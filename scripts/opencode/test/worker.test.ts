import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimFilePath,
  conflictStatePath,
  isPidAlive,
  readClaim,
  skipLatchGenerationPath,
  stuckStatePath,
  writeClaim,
} from "../src/claim.ts";
import { writeConflictState } from "../src/conflict.ts";
import { EngineFailedError } from "../src/engine.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { implementIssue } from "../src/implement.ts";
import { encodeInfraMarker, INFRA_SPAWN_REASON, InfraCircuitBreaker } from "../src/infra.ts";
import {
  decideQuotaRetry,
  encodeQuotaWaitMarker,
  isQuotaWaitMarker,
  QUOTA_MESSAGE,
  QUOTA_STUCK_TEXT,
  QUOTA_WAIT_BUDGET_MS,
  QuotaCooldown,
  QuotaWaitError,
} from "../src/quota.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { isQuotaStuck, readStuckLatch, readStuckState, writeStuckState } from "../src/stuck.ts";
import { handleIssueCancel, processWorkerTick, reclaimExpiredWorkerJobs } from "../src/worker.ts";
import type { GitRunner } from "../src/workspace.ts";
import {
  emptyCiMethods,
  makeComment,
  makeIssue,
  makeIssueJob,
  makePR,
  makeRepo,
  makeWorkerConfig,
  stripGitConfigArgs,
} from "./fixtures.ts";

function waitUntilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function makeApi(overrides: Partial<IssueApi> = {}): IssueApi & { comments: string[] } {
  const comments: string[] = [];
  const defaults: IssueApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getIssue: async () => makeIssue(),
    getPR: async (_owner, _repo, index) => makePR({ number: index }),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
    closePullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "closed" }),
    updatePullRequestBody: async (_owner, _repo, index, body) => makePR({ number: index, body }),
    findStickyIssueComment: async () => ({ id: 9 }),
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    ...emptyCiMethods(),
  };
  return { ...defaults, ...overrides, comments };
}

describe("handleIssueCancel", () => {
  test("does not overwrite a leftover sticky after finished work", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const api = makeApi();
      const result = await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12);
      expect(result).toEqual({ key: "kirmanak/demo#12", cancelled: true });
      expect(api.comments).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("deletes a terminal claim without posting stopped", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const path = claimFilePath(home, "kirmanak", "demo", 12);
      await writeClaim(path, {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
        terminal: true,
      });
      const api = makeApi();
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12);
      expect(await readClaim(path)).toBeUndefined();
      expect(api.comments).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("posts stopped when a non-terminal claim exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "",
        terminal: false,
      });
      const api = makeApi();
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12);
      expect(api.comments.at(-1)).toContain("stopped");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("ledger cancel does not kill an unrelated claim pid", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const child = Bun.spawn(["sleep", "30"]);
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: child.pid,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
        terminal: false,
      });
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      await store.lease("worker-other", 60_000, undefined, WORKER_JOB_KINDS);
      const api = makeApi();
      await handleIssueCancel(
        makeWorkerConfig({ home }),
        api,
        "kirmanak",
        "demo",
        12,
        undefined,
        store,
        new Map(),
        new Map()
      );
      expect(store.rows[0]?.state).toBe("cancelled");
      expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({ generation: 1, skipReason: null });
      expect(isPidAlive(child.pid)).toBe(true);
      expect(api.comments.at(-1)).toContain("stopped");
      child.kill();
      await child.exited;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("clears the shared skip latch so another ordinal can recover", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-latch-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.setIssueSkipReason("kirmanak", "demo", 12, "stuck: cannot resolve conflicts");
      await store.enqueueIssue(makeIssueJob());
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 19,
        round: 3,
        lastHeadSha: "abc",
        lastBaseSha: "def",
        updatedAt: "2026-05-23T00:00:00Z",
      });
      await handleIssueCancel(makeWorkerConfig({ home }), makeApi(), "kirmanak", "demo", 12, undefined, store);
      expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({ generation: 1, skipReason: null });
      expect(await store.skipLatches.get({ owner: "kirmanak", repo: "demo", issueNumber: 12 })).toEqual({
        followup: {},
        conflict: {},
        ci: {},
        stuck: {},
      });
      expect(await readFile(conflictStatePath(home, "kirmanak", "demo", 12), "utf8").catch(() => "")).toBe("");
      await handleIssueCancel(makeWorkerConfig({ home }), makeApi(), "kirmanak", "demo", 12, undefined, store);
      expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({ generation: 2, skipReason: null });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("kills recorded pid and cancels leased rows", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const child = Bun.spawn(["sleep", "30"]);
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
      const key = "kirmanak/demo#12";
      const aborts = new Map<string, AbortController>([[key, new AbortController()]]);
      const pids = new Map<string, number>([[key, child.pid]]);
      const api = makeApi();
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12, undefined, store, aborts, pids);
      expect(aborts.get(key)?.signal.aborted).toBe(true);
      expect(store.rows[0]?.state).toBe("cancelled");
      expect(store.rows[0]?.leasedBy).toBeNull();
      await child.exited;
      expect(child.exitCode === 0).toBe(false);
      expect(api.comments.at(-1)).toContain("stopped");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("reclaimExpiredWorkerJobs", () => {
  test("marks max-attempt implement failed so the key can be re-enqueued", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeIssueJob();
    await store.enqueueIssue(job);
    const past = new Date(Date.now() - 10_000);
    await store.lease("worker-1", 1, past, WORKER_JOB_KINDS);
    expect(await reclaimExpiredWorkerJobs(store, 2, () => undefined)).toEqual({ requeued: 1, published: 0 });
    await store.lease("worker-1", 1, past, WORKER_JOB_KINDS);
    expect(await reclaimExpiredWorkerJobs(store, 2, () => undefined)).toEqual({ requeued: 0, published: 1 });
    expect(store.rows[0]?.state).toBe("failed");
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(await store.enqueueIssue(job)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
  });
});

describe("processWorkerTick", () => {
  test("follow-up and conflict use configured timeouts, not OPENCODE_TIMEOUT_MS", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 127, headSha: "headsha" }));
    let followUp: { timeoutMs?: number; maxFollowupRounds?: number; conflictTimeoutMs?: number } = {};
    await processWorkerTick(
      store,
      makeWorkerConfig({
        opencodeTimeoutMs: 14_400_000,
        followupTimeoutMs: 1_800_000,
        conflictTimeoutMs: 900_000,
        maxFollowupRounds: 5,
        maxConflictRounds: 7,
      }),
      makeApi(),
      "worker-1",
      {
        followUp: async (opts) => {
          followUp = {
            timeoutMs: opts.timeoutMs,
            maxFollowupRounds: opts.maxFollowupRounds,
            conflictTimeoutMs: opts.conflictTimeoutMs,
          };
          return { status: "no-changes" };
        },
      }
    );
    expect(followUp).toEqual({ timeoutMs: 1_800_000, maxFollowupRounds: 5, conflictTimeoutMs: 900_000 });

    await store.enqueueIssue(makeIssueJob());
    let implement: {
      timeoutMs?: number;
      followupTimeoutMs?: number;
      conflictTimeoutMs?: number;
      maxFollowupRounds?: number;
      maxConflictRounds?: number;
    } = {};
    await processWorkerTick(
      store,
      makeWorkerConfig({
        opencodeTimeoutMs: 14_400_000,
        followupTimeoutMs: 1_800_000,
        conflictTimeoutMs: 900_000,
        maxFollowupRounds: 5,
        maxConflictRounds: 7,
      }),
      makeApi(),
      "worker-1",
      {
        implement: async (opts) => {
          implement = {
            timeoutMs: opts.timeoutMs,
            followupTimeoutMs: opts.followupTimeoutMs,
            conflictTimeoutMs: opts.conflictTimeoutMs,
            maxFollowupRounds: opts.maxFollowupRounds,
            maxConflictRounds: opts.maxConflictRounds,
          };
          return { status: "no-changes" };
        },
      }
    );
    expect(implement).toEqual({
      timeoutMs: 14_400_000,
      followupTimeoutMs: 1_800_000,
      conflictTimeoutMs: 900_000,
      maxFollowupRounds: 5,
      maxConflictRounds: 7,
    });

    await store.enqueueIssue(makeIssueJob({ mode: "conflict", prNumber: 127, headSha: "headsha" }));
    let conflict: { timeoutMs?: number; maxConflictRounds?: number } = {};
    await processWorkerTick(
      store,
      makeWorkerConfig({
        opencodeTimeoutMs: 14_400_000,
        conflictTimeoutMs: 900_000,
        maxConflictRounds: 7,
      }),
      makeApi(),
      "worker-1",
      {
        conflict: async (opts) => {
          conflict = { timeoutMs: opts.timeoutMs, maxConflictRounds: opts.maxConflictRounds };
          return { status: "up-to-date" };
        },
      }
    );
    expect(conflict).toEqual({ timeoutMs: 900_000, maxConflictRounds: 7 });
  });

  test("two workers cannot double-lease the same job", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    let running = 0;
    let maxRunning = 0;
    const implement = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Bun.sleep(20);
      running--;
      return { status: "pr" as const, prNumber: 1, htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/1" };
    };
    const results = await Promise.all([
      processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-a", { implement }),
      processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-b", { implement }),
    ]);
    expect(maxRunning).toBe(1);
    expect(results.sort()).toEqual(["idle", "processed"]);
    expect(store.rows.filter((row) => row.kind === "implement")).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("succeeded");
  });

  test("does not lease conflict for an issue while follow-up is in flight", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 127, headSha: "headsha" }));
    await store.enqueueIssue(makeIssueJob({ mode: "conflict", prNumber: 127, headSha: "headsha" }));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const follow = processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-a", {
      followUp: async () => {
        started.resolve();
        await release.promise;
        return { status: "pushed", prNumber: 127, htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127" };
      },
      conflict: async () => {
        throw new Error("conflict should wait");
      },
    });
    await started.promise;
    expect(
      await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-b", {
        conflict: async () => {
          throw new Error("conflict should wait");
        },
      })
    ).toBe("idle");
    release.resolve();
    expect(await follow).toBe("processed");
    let conflictRan = 0;
    expect(
      await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-b", {
        conflict: async () => {
          conflictRan++;
          return { status: "up-to-date" };
        },
      })
    ).toBe("processed");
    expect(conflictRan).toBe(1);
  });

  test("follow-up skip because the PR head changed enqueues a successor for the new head", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(
      makeIssueJob({
        mode: "follow-up",
        prNumber: 127,
        headSha: "oldsha",
        trigger: { event: "review-failure", sender: "jumi" },
      })
    );
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
      followUp: async () => ({ status: "skipped", reason: "PR head changed from oldsha to newsha" }),
    });
    const successor = store.rows.find((row) => row.headSha === "newsha");
    expect(successor?.kind).toBe("follow-up");
    expect(successor?.state).toBe("queued");
    expect(successor?.payload?.trigger?.event).toBe("review-failure");
    expect(store.rows.find((row) => row.headSha === "oldsha")?.state).toBe("skipped");
  });

  test("two workers lease different jobs", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ issueNumber: 12 }));
    await store.enqueueIssue(
      makeIssueJob({ issueNumber: 13, htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/13" })
    );
    const seen: number[] = [];
    const implement = async (opts: { job: { issueNumber: number } }) => {
      seen.push(opts.job.issueNumber);
      return { status: "pr" as const, prNumber: opts.job.issueNumber, htmlUrl: "https://example" };
    };
    const results = await Promise.all([
      processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-a", { implement }),
      processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-b", { implement }),
    ]);
    expect(results).toEqual(["processed", "processed"]);
    expect(seen.sort((a, b) => a - b)).toEqual([12, 13]);
    expect(store.rows.every((row) => row.state === "succeeded")).toBe(true);
  });

  test("same-replica unassign aborts the holder without waiting for heartbeat", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const aborts = new Map<string, AbortController>();
      const started = Promise.withResolvers<void>();
      const tick = processWorkerTick(
        store,
        makeWorkerConfig({ home }),
        makeApi(),
        "worker-1",
        {
          heartbeatMs: 60_000,
          implement: async (opts) => {
            started.resolve();
            await waitUntilAborted(opts.abortSignal);
            return { status: "cancelled" };
          },
        },
        () => undefined,
        aborts
      );
      await started.promise;
      await handleIssueCancel(makeWorkerConfig({ home }), makeApi(), "kirmanak", "demo", 12, undefined, store, aborts);
      expect(await tick).toBe("processed");
      expect(store.rows[0]?.state).toBe("cancelled");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("unassign on another replica aborts the holder via failed heartbeat", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const child = Bun.spawn(["sleep", "30"]);
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const holderAborts = new Map<string, AbortController>();
      const holderPids = new Map<string, number>();
      const started = Promise.withResolvers<void>();
      const tick = processWorkerTick(
        store,
        makeWorkerConfig({ home }),
        makeApi(),
        "worker-holder",
        {
          heartbeatMs: 15,
          implement: async (opts) => {
            await opts.onPid?.(child.pid);
            started.resolve();
            await waitUntilAborted(opts.abortSignal);
            return { status: "cancelled" };
          },
        },
        () => undefined,
        holderAborts,
        holderPids
      );
      await started.promise;
      await handleIssueCancel(
        makeWorkerConfig({ home }),
        makeApi(),
        "kirmanak",
        "demo",
        12,
        undefined,
        store,
        new Map(),
        new Map()
      );
      expect(store.rows[0]?.state).toBe("cancelled");
      expect(await tick).toBe("processed");
      await child.exited;
      expect(child.exitCode === 0).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("already-aborted tick does not lease", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const abort = new AbortController();
    abort.abort();
    const result = await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
      abortSignal: abort.signal,
      implement: async () => {
        throw new Error("should not run");
      },
    });
    expect(result).toBe("idle");
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.attempt).toBe(0);
  });

  test("abort without a published result requeues the same job without consuming an attempt", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const api = makeApi();
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    const tick = processWorkerTick(
      store,
      makeWorkerConfig(),
      api,
      "worker-1",
      {
        abortSignal: abort.signal,
        implement: async (opts) => {
          started.resolve();
          await waitUntilAborted(opts.abortSignal);
          return { status: "cancelled" };
        },
      },
      () => undefined
    );
    await started.promise;
    abort.abort();
    await tick;

    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.attempt).toBe(0);
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.leasedUntil).toBeNull();
    expect(store.rows[0]?.error).toBeNull();
    expect(api.comments).toEqual([]);

    const abort2 = new AbortController();
    const started2 = Promise.withResolvers<void>();
    const tick2 = processWorkerTick(
      store,
      makeWorkerConfig(),
      api,
      "worker-2",
      {
        abortSignal: abort2.signal,
        implement: async (opts) => {
          started2.resolve();
          await waitUntilAborted(opts.abortSignal);
          return { status: "cancelled" };
        },
      },
      () => undefined
    );
    await started2.promise;
    abort2.abort();
    await tick2;
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.attempt).toBe(0);

    await processWorkerTick(store, makeWorkerConfig(), api, "worker-3", {
      implement: async () => ({
        status: "pr",
        prNumber: 1,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/1",
      }),
    });
    expect(store.rows[0]?.state).toBe("succeeded");
  });

  test("abort does not release a different worker's lease", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    const originalRelease = store.releaseLease.bind(store);
    const callers: string[] = [];
    store.releaseLease = async (id, leasedBy) => {
      callers.push(leasedBy);
      store.rows[0]!.leasedBy = "worker-other";
      return originalRelease(id, leasedBy);
    };
    const tick = processWorkerTick(
      store,
      makeWorkerConfig(),
      makeApi(),
      "worker-1",
      {
        abortSignal: abort.signal,
        implement: async (opts) => {
          started.resolve();
          await waitUntilAborted(opts.abortSignal);
          return { status: "cancelled" };
        },
      },
      () => undefined
    );
    await started.promise;
    abort.abort();
    await tick;
    expect(callers).toEqual(["worker-1"]);
    expect(store.rows[0]?.state).toBe("leased");
    expect(store.rows[0]?.leasedBy).toBe("worker-other");
  });

  test("shutdown abort kills the OpenCode child and requeues", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const aborts = new Map<string, AbortController>();
    const pids = new Map<string, number>();
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    const tick = processWorkerTick(
      store,
      makeWorkerConfig(),
      makeApi(),
      "worker-1",
      {
        abortSignal: abort.signal,
        implement: async (opts) => {
          await opts.onPid?.(child.pid);
          started.resolve();
          await waitUntilAborted(opts.abortSignal);
          return { status: "cancelled" };
        },
      },
      () => undefined,
      aborts,
      pids
    );
    await started.promise;
    abort.abort();
    expect(await tick).toBe("processed");
    await child.exited;
    expect(child.exitCode === 0).toBe(false);
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.attempt).toBe(0);
    expect(store.rows[0]?.leasedBy).toBeNull();
  });

  test("abort throw requeues without publishing", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const api = makeApi();
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    const tick = processWorkerTick(
      store,
      makeWorkerConfig(),
      api,
      "worker-1",
      {
        abortSignal: abort.signal,
        implement: async (opts) => {
          started.resolve();
          await waitUntilAborted(opts.abortSignal);
          const err = new Error("cancelled");
          err.name = "AbortError";
          throw err;
        },
      },
      () => undefined
    );
    await started.promise;
    abort.abort();
    await tick;
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.attempt).toBe(0);
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(api.comments).toEqual([]);
  });

  test("follow-up shutdown abort requeues without consuming an attempt", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 127, headSha: "headsha" }));
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    const tick = processWorkerTick(
      store,
      makeWorkerConfig(),
      makeApi(),
      "worker-1",
      {
        abortSignal: abort.signal,
        followUp: async (opts) => {
          started.resolve();
          await waitUntilAborted(opts.abortSignal);
          return { status: "cancelled" };
        },
      },
      () => undefined
    );
    await started.promise;
    abort.abort();
    await tick;
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.attempt).toBe(0);
    expect(store.rows[0]?.leasedBy).toBeNull();
  });

  test("cancelled without shutdown abort publishes skipped so reopen can re-enqueue", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeIssueJob();
    await store.enqueueIssue(job);
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
      implement: async () => ({ status: "cancelled" }),
    });
    expect(store.rows[0]?.state).toBe("skipped");
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(await store.enqueueIssue(makeIssueJob({ issueUpdatedAt: "2026-05-23T01:00:00Z" }))).toEqual({
      key: "implement:kirmanak/demo#12",
      queued: true,
    });
  });

  test("blocked skip is not a terminal implement outcome", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeIssueJob();
    await store.enqueueIssue(job);
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
      implement: async () => ({ status: "skipped", reason: "blocked on #196" }),
    });
    expect(store.rows[0]?.state).toBe("skipped");
    expect(store.rows[0]?.resultReason).toBe("blocked on #196");
    expect(await store.enqueueIssue(job)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
  });

  test("assigned-PR wait skip is not a terminal implement outcome", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeIssueJob();
    await store.enqueueIssue(job);
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
      implement: async () => ({ status: "skipped", reason: "assigned PR is the job for this repo" }),
    });
    expect(store.rows[0]?.state).toBe("skipped");
    expect(store.rows[0]?.resultReason).toBe("assigned PR is the job for this repo");
    expect(await store.enqueueIssue(job)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
  });

  test("maps implement no-changes to skipped so an issue edit can re-enqueue", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeIssueJob();
    await store.enqueueIssue(job);
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
      implement: async () => ({ status: "no-changes" }),
    });
    expect(store.rows[0]?.state).toBe("skipped");
    expect(store.rows[0]?.resultReason).toBe("no-changes");
    expect(await store.enqueueIssue(job)).toEqual({ key: "implement:kirmanak/demo#12", queued: false });
    expect(await store.enqueueIssue(makeIssueJob({ issueUpdatedAt: "2026-05-23T01:00:00Z" }))).toEqual({
      key: "implement:kirmanak/demo#12",
      queued: true,
    });
  });

  test("after implement push, mergeable false enqueues conflict", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      makeApi({
        getPR: async () => makePR({ number: 3, mergeable: false, head: { ...makePR().head, sha: "newsha" } }),
      }),
      "worker-1",
      {
        implement: async () => ({
          status: "pr",
          prNumber: 3,
          htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/3",
        }),
      }
    );
    const conflict = store.rows.find((row) => row.kind === "conflict");
    expect(conflict?.state).toBe("queued");
    expect(conflict?.prNumber).toBe(3);
    expect(conflict?.headSha).toBe("newsha");
    expect(conflict?.issueNumber).toBe(12);
  });

  test("after follow-up push, mergeable false enqueues conflict", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 127, headSha: "headsha" }));
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      makeApi({ getPR: async () => makePR({ number: 127, mergeable: false }) }),
      "worker-1",
      {
        followUp: async () => ({
          status: "pushed",
          prNumber: 127,
          htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
        }),
      }
    );
    expect(store.rows.find((row) => row.kind === "conflict")?.state).toBe("queued");
  });

  test("after conflict push, mergeable false enqueues another conflict", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "conflict", prNumber: 127, headSha: "headsha" }));
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      makeApi({
        getPR: async () => makePR({ number: 127, mergeable: false, head: { ...makePR().head, sha: "next" } }),
      }),
      "worker-1",
      {
        conflict: async () => ({
          status: "pushed",
          prNumber: 127,
          htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
        }),
      }
    );
    expect(store.rows.filter((row) => row.kind === "conflict" && row.state === "queued")).toHaveLength(1);
    expect(store.rows.find((row) => row.kind === "conflict" && row.state === "queued")?.headSha).toBe("next");
  });

  test("after push, null mergeable does not enqueue conflict", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      makeApi({ getPR: async () => makePR({ number: 3, mergeable: null }) }),
      "worker-1",
      {
        implement: async () => ({
          status: "pr",
          prNumber: 3,
          htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/3",
        }),
      }
    );
    expect(store.rows.some((row) => row.kind === "conflict")).toBe(false);
  });

  test("infra fail requeues implement without incrementing model attempts", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const logs: string[] = [];
    const breaker = new InfraCircuitBreaker();
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      makeApi(),
      "worker-1",
      {
        breaker,
        implement: async () => {
          throw new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
        },
      },
      (message) => logs.push(message)
    );
    expect(store.rows[0]?.attempt).toBe(0);
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.kind).toBe("implement");
    expect(store.rows[0]?.leasedUntil).toBeGreaterThan(Date.now());
    expect(logs.some((line) => line.includes("infra-retry"))).toBe(true);
    expect(logs.some((line) => /requeued .*attempt=/.test(line))).toBe(false);
  });

  test("real implementIssue infra fail does not fingerprint or stuck-publish", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-infra-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-worker-infra-work-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") throw new Error("missing");
        return "";
      };
      const extras = {
        breaker: new InfraCircuitBreaker(100, 20),
        implement: async (opts: Parameters<typeof implementIssue>[0]) =>
          implementIssue({
            ...opts,
            heartbeatIntervalMs: 0,
            gitRunner,
            openCodeRunner: async () => {
              throw new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
            },
          }),
      };
      const logs: string[] = [];
      for (let i = 0; i < 4; i++) {
        await processWorkerTick(store, makeWorkerConfig({ home, workdir }), api, "worker-1", extras, (message) =>
          logs.push(message)
        );
        store.rows[0]!.leasedUntil = Date.now() - 1;
      }
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.attempt).toBe(0);
      expect(store.rows[0]?.resultReason).toBeNull();
      expect(api.comments.some((body) => body.includes("Jumi failed:") || body.includes("stuck:"))).toBe(false);
      expect((await readStuckState(stuckStatePath(home, "kirmanak", "demo", 12))).fingerprints).toEqual([]);
      expect(logs.filter((line) => line.includes("infra-retry"))).toHaveLength(4);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("follow-up and conflict infra fails share the same requeue path", async () => {
    for (const mode of ["follow-up", "conflict"] as const) {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ mode, prNumber: 127, headSha: "headsha" }));
      const extras =
        mode === "follow-up"
          ? {
              followUp: async () => {
                throw new EngineFailedError("spawn opencode ENOENT", true);
              },
            }
          : {
              conflict: async () => {
                throw new EngineFailedError("spawn opencode ENOENT", true);
              },
            };
      await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
        breaker: new InfraCircuitBreaker(),
        ...extras,
      });
      expect(store.rows[0]?.attempt).toBe(0);
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.kind).toBe(mode);
    }
  });

  test("N consecutive infra fails stop leasing; cooldown resumes", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const breaker = new InfraCircuitBreaker(3, 20);
    const extras = {
      breaker,
      implement: async () => {
        throw new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
      },
    };
    const logs: string[] = [];
    for (let i = 0; i < 3; i++) {
      await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras, (message) =>
        logs.push(message)
      );
      store.rows[0]!.leasedUntil = Date.now() - 1;
    }
    logs.length = 0;
    expect(
      await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras, (message) => logs.push(message))
    ).toBe("idle");
    expect(logs.some((line) => line === "breaker open")).toBe(true);
    await Bun.sleep(25);
    logs.length = 0;
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras, (message) => logs.push(message));
    expect(logs.some((line) => line.includes("infra-retry"))).toBe(true);
  });

  test("long model run still uses MAX_JOB_ATTEMPTS", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const extras = {
      breaker: new InfraCircuitBreaker(),
      implement: async () => {
        throw new EngineFailedError("opencode exited with code 1:\nbad things", false);
      },
    };
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras);
    expect((await reclaimExpiredWorkerJobs(store, 2, () => undefined)).requeued).toBe(1);
    expect(store.rows[0]?.attempt).toBe(1);
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras);
    expect(await reclaimExpiredWorkerJobs(store, 2, () => undefined)).toEqual({ requeued: 0, published: 1 });
    expect(store.rows[0]?.state).toBe("failed");
    expect(store.rows[0]?.error).toContain("max attempts");
  });

  test("infra budget publishes infra/spawn not max attempts", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    store.rows[0]!.error = encodeInfraMarker(7, Date.now() - 1_000);
    const logs: string[] = [];
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      makeApi(),
      "worker-1",
      {
        breaker: new InfraCircuitBreaker(),
        implement: async () => {
          throw new EngineFailedError("missing API key", true);
        },
      },
      (message) => logs.push(message)
    );
    expect(store.rows[0]?.state).toBe("failed");
    expect(store.rows[0]?.resultReason).toBe(INFRA_SPAWN_REASON);
    expect(store.rows[0]?.attempt).toBe(0);
    expect(logs.some((line) => line.includes("infra-published") && line.includes("infra/spawn"))).toBe(true);
    expect(logs.some((line) => line.includes("reclaim-published"))).toBe(false);
  });

  test("fake engine quota abort requeues then succeeds after the delay", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-quota-ok-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-worker-quota-ok-work-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const cooldown = new QuotaCooldown();
      const api = makeApi();
      let calls = 0;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") throw new Error("missing");
        return "";
      };
      const extras = {
        breaker: new InfraCircuitBreaker(),
        quotaCooldown: cooldown,
        implement: async (opts: Parameters<typeof implementIssue>[0]) =>
          implementIssue({
            ...opts,
            heartbeatIntervalMs: 0,
            gitRunner,
            openCodeRunner: async () => {
              calls += 1;
              if (calls === 1) return { status: "stuck" as const, message: QUOTA_MESSAGE, quota: "resetting" as const };
              return { status: "ok" as const };
            },
          }),
      };
      await processWorkerTick(store, makeWorkerConfig({ home, workdir }), api, "worker-1", extras);
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.attempt).toBe(0);
      expect(isQuotaWaitMarker(store.rows[0]?.error)).toBe(true);
      expect(api.comments.some((body) => body.includes(QUOTA_STUCK_TEXT))).toBe(false);
      expect(isQuotaStuck(await readStuckState(stuckStatePath(home, "kirmanak", "demo", 12)))).toBe(false);
      store.rows[0]!.leasedUntil = Date.now() - 1;
      cooldown.reset();
      await processWorkerTick(store, makeWorkerConfig({ home, workdir }), api, "worker-1", extras);
      expect(store.rows[0]?.state).toBe("succeeded");
      expect(calls).toBe(2);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("quota abort requeues until the delay then succeeds on a later attempt", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const cooldown = new QuotaCooldown();
    const logs: string[] = [];
    let calls = 0;
    const extras = {
      breaker: new InfraCircuitBreaker(),
      quotaCooldown: cooldown,
      implement: async () => {
        calls += 1;
        if (calls === 1) {
          const decision = decideQuotaRetry(null, Date.now(), undefined, () => 0);
          if (decision.action !== "requeue") throw new Error("expected requeue");
          throw new QuotaWaitError(decision);
        }
        return {
          status: "pr" as const,
          prNumber: 3,
          htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/3",
        };
      },
    };
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras, (message) => logs.push(message));
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.attempt).toBe(0);
    expect(store.rows[0]?.leasedUntil).toBeGreaterThan(Date.now());
    expect(logs.some((line) => line.includes("quota-wait") && line.includes("n=1"))).toBe(true);
    expect(logs.some((line) => line.includes("event=opencode_quota_wait"))).toBe(true);
    expect(await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras)).toBe("idle");
    store.rows[0]!.leasedUntil = Date.now() - 1;
    cooldown.reset();
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras);
    expect(store.rows[0]?.state).toBe("succeeded");
    expect(calls).toBe(2);
  });

  test("quota wait exhaust at 30h posts stuck and does not retry", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-quota-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-worker-quota-work-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      store.rows[0]!.error = encodeQuotaWaitMarker(1, Date.now() - QUOTA_WAIT_BUDGET_MS - 1);
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        if (gitArgs[0] === "show-ref") throw new Error("missing");
        return "";
      };
      await processWorkerTick(
        store,
        makeWorkerConfig({ home, workdir }),
        api,
        "worker-1",
        {
          breaker: new InfraCircuitBreaker(),
          quotaCooldown: new QuotaCooldown(),
          implement: async (opts) =>
            implementIssue({
              ...opts,
              heartbeatIntervalMs: 0,
              gitRunner,
              openCodeRunner: async () => ({
                status: "stuck",
                message: QUOTA_MESSAGE,
                quota: "resetting",
              }),
            }),
        },
        () => undefined
      );
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe(QUOTA_STUCK_TEXT);
      expect(api.comments.some((body) => body.includes(QUOTA_STUCK_TEXT))).toBe(true);
      expect(
        isQuotaStuck(await readStuckLatch(store.skipLatches, { owner: "kirmanak", repo: "demo", issueNumber: 12 }))
      ).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("hop-configured different provider never enters the quota wait", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-hop-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-worker-hop-work-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const models: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") throw new Error("missing");
        return "";
      };
      await processWorkerTick(
        store,
        makeWorkerConfig({ home, workdir, fallbackModel: "anthropic/claude-sonnet-4-6" }),
        makeApi(),
        "worker-1",
        {
          breaker: new InfraCircuitBreaker(),
          quotaCooldown: new QuotaCooldown(),
          implement: async (opts) =>
            implementIssue({
              ...opts,
              heartbeatIntervalMs: 0,
              gitRunner,
              openCodeRunner: async (engineOpts) => {
                models.push(engineOpts.model);
                if (engineOpts.model === "openai/gpt-5.5") {
                  return { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" };
                }
                return { status: "ok" };
              },
            }),
        }
      );
      expect(models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
      expect(store.rows[0]?.state).toBe("succeeded");
      expect(store.rows[0]?.error).toBeNull();
      expect(isQuotaWaitMarker(store.rows[0]?.error)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("mixed chain waits on the second runner quota and does not latch", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-chain-wait-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-worker-chain-wait-work-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const api = makeApi();
      const models: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") throw new Error("missing");
        return "";
      };
      await processWorkerTick(
        store,
        makeWorkerConfig({
          home,
          workdir,
          model: "openai/gpt-5.5",
          fallbackModel: "anthropic/claude-sonnet-4-6",
          runners: {
            first: { type: "opencode", model: "openai/gpt-5.5" },
            second: { type: "opencode", model: "anthropic/claude-sonnet-4-6" },
          },
          chain: ["first", "second"],
        }),
        api,
        "worker-1",
        {
          breaker: new InfraCircuitBreaker(),
          quotaCooldown: new QuotaCooldown(),
          implement: async (opts) =>
            implementIssue({
              ...opts,
              heartbeatIntervalMs: 0,
              gitRunner,
              openCodeRunner: async (engineOpts) => {
                models.push(engineOpts.model);
                return { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" };
              },
            }),
        }
      );
      expect(models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.attempt).toBe(0);
      expect(isQuotaWaitMarker(store.rows[0]?.error)).toBe(true);
      expect(api.comments.some((body) => body.includes(QUOTA_STUCK_TEXT))).toBe(false);
      expect(
        isQuotaStuck(await readStuckLatch(store.skipLatches, { owner: "kirmanak", repo: "demo", issueNumber: 12 }))
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("mixed chain still hops a quota on the first runner", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-chain-hop-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-worker-chain-hop-work-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const models: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") throw new Error("missing");
        return "";
      };
      await processWorkerTick(
        store,
        makeWorkerConfig({
          home,
          workdir,
          model: "openai/gpt-5.5",
          fallbackModel: "anthropic/claude-sonnet-4-6",
          runners: {
            first: { type: "opencode", model: "openai/gpt-5.5" },
            second: { type: "opencode", model: "anthropic/claude-sonnet-4-6" },
          },
          chain: ["first", "second"],
        }),
        makeApi(),
        "worker-1",
        {
          breaker: new InfraCircuitBreaker(),
          quotaCooldown: new QuotaCooldown(),
          implement: async (opts) =>
            implementIssue({
              ...opts,
              heartbeatIntervalMs: 0,
              gitRunner,
              openCodeRunner: async (engineOpts) => {
                models.push(engineOpts.model);
                if (engineOpts.model === "openai/gpt-5.5") {
                  return { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" };
                }
                return { status: "ok" };
              },
            }),
        }
      );
      expect(models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
      expect(store.rows[0]?.state).toBe("succeeded");
      expect(isQuotaWaitMarker(store.rows[0]?.error)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("refused quota hop waits instead of latching", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-hop-refused-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-worker-hop-refused-work-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const api = makeApi();
      const models: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") throw new Error("missing");
        return "";
      };
      await processWorkerTick(
        store,
        makeWorkerConfig({
          home,
          workdir,
          model: "openai/gpt-5.5",
          fallbackModel: "anthropic/claude-sonnet-4-6",
          runners: {
            first: { type: "opencode", model: "openai/gpt-5.5" },
            second: { type: "opencode", model: "anthropic/claude-sonnet-4-6" },
          },
          chain: ["first", "second"],
        }),
        api,
        "worker-1",
        {
          breaker: new InfraCircuitBreaker(),
          quotaCooldown: new QuotaCooldown(),
          implement: async (opts) =>
            implementIssue({
              ...opts,
              heartbeatIntervalMs: 0,
              extendLease: async () => false,
              gitRunner,
              openCodeRunner: async (engineOpts) => {
                models.push(engineOpts.model);
                return { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" };
              },
            }),
        }
      );
      expect(models).toEqual(["openai/gpt-5.5"]);
      expect(store.rows[0]?.state).toBe("queued");
      expect(isQuotaWaitMarker(store.rows[0]?.error)).toBe(true);
      expect(api.comments.some((body) => body.includes(QUOTA_STUCK_TEXT))).toBe(false);
      expect(
        isQuotaStuck(await readStuckLatch(store.skipLatches, { owner: "kirmanak", repo: "demo", issueNumber: 12 }))
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("quota hit cools the instance so another job does not spawn OpenCode", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ issueNumber: 13, delivery: "d-13" }));
    const cooldown = new QuotaCooldown();
    const extras = {
      breaker: new InfraCircuitBreaker(),
      quotaCooldown: cooldown,
      implement: async () => {
        const decision = decideQuotaRetry(null, Date.now(), undefined, () => 0);
        if (decision.action !== "requeue") throw new Error("expected requeue");
        throw new QuotaWaitError(decision);
      },
    };
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras);
    const logs: string[] = [];
    expect(
      await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras, (message) => logs.push(message))
    ).toBe("idle");
    expect(logs.filter((line) => line === "quota cooldown")).toEqual(["quota cooldown"]);
  });

  test("quota cooldown does not log on every poll tick", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ issueNumber: 13, delivery: "d-13" }));
    const cooldown = new QuotaCooldown();
    const extras = {
      breaker: new InfraCircuitBreaker(),
      quotaCooldown: cooldown,
      implement: async () => {
        const decision = decideQuotaRetry(null, Date.now(), undefined, () => 0);
        if (decision.action !== "requeue") throw new Error("expected requeue");
        throw new QuotaWaitError(decision);
      },
    };
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras);
    const logs: string[] = [];
    for (let i = 0; i < 5; i++) {
      expect(
        await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", extras, (message) =>
          logs.push(message)
        )
      ).toBe("idle");
    }
    expect(logs.filter((line) => line === "quota cooldown")).toEqual(["quota cooldown"]);
  });

  test("unlabel cancel drops a job sitting in the quota wait", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-quota-cancel-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const decision = decideQuotaRetry(null, Date.now(), undefined, () => 0);
      if (decision.action !== "requeue") throw new Error("expected requeue");
      await processWorkerTick(store, makeWorkerConfig({ home }), makeApi(), "worker-1", {
        breaker: new InfraCircuitBreaker(),
        quotaCooldown: new QuotaCooldown(),
        implement: async () => {
          throw new QuotaWaitError(decision);
        },
      });
      expect(store.rows[0]?.state).toBe("queued");
      await handleIssueCancel(makeWorkerConfig({ home }), makeApi(), "kirmanak", "demo", 12, undefined, store);
      expect(store.rows[0]?.state).toBe("cancelled");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("shared skip latch skips follow-up without OpenCode on another ordinal", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-latch-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.setIssueSkipReason("kirmanak", "demo", 12, "stuck: cannot resolve conflicts");
      await writeStuckState(stuckStatePath(home, "kirmanak", "demo", 12), {
        fingerprints: [
          { kind: "error", hash: "aaa" },
          { kind: "error", hash: "aaa" },
          { kind: "error", hash: "aaa" },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 19, headSha: "headsha" }));
      let followUp = 0;
      const logs: string[] = [];
      await processWorkerTick(
        store,
        makeWorkerConfig({ home }),
        makeApi(),
        "worker-1",
        {
          followUp: async () => {
            followUp++;
            return { status: "skipped", reason: "stuck: repeated error" };
          },
        },
        (message) => logs.push(message)
      );
      expect(followUp).toBe(0);
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe("stuck: cannot resolve conflicts");
      expect(logs.some((line) => line.includes("stuck: cannot resolve conflicts"))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("kill switch wipes HOME skip files so a writer follow-up runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-worker-kill-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.setIssueSkipReason("kirmanak", "demo", 12, "stuck: cannot resolve conflicts");
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 19,
        round: 3,
        lastHeadSha: "abc",
        lastBaseSha: "def",
        updatedAt: "2026-05-23T00:00:00Z",
      });
      await handleIssueCancel(makeWorkerConfig({ home }), makeApi(), "kirmanak", "demo", 12, undefined, store);
      await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 19, headSha: "headsha" }));
      let followUp = 0;
      await processWorkerTick(store, makeWorkerConfig({ home }), makeApi(), "worker-1", {
        followUp: async () => {
          followUp++;
          return { status: "pushed", prNumber: 19, htmlUrl: "https://github.com/kirmanak/demo/pull/19" };
        },
      });
      expect(followUp).toBe(1);
      expect(store.rows.at(-1)?.state).toBe("succeeded");
      expect(await readFile(conflictStatePath(home, "kirmanak", "demo", 12), "utf8").catch(() => "")).toBe("");
      expect(JSON.parse(await readFile(skipLatchGenerationPath(home, "kirmanak", "demo", 12), "utf8"))).toEqual({
        generation: 1,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("follow-up stuck skip records a shared latch", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 19, headSha: "headsha" }));
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
      followUp: async () => ({ status: "skipped", reason: "stuck: repeated error" }),
    });
    expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({
      generation: 0,
      skipReason: "stuck: repeated error",
    });
  });

  test("stuck result remembers a sit alongside the shared latch", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "conflict", prNumber: 19, headSha: "headsha" }));
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
      conflict: async () => ({ status: "stuck" }),
    });
    expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({
      generation: 0,
      skipReason: "stuck: cannot resolve conflicts",
    });
    expect(await store.sits.get("kirmanak", "demo", 12)).toMatchObject({ reason: "implement-latch" });
  });
});
