import { beforeAll, beforeEach, expect, test } from "bun:test";
import { JUMI_REVIEW_CONTEXT } from "../src/ci.ts";
import type { Check } from "../src/ports.ts";
import { createBunSqlClient, HEARTBEAT_MS, PgReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { reclaimExpiredJobs } from "../src/server.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { resolveExhaustedFollowUpHoldOrThrow } from "../src/exhausted_hold.ts";
import { markSuggestionHoldConsumed, suggestionHoldSkippedDescription } from "../src/suggestion_hold.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeComment, makeConfig, makeIssueJob } from "./fixtures.ts";
import { describePg, pgDatabaseUrl } from "./pg.ts";

// The stale-owner fence in `resolveExhaustedFollowUpHoldOrThrow` reads the
// live `leased_by` through `store.get`, so it must hold against the real
// Postgres reclaim tokens (`reclaim:<uuid>`), not just the memory fake.
// Skipped when JUMI_TEST_DATABASE_URL is unset so `bun test` stays green
// without Docker.
describePg("router reclaim hold resolution against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = createBunSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await sql.unsafe(`DROP TABLE IF EXISTS review_jobs, issue_skip_latches, jumi_run_usage, role_gates`);
    await store.migrate();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, jumi_run_usage RESTART IDENTITY`);
    await sql.unsafe(`TRUNCATE role_gates`);
    await store.migrate();
  });

  function apiWith(statuses: Check[]) {
    const posted: Array<{ sha: string; state: string; description?: string }> = [];
    const api = makeReviewApi({
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
      updateIssueComment: async (_owner, _repo, commentId, body) => makeComment({ id: commentId, body }),
      listCommitStatuses: async () => statuses,
      createCommitStatus: async (_owner, _repo, sha, status) => {
        posted.push({ sha, state: status.state, description: status.description });
        return status;
      },
    });
    return { api, posted };
  }

  test("exhausted follow-up resolves a suggestion-only hold", async () => {
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 19, headSha: "abc123" }));
    await store.lease("worker-1", 1, new Date(Date.now() - 10_000), WORKER_JOB_KINDS);
    await markSuggestionHoldConsumed(
      store.skipLatches,
      { owner: "kirmanak", repo: "demo", issueNumber: 12 },
      "abc123",
      2
    );
    const { api, posted } = apiWith([
      { id: 1, context: JUMI_REVIEW_CONTEXT, state: "pending", description: "2 suggestions waiting for follow-up" },
    ]);

    const summary = await reclaimExpiredJobs(store, api, makeConfig({ maxJobAttempts: 1 }), () => undefined);

    expect(summary).toEqual({ requeued: 0, published: 1 });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.description).toBe(suggestionHoldSkippedDescription(2, "job failed"));
    const rows = (await sql.unsafe(`SELECT state FROM review_jobs`)) as Array<{ state: string }>;
    expect(rows.map((row) => row.state)).toEqual(["failed"]);
  });

  test("stale reclaim token cannot resolve the hold for the new claim", async () => {
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 19, headSha: "abc123" }));
    await store.lease("dead-worker", 1, new Date(1_000), WORKER_JOB_KINDS);
    await markSuggestionHoldConsumed(
      store.skipLatches,
      { owner: "kirmanak", repo: "demo", issueNumber: 12 },
      "abc123",
      2
    );
    await store.reclaimExpired(2, new Date(5_000), HEARTBEAT_MS, WORKER_JOB_KINDS);
    await store.lease("dead-worker", 1, new Date(6_000), WORKER_JOB_KINDS);
    const first = await store.reclaimExpired(2, new Date(10_000), HEARTBEAT_MS, WORKER_JOB_KINDS);
    expect(first.publish).toHaveLength(1);
    const staleToken = first.publish[0]!.leasedBy!;
    const second = await store.reclaimExpired(2, new Date(10_000 + HEARTBEAT_MS + 1), HEARTBEAT_MS, WORKER_JOB_KINDS);
    expect(second.publish).toHaveLength(1);
    const liveToken = second.publish[0]!.leasedBy!;
    expect(liveToken).not.toBe(staleToken);

    const { api, posted } = apiWith([
      { id: 1, context: JUMI_REVIEW_CONTEXT, state: "pending", description: "2 suggestions waiting for follow-up" },
    ]);
    const row = second.publish[0]!;
    expect(await resolveExhaustedFollowUpHoldOrThrow({ api, store, row, ownerToken: staleToken })).toEqual({
      resolved: false,
      reason: "stale-owner",
    });
    expect(posted).toHaveLength(0);
    const live = await resolveExhaustedFollowUpHoldOrThrow({ api, store, row, ownerToken: liveToken });
    expect(live.resolved).toBe(true);
    expect(posted).toHaveLength(1);
  });
});
