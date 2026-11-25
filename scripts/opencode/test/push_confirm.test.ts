import { describe, expect, test } from "bun:test";
import { MemoryPushConfirmStore, type PushConfirmStore } from "../src/push_confirm.ts";

function freshStore(): PushConfirmStore {
  return new MemoryPushConfirmStore();
}

describe("MemoryPushConfirmStore contract", () => {
  test("duplicate cause returns the original generation and never revives", async () => {
    const store = freshStore();
    const a = await store.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    expect(a.status).toBe("created");
    const b = await store.request("o", "r", 7, "sha-b", "branch", "sha-b", 2_000);
    expect(b.status).toBe("bumped");
    expect(b.generation).toBeGreaterThan(a.generation);

    const replayA = await store.request("o", "r", 7, "sha-a", "branch", "sha-a", 3_000);
    expect(replayA.status).toBe("duplicate");
    expect(replayA.generation).toBe(a.generation);

    expect(await store.settle("o", "r", 7, replayA.generation)).toBe("stale");
    const claimed = await store.claimDue("tok-live", 60_000, 10, 3_000 + 180_000 + 1);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.generation).toBe(b.generation);
    expect(claimed[0]?.expectedSha).toBe("sha-b");
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
});
