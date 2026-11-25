import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementFollowUp, isLastJumiReviewFailedOnHead, shouldQueueReviewAfterBodyChange } from "../src/followup.ts";
import { buildFollowupPrompt, buildImplementPrompt, buildImplementYieldPrompt } from "../src/git.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { refsIssuePattern } from "../src/gitea_issues.ts";
import { buildPullRequestBody, PR_BODY_FENCE_END, PR_BODY_FENCE_START } from "../src/implement.ts";
import { BODY_ONLY_REVIEW_ACTION, reviewJobKey } from "../src/review.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import type { ReviewJob } from "../src/types.ts";
import type { GitRunner } from "../src/workspace.ts";
import { emptyCiMethods, makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";
import { withDirs } from "./harness/temp.ts";

function jumiPr() {
  const repo = makeRepo();
  return makePR({
    number: 127,
    title: "Fix the thing",
    body: "Fixes #12",
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
      "needs work before this can close the issue",
      "<!-- jumi-check: failure -->",
    ].join("\n"),
    user: makeUser({ login: "jumi" }),
    created_at: "2026-09-11T00:00:00Z",
  });
}

function successSticky(headSha: string) {
  return makeComment({
    id: 38023,
    body: [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi review",
      "",
      `Reviewed commit: \`${headSha}\``,
      "",
      "No blocking issues.",
      "<!-- jumi-check: success -->",
    ].join("\n"),
    user: makeUser({ login: "jumi" }),
    created_at: "2026-09-12T00:00:00Z",
  });
}

describe("partial work stays non-closing only with an explicit remaining list", () => {
  test("Refs and equivalents with an explicit remaining list publish without a closing keyword", () => {
    for (const phrase of ["Part of #12", "Progress toward #12", "Related to #12", "Refs #12"]) {
      const body = buildPullRequestBody(12, `Partial work.\n\n${phrase}`, undefined, [], undefined, ["one more case"]);
      expect(body).toContain(phrase);
      expect(body).toContain("one more case");
      expect(body).not.toMatch(/fixes #12/i);
    }
  });

  test("a bare non-closing reference without a remaining list is published with the closing keyword", () => {
    for (const phrase of ["Part of #12", "Progress toward #12", "Related to #12", "Refs #12"]) {
      const body = buildPullRequestBody(12, `Partial work.\n\n${phrase}`);
      expect(body).toBe("Partial work.\n\nFixes #12");
    }
  });

  test("a body with no reference still gets the default closing keyword", () => {
    expect(buildPullRequestBody(12, "Caches categories.")).toBe("Caches categories.\n\nFixes #12");
  });

  test("non-closing phrasings match like Refs", () => {
    for (const phrase of ["Part of #12", "Progress toward #12", "Progress towards #12", "Related to #12"]) {
      expect(refsIssuePattern(12).test(phrase)).toBe(true);
    }
    expect(refsIssuePattern(12).test("Fixes #12")).toBe(false);
  });
});

describe("worker prompts describe the PR body and partial work", () => {
  test("implement and follow-up prompts name set_pr_body as the PR description", () => {
    for (const prompt of [buildImplementPrompt(), buildImplementYieldPrompt(), buildFollowupPrompt()]) {
      expect(prompt).toContain("set_pr_body");
      expect(prompt).toContain("Refs #N");
      expect(prompt).toContain("leave the list empty when Done is met");
      expect(prompt).not.toContain("JUMI_PR.md is the pull-request description");
    }
  });

  test("an unfenced follow-up prompt names the maintainer-written addendum case", () => {
    const fenced = buildFollowupPrompt(undefined, { prBodyFenced: true });
    expect(fenced).toContain("set_pr_body");
    expect(fenced).not.toContain("maintainer-written");
    const unfenced = buildFollowupPrompt(undefined, { prBodyFenced: false });
    expect(unfenced).toContain("set_pr_body");
    expect(unfenced).toContain("maintainer-written");
    expect(unfenced).toContain("Jumi section appended below it");
    expect(unfenced).toContain("only what the reviewer asked to be disclosed plus verification notes");
  });
});

describe("body-only review requeue helpers", () => {
  test("queues only when the body changed on a failed head", () => {
    expect(shouldQueueReviewAfterBodyChange(true, true)).toBe(true);
    expect(shouldQueueReviewAfterBodyChange(true, false)).toBe(false);
    expect(shouldQueueReviewAfterBodyChange(false, true)).toBe(false);
    expect(shouldQueueReviewAfterBodyChange(false, false)).toBe(false);
  });

  test("latest review on the head decides, not an older head", () => {
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const failed = {
      jumiReviews: [],
      jumiStickies: [failingSticky(head)],
    };
    expect(isLastJumiReviewFailedOnHead(failed, head, "jumi")).toBe(true);
    expect(isLastJumiReviewFailedOnHead(failed, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "jumi")).toBe(false);

    const success = {
      jumiReviews: [],
      jumiStickies: [successSticky(head)],
    };
    expect(isLastJumiReviewFailedOnHead(success, head, "jumi")).toBe(false);
    expect(isLastJumiReviewFailedOnHead({ jumiReviews: [], jumiStickies: [] }, head, "jumi")).toBe(false);
  });

  test("body-only action bypasses the same-head terminal row", async () => {
    const store = new MemoryReviewJobStore();
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const base: ReviewJob = {
      delivery: "d1",
      owner: "o",
      repo: "r",
      prNumber: 127,
      action: "synchronize",
      headSha: head,
      receivedAt: new Date().toISOString(),
    };
    await store.enqueue(base);
    const row = (await store.peekRunnable(["review"], 10))[0];
    expect(row).toBeDefined();
    await store.lease("w", 60_000, new Date(), ["review"]);
    const leased = await store.get(row!.id);
    expect(leased?.state).toBe("leased");
    await store.saveResult(row!.id, "w", { kind: "markdown", markdown: "x\n\n<!-- jumi-check: failure -->" });
    await store.markPublished(row!.id, "w", { state: "succeeded" });

    const blocked = await store.enqueue({ ...base, delivery: "d2" });
    expect(blocked.queued).toBe(false);

    const bodyOnly = await store.enqueue({
      ...base,
      delivery: "followup-body-127-headsha",
      action: BODY_ONLY_REVIEW_ACTION,
    });
    expect(bodyOnly.queued).toBe(true);
    expect(bodyOnly.key).toBe(reviewJobKey(base));
  });
});

describe("follow-up body-only round queues a fresh review", () => {
  const fenced = (text: string) => `${PR_BODY_FENCE_START}\n${text}\n${PR_BODY_FENCE_END}`;
  const posted = `Human note.\n\n${fenced("Old writeup.\n\nFixes #12\n\n_Jumi · opencode · openai/gpt-5.5_")}`;

  async function runBodyOnly(opts: {
    writePr: string | null;
    stickyBody?: ReturnType<typeof failingSticky>[];
    reviewQueue?: { enqueue(job: ReviewJob): Promise<{ key: string; queued: boolean }> };
  }) {
    const queued: ReviewJob[] = [];
    let result: Awaited<ReturnType<typeof implementFollowUp>> | undefined;
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const pr = { ...jumiPr(), body: posted };
      const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const stickies = opts.stickyBody ?? [failingSticky(head)];
      const api: IssueApi = {
        getRepo: async () => makeRepo(),
        getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
        getIssue: async () => makeIssue(),
        getPR: async () => pr,
        listOpenPulls: async () => [pr],
        createPullRequest: async (_o, _r, pull) => makePR({ number: 3, title: pull.title, body: pull.body }),
        closePullRequest: async (_o, _r, index) => makePR({ number: index, state: "closed" }),
        updatePullRequestBody: async (_o, _r, index, body) => makePR({ number: index, body }),
        findStickyIssueComment: async () => undefined,
        createIssueComment: async (_o, _r, _i, body) => makeComment({ body }),
        updateIssueComment: async (_o, _r, id, body) => makeComment({ id, body }),
        listIssueComments: async () => [
          makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
          ...stickies,
        ],
        listPullReviewComments: async () => [],
        listPullReviews: async () => [],
        ...emptyCiMethods(),
      };
      const reviewQueue =
        opts.reviewQueue ??
        ({
          enqueue: async (job: ReviewJob) => {
            queued.push(job);
            return { key: reviewJobKey(job), queued: true };
          },
        } as unknown as NonNullable<Parameters<typeof implementFollowUp>[0]["reviewQueue"]>);
      result = await implementFollowUp({
        api,
        job: makeIssueJob({ mode: "follow-up", prNumber: 127 }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        reviewQueue,
        gitRunner: (async (args: string[]) => {
          const gitArgs = [...args];
          while (gitArgs[0] === "-c") gitArgs.splice(0, 2);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          return "";
        }) as unknown as GitRunner,
        openCodeRunner: async () => {
          if (opts.writePr != null) await writeFile(join(worktree, "JUMI_PR.md"), opts.writePr);
          return { status: "ok" };
        },
        logger: () => undefined,
      });
    });
    return { result, queued };
  }

  test("a body-only change on a failed head queues that head", async () => {
    const run = await runBodyOnly({ writePr: "Partial work.\n\nRefs #12\n\nRemaining:\n- one more case" });
    expect(run.result?.status).toBe("no-changes");
    expect(run.queued).toHaveLength(1);
    expect(run.queued[0]?.prNumber).toBe(127);
    expect(run.queued[0]?.headSha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(run.queued[0]?.action).toBe(BODY_ONLY_REVIEW_ACTION);
  });

  test("an unchanged body does not queue", async () => {
    const run = await runBodyOnly({ writePr: "Old writeup.\n\nFixes #12" });
    expect(run.result?.status).toBe("no-changes");
    expect(run.queued).toHaveLength(0);
  });

  test("a body-only change on a passing head does not queue", async () => {
    const run = await runBodyOnly({
      writePr: "Partial work.\n\nRefs #12\n\nRemaining:\n- one more case",
      stickyBody: [successSticky("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    });
    expect(run.queued).toHaveLength(0);
  });
});
