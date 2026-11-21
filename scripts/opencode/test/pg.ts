import { describe, expect, test } from "bun:test";
import { createBunSqlClient, type SqlClient } from "../src/sql_client.ts";

// Single place that decides how Postgres-only suites behave. `bun test`
// (the `checks` job) has no database, so suites skip; `bun run test:pg`
// (the `postgres-queue` job) sets JUMI_TEST_DATABASE_URL and they run. When
// JUMI_TEST_PG_REQUIRED=1 the suite fails instead of silently skipping, so a
// misspelled URL in CI cannot turn the whole job into a no-op.
export const pgDatabaseUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
const pgRequired = process.env.JUMI_TEST_PG_REQUIRED === "1";

// Every `new SQL()` pool defaults to `max: 10`. The `test:pg` script runs all
// `*_pg.test.ts` files in one `bun test` process, so one uncapped pool per
// file (plus the two contenders in the shared-failure election) can hold
// ~100 server connections and trip `53300 too many clients` on the CI
// `max_connections=100` service. Tests own their pools: open them through
// this helper (two connections cover one held transaction plus one racing
// query) and `close()` them in `afterAll` (or `try/finally` for per-test
// pools).
const TEST_PG_POOL_MAX = 2;

export function openTestSqlClient(databaseUrl: string = pgDatabaseUrl): SqlClient {
  return createBunSqlClient(databaseUrl, { max: TEST_PG_POOL_MAX });
}

export function describePg(name: string, fn: () => void): void {
  if (pgDatabaseUrl) {
    describe(name, fn);
    return;
  }
  if (pgRequired) {
    describe(name, () => {
      test("requires JUMI_TEST_DATABASE_URL (JUMI_TEST_PG_REQUIRED=1)", () => {
        expect(pgDatabaseUrl).not.toBe("");
      });
    });
    return;
  }
  describe.skip(name, fn);
}
