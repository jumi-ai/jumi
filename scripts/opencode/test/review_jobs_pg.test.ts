import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_LOOKUP_BACKOFF_MS, CI_LOOKUP_BUDGET_MS, CI_LOOKUP_FAILED_REASON, encodeCiLookupMarker } from "../src/ci.ts";
import { EngineFailedError } from "../src/engine.ts";
import { decideQuotaRetry, QUOTA_MESSAGE, QuotaWaitError } from "../src/quota.ts";
import type { ReviewApi } from "../src/review.ts";
import {
  createBunSqlClient,
  isUniqueViolation,
  MAX_ATTEMPTS_REASON,
  PgReviewJobStore,
  RECLAIM_LEASED_BY,
  WORKER_JOB_KINDS,
} from "../src/review_jobs.ts";
import { processEngineTick } from "../src/server.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { processWorkerTick } from "../src/worker.ts";
import type { GitRunner } from "../src/workspace.ts";
import {
  emptyCiMethods,
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

// The ledger invariants below live in Postgres, not in TypeScript: partial unique
// indexes, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT ... WHERE`, and the migration that
// requeues duplicate worker leases before the index that forbids them. A fake `unsafe()`
// that matches substrings cannot fail when one of those clauses is deleted, so this file
// runs the real `PgReviewJobStore` against a real database. It is skipped when
// JUMI_TEST_DATABASE_URL is unset so `bun test` stays green without Docker.
const databaseUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
const pgRequired = process.env.JUMI_TEST_PG_REQUIRED === "1";

// A misspelled URL in CI would turn the whole suite below into a silent no-op, so the CI
// job that owns the service container also sets JUMI_TEST_PG_REQUIRED=1.
test("postgres queue suite is not silently skipped where CI requires it", () => {
  expect(pgRequired && databaseUrl === "").toBe(false);
});

const describePg = databaseUrl ? describe : describe.skip;

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
  const api: ReviewApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => pr,
    getPRFiles: async () => [],
    getIssue: async () => {
      throw new Error("unused");
    },
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async () => makeComment(),
    updateIssueComment: async () => makeComment(),
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_owner, _repo, _sha, status) => {
      statuses.push({ state: status.state, description: status.description });
      return status;
    },
    listCommitStatuses: boom,
    listCheckRuns: boom,
    listActionJobs: boom,
    getActionJobLogs: async () => "",
  };
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
    const probe = createBunSqlClient(databaseUrl);
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
    if (!databaseUrl) return;
    sql = createBunSqlClient(databaseUrl);
    store = new PgReviewJobStore(sql);
    // Start from an empty database so `migrate()` is exercised from scratch, not against
    // whatever a previous run left behind.
    await sql.unsafe(`DROP TABLE IF EXISTS review_jobs, issue_skip_latches, role_gates`);
    await store.migrate();
  });

  beforeEach(async () => {
    if (!databaseUrl) return;
    await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches RESTART IDENTITY`);
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
    expect(second.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(second.publish[0]?.error).toBe(MAX_ATTEMPTS_REASON);
    expect(second.publish[0]?.resultReason).toBe(MAX_ATTEMPTS_REASON);

    const stored = await store.get(leased!.id);
    expect(stored?.state).toBe("leased");
    expect(stored?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(stored?.leasedUntil ?? 0).toBeGreaterThan(Date.now());
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

    expect(await store.enqueue(job)).toEqual({ key, queued: true });
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

  function makeReviewApi(): ReviewApi {
    return {
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      getPR: async () => makePR(),
      getPRFiles: async () => [makeFile()],
      getIssue: async () => makeIssue(),
      listIssueComments: async () => [],
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => makeComment(),
      updateIssueComment: async () => makeComment(),
      listPullReviewComments: async () => [],
      listPullReviews: async () => [],
      createPullReview: async () => ({ id: 1 }),
      submitPullReview: async () => ({ id: 1 }),
      resolvePullComment: async () => undefined,
      unresolvePullComment: async () => undefined,
      dismissPullReview: async () => ({ id: 1 }),
      createCommitStatus: async (_owner, _repo, _sha, status) => status,
      ...emptyCiMethods(),
      listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    };
  }

  function frozenGitRunner(): GitRunner {
    return async (args) => {
      if (args[0] === "rev-parse") return "headsha";
      if (args[0] === "status") return "?? JUMI_REVIEW.md";
      if (args[0] === "ls-files") return "";
      if (args[0] === "checkout") return "";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
  }

  function secondStore(): { sql2: SqlClient; store2: PgReviewJobStore; close: () => Promise<void> } {
    const sql2 = createBunSqlClient(databaseUrl);
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
        makeReviewApi(),
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
        makeReviewApi(),
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
        makeReviewApi(),
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
          makeReviewApi(),
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
});
