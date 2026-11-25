import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { resumePendingHandoffs } from "../src/review_handover_pending.ts";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import { reclaimExpiredJobs } from "../src/server.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeConfig, makeJob, makePR, makeUser } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

const BLOCKING_MARKDOWN = "src/demo.ts:1: 🔴 blocking\n<!-- jumi-check: failure -->";

describePg("atomic review settle with handover against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = openTestSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await store.migrate();
  });

  afterAll(async () => {
    await (sql as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`TRUNCATE review_jobs, follow_up_wake_causes RESTART IDENTITY`);
    await sql.unsafe(`DROP TABLE IF EXISTS review_handover_pending`);
    await store.migrate();
  });

  test("handover-insert fault blocks the terminal settle; recovery queues one follow-up", async () => {
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    if (!leased) throw new Error("lease failed");
    await store.saveResult(leased.id, "dead-engine", {
      kind: "markdown",
      markdown: BLOCKING_MARKDOWN,
    });

    const api = makeReviewApi({
      getPR: async () =>
        makePR({
          body: "Fixes #12",
          user: makeUser({ login: "jumi" }),
        }),
    });
    const config = makeConfig();

    // Controlled fault injection: fail only the pending-handover INSERT, both
    // direct and inside the settle transaction, so the atomic settle rolls
    // back instead of leaving a terminal review with no obligation.
    const holder = store as unknown as { sql: SqlClient };
    const originalSql = holder.sql;
    let faultActive = true;
    const faultSql: SqlClient = {
      ...originalSql,
      async unsafe(query: string, params?: unknown[]) {
        if (faultActive && query.includes("review_handover_pending") && query.includes("INSERT")) {
          throw new Error("pending insert down");
        }
        return originalSql.unsafe(query, params);
      },
      async begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
        return originalSql.begin(async (tx) => {
          const faultTx: SqlClient = {
            ...tx,
            async unsafe(query: string, params?: unknown[]) {
              if (faultActive && query.includes("review_handover_pending") && query.includes("INSERT")) {
                throw new Error("pending insert down");
              }
              return tx.unsafe(query, params);
            },
            begin: tx.begin.bind(tx),
          };
          return fn(faultTx);
        });
      },
    };
    holder.sql = faultSql;
    try {
      await reclaimExpiredJobs(store, api, config, () => undefined);
    } finally {
      faultActive = false;
    }

    // No attempt falsely reports a successful terminal settle.
    const stalled = await store.get(leased.id);
    expect(stalled?.state).toBe("leased");
    expect(stalled?.publishedAt).toBeNull();
    const stalledFollowUps = await sql.unsafe(`SELECT id FROM review_jobs WHERE kind = 'follow-up'`);
    expect(Array.isArray(stalledFollowUps) ? stalledFollowUps.length : 0).toBe(0);

    holder.sql = originalSql;
    await reclaimExpiredJobs(store, api, config, () => undefined);

    const settled = await store.get(leased.id);
    expect(settled?.state).toBe("succeeded");
    const followUps = await sql.unsafe(`SELECT id FROM review_jobs WHERE kind = 'follow-up'`);
    expect(Array.isArray(followUps) ? followUps.length : 0).toBe(1);

    const resumed = await resumePendingHandoffs(store, api, config, () => undefined);
    expect(resumed.completed).toBe(0);
    const again = await sql.unsafe(`SELECT id FROM review_jobs WHERE kind = 'follow-up'`);
    expect(Array.isArray(again) ? again.length : 0).toBe(1);
  });
});
