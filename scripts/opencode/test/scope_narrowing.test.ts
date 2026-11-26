import { describe, expect, test } from "bun:test";
import { implementFollowUp } from "../src/followup.ts";
import { buildConflictPrompt, buildFollowupPrompt, buildImplementPrompt } from "../src/git.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { buildPROpenedPrompt, REVIEW_RUBRIC } from "../src/prompt.ts";
import { BODY_ONLY_REVIEW_ACTION } from "../src/review.ts";
import { FINDING_RESPONSE_STATUSES, persistFindingResponses, validateFindingResponse } from "../src/review_findings.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import type { ReviewJob } from "../src/types.ts";
import { probeWorkerMcpServer, WorkerResultStore } from "../src/worker_mcp.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";
import { withDirs } from "./harness/temp.ts";

function jumiPr() {
  const repo = makeRepo();
  return makePR({
    number: 127,
    title: "Update jumi to v11.3.122",
    body: "Update jumi to v11.3.122\n\nFixes #12",
    user: makeUser({ login: "jumi" }),
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    head: {
      label: "kirmanak:jumi/issue-12-fix-the-thing",
      ref: "jumi/issue-12-fix-the-thing",
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repo,
      repo_id: repo.id,
    },
  });
}

function failingSticky(headSha: string) {
  return makeComment({
    id: 38022,
    body: [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi review",
      "",
      `Reviewed commit: \`${headSha}\``,
      "",
      "src/a.ts:10: 🔴 bug: null deref.",
      "<!-- jumi-check: failure -->",
    ].join("\n"),
    user: makeUser({ login: "jumi" }),
    created_at: "2026-09-11T00:00:00Z",
  });
}

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

describe("scope narrowing reviewer rule", () => {
  test("the new rule is present in the rubric", () => {
    expect(REVIEW_RUBRIC).toContain("If the only fix available for a");
    expect(REVIEW_RUBRIC).toContain("would deliver less than the PR");
    expect(REVIEW_RUBRIC).toContain("never list the scope reduction as the remedy");
    expect(REVIEW_RUBRIC).toContain("an older version than the PR targets");
    expect(REVIEW_RUBRIC).toContain("dropping or reverting a delivered part");
    expect(REVIEW_RUBRIC).toContain("deferring part of it");
    expect(REVIEW_RUBRIC).toContain("Take the intent from the linked issue");
    expect(REVIEW_RUBRIC).toContain("PR title and the author");
  });

  test("the rule sits with the maintainer-only list", () => {
    const maintainerOnly = REVIEW_RUBRIC.indexOf("Maintainer-only means");
    const narrowing = REVIEW_RUBRIC.indexOf("If the only fix available for a");
    const maintainerStart = REVIEW_RUBRIC.indexOf("Start a maintainer-only question");
    expect(maintainerOnly).toBeGreaterThan(-1);
    expect(narrowing).toBeGreaterThan(-1);
    expect(maintainerStart).toBeGreaterThan(-1);
    expect(narrowing).toBeGreaterThan(maintainerOnly);
    expect(narrowing).toBeLessThan(maintainerStart);
  });

  test("the built reviewer prompt carries the rule", () => {
    const prompt = buildPROpenedPrompt({ repo: makeRepo(), pr: makePR(), prFiles: [] });
    expect(prompt).toContain("If the only fix available for a");
    expect(prompt).toContain("never list the scope reduction as the remedy");
  });
});

describe("scope narrowing worker prompt", () => {
  test("follow-up carries the no-narrowing rule and needs_maintainer", () => {
    const prompt = buildFollowupPrompt();
    expect(prompt).toContain("Never narrow the PR");
    expect(prompt).toContain("needs_maintainer");
    expect(prompt).toContain("finding_response");
    expect(prompt).toContain("leave the tree unchanged");
    expect(prompt).toContain("set_pr_body");
    expect(prompt).toContain("Moving forward is not narrowing");
  });

  test("implement and conflict prompts do not carry it", () => {
    expect(buildImplementPrompt()).not.toContain("needs_maintainer");
    expect(buildImplementPrompt()).not.toContain("Never narrow the PR");
    expect(buildConflictPrompt()).not.toContain("needs_maintainer");
    expect(buildConflictPrompt()).not.toContain("Never narrow the PR");
  });
});

describe("finding_response needs_maintainer", () => {
  test("accepts with a reason and rejects without one", () => {
    expect(FINDING_RESPONSE_STATUSES).toEqual(["fixed", "unchanged", "needs_maintainer"]);
    const ok = validateFindingResponse({
      finding: "src/a.ts:10: 🔴 bug: null deref.",
      status: "needs_maintainer",
      reason: "Only fix narrows scope: ship v11.3.118 now or hold for a fix.",
    });
    expect(ok.ok).toBe(true);
    const missing = validateFindingResponse({ finding: "src/a.ts:10: 🔴 bug: x.", status: "needs_maintainer" });
    expect(missing.ok).toBe(false);
    const empty = validateFindingResponse({
      finding: "src/a.ts:10: 🔴 bug: x.",
      status: "needs_maintainer",
      reason: "   ",
    });
    expect(empty.ok).toBe(false);
  });

  test("the answer is persisted like the other statuses", async () => {
    const store = new MemoryReviewJobStore();
    await store.recordReviewFindings([
      {
        forge: "gitea",
        owner: "kirmanak",
        repo: "demo",
        prNumber: 12,
        severity: "bug",
        reviewerRunner: "opencode",
        writerRunner: "",
        reviewRound: 1,
        outcome: "repeated",
        fingerprint: "src/a.ts:10: 🔴 bug: null deref.",
        path: "src/a.ts",
        line: 10,
      },
    ]);
    const worker = new WorkerResultStore();
    const validated = validateFindingResponse({
      finding: "src/a.ts:10: 🔴 bug: null deref.",
      status: "needs_maintainer",
      reason: "Ship v11.3.118 now and leave the rest, or hold for a fix.",
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(worker.setFindingResponse(validated).ok).toBe(true);
    const recorded = await persistFindingResponses(
      worker.getFindingResponses(),
      { owner: "kirmanak", repo: "demo", prNumber: 12 },
      store,
      () => undefined
    );
    expect(recorded).toBe(1);
    expect(store.reviewFindings[0]?.workerStatus).toBe("needs_maintainer");
  });
});

describe("follow-up needs_maintainer flow", () => {
  const finding = "src/a.ts:10: 🔴 bug: null deref.";
  const optionsReason =
    "Only fix narrows scope: ship v11.3.118 now and leave v11.3.119-v11.3.122 for later, or hold until a release fixes it.";

  function followupApi(): IssueApi {
    const pr = jumiPr();
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    return makeIssueApi({
      getIssue: async () => makeIssue(),
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      listOpenPulls: async () => [pr],
      getPR: async () => pr,
      listIssueComments: async () => [
        makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
        failingSticky(head),
      ],
      listPullReviewComments: async () => [],
      listPullReviews: async () => [],
    }) as unknown as IssueApi;
  }

  function followUpJob() {
    return makeIssueJob({
      mode: "follow-up",
      prNumber: 127,
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
    });
  }

  test("needs_maintainer with a body change and no push queues one same-head followup-body review", async () => {
    await withDirs(async (home, workdir) => {
      const ledger = new MemoryReviewJobStore();
      await ledger.recordReviewFindings([
        {
          forge: "gitea",
          owner: "kirmanak",
          repo: "demo",
          prNumber: 127,
          severity: "bug",
          reviewerRunner: "opencode",
          writerRunner: "",
          reviewRound: 1,
          outcome: "repeated",
          fingerprint: finding,
          path: "src/a.ts",
          line: 10,
        },
      ]);
      const queued: ReviewJob[] = [];
      const pushCalls: string[][] = [];
      const gitRunner = (async (args: string[]) => {
        const gitArgs = stripGitConfigArgs(args);
        pushCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      }) as GitRunner;
      const result = await implementFollowUp({
        api: followupApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        ledger,
        reviewQueue: {
          enqueue: async (job: ReviewJob) => {
            queued.push(job);
            return { key: `${job.action}-${job.prNumber}`, queued: true };
          },
        },
        openCodeRunner: async (opts) => {
          const mcp = (opts as unknown as { workerMcp?: { url: string; token: string } }).workerMcp;
          expect(mcp).toBeDefined();
          const answered = await probeWorkerMcpServer(mcp!.url, mcp!.token, "finding_response", {
            finding,
            status: "needs_maintainer",
            reason: optionsReason,
          });
          expect(answered.ok).toBe(true);
          const described = await probeWorkerMcpServer(mcp!.url, mcp!.token, "set_pr_body", {
            markdown: `Only fix narrows scope: ${optionsReason}\n\nRefs #12`,
            remaining: ["maintainer decision on scope"],
          });
          expect(described.ok).toBe(true);
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(pushCalls.some((args) => args[0] === "push")).toBe(false);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.action).toBe(BODY_ONLY_REVIEW_ACTION);
      expect(queued[0]?.prNumber).toBe(127);
      expect(queued[0]?.headSha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(ledger.reviewFindings[0]?.workerStatus).toBe("needs_maintainer");
    });
  });

  test("needs_maintainer plus an in-scope fix still pushes and queues no body-only review", async () => {
    await withDirs(async (home, workdir) => {
      const ledger = new MemoryReviewJobStore();
      await ledger.recordReviewFindings([
        {
          forge: "gitea",
          owner: "kirmanak",
          repo: "demo",
          prNumber: 127,
          severity: "bug",
          reviewerRunner: "opencode",
          writerRunner: "",
          reviewRound: 1,
          outcome: "repeated",
          fingerprint: finding,
          path: "src/a.ts",
          line: 10,
        },
      ]);
      const queued: ReviewJob[] = [];
      const pushCalls: string[][] = [];
      const gitRunner = (async (args: string[]) => {
        const gitArgs = stripGitConfigArgs(args);
        pushCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "rev-list") return "1";
        return "";
      }) as GitRunner;
      const result = await implementFollowUp({
        api: followupApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        ledger,
        reviewQueue: {
          enqueue: async (job: ReviewJob) => {
            queued.push(job);
            return { key: `${job.action}-${job.prNumber}`, queued: true };
          },
        },
        openCodeRunner: async (opts) => {
          const mcp = (opts as unknown as { workerMcp?: { url: string; token: string } }).workerMcp;
          expect(mcp).toBeDefined();
          const answered = await probeWorkerMcpServer(mcp!.url, mcp!.token, "finding_response", {
            finding,
            status: "needs_maintainer",
            reason: optionsReason,
          });
          expect(answered.ok).toBe(true);
          const described = await probeWorkerMcpServer(mcp!.url, mcp!.token, "set_pr_body", {
            markdown: `Pushed the in-scope guard; still needs a maintainer call: ${optionsReason}\n\nRefs #12`,
            remaining: ["maintainer decision on scope"],
          });
          expect(described.ok).toBe(true);
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      expect(pushCalls.some((args) => args[0] === "push")).toBe(true);
      expect(queued.filter((job) => job.action === BODY_ONLY_REVIEW_ACTION)).toHaveLength(0);
      expect(ledger.reviewFindings[0]?.workerStatus).toBe("needs_maintainer");
    });
  });
});
