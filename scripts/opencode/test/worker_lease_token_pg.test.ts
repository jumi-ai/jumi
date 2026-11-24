import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { isReclaimOwner, PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { isWorkerTickOwner, runPersistentWorkerTick } from "../src/worker.ts";
import { makeIssue, makeIssueJob, makeRepo, makeWorkerConfig } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

function pgWorkerApi() {
  return {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write" }),
    getIssue: async () => makeIssue(),
  } as never;
}

function waitUntilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describePg("persistent worker lease tokens on postgres", () => {
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

  test("reclaimExpired requeue uses a fresh token and rejects the stale one", async () => {
    const workerId = "worker-pg-1";
    const config = makeWorkerConfig();
    const api = pgWorkerApi();
    await store.enqueueIssue(makeIssueJob());
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const jobId = Number(ids[0]?.id);
    expect(jobId).toBeGreaterThan(0);

    const first = await runPersistentWorkerTick({
      store,
      config,
      api,
      workerId,
      extras: {
        implement: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(first.result).toBe("processed");
    const token1 = first.leasedBy;
    expect(token1.startsWith(`${workerId}:`)).toBe(true);
    expect(isReclaimOwner(token1)).toBe(false);
    expect(isWorkerTickOwner(token1, workerId)).toBe(true);
    expect((await store.get(jobId))?.attempt).toBe(0);

    let observedToken2 = "";
    let staleHeartbeat = true;
    let stalePublishThrew = false;
    const second = await runPersistentWorkerTick({
      store,
      config,
      api,
      workerId,
      extras: {
        implement: async () => {
          const current = await store.get(jobId);
          observedToken2 = current?.leasedBy ?? "";
          staleHeartbeat = await store.heartbeat(jobId, token1, config.leaseMs);
          try {
            await store.markPublished(jobId, token1, { state: "succeeded" });
          } catch {
            stalePublishThrew = true;
          }
          return { status: "pr" as const, prNumber: 1, htmlUrl: "https://example.test/pr/1" };
        },
      },
    });
    expect(second.result).toBe("processed");
    expect(observedToken2).not.toBe("");
    expect(observedToken2).not.toBe(token1);
    expect(observedToken2.startsWith(`${workerId}:`)).toBe(true);
    expect(second.leasedBy).toBe(observedToken2);
    expect(isReclaimOwner(second.leasedBy)).toBe(false);
    expect(staleHeartbeat).toBe(false);
    expect(stalePublishThrew).toBe(true);
    const final = await store.get(jobId);
    expect(final?.attempt).toBe(1);
    expect(final?.state).toBe("succeeded");
  });

  test("releaseLease requeue uses a fresh token and rejects the stale one", async () => {
    const workerId = "worker-pg-2";
    const config = makeWorkerConfig();
    const api = pgWorkerApi();
    await store.enqueueIssue(makeIssueJob());
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const jobId = Number(ids[0]?.id);
    expect(jobId).toBeGreaterThan(0);

    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    const firstPromise = runPersistentWorkerTick({
      store,
      config,
      api,
      workerId,
      extras: {
        abortSignal: abort.signal,
        implement: async (opts) => {
          started.resolve();
          await waitUntilAborted(opts.abortSignal);
          return { status: "cancelled" as const };
        },
      },
    });
    await started.promise;
    abort.abort();
    const first = await firstPromise;
    expect(first.result).toBe("processed");
    const token1 = first.leasedBy;
    expect(token1.startsWith(`${workerId}:`)).toBe(true);
    const afterRelease = await store.get(jobId);
    expect(afterRelease?.state).toBe("queued");
    expect(afterRelease?.attempt).toBe(0);

    let observedToken2 = "";
    let staleHeartbeat = true;
    let stalePublishThrew = false;
    const second = await runPersistentWorkerTick({
      store,
      config,
      api,
      workerId,
      extras: {
        implement: async () => {
          const current = await store.get(jobId);
          observedToken2 = current?.leasedBy ?? "";
          staleHeartbeat = await store.heartbeat(jobId, token1, config.leaseMs);
          try {
            await store.markPublished(jobId, token1, { state: "succeeded" });
          } catch {
            stalePublishThrew = true;
          }
          return { status: "pr" as const, prNumber: 1, htmlUrl: "https://example.test/pr/1" };
        },
      },
    });
    expect(second.result).toBe("processed");
    expect(observedToken2).not.toBe("");
    expect(observedToken2).not.toBe(token1);
    expect(observedToken2.startsWith(`${workerId}:`)).toBe(true);
    expect(staleHeartbeat).toBe(false);
    expect(stalePublishThrew).toBe(true);
    const final = await store.get(jobId);
    expect(final?.attempt).toBe(0);
    expect(final?.state).toBe("succeeded");
  });

  test("isLeased owner matches current worker tokens only", () => {
    const workerId = "worker-pg-3";
    expect(isWorkerTickOwner(workerId, workerId)).toBe(true);
    expect(isWorkerTickOwner(`${workerId}:550e8400-e29b-41d4-a716-446655440000`, workerId)).toBe(true);
    expect(isWorkerTickOwner("worker-other:550e8400-e29b-41d4-a716-446655440000", workerId)).toBe(false);
  });
});
