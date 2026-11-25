import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

describePg("PgPushConfirmStore against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = openTestSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await sql.unsafe(`DROP TABLE IF EXISTS push_confirm_cause`);
    await sql.unsafe(`DROP TABLE IF EXISTS push_confirm`);
    await sql.unsafe(`DROP SEQUENCE IF EXISTS push_confirm_generation_seq`);
    await store.migrate();
  });

  afterAll(async () => {
    await (sql as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`TRUNCATE push_confirm, push_confirm_cause`);
    await store.migrate();
  });

  test("migrate is idempotent and the schema check lists both tables", async () => {
    await store.migrate();
    await store.migrate();
    await store.assertSchema();
    const listed = (await sql.unsafe(
      `SELECT tablename AS name FROM pg_tables WHERE tablename LIKE 'push_confirm%'`
    )) as Array<{ name: unknown }>;
    expect(listed.map((row) => String(row.name)).sort()).toEqual(["push_confirm", "push_confirm_cause"]);
  });

  test("confirm deletes on matching head; mismatch keeps the row", async () => {
    const sub = store.pushConfirm;
    const a = await sub.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    expect(a.status).toBe("created");
    expect(await sub.confirm("o", "r", 7, "sha-other")).toBe("mismatch");
    expect(await sub.confirm("o", "r", 7, "sha-a")).toBe("confirmed");
    expect(await sub.confirm("o", "r", 7, "sha-a")).toBe("unknown");
  });

  test("mismatch exhausts after the small budget and lists", async () => {
    const sub = store.pushConfirm;
    await sub.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    let now = 1_000 + 180_000;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const claimed = await sub.claimDue(`tok-${attempt}`, 60_000, 10, now);
      expect(claimed.length).toBe(1);
      const status = await sub.fail("o", "r", 7, `tok-${attempt}`, claimed[0]!.generation, "mismatch", now);
      if (attempt < 4) expect(status).toBe("retry");
      else expect(status).toBe("exhausted");
      now += 200_000;
    }
    const exhausted = await sub.listExhausted(10);
    expect(exhausted.length).toBe(1);
    expect(exhausted[0]?.expectedSha).toBe("sha-a");
  });
});
