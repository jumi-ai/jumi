import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { IssueApi } from "../src/gitea_issues.ts";
import { PgReviewJobStore, workerJobKey } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import type { IssueJob } from "../src/types.ts";
import { processWorkerTick } from "../src/worker.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssueJob, makeWorkerConfig } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

function workerApi(overrides: Partial<IssueApi> = {}): IssueApi {
  return makeIssueApi({
    findStickyIssueComment: async () => ({ id: 9 }),
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
    updateIssueComment: async (_owner, _repo, _id, body) => makeComment({ body }),
    ...overrides,
  });
}

function wakePayload(job: IssueJob, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issueNumber: job.issueNumber,
    title: job.title,
    body: job.body,
    htmlUrl: job.htmlUrl,
    issueUpdatedAt: job.issueUpdatedAt,
    defaultBranch: job.defaultBranch,
    cloneUrl: job.cloneUrl,
    action: job.action,
    trigger: job.trigger,
    generation: 0,
    ...overrides,
  };
}

const OWNER = "kirmanak";
const REPO = "demo";
const ISSUE = 12;
const BOARD_KEY = `${OWNER}/${REPO}#${ISSUE}`;

function followUpJob(headSha: string, extra: Partial<IssueJob> = {}): IssueJob {
  return makeIssueJob({
    mode: "follow-up",
    prNumber: 127,
    headSha,
    trigger: { event: "review-failure", sender: "jumi" },
    ...extra,
  });
}

describePg("worker wake settlement against real postgres", () => {
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
    await sql.unsafe(
      `TRUNCATE review_jobs, follow_up_wake_causes, router_sits, issue_skip_latches, role_gates, jumi_run_usage, strict_refresh_slots RESTART IDENTITY`
    );
    await store.migrate();
  });

  test("head-changed skip parks the pending cause, queues nothing, keeps the new-head job", async () => {
    const jobA = followUpJob("oldsha");
    await store.enqueueIssue(jobA);
    const keyA = workerJobKey(jobA);
    const logs: string[] = [];
    const result = await processWorkerTick(
      store,
      makeWorkerConfig(),
      workerApi(),
      "worker-1",
      {
        followUp: async () => {
          expect(
            await store.wakeCauses.record({
              jobKey: keyA,
              owner: OWNER,
              repo: REPO,
              issueNumber: ISSUE,
              prNumber: 127,
              headSha: "oldsha",
              delivery: "wake-1",
              payload: wakePayload(jobA, { trigger: { event: "issue_comment", sender: "alice" } }),
            })
          ).toBe("recorded");
          return { status: "skipped", reason: "PR head changed from oldsha to newsha" };
        },
      },
      (message) => logs.push(message)
    );
    expect(result).toBe("processed");
    const oldRow = (await sql.unsafe(`SELECT state FROM review_jobs WHERE head_sha = 'oldsha'`)) as Array<{
      state: unknown;
    }>;
    expect(oldRow.map((row) => String(row.state))).toEqual(["skipped"]);
    expect(await store.wakeCauses.countPending(keyA)).toBe(0);
    const parked = await store.wakeCauses.list(keyA, "parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.parkReason).toBe("head-changed");
    const queuedOld = (await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM review_jobs WHERE job_key = $1 AND state = 'queued'`,
      [keyA]
    )) as Array<{ n: unknown }>;
    expect(Number(queuedOld[0]?.n ?? -1)).toBe(0);
    const successor = (await sql.unsafe(`SELECT kind, state FROM review_jobs WHERE head_sha = 'newsha'`)) as Array<{
      kind: unknown;
      state: unknown;
    }>;
    expect(successor.map((row) => `${String(row.kind)}/${String(row.state)}`)).toEqual(["follow-up/queued"]);
    expect(logs.some((line) => line.includes(`parked 1 pending wake(s) for ${BOARD_KEY}: head-changed`))).toBe(true);
  });

  test("promoted pass survives a store reopen between settle and lease and runs once", async () => {
    const jobA = followUpJob("headsha");
    await store.enqueueIssue(jobA);
    const keyA = workerJobKey(jobA);
    const pendingTrigger = { event: "issue_comment", sender: "alice" };
    const logs: string[] = [];
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      workerApi(),
      "worker-1",
      {
        followUp: async () => {
          await store.wakeCauses.record({
            jobKey: keyA,
            owner: OWNER,
            repo: REPO,
            issueNumber: ISSUE,
            prNumber: 127,
            headSha: "headsha",
            delivery: "wake-1",
            payload: wakePayload(jobA, { trigger: pendingTrigger }),
          });
          return { status: "no-changes" };
        },
      },
      (message) => logs.push(message)
    );
    expect(logs.some((line) => line.includes(`promoted 1 pending wake(s) for ${BOARD_KEY}`))).toBe(true);
    expect(await store.sits.get(OWNER, REPO, ISSUE)).toBeUndefined();

    // Restart: a fresh pool and store over the same database, as a redeploy
    // between A's settle and the promoted row's lease.
    const reopenedSql = openTestSqlClient(pgDatabaseUrl);
    try {
      const reopened = new PgReviewJobStore(reopenedSql);
      await reopened.migrate();
      const seen: IssueJob[] = [];
      let runs = 0;
      await processWorkerTick(reopened, makeWorkerConfig(), workerApi(), "worker-2", {
        followUp: async (opts) => {
          runs++;
          seen.push(opts.job);
          return { status: "no-changes" };
        },
      });
      expect(runs).toBe(1);
      expect(seen[0]?.trigger).toEqual(pendingTrigger);
      const cause = await reopened.wakeCauses.get(keyA, "delivery:wake-1");
      expect(cause?.state).toBe("promoted");
      expect(cause?.promotedJobId).not.toBeNull();
      // Exactly once: nothing left to lease afterwards.
      expect(
        await processWorkerTick(reopened, makeWorkerConfig(), workerApi(), "worker-2", {
          followUp: async () => {
            throw new Error("promoted pass must run exactly once");
          },
        })
      ).toBe("idle");
    } finally {
      await reopenedSql.close?.();
    }
  });

  test("unassign during the pass parks the cause cancelled and runs no further pass", async () => {
    const jobA = followUpJob("headsha");
    await store.enqueueIssue(jobA);
    const keyA = workerJobKey(jobA);
    let runs = 0;
    const result = await processWorkerTick(store, makeWorkerConfig(), workerApi(), "worker-1", {
      followUp: async () => {
        runs++;
        expect(
          await store.wakeCauses.record({
            jobKey: keyA,
            owner: OWNER,
            repo: REPO,
            issueNumber: ISSUE,
            prNumber: 127,
            headSha: "headsha",
            delivery: "wake-1",
            payload: wakePayload(jobA),
          })
        ).toBe("recorded");
        await store.cancelQueuedForIssue(OWNER, REPO, ISSUE);
        return { status: "no-changes" };
      },
    });
    expect(result).toBe("processed");
    expect(runs).toBe(1);
    const states = (await sql.unsafe(`SELECT state FROM review_jobs WHERE job_key = $1`, [keyA])) as Array<{
      state: unknown;
    }>;
    expect(states.map((row) => String(row.state))).toEqual(["cancelled"]);
    expect(await store.wakeCauses.countPending(keyA)).toBe(0);
    const parked = await store.wakeCauses.list(keyA, "parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.parkReason).toBe("cancelled");
    expect(
      await processWorkerTick(store, makeWorkerConfig(), workerApi(), "worker-1", {
        followUp: async () => {
          throw new Error("parked cause must not run");
        },
      })
    ).toBe("idle");
  });
});
