import { expect, test } from "bun:test";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

describePg("shared ledger election (pg)", () => {
  test("concurrent election elects exactly one first", async () => {
    const sqlA = openTestSqlClient(pgDatabaseUrl);
    const sqlB = openTestSqlClient(pgDatabaseUrl);
    try {
      const a = new PgReviewJobStore(sqlA);
      const b = new PgReviewJobStore(sqlB);
      await a.migrate();
      const fp = `pg-burst-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const owner = "pg-owner";
      const repo = "pg-repo";
      const nowMs = Date.now();
      const [ra, rb] = await Promise.all([
        a.electSharedFailure({
          owner,
          repo,
          prNumber: 101,
          check: "build",
          fingerprint: fp,
          nowMs,
          isOpen: () => true,
          isLivePush: () => true,
        }),
        b.electSharedFailure({
          owner,
          repo,
          prNumber: 102,
          check: "build",
          fingerprint: fp,
          nowMs,
          isOpen: () => true,
          isLivePush: () => true,
        }),
      ]);
      const roles = [ra, rb].map((result) => result.role).sort();
      expect(roles).toEqual(["first", "waiter"]);
      const listed = await a.listSharedFailures(owner, repo, nowMs - 60_000, nowMs + 60_000);
      expect(listed.some((entry) => entry.fingerprint === fp)).toBe(true);
    } finally {
      await sqlA.close?.();
      await sqlB.close?.();
    }
  });
});
