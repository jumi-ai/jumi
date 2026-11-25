import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import {
  LatchFenceRejected,
  LatchFenceUnsupported,
  MemorySkipLatchStore,
  memorySkipLatchesFor,
  PgSkipLatchStore,
  skipLatchesFor,
  skipLatchStoreFromPath,
} from "../src/skip_latches.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeIssueJob } from "./fixtures.ts";

const key = { owner: "kirmanak", repo: "demo", issueNumber: 12 };

async function leasedStore(token = "worker-1") {
  const store = new MemoryReviewJobStore();
  await store.enqueueIssue(makeIssueJob());
  const row = await store.lease(token, 60_000, new Date(), WORKER_JOB_KINDS);
  if (!row) throw new Error("expected a lease");
  return { store, row };
}

describe("memory skip latch fence", () => {
  test("healthy fenced write lands; unfenced write unchanged", async () => {
    const { store, row } = await leasedStore();
    await store.skipLatches.put(
      key,
      { followup: { round: 1 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 0 }
    );
    expect((await store.skipLatches.get(key)).followup).toEqual({ round: 1 });
    // Unfenced writes behave exactly as before.
    await store.skipLatches.put(key, { stuck: { fingerprints: [] } });
    expect((await store.skipLatches.get(key)).stuck).toEqual({ fingerprints: [] });
    expect((await store.skipLatches.get(key)).followup).toEqual({ round: 1 });
  });

  test("stale generation rejects after clear; cleared cells stay empty", async () => {
    const { store, row } = await leasedStore();
    await store.skipLatches.put(
      key,
      { followup: { round: 1 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 0 }
    );
    await store.clearIssueSkipLatch(key.owner, key.repo, key.issueNumber);
    expect(await store.readIssueSkipLatch(key.owner, key.repo, key.issueNumber)).toEqual({
      generation: 1,
      skipReason: null,
    });
    await expect(
      store.skipLatches.put(key, { followup: { round: 2 } }, { jobId: row.id, leasedBy: "worker-1", generation: 0 })
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    // Guards the memory generation predicate: fails if the generation check is removed.
    expect(await store.skipLatches.get(key)).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
      reviewStuck: {},
    });
    await store.skipLatches.put(
      key,
      { followup: { round: 2 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 1 }
    );
    expect((await store.skipLatches.get(key)).followup).toEqual({ round: 2 });
  });

  test("missing latch row writes with expected 0 and rejects with expected 1", async () => {
    const { store, row } = await leasedStore();
    await expect(
      store.skipLatches.put(key, { followup: { round: 1 } }, { jobId: row.id, leasedBy: "worker-1", generation: 1 })
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    expect(await store.skipLatches.get(key)).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
      reviewStuck: {},
    });
    await store.skipLatches.put(
      key,
      { followup: { round: 1 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 0 }
    );
    expect((await store.skipLatches.get(key)).followup).toEqual({ round: 1 });
  });

  test("wrong token, unleased row, and cross-issue latch reject", async () => {
    const { store, row } = await leasedStore();
    await expect(
      store.skipLatches.put(key, { followup: 1 }, { jobId: row.id, leasedBy: "worker-2", generation: 0 })
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    await expect(
      store.skipLatches.put(
        { owner: "kirmanak", repo: "demo", issueNumber: 13 },
        { followup: 1 },
        { jobId: row.id, leasedBy: "worker-1", generation: 0 }
      )
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    await expect(
      store.skipLatches.put(
        { owner: "other", repo: "demo", issueNumber: 12 },
        { followup: 1 },
        { jobId: row.id, leasedBy: "worker-1", generation: 0 }
      )
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    await expect(
      store.skipLatches.put(
        { owner: "kirmanak", repo: "other", issueNumber: 12 },
        { followup: 1 },
        { jobId: row.id, leasedBy: "worker-1", generation: 0 }
      )
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    // A queued (never leased) row cannot authorize a fence.
    const idle = new MemoryReviewJobStore();
    await idle.enqueueIssue(makeIssueJob({ delivery: "d-idle" }));
    const idleRow = idle.rows[0];
    if (!idleRow) throw new Error("expected an idle row");
    await expect(
      idle.skipLatches.put(key, { followup: 1 }, { jobId: idleRow.id, leasedBy: "worker-1", generation: 0 })
    ).rejects.toBeInstanceOf(LatchFenceRejected);
    expect(await store.skipLatches.get(key)).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
      reviewStuck: {},
    });
  });

  test("expired lease and cancel_requested do not reject", async () => {
    const { store, row } = await leasedStore();
    const held = store.rows.find((item) => item.id === row.id);
    if (!held) throw new Error("expected the leased row");
    held.leasedUntil = Date.now() - 1_000;
    await store.skipLatches.put(
      key,
      { followup: { round: 1 } },
      { jobId: row.id, leasedBy: "worker-1", generation: 0 }
    );
    expect((await store.skipLatches.get(key)).followup).toEqual({ round: 1 });
    held.cancelRequested = true;
    await store.skipLatches.put(key, { stuck: { n: 1 } }, { jobId: row.id, leasedBy: "worker-1", generation: 0 });
    expect((await store.skipLatches.get(key)).stuck).toEqual({ n: 1 });
  });

  test("malformed expected generation rejects without a write", async () => {
    const { store, row } = await leasedStore();
    for (const generation of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0" as unknown as number]) {
      await expect(
        store.skipLatches.put(
          key,
          { followup: { round: 9 } },
          { jobId: row.id, leasedBy: "worker-1", generation: generation as number }
        )
      ).rejects.toBeInstanceOf(LatchFenceRejected);
    }
    expect(await store.skipLatches.get(key)).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
      reviewStuck: {},
    });
  });

  test("standalone memory stores throw LatchFenceUnsupported for a valid fence", async () => {
    const fence = { jobId: 1, leasedBy: "worker-1", generation: 0 };
    const standalone = new MemorySkipLatchStore();
    await expect(standalone.put(key, { followup: 1 }, fence)).rejects.toBeInstanceOf(LatchFenceUnsupported);
    expect(await standalone.get(key)).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
      reviewStuck: {},
    });
    const home = await mkdtemp(join(tmpdir(), "jumi-fence-"));
    await expect(memorySkipLatchesFor(home).put(key, { followup: 1 }, fence)).rejects.toBeInstanceOf(
      LatchFenceUnsupported
    );
    await expect(skipLatchesFor({ home }).put(key, { followup: 1 }, fence)).rejects.toBeInstanceOf(
      LatchFenceUnsupported
    );
    const parsed = skipLatchStoreFromPath(`${home}/worker/jobs/kirmanak/demo/12.followup.json`);
    if (!parsed) throw new Error("expected a parsed latch path");
    await expect(parsed.store.put(parsed.key, { followup: 1 }, fence)).rejects.toBeInstanceOf(LatchFenceUnsupported);
    // Malformed fences reject (without a write) even on standalone stores.
    await expect(
      standalone.put(key, { followup: 1 }, { jobId: 1, leasedBy: "worker-1", generation: -1 })
    ).rejects.toBeInstanceOf(LatchFenceRejected);
  });

  test("unfenced pg SQL is byte-identical and issues no transaction", async () => {
    const queries: string[] = [];
    let begins = 0;
    const sql: SqlClient = {
      async unsafe(query: string) {
        queries.push(query);
        return [];
      },
      async begin<T>(fn: (tx: SqlClient) => Promise<T>) {
        begins++;
        return fn(sql);
      },
    };
    await new PgSkipLatchStore(sql).put(key, { followup: { round: 1 } });
    expect(begins).toBe(0);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toBe(
      `INSERT INTO issue_skip_latches (owner, repo, issue_number, followup, conflict, ci, stuck, review_stuck)
       VALUES (
         $1, $2, $3,
         COALESCE($4::jsonb, '{}'::jsonb),
         COALESCE($5::jsonb, '{}'::jsonb),
         COALESCE($6::jsonb, '{}'::jsonb),
         COALESCE($7::jsonb, '{}'::jsonb),
         COALESCE($8::jsonb, '{}'::jsonb)
       )
       ON CONFLICT (owner, repo, issue_number) DO UPDATE SET
         followup = COALESCE($4::jsonb, issue_skip_latches.followup),
         conflict = COALESCE($5::jsonb, issue_skip_latches.conflict),
         ci = COALESCE($6::jsonb, issue_skip_latches.ci),
         stuck = COALESCE($7::jsonb, issue_skip_latches.stuck),
         review_stuck = COALESCE($8::jsonb, issue_skip_latches.review_stuck),
         updated_at = NOW()`
    );
  });
});
