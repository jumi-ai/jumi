import { describe, expect, test } from "bun:test";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { MemorySkipLatchStore } from "../src/skip_latches.ts";
import { handleIssueCancel, processWorkerTick } from "../src/worker.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeIssueJob, makeWorkerConfig } from "./fixtures.ts";

const key = { owner: "kirmanak", repo: "demo", issueNumber: 12 };

function workerApi() {
  return makeIssueApi({
    findStickyIssueComment: async () => ({ id: 9 }) as never,
  });
}

function silent() {
  const messages: string[] = [];
  return { messages, logger: (message: string) => void messages.push(message) };
}

describe("worker latch fence integration", () => {
  test("stale runner write after reclaim is rejected; old run ends without publish, new run's write lands", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const config = makeWorkerConfig();
    const { logger } = silent();

    const started = Promise.withResolvers<void>();
    const releaseOld = Promise.withResolvers<void>();
    let oldJobId = 0;
    const oldTick = processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-old",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          oldJobId = Number((opts as { jobId?: string }).jobId ?? 0);
          started.resolve();
          await releaseOld.promise;
          // Stale write: must reject and leave the new run's latch alone.
          let rejected: unknown;
          try {
            await opts.skipLatches!.put(key, { followup: { round: 99 } });
          } catch (err) {
            rejected = err;
          }
          expect(rejected).toBeDefined();
          return { status: "pr", prNumber: 99, htmlUrl: "https://example.test/pr/99" };
        },
      },
      logger
    );
    await started.promise;
    expect(oldJobId).toBeGreaterThan(0);

    // Reclaim the still-running row and re-lease it on a new token.
    expect(await store.expireLease(oldJobId, "worker-old")).toBe(true);
    const reclaimed = await store.reclaimExpired(5, new Date(Date.now() + 10_000), 1_000, WORKER_JOB_KINDS);
    expect(reclaimed.requeued).toHaveLength(1);

    const next = await processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-new",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          await opts.skipLatches!.put(key, { followup: { round: 2 } });
          return { status: "no-changes" };
        },
      },
      logger
    );
    expect(next).toBe("processed");

    releaseOld.resolve();
    expect(await oldTick).toBe("processed");

    // New run's write landed; the stale write did not overwrite it.
    expect((await store.skipLatches.get(key)).followup).toEqual({ round: 2 });
    // No follow-on conflict job was enqueued by either run.
    expect(store.rows).toHaveLength(1);
    const final = await store.get(oldJobId);
    expect(final?.state).toBe("skipped");
    expect(final?.resultReason).toBe("no-changes");
  });

  test("mid-run clear with the lease held settles skipped/latch generation changed", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const config = makeWorkerConfig();
    const { logger } = silent();

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const tick = processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-1",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          started.resolve();
          await release.promise;
          await opts.skipLatches!.put(key, { followup: { round: 1 } });
          return { status: "pr", prNumber: 1, htmlUrl: "https://example.test/pr/1" };
        },
      },
      logger
    );
    await started.promise;
    await store.clearIssueSkipLatch(key.owner, key.repo, key.issueNumber);
    release.resolve();
    expect(await tick).toBe("processed");

    const row = store.rows[0];
    expect(row?.state).toBe("skipped");
    expect(row?.resultReason).toBe("latch generation changed");
    expect((await store.skipLatches.get(key)).followup).toEqual({});
  });

  test("swallowed latch write failure still settles skipped and aborts the job", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const config = makeWorkerConfig();
    const { logger } = silent();

    const result = await processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-1",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          await store.clearIssueSkipLatch(key.owner, key.repo, key.issueNumber);
          // Swallowed by the runner: the recorded flag stays authoritative.
          await opts.skipLatches!.put(key, { followup: { round: 1 } }).catch(() => undefined);
          expect(opts.abortSignal!.aborted).toBe(true);
          return { status: "pr", prNumber: 1, htmlUrl: "https://example.test/pr/1" };
        },
      },
      logger
    );
    expect(result).toBe("processed");
    const row = store.rows[0];
    expect(row?.state).toBe("skipped");
    expect(row?.resultReason).toBe("latch generation changed");
    expect((await store.skipLatches.get(key)).followup).toEqual({});
  });

  test("cancel mid-run plus a rejected runner write still ends cancelled; kick/cancel clears stay unfenced", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const config = makeWorkerConfig({ home: `/tmp/jumi-fence-cancel-${Date.now()}` });
    const { logger } = silent();

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const aborts = new Map<string, AbortController>();
    const tick = processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-1",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          started.resolve();
          await release.promise;
          await opts.skipLatches!.put(key, { followup: { round: 1 } }).catch(() => undefined);
          return { status: "pr", prNumber: 1, htmlUrl: "https://example.test/pr/1" };
        },
      },
      logger,
      aborts
    );
    await started.promise;

    // Operator kick/cancel latch clears use the unfenced store and succeed
    // while the wrapped run is active.
    await handleIssueCancel(config, workerApi(), key.owner, key.repo, key.issueNumber, undefined, store, aborts);
    release.resolve();
    expect(await tick).toBe("processed");

    const row = store.rows[0];
    expect(row?.state).toBe("cancelled");
    // The cancel-time clear bumped the generation; the runner's write stayed rejected.
    expect((await store.skipLatches.get(key)).followup).toEqual({});
  });

  test("shutdown releases an owned row instead of settling it", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const config = makeWorkerConfig();
    const { logger } = silent();

    const shutdown = new AbortController();
    const started = Promise.withResolvers<void>();
    const tick = processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-1",
      {
        heartbeatMs: 60_000,
        abortSignal: shutdown.signal,
        implement: async (opts) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (opts.abortSignal!.aborted) {
              resolve();
              return;
            }
            opts.abortSignal!.addEventListener("abort", () => resolve(), { once: true });
          });
          return { status: "cancelled" };
        },
      },
      logger
    );
    await started.promise;
    shutdown.abort();
    expect(await tick).toBe("processed");
    const row = store.rows[0];
    expect(row?.state).toBe("queued");
    expect(row?.leasedBy).toBeNull();
  });

  test("missing/nonnumeric legacy payload generation normalizes to 0 and a healthy write succeeds", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    // Legacy row without a numeric generation must fence as generation 0.
    const queued = store.rows[0];
    if (!queued) throw new Error("expected a queued row");
    (queued.payload as unknown as Record<string, unknown>).generation = "legacy" as unknown as number;
    const config = makeWorkerConfig();
    const { logger } = silent();

    const result = await processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-1",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          await opts.skipLatches!.put(key, { followup: { round: 1 } });
          return { status: "no-changes" };
        },
      },
      logger
    );
    expect(result).toBe("processed");
    expect((await store.skipLatches.get(key)).followup).toEqual({ round: 1 });
    expect(store.rows[0]?.state).toBe("skipped");
    expect(store.rows[0]?.resultReason).toBe("no-changes");
  });

  test("swallowed LatchFenceUnsupported settles failed and never success", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    // A standalone (non-ledger) latch store cannot honor fences: every fenced
    // write throws LatchFenceUnsupported.
    (store as unknown as { skipLatches: MemorySkipLatchStore }).skipLatches = new MemorySkipLatchStore();
    const config = makeWorkerConfig();
    const { logger } = silent();

    const result = await processWorkerTick(
      store,
      config,
      workerApi(),
      "worker-1",
      {
        heartbeatMs: 60_000,
        implement: async (opts) => {
          await opts.skipLatches!.put(key, { followup: { round: 1 } }).catch(() => undefined);
          expect(opts.abortSignal!.aborted).toBe(true);
          return { status: "pr", prNumber: 1, htmlUrl: "https://example.test/pr/1" };
        },
      },
      logger
    );
    expect(result).toBe("processed");
    const row = store.rows[0];
    expect(row?.state).toBe("failed");
    expect(row?.resultReason).toBe("latch fence unsupported");
  });
});
