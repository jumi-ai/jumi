import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewApi } from "../src/review.ts";
import { resumePendingHandoffs } from "../src/review_handover_pending.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { processEngineTick, reclaimExpiredJobs } from "../src/server.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeConfig, makeJob, makePR, makeUser } from "./fixtures.ts";
import { frozenGit } from "./harness/git.ts";
import { withWorkspace } from "./harness/temp.ts";

const BLOCKING_MARKDOWN = "src/demo.ts:1: 🔴 blocking\n<!-- jumi-check: failure -->";

function atomicApi(overrides: Partial<ReviewApi> = {}): ReviewApi & {
  comments: string[];
  reviews: unknown[];
  statuses: Array<{ sha: string; state: string; description?: string }>;
} {
  const comments: string[] = [];
  const reviews: unknown[] = [];
  const statuses: Array<{ sha: string; state: string; description?: string }> = [];
  const fake = makeReviewApi({
    getPR: async () =>
      makePR({
        body: "Fixes #12",
        user: makeUser({ login: "jumi" }),
      }),
    getPRFiles: async () => [
      {
        filename: "src/demo.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
    createIssueComment: async (_o, _r, _i, body) => {
      comments.push(body);
      return { id: comments.length, body, user: makeUser({ login: "jumi" }) } as never;
    },
    createPullReview: async (_o, _r, _i, review) => {
      reviews.push(review);
      return { id: reviews.length };
    },
    createCommitStatus: async (_o, _r, sha, status) => {
      statuses.push({ sha, state: status.state, description: status.description });
      return status;
    },
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    ...overrides,
  });
  return Object.assign(fake, { comments, reviews, statuses });
}

function blockingRunner() {
  return async (opts: { workdir: string }) => {
    await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), BLOCKING_MARKDOWN);
    return { status: "ok" as const };
  };
}

describe("atomic review settle with handover (memory)", () => {
  test("engine-tick pending-insert fault never reports a terminal settle; recovery queues one follow-up", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = atomicApi();
      const config = makeConfig({ workdir: workspace, home: workspace });

      const original = store.markPublishedWithHandover.bind(store);
      store.markPublishedWithHandover = (async () => {
        throw new Error("pending insert down");
      }) as typeof store.markPublishedWithHandover;

      await processEngineTick(
        store,
        config,
        api,
        "engine-1",
        {
          gitRunner: frozenGit(),
          workspacePreparer: async () => undefined,
          verdictContract: "legacy" as const,
          openCodeRunner: blockingRunner(),
        },
        () => undefined
      );

      // No attempt falsely reports a successful terminal settle: the row stays
      // leased (expired for reclaim) with no follow-up and nothing to resume.
      expect(["queued", "leased"]).toContain(store.rows[0]?.state);
      expect(store.rows[0]?.state).not.toBe("succeeded");
      expect(store.rows[0]?.publishedAt).toBeNull();
      expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(0);
      const idleResume = await resumePendingHandoffs(store, api, config, () => undefined);
      expect(idleResume.completed).toBe(0);

      store.markPublishedWithHandover = original;
      await reclaimExpiredJobs(store, api, config, () => undefined);

      expect(store.rows[0]?.state).toBe("succeeded");
      const followUps = store.rows.filter((row) => row.kind === "follow-up");
      expect(followUps).toHaveLength(1);
      expect(followUps[0]?.state).toBe("queued");
      const again = await resumePendingHandoffs(store, api, config, () => undefined);
      expect(again.completed).toBe(0);
      expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(1);
    });
  });

  test("recovered-publication pending-insert fault never reports a terminal settle; recovery queues one follow-up", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    if (!leased) throw new Error("lease failed");
    await store.saveResult(leased.id, "dead-engine", {
      kind: "markdown",
      markdown: BLOCKING_MARKDOWN,
    });
    const api = atomicApi();
    const config = makeConfig();

    const original = store.markPublishedWithHandover.bind(store);
    store.markPublishedWithHandover = (async () => {
      throw new Error("pending insert down");
    }) as typeof store.markPublishedWithHandover;

    await reclaimExpiredJobs(store, api, config, () => undefined);
    expect(store.rows[0]?.state).toBe("leased");
    expect(store.rows[0]?.publishedAt).toBeNull();
    expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(0);

    store.markPublishedWithHandover = original;
    const beforeRecoverReviews = api.reviews.length;
    await reclaimExpiredJobs(store, api, config, () => undefined);
    expect(store.rows[0]?.state).toBe("succeeded");
    // Recovery republishes the persisted verdict once (forge post), then the
    // atomic settle records the obligation and queues exactly one follow-up.
    expect(api.reviews.length).toBeGreaterThanOrEqual(beforeRecoverReviews + 1);
    const followUps = store.rows.filter((row) => row.kind === "follow-up");
    expect(followUps).toHaveLength(1);
    const again = await resumePendingHandoffs(store, api, config, () => undefined);
    expect(again.completed).toBe(0);
    expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(1);
  });

  test("settle success plus handover failure resumes exactly once with no extra review post", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = atomicApi();
      const config = makeConfig({ workdir: workspace, home: workspace });

      const realEnqueue = store.enqueueIssue.bind(store);
      let handoverCalls = 0;
      store.enqueueIssue = (async (job: never) => {
        handoverCalls += 1;
        if (handoverCalls === 1) throw new Error("ledger down");
        return realEnqueue(job as never);
      }) as typeof store.enqueueIssue;

      await processEngineTick(
        store,
        config,
        api,
        "engine-1",
        {
          gitRunner: frozenGit(),
          workspacePreparer: async () => undefined,
          verdictContract: "legacy" as const,
          openCodeRunner: blockingRunner(),
        },
        () => undefined
      );

      // Settle succeeded so the review is terminal, but the follow-up is still
      // owed: no follow-up yet, and the verdict posted at least once.
      expect(store.rows[0]?.state).toBe("succeeded");
      expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(0);
      expect(api.reviews.length).toBeGreaterThan(0);
      const posted = api.reviews.length;

      store.enqueueIssue = realEnqueue;
      const resumed = await resumePendingHandoffs(store, api, config, () => undefined);
      expect(resumed.completed).toBe(1);
      expect(resumed.failed).toBe(0);
      expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(1);
      // No reviewer rerun and no extra forge review post while draining.
      expect(api.reviews).toHaveLength(posted);

      const again = await resumePendingHandoffs(store, api, config, () => undefined);
      expect(again.completed).toBe(0);
      expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(1);
      expect(api.reviews).toHaveLength(posted);
    });
  });
});
