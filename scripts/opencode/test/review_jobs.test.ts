import { describe, expect, test } from "bun:test";
import { encodeCiLookupMarker } from "../src/ci.ts";
import { encodeInfraMarker, INFRA_RETRY_PREFIX } from "../src/infra.ts";
import { encodeQuotaWaitMarker } from "../src/quota.ts";
import {
  HEARTBEAT_MS,
  isUniqueViolation,
  MemoryReviewJobStore,
  PgReviewJobStore,
  QueueUnavailableError,
  RECLAIM_LEASED_BY,
  REVIEW_JOBS_SCHEMA_SQL,
  WORKER_JOB_KINDS,
} from "../src/review_jobs.ts";
import { ISSUE_SKIP_LATCHES_SCHEMA_SQL } from "../src/skip_latches.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";

describe("MemoryReviewJobStore", () => {
  test("dedupes in-flight job_key", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeJob();
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });
    const leased = await store.lease("engine-1", 60_000);
    expect(leased?.state).toBe("leased");
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });
  });

  test("redelivery of succeeded or skipped SHA does not insert", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeJob();
    await store.enqueue(job);
    const leased = await store.lease("engine-1", 60_000);
    await store.markPublished(leased!.id, "engine-1", { state: "succeeded" });
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });
    expect(store.rows.filter((row) => row.jobKey === "kirmanak/demo#7:headsha")).toHaveLength(1);

    const skipped = makeJob({ headSha: "skippedsha" });
    await store.enqueue(skipped);
    const leasedSkip = await store.lease("engine-1", 60_000);
    await store.saveResult(leasedSkip!.id, "engine-1", { kind: "skip", reason: "Incomplete review: no output" });
    await store.markPublished(leasedSkip!.id, "engine-1", { state: "skipped", reason: "Incomplete review: no output" });
    expect(await store.enqueue(skipped)).toEqual({ key: "kirmanak/demo#7:skippedsha", queued: false });

    const headChange = makeJob({ headSha: "movedsha" });
    await store.enqueue(headChange);
    const leasedHead = await store.lease("engine-1", 60_000);
    await store.markPublished(leasedHead!.id, "engine-1", {
      state: "skipped",
      reason: "PR head changed from movedsha to newsha",
    });
    expect(await store.enqueue(headChange)).toEqual({ key: "kirmanak/demo#7:movedsha", queued: false });
  });

  test("closed or merged skip is not terminal; reopen can insert", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeJob();
    await store.enqueue(job);
    const leased = await store.lease("engine-1", 60_000);
    await store.markPublished(leased!.id, "engine-1", { state: "skipped", reason: "PR is closed" });
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(store.rows.filter((row) => row.jobKey === "kirmanak/demo#7:headsha" && row.state === "queued")).toHaveLength(
      1
    );

    const merged = makeJob({ headSha: "mergedsha" });
    await store.enqueue(merged);
    const leasedMerged = await store.lease("engine-1", 60_000);
    await store.markPublished(leasedMerged!.id, "engine-1", { state: "skipped", reason: "PR is already merged" });
    expect(await store.enqueue(merged)).toEqual({ key: "kirmanak/demo#7:mergedsha", queued: true });
  });

  test("failed SHA may be retried", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeJob();
    await store.enqueue(job);
    const leased = await store.lease("engine-1", 60_000);
    await store.markPublished(leased!.id, "engine-1", { state: "failed", reason: "boom" });
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
  });

  test("new SHA cancels queued predecessor for the same PR, not a leased one", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ headSha: "old" }));
    expect(await store.enqueue(makeJob({ headSha: "new" }))).toEqual({
      key: "kirmanak/demo#7:new",
      queued: true,
    });
    expect(store.rows.find((row) => row.headSha === "old")?.state).toBe("cancelled");
    expect(store.rows.find((row) => row.headSha === "new")?.state).toBe("queued");

    const store2 = new MemoryReviewJobStore();
    await store2.enqueue(makeJob({ headSha: "leased-old" }));
    const leased = await store2.lease("engine-1", 60_000);
    expect(leased?.headSha).toBe("leased-old");
    await store2.enqueue(makeJob({ headSha: "newer" }));
    expect(store2.rows.find((row) => row.headSha === "leased-old")?.state).toBe("leased");
    expect(store2.rows.find((row) => row.headSha === "newer")?.state).toBe("queued");
  });

  test("retry of an in-flight SHA does not cancel a newer queued SHA", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ headSha: "sha1" }));
    const leased = await store.lease("engine-1", 60_000);
    expect(leased?.headSha).toBe("sha1");
    await store.enqueue(makeJob({ headSha: "sha2" }));
    expect(await store.enqueue(makeJob({ headSha: "sha1" }))).toEqual({
      key: "kirmanak/demo#7:sha1",
      queued: false,
    });
    expect(store.rows.find((row) => row.headSha === "sha1")?.state).toBe("leased");
    expect(store.rows.find((row) => row.headSha === "sha2")?.state).toBe("queued");
  });

  test("stale SHA retry does not insert or cancel a newer queued SHA", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ headSha: "sha2", prUpdatedAt: "2026-05-23T00:00:02Z", delivery: "d2" }));
    expect(
      await store.enqueue(makeJob({ headSha: "sha1", prUpdatedAt: "2026-05-23T00:00:01Z", delivery: "d1" }))
    ).toEqual({
      key: "kirmanak/demo#7:sha1",
      queued: false,
    });
    expect(store.rows.find((row) => row.headSha === "sha2")?.state).toBe("queued");
    expect(store.rows.find((row) => row.headSha === "sha1")).toBeUndefined();
  });

  test("SKIP LOCKED does not double-lease", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const [a, b] = await Promise.all([store.lease("e1", 60_000), store.lease("e2", 60_000)]);
    const leased = [a, b].filter(Boolean);
    expect(leased).toHaveLength(1);
    expect(leased[0]?.leasedBy === "e1" || leased[0]?.leasedBy === "e2").toBe(true);
  });

  test("two workers cannot double-lease the same implement row", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const [a, b] = await Promise.all([
      store.lease("worker-a", 60_000, undefined, WORKER_JOB_KINDS),
      store.lease("worker-b", 60_000, undefined, WORKER_JOB_KINDS),
    ]);
    const leased = [a, b].filter(Boolean);
    expect(leased).toHaveLength(1);
    expect(leased[0]?.kind).toBe("implement");
    expect(leased[0]?.leasedBy === "worker-a" || leased[0]?.leasedBy === "worker-b").toBe(true);
  });

  test("leased follow-up blocks conflict for the same issue and still leases another issue", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "olda" }));
    await store.enqueueIssue(makeIssueJob({ mode: "conflict", prNumber: 7, headSha: "olda" }));
    await store.enqueueIssue(
      makeIssueJob({
        issueNumber: 13,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/13",
        mode: "conflict",
        prNumber: 8,
        headSha: "other",
      })
    );
    const first = await store.lease("worker-a", 60_000, undefined, WORKER_JOB_KINDS);
    expect(first?.kind).toBe("follow-up");
    expect(first?.issueNumber).toBe(12);
    const second = await store.lease("worker-b", 60_000, undefined, WORKER_JOB_KINDS);
    expect(second?.kind).toBe("conflict");
    expect(second?.issueNumber).toBe(13);
    expect(await store.lease("worker-c", 60_000, undefined, WORKER_JOB_KINDS)).toBeUndefined();
    await store.markPublished(first!.id, "worker-a", { state: "succeeded" });
    const third = await store.lease("worker-c", 60_000, undefined, WORKER_JOB_KINDS);
    expect(third?.kind).toBe("conflict");
    expect(third?.issueNumber).toBe(12);
  });

  test("lease expiry reclaim requeues with attempt++", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 1, new Date(1_000));
    expect(leased?.attempt).toBe(0);
    const result = await store.reclaimExpired(2, new Date(5_000));
    expect(result.requeued).toHaveLength(1);
    expect(result.requeued[0]?.attempt).toBe(1);
    expect(result.requeued[0]?.state).toBe("queued");
    expect(result.publish).toHaveLength(0);
  });

  test("infra requeue does not increment attempt and cools via leasedUntil", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    expect(await store.requeueInfra(leased!.id, "engine-1", 2_000, encodeInfraMarker(1, 1_000), new Date(1_500))).toBe(
      true
    );
    expect(store.rows[0]?.attempt).toBe(0);
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.leasedUntil).toBe(3_500);
    expect(store.rows[0]?.error?.startsWith(INFRA_RETRY_PREFIX)).toBe(true);
    expect(await store.lease("engine-1", 60_000, new Date(3_000))).toBeUndefined();
    const again = await store.lease("engine-1", 60_000, new Date(3_500));
    expect(again?.id).toBe(leased?.id);
    expect(again?.attempt).toBe(0);
  });

  test("same-key enqueue clears a queued ci-lookup backoff but keeps the marker", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    const now = Date.now();
    const marker = encodeCiLookupMarker(3, now);
    expect(await store.requeueInfra(leased!.id, "engine-1", 60_000, marker, new Date(now))).toBe(true);
    expect(await store.enqueue(makeJob())).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.leasedUntil).toBeNull();
    expect(store.rows[0]?.error).toBe(marker);
    expect(await store.lease("engine-1", 60_000, new Date(now))).toBeDefined();
  });

  test("model reclaim still increments attempt after an infra marker", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 1, new Date(1_000));
    await store.requeueInfra(leased!.id, "engine-1", 1, encodeInfraMarker(2, 1_000), new Date(1_000));
    await store.lease("engine-1", 1, new Date(2_000));
    const result = await store.reclaimExpired(2, new Date(5_000));
    expect(result.requeued[0]?.attempt).toBe(1);
    expect(result.requeued[0]?.error).toBeNull();
  });

  test("reclaim after max attempts publishes failure without requeue", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    await store.lease("engine-1", 1, new Date(1_000));
    await store.reclaimExpired(2, new Date(5_000));
    await store.lease("engine-1", 1, new Date(6_000));
    const result = await store.reclaimExpired(2, new Date(10_000));
    expect(result.requeued).toHaveLength(0);
    expect(result.publish).toHaveLength(1);
    expect(result.publish[0]?.attempt).toBe(2);
    expect(result.publish[0]?.error).toContain("max attempts");
    expect(result.publish[0]?.state).toBe("leased");
  });

  test("persist-ready reclaim extends leasedUntil so a second reclaim does not republish", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const first = await store.reclaimExpired(2, new Date(5_000));
    expect(first.publish).toHaveLength(1);
    expect(first.publish[0]?.state).toBe("leased");
    expect(first.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(first.publish[0]?.leasedUntil).toBe(5_000 + HEARTBEAT_MS);
    expect(store.rows[0]?.leasedUntil).toBe(5_000 + HEARTBEAT_MS);
    const second = await store.reclaimExpired(2, new Date(5_000));
    expect(second.publish).toHaveLength(0);
    expect(second.requeued).toHaveLength(0);
    expect(store.rows[0]?.state).toBe("leased");
    expect(store.rows[0]?.publishedAt).toBeNull();
  });

  test("persisted markdown keeps the runner stamp for a reclaimed publish", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
      runner: "_Jumi · opencode · xai/grok-4.6 (high)_",
    });
    const reclaimed = await store.reclaimExpired(2, new Date(5_000));
    expect(reclaimed.publish[0]?.resultRunner).toBe("_Jumi · opencode · xai/grok-4.6 (high)_");
  });

  test("expireLease nulls leasedBy so a late heartbeat cannot restore leasedUntil", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    expect(leased?.leasedBy).toBe("engine-1");
    expect(await store.expireLease(leased!.id, "engine-1", new Date(2_000))).toBe(true);
    const expired = await store.get(leased!.id);
    expect(expired?.state).toBe("leased");
    expect(expired?.leasedBy).toBeNull();
    expect(expired?.leasedUntil).toBe(1_999);
    expect(await store.heartbeat(leased!.id, "engine-1", 60_000, new Date(3_000))).toBe(false);
    const after = await store.get(leased!.id);
    expect(after?.leasedBy).toBeNull();
    expect(after?.leasedUntil).toBe(1_999);
  });

  test("reclaim claim blocks original engine saveResult, expireLease, and markPublished", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const reclaimed = await store.reclaimExpired(2, new Date(5_000));
    expect(reclaimed.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);

    await expect(store.saveResult(leased!.id, "dead-engine", { kind: "skip", reason: "late" })).rejects.toThrow(
      "cannot save result"
    );
    expect(store.rows[0]?.resultMarkdown).toContain("Persisted review");
    expect(store.rows[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);

    expect(await store.expireLease(leased!.id, "dead-engine")).toBe(false);
    expect(store.rows[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(store.rows[0]?.leasedUntil).toBe(5_000 + HEARTBEAT_MS);

    await expect(store.markPublished(leased!.id, "dead-engine", { state: "succeeded" })).rejects.toThrow(
      "cannot mark published"
    );
    expect(store.rows[0]?.state).toBe("leased");
    expect(store.rows[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
  });

  test("releaseLease requeues without attempt++ and rejects persist-ready or foreign leases", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    expect(leased?.attempt).toBe(0);
    expect(await store.releaseLease(leased!.id, "engine-other")).toBe(false);
    expect(store.rows[0]?.state).toBe("leased");
    expect(await store.releaseLease(leased!.id, "engine-1")).toBe(true);
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.leasedUntil).toBeNull();
    expect(store.rows[0]?.attempt).toBe(0);
    expect(await store.heartbeat(leased!.id, "engine-1", 60_000, new Date(3_000))).toBe(false);

    const persistStore = new MemoryReviewJobStore();
    await persistStore.enqueue(makeJob());
    const persist = await persistStore.lease("engine-1", 60_000);
    await persistStore.saveResult(persist!.id, "engine-1", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    expect(await persistStore.releaseLease(persist!.id, "engine-1")).toBe(false);
    expect(persistStore.rows[0]?.state).toBe("leased");
  });

  test("matching owner can expireLease; reclaim owner expire still lets the next tick retry", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    expect(await store.expireLease(leased!.id, "engine-1", new Date(2_000))).toBe(true);
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.leasedUntil).toBe(1_999);

    const store2 = new MemoryReviewJobStore();
    await store2.enqueue(makeJob());
    const persist = await store2.lease("dead-engine", 1, new Date(1_000));
    await store2.saveResult(persist!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const claimed = await store2.reclaimExpired(2, new Date(5_000));
    expect(claimed.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(await store2.expireLease(persist!.id, RECLAIM_LEASED_BY, new Date(6_000))).toBe(true);
    expect(store2.rows[0]?.leasedBy).toBeNull();
    expect(store2.rows[0]?.leasedUntil).toBe(5_999);
    const retry = await store2.reclaimExpired(2, new Date(7_000));
    expect(retry.publish).toHaveLength(1);
    expect(retry.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
  });

  test("skip latch is shared and kill-switch clear bumps generation", async () => {
    const store = new MemoryReviewJobStore();
    expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({ generation: 0, skipReason: null });
    await store.setIssueSkipReason("kirmanak", "demo", 12, "stuck: cannot resolve conflicts");
    expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({
      generation: 0,
      skipReason: "stuck: cannot resolve conflicts",
    });
    await store.skipLatches.put(
      { owner: "kirmanak", repo: "demo", issueNumber: 12 },
      { followup: { round: 3 }, stuck: { fingerprints: [{ kind: "action", hash: "aaa" }] } }
    );
    expect(await store.clearIssueSkipLatch("kirmanak", "demo", 12)).toEqual({ generation: 1, skipReason: null });
    expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({ generation: 1, skipReason: null });
    expect(await store.skipLatches.get({ owner: "kirmanak", repo: "demo", issueNumber: 12 })).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
    });
    await store.setIssueSkipReason("kirmanak", "demo", 12, "stuck: repeated error");
    expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({
      generation: 1,
      skipReason: "stuck: repeated error",
    });
    expect(await store.clearIssueSkipLatch("kirmanak", "demo", 12)).toEqual({ generation: 2, skipReason: null });
  });

  test("countSucceeded scopes follow-ups to the current skip-latch generation", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha0", delivery: "d0" }));
    const first = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    expect(first?.payload?.generation).toBe(0);
    await store.markPublished(first!.id, first!.leasedBy!, { state: "succeeded" });
    expect(await store.countSucceeded("follow-up", "kirmanak", "demo", 12)).toBe(1);
    await store.clearIssueSkipLatch("kirmanak", "demo", 12);
    expect(await store.countSucceeded("follow-up", "kirmanak", "demo", 12)).toBe(0);
    expect(store.rows.filter((row) => row.kind === "follow-up" && row.state === "succeeded")).toHaveLength(1);
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha1", delivery: "d1" }));
    const second = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    expect(second?.payload?.generation).toBe(1);
    await store.markPublished(second!.id, second!.leasedBy!, { state: "succeeded" });
    expect(await store.countSucceeded("follow-up", "kirmanak", "demo", 12)).toBe(1);
  });
});

type FakeSql = {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  begin<T>(fn: (tx: FakeSql) => Promise<T>): Promise<T>;
};

function recordingSql(opts: { insertRows?: unknown[]; inflightRows?: unknown[]; doneRows?: unknown[] } = {}): {
  sql: FakeSql;
  queries: string[];
} {
  const queries: string[] = [];
  const sql: FakeSql = {
    async unsafe(query: string) {
      queries.push(query);
      if (query.includes("INSERT")) return opts.insertRows ?? [];
      if (query.includes("FOR UPDATE") && !query.includes("SKIP LOCKED")) return opts.inflightRows ?? [];
      if (query.includes("succeeded")) return opts.doneRows ?? [];
      return [];
    },
    async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
      return fn(sql);
    },
  };
  return { sql, queries };
}

describe("PgReviewJobStore.enqueue", () => {
  test("retry of an in-flight job_key does not cancel queued successors", async () => {
    const { sql, queries } = recordingSql();
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob({ headSha: "sha1" }))).toEqual({
      key: "kirmanak/demo#7:sha1",
      queued: false,
    });
    expect(queries.some((query) => query.includes("cancelled"))).toBe(false);
  });

  test("cancels queued predecessors only after a successful insert", async () => {
    const { sql, queries } = recordingSql({ insertRows: [{ id: 1 }] });
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob({ headSha: "new" }))).toEqual({
      key: "kirmanak/demo#7:new",
      queued: true,
    });
    const insertAt = queries.findIndex((query) => query.includes("INSERT"));
    const cancelAt = queries.findIndex((query) => query.includes("cancelled"));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBeGreaterThan(insertAt);
  });

  test("does not insert or cancel when a queued SHA has a newer pr_updated_at", async () => {
    const { sql, queries } = recordingSql({
      inflightRows: [{ job_key: "kirmanak/demo#7:sha2", pr_updated_at: "2026-05-23T00:00:02Z" }],
    });
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob({ headSha: "sha1", prUpdatedAt: "2026-05-23T00:00:01Z" }))).toEqual({
      key: "kirmanak/demo#7:sha1",
      queued: false,
    });
    expect(queries.some((query) => query.includes("INSERT"))).toBe(false);
    expect(queries.some((query) => query.includes("cancelled"))).toBe(false);
  });

  test("inserts after a non-terminal closed skip", async () => {
    const { sql, queries } = recordingSql({
      doneRows: [{ state: "skipped", result_reason: "PR is closed" }],
      insertRows: [{ id: 1 }],
    });
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob())).toEqual({
      key: "kirmanak/demo#7:headsha",
      queued: true,
    });
    expect(queries.some((query) => query.includes("INSERT"))).toBe(true);
  });

  test("same-key leased inflight sets rewake_requested instead of inserting", async () => {
    const { sql, queries } = recordingSql({
      inflightRows: [{ job_key: "kirmanak/demo#7:headsha", pr_updated_at: null }],
    });
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob())).toEqual({
      key: "kirmanak/demo#7:headsha",
      queued: false,
    });
    const wake = queries.find((query) => query.includes("rewake_requested"));
    expect(wake).toContain("state = 'leased' THEN TRUE");
    expect(wake).toContain("ci-lookup-retry:%");
    expect(wake).toContain("leased_until");
    expect(wake).not.toContain("error = CASE");
    expect(queries.some((query) => query.includes("INSERT INTO review_jobs"))).toBe(false);
  });

  test("locks inflight rows FOR UPDATE in id order", async () => {
    const { sql, queries } = recordingSql();
    const store = new PgReviewJobStore(sql);
    await store.enqueue(makeJob());
    const inflight = queries.find((query) => query.includes("FOR UPDATE") && !query.includes("SKIP LOCKED"));
    expect(inflight).toContain("ORDER BY id");
  });

  test("does not insert after an incomplete-review skip", async () => {
    const { sql, queries } = recordingSql({
      doneRows: [{ state: "skipped", result_reason: "Incomplete review: no output" }],
    });
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob())).toEqual({
      key: "kirmanak/demo#7:headsha",
      queued: false,
    });
    expect(queries.some((query) => query.includes("INSERT INTO review_jobs"))).toBe(false);
  });
});

describe("PgReviewJobStore expireLease", () => {
  test("nulls leased_by so a late heartbeat cannot restore leasedUntil", async () => {
    let leasedBy: string | null = "engine-1";
    let leasedUntil = new Date(Date.now() + 60_000).toISOString();
    const queries: string[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push(query);
        if (query.includes("leased_by = NULL")) {
          if (!query.includes("leased_by = $2") || !query.includes("state = 'leased'")) return [];
          if (leasedBy !== params?.[1]) return [];
          leasedUntil = String(params?.[2]);
          leasedBy = null;
          return [{ id: 1 }];
        }
        if (query.includes("leased_by = $2") && query.includes("state = 'leased'")) {
          if (leasedBy !== params?.[1]) return [];
          leasedUntil = String(params?.[2]);
          return [{ id: 1 }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.expireLease(1, "engine-1", new Date(2_000))).toBe(true);
    expect(queries.some((query) => query.includes("leased_by = $2") && query.includes("leased_by = NULL"))).toBe(true);
    expect(leasedBy).toBeNull();
    expect(leasedUntil).toBe(new Date(1_999).toISOString());
    expect(await store.heartbeat(1, "engine-1", 60_000, new Date(3_000))).toBe(false);
    expect(leasedUntil).toBe(new Date(1_999).toISOString());
  });
});

describe("PgReviewJobStore releaseLease", () => {
  test("requeues without a persisted result and no-ops persist-ready rows", async () => {
    let state = "leased";
    let leasedBy: string | null = "engine-1";
    let leasedUntil: string | null = new Date(Date.now() + 60_000).toISOString();
    let resultMarkdown: string | null = null;
    const queries: string[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push(query);
        if (query.includes("state = 'queued'") && query.includes("leased_by = NULL")) {
          if (leasedBy !== params?.[1] || resultMarkdown) return [];
          state = "queued";
          leasedBy = null;
          leasedUntil = null;
          return [{ id: 1 }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.releaseLease(1, "engine-1")).toBe(true);
    expect(
      queries.some((query) => query.includes("state = 'queued'") && query.includes("result_markdown IS NULL"))
    ).toBe(true);
    expect(state).toBe("queued");
    expect(leasedBy).toBeNull();
    expect(leasedUntil).toBeNull();

    state = "leased";
    leasedBy = "engine-1";
    resultMarkdown = "Persisted review";
    expect(await store.releaseLease(1, "engine-1")).toBe(false);
    expect(state).toBe("leased");
  });
});

describe("PgReviewJobStore saveResult and markPublished", () => {
  test("throws when no row is affected and requires leased_by", async () => {
    const queries: string[] = [];
    const sql: FakeSql = {
      async unsafe(query: string) {
        queries.push(query);
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    await expect(store.saveResult(1, "engine-1", { kind: "skip", reason: "late" })).rejects.toThrow(
      "cannot save result"
    );
    expect(queries.some((query) => query.includes("leased_by = $2") && query.includes("state = 'leased'"))).toBe(true);
    await expect(store.markPublished(1, "engine-1", { state: "succeeded" })).rejects.toThrow("cannot mark published");
    expect(queries.some((query) => query.includes("leased_by = $2") && query.includes("state = 'leased'"))).toBe(true);
    expect(queries.some((query) => query.includes("rewake_requested"))).toBe(true);
  });
});

describe("PgReviewJobStore.reclaimExpired", () => {
  test("persist-ready reclaim updates leased_until so a second select does not republish", async () => {
    const persistRow = {
      id: 1,
      job_key: "kirmanak/demo#7:headsha",
      owner: "kirmanak",
      repo: "demo",
      pr_number: 7,
      head_sha: "headsha",
      delivery: "delivery-1",
      state: "leased",
      attempt: 0,
      leased_by: "dead-engine",
      leased_until: new Date(1_000).toISOString(),
      result_markdown: "Persisted review",
      result_reason: null,
      error: null,
      pending_status_at: null,
      published_at: null,
      pr_updated_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(1_000).toISOString(),
    };
    let leasedUntil = persistRow.leased_until;
    let leasedBy: string | null = persistRow.leased_by;
    const queries: string[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push(query);
        if (query.includes("FOR UPDATE SKIP LOCKED")) {
          if (Date.parse(String(leasedUntil)) < Date.parse(String(params?.[0]))) {
            return [{ ...persistRow, leased_by: leasedBy, leased_until: leasedUntil }];
          }
          return [];
        }
        if (query.includes("UPDATE") && query.includes("leased_until")) {
          leasedBy = String(params?.[1]);
          leasedUntil = String(params?.[2]);
          return [{ ...persistRow, leased_by: leasedBy, leased_until: leasedUntil }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    const first = await store.reclaimExpired(2, new Date(5_000), 30_000);
    expect(first.publish).toHaveLength(1);
    expect(first.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(first.publish[0]?.leasedUntil).toBe(35_000);
    expect(queries.some((query) => query.includes("UPDATE") && query.includes("leased_until"))).toBe(true);
    const second = await store.reclaimExpired(2, new Date(5_000), 30_000);
    expect(second.publish).toHaveLength(0);
    expect(second.requeued).toHaveLength(0);
  });
});

describe("PgReviewJobStore.migrate", () => {
  test("requeues extra leased worker rows before creating the unique issue index", () => {
    const requeueAt = REVIEW_JOBS_SCHEMA_SQL.indexOf("ROW_NUMBER()");
    const indexAt = REVIEW_JOBS_SCHEMA_SQL.indexOf("review_jobs_leased_worker_issue");
    expect(requeueAt).toBeGreaterThanOrEqual(0);
    expect(indexAt).toBeGreaterThan(requeueAt);
    expect(REVIEW_JOBS_SCHEMA_SQL).toContain("WHERE rn > 1");
    expect(REVIEW_JOBS_SCHEMA_SQL).toContain("state = 'queued'");
    expect(ISSUE_SKIP_LATCHES_SCHEMA_SQL).toContain("generation INTEGER NOT NULL DEFAULT 0");
    expect(ISSUE_SKIP_LATCHES_SCHEMA_SQL).toContain("skip_reason TEXT");
  });
});

describe("isUniqueViolation", () => {
  test("detects postgres 23505 including wrapped queue errors", () => {
    expect(isUniqueViolation(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(true);
    // The shape Bun actually throws; test/review_jobs_pg.test.ts pins it against a real server.
    expect(
      isUniqueViolation(
        Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "23505",
        })
      )
    ).toBe(true);
    expect(
      isUniqueViolation(new QueueUnavailableError(Object.assign(new Error("duplicate key"), { code: "23505" })))
    ).toBe(true);
    expect(isUniqueViolation(new QueueUnavailableError(new Error("connection refused")))).toBe(false);
  });
});

describe("PgReviewJobStore.lease unique violation", () => {
  test("retries once then skips", async () => {
    let calls = 0;
    const sql: FakeSql = {
      async unsafe() {
        calls++;
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.lease("worker-1", 60_000, new Date(0), WORKER_JOB_KINDS)).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("retries unique violation then leases", async () => {
    let calls = 0;
    const sql: FakeSql = {
      async unsafe() {
        calls++;
        if (calls === 1) throw Object.assign(new Error("duplicate key"), { code: "23505" });
        return [
          {
            id: 9,
            job_key: "follow-up:kirmanak/demo#127:headsha",
            kind: "follow-up",
            owner: "kirmanak",
            repo: "demo",
            pr_number: 127,
            head_sha: "headsha",
            issue_number: 12,
            payload: null,
            delivery: "d1",
            state: "leased",
            attempt: 0,
            leased_by: "worker-1",
            leased_until: new Date(60_000).toISOString(),
            result_markdown: null,
            result_reason: null,
            error: null,
            pending_status_at: null,
            published_at: null,
            pr_updated_at: null,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
          },
        ];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    const row = await store.lease("worker-1", 60_000, new Date(0), WORKER_JOB_KINDS);
    expect(row?.id).toBe(9);
    expect(calls).toBe(2);
  });
});

describe("PgReviewJobStore infra requeue", () => {
  test("does not increment attempt and sets leased_until for backoff", async () => {
    const queries: { query: string; params?: unknown[] }[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push({ query, params });
        if (query.includes("state = 'queued'") && query.includes("error = $4")) {
          expect(params?.[3]).toBe(encodeInfraMarker(1, 1_500));
          return [{ id: 1 }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.requeueInfra(1, "engine-1", 2_000, encodeInfraMarker(1, 1_500), new Date(1_500))).toBe(true);
    const update = queries.find((row) => row.query.includes("error = $4"));
    expect(update?.query).not.toContain("attempt = attempt + 1");
    expect(update?.query).toContain("state = 'queued'");
    expect(update?.params?.[2]).toBe(new Date(3_500).toISOString());
  });

  test("quota-wait marker reuses the same not-before requeue", async () => {
    const queries: { query: string; params?: unknown[] }[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push({ query, params });
        if (query.includes("state = 'queued'") && query.includes("error = $4")) {
          expect(params?.[3]).toBe(encodeQuotaWaitMarker(1, 1_500));
          return [{ id: 1 }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.requeueInfra(1, "worker-1", 3_600_000, encodeQuotaWaitMarker(1, 1_500), new Date(1_500))).toBe(
      true
    );
    const update = queries.find((row) => row.query.includes("error = $4"));
    expect(update?.query).toContain("quota-wait:%");
    expect(update?.query).not.toContain("attempt = attempt + 1");
  });

  test("ci-lookup marker reuses the same not-before requeue", async () => {
    const queries: { query: string; params?: unknown[] }[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push({ query, params });
        if (query.includes("state = 'queued'") && query.includes("error = $4")) {
          expect(params?.[3]).toBe(encodeCiLookupMarker(1, 1_500));
          return [{ id: 1 }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.requeueInfra(1, "engine-1", 15_000, encodeCiLookupMarker(1, 1_500), new Date(1_500))).toBe(true);
    const update = queries.find((row) => row.query.includes("error = $4"));
    expect(update?.query).toContain("ci-lookup-retry:%");
    expect(update?.query).not.toContain("attempt = attempt + 1");
  });

  test("lease skips cooling jobs until leased_until", async () => {
    let leasedUntil = new Date(3_500).toISOString();
    const row = {
      id: 1,
      job_key: "kirmanak/demo#7:headsha",
      kind: "review",
      owner: "kirmanak",
      repo: "demo",
      pr_number: 7,
      head_sha: "headsha",
      issue_number: null,
      payload: null,
      delivery: "d1",
      state: "queued",
      attempt: 0,
      leased_by: null,
      leased_until: leasedUntil,
      result_markdown: null,
      result_reason: null,
      error: encodeInfraMarker(1, 1_000),
      pending_status_at: null,
      published_at: null,
      pr_updated_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(1_000).toISOString(),
    };
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        if (query.includes("state = 'queued'") && query.includes("RETURNING *")) {
          const now = Date.parse(String(params?.[2]));
          if (Date.parse(leasedUntil) > now) return [];
          leasedUntil = String(params?.[1]);
          return [{ ...row, state: "leased", leased_by: params?.[0], leased_until: leasedUntil }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.lease("engine-1", 60_000, new Date(3_000))).toBeUndefined();
    const leased = await store.lease("engine-1", 60_000, new Date(3_500));
    expect(leased?.attempt).toBe(0);
    expect(leased?.id).toBe(1);
  });
});

describe("PgReviewJobStore kind ANY() bind", () => {
  test("lease/reclaim/cancel bind text[] literals instead of JS arrays", async () => {
    const captured: { query: string; params?: unknown[] }[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        captured.push({ query, params });
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);

    await store.lease("engine-1", 60_000, new Date(0));
    const leaseReview = captured.find((row) => row.query.includes("state = 'queued' AND kind = ANY($4::text[])"));
    expect(leaseReview?.params?.[3]).toBe("{review}");
    expect(Array.isArray(leaseReview?.params?.[3])).toBe(false);
    expect(leaseReview?.query).toContain("leased_until IS NULL OR leased_until <= $3::timestamptz");

    captured.length = 0;
    await store.lease("worker-1", 60_000, new Date(0), WORKER_JOB_KINDS);
    const leaseWorker = captured.find((row) => row.query.includes("kind = ANY($4::text[])"));
    expect(leaseWorker?.params?.[3]).toBe("{implement,follow-up,conflict}");
    expect(leaseWorker?.params?.[4]).toBe("{implement,follow-up,conflict}");
    expect(leaseWorker?.query).toContain("held.issue_number IS NOT DISTINCT FROM review_jobs.issue_number");

    captured.length = 0;
    await store.reclaimExpired(2, new Date(5_000), 30_000, WORKER_JOB_KINDS);
    const reclaim = captured.find((row) => row.query.includes("kind = ANY($2::text[])"));
    expect(reclaim?.params?.[1]).toBe("{implement,follow-up,conflict}");

    captured.length = 0;
    await store.cancelQueuedForIssue("personal", "jumi", 149);
    const cancel = captured.find((row) => row.query.includes("kind = ANY($4::text[])"));
    expect(cancel?.params?.[3]).toBe("{implement,follow-up,conflict}");

    captured.length = 0;
    await store.clearIssueSkipLatch("kirmanak", "demo", 12);
    const clearLatch = captured.find((row) => row.query.includes("issue_skip_latches") && row.query.includes("INSERT"));
    expect(clearLatch?.query).toContain("generation = issue_skip_latches.generation + 1");
    expect(clearLatch?.query).toContain("skip_reason = NULL");
    expect(clearLatch?.query).toContain("followup = '{}'::jsonb");
    expect(clearLatch?.query).toContain("conflict = '{}'::jsonb");
    expect(clearLatch?.query).toContain("ci = '{}'::jsonb");
    expect(clearLatch?.query).toContain("stuck = '{}'::jsonb");
    expect(clearLatch?.params).toEqual(["kirmanak", "demo", 12]);
    expect(captured.some((row) => row.query.includes("DELETE FROM issue_skip_latches"))).toBe(false);

    captured.length = 0;
    await store.countSucceeded("follow-up", "kirmanak", "demo", 12);
    const count = captured.find((row) => row.query.includes("COUNT(*)"));
    expect(count?.query).toContain("payload->>'generation'");
    expect(count?.query).toContain("issue_skip_latches");
    expect(count?.params).toEqual(["follow-up", "kirmanak", "demo", 12]);
  });
});

describe("PgReviewJobStore.enqueueIssue generation", () => {
  test("stamps the current skip-latch generation on the payload", async () => {
    const captured: { query: string; params?: unknown[] }[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        captured.push({ query, params });
        if (query.includes("SELECT generation FROM issue_skip_latches")) return [{ generation: 2 }];
        if (query.includes("INSERT")) return [{ id: 1 }];
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "headsha" }))).toEqual({
      key: "follow-up:kirmanak/demo#7:headsha",
      queued: true,
    });
    const insert = captured.find((row) => row.query.includes("INSERT INTO review_jobs"));
    expect(JSON.parse(String(insert?.params?.[7]))).toMatchObject({ generation: 2, issueNumber: 12 });
  });
});
