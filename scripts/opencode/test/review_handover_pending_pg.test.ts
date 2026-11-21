import { beforeAll, beforeEach, expect, test } from "bun:test";
import type { ReviewApi } from "../src/review.ts";
import { clearPendingHandover, recordPendingHandover, resumePendingHandoffs } from "../src/review_handover_pending.ts";
import { createBunSqlClient, PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeConfig, makeJob, makePR, makeUser } from "./fixtures.ts";
import { describePg, pgDatabaseUrl } from "./pg.ts";

function handoverApi(overrides: Parameters<typeof makeReviewApi>[0] = {}): ReviewApi {
  return makeReviewApi({
    getPR: async () =>
      makePR({
        body: "Fixes #12",
        user: makeUser({ login: "jumi" }),
        head: { ...makePR().head, ref: "jumi/issue-12-fix", sha: "headsha" },
      }),
    ...overrides,
  });
}

describePg("review handover pending against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = createBunSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await store.migrate();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`TRUNCATE review_jobs RESTART IDENTITY`);
    await sql.unsafe(`DROP TABLE IF EXISTS review_handover_pending`);
    await store.migrate();
  });

  test("interrupt after verdict posts resumes exactly once", async () => {
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    if (!leased) throw new Error("lease failed");
    await store.saveResult(leased.id, "engine-1", {
      kind: "markdown",
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    await recordPendingHandover(store, leased.id, "posted");
    await store.markPublished(leased.id, "engine-1", { state: "succeeded" });

    const api = handoverApi();
    const config = makeConfig();
    const first = await resumePendingHandoffs(store, api, config, () => undefined);
    expect(first.completed).toBe(1);
    expect(first.failed).toBe(0);

    const followUps = await sql.unsafe(`SELECT id FROM review_jobs WHERE kind = 'follow-up'`);
    expect((Array.isArray(followUps) ? followUps : []).length).toBe(1);

    const second = await resumePendingHandoffs(store, api, config, () => undefined);
    expect(second.completed).toBe(0);
    const again = await sql.unsafe(`SELECT id FROM review_jobs WHERE kind = 'follow-up'`);
    expect((Array.isArray(again) ? again : []).length).toBe(1);
  });

  test("failed insert then success yields one follow-up", async () => {
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    if (!leased) throw new Error("lease failed");
    await store.saveResult(leased.id, "engine-1", {
      kind: "markdown",
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    await recordPendingHandover(store, leased.id, "posted");
    await store.markPublished(leased.id, "engine-1", { state: "succeeded" });

    const api = handoverApi();
    const config = makeConfig();
    const realEnqueue = store.enqueueIssue.bind(store);
    let calls = 0;
    store.enqueueIssue = (async (job) => {
      calls += 1;
      if (calls === 1) throw new Error("ledger down");
      return realEnqueue(job);
    }) as typeof store.enqueueIssue;

    const failed = await resumePendingHandoffs(store, api, config, () => undefined);
    expect(failed.failed).toBe(1);

    store.enqueueIssue = realEnqueue;
    const ok = await resumePendingHandoffs(store, api, config, () => undefined);
    expect(ok.completed).toBe(1);
    const rows = await sql.unsafe(`SELECT id FROM review_jobs WHERE kind = 'follow-up'`);
    expect((Array.isArray(rows) ? rows : []).length).toBe(1);

    await clearPendingHandover(store, leased.id).catch(() => undefined);
  });

  test("success trailer produces no follow-up", async () => {
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    if (!leased) throw new Error("lease failed");
    await store.saveResult(leased.id, "engine-1", {
      kind: "markdown",
      markdown: "ok\n<!-- jumi-check: success -->",
    });
    await recordPendingHandover(store, leased.id, "posted");
    await store.markPublished(leased.id, "engine-1", { state: "succeeded" });

    const resumed = await resumePendingHandoffs(store, handoverApi(), makeConfig(), () => undefined);
    expect(resumed.completed).toBe(1);
    const rows = await sql.unsafe(`SELECT id FROM review_jobs WHERE kind = 'follow-up'`);
    expect((Array.isArray(rows) ? rows : []).length).toBe(0);
  });
});
