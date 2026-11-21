import { expect, test } from "bun:test";
import { PgReviewJobStore, type ReviewJobRecord } from "../src/review_jobs.ts";
import { makeIssueJob } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

describePg("board blocked implement on postgres (#668)", () => {
  test("pg implementKick accepts blocked-on and lists terminal implements", async () => {
    const sql = openTestSqlClient(pgDatabaseUrl);
    try {
      const store = new PgReviewJobStore(sql);
      await store.migrate();
      await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, review_kicks RESTART IDENTITY`);
      const job = makeIssueJob({ delivery: "d-pg-blocked", issueNumber: 12 });
      await store.enqueueIssue(job);
      const leased = await store.lease("worker", 60_000, new Date(), ["implement"]);
      if (!leased) throw new Error("expected lease");
      await store.saveResult(leased.id, "worker", { kind: "skip", reason: "blocked on #196" });
      await store.markPublished(leased.id, "worker", { state: "skipped", reason: "blocked on #196" } as never);
      const listed = await store.listTerminalImplements?.(200);
      expect(listed?.some((r: ReviewJobRecord) => r.issueNumber === 12 && r.resultReason === "blocked on #196")).toBe(
        true
      );
      const outcome = await store.implementKick({
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        kick: "implement",
        actor: "operator",
        idempotencyKey: "pg-blocked-1",
        delivery: "d-pg-kick",
      });
      expect(outcome.status).toBe("ok");
      // still-blocked replay path on the pg store: log then replay.
      await store.recordImplementKick({
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        kick: "implement",
        actor: "operator",
        idempotencyKey: "pg-still-1",
        result: "still-blocked",
        terminalJobId: leased.id,
        newJobId: null,
      });
      const prior = await store.getKickByIdempotencyKey("pg-still-1");
      expect(prior?.result).toBe("still-blocked");
    } finally {
      await sql.close?.();
    }
  });
});
