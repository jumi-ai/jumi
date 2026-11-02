import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOneShotJob } from "../src/job.ts";
import { createBunSqlClient, PgReviewJobStore } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
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
});
