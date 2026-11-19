import { expect, test } from "bun:test";
import { createBunSqlClient, PgReviewJobStore } from "../src/review_jobs.ts";
import { makeJob } from "./fixtures.ts";
import { describePg, pgDatabaseUrl } from "./pg.ts";

describePg("PgReviewJobStore result_json round-trip", () => {
  test("markdown saveResult persists and reads back the record", async () => {
    const sql = createBunSqlClient(pgDatabaseUrl);
    try {
      const store = new PgReviewJobStore(sql);
      await store.migrate();
      await sql.unsafe(`TRUNCATE review_jobs RESTART IDENTITY`);
      await store.enqueue(makeJob());
      const leased = await store.lease("engine-1", 60_000, new Date());
      expect(leased).toBeDefined();
      const record = {
        version: 1 as const,
        state: "failure" as const,
        reason: "blocking",
        findings: [{ id: "f1", path: "src/demo.ts", line: 1, severity: "bug" as const, title: "t", body: "b" }],
        counts: { bug: 1, risk: 0, question: 0, suggestion: 0 },
      };
      await store.saveResult(leased!.id, "engine-1", { kind: "markdown", markdown: "md", record });
      const row = await store.get(leased!.id);
      expect(row?.resultJson).toEqual(record);
      await store.saveResult(leased!.id, "engine-1", { kind: "skip", reason: "late" });
      const cleared = await store.get(leased!.id);
      expect("resultJson" in (cleared ?? {})).toBe(false);
    } finally {
      await sql.close?.();
    }
  });
});
