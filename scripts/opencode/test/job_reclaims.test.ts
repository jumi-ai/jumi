import { afterEach, describe, expect, test } from "bun:test";
import { renderEphemeralMetrics, renderRunMetrics, resetControlMetricsForTests } from "../src/control_metrics.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { renderLedgerMetrics } from "../src/run_usage.ts";
import { reclaimExpiredJobs } from "../src/server.ts";
import { releaseLeaseOnShutdown } from "../src/shutdown.ts";
import { reclaimExpiredWorkerJobs } from "../src/worker.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeConfig, makeIssueJob, makeJob } from "./fixtures.ts";

afterEach(() => {
  resetControlMetricsForTests();
});

function engineApi() {
  return makeReviewApi({
    getPRFiles: async () => [],
    createIssueComment: async () => ({ id: 1, body: "x" }) as never,
    updateIssueComment: async () => ({ id: 1, body: "x" }) as never,
    createPullReview: async () => ({ id: 1 }) as never,
    createCommitStatus: async (_o, _r, _s, status) => status as never,
    listCommitStatuses: async () => [],
  }) as never;
}

describe("durable reclaim counters", () => {
  test("lease_expired_requeued increments count and leased seconds", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 1, new Date(1_000));
    expect(leased?.leasedStartedAt).toBe(1_000);
    const result = await store.reclaimExpired(2, new Date(1_000 + 45_000), 30_000);
    expect(result.requeued).toHaveLength(1);
    const totals = await store.getJobReclaimTotals();
    expect(totals).toContainEqual({ kind: "review", reason: "lease_expired_requeued", count: 1, leasedSeconds: 45 });
    const text = await renderLedgerMetrics(store);
    expect(text).toContain('jumi_jobs_reclaimed_total{kind="review",reason="lease_expired_requeued"} 1');
    expect(text).toContain(
      'jumi_jobs_reclaimed_leased_seconds_total{kind="review",reason="lease_expired_requeued"} 45'
    );
    expect(text).toContain('jumi_jobs_reclaimed_total{kind="implement",reason="lease_expired_requeued"} 0');
  });

  test("lease_expired_exhausted increments on the last allowed attempt", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    await store.lease("engine-1", 60_000, new Date(2_000));
    const result = await store.reclaimExpired(1, new Date(2_000 + 120_000), 30_000);
    expect(result.requeued).toHaveLength(0);
    expect(result.publish).toHaveLength(1);
    const totals = await store.getJobReclaimTotals();
    expect(totals).toContainEqual({
      kind: "review",
      reason: "lease_expired_exhausted",
      count: 1,
      leasedSeconds: 120,
    });
    const text = await renderLedgerMetrics(store);
    expect(text).toContain('jumi_jobs_reclaimed_total{kind="review",reason="lease_expired_exhausted"} 1');
    expect(text).toContain(
      'jumi_jobs_reclaimed_leased_seconds_total{kind="review",reason="lease_expired_exhausted"} 120'
    );
  });

  test("shutdown_released increments without consuming an attempt", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(5_000));
    const messages: string[] = [];
    await releaseLeaseOnShutdown(store, leased!.id, leased!.jobKey, "engine-1", (m) => messages.push(m), "expire");
    expect(messages).toContain(`released ${leased!.jobKey} on shutdown`);
    const after = await store.get(leased!.id);
    expect(after?.state).toBe("queued");
    expect(after?.attempt).toBe(0);
    const totals = await store.getJobReclaimTotals();
    // shutdownRelease uses the real clock for `now`; elapsed is >= 0 and bounded.
    expect(totals).toHaveLength(1);
    expect(totals[0]?.kind).toBe("review");
    expect(totals[0]?.reason).toBe("shutdown_released");
    expect(totals[0]?.count).toBe(1);
    expect(totals[0]?.leasedSeconds).toBeGreaterThanOrEqual(0);
    const text = await renderLedgerMetrics(store);
    expect(text).toContain('jumi_jobs_reclaimed_total{kind="review",reason="shutdown_released"} 1');
    // A plain releaseLease (abort right after lease) does not count.
    const store2 = new MemoryReviewJobStore();
    await store2.enqueue(makeJob());
    const leased2 = await store2.lease("engine-1", 60_000, new Date(5_000));
    expect(await store2.releaseLease(leased2!.id, "engine-1")).toBe(true);
    expect(await store2.getJobReclaimTotals()).toEqual([]);
  });

  test("shutdown_released elapsed uses the lease start time", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(10_000));
    // Heartbeats extend the lease but must not move the attempt start.
    expect(await store.heartbeat(leased!.id, "engine-1", 60_000, new Date(20_000))).toBe(true);
    expect(await store.shutdownRelease(leased!.id, "engine-1", new Date(70_000))).toBe(true);
    const totals = await store.getJobReclaimTotals();
    expect(totals).toContainEqual({
      kind: "review",
      reason: "shutdown_released",
      count: 1,
      leasedSeconds: 60,
    });
  });

  test("cancel-requested reclaim settles cancelled and does not count", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const leased = await store.lease("worker-1", 1, new Date(1_000), WORKER_JOB_KINDS);
    expect(await store.cancelQueuedForIssue("kirmanak", "demo", 12)).toBe(0);
    expect(await store.isCancelRequested(leased!.id)).toBe(true);
    const result = await store.reclaimExpired(5, new Date(5_000), 1_000, WORKER_JOB_KINDS);
    expect(result.requeued).toHaveLength(0);
    expect(result.publish).toHaveLength(0);
    expect((await store.get(leased!.id))?.state).toBe("cancelled");
    expect(await store.getJobReclaimTotals()).toEqual([]);
    const text = await renderLedgerMetrics(store);
    expect(text).toContain('jumi_jobs_reclaimed_total{kind="implement",reason="lease_expired_requeued"} 0');
    expect(text).toContain(
      'jumi_jobs_reclaimed_leased_seconds_total{kind="implement",reason="lease_expired_requeued"} 0'
    );
  });

  test("router and worker reclaim loops both count (review + worker kinds)", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    await store.enqueueIssue(makeIssueJob());
    await store.lease("engine-1", 1, new Date(1_000), ["review"]);
    await store.lease("worker-1", 1, new Date(1_000), WORKER_JOB_KINDS);
    await reclaimExpiredJobs(store, engineApi(), makeConfig(), () => undefined);
    const totals = await store.getJobReclaimTotals();
    expect(totals).toContainEqual({
      kind: "review",
      reason: "lease_expired_requeued",
      count: 1,
      leasedSeconds: expect.any(Number),
    });
    expect(totals).toContainEqual({
      kind: "implement",
      reason: "lease_expired_requeued",
      count: 1,
      leasedSeconds: expect.any(Number),
    });

    const workerStore = new MemoryReviewJobStore();
    await workerStore.enqueueIssue(makeIssueJob());
    await workerStore.lease("worker-1", 1, new Date(1_000), WORKER_JOB_KINDS);
    const summary = await reclaimExpiredWorkerJobs(workerStore, 2, () => undefined);
    expect(summary).toEqual({ requeued: 1, published: 0 });
    expect(await workerStore.getJobReclaimTotals()).toContainEqual({
      kind: "implement",
      reason: "lease_expired_requeued",
      count: 1,
      leasedSeconds: expect.any(Number),
    });
  });

  test("totals are ledger-backed: they survive an in-process reset and never render from ephemeral pods", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    await store.lease("engine-1", 1, new Date(1_000));
    await store.reclaimExpired(2, new Date(31_000), 30_000);
    resetControlMetricsForTests();
    const text = await renderLedgerMetrics(store);
    expect(text).toContain('jumi_jobs_reclaimed_total{kind="review",reason="lease_expired_requeued"} 1');
    expect(text).toContain(
      'jumi_jobs_reclaimed_leased_seconds_total{kind="review",reason="lease_expired_requeued"} 30'
    );
    // Zero-filled across the existing run-kind labels, like jumi_jobs_completed_total.
    for (const kind of ["review", "implement", "follow-up", "conflict"] as const) {
      for (const reason of ["lease_expired_requeued", "lease_expired_exhausted", "shutdown_released"] as const) {
        expect(text).toContain(`jumi_jobs_reclaimed_total{kind="${kind}",reason="${reason}"}`);
        expect(text).toContain(`jumi_jobs_reclaimed_leased_seconds_total{kind="${kind}",reason="${reason}"}`);
      }
    }
    expect(text).not.toContain("repo=");
    expect(text).not.toContain("jobKey");
    expect(renderEphemeralMetrics()).not.toContain("jumi_jobs_reclaimed");
    expect(renderRunMetrics()).not.toContain("jumi_jobs_reclaimed");
  });
});
