import { describe, expect, test } from "bun:test";
import { JUMI_REVIEW_CONTEXT } from "../src/ci.ts";
import type { Check } from "../src/ports.ts";
import { HEARTBEAT_MS, MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { reclaimExpiredJobs } from "../src/server.ts";
import {
  EXHAUSTED_FOLLOW_UP_HOLD_KIND,
  EXHAUSTED_FOLLOW_UP_HOLD_REASON,
  isMaintainerHoldPendingDescription,
  isSuggestionHoldPendingDescription,
  resolveExhaustedFollowUpHoldOrThrow,
} from "../src/exhausted_hold.ts";
import {
  markSuggestionHoldConsumed,
  suggestionHoldSkippedDescription,
} from "../src/suggestion_hold.ts";
import { reclaimExpiredWorkerJobs } from "../src/worker.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeComment, makeConfig, makeIssueJob, makePR } from "./fixtures.ts";

const OWNER = "kirmanak";
const REPO = "demo";
const ISSUE = 12;
const PR = 19;
const HEAD = "abc123";

function suggestionPending(count = 2) {
  return [
    {
      id: 1,
      context: JUMI_REVIEW_CONTEXT,
      state: "pending" as const,
      description: `${count} suggestions waiting for follow-up`,
    },
  ];
}

function maintainerPending() {
  return [
    {
      id: 2,
      context: JUMI_REVIEW_CONTEXT,
      state: "pending" as const,
      description: "waiting on maintainer: 1 question",
    },
  ];
}

function commentsTracker() {
  let sticky: { id: number } | undefined;
  let creates = 0;
  let updates = 0;
  return {
    find: async () => sticky,
    create: async (_owner: string, _repo: string, _index: number, body: string) => {
      creates++;
      sticky = { id: 7 };
      return makeComment({ id: 7, body });
    },
    update: async (_owner: string, _repo: string, _commentId: number, body: string) => {
      updates++;
      return makeComment({ id: 7, body });
    },
    counts: () => ({ creates, updates }),
  };
}

function routerApi(opts: {
  statuses?: Check[];
  failStatusTimes?: number;
  onStatus?: (status: { state: string; description?: string }) => void;
  prNumber?: number;
}) {
  const comments = commentsTracker();
  const statuses: Array<{ sha: string; state: string; description?: string }> = [];
  let statusCalls = 0;
  const api = makeReviewApi({
    findStickyIssueComment: comments.find,
    createIssueComment: comments.create,
    updateIssueComment: comments.update,
    getPR: async (_owner, _repo, index) => makePR({ number: opts.prNumber ?? index }),
    listCommitStatuses: async () => opts.statuses ?? [],
    createCommitStatus: async (_owner, _repo, sha, status) => {
      statusCalls++;
      if (opts.failStatusTimes != null && statusCalls <= opts.failStatusTimes) throw new Error("gitea 502");
      statuses.push({ sha, state: status.state, description: status.description });
      opts.onStatus?.({ state: status.state, description: status.description });
      return status;
    },
  });
  return { api, comments, statuses, statusCalls: () => statusCalls };
}

async function exhaustFollowUp(store: MemoryReviewJobStore, overrides: Record<string, unknown> = {}) {
  await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: PR, headSha: HEAD, ...overrides }));
  await store.lease("worker-1", 1, new Date(Date.now() - 10_000), WORKER_JOB_KINDS);
}

describe("router reclaim resolves exhausted follow-up holds", () => {
  test("suggestion-only hold resolves with the standing worker disposition", async () => {
    const store = new MemoryReviewJobStore();
    await exhaustFollowUp(store);
    await markSuggestionHoldConsumed(store.skipLatches, { owner: OWNER, repo: REPO, issueNumber: ISSUE }, HEAD, 2);
    const { api, comments, statuses } = routerApi({ statuses: suggestionPending(2) });

    const summary = await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    expect(summary).toEqual({ requeued: 0, published: 1 });
    expect(store.rows[0]?.state).toBe("failed");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ sha: HEAD, state: "success" });
    expect(statuses[0]?.description).toBe(suggestionHoldSkippedDescription(2, "job failed"));
    expect(EXHAUSTED_FOLLOW_UP_HOLD_KIND).toBe("skipped");
    expect(EXHAUSTED_FOLLOW_UP_HOLD_REASON).toBe("job failed");
    expect(comments.counts().creates).toBe(1);
  });

  test("maintainer hold stays pending while the row still publishes", async () => {
    const store = new MemoryReviewJobStore();
    await exhaustFollowUp(store);
    await markSuggestionHoldConsumed(store.skipLatches, { owner: OWNER, repo: REPO, issueNumber: ISSUE }, HEAD, 2);
    const { api, statuses } = routerApi({ statuses: maintainerPending() });

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    expect(store.rows[0]?.state).toBe("failed");
    expect(statuses).toHaveLength(0);
  });

  test("mixed suggestion plus maintainer pending stays pending", async () => {
    const store = new MemoryReviewJobStore();
    await exhaustFollowUp(store);
    await markSuggestionHoldConsumed(store.skipLatches, { owner: OWNER, repo: REPO, issueNumber: ISSUE }, HEAD, 2);
    const { api, statuses } = routerApi({ statuses: [...suggestionPending(2), ...maintainerPending()] });

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    expect(store.rows[0]?.state).toBe("failed");
    expect(statuses).toHaveLength(0);
  });

  test("any other hold type stays pending", async () => {
    const store = new MemoryReviewJobStore();
    await exhaustFollowUp(store);
    await markSuggestionHoldConsumed(store.skipLatches, { owner: OWNER, repo: REPO, issueNumber: ISSUE }, HEAD, 2);
    const { api, statuses } = routerApi({
      statuses: [{ id: 3, context: JUMI_REVIEW_CONTEXT, state: "pending", description: "some future hold" }],
    });

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    expect(store.rows[0]?.state).toBe("failed");
    expect(statuses).toHaveLength(0);
  });

  test("implement exhaustion never resolves a hold", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "implement" }));
    await store.lease("worker-1", 1, new Date(Date.now() - 10_000), WORKER_JOB_KINDS);
    await markSuggestionHoldConsumed(store.skipLatches, { owner: OWNER, repo: REPO, issueNumber: ISSUE }, HEAD, 2);
    const { api, statuses } = routerApi({ statuses: suggestionPending(2) });

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    expect(store.rows[0]?.state).toBe("failed");
    expect(statuses).toHaveLength(0);
  });

  test("follow-up without a consumed hold publishes without a status write", async () => {
    const store = new MemoryReviewJobStore();
    await exhaustFollowUp(store);
    const { api, statuses } = routerApi({ statuses: suggestionPending(2) });

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    expect(store.rows[0]?.state).toBe("failed");
    expect(statuses).toHaveLength(0);
  });

  test("hold for a moved head is left alone", async () => {
    const store = new MemoryReviewJobStore();
    await exhaustFollowUp(store);
    await markSuggestionHoldConsumed(store.skipLatches, { owner: OWNER, repo: REPO, issueNumber: ISSUE }, "oldhead", 2);
    const { api, statuses } = routerApi({ statuses: suggestionPending(2) });

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    expect(store.rows[0]?.state).toBe("failed");
    expect(statuses).toHaveLength(0);
  });

  test("stale reclaim token cannot resolve the hold for the new claim", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: PR, headSha: HEAD }));
    const leased = await store.lease("dead-worker", 1, new Date(1_000), WORKER_JOB_KINDS);
    await markSuggestionHoldConsumed(store.skipLatches, { owner: OWNER, repo: REPO, issueNumber: ISSUE }, HEAD, 2);
    await store.reclaimExpired(2, new Date(5_000), HEARTBEAT_MS, WORKER_JOB_KINDS);
    await store.lease("dead-worker", 1, new Date(6_000), WORKER_JOB_KINDS);
    const first = await store.reclaimExpired(2, new Date(10_000), HEARTBEAT_MS, WORKER_JOB_KINDS);
    expect(first.publish).toHaveLength(1);
    const staleToken = first.publish[0]!.leasedBy!;
    const second = await store.reclaimExpired(2, new Date(10_000 + 30_001), HEARTBEAT_MS, WORKER_JOB_KINDS);
    expect(second.publish).toHaveLength(1);
    const liveToken = second.publish[0]!.leasedBy!;
    expect(liveToken).not.toBe(staleToken);

    const { api, statuses } = routerApi({ statuses: suggestionPending(2) });
    const row = second.publish[0]!;
    const stale = await resolveExhaustedFollowUpHoldOrThrow({ api, store, row, ownerToken: staleToken });
    expect(stale).toEqual({ resolved: false, reason: "stale-owner" });
    expect(statuses).toHaveLength(0);

    const live = await resolveExhaustedFollowUpHoldOrThrow({ api, store, row, ownerToken: liveToken });
    expect(live.resolved).toBe(true);
    expect(statuses).toHaveLength(1);
    expect(leased!.id).toBe(row.id);
  });

  test("failed status write retries on the next pass and ends with one resolved status", async () => {
    const store = new MemoryReviewJobStore();
    await exhaustFollowUp(store);
    await markSuggestionHoldConsumed(store.skipLatches, { owner: OWNER, repo: REPO, issueNumber: ISSUE }, HEAD, 2);
    const { api, comments, statuses } = routerApi({ statuses: suggestionPending(2), failStatusTimes: 1 });

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);
    expect(store.rows[0]?.state).toBe("leased");
    expect(store.rows[0]?.publishedAt).toBeNull();
    expect(statuses).toHaveLength(0);

    await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);
    expect(store.rows[0]?.state).toBe("failed");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.description).toBe(suggestionHoldSkippedDescription(2, "job failed"));
    // The sticky failure comment is upserted, not duplicated: one create, one update.
    expect(comments.counts()).toEqual({ creates: 1, updates: 1 });
  });

  test("worker reclaim resolves the same way as the router", async () => {
    const workerStore = new MemoryReviewJobStore();
    await workerStore.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: PR, headSha: HEAD }));
    await workerStore.lease("worker-1", 1, new Date(Date.now() - 10_000), WORKER_JOB_KINDS);
    await markSuggestionHoldConsumed(
      workerStore.skipLatches,
      { owner: OWNER, repo: REPO, issueNumber: ISSUE },
      HEAD,
      2
    );
    const workerComments = commentsTracker();
    const workerStatuses: Array<{ sha: string; state: string; description?: string }> = [];
    const workerApi = {
      findStickyIssueComment: workerComments.find,
      createIssueComment: workerComments.create,
      updateIssueComment: workerComments.update,
      getPR: async (_owner: string, _repo: string, index: number) => makePR({ number: index }),
      listCommitStatuses: async () => suggestionPending(2),
      createCommitStatus: async (_owner: string, _repo: string, sha: string, status: { state: string }) => {
        workerStatuses.push({ sha, state: status.state });
        return status;
      },
    };
    await reclaimExpiredWorkerJobs(workerStore, 1, () => undefined, { api: workerApi, botUsername: "jumi" });
    expect(workerStore.rows[0]?.state).toBe("failed");
    expect(workerStatuses).toHaveLength(1);

    const routerStore = new MemoryReviewJobStore();
    await exhaustFollowUp(routerStore);
    await markSuggestionHoldConsumed(
      routerStore.skipLatches,
      { owner: OWNER, repo: REPO, issueNumber: ISSUE },
      HEAD,
      2
    );
    const { api, statuses } = routerApi({ statuses: suggestionPending(2) });
    await reclaimExpiredJobs(routerStore, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);
    expect(routerStore.rows[0]?.state).toBe("failed");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.description).toBe(suggestionHoldSkippedDescription(2, "job failed"));
    expect(workerStatuses[0]?.state).toBe("success");
  });
});

describe("exhausted hold description predicates", () => {
  test("only suggestion pending text counts as suggestion-origin", () => {
    expect(isSuggestionHoldPendingDescription("2 suggestions waiting for follow-up")).toBe(true);
    expect(isSuggestionHoldPendingDescription("1 suggestion waiting for follow-up")).toBe(true);
    expect(isSuggestionHoldPendingDescription("waiting on maintainer: 1 question")).toBe(false);
    expect(isSuggestionHoldPendingDescription("some future hold")).toBe(false);
    expect(isSuggestionHoldPendingDescription(undefined)).toBe(false);
  });

  test("only maintainer pending text counts as maintainer-held", () => {
    expect(isMaintainerHoldPendingDescription("waiting on maintainer: 1 question")).toBe(true);
    expect(isMaintainerHoldPendingDescription("2 suggestions waiting for follow-up")).toBe(false);
    expect(isMaintainerHoldPendingDescription(undefined)).toBe(false);
  });
});
