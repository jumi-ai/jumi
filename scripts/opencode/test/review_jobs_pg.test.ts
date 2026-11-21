import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_LOOKUP_BACKOFF_MS, CI_LOOKUP_BUDGET_MS, CI_LOOKUP_FAILED_REASON, encodeCiLookupMarker } from "../src/ci.ts";
import { EngineFailedError } from "../src/engine.ts";
import { decideQuotaRetry, QUOTA_MESSAGE, QuotaWaitError } from "../src/quota.ts";
import type { ReviewApi } from "../src/review.ts";
import {
  assertLedgerSchema,
  isReclaimOwner,
  isUniqueViolation,
  MAX_ATTEMPTS_REASON,
  openPgReviewJobStoreForJob,
  PgReviewJobStore,
  WORKER_JOB_KINDS,
  WORKER_MAX_ATTEMPTS_REASON,
} from "../src/review_jobs.ts";
import { processEngineTick, reclaimExpiredJobs } from "../src/server.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { processWorkerTick } from "../src/worker.ts";
import { makeReviewApi as makeSharedReviewApi } from "./fakes/forge.ts";
import {
  makeComment,
  makeConfig,
  makeFile,
  makeIssue,
  makeIssueJob,
  makeJob,
  makePR,
  makeRepo,
  makeWorkerConfig,
} from "./fixtures.ts";
import { frozenGitRunner } from "./harness/git.ts";

// The ledger invariants below live in Postgres, not in TypeScript: partial unique
// indexes, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT ... WHERE`, and the migration that
// requeues duplicate worker leases before the index that forbids them. A fake `unsafe()`
// that matches substrings cannot fail when one of those clauses is deleted, so this file
// runs the real `PgReviewJobStore` against a real database. It is skipped when
// JUMI_TEST_DATABASE_URL is unset so `bun test` stays green without Docker.
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

function failingLookupApi(pr = makePR()): {
  api: ReviewApi;
  lists: () => number;
  statuses: Array<{ state: string; description?: string }>;
} {
  const statuses: Array<{ state: string; description?: string }> = [];
  let lists = 0;
  const boom = async () => {
    lists++;
    throw new Error("rate limited");
  };
  const api: ReviewApi = makeSharedReviewApi({
    getPR: async () => pr,
    getIssue: async () => {
      throw new Error("unused");
    },
    createCommitStatus: async (_owner, _repo, _sha, status) => {
      statuses.push({ state: status.state, description: status.description });
      return status;
    },
    listCommitStatuses: boom,
    listCheckRuns: boom,
    listActionJobs: boom,
  });
  return { api, lists: () => lists, statuses };
}

describePg("PgReviewJobStore against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  function asRows<T>(result: unknown): T[] {
    return Array.isArray(result) ? (result as T[]) : [];
  }

  async function countJobs(where: string, params: unknown[] = []): Promise<number> {
    const rows = asRows<{ n: unknown }>(
      await sql.unsafe(`SELECT COUNT(*)::int AS n FROM review_jobs WHERE ${where}`, params)
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function indexExists(name: string): Promise<boolean> {
    const rows = asRows<{ n: unknown }>(
      await sql.unsafe(`SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = $1`, [name])
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async function waitForBlockedReviewJobsLock(timeoutMs = 5_000): Promise<void> {
    const probe = openTestSqlClient(pgDatabaseUrl);
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const rows = asRows<{ n: unknown }>(
          await probe.unsafe(
            `SELECT COUNT(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND query LIKE '%review_jobs%' AND pid <> pg_backend_pid()`
          )
        );
        if (Number(rows[0]?.n ?? 0) >= 1) return;
        await Bun.sleep(10);
      }
      throw new Error("timed out waiting for lease() to block on review_jobs_leased_worker_issue");
    } finally {
      await probe.close?.();
    }
  }

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = openTestSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    // Start from an empty database so `migrate()` is exercised from scratch, not against
    // whatever a previous run left behind.
    await sql.unsafe(`DROP TABLE IF EXISTS review_jobs, issue_skip_latches, jumi_run_usage, role_gates`);
    await store.migrate();
  });

  afterAll(async () => {
    await (sql as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, jumi_run_usage RESTART IDENTITY`);
    await sql.unsafe(`TRUNCATE role_gates`);
    // Re-assert the schema: the migrate test drops an index on purpose.
    await store.migrate();
  });

  test("two workers racing for one issue end with exactly one lease", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha1", delivery: "d2" }));
    expect(await countJobs(`state = 'queued'`)).toBe(2);

    const leased = (
      await Promise.all([
        store.lease("worker-a", 60_000, new Date(), WORKER_JOB_KINDS),
        store.lease("worker-b", 60_000, new Date(), WORKER_JOB_KINDS),
      ])
    ).filter((row) => row != null);

    expect(leased).toHaveLength(1);
    expect(leased[0]?.issueNumber).toBe(12);
    expect(await countJobs(`state = 'leased'`)).toBe(1);
    expect(await countJobs(`state = 'queued'`)).toBe(1);
  });

  test("partial unique index rejects a second leased worker row for the same issue", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha1", delivery: "d2" }));
    const first = await store.lease("worker-a", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(first?.kind).toBe("implement");

    const queued = asRows<{ id: unknown }>(await sql.unsafe(`SELECT id FROM review_jobs WHERE state = 'queued'`));
    expect(queued).toHaveLength(1);

    let err: unknown;
    try {
      await sql.unsafe(
        `UPDATE review_jobs
         SET state = 'leased', leased_by = 'worker-b', leased_until = NOW() + interval '1 minute'
         WHERE id = $1`,
        [Number(queued[0]?.id)]
      );
    } catch (caught) {
      err = caught;
    }
    // The index name is in the server message, so this assertion fails if the partial
    // unique index is dropped from the schema rather than merely renamed around it.
    expect(String(err)).toContain("review_jobs_leased_worker_issue");
    // `lease()` swallows exactly this error class to retry; a real driver error, not a fake.
    expect(isUniqueViolation(err)).toBe(true);
    expect(await countJobs(`state = 'leased'`)).toBe(1);
  });

  test("a lease that loses the index race retries and comes back empty", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha1", delivery: "d2" }));
    const ids = asRows<{ id: unknown }>(await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`));
    expect(ids).toHaveLength(2);

    // Hold an uncommitted lease on the first row. The second lease cannot see it yet, so it
    // runs the whole NOT EXISTS / SKIP LOCKED path and only collides at the unique index.
    let commit!: () => void;
    let holderReady!: () => void;
    const gate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const holderUpdated = new Promise<void>((resolve) => {
      holderReady = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx.unsafe(
        `UPDATE review_jobs
         SET state = 'leased', leased_by = 'worker-holder', leased_until = NOW() + interval '1 hour'
         WHERE id = $1`,
        [Number(ids[0]?.id)]
      );
      holderReady();
      await gate;
    });

    await holderUpdated;
    const blocked = store.lease("worker-b", 60_000, new Date(), WORKER_JOB_KINDS);
    try {
      await waitForBlockedReviewJobsLock();
    } finally {
      commit();
      await holder;
    }

    // Not an error: 23505 here means "someone else got the issue", and the retry finds the
    // now-visible lease. A lease() that rethrew would read as a dead queue to the worker.
    expect(await blocked).toBeUndefined();
    expect(await countJobs(`state = 'leased'`)).toBe(1);
    expect(await countJobs(`state = 'queued'`)).toBe(1);
  });

  test("a blocked issue does not starve another issue, and unblocks when the lease ends", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha1", delivery: "d2" }));
    await store.enqueueIssue(
      makeIssueJob({
        issueNumber: 13,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/13",
        delivery: "d3",
      })
    );

    const first = await store.lease("worker-a", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(first?.issueNumber).toBe(12);
    expect(first?.kind).toBe("implement");

    // Without the NOT EXISTS guard the oldest runnable row is issue 12's follow-up, whose
    // UPDATE trips the unique index; the lease would come back empty and issue 13 would
    // wait behind a job it has nothing to do with.
    const second = await store.lease("worker-b", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(second?.issueNumber).toBe(13);

    await store.markPublished(first!.id, "worker-a", { state: "succeeded" });
    const third = await store.lease("worker-c", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(third?.issueNumber).toBe(12);
    expect(third?.kind).toBe("follow-up");
  });

  test("reclaim requeues an expired lease and publishes failure at the attempt cap", async () => {
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    expect(leased?.attempt).toBe(0);

    const live = await store.reclaimExpired(2);
    expect(live.requeued).toHaveLength(0);
    expect(live.publish).toHaveLength(0);

    expect(await store.expireLease(leased!.id, "engine-1")).toBe(true);
    const first = await store.reclaimExpired(2);
    expect(first.publish).toHaveLength(0);
    expect(first.requeued).toHaveLength(1);
    expect(first.requeued[0]?.attempt).toBe(1);
    expect(first.requeued[0]?.state).toBe("queued");

    const retried = await store.lease("engine-2", 60_000);
    expect(retried?.id).toBe(leased!.id);
    expect(retried?.attempt).toBe(1);
    expect(await store.expireLease(retried!.id, "engine-2")).toBe(true);

    const second = await store.reclaimExpired(2);
    expect(second.requeued).toHaveLength(0);
    expect(second.publish).toHaveLength(1);
    expect(second.publish[0]?.attempt).toBe(2);
    expect(second.publish[0]?.state).toBe("leased");
    expect(isReclaimOwner(second.publish[0]?.leasedBy)).toBe(true);
    expect(second.publish[0]?.error).toBe(MAX_ATTEMPTS_REASON);
    expect(second.publish[0]?.resultReason).toBe(MAX_ATTEMPTS_REASON);

    const stored = await store.get(leased!.id);
    expect(stored?.state).toBe("leased");
    expect(isReclaimOwner(stored?.leasedBy)).toBe(true);
    expect(stored?.leasedUntil ?? 0).toBeGreaterThan(Date.now());
  });

  test("sequential reclaims supersede: first holder acknowledge rejected, second succeeds", async () => {
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const first = await store.reclaimExpired(2, new Date(5_000));
    expect(first.publish).toHaveLength(1);
    const firstToken = first.publish[0]!.leasedBy!;
    expect(isReclaimOwner(firstToken)).toBe(true);
    const second = await store.reclaimExpired(2, new Date(5_000 + 30_000 + 1));
    expect(second.publish).toHaveLength(1);
    const secondToken = second.publish[0]!.leasedBy!;
    expect(isReclaimOwner(secondToken)).toBe(true);
    expect(secondToken).not.toBe(firstToken);
    await expect(store.markPublished(leased!.id, firstToken, { state: "succeeded" })).rejects.toThrow(
      "cannot mark published"
    );
    expect(await store.heartbeat(leased!.id, firstToken, 60_000, new Date(5_000 + 30_000 + 2))).toBe(false);
    expect(await store.expireLease(leased!.id, firstToken, new Date(5_000 + 30_000 + 2))).toBe(false);
    await store.markPublished(leased!.id, secondToken, { state: "succeeded" });
    expect((await store.get(leased!.id))?.state).toBe("succeeded");
  });

  test("concurrent reclaimExpired claims one row once with a single effective token", async () => {
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    await store.expireLease(leased!.id, "dead-engine", new Date(2_000));
    // Force the row back to expired with a persisted result so both racers see it.
    await sql.unsafe(
      `UPDATE review_jobs SET leased_by = 'dead-engine', leased_until = NOW() - interval '1 second' WHERE id = $1`,
      [leased!.id]
    );
    const results = await Promise.all([store.reclaimExpired(2), store.reclaimExpired(2)]);
    const claimed = results.flatMap((result) => result.publish);
    // Exactly one effective claim per row: either one racer wins or the loser
    // reclaims the winner's unexpired lease and supersedes it — never two live tokens.
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const stored = await store.get(leased!.id);
    expect(isReclaimOwner(stored?.leasedBy)).toBe(true);
    for (const row of claimed.slice(0, -1)) {
      await expect(store.markPublished(row.id, row.leasedBy!, { state: "succeeded" })).rejects.toThrow();
    }
    const live = claimed[claimed.length - 1]!;
    expect(live.leasedBy).toBe(stored?.leasedBy ?? null);
    await store.markPublished(live.id, live.leasedBy!, { state: "succeeded" });
    expect((await store.get(leased!.id))?.state).toBe("succeeded");
  });

  test("same-key enqueue clears a queued ci-lookup backoff", async () => {
    const job = makeJob();
    await store.enqueue(job);
    const leased = await store.lease("engine-1", 60_000);
    const now = Date.now();
    expect(await store.requeueInfra(leased!.id, "engine-1", 60_000, encodeCiLookupMarker(1, now), new Date(now))).toBe(
      true
    );
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });
    const row = await store.get(leased!.id);
    expect(row?.state).toBe("queued");
    expect(row?.leasedUntil).toBeNull();
    expect(row?.error).toBe(encodeCiLookupMarker(1, now));
    expect(await store.lease("engine-1", 60_000, new Date(now))).toBeDefined();
  });

  test("concurrent enqueue of one job_key inserts exactly one in-flight row", async () => {
    const job = makeJob();
    const key = "kirmanak/demo#7:headsha";
    const results = await Promise.all([store.enqueue(job), store.enqueue(job)]);

    expect(results.map((result) => result.key)).toEqual([key, key]);
    expect(results.filter((result) => result.queued)).toHaveLength(1);
    expect(await countJobs(`job_key = $1`, [key])).toBe(1);
  });

  test("in-flight dedupe index is partial: a terminal row does not block the next attempt", async () => {
    const job = makeJob();
    const key = "kirmanak/demo#7:headsha";
    expect(await store.enqueue(job)).toEqual({ key, queued: true });
    const leased = await store.lease("engine-1", 60_000);
    await store.markPublished(leased!.id, "engine-1", { state: "failed", reason: "boom" });

    // A new delivery stays eligible; the same delivery would dedupe per effect
    // (see the retried-delivery test below).
    expect(await store.enqueue(makeJob({ delivery: "delivery-2" }))).toEqual({ key, queued: true });
    expect(await countJobs(`job_key = $1`, [key])).toBe(2);
    expect(await countJobs(`job_key = $1 AND state IN ('queued', 'leased')`, [key])).toBe(1);
  });

  test("migrate is idempotent and requeues extra leased worker rows before the unique index", async () => {
    expect(await indexExists("review_jobs_leased_worker_issue")).toBe(true);

    // Reproduce a pre-index ledger: two leased worker rows on one issue.
    await sql.unsafe(`DROP INDEX review_jobs_leased_worker_issue`);
    await sql.unsafe(
      `INSERT INTO review_jobs (
         job_key, kind, owner, repo, pr_number, head_sha, issue_number, delivery, state, attempt, leased_by, leased_until
       ) VALUES
         ($1, 'implement', 'kirmanak', 'demo', 0, '', 12, 'd1', 'leased', 0, 'worker-a', NOW() + interval '1 hour'),
         ($2, 'follow-up', 'kirmanak', 'demo', 7, 'sha1', 12, 'd2', 'leased', 0, 'worker-b', NOW() + interval '1 hour')`,
      ["implement:kirmanak/demo#12", "follow-up:kirmanak/demo#7:sha1"]
    );

    await store.migrate();
    const after = asRows<{ kind: unknown; state: unknown; leased_by: unknown }>(
      await sql.unsafe(`SELECT kind, state, leased_by FROM review_jobs ORDER BY id`)
    );
    expect(after.map((row) => String(row.state))).toEqual(["leased", "queued"]);
    expect(String(after[0]?.leased_by)).toBe("worker-a");
    expect(after[1]?.leased_by).toBeNull();
    expect(await indexExists("review_jobs_leased_worker_issue")).toBe(true);

    // Migrate again: every statement in the schema must survive a second run.
    await store.migrate();
    expect(await countJobs(`state = 'leased'`)).toBe(1);
    expect(await indexExists("review_jobs_leased_worker_issue")).toBe(true);
    expect(await indexExists("review_jobs_inflight_job_key")).toBe(true);
  });

  test("always-failing CI lookup becomes terminal after the budget and is not leasable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-ci-lookup-"));
    const blocker = join(workspace, "not-a-dir");
    await writeFile(blocker, "x");
    try {
      await store.enqueue(makeJob());
      const { api, lists, statuses } = failingLookupApi();
      let now = Date.UTC(2026, 0, 1);
      const config = makeConfig({ workdir: blocker, home: workspace });
      const extras = {
        now: () => now,
        openCodeRunner: async () => {
          throw new Error("runner should not be called");
        },
      };
      await processEngineTick(store, config, api, "engine-1", extras);
      const ids = asRows<{ id: unknown }>(await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`));
      const id = Number(ids[0]?.id);
      const cooling = await store.get(id);
      expect(cooling?.state).toBe("queued");
      expect(cooling?.leasedUntil).toBe(now + CI_LOOKUP_BACKOFF_MS[0]);
      expect(statuses).toEqual([]);
      expect(await store.lease("engine-2", 60_000, new Date(now))).toBeUndefined();
      now += CI_LOOKUP_BUDGET_MS;
      await processEngineTick(store, config, api, "engine-1", extras);
      const done = await store.get(id);
      expect(done?.state).toBe("failed");
      expect(done?.resultReason).toBe(CI_LOOKUP_FAILED_REASON);
      expect(done?.publishedAt).not.toBeNull();
      expect(statuses).toEqual([{ state: "failure", description: CI_LOOKUP_FAILED_REASON }]);
      expect(lists()).toBe(12);
      expect(await store.lease("engine-2", 60_000, new Date(now))).toBeUndefined();
      expect(await processEngineTick(store, config, api, "engine-1", extras)).toBe("idle");
      expect(lists()).toBe(12);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("closed pull with failing CI lookups finishes in one lease", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-ci-closed-"));
    const blocker = join(workspace, "not-a-dir");
    await writeFile(blocker, "x");
    try {
      await store.enqueue(makeJob());
      const { api, lists } = failingLookupApi(makePR({ state: "closed" }));
      const config = makeConfig({ workdir: blocker, home: workspace });
      await processEngineTick(store, config, api, "engine-1", {
        openCodeRunner: async () => {
          throw new Error("runner should not be called");
        },
      });
      expect(lists()).toBe(0);
      const ids = asRows<{ id: unknown }>(await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`));
      const row = await store.get(Number(ids[0]?.id));
      expect(row?.state).toBe("skipped");
      expect(row?.resultReason).toBe("PR is closed");
      expect(await processEngineTick(store, config, api, "engine-1")).toBe("idle");
      expect(lists()).toBe(0);
      expect(await store.lease("engine-2", 60_000)).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("run usage rows round-trip through postgres aggregates", async () => {
    await store.enqueue(makeJob());
    const leased = (await store.lease("engine-1", 60_000))!;
    await store.recordRunUsageRows([
      {
        jobId: leased.id,
        jobKey: leased.jobKey,
        kind: "review",
        runner: "opencode",
        model: "xai/grok-4.6",
        agentInstance: "jumi",
        tokensInput: 15,
        tokensCacheRead: 120,
        tokensOutput: 4,
        tokensCacheWrite: 1,
        tokensReasoning: 6,
        sessions: 2,
        exitClass: "ok",
        runnerOutcome: "ok",
        quotaResetAt: null,
        startedAt: new Date(1_000_000),
        endedAt: new Date(1_090_000),
        durationSeconds: 90,
      },
      {
        jobId: leased.id,
        jobKey: leased.jobKey,
        kind: "review",
        runner: "claude",
        model: "claude-opus-5",
        agentInstance: "jumi",
        tokensInput: 0,
        tokensCacheRead: 0,
        tokensOutput: 0,
        tokensCacheWrite: 0,
        tokensReasoning: 0,
        sessions: 0,
        exitClass: "auth",
        runnerOutcome: "auth",
        quotaResetAt: null,
        startedAt: new Date(2_000_000),
        endedAt: new Date(2_008_000),
        durationSeconds: 8,
      },
    ]);
    // Empty batches are a no-op, never an INSERT with zero tuples.
    await store.recordRunUsageRows([]);
    const tokens = await store.getRunUsageTokenTotals();
    expect(tokens).toContainEqual({
      agentInstance: "jumi",
      source: "opencode",
      model: "xai/grok-4.6",
      tokenType: "input",
      value: 15,
    });
    expect(tokens).toContainEqual({
      agentInstance: "jumi",
      source: "claude",
      model: "claude-opus-5",
      tokenType: "output",
      value: 0,
    });
    expect(await store.getRunUsageSessionTotals()).toContainEqual({
      agentInstance: "jumi",
      source: "opencode",
      model: "xai/grok-4.6",
      value: 2,
    });
    const exits = await store.getRunExitCounts();
    expect(exits).toContainEqual({ kind: "review", exitClass: "ok", count: 1 });
    expect(exits).toContainEqual({ kind: "review", exitClass: "auth", count: 1 });
    const durations = await store.getRunDurations();
    expect(durations).toContainEqual({ kind: "review", exitClass: "ok", durationSeconds: 90 });
    expect(await indexExists("jumi_run_usage_job_key")).toBe(true);
  });

  test("one multi-model attempt counts exit and duration once in postgres", async () => {
    await store.enqueue(makeJob());
    const leased = (await store.lease("engine-1", 60_000))!;
    const base = {
      jobId: leased.id,
      jobKey: leased.jobKey,
      kind: "review" as const,
      runner: "opencode",
      agentInstance: "jumi",
      tokensInput: 10,
      tokensCacheRead: 0,
      tokensOutput: 2,
      tokensCacheWrite: 0,
      tokensReasoning: 0,
      sessions: 1,
      exitClass: "ok" as const,
      runnerOutcome: "ok" as const,
      quotaResetAt: null,
      startedAt: new Date(1_000_000),
      endedAt: new Date(1_090_000),
      durationSeconds: 90,
    };
    await store.recordRunUsageRows([
      { ...base, model: "model-a", attemptId: "attempt-1" },
      { ...base, model: "model-b", attemptId: "attempt-1" },
      { ...base, model: "model-c", attemptId: "attempt-1" },
      // Legacy shape: no attempt identity, counts as its own attempt.
      { ...base, model: "model-legacy", attemptId: null },
    ]);
    expect(await store.getRunExitCounts()).toContainEqual({ kind: "review", exitClass: "ok", count: 2 });
    expect(await store.getRunRunnerExitCounts()).toContainEqual({
      kind: "review",
      runner: "opencode",
      outcome: "ok",
      count: 2,
    });
    const durations = await store.getRunDurations();
    expect(durations.filter((row) => row.kind === "review" && row.exitClass === "ok")).toHaveLength(2);
    const tokens = await store.getRunUsageTokenTotals();
    const input = tokens
      .filter((row) => row.tokenType === "input" && row.source === "opencode")
      .reduce((sum, row) => sum + row.value, 0);
    // Token sums stay per row: three attempt rows plus the legacy row.
    expect(input).toBe(40);
    const sessions = await store.getRunUsageSessionTotals();
    expect(sessions.filter((row) => row.source === "opencode").reduce((sum, row) => sum + row.value, 0)).toBe(4);
  });

  function pgReviewApi(): ReviewApi {
    return makeSharedReviewApi({
      getPRFiles: async () => [makeFile()],
      listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    });
  }

  function secondStore(): { sql2: SqlClient; store2: PgReviewJobStore; close: () => Promise<void> } {
    const sql2 = openTestSqlClient(pgDatabaseUrl);
    const store2 = new PgReviewJobStore(sql2);
    return {
      sql2,
      store2,
      close: async () => {
        await sql2.close?.();
      },
    };
  }

  test("breaker tripped by one process blocks an engine lease in another", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-gate-breaker-"));
    const { store2, close } = secondStore();
    try {
      await store.enqueue(makeJob());
      // Trip the ledger breaker from the first process.
      await store.recordRoleInfra("engine");
      await store.recordRoleInfra("engine");
      await store.recordRoleInfra("engine");
      expect(await store.mayStartWork("engine")).toBe(false);
      expect((await store2.checkRoleGate("engine")).infraBlocked).toBe(true);
      expect(await store2.mayStartWork("engine")).toBe(false);

      const logs: string[] = [];
      const result = await processEngineTick(
        store2,
        makeConfig({ workdir: workspace, home: workspace }),
        pgReviewApi(),
        "engine-2",
        {
          gitRunner: frozenGitRunner(),
          workspacePreparer: async () => undefined,
          openCodeRunner: async () => {
            throw new Error("runner should not be called while the breaker is open");
          },
        },
        (message) => logs.push(message)
      );
      expect(result).toBe("idle");
      expect(logs.some((line) => line === "breaker open")).toBe(true);
      const row = await store2.get(1);
      expect(row?.state).toBe("queued");

      // A model success resets the ledger breaker for the other process.
      await store.recordRoleSuccess("engine");
      expect(await store2.mayStartWork("engine")).toBe(true);
    } finally {
      await close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("breaker tripped by one process blocks a worker lease in another", async () => {
    const { store2, close } = secondStore();
    try {
      await store.enqueueIssue(makeIssueJob());
      await store.recordRoleInfra("worker");
      await store.recordRoleInfra("worker");
      await store.recordRoleInfra("worker");
      expect(await store2.mayStartWork("worker")).toBe(false);

      const logs: string[] = [];
      let calls = 0;
      const result = await processWorkerTick(
        store2,
        makeWorkerConfig(),
        {
          getRepo: async () => makeRepo(),
          getCollaboratorPermission: async () => ({ permission: "write" }),
          getIssue: async () => makeIssue(),
        } as never,
        "worker-2",
        {
          implement: async () => {
            calls += 1;
            return { status: "pr" as const, prNumber: 3, htmlUrl: "https://example.test/pr/3" };
          },
        },
        (message) => logs.push(message)
      );
      expect(result).toBe("idle");
      expect(calls).toBe(0);
      expect(logs.some((line) => line === "breaker open")).toBe(true);
    } finally {
      await close();
    }
  });

  test("quota recorded by one process blocks an engine lease in another", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-gate-quota-engine-"));
    const { store2, close } = secondStore();
    try {
      await store.enqueue(makeJob());
      // First process hits quota through the real tick, recording to the ledger.
      await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        pgReviewApi(),
        "engine-1",
        {
          gitRunner: frozenGitRunner(),
          workspacePreparer: async () => undefined,
          openCodeRunner: async () => ({ status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" as const }),
        },
        () => undefined
      );
      const gate = await store2.checkRoleGate("engine", new Date());
      expect(gate.quotaBlocked).toBe(true);
      expect(await store2.mayStartWork("engine")).toBe(false);

      const logs: string[] = [];
      const result = await processEngineTick(
        store2,
        makeConfig({ workdir: workspace, home: workspace }),
        pgReviewApi(),
        "engine-2",
        {
          gitRunner: frozenGitRunner(),
          workspacePreparer: async () => undefined,
          openCodeRunner: async () => {
            throw new Error("runner should not be called while quota cools");
          },
        },
        (message) => logs.push(message)
      );
      expect(result).toBe("idle");
      expect(logs.some((line) => line === "quota cooldown")).toBe(true);
    } finally {
      await close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("quota recorded by one process blocks a worker lease in another", async () => {
    const { store2, close } = secondStore();
    try {
      await store.enqueueIssue(makeIssueJob());
      await processWorkerTick(
        store,
        makeWorkerConfig(),
        {
          getRepo: async () => makeRepo(),
          getCollaboratorPermission: async () => ({ permission: "write" }),
          getIssue: async () => makeIssue(),
        } as never,
        "worker-1",
        {
          implement: async () => {
            const decision = decideQuotaRetry(null, Date.now(), undefined, () => 0);
            if (decision.action !== "requeue") throw new Error("expected requeue");
            throw new QuotaWaitError(decision);
          },
        },
        () => undefined
      );
      expect((await store2.checkRoleGate("worker")).quotaBlocked).toBe(true);
      expect(await store2.mayStartWork("worker")).toBe(false);

      const logs: string[] = [];
      let calls = 0;
      const result = await processWorkerTick(
        store2,
        makeWorkerConfig(),
        {
          getRepo: async () => makeRepo(),
          getCollaboratorPermission: async () => ({ permission: "write" }),
          getIssue: async () => makeIssue(),
        } as never,
        "worker-2",
        {
          implement: async () => {
            calls += 1;
            return { status: "pr" as const, prNumber: 3, htmlUrl: "https://example.test/pr/3" };
          },
        },
        (message) => logs.push(message)
      );
      expect(result).toBe("idle");
      expect(calls).toBe(0);
      expect(logs.some((line) => line === "quota cooldown")).toBe(true);
    } finally {
      await close();
    }
  });

  test("concurrent writers cannot lose a failure count or shorten a longer cooldown", async () => {
    const { store2, close } = secondStore();
    try {
      await Promise.all([
        store.recordRoleInfra("engine"),
        store2.recordRoleInfra("engine"),
        store.recordRoleInfra("engine"),
        store2.recordRoleInfra("engine"),
      ]);
      const gate = await store.checkRoleGate("engine");
      expect(gate.infraConsecutive).toBe(4);
      expect(gate.infraBlocked).toBe(true);

      const now = Date.now();
      await Promise.all([
        store.recordRoleQuotaWait("worker", now + 60_000),
        store2.recordRoleQuotaWait("worker", now + 3_600_000),
        store.recordRoleQuotaWait("worker", now + 1_000),
      ]);
      const quotaGate = await store.checkRoleGate("worker", new Date(now));
      expect(quotaGate.quotaUntil).toBe(now + 3_600_000);
      expect(quotaGate.quotaBlocked).toBe(true);
      expect(await store2.mayStartWork("worker", new Date(now))).toBe(false);
    } finally {
      await close();
    }
  });

  test("failing engine infra ticks share the ledger breaker across processes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-gate-infra-ticks-"));
    const { store2, close } = secondStore();
    try {
      await store.enqueue(makeJob());
      const extras = {
        gitRunner: frozenGitRunner(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async () => {
          throw new EngineFailedError("EACCES: spawn /bin/sh", true);
        },
      };
      for (let i = 0; i < 3; i++) {
        await processEngineTick(
          store,
          makeConfig({ workdir: workspace, home: workspace }),
          pgReviewApi(),
          "engine-1",
          extras,
          () => undefined
        );
        // Clear the infra backoff so the next failure can lease again.
        await sql.unsafe(`UPDATE review_jobs SET leased_until = NULL WHERE state = 'queued'`);
      }
      expect((await store2.checkRoleGate("engine")).infraBlocked).toBe(true);
      expect(await store2.mayStartWork("engine")).toBe(false);
    } finally {
      await close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("router reclaim moves an expired worker lease and publishes max-attempts to the forge", async () => {
    // Ordinary worker failures call expireLease, leaving state='leased' with
    // leased_by=NULL. Only reclaim moves such a row on.
    await store.enqueueIssue(makeIssueJob());
    const leased = await store.lease("worker-1", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(leased?.issueNumber).toBe(12);
    expect(await store.expireLease(leased!.id, "worker-1")).toBe(true);
    const stuck = await store.get(leased!.id);
    expect(stuck?.state).toBe("leased");
    expect(stuck?.leasedBy).toBeNull();

    // With no worker running this row blocks every job for the issue, dedupes
    // new enqueues as repo-mutex, and is not counted as queued.
    expect(await store.lease("worker-2", 60_000, new Date(), WORKER_JOB_KINDS)).toBeUndefined();
    expect(await store.enqueueIssue(makeIssueJob({ delivery: "d-retry" }))).toEqual({
      key: "implement:kirmanak/demo#12",
      queued: false,
    });
    expect(await countJobs(`state = 'queued'`)).toBe(0);

    const comments: string[] = [];
    const api = {
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      getIssue: async () => makeIssue(),
      getPR: async (_owner: string, _repo: string, index: number) => makePR({ number: index }),
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_owner: string, _repo: string, _index: number, body: string) => {
        comments.push(body);
        return makeComment({ body });
      },
      updateIssueComment: async (_owner: string, _repo: string, _id: number, body: string) => {
        comments.push(body);
        return makeComment({ body });
      },
    } as unknown as ReviewApi;

    // Only a router is running: its reclaim moves the failed worker row on.
    const first = await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    expect(first.requeued).toBe(1);
    expect((await store.get(leased!.id))?.state).toBe("queued");

    // A pod can now start the row.
    const picked = await store.lease("worker-2", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(picked?.id).toBe(leased!.id);
    expect(await store.expireLease(picked!.id, "worker-2")).toBe(true);

    // At the attempt cap the router publishes the failure to the forge so the
    // sticky moves off "Jumi is implementing this issue".
    const second = await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    expect(second.published).toBe(1);
    const done = await store.get(leased!.id);
    expect(done?.state).toBe("failed");
    expect(done?.error).toBe(WORKER_MAX_ATTEMPTS_REASON);
    expect(comments.some((body) => body.includes("max attempts exceeded"))).toBe(true);
  });

  test("reclaim resolves a cancel-requested lease as cancelled instead of requeueing", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(
      makeIssueJob({
        issueNumber: 13,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/13",
        delivery: "d13",
      })
    );
    const flagged = await store.lease("worker-1", 1, new Date(1_000), WORKER_JOB_KINDS);
    const plain = await store.lease("worker-2", 1, new Date(1_000), WORKER_JOB_KINDS);
    expect(flagged?.issueNumber).toBe(12);
    expect(plain?.issueNumber).toBe(13);
    expect(await store.cancelQueuedForIssue("kirmanak", "demo", 12)).toBe(0);
    expect(await store.isCancelRequested(flagged!.id)).toBe(true);
    expect(await store.isCancelRequested(plain!.id)).toBe(false);

    const result = await store.reclaimExpired(5, new Date(5_000), 1_000, WORKER_JOB_KINDS);
    expect(result.requeued.map((row) => row.id)).toEqual([plain!.id]);
    expect(result.publish).toHaveLength(0);

    const settled = await store.get(flagged!.id);
    expect(settled?.state).toBe("cancelled");
    expect(settled?.cancelRequested).toBe(false);
    expect(settled?.leasedBy).toBeNull();
    expect(settled?.attempt).toBe(0);

    const requeued = await store.get(plain!.id);
    expect(requeued?.state).toBe("queued");
    expect(requeued?.attempt).toBe(1);

    // Cancelled work is never requeued.
    const again = await store.reclaimExpired(5, new Date(6_000), 1_000, WORKER_JOB_KINDS);
    expect(again.requeued).toHaveLength(0);
    expect(again.publish).toHaveLength(0);
    expect((await store.get(flagged!.id))?.state).toBe("cancelled");
  });

  test("cancel racing lease acquisition ends cancelled or flagged, never runnable", async () => {
    await store.enqueueIssue(makeIssueJob());
    const [leased, cancelled] = await Promise.all([
      store.lease("worker-1", 60_000, new Date(), WORKER_JOB_KINDS),
      store.cancelQueuedForIssue("kirmanak", "demo", 12),
    ]);
    const ids = asRows<{ id: unknown }>(await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`));
    expect(ids).toHaveLength(1);
    const final = await store.get(Number(ids[0]?.id));
    if (leased) {
      expect(cancelled).toBe(0);
      expect(final?.state).toBe("leased");
      expect(final?.cancelRequested).toBe(true);
    } else {
      expect(cancelled).toBe(1);
      expect(final?.state).toBe("cancelled");
      expect(final?.cancelRequested).toBe(false);
    }
    expect(final?.state).not.toBe("queued");
  });

  test("cancel racing reclaim back to queued ends cancelled", async () => {
    await store.enqueueIssue(makeIssueJob());
    const leased = await store.lease("worker-1", 1, new Date(1_000), WORKER_JOB_KINDS);
    expect(await store.expireLease(leased!.id, "worker-1", new Date(2_000))).toBe(true);

    // Cancel first, then reclaim: the flagged row settles to cancelled.
    expect(await store.cancelQueuedForIssue("kirmanak", "demo", 12)).toBe(0);
    const first = await store.reclaimExpired(5, new Date(5_000), 1_000, WORKER_JOB_KINDS);
    expect(first.requeued).toHaveLength(0);
    expect(first.publish).toHaveLength(0);
    expect((await store.get(leased!.id))?.state).toBe("cancelled");

    // Reclaim first, then cancel: the requeued row is cancelled by the late cancel.
    await sql.unsafe(`TRUNCATE review_jobs RESTART IDENTITY`);
    await store.enqueueIssue(makeIssueJob({ delivery: "d-second" }));
    const relased = await store.lease("worker-1", 1, new Date(1_000), WORKER_JOB_KINDS);
    expect(await store.expireLease(relased!.id, "worker-1", new Date(2_000))).toBe(true);
    const reclaimed = await store.reclaimExpired(5, new Date(5_000), 1_000, WORKER_JOB_KINDS);
    expect(reclaimed.requeued).toHaveLength(1);
    expect(await store.cancelQueuedForIssue("kirmanak", "demo", 12)).toBe(1);
    const final = await store.get(relased!.id);
    expect(final?.state).toBe("cancelled");
    expect(final?.cancelRequested).toBe(false);

    // Fully concurrent: either order lands cancelled, never runnable.
    // If cancel holds the row lock first, reclaim's `FOR UPDATE SKIP LOCKED`
    // scan skips it and the row stays leased with the cancel flag set; the
    // next reclaim tick settles it to cancelled. Settle here so the test
    // asserts the converged state instead of the race winner.
    await sql.unsafe(`TRUNCATE review_jobs RESTART IDENTITY`);
    await store.enqueueIssue(makeIssueJob({ delivery: "d-third" }));
    const raced = await store.lease("worker-1", 1, new Date(1_000), WORKER_JOB_KINDS);
    expect(await store.expireLease(raced!.id, "worker-1", new Date(2_000))).toBe(true);
    await Promise.all([
      store.reclaimExpired(5, new Date(5_000), 1_000, WORKER_JOB_KINDS),
      store.cancelQueuedForIssue("kirmanak", "demo", 12),
    ]);
    let ended = await store.get(raced!.id);
    expect(ended?.state).not.toBe("queued");
    if (ended?.state === "leased" && ended?.cancelRequested) {
      await store.reclaimExpired(5, new Date(5_000), 1_000, WORKER_JOB_KINDS);
      ended = await store.get(raced!.id);
    }
    expect(ended?.state).toBe("cancelled");
    expect(ended?.cancelRequested).toBe(false);
  });

  test("cancel for one issue leaves another issue's rows alone", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(
      makeIssueJob({
        issueNumber: 13,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/13",
        delivery: "d13",
      })
    );
    const leased = await store.lease("worker-1", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(leased?.issueNumber).toBe(12);
    expect(await store.cancelQueuedForIssue("kirmanak", "demo", 12)).toBe(0);
    expect((await store.get(leased!.id))?.cancelRequested).toBe(true);
    const other = asRows<{ state: unknown; cancel_requested: unknown }>(
      await sql.unsafe(`SELECT state, cancel_requested FROM review_jobs WHERE issue_number = 13`)
    );
    expect(other).toHaveLength(1);
    expect(String(other[0]?.state)).toBe("queued");
    expect(other[0]?.cancel_requested).toBe(false);
    const second = await store.lease("worker-2", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(second?.issueNumber).toBe(13);
  });

  test("concurrent migrators do not conflict and job-mode checks instead of migrating", async () => {
    await Promise.all([store.migrate(), store.migrate(), store.migrate(), store.migrate(), store.migrate()]);
    expect(await indexExists("review_jobs_leased_worker_issue")).toBe(true);
    expect(await indexExists("review_jobs_delivery_job_key")).toBe(true);

    // A migrated schema passes the job-mode check and opens without migrating.
    await assertLedgerSchema(sql);
    const jobStore = await openPgReviewJobStoreForJob(pgDatabaseUrl, { max: 2 });
    try {
      expect(await jobStore.enqueueIssue(makeIssueJob({ delivery: "d-job-open" }))).toEqual({
        key: "implement:kirmanak/demo#12",
        queued: true,
      });
    } finally {
      await jobStore.close();
    }

    // A schema older than the router fails clearly instead of migrating.
    await sql.unsafe(`ALTER TABLE review_jobs DROP COLUMN IF EXISTS rewake_requested`);
    await expect(assertLedgerSchema(sql)).rejects.toThrow("router must migrate");
    await expect(openPgReviewJobStoreForJob(pgDatabaseUrl, { max: 2 })).rejects.toThrow("router must migrate");

    // Restore the column for the next test; beforeEach re-migrates anyway.
    await store.migrate();
    await assertLedgerSchema(sql);
  });

  test("retried delivery repeats only effects that did not settle", async () => {
    const delivery = "ci-delivery-1";
    const jobA = makeIssueJob({
      delivery,
      mode: "follow-up",
      issueNumber: 81,
      prNumber: 102,
      headSha: "sha-a",
      trigger: { event: "workflow_job", sender: "bot", workflowJobId: 11 },
    });
    const jobB = makeIssueJob({
      delivery,
      mode: "follow-up",
      issueNumber: 82,
      prNumber: 103,
      headSha: "sha-b",
      trigger: { event: "workflow_job", sender: "bot", workflowJobId: 12 },
    });
    expect((await store.enqueueIssue(jobA)).queued).toBe(true);
    const leased = await store.lease("worker-1", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(leased?.prNumber).toBe(102);
    await store.markPublished(leased!.id, leased!.leasedBy!, { state: "succeeded" });
    // Same delivery + same effect is settled even though the key is no longer
    // in flight; the sibling with the same delivery still enqueues.
    expect((await store.enqueueIssue(jobA)).queued).toBe(false);
    expect((await store.enqueueIssue(jobB)).queued).toBe(true);
    expect(await countJobs(`delivery = 'ci-delivery-1'`)).toBe(2);
    // A new delivery for the same PR stays eligible.
    expect((await store.enqueueIssue({ ...jobA, delivery: "ci-delivery-2" })).queued).toBe(true);
  });

  test("job-mode schema check covers the review handover pending table", async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(`DROP TABLE IF EXISTS review_handover_pending`);
    await expect(assertLedgerSchema(sql)).rejects.toThrow("review_handover_pending");

    // The router migration recreates the table; the job-mode check passes.
    await store.migrate();
    await assertLedgerSchema(sql);
  });
});
