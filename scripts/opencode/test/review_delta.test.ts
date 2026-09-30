import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Comment } from "../src/ports.ts";
import { buildPROpenedPrompt } from "../src/prompt.ts";
import type { ReviewApi } from "../src/review.ts";
import { reviewPullRequest } from "../src/review.ts";
import { findPreviousReview, loadReviewDelta } from "../src/review_delta.ts";
import { type GitRunner, runGit } from "../src/workspace.ts";
import {
  emptyCiMethods,
  makeBranch,
  makeComment,
  makeFile,
  makeIssue,
  makePR,
  makeRepo,
  makeUser,
} from "./fixtures.ts";

const MARKER = "<!-- jumi-review:kirmanak/demo#7 -->";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function commit(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** base → reviewed (touches a.ts, b.ts) → head (touches b.ts and c.ts, which the pull does not change). */
async function withPullRepo(run: (repo: { dir: string; reviewed: string; head: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "jumi-delta-"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    await commit(dir, { "a.ts": "a1\n", "b.ts": "b1\n", "c.ts": "c1\n" }, "base");
    const reviewed = await commit(dir, { "a.ts": "a2\n", "b.ts": "b2\n" }, "first pass");
    const head = await commit(dir, { "b.ts": "b3\n", "c.ts": "c2\n" }, "fix b");
    await run({ dir, reviewed, head });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function stickyBody(sha: string, prose: string, checkLine: string): string {
  return `${MARKER}\n### Jumi review\n\nReviewed commit: \`${sha}\`\n\n${prose}\n\n${checkLine}`;
}

const PULL_FILES = [
  makeFile({ filename: "a.ts", patch: "A_FULL_PATCH" }),
  makeFile({ filename: "b.ts", patch: "B_FULL_PATCH" }),
];

const ESSAY = "PREVIOUS_ESSAY: the whole change reads fine apart from b.";
const FINDING = "b.ts:1: 🟡 risk: `b` is fragile. Guard it.";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => PULL_FILES,
    getIssue: async () => makeIssue(),
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
  };
  return { ...defaults, ...overrides };
}

/** Real git for the delta reads; the checkout bookkeeping stays stubbed. */
function repoGit(head: string): GitRunner {
  return async (args, opts) => {
    if (["merge-base", "log", "diff"].includes(args[0])) return runGit(args, opts);
    if (args[0] === "rev-parse") return head;
    if (args[0] === "status") return "?? JUMI_REVIEW.md";
    if (args[0] === "ls-files" || args[0] === "checkout") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

async function reviewPrompt(dir: string, head: string, comments: Comment[], maxThreadBytes?: number): Promise<string> {
  let prompt = "";
  const result = await reviewPullRequest({
    maxThreadBytes,
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    model: "openai/gpt-5.5",
    workspace: dir,
    giteaUrl: "https://gitea.kirmanak.stream",
    giteaToken: "bot-token",
    botUsername: "jumi",
    workspacePreparer: async () => undefined,
    logger: () => undefined,
    gitRunner: repoGit(head),
    api: makeApi({
      getPR: async () => makePR({ head: makeBranch({ sha: head }) }),
      listIssueComments: async () => comments,
    }),
    openCodeRunner: async () => {
      prompt = await readFile(join(dir, "JUMI_TASK.md"), "utf8");
      await writeFile(join(dir, "JUMI_REVIEW.md"), "No blocking issues.\n<!-- jumi-check: success -->");
      return { status: "ok" };
    },
  });
  expect(result.status).toBe("posted");
  return prompt;
}

const HUMAN = makeComment({ id: 60, user: makeUser({ login: "alice" }), body: "HUMAN_NOTE: keep b small" });

describe("later reviews", () => {
  test("a first review still gets the full pull patches", async () => {
    await withPullRepo(async ({ dir, head }) => {
      const prompt = await reviewPrompt(dir, head, [HUMAN]);
      expect(prompt).toContain("A_FULL_PATCH");
      expect(prompt).toContain("B_FULL_PATCH");
      expect(prompt).toContain("HUMAN_NOTE: keep b small");
      expect(prompt).not.toContain("<changes_since_last_review");
      expect(prompt).not.toContain("<previous_review_findings");
    });
  });

  test("a second review gets the new commit's patches and the previous finding lines, not the essay", async () => {
    await withPullRepo(async ({ dir, reviewed, head }) => {
      const sticky = makeComment({
        id: 50,
        body: stickyBody(reviewed, `${ESSAY}\n\n- ${FINDING}`, "<!-- jumi-check: failure; 1 risk -->"),
      });
      const prompt = await reviewPrompt(dir, head, [sticky, HUMAN]);

      expect(prompt).toContain(`<changes_since_last_review from_sha="${reviewed}"`);
      expect(prompt).toContain("fix b");
      expect(prompt).toContain("+b3");
      expect(prompt).toContain(`<finding>b.ts:1: 🟡 risk: \`b\` is fragile. Guard it.</finding>`);
      expect(prompt).toContain("HUMAN_NOTE: keep b small");
      expect(prompt).toContain('<pull_request_changed_files patches="omitted">');
      expect(prompt).toContain('<file name="a.ts"');

      expect(prompt).not.toContain("A_FULL_PATCH");
      expect(prompt).not.toContain("B_FULL_PATCH");
      expect(prompt).not.toContain("+a2");
      expect(prompt).not.toContain("+c2");
      expect(prompt).not.toContain("PREVIOUS_ESSAY");
    });
  });

  test("says so when the previous review had no findings", async () => {
    await withPullRepo(async ({ dir, reviewed, head }) => {
      const sticky = makeComment({
        id: 50,
        body: stickyBody(reviewed, ESSAY, "<!-- jumi-check: success -->"),
      });
      const prompt = await reviewPrompt(dir, head, [sticky]);
      expect(prompt).toContain("<none>The previous review had no findings.</none>");
      expect(prompt).not.toContain("PREVIOUS_ESSAY");
    });
  });

  test("a failed previous review with no finding lines falls back to a first review", async () => {
    await withPullRepo(async ({ dir, reviewed, head }) => {
      const sticky = makeComment({
        id: 50,
        body: stickyBody(reviewed, "Could not finish the review.", "<!-- jumi-check: failure; unfinished -->"),
      });
      const prompt = await reviewPrompt(dir, head, [sticky]);
      expect(prompt).toContain("A_FULL_PATCH");
      expect(prompt).toContain("B_FULL_PATCH");
      expect(prompt).not.toContain("<changes_since_last_review");
      expect(prompt).not.toContain("The previous review had no findings.");
    });
  });

  test("drops the previous essay before fitting the thread budget", async () => {
    await withPullRepo(async ({ dir, reviewed, head }) => {
      const older = makeComment({ id: 10, user: makeUser({ login: "alice" }), body: "HUMAN_NOTE: keep b small" });
      const sticky = makeComment({
        id: 50,
        body: stickyBody(reviewed, `${ESSAY}\n\n${"x".repeat(4000)}\n\n- ${FINDING}`, "<!-- jumi-check: failure -->"),
      });
      const prompt = await reviewPrompt(dir, head, [older, sticky], 1000);
      expect(prompt).toContain(`<finding>${FINDING}</finding>`);
      expect(prompt).toContain("HUMAN_NOTE: keep b small");
      expect(prompt).not.toContain("[omitted; thread budget]");
      expect(prompt).not.toContain("PREVIOUS_ESSAY");
    });
  });

  test("falls back to a first review when the reviewed SHA is missing or not an ancestor", async () => {
    await withPullRepo(async ({ dir, reviewed, head }) => {
      const missing = makeComment({
        id: 50,
        body: stickyBody("0123456789abcdef0123456789abcdef01234567", ESSAY, "<!-- jumi-check: success -->"),
      });
      const missingPrompt = await reviewPrompt(dir, head, [missing]);
      expect(missingPrompt).toContain("A_FULL_PATCH");
      expect(missingPrompt).not.toContain("<changes_since_last_review");

      git(dir, ["checkout", "-q", "-b", "rewritten", reviewed]);
      const rewritten = await commit(dir, { "a.ts": "a9\n" }, "rewrite");
      git(dir, ["checkout", "-q", head]);
      const diverged = makeComment({ id: 51, body: stickyBody(rewritten, ESSAY, "<!-- jumi-check: success -->") });
      const divergedPrompt = await reviewPrompt(dir, head, [diverged]);
      expect(divergedPrompt).toContain("B_FULL_PATCH");
      expect(divergedPrompt).not.toContain("<changes_since_last_review");
    });
  });
});

describe("findPreviousReview", () => {
  test("uses the newest Jumi review and its open inline findings for a pull review", () => {
    const previous = findPreviousReview({
      comments: [
        makeComment({
          id: 50,
          body: stickyBody("aaaaaaa", "- b.ts:9: 🔴 bug: old", "<!-- jumi-check: failure -->"),
          updated_at: "2026-05-01T00:00:00Z",
        }),
      ],
      reviews: [
        {
          id: 9,
          user: makeUser({ login: "jumi" }),
          body: stickyBody("bbbbbbb", "Two risks.", "<!-- jumi-check: failure; 2 risks -->"),
          commit_id: "bbbbbbb",
          submitted_at: "2026-05-02T00:00:00Z",
        },
      ],
      inlines: [
        { ...makeComment({ id: 70, body: `🟡 risk: open one\n\n${MARKER}` }), path: "a.ts", new_position: 3 },
        { ...makeComment({ id: 71, body: `🟡 risk: fixed one\n\n${MARKER}` }), path: "a.ts", resolved: true },
        { ...makeComment({ id: 72, user: makeUser({ login: "alice" }), body: `human ${MARKER}` }), path: "a.ts" },
      ],
      botUsername: "jumi",
      marker: MARKER,
    });
    expect(previous).toEqual({ sha: "bbbbbbb", findings: ["a.ts:3: 🟡 risk: open one"] });
  });

  test("treats a failed review without finding lines as no previous review", () => {
    expect(
      findPreviousReview({
        comments: [
          makeComment({ body: stickyBody("aaaaaaa", "🔴 bug: no path here", "<!-- jumi-check: failure -->") }),
        ],
        reviews: [],
        inlines: [],
        botUsername: "jumi",
        marker: MARKER,
      })
    ).toBeUndefined();
  });

  test("ignores another pull's sticky", () => {
    expect(
      findPreviousReview({
        comments: [
          makeComment({
            body: stickyBody("aaaaaaa", "x", "<!-- jumi-check: success -->").replace(
              MARKER,
              "<!-- jumi-review:o/r#1 -->"
            ),
          }),
        ],
        reviews: [],
        inlines: [],
        botUsername: "jumi",
        marker: MARKER,
      })
    ).toBeUndefined();
  });
});

describe("loadReviewDelta", () => {
  test("treats the current head as a first review", async () => {
    await withPullRepo(async ({ dir, head }) => {
      const delta = await loadReviewDelta({
        previous: { sha: head, findings: [] },
        headSha: head,
        pullFiles: PULL_FILES,
        git: repoGit(head),
        cwd: dir,
        env: { PATH: process.env.PATH },
      });
      expect(delta).toBeUndefined();
    });
  });

  test("keeps only files the pull changes", async () => {
    await withPullRepo(async ({ dir, reviewed, head }) => {
      const delta = await loadReviewDelta({
        previous: { sha: reviewed, findings: [FINDING] },
        headSha: head,
        pullFiles: PULL_FILES,
        git: repoGit(head),
        cwd: dir,
        env: { PATH: process.env.PATH },
      });
      expect(delta?.files.map((file) => file.filename)).toEqual(["b.ts"]);
      expect(delta?.files[0]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
      expect(delta?.commits).toHaveLength(1);
      expect(delta?.findings).toEqual([FINDING]);
    });
  });
});

describe("buildPROpenedPrompt", () => {
  test("a first review prompt is unchanged by the delta option", () => {
    const opts = { repo: makeRepo(), pr: makePR(), prFiles: PULL_FILES };
    expect(buildPROpenedPrompt(opts)).toBe(buildPROpenedPrompt({ ...opts, delta: undefined }));
    expect(buildPROpenedPrompt(opts)).toContain("<patch><![CDATA[A_FULL_PATCH]]></patch>");
  });
});
