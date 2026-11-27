import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  JOB_RECLAIMS_SCHEMA_SQL,
  PgReviewJobStore,
  REVIEW_JOBS_SCHEMA_SQL,
  WORKER_JOB_KINDS,
} from "../src/review_jobs.ts";
import { renderLedgerMetrics } from "../src/run_usage.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

describePg("durable reclaim counters against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    sql = openTestSqlClient(pgDatabaseUrl);
    await sql.unsafe(REVIEW_JOBS_SCHEMA_SQL);
    await sql.unsafe(JOB_RECLAIMS_SCHEMA_SQL);
    await sql.unsafe(`DELETE FROM jumi_job_reclaims`);
    await sql.unsafe(`DELETE FROM review_jobs`);
    store = new PgReviewJobStore(sql);
    await store.migrate();
    await sql.unsafe(`DELETE FROM jumi_job_reclaims`);
    await sql.unsafe(`DELETE FROM review_jobs`);
  });

  afterAll(async () => {
    await sql?.close?.();
  });

  test("requeue and exhausted paths record with elapsed seconds", async () => {
    await sql.unsafe(`DELETE FROM jumi_job_reclaims`);
    await sql.unsafe(`DELETE FROM review_jobs`);
    await store.enqueue(makeJob({ delivery: "pg-requeue" }));
    const leased = await store.lease("engine-1", 1, new Date(1_000));
    expect(leased?.leasedStartedAt).toBe(1_000);
    const requeued = await store.reclaimExpired(2, new Date(46_000), 30_000);
    expect(requeued.requeued).toHaveLength(1);
    let totals = await store.getJobReclaimTotals();
    expect(totals).toContainEqual({
      kind: "review",
      reason: "lease_expired_requeued",
      count: 1,
      leasedSeconds: 45,
    });

    await store.enqueue(makeJob({ delivery: "pg-exhaust", prNumber: 8, headSha: "other" }));
    await store.lease("engine-1", 1, new Date(2_000), ["review"]);
    const exhausted = await store.reclaimExpired(1, new Date(122_000), 30_000, ["review"]);
    // One of the two expired rows exhausts (maxAttempts=1); the requeued row above is queued, not leased.
    expect(exhausted.publish.length).toBeGreaterThanOrEqual(1);
    totals = await store.getJobReclaimTotals();
    const exhaustedTotal = totals.find((t) => t.reason === "lease_expired_exhausted");
    expect(exhaustedTotal?.count).toBeGreaterThanOrEqual(1);
    expect(exhaustedTotal?.leasedSeconds).toBeGreaterThan(0);

    const text = await renderLedgerMetrics(store);
    expect(text).toContain('jumi_jobs_reclaimed_total{kind="review",reason="lease_expired_requeued"} 1');
    expect(text).toContain(
      'jumi_jobs_reclaimed_leased_seconds_total{kind="review",reason="lease_expired_requeued"} 45'
    );
  });

  test("worker reclaim loop and cancel exclusion", async () => {
    await sql.unsafe(`DELETE FROM jumi_job_reclaims`);
    await sql.unsafe(`DELETE FROM review_jobs`);
    await store.enqueueIssue(makeIssueJob({ delivery: "pg-worker" }));
    const leased = await store.lease("worker-1", 1, new Date(1_000), WORKER_JOB_KINDS);
    expect(leased?.leasedStartedAt).toBe(1_000);
    const result = await store.reclaimExpired(5, new Date(11_000), 1_000, WORKER_JOB_KINDS);
    expect(result.requeued).toHaveLength(1);
    expect(await store.getJobReclaimTotals()).toContainEqual({
      kind: "implement",
      reason: "lease_expired_requeued",
      count: 1,
      leasedSeconds: 10,
    });

    // Isolate the cancel path so the lease below is guaranteed to be the
    // cancel-requested row (otherwise the requeued row above wins the lease).
    await sql.unsafe(`DELETE FROM jumi_job_reclaims`);
    await sql.unsafe(`DELETE FROM review_jobs`);
    await store.enqueueIssue(makeIssueJob({ delivery: "pg-cancel", issueNumber: 13 }));
    const flagged = await store.lease("worker-1", 1, new Date(20_000), WORKER_JOB_KINDS);
    expect(flagged?.issueNumber).toBe(13);
    await store.cancelQueuedForIssue("kirmanak", "demo", 13);
    expect(await store.isCancelRequested(flagged!.id)).toBe(true);
    const again = await store.reclaimExpired(5, new Date(30_000), 1_000, WORKER_JOB_KINDS);
    // The cancel-requested row settles to cancelled and records nothing new.
    expect(again.requeued).toHaveLength(0);
    expect(again.publish).toHaveLength(0);
    expect((await store.get(flagged!.id))?.state).toBe("cancelled");
    expect(await store.getJobReclaimTotals()).toEqual([]);
  });

  test("shutdown release records and survives a new store on the same database", async () => {
    await sql.unsafe(`DELETE FROM jumi_job_reclaims`);
    await sql.unsafe(`DELETE FROM review_jobs`);
    await store.enqueue(makeJob({ delivery: "pg-shutdown" }));
    const leased = await store.lease("engine-1", 60_000, new Date(5_000));
    expect(await store.shutdownRelease(leased!.id, "engine-1", new Date(25_000))).toBe(true);
    // A fresh store object on the same database sees the same ledger totals: restart-safe.
    const reopened = new PgReviewJobStore(sql);
    const totals = await reopened.getJobReclaimTotals();
    expect(totals).toContainEqual({
      kind: "review",
      reason: "shutdown_released",
      count: 1,
      leasedSeconds: 20,
    });
    const text = await renderLedgerMetrics(reopened);
    expect(text).toContain('jumi_jobs_reclaimed_total{kind="review",reason="shutdown_released"} 1');
    expect(text).toContain('jumi_jobs_reclaimed_leased_seconds_total{kind="review",reason="shutdown_released"} 20');
  });
});
