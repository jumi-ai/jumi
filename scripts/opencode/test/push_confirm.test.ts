import { describe, expect, test } from "bun:test";
import {
  discardPushObligationAfterFailedPush,
  MemoryPushConfirmStore,
  type PushConfirmStore,
  recordPushObligationBeforePush,
} from "../src/push_confirm.ts";

function freshStore(): PushConfirmStore {
  return new MemoryPushConfirmStore();
}

describe("MemoryPushConfirmStore contract", () => {
  test("superseded causes are pruned on bump so the cause table stays bounded", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "sha-a", "branch", "cause-a", 1_000);
    expect(a.status).toBe("created");
    const b = await store.request("o", "r", 7, "sha-b", "branch", "cause-b", 2_000);
    expect(b.status).toBe("bumped");
    expect(b.generation).toBeGreaterThan(a.generation);

    // The current cause still dedupes.
    const replayB = await store.request("o", "r", 7, "sha-b", "branch", "cause-b", 3_000);
    expect(replayB.status).toBe("duplicate");
    expect(replayB.generation).toBe(b.generation);

    // The superseded cause was pruned with its generation, so a replay
    // admits a new generation instead of returning a duplicate. Production
    // cause ids are fresh UUIDs per push and never replay, so this path
    // only matters for boundedness.
    const replayA = await store.request("o", "r", 7, "sha-a", "branch", "cause-a", 4_000);
    expect(replayA.status).toBe("bumped");
    expect(replayA.generation).toBeGreaterThan(b.generation);

    expect(await store.settle("o", "r", 7, a.generation)).toBe("stale");
    const claimed = await store.claimDue("tok-live", 60_000, 10, 4_000 + 180_000 + 1);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.generation).toBe(replayA.generation);
    expect(claimed[0]?.expectedSha).toBe("sha-a");
  });

  test("confirm deletes on matching head and reports mismatch otherwise", async () => {
    const store = freshStore();
    await store.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    expect(await store.confirm("o", "r", 7, "sha-other")).toBe("mismatch");
    expect(await store.confirm("o", "r", 7, "sha-a")).toBe("confirmed");
    expect(await store.confirm("o", "r", 7, "sha-a")).toBe("unknown");
  });

  test("fail retries with backoff then exhausts; exhausted lists", async () => {
    const store = freshStore();
    await store.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    let now = 1_000 + 180_000;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const claimed = await store.claimDue(`tok-${attempt}`, 60_000, 10, now);
      expect(claimed.length).toBe(1);
      const row = claimed[0]!;
      const status = await store.fail("o", "r", 7, `tok-${attempt}`, row.generation, "mismatch", now);
      if (attempt < 4) {
        expect(status).toBe("retry");
        now += 200_000;
      } else {
        expect(status).toBe("exhausted");
      }
    }
    const exhausted = await store.listExhausted(10);
    expect(exhausted.length).toBe(1);
    expect(exhausted[0]?.expectedSha).toBe("sha-a");
    expect(await store.dismiss("o", "r", 7)).toBe(true);
    expect(await store.listExhausted(10)).toEqual([]);
  });

  test("new push bumps the expected SHA and resets the budget", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    expect(a.status).toBe("created");
    const b = await store.request("o", "r", 7, "sha-b", "branch", "sha-b", 2_000);
    expect(b.status).toBe("bumped");
    expect(await store.confirm("o", "r", 7, "sha-a")).toBe("mismatch");
    expect(await store.confirm("o", "r", 7, "sha-b")).toBe("confirmed");
  });

  test("same-SHA re-record after settle admits a new obligation", async () => {
    const store = freshStore();
    const loop = {
      worktree: "/tmp",
      env: {},
      runConfiguredGit: async () => "sha-same\n",
    };
    const first = await recordPushObligationBeforePush(loop, store, "o", "r", 7, "branch");
    expect(first).toBeDefined();
    await discardPushObligationAfterFailedPush(store, "o", "r", 7, first);
    const second = await recordPushObligationBeforePush(loop, store, "o", "r", 7, "branch");
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(await store.confirm("o", "r", 7, "sha-same")).toBe("confirmed");
  });

  test("same-SHA re-record after confirm admits a new obligation", async () => {
    const store = freshStore();
    const loop = {
      worktree: "/tmp",
      env: {},
      runConfiguredGit: async () => "sha-same\n",
    };
    const first = await recordPushObligationBeforePush(loop, store, "o", "r", 7, "branch");
    expect(first).toBeDefined();
    expect(await store.confirm("o", "r", 7, "sha-same")).toBe("confirmed");
    const second = await recordPushObligationBeforePush(loop, store, "o", "r", 7, "branch");
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(await store.confirm("o", "r", 7, "sha-same")).toBe("confirmed");
  });
});
