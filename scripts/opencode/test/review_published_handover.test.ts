import { describe, expect, test } from "bun:test";
import { CI_PENDING_REASON } from "../src/ci.ts";
import { recordPendingHandover } from "../src/review_handover_pending.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { makeJob } from "./fixtures.ts";

type PendingMap = Map<number, { reviewJobId: number; publishedStatus: string; createdAt: number }>;

function pendingsOf(store: MemoryReviewJobStore): PendingMap {
  const holder = store as unknown as { __reviewHandoverPending?: PendingMap };
  return holder.__reviewHandoverPending ?? new Map();
}

async function leaseReview(store: MemoryReviewJobStore, jobSeed = {}) {
  await store.enqueue(makeJob(jobSeed));
  const leased = await store.lease("engine-1", 60_000);
  if (!leased) throw new Error("lease failed");
  return leased;
}

describe("markPublishedWithHandover (memory)", () => {
  test("success settles terminal and records the pending together; repeat throws without duplicating", async () => {
    const store = new MemoryReviewJobStore();
    const leased = await leaseReview(store);
    const res = await store.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "posted");
    expect(res).toEqual({ cancelled: false, promoted: 0, parked: 0 });
    expect((await store.get(leased.id))?.state).toBe("succeeded");
    expect(pendingsOf(store).get(leased.id)?.publishedStatus).toBe("posted");

    await expect(
      store.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "posted")
    ).rejects.toThrow("cannot mark published");
    expect(pendingsOf(store).size).toBe(1);
  });

  test("updated verdict records the pending; first status wins on a second obligation", async () => {
    const store = new MemoryReviewJobStore();
    const leased = await leaseReview(store);
    await store.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "updated");
    expect(pendingsOf(store).get(leased.id)?.publishedStatus).toBe("updated");
  });

  test("non-pending statuses insert nothing", async () => {
    const store = new MemoryReviewJobStore();
    const leased = await leaseReview(store);
    await store.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "skipped");
    expect((await store.get(leased.id))?.state).toBe("succeeded");
    expect(pendingsOf(store).size).toBe(0);

    const store2 = new MemoryReviewJobStore();
    const leased2 = await leaseReview(store2);
    await store2.markPublishedWithHandover(leased2.id, "engine-1", { state: "skipped", reason: "draft" }, "skipped");
    expect((await store2.get(leased2.id))?.state).toBe("skipped");
    expect(pendingsOf(store2).size).toBe(0);
  });

  test("cancel wins and removes an existing pending row", async () => {
    const store = new MemoryReviewJobStore();
    const leased = await leaseReview(store);
    await recordPendingHandover(store, leased.id, "posted");
    expect(pendingsOf(store).size).toBe(1);
    expect(await store.cancelQueuedForPull("kirmanak", "demo", 7)).toBe(0);
    const res = await store.markPublishedWithHandover(leased.id, "engine-1", { state: "succeeded" }, "posted");
    expect(res).toEqual({ cancelled: true, promoted: 0, parked: 0 });
    expect((await store.get(leased.id))?.state).toBe("cancelled");
    expect(pendingsOf(store).size).toBe(0);
  });

  test("CI-wait rewake requeues and inserts nothing", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeJob();
    await store.enqueue(job);
    const leased = await store.lease("engine-1", 60_000);
    if (!leased) throw new Error("lease failed");
    await store.enqueue(job);
    const res = await store.markPublishedWithHandover(
      leased.id,
      "engine-1",
      { state: "skipped", reason: CI_PENDING_REASON },
      "skipped"
    );
    expect(res).toEqual({ cancelled: false, promoted: 0, parked: 0 });
    const row = await store.get(leased.id);
    expect(row?.state).toBe("queued");
    expect(pendingsOf(store).size).toBe(0);
  });

  test("stale owner throws and inserts nothing", async () => {
    const store = new MemoryReviewJobStore();
    const leased = await leaseReview(store);
    await expect(
      store.markPublishedWithHandover(leased.id, "engine-2", { state: "succeeded" }, "posted")
    ).rejects.toThrow("cannot mark published");
    expect((await store.get(leased.id))?.state).toBe("leased");
    expect(pendingsOf(store).size).toBe(0);
  });
});
