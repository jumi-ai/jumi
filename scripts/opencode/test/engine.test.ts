import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerAuthDeathMessage } from "../src/auth.ts";
import {
  CI_ABSENT_NOTE,
  CI_LOOKUP_BACKOFF_MS,
  CI_LOOKUP_BUDGET_MS,
  CI_LOOKUP_FAILED_REASON,
  CI_PENDING_REASON,
} from "../src/ci.ts";
import { renderRunMetrics, resetControlMetricsForTests } from "../src/control_metrics.ts";
import { EngineFailedError } from "../src/engine.ts";
import { encodeInfraMarker, INFRA_SPAWN_REASON, InfraCircuitBreaker } from "../src/infra.ts";
import { QUOTA_MESSAGE, QUOTA_STUCK_TEXT, QUOTA_WAIT_PREFIX } from "../src/quota.ts";
import {
  INCOMPLETE_REVIEW_STUCK,
  MAX_INCOMPLETE_RETRIES,
  PR_AUTHOR_CANNOT_PUSH,
  type ReviewApi,
} from "../src/review.ts";
import { HEARTBEAT_MS, MemoryReviewJobStore, RECLAIM_LEASED_BY, REVIEW_KIND } from "../src/review_jobs.ts";
import { processEngineTick, reclaimExpiredJobs, startReviewer } from "../src/server.ts";
import { stuckMarker } from "../src/stuck.ts";
import type { GitRunner } from "../src/workspace.ts";
import {
  emptyCiMethods,
  makeBranch,
  makeComment,
  makeConfig,
  makeFile,
  makeIssue,
  makeJob,
  makePR,
  makeRepo,
  makeUser,
} from "./fixtures.ts";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi & {
  comments: string[];
  reviews: unknown[];
  statuses: Array<{ sha: string; state: string; description?: string }>;
} {
  const comments: string[] = [];
  const reviews: unknown[] = [];
  const statuses: Array<{ sha: string; state: string; description?: string }> = [];
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ id: comments.length, body });
    },
    updateIssueComment: async (_owner, _repo, commentId, body) => {
      comments.push(body);
      return makeComment({ id: commentId, body });
    },
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async (_owner, _repo, _index, review) => {
      reviews.push(review);
      return { id: reviews.length };
    },
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_owner, _repo, sha, status) => {
      statuses.push({ sha, state: status.state, description: status.description });
      return status;
    },
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  };
  return { ...defaults, ...overrides, comments, reviews, statuses };
}

function frozenGit(): GitRunner {
  return async (args) => {
    if (args[0] === "rev-parse") return "headsha";
    if (args[0] === "status") return "?? JUMI_REVIEW.md";
    if (args[0] === "ls-files") return "";
    if (args[0] === "checkout") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

function hangUntilAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error("cancelled");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}

async function withWorkspace<T>(run: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), "jumi-engine-"));
  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

afterEach(() => {
  resetControlMetricsForTests();
});

describe("processEngineTick", () => {
  test("leases a job, persists JUMI_REVIEW.md, and posts sticky via fake API", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(ran).toBe(1);
      const row = store.rows[0];
      expect(row?.state).toBe("succeeded");
      expect(row?.resultMarkdown).toContain("Looks good");
      expect(row?.resultMarkdown).not.toContain("I'll inspect");
      expect((api.reviews[0] as { body: string }).body).toContain("<!-- jumi-check: success -->");
      expect((api.reviews[0] as { body: string }).body).not.toContain("I'll inspect");
      expect(api.comments).toHaveLength(0);
      expect(api.statuses.map((status) => status.state)).toEqual(["pending", "success"]);
      expect(renderRunMetrics()).toContain('jumi_jobs_completed_total{kind="review",result="succeeded"} 1');
    });
  });

  test("incomplete review skip persists; reclaim publishes failure and does not rerun OpenCode", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" };
        },
      });

      expect(ran).toBe(1 + MAX_INCOMPLETE_RETRIES);
      const row = store.rows[0];
      expect(row?.state).toBe("skipped");
      expect(row?.resultReason).toBe("Incomplete review: no output");
      expect(store.rows.some((entry) => entry.kind === "follow-up")).toBe(false);
      expect(api.comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${INCOMPLETE_REVIEW_STUCK}`]);
      expect(api.statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: no output" });

      row!.state = "leased";
      row!.leasedBy = "dead-engine";
      row!.leasedUntil = 1;
      row!.publishedAt = null;
      api.statuses.length = 0;
      api.comments.length = 0;
      await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
      expect(ran).toBe(1 + MAX_INCOMPLETE_RETRIES);
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows.some((entry) => entry.kind === "follow-up")).toBe(false);
      expect(api.comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${INCOMPLETE_REVIEW_STUCK}`]);
      expect(api.statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: no output" });
    });
  });

  test("reclaim after result_markdown publishes without OpenCode", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const api = makeApi();
    const ran = 0;
    await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    expect(ran).toBe(0);
    expect(store.rows[0]?.state).toBe("succeeded");
    expect((api.reviews[0] as { body: string }).body).toContain("<!-- jumi-check: success -->");
    expect((api.reviews[0] as { body: string }).body).not.toContain("I'll inspect");
    expect(api.comments).toHaveLength(0);
  });

  test("overlapping reclaimExpiredJobs does not double-post a persist-ready sticky", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    let releaseComment!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseComment = resolve;
    });
    let enteredPublish!: () => void;
    const inPublish = new Promise<void>((resolve) => {
      enteredPublish = resolve;
    });
    let reviewCalls = 0;
    const api = makeApi({
      createPullReview: async (_owner, _repo, _index, review) => {
        enteredPublish();
        await gate;
        reviewCalls++;
        api.reviews.push(review);
        return { id: reviewCalls };
      },
    });
    const first = reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    await inPublish;
    const second = reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    releaseComment();
    await Promise.all([first, second]);
    expect(reviewCalls).toBe(1);
    expect(api.reviews).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("succeeded");
  });

  test("persist-ready reclaim claims HEARTBEAT_MS not leaseMs", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    let releaseComment!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseComment = resolve;
    });
    let enteredPublish!: () => void;
    const inPublish = new Promise<void>((resolve) => {
      enteredPublish = resolve;
    });
    const api = makeApi({
      createPullReview: async () => {
        enteredPublish();
        await gate;
        throw new Error("gitea down");
      },
      createIssueComment: async () => {
        throw new Error("gitea down");
      },
    });
    const first = reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    await inPublish;

    const claimedUntil = store.rows[0]!.leasedUntil!;
    const now = Date.now();
    expect(claimedUntil).toBeGreaterThan(now);
    expect(claimedUntil).toBeLessThanOrEqual(now + HEARTBEAT_MS + 1_000);
    expect(claimedUntil).toBeLessThan(now + makeConfig().leaseMs / 2);

    const twoSecondsLater = await store.reclaimExpired(2, new Date(now + 2_000));
    expect(twoSecondsLater.publish).toHaveLength(0);
    expect(twoSecondsLater.requeued).toHaveLength(0);

    const afterHeartbeat = await store.reclaimExpired(2, new Date(now + HEARTBEAT_MS + 1));
    expect(afterHeartbeat.publish).toHaveLength(1);

    releaseComment();
    await first;
    expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.publishedAt).toBeNull();
  });

  test("reclaimExpiredJobs expires lease on Gitea failure so the next tick retries publish", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    let reviewCalls = 0;
    const api = makeApi({
      createPullReview: async (_owner, _repo, _index, review) => {
        reviewCalls++;
        if (reviewCalls === 1) throw new Error("gitea 502");
        api.reviews.push(review);
        return { id: reviewCalls };
      },
      createIssueComment: async () => {
        throw new Error("gitea 502");
      },
    });
    await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    expect(reviewCalls).toBe(1);
    expect(store.rows[0]?.state).toBe("leased");
    expect(store.rows[0]?.publishedAt).toBeNull();
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());

    await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    expect(reviewCalls).toBe(2);
    expect(store.rows[0]?.state).toBe("succeeded");
    expect(api.reviews).toHaveLength(1);
    expect((api.reviews[0] as { body: string }).body).toContain("<!-- jumi-check: success -->");
  });

  test("expired lease without a result is retried", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      await store.lease("dead-engine", 1, new Date(1_000));
      const reclaimed = await store.reclaimExpired(2, new Date(5_000));
      expect(reclaimed.requeued[0]?.attempt).toBe(1);

      const api = makeApi();
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-2", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Retry\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ran).toBe(1);
      expect(store.rows[0]?.state).toBe("succeeded");
    });
  });

  test("publish throw after persist retries publish and marks published", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let reviewCalls = 0;
      const api = makeApi({
        createPullReview: async (_owner, _repo, _index, review) => {
          reviewCalls++;
          if (reviewCalls === 1) throw new Error("gitea down");
          api.reviews.push(review);
          return { id: reviewCalls };
        },
        createIssueComment: async () => {
          throw new Error("gitea down");
        },
      });
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(reviewCalls).toBe(2);
      expect(store.rows[0]?.state).toBe("succeeded");
      expect(store.rows[0]?.leasedUntil).toBeNull();
      expect((api.reviews[0] as { body: string }).body).toContain("<!-- jumi-check: success -->");
    });
  });

  test("persistResult throw on markdown does not persist error; expireLease so reclaim can retry", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const originalSave = store.saveResult.bind(store);
      store.saveResult = async (id, leasedBy, result) => {
        if (result.kind === "markdown") throw new Error("cannot save result");
        return originalSave(id, leasedBy, result);
      };
      const api = makeApi();
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(store.rows[0]?.error).toBeNull();
      expect(store.rows[0]?.resultMarkdown).toBeNull();
      expect(store.rows[0]?.resultReason).toBeNull();
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
      expect(api.comments).toHaveLength(0);
      expect(api.statuses.some((status) => status.description?.includes("cannot save result"))).toBe(false);
      const reclaimed = await store.reclaimExpired(2);
      expect(reclaimed.requeued).toHaveLength(1);
      expect(reclaimed.publish).toHaveLength(0);

      store.saveResult = originalSave;
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-2", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(store.rows[0]?.state).toBe("succeeded");
      expect((api.reviews[0] as { body: string }).body).toContain("<!-- jumi-check: success -->");
      expect((api.reviews[0] as { body: string }).body).not.toContain("cannot save result");
    });
  });

  test("persistResult throw on skip does not persist error; expireLease so reclaim can retry", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const originalSave = store.saveResult.bind(store);
      store.saveResult = async (id, leasedBy, result) => {
        if (result.kind === "skip") throw new Error("cannot save result");
        return originalSave(id, leasedBy, result);
      };
      const api = makeApi();
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async () => ({ status: "ok" }),
      });
      expect(store.rows[0]?.error).toBeNull();
      expect(store.rows[0]?.resultReason).toBeNull();
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
      expect(api.comments).toHaveLength(0);
      expect(api.statuses.some((status) => status.description?.includes("cannot save result"))).toBe(false);
      const reclaimed = await store.reclaimExpired(2);
      expect(reclaimed.requeued).toHaveLength(1);
      expect(reclaimed.publish).toHaveLength(0);
    });
  });

  test("engine catch after reclaim claimed does not publish or expire as the original engine", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const originalSave = store.saveResult.bind(store);
      const originalExpire = store.expireLease.bind(store);
      const expireCallers: string[] = [];
      store.saveResult = async (id, leasedBy, result) => {
        await originalSave(id, leasedBy, result);
        store.rows[0]!.leasedBy = RECLAIM_LEASED_BY;
      };
      store.expireLease = async (id, leasedBy, now) => {
        expireCallers.push(leasedBy);
        return originalExpire(id, leasedBy, now);
      };
      let reviewCalls = 0;
      const api = makeApi({
        createPullReview: async () => {
          reviewCalls++;
          throw new Error("gitea down");
        },
        createIssueComment: async () => {
          throw new Error("gitea down");
        },
      });
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(reviewCalls).toBe(1);
      expect(expireCallers).toEqual([]);
      expect(store.rows[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.publishedAt).toBeNull();
    });
  });

  test("CI pending skip does not create a review workspace", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi({
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "pending" }],
      });
      await processEngineTick(store, makeConfig({ workdir: blocker }), api, "engine-1");
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe(CI_PENDING_REASON);
    });
  });

  test("always-failing CI lookup is not leasable until backoff, then terminal after the budget", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let lists = 0;
      const boom = async () => {
        lists++;
        throw new Error("rate limited");
      };
      const api = makeApi({
        listCommitStatuses: boom,
        listCheckRuns: boom,
        listActionJobs: boom,
      });
      let now = Date.UTC(2026, 0, 1);
      const extras = {
        now: () => now,
        openCodeRunner: async () => {
          throw new Error("runner should not be called");
        },
      };
      const config = makeConfig({ workdir: blocker, home: workspace });
      await processEngineTick(store, config, api, "engine-1", extras);
      const cooling = store.rows[0];
      expect(cooling?.state).toBe("queued");
      expect(cooling?.leasedUntil).toBe(now + CI_LOOKUP_BACKOFF_MS[0]);
      expect(api.statuses).toEqual([]);
      expect(await store.lease("engine-2", 60_000, new Date(now), [REVIEW_KIND])).toBeUndefined();
      now = cooling?.leasedUntil ?? now;
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.leasedUntil).toBe(now + CI_LOOKUP_BACKOFF_MS[1]);
      expect((store.rows[0]?.leasedUntil ?? 0) - now).toBeGreaterThan(CI_LOOKUP_BACKOFF_MS[0]);
      now += CI_LOOKUP_BUDGET_MS;
      await processEngineTick(store, config, api, "engine-1", extras);
      const done = store.rows[0];
      expect(done?.state).toBe("failed");
      expect(done?.resultReason).toBe(CI_LOOKUP_FAILED_REASON);
      expect(done?.publishedAt).not.toBeNull();
      expect(api.statuses).toEqual([{ sha: "headsha", state: "failure", description: CI_LOOKUP_FAILED_REASON }]);
      expect(lists).toBe(18);
      expect(await store.lease("engine-2", 60_000, new Date(now), [REVIEW_KIND])).toBeUndefined();
      expect(await processEngineTick(store, config, api, "engine-1", extras)).toBe("idle");
      expect(lists).toBe(18);
      expect(await store.enqueue(makeJob())).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    });
  });

  test("pending external status then success is reviewed without a new push", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let state: "pending" | "success" = "pending";
      const api = makeApi({
        listCommitStatuses: async () => [{ id: 1, context: "external/ci", status: state }],
      });
      let ran = 0;
      const extras = {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts: { workdir: string }) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" as const };
        },
      };
      const config = makeConfig({ workdir: workspace, home: workspace });
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(ran).toBe(0);
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe(CI_PENDING_REASON);
      state = "success";
      expect(await store.enqueue(makeJob())).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(ran).toBe(1);
      expect(store.rows.some((row) => row.state === "succeeded")).toBe(true);
    });
  });

  test("no checks wait on the lookup budget, then review and say there is no CI", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let looks = 0;
      const api = makeApi({
        listCommitStatuses: async () => {
          looks++;
          return [];
        },
        listCheckRuns: async () => [],
        listActionJobs: async () => [],
      });
      let ran = 0;
      let now = Date.UTC(2026, 0, 1);
      const extras = {
        now: () => now,
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts: { workdir: string }) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" as const };
        },
      };
      const config = makeConfig({ workdir: workspace, home: workspace });
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(ran).toBe(0);
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.leasedUntil).toBe(now + CI_LOOKUP_BACKOFF_MS[0]);
      expect(store.rows[0]?.error).toContain("ci-lookup-retry:");
      now += CI_LOOKUP_BUDGET_MS;
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(ran).toBe(1);
      expect(store.rows[0]?.state).toBe("succeeded");
      expect((api.reviews[0] as { body: string }).body).toContain(CI_ABSENT_NOTE);
      expect(looks).toBeGreaterThan(0);
    });
  });

  test("absent-budget exhaust re-lists once and does not claim no CI if a check appeared", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let looks = 0;
      const api = makeApi({
        listCommitStatuses: async () => {
          looks++;
          if (looks < 5) return [];
          return [{ id: 1, context: "external/ci", status: "pending" }];
        },
        listCheckRuns: async () => [],
        listActionJobs: async () => [],
      });
      let ran = 0;
      let now = Date.UTC(2026, 0, 1);
      const extras = {
        now: () => now,
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" as const };
        },
      };
      const config = makeConfig({ workdir: workspace, home: workspace });
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(ran).toBe(0);
      expect(store.rows[0]?.state).toBe("queued");
      now += CI_LOOKUP_BUDGET_MS;
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(ran).toBe(0);
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe(CI_PENDING_REASON);
      expect(api.reviews).toEqual([]);
      expect(looks).toBe(5);
    });
  });

  test("absent-budget exhaust reviews a check that finished green without the no-CI note", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let looks = 0;
      const api = makeApi({
        listCommitStatuses: async () => {
          looks++;
          if (looks < 5) return [];
          return [{ id: 1, context: "external/ci", status: "success" }];
        },
        listCheckRuns: async () => [],
        listActionJobs: async () => [],
      });
      let ran = 0;
      let now = Date.UTC(2026, 0, 1);
      const extras = {
        now: () => now,
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts: { workdir: string }) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" as const };
        },
      };
      const config = makeConfig({ workdir: workspace, home: workspace });
      await processEngineTick(store, config, api, "engine-1", extras);
      now += CI_LOOKUP_BUDGET_MS;
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(ran).toBe(1);
      expect(store.rows[0]?.state).toBe("succeeded");
      expect((api.reviews[0] as { body: string }).body).not.toContain(CI_ABSENT_NOTE);
      expect(looks).toBe(5);
    });
  });

  test("absent-budget exhaust that fails the final list publishes the lookup failure", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let looks = 0;
      const emptyThenFail = async () => {
        looks++;
        if (looks < 5) return [];
        throw new Error("rate limited");
      };
      const api = makeApi({
        listCommitStatuses: emptyThenFail,
        listCheckRuns: async () => {
          if (looks < 5) return [];
          throw new Error("rate limited");
        },
        listActionJobs: async () => {
          if (looks < 5) return [];
          throw new Error("rate limited");
        },
      });
      let ran = 0;
      let now = Date.UTC(2026, 0, 1);
      const extras = {
        now: () => now,
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" as const };
        },
      };
      const config = makeConfig({ workdir: blocker, home: workspace });
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(ran).toBe(0);
      expect(store.rows[0]?.state).toBe("queued");
      now += CI_LOOKUP_BUDGET_MS;
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(ran).toBe(0);
      expect(store.rows[0]?.state).toBe("failed");
      expect(store.rows[0]?.resultReason).toBe(CI_LOOKUP_FAILED_REASON);
      expect(store.rows[0]?.publishedAt).not.toBeNull();
      expect(api.statuses).toEqual([{ sha: "headsha", state: "failure", description: CI_LOOKUP_FAILED_REASON }]);
      expect(looks).toBe(5);
      expect(await processEngineTick(store, config, api, "engine-1", extras)).toBe("idle");
    });
  });

  test("sibling finish during a CI lookup outage does not restart the budget", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const boom = async () => {
        throw new Error("rate limited");
      };
      const api = makeApi({
        listCommitStatuses: boom,
        listCheckRuns: boom,
        listActionJobs: boom,
      });
      let now = Date.now();
      const extras = {
        now: () => now,
        openCodeRunner: async () => {
          throw new Error("runner should not be called");
        },
      };
      const config = makeConfig({ workdir: blocker, home: workspace });
      await processEngineTick(store, config, api, "engine-1", extras);
      const marker = store.rows[0]?.error;
      expect(marker).toContain("ci-lookup-retry:");
      expect(await store.enqueue(makeJob())).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });
      expect(store.rows[0]?.leasedUntil).toBeNull();
      expect(store.rows[0]?.error).toBe(marker);
      now += CI_LOOKUP_BUDGET_MS;
      await processEngineTick(store, config, api, "engine-1", extras);
      expect(store.rows[0]?.state).toBe("failed");
      expect(store.rows[0]?.resultReason).toBe(CI_LOOKUP_FAILED_REASON);
      expect(api.statuses).toEqual([{ sha: "headsha", state: "failure", description: CI_LOOKUP_FAILED_REASON }]);
    });
  });

  test("Actions that appear after the first list are not reviewed before they finish", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let looks = 0;
      const api = makeApi({
        listCommitStatuses: async () => [],
        listCheckRuns: async () => [],
        listActionJobs: async () => {
          looks++;
          if (looks < 2) return [];
          return [{ id: 9, name: "build", head_sha: "headsha", status: "in_progress" }];
        },
      });
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" };
        },
      });
      expect(ran).toBe(0);
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe(CI_PENDING_REASON);
      expect(looks).toBe(2);
    });
  });

  test("reviews a Renovate pull whose head is on the base repo even when its lookup says none", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi({
        getPR: async () => makePR({ user: makeUser({ login: "renovate[bot]" }) }),
        getCollaboratorPermission: async () => ({ permission: "none" }),
      });
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ran).toBe(1);
      expect(store.rows[0]?.state).toBe("succeeded");
    });
  });

  test("ignores a fork pull whose author cannot push to the base repo", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const lookedUp: string[] = [];
      const api = makeApi({
        getPR: async () =>
          makePR({
            user: makeUser({ login: "mallory" }),
            head: makeBranch({ sha: "headsha", repo: makeRepo({ owner: makeUser({ login: "mallory" }) }) }),
          }),
        getCollaboratorPermission: async (_owner, _repo, username) => {
          lookedUp.push(username);
          return { permission: "read" };
        },
      });
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        openCodeRunner: async () => {
          throw new Error("runner should not be called");
        },
      });
      expect(lookedUp).toEqual(["mallory"]);
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe(PR_AUTHOR_CANNOT_PUSH);
      expect(api.statuses).toEqual([]);
      expect(api.comments).toEqual([]);
      expect(api.reviews).toEqual([]);
    });
  });

  test("reviews a fork pull whose author can push to the base repo", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi({
        getPR: async () =>
          makePR({ head: makeBranch({ sha: "headsha", repo: makeRepo({ owner: makeUser({ login: "alice" }) }) }) }),
      });
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ran).toBe(1);
      expect(store.rows[0]?.state).toBe("succeeded");
    });
  });

  test("closed or merged pull finishes in one lease when CI lookups would fail", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const config = makeConfig({ workdir: blocker, home: workspace });
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let lists = 0;
      const boom = async () => {
        lists++;
        throw new Error("rate limited");
      };
      const closed = makeApi({
        getPR: async () => makePR({ state: "closed" }),
        listCommitStatuses: boom,
        listCheckRuns: boom,
        listActionJobs: boom,
      });
      await processEngineTick(store, config, closed, "engine-1", {
        openCodeRunner: async () => {
          throw new Error("runner should not be called");
        },
      });
      expect(lists).toBe(0);
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe("PR is closed");
      expect(await processEngineTick(store, config, closed, "engine-1")).toBe("idle");

      const mergedStore = new MemoryReviewJobStore();
      await mergedStore.enqueue(makeJob());
      const merged = makeApi({
        getPR: async () => makePR({ merged: true }),
        listCommitStatuses: boom,
        listCheckRuns: boom,
        listActionJobs: boom,
      });
      await processEngineTick(mergedStore, config, merged, "engine-1");
      expect(lists).toBe(0);
      expect(mergedStore.rows[0]?.state).toBe("skipped");
      expect(mergedStore.rows[0]?.resultReason).toBe("PR is already merged");
      expect(await processEngineTick(mergedStore, config, merged, "engine-1")).toBe("idle");
    });
  });

  test("same-SHA wake during a failing CI lookup requeues immediately", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi({
        listCommitStatuses: async () => {
          await store.enqueue(makeJob());
          throw new Error("rate limited");
        },
        listCheckRuns: async () => {
          throw new Error("rate limited");
        },
        listActionJobs: async () => {
          throw new Error("rate limited");
        },
      });
      await processEngineTick(store, makeConfig({ workdir: blocker, home: workspace }), api, "engine-1", {
        openCodeRunner: async () => {
          throw new Error("runner should not be called");
        },
      });
      const row = store.rows[0];
      expect(row?.state).toBe("queued");
      expect(row?.leasedUntil).toBeNull();
      expect(row?.rewakeRequested).toBe(false);
      expect(api.statuses).toEqual([]);
    });
  });

  test("throw before persist expires the lease so reclaim can retry", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      await processEngineTick(store, makeConfig({ workdir: blocker }), api, "engine-1");
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.resultMarkdown).toBeNull();
      expect(store.rows[0]?.resultReason).toBeNull();
      expect(store.rows[0]?.error).toBeNull();
      expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
      const reclaimed = await store.reclaimExpired(2);
      expect(reclaimed.requeued).toHaveLength(1);
      expect(reclaimed.requeued[0]?.state).toBe("queued");
    });
  });

  test("already-aborted tick does not lease", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const abort = new AbortController();
    abort.abort();
    const result = await processEngineTick(store, makeConfig(), makeApi(), "engine-1", {
      abortSignal: abort.signal,
      openCodeRunner: async () => {
        throw new Error("should not run");
      },
    });
    expect(result).toBe("idle");
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.attempt).toBe(0);
  });

  test("engine stop aborts OpenCode and requeues the leased SHA", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const shutdown = new AbortController();
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        started = resolve;
      });
      const reviewer = await startReviewer(
        makeConfig({ role: "engine", workdir: workspace, home: workspace, port: 0 }),
        {
          store,
          api: makeApi(),
          signal: shutdown.signal,
          ensureAuth: async () => undefined,
          extras: {
            ciRelistDelayMs: 0,
            gitRunner: frozenGit(),
            workspacePreparer: async () => undefined,
            openCodeRunner: async (opts) => {
              started();
              return hangUntilAbort(opts.abortSignal);
            },
          },
        }
      );
      try {
        await gate;
        shutdown.abort();
        reviewer.stop();
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline && store.rows[0]?.state !== "queued") {
          await Bun.sleep(10);
        }
        expect(store.rows[0]?.state).toBe("queued");
        expect(store.rows[0]?.attempt).toBe(0);
        expect(store.rows[0]?.leasedBy).toBeNull();
      } finally {
        reviewer.stop();
        reviewer.server?.stop(true);
      }
    });
  });

  test("abort without a persisted result requeues the same SHA without consuming an attempt", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      const abort = new AbortController();
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        started = resolve;
      });
      const tick = processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        abortSignal: abort.signal,
        openCodeRunner: async (opts) => {
          started();
          return hangUntilAbort(opts.abortSignal);
        },
      });
      await gate;
      abort.abort();
      await tick;

      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.attempt).toBe(0);
      expect(store.rows[0]?.leasedBy).toBeNull();
      expect(store.rows[0]?.leasedUntil).toBeNull();
      expect(store.rows[0]?.error).toBeNull();
      expect(store.rows[0]?.resultMarkdown).toBeNull();
      expect(api.comments).toHaveLength(0);
      expect(api.statuses.map((status) => status.state)).toEqual(["pending"]);
      expect(api.statuses.some((status) => status.state === "failure")).toBe(false);

      const abort2 = new AbortController();
      let started2!: () => void;
      const gate2 = new Promise<void>((resolve) => {
        started2 = resolve;
      });
      const tick2 = processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-2", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        abortSignal: abort2.signal,
        openCodeRunner: async (opts) => {
          started2();
          return hangUntilAbort(opts.abortSignal);
        },
      });
      await gate2;
      abort2.abort();
      await tick2;
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.attempt).toBe(0);

      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-3", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(store.rows[0]?.state).toBe("succeeded");
      expect((api.reviews[0] as { body: string }).body).toContain("<!-- jumi-check: success -->");
    });
  });

  test("abort does not release a different engine's lease", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      const abort = new AbortController();
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        started = resolve;
      });
      const originalRelease = store.releaseLease.bind(store);
      const callers: string[] = [];
      store.releaseLease = async (id, leasedBy) => {
        callers.push(leasedBy);
        store.rows[0]!.leasedBy = "engine-other";
        return originalRelease(id, leasedBy);
      };
      const tick = processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        abortSignal: abort.signal,
        openCodeRunner: async (opts) => {
          started();
          return hangUntilAbort(opts.abortSignal);
        },
      });
      await gate;
      abort.abort();
      await tick;
      expect(callers).toEqual(["engine-1"]);
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.leasedBy).toBe("engine-other");
    });
  });

  test("lost lease aborts OpenCode and does not publish or steal the row", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        started = resolve;
      });
      const tick = processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        heartbeatMs: 15,
        openCodeRunner: async (opts) => {
          started();
          return hangUntilAbort(opts.abortSignal);
        },
      });
      await gate;
      store.rows[0]!.leasedBy = "engine-other";
      expect(await tick).toBe("processed");
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.leasedBy).toBe("engine-other");
      expect(store.rows[0]?.resultMarkdown).toBeNull();
      expect(api.reviews).toHaveLength(0);
      expect(api.comments).toHaveLength(0);
    });
  });

  test("lost lease after router requeue aborts OpenCode so another engine can run it", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        started = resolve;
      });
      const tick = processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        heartbeatMs: 15,
        openCodeRunner: async (opts) => {
          started();
          return hangUntilAbort(opts.abortSignal);
        },
      });
      await gate;
      store.rows[0]!.state = "queued";
      store.rows[0]!.leasedBy = null;
      store.rows[0]!.leasedUntil = null;
      expect(await tick).toBe("processed");
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.attempt).toBe(0);
      expect(store.rows[0]?.leasedBy).toBeNull();
      expect(api.reviews).toHaveLength(0);

      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-2", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      const published = await store.get(store.rows[0]!.id);
      expect(published?.state).toBe("succeeded");
      expect((api.reviews[0] as { body: string }).body).toContain("<!-- jumi-check: success -->");
    });
  });

  test("in-flight heartbeat after throw cannot restore an expired lease", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());

      let releaseHeartbeat!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseHeartbeat = resolve;
      });
      let heartbeatCalls = 0;
      const pendingHeartbeats: Promise<boolean>[] = [];
      const originalHeartbeat = store.heartbeat.bind(store);
      store.heartbeat = (id, leasedBy, leaseMs, now) => {
        heartbeatCalls++;
        const run = gate.then(() => originalHeartbeat(id, leasedBy, leaseMs, now));
        pendingHeartbeats.push(run);
        return run;
      };

      const intervalCallbacks: Array<() => void> = [];
      const realSetInterval = globalThis.setInterval.bind(globalThis);
      globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (typeof handler === "function") {
          const cb = () => {
            (handler as (...handlerArgs: unknown[]) => void)(...args);
          };
          intervalCallbacks.push(cb);
          cb();
        }
        return realSetInterval(handler, timeout, ...args);
      }) as typeof setInterval;

      try {
        const api = makeApi();
        await processEngineTick(store, makeConfig({ workdir: blocker }), api, "engine-1");
        intervalCallbacks[0]!();
        expect(heartbeatCalls).toBe(1);

        releaseHeartbeat();
        await Promise.all(pendingHeartbeats);

        expect(store.rows[0]?.state).toBe("leased");
        expect(store.rows[0]?.leasedBy).toBeNull();
        expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
        const reclaimed = await store.reclaimExpired(2);
        expect(reclaimed.requeued).toHaveLength(1);
        expect(reclaimed.requeued[0]?.state).toBe("queued");
      } finally {
        globalThis.setInterval = realSetInterval;
      }
    });
  });

  test("infra fail requeues without incrementing model attempts", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const logs: string[] = [];
      const breaker = new InfraCircuitBreaker();
      await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        makeApi(),
        "engine-1",
        {
          gitRunner: frozenGit(),
          workspacePreparer: async () => undefined,
          breaker,
          openCodeRunner: async () => {
            throw new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
          },
        },
        (message) => logs.push(message)
      );
      expect(store.rows[0]?.attempt).toBe(0);
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.leasedUntil).toBeGreaterThan(Date.now());
      expect(logs.some((line) => line.includes("infra-retry") && line.includes("n=1"))).toBe(true);
      expect(logs.some((line) => line.includes("requeued") && line.includes("attempt="))).toBe(false);
    });
  });

  test("resetting quota stuck requeues the same head with a quota-wait marker", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const logs: string[] = [];
      const api = makeApi();
      await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        api,
        "engine-1",
        {
          gitRunner: frozenGit(),
          workspacePreparer: async () => undefined,
          breaker: new InfraCircuitBreaker(),
          openCodeRunner: async () => ({ status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" }),
        },
        (message) => logs.push(message)
      );
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.headSha).toBe("headsha");
      expect(store.rows[0]?.error?.startsWith(QUOTA_WAIT_PREFIX)).toBe(true);
      expect(store.rows[0]?.resultReason).toBeNull();
      expect(store.rows[0]?.resultMarkdown).toBeNull();
      expect(store.rows[0]?.leasedUntil).toBeGreaterThan(Date.now());
      expect(logs.some((line) => line.includes("quota-wait") && line.includes("n=1"))).toBe(true);
      expect(api.comments.some((body) => body.includes(QUOTA_STUCK_TEXT))).toBe(false);
      expect(api.statuses.map((status) => status.state)).toEqual(["pending"]);
    });
  });

  test("hard quota stuck still takes the day-long skip path", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        breaker: new InfraCircuitBreaker(),
        openCodeRunner: async () => ({ status: "stuck", message: QUOTA_MESSAGE, quota: "hard" }),
      });
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe(QUOTA_STUCK_TEXT);
      expect((store.rows[0]?.error ?? "").startsWith(QUOTA_WAIT_PREFIX)).toBe(false);
      expect(api.comments.some((body) => body.includes(QUOTA_STUCK_TEXT))).toBe(true);
      expect(api.statuses.at(-1)?.state).toBe("warning");
    });
  });

  test("auth death does not infra-retry", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const logs: string[] = [];
      const api = makeApi();
      await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        api,
        "engine-1",
        {
          gitRunner: frozenGit(),
          workspacePreparer: async () => undefined,
          breaker: new InfraCircuitBreaker(),
          openCodeRunner: async () => ({
            status: "exit",
            exitCode: 1,
            auth: true,
            message: providerAuthDeathMessage(),
          }),
        },
        (message) => logs.push(message)
      );
      expect(logs.some((line) => line.includes("infra-retry"))).toBe(false);
      expect(store.rows[0]?.state).toBe("failed");
      expect(store.rows[0]?.attempt).toBe(0);
      expect(api.statuses.at(-1)).toMatchObject({
        state: "failure",
        description: `Jumi review failed: ${providerAuthDeathMessage()}`,
      });
      expect(api.statuses.at(-1)?.description).not.toContain("invalid_grant");
    });
  });

  test("N consecutive infra fails stop leasing until cooldown", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const breaker = new InfraCircuitBreaker(3, 20);
      const extras = {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        breaker,
        openCodeRunner: async () => {
          throw new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
        },
      };
      const logs: string[] = [];
      const logger = (message: string) => logs.push(message);
      for (let i = 0; i < 3; i++) {
        await processEngineTick(
          store,
          makeConfig({ workdir: workspace, home: workspace }),
          makeApi(),
          "engine-1",
          extras,
          logger
        );
        store.rows[0]!.leasedUntil = Date.now() - 1;
      }
      logs.length = 0;
      expect(
        await processEngineTick(
          store,
          makeConfig({ workdir: workspace, home: workspace }),
          makeApi(),
          "engine-1",
          extras,
          logger
        )
      ).toBe("idle");
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.attempt).toBe(0);
      expect(logs.some((line) => line === "breaker open")).toBe(true);
      await Bun.sleep(25);
      logs.length = 0;
      await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        makeApi(),
        "engine-1",
        extras,
        logger
      );
      expect(logs.some((line) => line.includes("infra-retry"))).toBe(true);
    });
  });

  test("model success after infra closes the breaker", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const breaker = new InfraCircuitBreaker(3, 60_000);
      const fail = {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        breaker,
        openCodeRunner: async () => {
          throw new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
        },
      };
      for (let i = 0; i < 2; i++) {
        await processEngineTick(
          store,
          makeConfig({ workdir: workspace, home: workspace }),
          makeApi(),
          "engine-1",
          fail
        );
        store.rows[0]!.leasedUntil = Date.now() - 1;
      }
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), makeApi(), "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        breaker,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(store.rows[0]?.state).toBe("succeeded");
      expect(breaker.canLease()).toBe(true);
      expect(await store.enqueue(makeJob({ prNumber: 8, delivery: "d2" }))).toEqual({
        key: "kirmanak/demo#8:headsha",
        queued: true,
      });
      const logs: string[] = [];
      await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        makeApi(),
        "engine-1",
        fail,
        (message) => logs.push(message)
      );
      expect(logs.some((line) => line === "breaker open")).toBe(false);
      expect(logs.some((line) => line.includes("infra-retry"))).toBe(true);
    });
  });

  test("long model run still uses MAX_JOB_ATTEMPTS", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const logs: string[] = [];
      await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        makeApi(),
        "engine-1",
        {
          gitRunner: frozenGit(),
          workspacePreparer: async () => undefined,
          breaker: new InfraCircuitBreaker(),
          openCodeRunner: async () => {
            throw new EngineFailedError("opencode exited with code 1:\nbad things", false);
          },
        },
        (message) => logs.push(message)
      );
      expect(store.rows[0]?.state).toBe("failed");
      expect(store.rows[0]?.error).toContain("opencode exited");
      expect(logs.some((line) => line.includes("infra-retry"))).toBe(false);

      const crash = new MemoryReviewJobStore();
      await crash.enqueue(makeJob());
      await crash.lease("engine-1", 1, new Date(1_000));
      expect((await crash.reclaimExpired(2, new Date(5_000))).requeued[0]?.attempt).toBe(1);
      await crash.lease("engine-1", 1, new Date(6_000));
      const published = await crash.reclaimExpired(2, new Date(10_000));
      expect(published.requeued).toHaveLength(0);
      expect(published.publish[0]?.attempt).toBe(2);
      expect(published.publish[0]?.error).toContain("max attempts");
    });
  });

  test("infra budget publishes infra/spawn not max attempts", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      store.rows[0]!.error = encodeInfraMarker(7, Date.now() - 1_000);
      const logs: string[] = [];
      await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        makeApi(),
        "engine-1",
        {
          gitRunner: frozenGit(),
          workspacePreparer: async () => undefined,
          breaker: new InfraCircuitBreaker(),
          openCodeRunner: async () => {
            throw new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
          },
        },
        (message) => logs.push(message)
      );
      expect(store.rows[0]?.state).toBe("failed");
      expect(store.rows[0]?.error).toBe(INFRA_SPAWN_REASON);
      expect(store.rows[0]?.attempt).toBe(0);
      expect(logs.some((line) => line.includes("infra-published") && line.includes("infra/spawn"))).toBe(true);
      expect(logs.some((line) => line.includes("reclaim-published"))).toBe(false);
    });
  });
});
