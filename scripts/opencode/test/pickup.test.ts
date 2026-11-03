import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueApi } from "../src/gitea_issues.ts";
import { classifyCloserWork, conflictJobIfUnmergeable, isJumiCloserForIssue } from "../src/pickup.ts";
import { emptyCiMethods, makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";

const repo = makeRepo();

function jumiCloser(overrides: Parameters<typeof makePR>[0] = {}) {
  return makePR({
    number: 127,
    user: makeUser({ login: "jumi" }),
    body: "Fixes #12",
    head: {
      label: "kirmanak:jumi/issue-12-fix-the-thing",
      ref: "jumi/issue-12-fix-the-thing",
      sha: "headsha",
      repo,
      repo_id: repo.id,
    },
    ...overrides,
  });
}

function makeApi(overrides: Partial<IssueApi> = {}): IssueApi {
  const defaults: IssueApi = {
    getRepo: async () => repo,
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getIssue: async () => makeIssue(),
    getPR: async (_owner, _repo, index) => makePR({ number: index }),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
    closePullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "closed" }),
    updatePullRequestBody: async (_owner, _repo, index, body) => makePR({ number: index, body }),
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
    updateIssueComment: async (_owner, _repo, _id, body) => makeComment({ body }),
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    ...emptyCiMethods(),
  };
  return { ...defaults, ...overrides };
}

describe("classifyCloserWork", () => {
  test("human comments on a jumi closer are follow-up", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-pickup-"));
    try {
      const mode = await classifyCloserWork({
        api: makeApi({
          listIssueComments: async () => [
            makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        pr: jumiCloser(),
        issueNumber: 12,
        botUsername: "jumi",
        home,
      });
      expect(mode).toBe("follow-up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("red non-jumi check is follow-up", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-pickup-"));
    try {
      const mode = await classifyCloserWork({
        api: makeApi({
          listCommitStatuses: async () => [
            { id: 1, context: "jumi/opencode-review", status: "success" },
            { id: 2, context: "build", status: "failure" },
          ],
          getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
        }),
        owner: "kirmanak",
        repo: "demo",
        pr: jumiCloser(),
        issueNumber: 12,
        botUsername: "jumi",
        home,
      });
      expect(mode).toBe("follow-up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("red GitHub Actions check-run with only jumi/opencode-review status is follow-up", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-pickup-"));
    try {
      const mode = await classifyCloserWork({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "jumi/opencode-review", status: "success" }],
          listCheckRuns: async () => [{ id: 4, context: "checks", status: "failure", jobId: 4 }],
          getActionJobLogs: async () => "##[error]lint/typecheck/tests, exit 1\n",
        }),
        owner: "kirmanak",
        repo: "demo",
        pr: jumiCloser(),
        issueNumber: 12,
        botUsername: "jumi",
        home,
      });
      expect(mode).toBe("follow-up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("mergeable false with no comments is conflict", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-pickup-"));
    try {
      const mode = await classifyCloserWork({
        api: makeApi(),
        owner: "kirmanak",
        repo: "demo",
        pr: jumiCloser({ mergeable: false }),
        issueNumber: 12,
        botUsername: "jumi",
        home,
      });
      expect(mode).toBe("conflict");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("mergeable false with comments is follow-up only", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-pickup-"));
    try {
      const mode = await classifyCloserWork({
        api: makeApi({
          listIssueComments: async () => [
            makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        pr: jumiCloser({ mergeable: false }),
        issueNumber: 12,
        botUsername: "jumi",
        home,
      });
      expect(mode).toBe("follow-up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("null or true mergeable with no comments is green", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-pickup-"));
    try {
      expect(
        await classifyCloserWork({
          api: makeApi(),
          owner: "kirmanak",
          repo: "demo",
          pr: jumiCloser({ mergeable: null }),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBeUndefined();
      expect(
        await classifyCloserWork({
          api: makeApi(),
          owner: "kirmanak",
          repo: "demo",
          pr: jumiCloser({ mergeable: true }),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("isJumiCloserForIssue", () => {
  test("matches an in-scope jumi closer and rejects a human PR", () => {
    expect(isJumiCloserForIssue(jumiCloser(), "kirmanak", "demo", 12, "jumi")).toBe(true);
    expect(
      isJumiCloserForIssue(
        makePR({ title: "Fix", body: "Fixes #12", user: makeUser({ login: "alice" }) }),
        "kirmanak",
        "demo",
        12,
        "jumi"
      )
    ).toBe(false);
  });

  test("matches a Refs jumi branch PR so re-picking finds it", () => {
    expect(isJumiCloserForIssue(jumiCloser({ body: "Refs #12" }), "kirmanak", "demo", 12, "jumi")).toBe(true);
    expect(isJumiCloserForIssue(jumiCloser({ body: "no keyword here" }), "kirmanak", "demo", 12, "jumi")).toBe(true);
    expect(isJumiCloserForIssue(jumiCloser({ body: "Fixes #13" }), "kirmanak", "demo", 12, "jumi")).toBe(true);
    expect(isJumiCloserForIssue(jumiCloser({ body: "Fixes #13" }), "kirmanak", "demo", 13, "jumi")).toBe(false);
  });
});

describe("conflictJobIfUnmergeable", () => {
  test("enqueues when mergeable is false", async () => {
    const job = makeIssueJob();
    const next = await conflictJobIfUnmergeable(
      { getPR: async () => makePR({ number: 3, mergeable: false, head: { ...makePR().head, sha: "newsha" } }) },
      job,
      3
    );
    expect(next?.mode).toBe("conflict");
    expect(next?.prNumber).toBe(3);
    expect(next?.headSha).toBe("newsha");
    expect(next?.issueNumber).toBe(12);
  });

  test("does not enqueue when mergeable is null or true", async () => {
    const job = makeIssueJob();
    expect(
      await conflictJobIfUnmergeable({ getPR: async () => makePR({ number: 3, mergeable: null }) }, job, 3)
    ).toBeUndefined();
    expect(
      await conflictJobIfUnmergeable({ getPR: async () => makePR({ number: 3, mergeable: true }) }, job, 3)
    ).toBeUndefined();
  });
});
