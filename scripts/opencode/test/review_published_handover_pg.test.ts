import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { CI_PENDING_REASON } from "../src/ci.ts";
import { recordPendingHandover } from "../src/review_handover_pending.ts";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeJob } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

function asRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

async function pendingCount(sql: SqlClient, id?: number): Promise<number> {
  const rows = asRows(
    id === undefined
      ? await sql.unsafe(`SELECT review_job_id FROM review_handover_pending`)
      : await sql.unsafe(`SELECT review_job_id FROM review_handover_pending WHERE review_job_id = $1`, [id])
  );
  return rows.length;
}

async function leaseReview(store: PgReviewJobStore) {
  await store.enqueue(makeJob());
  const leased = await store.lease("engine-1", 60_000);
  if (!leased) throw new Error("lease failed");
  return leased;
}

/** Wrap a client so the handover-table insert always fails while everything else passes through. */
function failingHandoverSql(sql: SqlClient): SqlClient {
  const throwing = () => {
    throw new Error("handover insert boom");
  };
  const wrapTx = (realTx: SqlClient): SqlClient => ({
    async unsafe(query: string, params?: unknown[]) {
      if (query.includes("review_handover_pending")) throwing();
      return realTx.unsafe(query, params);
    },
    async begin<U>(nested: (tx: SqlClient) => Promise<U>): Promise<U> {
      return realTx.begin((inner) => nested(wrapTx(inner)));
    },
  });
  return {
    async unsafe(query: string, params?: unknown[]) {
      if (query.includes("review_handover_pending")) throwing();
      return sql.unsafe(query, params);
    },
    async begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      return sql.begin((realTx) => fn(wrapTx(realTx)));
    },
  };
}

describePg("markPublishedWithHandover against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = openTestSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await store.migrate();
  });

  afterAll(async () => {
    await (sql as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`TRUNCATE review_jobs, follow_up_wake_causes RESTART IDENTITY`);
    await sql.unsafe(`DROP TABLE IF EXISTS review_handover_pending`);
    await store.migrate();
  });

  test("forced insert failure rolls back: row stays leased, nothing pending", async () => {
    const leased = await leaseReview(store);
    const failingStore = new PgReviewJobStore(failingHandoverSql(sql));
    await expect(
      failingStore.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "posted")
    ).rejects.toThrow("handover insert boom");
    const row = await store.get(leased.id);
    expect(row?.state).toBe("leased");
    expect(row?.leasedBy).toBe("engine-1");
    expect(await pendingCount(sql, leased.id)).toBe(0);
  });

  test("success settles terminal plus pending together; repeat throws without duplicating", async () => {
    const leased = await leaseReview(store);
    const res = await store.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "posted");
    expect(res).toEqual({ cancelled: false, promoted: 0, parked: 0 });
    expect((await store.get(leased.id))?.state).toBe("succeeded");
    expect(await pendingCount(sql, leased.id)).toBe(1);

    await expect(
      store.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "posted")
    ).rejects.toThrow("cannot mark published");
    expect(await pendingCount(sql, leased.id)).toBe(1);
  });

  test("non-pending statuses insert nothing", async () => {
    const leased = await leaseReview(store);
    await store.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "skipped");
    expect((await store.get(leased.id))?.state).toBe("succeeded");
    expect(await pendingCount(sql)).toBe(0);
  });

  test("cancel wins and removes an existing pending row", async () => {
    const leased = await leaseReview(store);
    await recordPendingHandover(store, leased.id, "posted");
    expect(await pendingCount(sql, leased.id)).toBe(1);
    expect(await store.cancelQueuedForPull("kirmanak", "demo", 7)).toBe(0);
    const res = await store.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "posted");
    expect(res).toEqual({ cancelled: true, promoted: 0, parked: 0 });
    expect((await store.get(leased.id))?.state).toBe("cancelled");
    expect(await pendingCount(sql, leased.id)).toBe(0);
  });

  test("CI-wait rewake requeues and inserts nothing", async () => {
    const job = makeJob();
    await store.enqueue(job);
    const leased = await store.lease("engine-1", 60_000);
    if (!leased) throw new Error("lease failed");
    await store.enqueue(job);
    const res = await store.markPublishedWithHandover(
      leased.id,
      "engine-1",
      { state: "skipped", reason: CI_PENDING_REASON },
      "skipped"
    );
    expect(res).toEqual({ cancelled: false, promoted: 0, parked: 0 });
    expect((await store.get(leased.id))?.state).toBe("queued");
    expect(await pendingCount(sql)).toBe(0);
  });

  test("stale owner throws and inserts nothing", async () => {
    const leased = await leaseReview(store);
    await expect(
      store.markPublishedWithHandover(leased.id, "engine-2", { state: "succeeded" }, "posted")
    ).rejects.toThrow("cannot mark published");
    expect((await store.get(leased.id))?.state).toBe("leased");
    expect(await pendingCount(sql)).toBe(0);
  });
});
