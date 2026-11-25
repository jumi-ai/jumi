import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PgReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { processWorkerTick } from "../src/worker.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeIssueJob, makeWorkerConfig } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

const key = { owner: "kirmanak", repo: "demo", issueNumber: 12 };

function workerApi() {
  return makeIssueApi({
    findStickyIssueComment: async () => ({ id: 9 }) as never,
  });
}

describePg("worker latch fence against real postgres", () => {
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
    await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, jumi_run_usage RESTART IDENTITY`);
    await sql.unsafe(`TRUNCATE role_gates`);
    await store.migrate();
  });

  test("stale runner write after reclaim is rejected; old run ends without publish, new run's write lands", async () => {
    await store.enqueueIssue(makeIssueJob());
    const config = makeWorkerConfig();
    const logs: string[] = [];
    const logger = (message: string) => void logs.push(message);

    const started = Promise.withResolvers<void>();
    const releaseOld = Promise.withResolvers<void>();
    let oldJobId = 0;
    const oldTick = processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-old",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          oldJobId = Number((opts as { jobId?: string }).jobId ?? 0);
          started.resolve();
          await releaseOld.promise;
          let rejected: unknown;
          try {
            await opts.skipLatches!.put(key, { followup: { round: 99 } });
          } catch (err) {
            rejected = err;
          }
          expect(rejected).toBeDefined();
          return { status: "pr", prNumber: 99, htmlUrl: "https://example.test/pr/99" };
        },
      },
      logger
    );
    await started.promise;
    expect(oldJobId).toBeGreaterThan(0);

    expect(await store.expireLease(oldJobId, "worker-old")).toBe(true);
    const reclaimed = await store.reclaimExpired(5, new Date(Date.now() + 10_000), 1_000, WORKER_JOB_KINDS);
    expect(reclaimed.requeued).toHaveLength(1);

    const next = await processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-new",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          await opts.skipLatches!.put(key, { followup: { round: 2 } });
          return { status: "no-changes" };
        },
      },
      logger
    );
    expect(next).toBe("processed");

    releaseOld.resolve();
    expect(await oldTick).toBe("processed");

    expect((await store.skipLatches.get(key)).followup).toEqual({ round: 2 });
    const rows = (await sql.unsafe(`SELECT COUNT(*)::int AS n FROM review_jobs`)) as Array<{ n: number }>;
    expect(Number(rows[0]?.n)).toBe(1);
    const final = await store.get(oldJobId);
    expect(final?.state).toBe("skipped");
    expect(final?.resultReason).toBe("no-changes");
  });

  test("mid-run clear with the lease held settles skipped/latch generation changed", async () => {
    await store.enqueueIssue(makeIssueJob());
    const config = makeWorkerConfig();
    const logs: string[] = [];
    const logger = (message: string) => void logs.push(message);

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const tick = processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-1",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          started.resolve();
          await release.promise;
          await opts.skipLatches!.put(key, { followup: { round: 1 } }).catch(() => undefined);
          return { status: "pr", prNumber: 1, htmlUrl: "https://example.test/pr/1" };
        },
      },
      logger
    );
    await started.promise;
    await store.clearIssueSkipLatch(key.owner, key.repo, key.issueNumber);
    release.resolve();
    expect(await tick).toBe("processed");

    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const final = await store.get(Number(ids[0]?.id));
    expect(final?.state).toBe("skipped");
    expect(final?.resultReason).toBe("latch generation changed");
    expect((await store.skipLatches.get(key)).followup).toEqual({});
  });
});
