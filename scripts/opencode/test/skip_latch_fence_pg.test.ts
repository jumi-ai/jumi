import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PgReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { LatchFenceRejected, LatchFenceUnsupported, MemorySkipLatchStore } from "../src/skip_latches.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeIssueJob } from "./fixtures.ts";

// Skipped without JUMI_TEST_DATABASE_URL so `bun test` stays green.
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

const key = { owner: "kirmanak", repo: "demo", issueNumber: 12 };

describePg("skip latch fence against real postgres", () => {
  let sqlA!: SqlClient;
  let sqlB!: SqlClient;
  let storeA!: PgReviewJobStore;
  let storeB!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sqlA = openTestSqlClient(pgDatabaseUrl);
    sqlB = openTestSqlClient(pgDatabaseUrl);
    storeA = new PgReviewJobStore(sqlA);
    storeB = new PgReviewJobStore(sqlB);
    await sqlA.unsafe(
      `DROP TABLE IF EXISTS review_jobs, follow_up_wake_causes, issue_skip_latches, jumi_run_usage, role_gates`
    );
    await storeA.migrate();
  });

  afterAll(async () => {
    await (sqlA as SqlClient | undefined)?.close?.();
    await (sqlB as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sqlA.unsafe(
      `TRUNCATE review_jobs, follow_up_wake_causes, issue_skip_latches, jumi_run_usage RESTART IDENTITY`
    );
    await sqlA.unsafe(`TRUNCATE role_gates`);
    await storeA.migrate();
  });

  async function leaseIssue(token: string, delivery = `d-${token}-${Math.random()}`) {
    await storeA.enqueueIssue(makeIssueJob({ delivery }));
    const row = await storeA.lease(token, 60_000, new Date(), WORKER_JOB_KINDS);
    if (!row) throw new Error("expected a lease");
    return row;
  }

  test("healthy fenced write lands; unfenced write unchanged", async () => {
    const row = await leaseIssue("worker-1");
    await storeA.skipLatches.put(
      key,
      { followup: { round: 1 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 0 }
    );
    expect((await storeA.skipLatches.get(key)).followup).toEqual({ round: 1 });
    await storeA.skipLatches.put(key, { stuck: { fingerprints: [] } });
    const latch = await storeA.skipLatches.get(key);
    expect(latch.followup).toEqual({ round: 1 });
    expect(latch.stuck).toEqual({ fingerprints: [] });
  });

  test("clear between lease and write rejects the stale write; cleared cells stay empty", async () => {
    const row = await leaseIssue("worker-1");
    await storeA.skipLatches.put(
      key,
      { followup: { round: 1 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 0 }
    );
    await storeA.clearIssueSkipLatch(key.owner, key.repo, key.issueNumber);
    expect(await storeA.readIssueSkipLatch(key.owner, key.repo, key.issueNumber)).toEqual({
      generation: 1,
      skipReason: null,
    });
    await expect(
      storeA.skipLatches.put(key, { followup: { round: 2 } }, { jobId: row.id, leasedBy: "worker-1", generation: 0 })
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    // Guards the PG generation predicate: fails if the `generation = $9` update
    // predicate (or the `WHERE $9 = 0` insert gate) is removed.
    expect(await storeA.skipLatches.get(key)).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
      reviewStuck: {},
    });
    await storeA.skipLatches.put(
      key,
      { followup: { round: 2 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 1 }
    );
    expect((await storeA.skipLatches.get(key)).followup).toEqual({ round: 2 });
  });

  test("missing latch row writes with expected 0 and rejects with expected 1", async () => {
    const row = await leaseIssue("worker-1");
    await expect(
      storeA.skipLatches.put(key, { followup: { round: 1 } }, { jobId: row.id, leasedBy: "worker-1", generation: 1 })
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    await storeA.skipLatches.put(
      key,
      { followup: { round: 1 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 0 }
    );
    expect((await storeA.skipLatches.get(key)).followup).toEqual({ round: 1 });
  });

  test("reclaim on a separate pool revokes the old token; latch JSON stays byte-identical", async () => {
    const row = await leaseIssue("worker-1");
    await storeA.skipLatches.put(
      key,
      { followup: { round: 1 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 0 }
    );
    const before = JSON.stringify(await storeA.skipLatches.get(key));
    // Persist a result so reclaim takes the publish path and reclaims the row
    // to a new owner instead of requeueing it.
    await storeA.saveResult(row.id, "worker-1", { kind: "skip", reason: "ci-failed" });
    await sqlA.unsafe(`UPDATE review_jobs SET leased_until = NOW() - interval '1 minute' WHERE id = $1`, [row.id]);
    const reclaimed = await storeB.reclaimExpired(3, new Date(), 60_000, WORKER_JOB_KINDS);
    expect(reclaimed.publish).toHaveLength(1);
    const newOwner = reclaimed.publish[0]?.leasedBy;
    if (!newOwner) throw new Error("expected a reclaim owner");
    expect(newOwner).not.toBe("worker-1");
    await expect(
      storeA.skipLatches.put(key, { followup: { round: 2 } }, { jobId: row.id, leasedBy: "worker-1", generation: 0 })
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    expect(JSON.stringify(await storeA.skipLatches.get(key))).toBe(before);
    await storeA.skipLatches.put(key, { followup: { round: 2 } }, { jobId: row.id, leasedBy: newOwner, generation: 0 });
    expect((await storeA.skipLatches.get(key)).followup).toEqual({ round: 2 });
  });

  test("fenced write waits for an in-flight reclaim lock, then rejects after the owner change", async () => {
    const row = await leaseIssue("worker-1");
    let txLocked!: () => void;
    const txLockedGate = new Promise<void>((resolve) => {
      txLocked = resolve;
    });
    let releaseTx!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    const txDone = sqlB.begin(async (tx) => {
      await tx.unsafe(`SELECT * FROM review_jobs WHERE id = $1 FOR UPDATE`, [row.id]);
      txLocked();
      await releaseGate;
      await tx.unsafe(`UPDATE review_jobs SET leased_by = $2, updated_at = NOW() WHERE id = $1`, [
        row.id,
        "reclaim:simulated",
      ]);
    });
    await txLockedGate;
    let settled = false;
    const writePromise = storeA.skipLatches
      .put(key, { followup: { round: 1 } }, { jobId: row.id, leasedBy: "worker-1", generation: 0 })
      .then(
        () => {
          settled = true;
        },
        (err) => {
          settled = true;
          throw err;
        }
      );
    try {
      await Bun.sleep(400);
      // Guards the `FOR SHARE` ledger lock: fails if the lock is removed, since
      // the write would no longer block on the in-flight reclaim transaction.
      expect(settled).toBe(false);
    } finally {
      releaseTx();
      await txDone;
    }
    await expect(writePromise).rejects.toBeInstanceOf(LatchFenceRejected);
    expect(await storeA.skipLatches.get(key)).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
      reviewStuck: {},
    });
  });

  test("converse: a held ledger lock makes reclaim skip the row that pass", async () => {
    const row = await leaseIssue("worker-1");
    await storeA.saveResult(row.id, "worker-1", { kind: "skip", reason: "ci-failed" });
    await sqlA.unsafe(`UPDATE review_jobs SET leased_until = NOW() - interval '1 minute' WHERE id = $1`, [row.id]);
    let releaseTx!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    let txLocked!: () => void;
    const txLockedGate = new Promise<void>((resolve) => {
      txLocked = resolve;
    });
    // Hold the same `FOR SHARE` lock a fenced write takes.
    const txDone = sqlA.begin(async (tx) => {
      await tx.unsafe(`SELECT * FROM review_jobs WHERE id = $1 FOR SHARE`, [row.id]);
      txLocked();
      await releaseGate;
    });
    await txLockedGate;
    try {
      const skipped = await storeB.reclaimExpired(3, new Date(), 60_000, WORKER_JOB_KINDS);
      // Guards the lock conflict: fails if the fenced-write lock no longer
      // conflicts with reclaim's `FOR UPDATE SKIP LOCKED` scan.
      expect([...skipped.requeued, ...skipped.publish]).toHaveLength(0);
    } finally {
      releaseTx();
      await txDone;
    }
    const claimed = await storeB.reclaimExpired(3, new Date(), 60_000, WORKER_JOB_KINDS);
    expect([...claimed.requeued, ...claimed.publish]).toHaveLength(1);
  });

  test("fence for another owner/repo/issue rejects; malformed generation changes nothing", async () => {
    const row = await leaseIssue("worker-1");
    for (const other of [
      { owner: "other", repo: "demo", issueNumber: 12 },
      { owner: "kirmanak", repo: "other", issueNumber: 12 },
      { owner: "kirmanak", repo: "demo", issueNumber: 13 },
    ]) {
      await expect(
        storeA.skipLatches.put(other, { followup: 1 }, { jobId: row.id, leasedBy: "worker-1", generation: 0 })
      ).rejects.toBeInstanceOf(LatchFenceRejected);
      expect(await storeA.skipLatches.get(other)).toEqual({
        followup: {},
        conflict: {},
        ci: {},
        stuck: {},
        reviewStuck: {},
      });
    }
    for (const generation of [-1, 1.5, Number.NaN]) {
      await expect(
        storeA.skipLatches.put(
          key,
          { followup: { round: 9 } },
          { jobId: row.id, leasedBy: "worker-1", generation: generation as number }
        )
      ).rejects.toBeInstanceOf(LatchFenceRejected);
    }
    expect(await storeA.skipLatches.get(key)).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
      reviewStuck: {},
    });
  });

  test("standalone pg-adjacent memory store still throws Unsupported", async () => {
    const standalone = new MemorySkipLatchStore();
    await expect(
      standalone.put(key, { followup: 1 }, { jobId: 1, leasedBy: "worker-1", generation: 0 })
    ).rejects.toBeInstanceOf(LatchFenceUnsupported);
  });
});
