import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPROpenedPrompt, REVIEW_MD_UNREACHABLE_SOURCE_GUIDANCE } from "../src/prompt.ts";
import type { PersistReviewResult } from "../src/review.ts";
import { type ReviewApi, reviewPullRequest } from "../src/review.ts";
import { probeReviewMcpServer } from "../src/review_mcp.ts";
import { emptyCiMethods, makeComment, makeFile, makePR, makeRepo } from "./fixtures.ts";
import { fakeGit } from "./harness/git.ts";

const REVIEW_TEXT =
  "# Review rules\n\n## Layout\n\nCheck changes against acme/private-sibling's README for new keys.\n\n## Hygiene\n\nEvery changed file must end with a newline.\n";

function promptWithReviewMd() {
  return buildPROpenedPrompt({
    repo: makeRepo(),
    pr: makePR(),
    prFiles: [makeFile({ filename: "src/demo.ts" })],
    reviewMd: { text: REVIEW_TEXT, truncated: false },
  });
}

describe("REVIEW.md unreachable-source rule", () => {
  test("with REVIEW.md sections the prompt carries the unreachable-source rule next to the REVIEW.md framing", () => {
    const prompt = promptWithReviewMd();
    expect(prompt).toContain("<review_md");
    // The framing sentence is still there and the new rule sits next to it.
    expect(prompt).toContain("report each violation as a finding with the rule it breaks");
    expect(prompt).toContain(REVIEW_MD_UNREACHABLE_SOURCE_GUIDANCE);
    expect(prompt.indexOf(REVIEW_MD_UNREACHABLE_SOURCE_GUIDANCE)).toBeGreaterThan(
      prompt.indexOf("report each violation as a finding")
    );
    expect(prompt.indexOf(REVIEW_MD_UNREACHABLE_SOURCE_GUIDANCE)).toBeLessThan(prompt.indexOf("<review_md"));
  });

  test("without REVIEW.md sections the prompt is unchanged", () => {
    const prompt = buildPROpenedPrompt({ repo: makeRepo(), pr: makePR(), prFiles: [makeFile()] });
    expect(prompt).not.toContain("<review_md");
    expect(prompt).not.toContain(REVIEW_MD_UNREACHABLE_SOURCE_GUIDANCE);
  });

  test("the existing violation and unverifiable-upstream sentences are still present", () => {
    const withReview = promptWithReviewMd();
    expect(withReview).toContain("report each violation as a finding with the rule it breaks");

    const blocking = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [makeFile()],
      reviewMd: { text: REVIEW_TEXT, truncated: false },
      blockingQuestions: true,
    });
    expect(blocking).toContain("changes stay unverifiable after you tried to read them");
    expect(blocking).toContain("non-blocking note");
  });
});

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
    getIssue: async () => {
      throw new Error("unused");
    },
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ id: 1, body }),
    updateIssueComment: async (_owner, _repo, commentId, body) => makeComment({ id: commentId, body }),
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_owner, _repo, _sha, status) => status,
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    ...overrides,
  } as ReviewApi;
}

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

async function runStubbedReview(
  stub: (opts: { reviewMcp?: { url: string; token: string }; workdir: string }) => Promise<void>
) {
  const workspace = await mkdtemp(join(tmpdir(), "jumi-unreachable-"));
  let capturedPrompt = "";
  try {
    const persisted: PersistReviewResult[] = [];
    const statuses: Array<{ state: string; description?: string }> = [];
    const comments: string[] = [];
    const result = (await reviewPullRequest({
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      model: "openai/gpt-5.5",
      workspace,
      giteaUrl: "https://gitea.kirmanak.stream",
      giteaToken: "bot-token",
      botUsername: "jumi",
      workspacePreparer: async () => undefined,
      logger: () => undefined,
      api: makeApi({
        getPR: async () =>
          makePR({ head: { ...makePR().head, sha: HEAD_SHA }, base: { ...makePR().base, sha: BASE_SHA } }),
        getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
        createIssueComment: async (_o, _r, _i, body) => {
          comments.push(body);
          return makeComment({ id: comments.length, body });
        },
        createCommitStatus: async (_o, _r, _s, status) => {
          statuses.push(status);
          return status;
        },
      }),
      gitRunner: fakeGit({ head: HEAD_SHA, baseReviewMd: REVIEW_TEXT }),
      persistResult: async (value) => {
        persisted.push(value);
      },
      openCodeRunner: async (engineOpts) => {
        const task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8").catch(() => "");
        capturedPrompt = task;
        await stub(engineOpts as never);
        return { status: "ok" };
      },
    })) as { status: string; reason?: string };
    return { result, persisted, statuses, comments, capturedPrompt };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("REVIEW.md unreachable-source review runs", () => {
  test("a suggestion naming the unreachable rule publishes success, not incomplete", async () => {
    const run = await runStubbedReview(async ({ reviewMcp }) => {
      if (!reviewMcp) throw new Error("required mode must wire the structured adapter");
      const added = await probeReviewMcpServer(reviewMcp.url, reviewMcp.token, "add_finding", {
        path: "src/demo.ts",
        line: 1,
        severity: "suggestion",
        title: "Layout: could not check private sibling README",
        body: "Per the Layout rule (check against acme/private-sibling's README): the sibling README is unreachable from this review, so the new keys stay unchecked. Checked the checkout and CI as far as possible.",
      });
      expect(added.ok).toBe(true);
      const verdict = await probeReviewMcpServer(reviewMcp.url, reviewMcp.token, "set_verdict", {
        state: "success",
        reason: "only an unchecked sibling README, recorded as a suggestion",
      });
      expect(verdict.ok).toBe(true);
    });

    expect(run.capturedPrompt).toContain("<review_md");
    expect(run.capturedPrompt).toContain(REVIEW_MD_UNREACHABLE_SOURCE_GUIDANCE);
    expect(run.capturedPrompt).toContain("report each violation as a finding with the rule it breaks");
    expect(run.result.status).toBe("posted");
    expect(run.result.reason).not.toBe("Incomplete review: no findings");
    expect(run.persisted).toHaveLength(1);
    expect(run.persisted[0]?.kind).toBe("markdown");
    if (run.persisted[0]?.kind !== "markdown") return;
    expect(run.persisted[0].markdown).toContain("💡");
    expect(run.persisted[0].markdown).not.toContain("Incomplete review: no findings");
  });

  test("a checkable rule from the same file still fails the review when broken", async () => {
    const run = await runStubbedReview(async ({ reviewMcp }) => {
      if (!reviewMcp) throw new Error("required mode must wire the structured adapter");
      const added = await probeReviewMcpServer(reviewMcp.url, reviewMcp.token, "add_finding", {
        path: "src/demo.ts",
        line: 1,
        severity: "bug",
        title: "Hygiene: missing trailing newline",
        body: "Per the Hygiene rule (every changed file must end with a newline): this diff adds a line without a trailing newline. End the file with a newline.",
      });
      expect(added.ok).toBe(true);
      const verdict = await probeReviewMcpServer(reviewMcp.url, reviewMcp.token, "set_verdict", {
        state: "failure",
        reason: "blocking hygiene violation",
      });
      expect(verdict.ok).toBe(true);
    });

    expect(run.capturedPrompt).toContain(REVIEW_MD_UNREACHABLE_SOURCE_GUIDANCE);
    expect(run.result.status).toBe("posted");
    expect(run.persisted).toHaveLength(1);
    expect(run.persisted[0]?.kind).toBe("markdown");
    if (run.persisted[0]?.kind !== "markdown") return;
    expect(run.persisted[0].markdown).toContain("🔴");
    expect(run.persisted[0].record?.state).toBe("failure");
  });
});
