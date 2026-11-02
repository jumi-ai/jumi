import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "../src/claim.ts";
import { runOneShotJob } from "../src/job.ts";
import { createBunSqlClient, PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { handleIssueCancel } from "../src/worker.ts";
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

const databaseUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
const describePg = databaseUrl ? describe : describe.skip;

function makeReviewApi() {
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
    createCommitStatus: async (_o: string, _r: string, _s: string, status: { state: string }) => status,
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  } as never;
}

function frozenGitRunner() {
  return async (args: string[]) => {
    if (args[0] === "rev-parse") return "headsha";
    if (args[0] === "status") return "?? JUMI_REVIEW.md";
    if (args[0] === "ls-files") return "";
    if (args[0] === "checkout") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

describePg("one-shot jobs against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = createBunSqlClient(databaseUrl);
    store = new PgReviewJobStore(sql);
    await store.migrate();
  });

  beforeEach(async () => {
    if (!databaseUrl) return;
    await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, jumi_run_usage RESTART IDENTITY`);
    await sql.unsafe(`TRUNCATE role_gates`);
    await store.migrate();
  });

  test("runs a review row and a worker row end to end", async () => {
    // Review row.
    await store.enqueue(makeJob());
    const reviewIds = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const reviewId = Number(reviewIds[0]?.id);
    const reviewWorkspace = await mkdtemp(join(tmpdir(), "jumi-job-pg-review-"));
    try {
      const result = await runOneShotJob({
        store,
        jobId: reviewId,
        engineConfig: makeConfig({
          workdir: reviewWorkspace,
          home: reviewWorkspace,
          opencodeWellKnownUrl: "disabled",
        }),
        workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
        api: makeReviewApi() as never,
        engineExtras: {
          gitRunner: frozenGitRunner() as never,
          workspacePreparer: async () => undefined,
          openCodeRunner: async () => ({ status: "skipped" as never, reason: "no unhandled feedback" }) as never,
        },
      });
      // Skipped still reaches the ledger (exit 0).
      expect(result.exitCode).toBe(0);
      const row = await store.get(reviewId);
      expect(["skipped", "succeeded", "failed"].includes(row?.state ?? "")).toBe(true);
    } finally {
      await rm(reviewWorkspace, { recursive: true, force: true });
    }

    // Worker row.
    await store.enqueueIssue(makeIssueJob());
    const workerIds = (await sql.unsafe(`SELECT id FROM review_jobs WHERE kind <> 'review' ORDER BY id`)) as Array<{
      id: unknown;
    }>;
    const workerId = Number(workerIds[0]?.id);
    const result = await runOneShotJob({
      store,
      jobId: workerId,
      engineConfig: makeConfig({ opencodeWellKnownUrl: "disabled" }),
      workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
      api: {
        getRepo: async () => makeRepo(),
        getCollaboratorPermission: async () => ({ permission: "write" }),
        getIssue: async () => makeIssue(),
      } as never,
      workerExtras: {
        implement: async () => ({ status: "pr" as const, prNumber: 3, htmlUrl: "https://example.test/pr/3" }),
      },
    });
    expect(result.exitCode).toBe(0);
    const workerRow = await store.get(workerId);
    expect(workerRow?.state).toBe("succeeded");

    // Per-run data carries the one-shot clone timing.
    const usage = (await sql.unsafe(`SELECT clone_seconds FROM jumi_run_usage`)) as Array<{ clone_seconds: unknown }>;
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.some((r) => r.clone_seconds != null)).toBe(true);
  });

  test("unassign while the one-shot job runs stops the child and settles cancelled", async () => {
    await store.enqueueIssue(makeIssueJob());
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const jobId = Number(ids[0]?.id);

    const comments: string[] = [];
    const api = {
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      getIssue: async () => makeIssue(),
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_o: string, _r: string, _n: number, body: string) => {
        comments.push(body);
        return makeComment({ body });
      },
      updateIssueComment: async (_o: string, _r: string, _id: number, body: string) => {
        comments.push(body);
        return makeComment({ body });
      },
      ...emptyCiMethods(),
    } as never;

    let implementRan = false;
    let childPid = 0;
    let childStopped = false;
    const runPromise = runOneShotJob({
      store,
      jobId,
      engineConfig: makeConfig({ opencodeWellKnownUrl: "disabled" }),
      workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
      api,
      leasedBy: "one-shot-cancel-test",
      workerExtras: {
        heartbeatMs: 50,
        implement: async (opts: { abortSignal?: AbortSignal; onPid?: (pid: number) => void }) => {
          implementRan = true;
          const child = Bun.spawn(["sleep", "30"]);
          childPid = child.pid;
          opts.onPid?.(child.pid);
          await new Promise<void>((resolve) => {
            if (opts.abortSignal?.aborted) {
              resolve();
              return;
            }
            opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          try {
            child.kill();
          } catch {
            // Already exited.
          }
          await child.exited;
          childStopped = true;
          return { status: "cancelled" as const };
        },
      },
    });

    // Wait until the job pod holds the lease.
    for (let i = 0; i < 250; i++) {
      const row = await store.get(jobId);
      if (row?.state === "leased") break;
      await Bun.sleep(20);
    }
    expect((await store.get(jobId))?.state).toBe("leased");

    const home = await mkdtemp(join(tmpdir(), "jumi-job-pg-cancel-"));
    const cancelAt = Date.now();
    try {
      // The router path (another replica: no in-process abort, ledger only).
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12, undefined, store);
      // The leased row stays leased with the mark; only the running job settles it.
      expect((await store.get(jobId))?.state).toBe("leased");
      const result = await runPromise;
      const settleMs = Date.now() - cancelAt;
      expect(result.exitCode).toBe(0);
      expect(implementRan).toBe(true);
      expect(childPid).toBeGreaterThan(0);
      expect(childStopped).toBe(true);
      expect(isPidAlive(childPid)).toBe(false);
      expect(comments.some((body) => body.includes("stopped"))).toBe(true);
      expect((await store.get(jobId))?.state).toBe("cancelled");
      // Prompt heartbeat poll (50ms), not lease expiry (leaseMs is hours).
      expect(settleMs).toBeLessThan(10_000);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("unassign while the row is still queued starts no job", async () => {
    await store.enqueueIssue(makeIssueJob());
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const jobId = Number(ids[0]?.id);

    const comments: string[] = [];
    const api = {
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      getIssue: async () => makeIssue(),
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_o: string, _r: string, _n: number, body: string) => {
        comments.push(body);
        return makeComment({ body });
      },
      updateIssueComment: async (_o: string, _r: string, _id: number, body: string) => {
        comments.push(body);
        return makeComment({ body });
      },
      ...emptyCiMethods(),
    } as never;

    const home = await mkdtemp(join(tmpdir(), "jumi-job-pg-cancel-queued-"));
    try {
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12, undefined, store);
      expect((await store.get(jobId))?.state).toBe("cancelled");

      let ran = false;
      const result = await runOneShotJob({
        store,
        jobId,
        engineConfig: makeConfig({ opencodeWellKnownUrl: "disabled" }),
        workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
        api,
        workerExtras: {
          implement: async () => {
            ran = true;
            return { status: "pr" as const, prNumber: 3, htmlUrl: "https://example.test/pr/3" };
          },
        },
      });
      // The cancelled row cannot be leased, so no job starts.
      expect(result.exitCode).toBe(0);
      expect(ran).toBe(false);
      expect((await store.get(jobId))?.state).toBe("cancelled");
      expect(comments.some((body) => body.includes("stopped"))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
