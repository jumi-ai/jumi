import { describe, expect, test } from "bun:test";
import { enqueueFollowUpFromReview } from "../src/handover.ts";
import { disabledKickWhy } from "../src/kick.ts";
import { buildFollowUpSnapshot } from "../src/pr_snapshot.ts";
import { headSettingsFollowUpFeedback, isHeadSettingsFailureReason } from "../src/repo_settings.ts";
import { invalidHeadSettingsFailure } from "../src/review.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { normalizeSitReason } from "../src/router_sits.ts";
import { MemorySkipLatchStore } from "../src/skip_latches.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeComment, makeIssue, makeIssueJob, makeJob, makePR, makeRepo, makeUser } from "./fixtures.ts";

const UNKNOWN_KEY_FAILURE = '.jumi.yml is invalid: unknown key "verify" (did you mean "review_exclude"?)';

function reviewLeaseApi(overrides: Parameters<typeof makeReviewApi>[0] = {}) {
  const comments: string[] = [];
  const fake = makeReviewApi({
    getPR: async () =>
      makePR({
        body: "Fixes #12",
        user: makeUser({ login: "jumi" }),
        head: { ...makePR().head, ref: "jumi/issue-12-fix", sha: "headsha" },
      }),
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, commentId, body) => {
      comments.push(body);
      return makeComment({ id: commentId, body });
    },
    ...overrides,
  });
  return Object.assign(fake, { comments });
}

async function leasedReviewRow(store: MemoryReviewJobStore) {
  await store.enqueue(makeJob());
  const leased = await store.lease("engine-1", 60_000);
  if (!leased) throw new Error("expected a leased review row");
  return leased;
}

describe("invalid head .jumi.yml routes to follow-up (#915)", () => {
  test("Jumi closer with an unknown key queues a follow-up naming the parser error", async () => {
    // The strict check is unchanged: the head failure names the parser error.
    const failure = await invalidHeadSettingsFailure({
      api: {
        getRepoFile: async () => ({ found: true, content: "verify: true\n" }),
      },
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "headsha",
      baseBranch: "main",
      changedFiles: [{ filename: ".jumi.yml" }],
      log: () => undefined,
    });
    expect(failure).toContain(".jumi.yml is invalid:");
    expect(failure).toContain('unknown key "verify"');
    expect(isHeadSettingsFailureReason(failure)).toBe(true);

    const store = new MemoryReviewJobStore();
    const row = await leasedReviewRow(store);
    const api = reviewLeaseApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row,
      botUsername: "jumi",
      published: { status: "skipped", reason: failure! },
      logger: (message) => logs.push(message),
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    const follow = store.rows.find((entry) => entry.kind === "follow-up");
    expect(follow?.state).toBe("queued");
    expect(follow?.issueNumber).toBe(12);
    expect(logs.some((line) => line.includes("no unhandled feedback"))).toBe(false);

    // The worker-facing feedback carries the parser error verbatim plus the
    // merge-off guidance and the separate-pull default.
    const feedback = headSettingsFollowUpFeedback(failure!);
    expect(feedback).toContain(failure!);
    expect(feedback).toContain("turn Jumi off");
    expect(feedback).toContain("separate pull");
  });

  test("the follow-up removes the settings change, so the next head reviews normally", async () => {
    // A head that no longer touches the settings file reads no head file and
    // reports no failure.
    let headReads = 0;
    const untouched = await invalidHeadSettingsFailure({
      api: {
        getPRFiles: async () => [
          { filename: "src/app.ts", status: "modified" as const, additions: 1, deletions: 0, changes: 1 },
        ],
        getRepoFile: async () => {
          headReads++;
          return { found: true, content: "verify: true\n" };
        },
      },
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "fixedsha",
      baseBranch: "main",
      log: () => undefined,
    });
    expect(untouched).toBeUndefined();
    expect(headReads).toBe(0);

    // A head that still touches the file but parses cleanly also passes.
    const fixed = await invalidHeadSettingsFailure({
      api: {
        getRepoFile: async () => ({ found: true, content: "automerge: true\n" }),
      },
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "fixedsha",
      baseBranch: "main",
      changedFiles: [{ filename: ".jumi.yml" }],
      log: () => undefined,
    });
    expect(fixed).toBeUndefined();
  });

  test("a pull Jumi does not work on keeps the failing status with no follow-up", async () => {
    const store = new MemoryReviewJobStore();
    const row = await leasedReviewRow(store);
    const api = reviewLeaseApi({
      getPR: async () => makePR({ body: "unrelated change, no closer" }),
    });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row,
      botUsername: "jumi",
      published: { status: "skipped", reason: UNKNOWN_KEY_FAILURE },
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((entry) => entry.kind === "follow-up")).toBe(false);
    expect(logs).toEqual(["persist-insert skipped: no closer"]);
  });

  test("a handed-over pull with a human author and a picked-up closer queues a follow-up", async () => {
    // Handed-over / taken-over pulls keep human authorship and branch, so
    // the Jumi-identity gate must not deny them: with a `Fixes #N` closer
    // whose issue is picked up, the shared closer/pickup checks enqueue, the
    // same as an ordinary review failure would.
    const store = new MemoryReviewJobStore();
    const row = await leasedReviewRow(store);
    const repo = makeRepo();
    const api = reviewLeaseApi({
      getPR: async () =>
        makePR({
          body: "Fixes #12",
          user: makeUser({ login: "alice" }),
          head: { label: "kirmanak:feature", ref: "feature", sha: "headsha", repo, repo_id: repo.id },
        }),
    });
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row,
      botUsername: "jumi",
      published: { status: "skipped", reason: UNKNOWN_KEY_FAILURE },
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    const follow = store.rows.find((entry) => entry.kind === "follow-up");
    expect(follow?.state).toBe("queued");
    expect(follow?.issueNumber).toBe(12);
  });

  test("the snapshot treats an invalid head file as feedback for the worker", async () => {
    const latches = new MemorySkipLatchStore();
    const pr = {
      ...makePR({ number: 127, body: "Fixes #12" }),
      head: { ...makePR().head, sha: "headsha" },
      base: { ...makePR().base, ref: "main" },
    } as unknown as Parameters<typeof buildFollowUpSnapshot>[0]["pr"];
    const api = {
      getRepoFile: async (_owner: string, _repo: string, _path: string, ref: string) => {
        if (ref === "headsha") return { found: true, content: "verify: true\n" };
        return { found: false };
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      listCommitStatuses: async () => [],
      listCheckRuns: async () => [],
      listActionJobs: async () => [],
      getBranch: async () => ({ protected: false }),
      getPR: async () => makePR({ number: 127 }),
      listPullCommits: async () => [],
      getPRFiles: async () => [
        { filename: ".jumi.yml", status: "modified" as const, additions: 1, deletions: 0, changes: 1 },
      ],
    };
    const snapshot = await buildFollowUpSnapshot(
      {
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        pr,
        job: makeIssueJob({ defaultBranch: "main" }),
        botUsername: "jumi",
        home: "/tmp/jumi-head-settings-test",
        defaultBranch: "main",
        deployment: {
          maxFollowupRounds: 3,
          maxConflictRounds: 3,
          blockingQuestionAuthors: [],
          followupIgnoreLogins: [],
          trustedSenderLogins: [],
          ignoreConflictsLabel: "ignore-conflicts",
        },
        skipLatches: latches,
      },
      {
        api: api as never,
        log: () => undefined,
        sleep: async () => undefined,
        now: () => new Date("2026-01-01T00:00:00Z"),
      }
    );
    expect(snapshot.hasFeedback).toBe(true);
    expect(snapshot.headSettingsFailure).toContain(".jumi.yml is invalid:");
  });

  test("the board row for an invalid-head skip carries no requeue kick", async () => {
    expect(isHeadSettingsFailureReason(UNKNOWN_KEY_FAILURE)).toBe(true);
    expect(isHeadSettingsFailureReason(".jumi.yml sets mode: off, but review is required")).toBe(true);
    expect(isHeadSettingsFailureReason("boom")).toBe(false);
    expect(isHeadSettingsFailureReason(null)).toBe(false);

    const why = disabledKickWhy(UNKNOWN_KEY_FAILURE);
    expect(typeof why).toBe("string");
    expect(why).toContain("Push a fix to the pull");

    expect(normalizeSitReason(UNKNOWN_KEY_FAILURE)).toBe("terminal-result");
    expect(normalizeSitReason(".jumi.yml sets mode: off, but review is required")).toBe("terminal-result");
  });

  test("an unassigned Jumi closer also queues no follow-up", async () => {
    const store = new MemoryReviewJobStore();
    const row = await leasedReviewRow(store);
    const api = reviewLeaseApi({
      getIssue: async () => makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [] }),
    });
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row,
      botUsername: "jumi",
      published: { status: "skipped", reason: UNKNOWN_KEY_FAILURE },
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((entry) => entry.kind === "follow-up")).toBe(false);
  });
});
