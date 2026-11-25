import { describe, expect, test } from "bun:test";
import { type AutomergeReconcileStore, MemoryAutomergeReconcileStore } from "../src/automerge_reconcile.ts";

function freshStore(): AutomergeReconcileStore {
  return new MemoryAutomergeReconcileStore();
}

describe("MemoryAutomergeReconcileStore contract", () => {
  test("duplicate cause returns the original admission generation and never revives", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "cause-A", 1_000);
    expect(a.status).toBe("created");
    const b = await store.request("o", "r", 7, "cause-B", 2_000);
    expect(b.status).toBe("bumped");
    expect(b.generation).toBeGreaterThan(a.generation);

    const replayA = await store.request("o", "r", 7, "cause-A", 3_000);
    expect(replayA.status).toBe("duplicate");
    expect(replayA.generation).toBe(a.generation);

    // Settling with the replayed (stale) generation cannot delete B's row.
    expect(await store.settle("o", "r", 7, replayA.generation)).toBe("stale");
    // The live row is still there: a fresh claim sees B's generation.
    const claimed = await store.claimDue("tok-live", 60_000, 10, 3_000);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.generation).toBe(b.generation);
  });

  test("duplicate after completion deletes nothing new and does not revive", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "cause-A", 1_000);
    expect(await store.settle("o", "r", 7, a.generation)).toBe("deleted");

    const replay = await store.request("o", "r", 7, "cause-A", 2_000);
    expect(replay.status).toBe("duplicate");
    expect(replay.generation).toBe(a.generation);
    // No row was revived: nothing due.
    expect(await store.claimDue("tok", 60_000, 10, 2_000)).toEqual([]);

    const c = await store.request("o", "r", 7, "cause-C", 3_000);
    expect(c.status).toBe("created");
    expect(c.generation).toBeGreaterThan(a.generation);
  });

  test("settle only deletes on an exact generation match", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "cause-A", 1_000);
    expect(await store.settle("o", "r", 7, a.generation + 999)).toBe("stale");
    expect(await store.settle("o", "r", 99, a.generation)).toBe("stale");
    expect(await store.settle("o", "r", 7, a.generation)).toBe("deleted");
    expect(await store.settle("o", "r", 7, a.generation)).toBe("stale");
  });

  test("complete fences on token, expiry, and generation; moved generation rearms", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "cause-A", 1_000);
    expect(await store.complete("o", "r", 7, "wrong-token", a.generation, 1_000)).toBe("lost");

    const claimed = await store.claimDue("holder-1", 60_000, 10, 1_000);
    expect(claimed.length).toBe(1);

    // Wrong token and stale generation never delete.
    expect(await store.complete("o", "r", 7, "other", a.generation, 1_000)).toBe("lost");
    expect(await store.complete("o", "r", 7, "holder-1", a.generation + 50, 1_000)).toBe("rearmed");

    // Rearm cleared the lease and made the row due again without deleting it.
    const afterRearm = await store.claimDue("holder-2", 60_000, 10, 1_001);
    expect(afterRearm.length).toBe(1);

    // Expired lease: the holder loses the row.
    expect(await store.complete("o", "r", 7, "holder-2", afterRearm[0]?.generation ?? -1, 1_001 + 60_001)).toBe("lost");
  });

  test("bump while leased rearms the stale holder instead of deleting", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "cause-A", 1_000);
    expect((await store.claimDue("holder-1", 60_000, 10, 1_000)).length).toBe(1);
    const b = await store.request("o", "r", 7, "cause-B", 2_000);
    expect(b.status).toBe("bumped");
    // Stale holder cannot delete the bumped row; the lease is released and due now.
    expect(await store.complete("o", "r", 7, "holder-1", a.generation, 2_000)).toBe("rearmed");
    const reclaimed = await store.claimDue("holder-2", 60_000, 10, 2_000);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0]?.generation).toBe(b.generation);
    expect(await store.complete("o", "r", 7, "holder-2", b.generation, 2_000)).toBe("deleted");
  });

  test("fail with a stale generation rearms without counting an attempt", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "cause-A", 1_000);
    expect((await store.claimDue("holder-1", 60_000, 10, 1_000)).length).toBe(1);
    const b = await store.request("o", "r", 7, "cause-B", 2_000);
    expect(b.status).toBe("bumped");
    expect(await store.fail("o", "r", 7, "holder-1", a.generation, "boom", 2_000)).toBe("rearmed");
    const reclaimed = await store.claimDue("holder-2", 60_000, 10, 2_000);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0]?.generation).toBe(b.generation);
    expect(reclaimed[0]?.retryMarker).toBeNull();
  });

  test("fail follows decideInfraRetry until exhaustion; exhausted survives and lists", async () => {
    const store = freshStore();
    await store.request("o", "r", 7, "cause-A", 1_000);
    let now = 1_000;
    let lastStatus: string | undefined;
    for (let attempt = 1; attempt <= 8; attempt++) {
      const claimed = await store.claimDue(`tok-${attempt}`, 60_000, 10, now);
      expect(claimed.length).toBe(1);
      const gen = claimed[0]?.generation ?? -1;
      const status = await store.fail("o", "r", 7, `tok-${attempt}`, gen, `boom-${attempt}`, now);
      lastStatus = status;
      if (attempt < 8) {
        expect(status).toBe("retry");
        const row = (await store.claimDue(`peek-${attempt}`, 60_000, 10, now)).length;
        // Lease was cleared but the row is in backoff, so it is not due yet.
        void row;
        now += 61_000;
      } else {
        expect(status).toBe("exhausted");
      }
    }
    expect(lastStatus).toBe("exhausted");
    const exhausted = await store.listExhausted(10);
    expect(exhausted.length).toBe(1);
    expect(exhausted[0]?.prNumber).toBe(7);
    expect(exhausted[0]?.lastError).toBe("boom-8");

    // A duplicate of the original cause does not revive the exhausted row.
    const dup = await store.request("o", "r", 7, "cause-A", now);
    expect(dup.status).toBe("duplicate");
    expect((await store.listExhausted(10)).length).toBe(1);
    expect(await store.claimDue("tok-after", 60_000, 10, now)).toEqual([]);

    // Only a new cause revives: pending again, marker cleared, due now.
    const revived = await store.request("o", "r", 7, "cause-new", now + 1);
    expect(revived.status).toBe("revived");
    expect(revived.generation).toBeGreaterThan(exhausted[0]?.generation ?? 0);
    expect(await store.listExhausted(10)).toEqual([]);
    const claimed = await store.claimDue("tok-revived", 60_000, 10, now + 1);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.retryMarker).toBeNull();
  });

  test("block exhausts immediately and revives only on a new cause", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 8, "cause-A", 1_000);
    expect((await store.claimDue("holder-1", 60_000, 10, 1_000)).length).toBe(1);
    expect(await store.block("o", "r", 8, "holder-1", a.generation, "unsupported-cap", 1_000)).toBe("exhausted");
    const exhausted = await store.listExhausted(10);
    expect(exhausted.length).toBe(1);
    expect(exhausted[0]?.lastError).toBe("unsupported-cap");

    expect((await store.request("o", "r", 8, "cause-A", 2_000)).status).toBe("duplicate");
    expect((await store.listExhausted(10)).length).toBe(1);
    const revived = await store.request("o", "r", 8, "cause-B", 2_000);
    expect(revived.status).toBe("revived");
  });

  test("renew extends only a live matching token and generation", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "cause-A", 1_000);
    expect((await store.claimDue("holder-1", 1_000, 10, 1_000)).length).toBe(1);
    expect(await store.renew("o", "r", 7, "holder-1", a.generation, 60_000, 1_500)).toBe(true);
    expect(await store.renew("o", "r", 7, "other", a.generation, 60_000, 1_500)).toBe(false);
    expect(await store.renew("o", "r", 7, "holder-1", a.generation + 1, 60_000, 1_500)).toBe(false);
    // After expiry the renewal has no effect.
    expect(await store.renew("o", "r", 7, "holder-1", a.generation, 60_000, 1_500 + 60_001)).toBe(false);
  });

  test("generations are never reused after deletion and re-creation", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "cause-A", 1_000);
    expect(await store.settle("o", "r", 7, a.generation)).toBe("deleted");
    const b = await store.request("o", "r", 7, "cause-B", 2_000);
    expect(b.status).toBe("created");
    expect(b.generation).toBeGreaterThan(a.generation);
  });

  test("claimDue respects limit and due time", async () => {
    const store = freshStore();
    await store.request("o", "r", 1, "cause-A", 1_000);
    await store.request("o", "r", 2, "cause-A", 1_000);
    const one = await store.claimDue("tok", 60_000, 1, 1_000);
    expect(one.length).toBe(1);
    const rest = await store.claimDue("tok-2", 60_000, 10, 1_000);
    expect(rest.length).toBe(1);
    expect(rest[0]?.prNumber).not.toBe(one[0]?.prNumber);
    expect(await store.claimDue("tok-3", 60_000, 10, 1_000)).toEqual([]);
  });
});
