import { describe, expect, test } from "bun:test";
import { isReclaimOwner, MemoryReviewJobStore } from "../src/review_jobs.ts";
import { isWorkerTickOwner, mintWorkerTickToken, runPersistentWorkerTick } from "../src/worker.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssueJob, makeWorkerConfig } from "./fixtures.ts";

function testApi() {
  return makeIssueApi({
    findStickyIssueComment: async () => ({ id: 9 }),
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
    updateIssueComment: async (_owner, _repo, id, body) => makeComment({ body, id }),
  });
}

describe("persistent worker lease tokens", () => {
  test("two ticks from one worker lease the same requeued row with different tokens", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const workerId = "worker-test-1";
    const config = makeWorkerConfig();
    const api = testApi();

    const first = await runPersistentWorkerTick({
      store,
      config,
      api: api as never,
      workerId,
      extras: {
        implement: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(first.result).toBe("processed");
    const rowId = store.rows[0]?.id;
    expect(rowId).toBeGreaterThan(0);
    const token1 = first.leasedBy;
    expect(token1.startsWith(`${workerId}:`)).toBe(true);
    expect(isReclaimOwner(token1)).toBe(false);
    expect(store.rows[0]?.attempt).toBe(0);

    let observedToken2 = "";
    let staleHeartbeat = true;
    let stalePublishThrew = false;
    const second = await runPersistentWorkerTick({
      store,
      config,
      api: api as never,
      workerId,
      extras: {
        implement: async () => {
          const current = await store.get(rowId as number);
          observedToken2 = current?.leasedBy ?? "";
          staleHeartbeat = await store.heartbeat(rowId as number, token1, config.leaseMs);
          try {
            await store.markPublished(rowId as number, token1, { state: "succeeded" });
          } catch {
            stalePublishThrew = true;
          }
          return { status: "pr" as const, prNumber: 1, htmlUrl: "https://example.test/pr/1" };
        },
      },
    });
    expect(second.result).toBe("processed");
    expect(observedToken2).not.toBe("");
    expect(observedToken2).not.toBe(token1);
    expect(observedToken2.startsWith(`${workerId}:`)).toBe(true);
    expect(second.leasedBy).toBe(observedToken2);
    expect(isReclaimOwner(second.leasedBy)).toBe(false);
    expect(staleHeartbeat).toBe(false);
    expect(stalePublishThrew).toBe(true);
    expect(store.rows[0]?.attempt).toBe(1);
    expect(store.rows[0]?.state).toBe("succeeded");
  });

  test("isWorkerTickOwner matches legacy id and per-tick tokens", () => {
    const workerId = "worker-host-123-uuid";
    expect(isWorkerTickOwner(workerId, workerId)).toBe(true);
    expect(isWorkerTickOwner(`${workerId}:550e8400-e29b-41d4-a716-446655440000`, workerId)).toBe(true);
    expect(isWorkerTickOwner("worker-other:550e8400-e29b-41d4-a716-446655440000", workerId)).toBe(false);
    expect(isWorkerTickOwner(null, workerId)).toBe(false);
    const token = mintWorkerTickToken(workerId);
    expect(token.startsWith(`${workerId}:`)).toBe(true);
    expect(isReclaimOwner(token)).toBe(false);
    expect(isWorkerTickOwner(token, workerId)).toBe(true);
  });
});
