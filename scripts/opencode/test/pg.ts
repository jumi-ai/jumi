import { describe, expect, test } from "bun:test";

// Single place that decides how Postgres-only suites behave. `bun test`
// (the `checks` job) has no database, so suites skip; `bun run test:pg`
// (the `postgres-queue` job) sets JUMI_TEST_DATABASE_URL and they run. When
// JUMI_TEST_PG_REQUIRED=1 the suite fails instead of silently skipping, so a
// misspelled URL in CI cannot turn the whole job into a no-op.
export const pgDatabaseUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
export const pgRequired = process.env.JUMI_TEST_PG_REQUIRED === "1";

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
