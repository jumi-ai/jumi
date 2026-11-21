import { describe, expect, test } from "bun:test";
import type { Pull } from "../src/ports.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import {
  encodeStrictRefreshWait,
  isStrictRefreshBehind,
  isStrictRefreshCandidate,
  isStrictRefreshLeftToAuthor,
  isStrictRefreshWaitMarker,
  parseStrictRefreshWait,
  recheckStrictRefreshEligibility,
  resolveStrictPolicy,
  STRICT_REFRESH_WAIT_FALLBACK_MS,
  STRICT_REFRESH_WAIT_PREFIX,
  shouldEnqueueStrictRefreshForPR,
  shouldEnqueueStrictRefreshOnPush,
  strictRecheckSkipReason,
} from "../src/strict_refresh.ts";

function jumiPull(overrides: Partial<Pull> = {}): Pull {
  return {
    number: 127,
    title: "Fix the thing",
    body: "Fixes #12",
    state: "open",
    html_url: "https://github.com/o/r/pull/127",
    user: { login: "jumi" },
    head: {
      ref: "jumi/issue-12-fix",
      sha: "headsha",
      repo: { full_name: "o/r", clone_url: "https://github.com/o/r.git" },
    },
    base: { ref: "main", sha: "basesha" },
    merged: false,
    draft: false,
    autoMergeEnabled: true,
    created_at: "2026-05-23T00:00:00Z",
    updated_at: "2026-05-23T00:00:00Z",
    ...overrides,
  };
}

function pushPayload(after = "base2") {
  return {
    ref: "refs/heads/main",
    before: "base1",
    after,
    repository: {
      full_name: "o/r",
      default_branch: "main",
      clone_url: "https://github.com/o/r.git",
    },
    pusher: { login: "alice" },
    sender: { login: "alice" },
  } as never;
}

const policy = {
  giteaUrl: "https://github.com",
  allowedOrgs: ["o"],
  allowedRepos: [],
  botUsername: "jumi",
} as never;

describe("strict policy", () => {
  test("classic strict true is strict", async () => {
    const api = {
      getBranch: async () => ({ protected: true, enableStatusCheck: true, requiredContexts: ["ci"], strict: true }),
    };
    expect(await resolveStrictPolicy(api as never, "o", "r", "main")).toBe("strict");
  });
  test("classic strict false is off", async () => {
    const api = {
      getBranch: async () => ({ protected: true, enableStatusCheck: true, requiredContexts: ["ci"], strict: false }),
    };
    expect(await resolveStrictPolicy(api as never, "o", "r", "main")).toBe("off");
  });
  test("classic without strict is unknown (fail closed)", async () => {
    const api = { getBranch: async () => ({ protected: true, enableStatusCheck: true, requiredContexts: ["ci"] }) };
    expect(await resolveStrictPolicy(api as never, "o", "r", "main")).toBe("unknown");
  });
  test("unreadable policy is unknown, not permission", async () => {
    const api = {
      getBranch: async () => {
        throw new Error("GitHub API GET /repos/o/r/branches/main/protection → 403: forbidden");
      },
    };
    expect(await resolveStrictPolicy(api as never, "o", "r", "main")).toBe("unknown");
  });
  test("missing getBranch is unknown", async () => {
    expect(await resolveStrictPolicy({} as never, "o", "r", "main")).toBe("unknown");
  });
});

describe("strict candidate", () => {
  test("eligible Jumi PR with automerge is candidate", () => {
    expect(isStrictRefreshCandidate(jumiPull(), "o", "r", "jumi")).toBe(true);
  });
  test("draft is never written", () => {
    expect(isStrictRefreshCandidate(jumiPull({ draft: true }), "o", "r", "jumi")).toBe(false);
  });
  test("fork is never written", () => {
    const fork = jumiPull();
    fork.head.repo = { full_name: "fork/r", clone_url: "https://github.com/fork/r.git" };
    expect(isStrictRefreshCandidate(fork, "o", "r", "jumi")).toBe(false);
  });
  test("human PR without automerge is never written", () => {
    const human = jumiPull({ user: { login: "alice" }, autoMergeEnabled: undefined });
    human.head = { ref: "feature", sha: "headsha", repo: { full_name: "o/r", clone_url: "x" } };
    expect(isStrictRefreshCandidate(human, "o", "r", "jumi")).toBe(false);
  });
  test("automerge not armed is never written", () => {
    expect(isStrictRefreshCandidate(jumiPull({ autoMergeEnabled: false }), "o", "r", "jumi")).toBe(false);
  });
  test("closed or merged is never written", () => {
    expect(isStrictRefreshCandidate(jumiPull({ state: "closed" as const }), "o", "r", "jumi")).toBe(false);
    expect(isStrictRefreshCandidate(jumiPull({ merged: true }), "o", "r", "jumi")).toBe(false);
  });
});

describe("strict push enqueue", () => {
  function strictApi(strict: boolean | undefined) {
    return {
      listOpenPulls: async () => [jumiPull()],
      getBranch: async () =>
        strict === undefined ? ({ protected: true } as never) : ({ protected: true, strict } as never),
    } as never;
  }
  test("enqueues merge-only strict job on target-branch push when strict", async () => {
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), policy, strictApi(true));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.mergeOnly).toBe(true);
    expect((jobs[0] as { strictRefresh?: boolean }).strictRefresh).toBe(true);
    expect(jobs[0]?.mode).toBe("follow-up");
    expect(jobs[0]?.prNumber).toBe(127);
    expect(jobs[0]?.headSha).toBe("headsha");
  });
  test("off stays silent", async () => {
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), policy, strictApi(false));
    expect(jobs).toHaveLength(0);
  });
  test("unknown stays silent (unreadable is not permission)", async () => {
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), policy, strictApi(undefined));
    expect(jobs).toHaveLength(0);
    const throwing = {
      listOpenPulls: async () => [jumiPull()],
      getBranch: async () => {
        throw new Error("x → 403");
      },
    } as never;
    const second = await shouldEnqueueStrictRefreshOnPush(pushPayload(), policy, throwing);
    expect(second.jobs).toHaveLength(0);
  });
  test("ineligible PRs are never written", async () => {
    const api = {
      listOpenPulls: async () => [jumiPull({ draft: true }), jumiPull({ number: 128, autoMergeEnabled: false })],
      getBranch: async () => ({ protected: true, strict: true }) as never,
    } as never;
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), policy, api);
    expect(jobs).toHaveLength(0);
  });
  test("only PRs targeting the pushed branch wake", async () => {
    const other = jumiPull();
    other.base = { ref: "develop", sha: "x" };
    const api = {
      listOpenPulls: async () => [other],
      getBranch: async () => ({ protected: true, strict: true }) as never,
    } as never;
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), policy, api);
    expect(jobs).toHaveLength(0);
  });
  test("repeated base pushes coalesce to the latest tip", async () => {
    const api = strictApi(true);
    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base2"), policy, api);
    const second = await shouldEnqueueStrictRefreshOnPush(pushPayload("base3"), policy, api);
    expect(first.jobs[0]?.strictBaseSha).toBe("base2");
    expect(second.jobs[0]?.strictBaseSha).toBe("base3");
    // The worker merges the latest tip it fetches, so the second job
    // supersedes the first; deduplication is by head+base via the worker key.
    expect(first.jobs[0]?.headSha).toBe(second.jobs[0]?.headSha);
  });
});

describe("strict PR-activity reconcile", () => {
  test("already-behind PR is picked up without waiting for another base push", async () => {
    const api = { getBranch: async () => ({ protected: true, strict: true }) } as never;
    const job = await shouldEnqueueStrictRefreshForPR({
      pr: jumiPull(),
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: policy as never,
      api,
    });
    expect(job?.mergeOnly).toBe(true);
    expect(job?.strictRefresh).toBe(true);
  });
  test("strict off or unknown needs no refresh", async () => {
    for (const strict of [false, undefined]) {
      const api = {
        getBranch: async () => ({ protected: true, ...(strict === undefined ? {} : { strict }) }),
      } as never;
      const job = await shouldEnqueueStrictRefreshForPR({
        pr: jumiPull(),
        owner: "o",
        repo: "r",
        defaultBranch: "main",
        cloneUrl: "https://github.com/o/r.git",
        policy: policy as never,
        api,
      });
      expect(job).toBeNull();
    }
  });
  test("ineligible PR activity never enqueues", async () => {
    const api = { getBranch: async () => ({ protected: true, strict: true }) } as never;
    const job = await shouldEnqueueStrictRefreshForPR({
      pr: jumiPull({ draft: true }),
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: policy as never,
      api,
    });
    expect(job).toBeNull();
  });
});

describe("strict worker rechecks", () => {
  test("competing head update skips without writing", () => {
    expect(
      strictRecheckSkipReason({
        fresh: jumiPull({ head: { ref: "jumi/issue-12-fix", sha: "newsha", repo: { full_name: "o/r" } } }),
        expectedHeadSha: "headsha",
        strict: "strict",
      })
    ).toBe("strict refresh: competing head update");
  });
  test("automerge cancelled during refresh never re-arms (skip without writing)", () => {
    expect(
      strictRecheckSkipReason({
        fresh: jumiPull({ autoMergeEnabled: false }),
        expectedHeadSha: "headsha",
        strict: "strict",
      })
    ).toBe("strict refresh: auto-merge no longer armed");
  });
  test("strictness off or unknown skips", () => {
    expect(strictRecheckSkipReason({ fresh: jumiPull(), expectedHeadSha: "headsha", strict: "off" })).toBe(
      "strict refresh: strictness off or unknown"
    );
    expect(strictRecheckSkipReason({ fresh: jumiPull(), expectedHeadSha: "headsha", strict: "unknown" })).toBe(
      "strict refresh: strictness off or unknown"
    );
  });
  test("eligible refresh proceeds", () => {
    expect(strictRecheckSkipReason({ fresh: jumiPull(), expectedHeadSha: "headsha", strict: "strict" })).toBeNull();
    expect(strictRecheckSkipReason({ fresh: jumiPull(), expectedHeadSha: "HEADSHA", strict: "strict" })).toBeNull();
  });
});

describe("strict review deferral", () => {
  test("wait marker round-trips through the shared prefix", () => {
    expect(STRICT_REFRESH_WAIT_PREFIX).toBe("strict-refresh-wait:");
    const marker = encodeStrictRefreshWait(123);
    expect(parseStrictRefreshWait(marker)).toEqual({ firstSeen: 123 });
    expect(parseStrictRefreshWait(null)).toBeUndefined();
    expect(parseStrictRefreshWait("ci-wait-pending:123")).toBeUndefined();
  });
  test("parked review takes no reviewer slot and promotes on same-head wake", async () => {
    const store = new MemoryReviewJobStore();
    const job = {
      owner: "o",
      repo: "r",
      prNumber: 127,
      headSha: "headsha",
      action: "synchronize",
      delivery: "d1",
      receivedAt: new Date().toISOString(),
      prUpdatedAt: new Date().toISOString(),
    } as never;
    const nowMs = Date.now();
    const parked = await store.enqueue(job, {
      waitUntilMs: nowMs + STRICT_REFRESH_WAIT_FALLBACK_MS,
      waitMarker: encodeStrictRefreshWait(nowMs),
      nowMs,
    });
    expect(parked.queued).toBe(true);
    expect(isStrictRefreshWaitMarker(encodeStrictRefreshWait(nowMs))).toBe(true);
    // Leased_until in the future: peekRunnable skips the parked row.
    const runnable = await store.peekRunnable(["review"] as never, 10, new Date(nowMs + 1000));
    expect(runnable).toHaveLength(0);
    // Same-head wake without wait promotes the parked row.
    const promoted = await store.enqueue(job, { nowMs: nowMs + 2000 });
    expect(promoted.queued).toBe(false);
    const afterFallback = await store.peekRunnable(["review"] as never, 10, new Date(nowMs + 2000));
    expect(afterFallback).toHaveLength(1);
  });
  test("new head cancels the parked stale head; fresh head runs normal flow", async () => {
    const store = new MemoryReviewJobStore();
    const stale = {
      owner: "o",
      repo: "r",
      prNumber: 127,
      headSha: "oldsha",
      action: "synchronize",
      delivery: "d1",
      receivedAt: new Date().toISOString(),
      prUpdatedAt: "2026-01-01T00:00:00.000Z",
    } as never;
    const nowMs = Date.now();
    await store.enqueue(stale, {
      waitUntilMs: nowMs + STRICT_REFRESH_WAIT_FALLBACK_MS,
      waitMarker: encodeStrictRefreshWait(nowMs),
      nowMs,
    });
    const fresh = {
      owner: "o",
      repo: "r",
      prNumber: 127,
      headSha: "newsha",
      action: "synchronize",
      delivery: "d2",
      receivedAt: new Date().toISOString(),
      prUpdatedAt: "2026-01-02T00:00:00.000Z",
    } as never;
    const enqueued = await store.enqueue(fresh);
    expect(enqueued.queued).toBe(true);
    const runnable = await store.peekRunnable(["review"] as never, 10, new Date(nowMs + 1000));
    expect(runnable.map((row) => row.headSha)).toEqual(["newsha"]);
  });
  test("failed refresh does not leave the review stuck waiting", async () => {
    const store = new MemoryReviewJobStore();
    const job = {
      owner: "o",
      repo: "r",
      prNumber: 127,
      headSha: "headsha",
      action: "synchronize",
      delivery: "d1",
      receivedAt: new Date().toISOString(),
      prUpdatedAt: new Date().toISOString(),
    } as never;
    const nowMs = Date.now();
    await store.enqueue(job, {
      waitUntilMs: nowMs + STRICT_REFRESH_WAIT_FALLBACK_MS,
      waitMarker: encodeStrictRefreshWait(nowMs),
      nowMs,
    });
    // A same-head dispatchable wake (refresh failed/cancelled) promotes.
    await store.enqueue(job, { nowMs: nowMs + 5000 });
    const runnable = await store.peekRunnable(["review"] as never, 10, new Date(nowMs + 5000));
    expect(runnable).toHaveLength(1);
  });
});

describe("two-PR strict sequence", () => {
  test("first merges, second refreshes, fresh CI/review decides on the new head", async () => {
    // Both PRs start green with strict on and auto-merge armed.
    const strictApi = { getBranch: async () => ({ protected: true, strict: true }) } as never;
    const first = jumiPull({
      number: 100,
      head: { ref: "jumi/issue-10-fix", sha: "sha-first", repo: { full_name: "o/r" } },
    });
    const second = jumiPull({
      number: 127,
      head: { ref: "jumi/issue-12-fix", sha: "sha-second", repo: { full_name: "o/r" } },
    });
    expect(isStrictRefreshCandidate(first, "o", "r", "jumi")).toBe(true);
    expect(isStrictRefreshCandidate(second, "o", "r", "jumi")).toBe(true);
    expect(await resolveStrictPolicy(strictApi, "o", "r", "main")).toBe("strict");

    // The first merges: a push to main with the new tip.
    const api = {
      listOpenPulls: async () => [second],
      getBranch: async () => ({ protected: true, strict: true }),
    } as never;
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-after-first"), policy, api);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prNumber).toBe(127);

    // The refresh rechecks eligibility, head and auto-merge before writing,
    // then merges the latest tip it fetches (no manual update).
    expect(strictRecheckSkipReason({ fresh: second, expectedHeadSha: "sha-second", strict: "strict" })).toBeNull();

    // Passing new head: fresh CI/review runs on the new head, not the old verdict.
    const refreshed = { ...second, head: { ref: second.head.ref, sha: "sha-second-new", repo: second.head.repo } };
    expect(strictRecheckSkipReason({ fresh: refreshed, expectedHeadSha: "sha-second", strict: "strict" })).toBe(
      "strict refresh: competing head update"
    );

    // Failing new head: red CI means the PR cannot merge even after refresh.
    // The worker's fresh inspection would see the failure; the stale verdict
    // is never reused because the review key includes the new head.
    const store = new MemoryReviewJobStore();
    const staleReview = {
      owner: "o",
      repo: "r",
      prNumber: 127,
      headSha: "sha-second",
      action: "synchronize",
      delivery: "d1",
      receivedAt: new Date().toISOString(),
      prUpdatedAt: "2026-01-01T00:00:00.000Z",
    } as never;
    const nowMs = Date.now();
    await store.enqueue(staleReview, {
      waitUntilMs: nowMs + STRICT_REFRESH_WAIT_FALLBACK_MS,
      waitMarker: encodeStrictRefreshWait(nowMs),
      nowMs,
    });
    const freshReview = {
      owner: "o",
      repo: "r",
      prNumber: 127,
      headSha: "sha-second-new",
      action: "synchronize",
      delivery: "d2",
      receivedAt: new Date().toISOString(),
      prUpdatedAt: "2026-01-02T00:00:00.000Z",
    } as never;
    const result = await store.enqueue(freshReview);
    expect(result.queued).toBe(true);
    const runnable = await store.peekRunnable(["review"] as never, 10, new Date(nowMs + 1000));
    expect(runnable.map((row) => row.headSha)).toEqual(["sha-second-new"]);
  });
});

describe("strict behind signal", () => {
  test("only mergeable_state behind parks", () => {
    expect(isStrictRefreshBehind(jumiPull({ mergeableState: "behind" }))).toBe(true);
    expect(isStrictRefreshBehind(jumiPull({ mergeableState: "BEHIND" }))).toBe(true);
    for (const state of ["clean", "blocked", "dirty", "unstable", "unknown", "draft", "has_hooks"] as const) {
      expect(isStrictRefreshBehind(jumiPull({ mergeableState: state }))).toBe(false);
    }
    expect(isStrictRefreshBehind(jumiPull())).toBe(false);
  });
});

describe("strict ignore-conflicts guard", () => {
  const foreignCommit = { author: { login: "alice" }, committer: { login: "alice" } };
  const jumiCommit = { author: { login: "jumi" }, committer: { login: "jumi" } };
  function labeledPull(): Pull {
    return jumiPull({ labels: [{ name: "ignore-conflicts" }] });
  }
  test("labeled PR without a Jumi commit is left to the author", async () => {
    const api = { listPullCommits: async () => [foreignCommit] } as never;
    expect(await isStrictRefreshLeftToAuthor(api, "o", "r", labeledPull(), { botUsername: "jumi" })).toBe(true);
  });
  test("labeled PR with a Jumi commit is not left", async () => {
    const api = { listPullCommits: async () => [foreignCommit, jumiCommit] } as never;
    expect(await isStrictRefreshLeftToAuthor(api, "o", "r", labeledPull(), { botUsername: "jumi" })).toBe(false);
  });
  test("unlabeled PR is never left", async () => {
    const api = { listPullCommits: async () => [foreignCommit] } as never;
    expect(await isStrictRefreshLeftToAuthor(api, "o", "r", jumiPull(), { botUsername: "jumi" })).toBe(false);
  });
  test("unreadable settings fail closed (left)", async () => {
    const api = {
      listPullCommits: async () => [foreignCommit],
      getRepoFile: async () => {
        throw new Error("github GET /repos/o/r/contents/.jumi.yml → 500");
      },
    } as never;
    expect(
      await isStrictRefreshLeftToAuthor(api, "o", "r", labeledPull(), { botUsername: "jumi", defaultBranch: "main" })
    ).toBe(true);
  });
  test("push enqueue skips left-to-author PRs", async () => {
    const api = {
      listOpenPulls: async () => [labeledPull()],
      getBranch: async () => ({ protected: true, strict: true }) as never,
      listPullCommits: async () => [foreignCommit],
    } as never;
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload("base2"), policy, api);
    expect(jobs).toHaveLength(0);
  });
  test("PR-activity enqueue skips left-to-author PRs", async () => {
    const api = {
      getBranch: async () => ({ protected: true, strict: true }),
      listPullCommits: async () => [foreignCommit],
    } as never;
    const job = await shouldEnqueueStrictRefreshForPR({
      pr: labeledPull(),
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: policy as never,
      api,
    });
    expect(job).toBeNull();
  });
  test("worker recheck refuses to write left-to-author PRs", async () => {
    const pr = labeledPull();
    const api = {
      getPR: async () => pr,
      getBranch: async () => ({ protected: true, strict: true }),
      listPullCommits: async () => [foreignCommit],
    } as never;
    const { skipReason } = await recheckStrictRefreshEligibility({
      api,
      owner: "o",
      repo: "r",
      prNumber: 127,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      defaultBranch: "main",
    });
    expect(skipReason).toBe("strict refresh: left to author (ignore-conflicts)");
  });
  test("worker recheck proceeds for eligible PRs and still blocks competing heads", async () => {
    const pr = jumiPull();
    const baseApi = {
      getPR: async () => pr,
      getBranch: async () => ({ protected: true, strict: true }),
    };
    const ok = await recheckStrictRefreshEligibility({
      api: baseApi as never,
      owner: "o",
      repo: "r",
      prNumber: 127,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      defaultBranch: "main",
    });
    expect(ok.skipReason).toBeNull();
    expect(ok.fresh?.number).toBe(127);
    const moved = await recheckStrictRefreshEligibility({
      api: { ...baseApi, getPR: async () => ({ ...pr, head: { ...pr.head, sha: "newsha" } }) } as never,
      owner: "o",
      repo: "r",
      prNumber: 127,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      defaultBranch: "main",
    });
    expect(moved.skipReason).toBe("strict refresh: competing head update");
  });
});
