import { expect, test } from "bun:test";
import { BOARD_NEEDS_KICK_PAGE_SIZE, buildBoardGroups } from "../src/board.ts";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

describePg("recovery board latest-per-item on postgres (#708)", () => {
  test("older eligible failure survives a window of unrelated completions", async () => {
    const sql = openTestSqlClient(pgDatabaseUrl);
    try {
      const store = new PgReviewJobStore(sql);
      await store.migrate();
      await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, review_kicks RESTART IDENTITY`);
      await sql.unsafe(
        `INSERT INTO review_jobs (job_key, owner, repo, pr_number, head_sha, delivery, state, kind, result_reason)
         VALUES ('kirmanak/demo#7:${HEAD_SHA}:old', 'kirmanak', 'demo', 7, '${HEAD_SHA}', 'd-old', 'failed', 'review', 'boom')`
      );
      await sql.unsafe(
        `INSERT INTO review_jobs (job_key, owner, repo, pr_number, head_sha, delivery, state, kind, result_markdown)
         SELECT 'k-' || g, 'kirmanak', 'demo', 1000 + g, 'head' || g, 'd-' || g, 'succeeded', 'review', 'done'
         FROM generate_series(1, 250) g`
      );
      const listed = await store.listTerminalReviews();
      expect(listed.some((r) => r.prNumber === 7)).toBe(true);
      expect(listed.length).toBe(251);
      const groups = await buildBoardGroups(store);
      expect(groups.needs_kick.some((item) => item.number === 7 && item.kind === "review")).toBe(true);
      expect(groups.needs_kick_overflow).toBeUndefined();
    } finally {
      await sql.close?.();
    }
  });

  test("newer success on the same item clears the older failure", async () => {
    const sql = openTestSqlClient(pgDatabaseUrl);
    try {
      const store = new PgReviewJobStore(sql);
      await store.migrate();
      await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, review_kicks RESTART IDENTITY`);
      await sql.unsafe(
        `INSERT INTO review_jobs (job_key, owner, repo, pr_number, head_sha, delivery, state, kind, result_reason)
         VALUES ('kirmanak/demo#7:${HEAD_SHA}:old', 'kirmanak', 'demo', 7, '${HEAD_SHA}', 'd-old', 'failed', 'review', 'boom')`
      );
      await sql.unsafe(
        `INSERT INTO review_jobs (job_key, owner, repo, pr_number, head_sha, delivery, state, kind, result_markdown)
         VALUES ('kirmanak/demo#7:head-new', 'kirmanak', 'demo', 7, 'head-new', 'd-new', 'succeeded', 'review', 'done')`
      );
      const listed = await store.listTerminalReviews();
      expect(listed.filter((r) => r.prNumber === 7)).toHaveLength(1);
      expect(listed.find((r) => r.prNumber === 7)?.state).toBe("succeeded");
      const groups = await buildBoardGroups(store);
      expect(groups.needs_kick.filter((item) => item.number === 7)).toHaveLength(0);
    } finally {
      await sql.close?.();
    }
  });

  test("overflow counts only eligible rows and caps the visible list", async () => {
    const sql = openTestSqlClient(pgDatabaseUrl);
    try {
      const store = new PgReviewJobStore(sql);
      await store.migrate();
      await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, review_kicks RESTART IDENTITY`);
      const total = BOARD_NEEDS_KICK_PAGE_SIZE + 1;
      await sql.unsafe(
        `INSERT INTO review_jobs (job_key, owner, repo, pr_number, head_sha, delivery, state, kind, result_reason)
         SELECT 'k-' || g, 'kirmanak', 'demo', g, '${HEAD_SHA}', 'd-' || g, 'failed', 'review', 'boom'
         FROM generate_series(1, ${total}) g`
      );
      await sql.unsafe(
        `INSERT INTO review_jobs (job_key, owner, repo, pr_number, head_sha, delivery, state, kind, result_markdown)
         SELECT 's-' || g, 'kirmanak', 'demo', 100000 + g, 'head' || g, 'ds-' || g, 'succeeded', 'review', 'done'
         FROM generate_series(1, 50) g`
      );
      const groups = await buildBoardGroups(store);
      expect(groups.needs_kick).toHaveLength(BOARD_NEEDS_KICK_PAGE_SIZE);
      expect(groups.needs_kick_overflow).toBe(1);
    } finally {
      await sql.close?.();
    }
  });
});
