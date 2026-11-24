import { describe, expect, test } from "bun:test";
import type { CheckPayload } from "../src/ports.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { markSuggestionHoldConsumed } from "../src/suggestion_hold.ts";
import type { IssueJob } from "../src/types.ts";
import { processWorkerTick } from "../src/worker.ts";
import {
  assertValidIssueJobForEnqueue,
  decodeWorkerJobIntent,
  INVALID_JOB_INTENT_PREFIX,
  InvalidJobIntentError,
  type WorkerJobIntentKind,
} from "../src/worker_intent.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssueJob, makeWorkerConfig } from "./fixtures.ts";

function apiWithStatusLog() {
  const statuses: Array<{ sha: string; state: string; description?: string }> = [];
  const api = {
    ...makeIssueApi({
      findStickyIssueComment: async () => ({ id: 9 }),
      createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
      updateIssueComment: async (_owner, _repo, id, body) => makeComment({ id, body }),
    }),
    createCommitStatus: async (_owner: string, _repo: string, sha: string, status: CheckPayload) => {
      statuses.push({ sha, state: status.state, description: status.description });
      return status;
    },
  };
  return { api, statuses };
}

describe("decodeWorkerJobIntent", () => {
  test("every real producer shape enqueues and decodes with the expected intent", async () => {
    const cases: Array<{ name: string; job: IssueJob; expected: WorkerJobIntentKind }> = [
      {
        name: "implement",
        job: makeIssueJob({ delivery: "d-implement" }),
        expected: "implement",
      },
      {
        name: "comment follow-up with head",
        job: makeIssueJob({ delivery: "d-comment", mode: "follow-up", prNumber: 127, headSha: "headsha" }),
        expected: "follow-up",
      },
      {
        name: "comment follow-up without head",
        job: makeIssueJob({ delivery: "d-nohead", mode: "follow-up", prNumber: 127, headSha: undefined }),
        expected: "follow-up",
      },
      {
        name: "takeover follow-up without head",
        job: makeIssueJob({
          delivery: "d-takeover",
          mode: "follow-up",
          prNumber: 128,
          headSha: undefined,
          action: "takeover",
        }),
        expected: "follow-up",
      },
      {
        name: "handover follow-up",
        job: makeIssueJob({
          delivery: "d-handover",
          mode: "follow-up",
          prNumber: 129,
          headSha: "hs",
          action: "review-failure",
        }),
        expected: "follow-up",
      },
      {
        name: "shared-failure waiter merge-only",
        job: makeIssueJob({
          delivery: "d-waiter",
          mode: "follow-up",
          prNumber: 130,
          headSha: "hs",
          action: "push",
          mergeOnly: true,
        }),
        expected: "follow-up-merge-only",
      },
      {
        name: "push-webhook merge-only",
        job: makeIssueJob({
          delivery: "d-push",
          mode: "follow-up",
          prNumber: 131,
          headSha: "hs",
          action: "push",
          mergeOnly: true,
        }),
        expected: "follow-up-merge-only",
      },
      {
        name: "strict refresh",
        job: makeIssueJob({
          delivery: "d-strict",
          mode: "follow-up",
          prNumber: 132,
          headSha: "hs",
          action: "push",
          mergeOnly: true,
          strictRefresh: true,
          strictBaseSha: "base",
        }),
        expected: "follow-up-strict-refresh",
      },
      {
        name: "pickup conflict",
        job: makeIssueJob({ delivery: "d-pickup", mode: "conflict", prNumber: 133, headSha: "hs" }),
        expected: "conflict",
      },
      {
        name: "conflict spread from a merge-only parent keeps working",
        job: makeIssueJob({
          delivery: "d-spread",
          mode: "conflict",
          prNumber: 134,
          headSha: "hs2",
          mergeOnly: true,
          strictRefresh: true,
        }),
        expected: "conflict",
      },
      {
        name: "implement ignores leaked flags",
        job: makeIssueJob({ delivery: "d-impl-flags", mergeOnly: true, strictRefresh: true }),
        expected: "implement",
      },
    ];
    for (const { name, job, expected } of cases) {
      const store = new MemoryReviewJobStore();
      const enqueued = await store.enqueueIssue(job);
      expect(enqueued, name).toEqual({ key: enqueued.key, queued: true });
      expect(decodeWorkerJobIntent(store.rows[0]!).kind, name).toBe(expected);
    }
  });

  test("legacy payload without generation decodes unchanged", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ delivery: "d-legacy", mode: "follow-up", prNumber: 7, headSha: "sha" }));
    const row = store.rows[0]!;
    const { generation: _dropped, ...legacy } = row.payload as unknown as Record<string, unknown>;
    row.payload = legacy as unknown as NonNullable<typeof row.payload>;
    expect(decodeWorkerJobIntent(row)).toEqual({ kind: "follow-up" });
  });

  test("missing payload and each invalid flag combination throw the typed error", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ delivery: "d-missing", mode: "follow-up", prNumber: 7, headSha: "sha" }));
    const missing = { ...store.rows[0]!, payload: null };
    expect(() => decodeWorkerJobIntent(missing)).toThrow(InvalidJobIntentError);

    const badRows = [
      { ...store.rows[0]!, kind: "follow-up" as const, prNumber: 0 },
      { ...store.rows[0]!, kind: "conflict" as const, prNumber: 0 },
    ];
    for (const row of badRows) {
      expect(() => decodeWorkerJobIntent(row)).toThrow(InvalidJobIntentError);
    }
    const strictWithoutMerge = {
      ...store.rows[0]!,
      kind: "follow-up" as const,
      payload: { ...store.rows[0]!.payload!, strictRefresh: true, mergeOnly: undefined },
    };
    expect(() => decodeWorkerJobIntent(strictWithoutMerge)).toThrow(InvalidJobIntentError);

    const badJobs: IssueJob[] = [
      makeIssueJob({ mode: "follow-up", prNumber: 0, headSha: "sha" }),
      makeIssueJob({ mode: "follow-up", headSha: "sha" }),
      makeIssueJob({ mode: "conflict", prNumber: 0, headSha: "sha" }),
      makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha", strictRefresh: true }),
    ];
    for (const job of badJobs) {
      expect(() => assertValidIssueJobForEnqueue(job)).toThrow(InvalidJobIntentError);
      await expect(store.enqueueIssue({ ...job, delivery: `d-bad-${Math.random()}` })).rejects.toThrow(
        InvalidJobIntentError
      );
    }
  });
});

describe("processWorkerTick invalid job intent", () => {
  test("corrupt follow-up settles failed with the prefix and never runs", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(
      makeIssueJob({ delivery: "d-corrupt", mode: "follow-up", prNumber: 19, headSha: "abc123" })
    );
    await markSuggestionHoldConsumed(
      store.skipLatches,
      { owner: "kirmanak", repo: "demo", issueNumber: 12 },
      "abc123",
      2
    );
    store.rows[0]!.prNumber = 0;
    const { api, statuses } = apiWithStatusLog();
    let runs = 0;
    const fail = async () => {
      runs++;
      throw new Error("runner must not run");
    };
    const result = await processWorkerTick(store, makeWorkerConfig(), api, "worker-1", {
      implement: fail,
      followUp: fail,
      conflict: fail,
    });
    expect(result).toBe("processed");
    expect(runs).toBe(0);
    expect(store.rows[0]?.state).toBe("failed");
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.resultReason?.startsWith(INVALID_JOB_INTENT_PREFIX)).toBe(true);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.description).toContain("job failed");
    expect(await processWorkerTick(store, makeWorkerConfig(), api, "worker-2")).toBe("idle");
  });

  test("cancel-requested malformed row settles cancelled without hold resolution", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(
      makeIssueJob({ delivery: "d-cancel", mode: "follow-up", prNumber: 19, headSha: "abc123" })
    );
    store.rows[0]!.prNumber = 0;
    const { api, statuses } = apiWithStatusLog();
    const slowApi = { ...api, getRepoFile: async () => Bun.sleep(50).then(() => ({ found: false as const })) };
    let runs = 0;
    const tick = processWorkerTick(store, makeWorkerConfig(), slowApi, "worker-1", {
      followUp: async () => {
        runs++;
        return { status: "pushed" as const, prNumber: 19, htmlUrl: "https://example" };
      },
    });
    while (store.rows[0]?.state !== "leased") await Bun.sleep(1);
    store.rows[0]!.cancelRequested = true;
    expect(await tick).toBe("processed");
    expect(runs).toBe(0);
    expect(store.rows[0]?.state as string).toBe("cancelled");
    expect(statuses).toHaveLength(0);
  });

  test("settlement failure leaves the row unsettled and a retry can settle it", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(
      makeIssueJob({ delivery: "d-outage", mode: "follow-up", prNumber: 19, headSha: "abc123" })
    );
    store.rows[0]!.prNumber = 0;
    const { api, statuses } = apiWithStatusLog();
    const realMarkPublished = store.markPublished.bind(store);
    store.markPublished = async () => {
      throw new Error("cannot mark published for job 1");
    };
    let runs = 0;
    const result = await processWorkerTick(store, makeWorkerConfig(), api, "worker-1", {
      followUp: async () => {
        runs++;
        return { status: "pushed" as const, prNumber: 19, htmlUrl: "https://example" };
      },
    });
    expect(result).toBe("processed");
    expect(runs).toBe(0);
    expect(statuses).toHaveLength(0);
    expect(store.rows[0]?.state).not.toBe("failed");
    store.markPublished = realMarkPublished;
    store.rows[0]!.state = "queued";
    store.rows[0]!.leasedBy = null;
    store.rows[0]!.leasedUntil = null;
    expect(await processWorkerTick(store, makeWorkerConfig(), api, "worker-1")).toBe("processed");
    expect(runs).toBe(0);
    expect(store.rows[0]?.state as string).toBe("failed");
    expect(store.rows[0]?.resultReason?.startsWith(INVALID_JOB_INTENT_PREFIX)).toBe(true);
  });
});
