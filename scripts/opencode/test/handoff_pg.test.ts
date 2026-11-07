import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { handoffKey } from "../src/handoff.ts";
import { createBunSqlClient, PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";

const databaseUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
const pgRequired = process.env.JUMI_TEST_PG_REQUIRED === "1";

test("postgres handoff suite is not silently skipped where CI requires it", () => {
  expect(pgRequired && databaseUrl === "").toBe(false);
});

const describePg = databaseUrl ? describe : describe.skip;

describePg("PgHandoffStore against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  function asRows<T>(result: unknown): T[] {
    return Array.isArray(result) ? (result as T[]) : [];
  }

  // bun runs beforeAll at module scope
  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = createBunSqlClient(databaseUrl);
    store = new PgReviewJobStore(sql);
    await sql.unsafe(`DROP TABLE IF EXISTS issue_handoffs`);
    await store.migrate();
  });

  // bun runs beforeEach at module scope
  beforeEach(async () => {
    if (!databaseUrl) return;
    await sql.unsafe(`TRUNCATE issue_handoffs`);
    await store.migrate();
  });

  test("write, cap, replace, and missing note", async () => {
    const key = handoffKey("gitea", "kirmanak", "demo", 12);
    expect(await store.handoffs.get(key)).toBeNull();
    await store.handoffs.put(key, "first round");
    expect(await store.handoffs.get(key)).toBe("first round");
    await store.handoffs.put(key, "second round");
    expect(await store.handoffs.get(key)).toBe("second round");
    const big = `note\n${"x".repeat(20_000)}`;
    await store.handoffs.put(key, big);
    const capped = await store.handoffs.get(key);
    expect(capped).not.toBeNull();
    expect(new TextEncoder().encode(capped as string).byteLength).toBeLessThanOrEqual(16 * 1024);
    await store.handoffs.delete(key);
    expect(await store.handoffs.get(key)).toBeNull();
  });

  test("forges are isolated and deleteForIssue clears both", async () => {
    const gitea = handoffKey("gitea", "kirmanak", "demo", 12);
    const github = handoffKey("github", "kirmanak", "demo", 12);
    await store.handoffs.put(gitea, "gitea note");
    await store.handoffs.put(github, "github note");
    expect(await store.handoffs.get(gitea)).toBe("gitea note");
    expect(await store.handoffs.get(github)).toBe("github note");
    await store.handoffs.deleteForIssue("kirmanak", "demo", 12);
    expect(await store.handoffs.get(gitea)).toBeNull();
    expect(await store.handoffs.get(github)).toBeNull();
  });

  test("kill switch and close paths delete the row", async () => {
    const key = handoffKey("gitea", "kirmanak", "demo", 12);
    await store.handoffs.put(key, "round one");
    await store.clearIssueSkipLatch("kirmanak", "demo", 12);
    expect(await store.handoffs.get(key)).toBeNull();
    await store.handoffs.put(key, "round two");
    await store.cancelQueuedForIssue("kirmanak", "demo", 12);
    expect(await store.handoffs.get(key)).toBeNull();
  });

  test("migrate is idempotent for the new table", async () => {
    await store.migrate();
    await store.migrate();
    const rows = asRows<{ name: unknown }>(
      await sql.unsafe(`SELECT tablename AS name FROM pg_tables WHERE tablename = 'issue_handoffs'`)
    );
    expect(rows.length).toBe(1);
  });
});
