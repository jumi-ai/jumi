import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFollowUpLatch } from "../src/followup.ts";
import { enqueueFollowUpFromReview, TOO_MANY_FOLLOWUP_ROUNDS } from "../src/handover.ts";
import type { ReviewApi } from "../src/review.ts";
import { PgReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { stuckMarker } from "../src/stuck.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeComment, makeIssueJob, makeJob, makePR, makeUser } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

function handoverApi(overrides: Parameters<typeof makeReviewApi>[0] = {}): ReviewApi & { comments: string[] } {
  const comments: string[] = [];
  const fake = makeReviewApi({
    getPR: async () =>
      makePR({
        body: "Fixes #12",
        user: makeUser({ login: "jumi" }),
        head: { ...makePR().head, ref: "jumi/issue-12-fix", sha: "headsha" },
      }),
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, commentId, body) => {
      comments.push(body);
      return makeComment({ id: commentId, body });
    },
    ...overrides,
  });
  return Object.assign(fake, { comments });
}

async function seedSucceededFollowUps(store: PgReviewJobStore, count: number, issueNumber = 12): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.enqueueIssue(
      makeIssueJob({
        mode: "follow-up",
        issueNumber,
        prNumber: 7,
        headSha: `sha${i}`,
        delivery: `follow-${i}`,
      })
    );
    const leased = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    if (!leased) throw new Error("lease failed");
    await store.markPublished(leased.id, leased.leasedBy!, { state: "succeeded" });
  }
}

async function seedFollowUpRound(store: PgReviewJobStore, round: number, issueNumber = 12): Promise<void> {
  await store.skipLatches.put(
    { owner: "kirmanak", repo: "demo", issueNumber },
    {
      followup: {
        prNumber: 7,
        round,
        lastHeadSha: "headsha",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: new Date().toISOString(),
      },
    }
  );
}

describePg("handover follow-up latch round cap against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = openTestSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await sql.unsafe(
      `DROP TABLE IF EXISTS review_jobs, follow_up_wake_causes, issue_skip_latches, jumi_run_usage, role_gates`
    );
    await store.migrate();
  });

  afterAll(async () => {
    await (sql as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(
      `TRUNCATE review_jobs, follow_up_wake_causes, issue_skip_latches, jumi_run_usage RESTART IDENTITY`
    );
    await store.migrate();
  });

  test("succeeded merge-only rows without latch rounds still enqueue", async () => {
    await seedSucceededFollowUps(store, 3);
    await seedFollowUpRound(store, 0);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    if (!review) throw new Error("lease failed");
    const api = handoverApi();
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(api.comments).toEqual([]);
  });

  test("latch round at the cap skips with stuck and no succeeded rows", async () => {
    await seedFollowUpRound(store, 3);
    expect(await store.countSucceeded("follow-up", "kirmanak", "demo", 12)).toBe(0);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    if (!review) throw new Error("lease failed");
    const api = handoverApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(api.comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${TOO_MANY_FOLLOWUP_ROUNDS}`]);
    expect(logs).toEqual(["persist-insert skipped: round cap"]);
  });

  test("clearIssueSkipLatch resets a stale latch cap", async () => {
    await seedFollowUpRound(store, 3);
    expect(
      (await readFollowUpLatch(store.skipLatches, { owner: "kirmanak", repo: "demo", issueNumber: 12 })).round
    ).toBe(3);
    await store.clearIssueSkipLatch("kirmanak", "demo", 12);
    expect(
      (await readFollowUpLatch(store.skipLatches, { owner: "kirmanak", repo: "demo", issueNumber: 12 })).round
    ).toBe(0);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    if (!review) throw new Error("lease failed");
    const api = handoverApi();
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(api.comments).toEqual([]);
  });
});
