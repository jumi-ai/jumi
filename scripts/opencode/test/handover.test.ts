import { describe, expect, test } from "bun:test";
import { hasJumiLabel } from "../src/github_webhook.ts";
import { enqueueFollowUpFromReview, shouldHandoverFollowUp, TOO_MANY_FOLLOWUP_ROUNDS } from "../src/handover.ts";
import type { ReviewApi } from "../src/review.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { stuckMarker } from "../src/stuck.ts";
import {
  emptyCiMethods,
  makeComment,
  makeIssue,
  makeIssueJob,
  makeJob,
  makePR,
  makeRepo,
  makeUser,
} from "./fixtures.ts";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi & { comments: string[] } {
  const comments: string[] = [];
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () =>
      makePR({
        body: "Fixes #12",
        user: makeUser({ login: "jumi" }),
        head: { ...makePR().head, ref: "jumi/issue-12-fix", sha: "headsha" },
      }),
    getPRFiles: async () => [],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, commentId, body) => {
      comments.push(body);
      return makeComment({ id: commentId, body });
    },
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_owner, _repo, _sha, status) => status,
    ...emptyCiMethods(),
  };
  return { ...defaults, ...overrides, comments };
}

function makeAssignedForeignPR() {
  const repo = makeRepo();
  return makePR({
    user: makeUser({ login: "renovate" }),
    body: "no close keyword",
    assignee: makeUser({ login: "jumi" }),
    assignees: [makeUser({ login: "jumi" })],
    head: { label: "kirmanak:renovate/x", ref: "renovate/x", sha: "headsha", repo, repo_id: repo.id },
  });
}

async function seedSucceededFollowUps(store: MemoryReviewJobStore, count: number, issueNumber = 12): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.enqueueIssue(
      makeIssueJob({
        mode: "follow-up",
        issueNumber,
        prNumber: 7,
        headSha: `sha${i}`,
        delivery: `follow-${i}`,
      })
    );
    const leased = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    await store.markPublished(leased!.id, leased!.leasedBy!, { state: "succeeded" });
  }
}

describe("shouldHandoverFollowUp", () => {
  test("current-head failure or leftover-simplification trailer on a published sticky", () => {
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "blocking\n<!-- jumi-check: failure -->",
      })
    ).toBe(true);
    expect(
      shouldHandoverFollowUp({
        published: { status: "updated" },
        markdown: "blocking\n<!-- jumi-check: failure; 1 blocking -->",
      })
    ).toBe(true);
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "drop the helper\n<!-- jumi-check: success; 2 suggestions -->",
      })
    ).toBe(true);
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "ok\n<!-- jumi-check: success -->",
      })
    ).toBe(false);
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "❓ q: is the timeout intentional?\n<!-- jumi-check: success -->",
      })
    ).toBe(false);
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "no trailer",
      })
    ).toBe(false);
    expect(
      shouldHandoverFollowUp({
        published: { status: "skipped", reason: "Incomplete review: no output" },
        markdown: "blocking\n<!-- jumi-check: failure -->",
      })
    ).toBe(false);
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "",
      })
    ).toBe(false);
  });
});

describe("enqueueFollowUpFromReview", () => {
  test("inserts a follow-up job when the closing issue is still assigned to jumi", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "Please fix tests\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    const follow = store.rows.find((row) => row.kind === "follow-up");
    expect(follow?.state).toBe("queued");
    expect(follow?.issueNumber).toBe(12);
    expect(follow?.prNumber).toBe(7);
    expect(follow?.headSha).toBe("headsha");
    expect(follow?.payload?.title).toBe("Fix the thing");
    expect(api.comments).toEqual([]);
    expect(logs.some((line) => line.includes("persist-insert skipped"))).toBe(false);
  });

  test("inserts a follow-up job when GitHub closing issue is labeled jumi", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi({
      getIssue: async () => makeIssue({ assignee: null, assignees: [], labels: [{ name: "jumi" }] }),
    });
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      isPickedUp: hasJumiLabel,
      published: { status: "posted", commentId: 1 },
      markdown: "Please fix tests\n<!-- jumi-check: failure -->",
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(store.rows.find((row) => row.kind === "follow-up")?.issueNumber).toBe(12);
  });

  test("does not insert when GitHub closing issue lacks jumi label", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi({ getIssue: async () => makeIssue({ labels: [] }) });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      isPickedUp: hasJumiLabel,
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(logs).toEqual(["persist-insert skipped: unassigned"]);
  });

  test("does not insert when the issue is unassigned", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi({
      getIssue: async () => makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [] }),
    });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: unassigned"]);
  });

  test("does not insert when HEAD moved", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi({
      getPR: async () => makePR({ body: "Fixes #12", head: { ...makePR().head, sha: "other" } }),
    });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: head moved"]);
  });

  test("failure trailer at follow-up cap posts stuck and does not enqueue", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 3);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.filter((row) => row.kind === "follow-up" && row.state === "queued")).toHaveLength(0);
    expect(api.comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${TOO_MANY_FOLLOWUP_ROUNDS}`]);
    expect(logs).toEqual(["persist-insert skipped: round cap"]);
  });

  test("failure trailer below maxFollowupRounds enqueues and does not post stuck", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 2);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review!,
      botUsername: "jumi",
      published: { status: "updated", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(api.comments).toEqual([]);
  });

  test("follow-up cap sticks at configured maxFollowupRounds, not only 3", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 3);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const blockedApi = makeApi();
    const blocked = await enqueueFollowUpFromReview({
      store,
      api: blockedApi,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(blocked).toBeUndefined();
    expect(blockedApi.comments.at(-1)).toContain(TOO_MANY_FOLLOWUP_ROUNDS);
    const allowedApi = makeApi();
    const allowed = await enqueueFollowUpFromReview({
      store,
      api: allowedApi,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      maxFollowupRounds: 5,
    });
    expect(allowed).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(allowedApi.comments).toEqual([]);
  });

  test("assigned jumi-identity PR with no closer follows the branch issue", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const repo = makeRepo();
    const api = makeApi({
      getPR: async () =>
        makePR({
          user: makeUser({ login: "jumi" }),
          body: "no close keyword",
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" })],
          head: { label: "kirmanak:jumi/issue-12-x", ref: "jumi/issue-12-x", sha: "headsha", repo, repo_id: repo.id },
        }),
    });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(true);
    expect(store.rows.find((row) => row.kind === "follow-up")?.issueNumber).toBe(12);
    expect(api.comments).toEqual([]);
    expect(logs.some((line) => line.includes("persist-insert skipped"))).toBe(false);
  });

  test("inserts a follow-up when the body says Refs #N on the branch issue", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const repo = makeRepo();
    const api = makeApi({
      getPR: async () =>
        makePR({
          body: "Refs #12",
          user: makeUser({ login: "jumi" }),
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" })],
          head: { label: "kirmanak:jumi/issue-12-x", ref: "jumi/issue-12-x", sha: "headsha", repo, repo_id: repo.id },
        }),
    });
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(store.rows.find((row) => row.kind === "follow-up")?.issueNumber).toBe(12);
  });

  test("does not insert without a closing issue", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi({ getPR: async () => makePR({ body: "no close keyword" }) });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: no closer"]);
  });

  test("labeled GitHub foreign PR failure trailer below cap enqueues keyed by PR number", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const repo = makeRepo({
      html_url: "https://github.com/kirmanak/demo",
      clone_url: "https://github.com/kirmanak/demo.git",
    });
    const api = makeApi({
      getPR: async () =>
        makePR({
          user: makeUser({ login: "renovate[bot]" }),
          body: "no close keyword",
          assignee: null,
          assignees: [],
          labels: [{ name: "jumi" }],
          head: { label: "kirmanak:renovate/x", ref: "renovate/x", sha: "headsha", repo, repo_id: repo.id },
        }),
      getRepo: async () => repo,
    });
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "kirmanak-jumi[bot]",
      isPickedUp: hasJumiLabel,
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(store.rows.find((row) => row.kind === "follow-up")?.issueNumber).toBe(7);
  });

  test("assigned foreign PR failure trailer below cap enqueues keyed by PR number", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi({ getPR: async () => makeAssignedForeignPR() });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    const follow = store.rows.find((row) => row.kind === "follow-up");
    expect(follow?.state).toBe("queued");
    expect(follow?.issueNumber).toBe(7);
    expect(follow?.prNumber).toBe(7);
    expect(follow?.headSha).toBe("headsha");
    expect(api.comments).toEqual([]);
    expect(logs.some((line) => line.includes("persist-insert skipped"))).toBe(false);
  });

  test("assigned foreign PR failure trailer at cap posts stuck and does not enqueue", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 3, 7);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const api = makeApi({ getPR: async () => makeAssignedForeignPR() });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.filter((row) => row.kind === "follow-up" && row.state === "queued")).toHaveLength(0);
    expect(api.comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${TOO_MANY_FOLLOWUP_ROUNDS}`]);
    expect(logs).toEqual(["persist-insert skipped: round cap"]);
  });

  test("success trailer with leftover simplifications enqueues follow-up", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "drop the helper\n<!-- jumi-check: success; 2 suggestions -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    const follow = store.rows.find((row) => row.kind === "follow-up");
    expect(follow?.state).toBe("queued");
    expect(follow?.payload?.trigger).toEqual({ event: "review-suggestions", sender: "jumi" });
    expect(api.comments).toEqual([]);
    expect(logs.some((line) => line.includes("persist-insert skipped"))).toBe(false);
  });

  test("success trailer neither enqueues nor posts stuck", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "ok\n<!-- jumi-check: success -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: success trailer"]);
  });

  test("incomplete review neither enqueues nor posts stuck", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "no trailer",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: incomplete"]);
  });

  test("cancel after the lifetime cap lets a later failing review handover again", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 3);
    expect(await store.countSucceeded("follow-up", "kirmanak", "demo", 12)).toBe(3);
    expect(store.rows.filter((row) => row.kind === "follow-up" && row.state === "succeeded")).toHaveLength(3);
    await store.clearIssueSkipLatch("kirmanak", "demo", 12);
    expect(await store.countSucceeded("follow-up", "kirmanak", "demo", 12)).toBe(0);
    expect(store.rows.filter((row) => row.kind === "follow-up" && row.state === "succeeded")).toHaveLength(3);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(api.comments).toEqual([]);
    expect(store.rows.find((row) => row.kind === "follow-up" && row.state === "queued")?.payload?.generation).toBe(1);
  });

  test("human-comment follow-ups in the current generation still count toward the cap", async () => {
    const store = new MemoryReviewJobStore();
    await store.clearIssueSkipLatch("kirmanak", "demo", 12);
    await seedSucceededFollowUps(store, 2);
    await store.enqueueIssue(
      makeIssueJob({
        mode: "follow-up",
        issueNumber: 12,
        prNumber: 7,
        headSha: "comment-sha",
        delivery: "comment-follow",
        trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      })
    );
    const leased = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    await store.markPublished(leased!.id, leased!.leasedBy!, { state: "succeeded" });
    expect(await store.countSucceeded("follow-up", "kirmanak", "demo", 12)).toBe(3);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.filter((row) => row.kind === "follow-up" && row.state === "queued")).toHaveLength(0);
    expect(api.comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${TOO_MANY_FOLLOWUP_ROUNDS}`]);
    expect(logs).toEqual(["persist-insert skipped: round cap"]);
  });

  test("round cap does not unassign the issue", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 3);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const issue = makeIssue();
    const api = makeApi({
      getIssue: async () => issue,
    });
    await enqueueFollowUpFromReview({
      store,
      api,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(issue.assignee?.login).toBe("jumi");
    expect(issue.assignees?.map((user) => user.login)).toEqual(["jumi"]);
    expect(api.comments.some((body) => body.includes("unassign"))).toBe(false);
  });
});
