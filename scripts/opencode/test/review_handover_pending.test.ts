import { describe, expect, test } from "bun:test";
import { pickupPolicyForForge } from "../src/github_webhook.ts";
import { enqueueFollowUpFromReview } from "../src/handover.ts";
import type { ReviewApi } from "../src/review.ts";
import { clearPendingHandover, recordPendingHandover, resumePendingHandoffs } from "../src/review_handover_pending.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeConfig, makeJob, makePR, makeUser } from "./fixtures.ts";

function handoverApi(overrides: Parameters<typeof makeReviewApi>[0] = {}): ReviewApi & { reviews: number } {
  let reviews = 0;
  const fake = makeReviewApi({
    getPR: async () =>
      makePR({
        body: "Fixes #12",
        user: makeUser({ login: "jumi" }),
        head: { ...makePR().head, ref: "jumi/issue-12-fix", sha: "headsha" },
      }),
    createPullReview: async () => {
      reviews += 1;
      return { id: reviews };
    },
    ...overrides,
  });
  return Object.assign(fake, {
    get reviews() {
      return reviews;
    },
  });
}

async function seedTerminalReview(
  store: MemoryReviewJobStore,
  markdown: string,
  publishedStatus: "posted" | "updated" = "posted"
): Promise<number> {
  await store.enqueue(makeJob());
  const leased = await store.lease("engine-1", 60_000);
  if (!leased) throw new Error("lease failed");
  await store.saveResult(leased.id, "engine-1", { kind: "markdown", markdown });
  await recordPendingHandover(store, leased.id, publishedStatus);
  await store.markPublished(leased.id, "engine-1", { state: "succeeded", reason: undefined });
  return leased.id;
}

describe("review handover pending (memory)", () => {
  test("interrupt after verdict posts resumes exactly once with no extra review posts", async () => {
    const store = new MemoryReviewJobStore();
    const api = handoverApi();
    const config = makeConfig();
    const logs: string[] = [];
    const logger = (message: string) => logs.push(message);

    const reviewId = await seedTerminalReview(store, "blocking\n<!-- jumi-check: failure -->");
    expect(store.rows.find((row) => row.id === reviewId)?.state).toBe("succeeded");

    const beforeReviews = api.reviews;
    const first = await resumePendingHandoffs(store, api, config, logger);
    expect(first.completed).toBe(1);
    expect(first.failed).toBe(0);
    const followUps = store.rows.filter((row) => row.kind === "follow-up");
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.state).toBe("queued");
    expect(api.reviews).toBe(beforeReviews);

    const second = await resumePendingHandoffs(store, api, config, logger);
    expect(second.completed).toBe(0);
    expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(1);
    expect(api.reviews).toBe(beforeReviews);
  });

  test("a follow-up insert that fails once then succeeds yields one follow-up", async () => {
    const store = new MemoryReviewJobStore();
    const api = handoverApi();
    const config = makeConfig();
    const logger = () => undefined;

    await seedTerminalReview(store, "blocking\n<!-- jumi-check: failure -->");

    const realEnqueue = store.enqueueIssue.bind(store);
    let calls = 0;
    store.enqueueIssue = (async (job) => {
      calls += 1;
      if (calls === 1) throw new Error("ledger down");
      return realEnqueue(job);
    }) as typeof store.enqueueIssue;

    const failed = await resumePendingHandoffs(store, api, config, logger);
    expect(failed.failed).toBe(1);
    expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(0);

    store.enqueueIssue = realEnqueue;
    const ok = await resumePendingHandoffs(store, api, config, logger);
    expect(ok.completed).toBe(1);
    expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(1);

    const again = await resumePendingHandoffs(store, api, config, logger);
    expect(again.completed).toBe(0);
    expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(1);
  });

  test("no-follow-up cases produce none and clear the pending", async () => {
    const store = new MemoryReviewJobStore();
    const api = handoverApi();
    const config = makeConfig();
    const logger = () => undefined;

    await seedTerminalReview(store, "ok\n<!-- jumi-check: success -->");
    const first = await resumePendingHandoffs(store, api, config, logger);
    expect(first.completed).toBe(1);
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    const second = await resumePendingHandoffs(store, api, config, logger);
    expect(second.completed).toBe(0);
  });

  test("maintainer-only reviews keep the hold pending and sit waiting", async () => {
    const store = new MemoryReviewJobStore();
    const statuses: Array<{ state: string }> = [];
    const api = handoverApi({
      createCommitStatus: (async (_owner, _repo, _sha, status) => {
        statuses.push(status);
        return status;
      }) as ReviewApi["createCommitStatus"],
    });
    const config = makeConfig();
    const logger = () => undefined;
    const markdown = "src/foo.ts:12: ❓ maintainer: please file a follow-up issue?\n<!-- jumi-check: success -->";

    await seedTerminalReview(store, markdown);
    const resumed = await resumePendingHandoffs(store, api, config, logger);
    expect(resumed.completed).toBe(1);
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect((await store.sits.get("kirmanak", "demo", 7))?.reason).toBe("waiting-maintainer");
    expect(statuses).toHaveLength(0);
  });

  test("immediate handover clears the pending so resume is a no-op", async () => {
    const store = new MemoryReviewJobStore();
    const api = handoverApi();
    const config = makeConfig();
    const logger = () => undefined;

    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    if (!leased) throw new Error("lease failed");
    await store.saveResult(leased.id, "engine-1", {
      kind: "markdown",
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    await recordPendingHandover(store, leased.id, "posted");
    await store.markPublished(leased.id, "engine-1", { state: "succeeded" });

    const current = await store.get(leased.id);
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: current ?? leased,
      ...pickupPolicyForForge(config.forge, config.botUsername),
      published: { status: "posted" },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      maxFollowupRounds: config.maxFollowupRounds,
      blockingQuestionAuthors: config.blockingQuestionAuthors,
      logger,
    });
    expect(result?.queued).toBe(true);
    await clearPendingHandover(store, leased.id);

    const resumed = await resumePendingHandoffs(store, api, config, logger);
    expect(resumed.completed).toBe(0);
    expect(store.rows.filter((row) => row.kind === "follow-up")).toHaveLength(1);
  });

  test("skipped verdicts never record a pending handover", async () => {
    const store = new MemoryReviewJobStore();
    const api = handoverApi();
    const config = makeConfig();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    if (!leased) throw new Error("lease failed");
    await recordPendingHandover(store, leased.id, "skipped");
    await store.markPublished(leased.id, "engine-1", { state: "skipped", reason: "draft" });
    const resumed = await resumePendingHandoffs(store, api, config, () => undefined);
    expect(resumed.completed).toBe(0);
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
  });
});
