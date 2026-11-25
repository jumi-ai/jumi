import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

describePg("PgAutomergeReconcileStore against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = openTestSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await sql.unsafe(`DROP TABLE IF EXISTS automerge_reconcile_cause`);
    await sql.unsafe(`DROP TABLE IF EXISTS automerge_reconcile`);
    await sql.unsafe(`DROP SEQUENCE IF EXISTS automerge_reconcile_generation_seq`);
    await store.migrate();
  });

  afterAll(async () => {
    await (sql as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`TRUNCATE automerge_reconcile, automerge_reconcile_cause`);
    await store.migrate();
  });

  test("migrate is idempotent and the schema check lists both tables", async () => {
    await store.migrate();
    await store.migrate();
    await store.assertSchema();
    const listed = (await sql.unsafe(
      `SELECT tablename AS name FROM pg_tables WHERE tablename LIKE 'automerge_reconcile%'`
    )) as Array<{ name: unknown }>;
    expect(listed.map((row) => String(row.name)).sort()).toEqual(["automerge_reconcile", "automerge_reconcile_cause"]);
  });

  test("duplicate cause is idempotent after deletion; stale settle cannot delete the newer row", async () => {
    const sub = store.automergeReconcile;
    const a = await sub.request("o", "r", 7, "cause-A", 1_000);
    expect(a.status).toBe("created");
    const b = await sub.request("o", "r", 7, "cause-B", 2_000);
    expect(b.status).toBe("bumped");
    expect(b.generation).toBeGreaterThan(a.generation);

    const replayA = await sub.request("o", "r", 7, "cause-A", 3_000);
    expect(replayA.status).toBe("duplicate");
    expect(replayA.generation).toBe(a.generation);
    expect(await sub.settle("o", "r", 7, replayA.generation)).toBe("stale");
    expect(await sub.settle("o", "r", 7, b.generation)).toBe("deleted");

    // The tombstone survives deletion: replaying A still returns gen1 and revives nothing.
    const afterDelete = await sub.request("o", "r", 7, "cause-A", 4_000);
    expect(afterDelete.status).toBe("duplicate");
    expect(afterDelete.generation).toBe(a.generation);
    expect(await sub.claimDue("tok", 60_000, 10, 4_000)).toEqual([]);

    const c = await sub.request("o", "r", 7, "cause-C", 5_000);
    expect(c.status).toBe("created");
    expect(c.generation).toBeGreaterThan(b.generation);
  });

  test("concurrent claims have one live owner; expiry is reclaimable", async () => {
    const sub = store.automergeReconcile;
    const created = await sub.request("o", "r", 11, "cause-A", 1_000);
    expect(created.status).toBe("created");

    const [first, second] = await Promise.all([
      sub.claimDue("token-1", 60_000, 10, 1_000),
      sub.claimDue("token-2", 60_000, 10, 1_000),
    ]);
    expect(first.length + second.length).toBe(1);
    const winner = first.length === 1 ? { token: "token-1", rows: first } : { token: "token-2", rows: second };
    const loserToken = winner.token === "token-1" ? "token-2" : "token-1";
    expect(winner.rows[0]?.generation).toBe(created.generation);

    // The loser cannot complete or renew the row it never owned.
    expect(await sub.complete("o", "r", 11, loserToken, created.generation, 1_000)).toBe("lost");
    expect(await sub.renew("o", "r", 11, loserToken, created.generation, 60_000, 1_000)).toBe(false);

    // After expiry the row is reclaimable by a new token.
    const reclaimed = await sub.claimDue("token-3", 60_000, 10, 1_000 + 60_001);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0]?.generation).toBe(created.generation);

    // The original holder's lease is now stale: renew is false, complete is lost.
    expect(await sub.renew("o", "r", 11, winner.token, created.generation, 60_000, 1_000 + 60_001)).toBe(false);
    expect(await sub.complete("o", "r", 11, winner.token, created.generation, 1_000 + 60_001)).toBe("lost");
    // Settling with a stale token-adjacent wrong generation cannot delete either.
    expect(await sub.settle("o", "r", 11, created.generation + 999)).toBe("stale");
    expect(await sub.complete("o", "r", 11, "token-3", created.generation, 1_000 + 60_001)).toBe("deleted");
  });

  test("stale generation rearms; fail retries then exhausts and revives only on a new cause", async () => {
    const sub = store.automergeReconcile;
    const a = await sub.request("o", "r", 12, "cause-A", 1_000);
    expect((await sub.claimDue("holder-1", 60_000, 10, 1_000)).length).toBe(1);
    const b = await sub.request("o", "r", 12, "cause-B", 2_000);
    expect(b.status).toBe("bumped");
    expect(b.generation).toBeGreaterThan(a.generation);
    expect(await sub.fail("o", "r", 12, "holder-1", a.generation, "boom", 2_000)).toBe("rearmed");

    let now = 2_000;
    let last: string | undefined;
    for (let attempt = 1; attempt <= 8; attempt++) {
      const claimed = await sub.claimDue(`tok-${attempt}`, 60_000, 10, now);
      expect(claimed.length).toBe(1);
      last = await sub.fail("o", "r", 12, `tok-${attempt}`, claimed[0]?.generation ?? -1, `boom-${attempt}`, now);
      if (attempt < 8) expect(last).toBe("retry");
      now += 61_000;
    }
    expect(last).toBe("exhausted");
    expect((await sub.listExhausted(10)).length).toBe(1);

    expect((await sub.request("o", "r", 12, "cause-A", now)).status).toBe("duplicate");
    expect((await sub.listExhausted(10)).length).toBe(1);
    const revived = await sub.request("o", "r", 12, "cause-fresh", now);
    expect(revived.status).toBe("revived");
    expect((await sub.listExhausted(10)).length).toBe(0);
    const claimed = await sub.claimDue("tok-revived", 60_000, 10, now);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.retryMarker).toBeNull();
  });

  test("block exhausts immediately with the diagnostic", async () => {
    const sub = store.automergeReconcile;
    const a = await sub.request("o", "r", 13, "cause-A", 1_000);
    expect((await sub.claimDue("holder-1", 60_000, 10, 1_000)).length).toBe(1);
    expect(await sub.block("o", "r", 13, "holder-1", a.generation, "unsupported-cap", 1_000)).toBe("exhausted");
    const exhausted = await sub.listExhausted(10);
    expect(exhausted.some((row) => row.prNumber === 13 && row.lastError === "unsupported-cap")).toBe(true);
    expect((await sub.request("o", "r", 13, "cause-A", 2_000)).status).toBe("duplicate");
    expect((await sub.request("o", "r", 13, "cause-B", 2_000)).status).toBe("revived");
  });
});
