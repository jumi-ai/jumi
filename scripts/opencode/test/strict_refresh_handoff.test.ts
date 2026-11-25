import { describe, expect, test } from "bun:test";
import type { Check, Pull } from "../src/ports.ts";
import { shouldEnqueueStrictRefreshForPR, shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import { MemoryStrictRefreshSlotStore, STRICT_REFRESH_SLOT_TIMEOUT_MS } from "../src/strict_refresh_queue.ts";
import { expireStrictRefreshSlotsOnTick } from "../src/strict_refresh_terminal.ts";
import type { IssueJob } from "../src/types.ts";

function jumiPull(number: number, overrides: Partial<Pull> = {}): Pull {
  const issue = 1000 + number;
  return {
    number,
    title: `Fix ${number}`,
    body: `Fixes #${issue}`,
    state: "open",
    html_url: `https://github.com/o/r/pull/${number}`,
    user: { login: "jumi" },
    head: {
      ref: `jumi/issue-${issue}-fix`,
      sha: `head-${number}`,
      repo: { full_name: "o/r", clone_url: "https://github.com/o/r.git" },
    },
    base: { ref: "main", sha: "base-1" },
    merged: false,
    draft: false,
    autoMergeEnabled: true,
    created_at: new Date(Date.UTC(2026, 4, 23, 0, 0, number)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 4, 23, 0, 0, number)).toISOString(),
    ...overrides,
  };
}

function pushPayload(after = "base-2"): any {
  return {
    ref: "refs/heads/main",
    before: "base-1",
    after,
    repository: {
      full_name: "o/r",
      default_branch: "main",
      clone_url: "https://github.com/o/r.git",
    },
    pusher: { login: "alice" },
    sender: { login: "alice" },
  };
}

const policy = {
  giteaUrl: "https://github.com",
  allowedOrgs: ["o"],
  allowedRepos: [],
  botUsername: "jumi",
} as never;

function checkState(state: Check["state"]): Check {
  return { context: "ci", state, status: state };
}

/** GitHub-shaped fake: list carries no merge state; getPR hydrates per PR. */
function githubApi(opts: {
  list: Pull[];
  fresh: Record<number, Pull>;
  statuses?: Record<string, Check[]>;
  counts?: { getPR: number };
}) {
  const counts = opts.counts ?? { getPR: 0 };
  return {
    api: {
      listOpenPulls: async () => opts.list,
      getPR: async (_o: string, _r: string, index: number) => {
        counts.getPR += 1;
        const fresh = opts.fresh[index];
        if (!fresh) throw new Error(`GitHub pull request #${index} unreadable`);
        return fresh;
      },
      getBranch: async () => ({ protected: true, strict: true, requiredContexts: ["ci"] }),
      listCommitStatuses: async (_o: string, _r: string, sha: string) => opts.statuses?.[sha] ?? [],
      listCheckRuns: async () => [],
      getRepo: async () => ({
        full_name: "o/r",
        html_url: "https://github.com/o/r",
        clone_url: "https://github.com/o/r.git",
        default_branch: "main",
      }),
    } as never,
    counts,
  };
}

describe("strict timeout handoff hands the slot to the next ready PR (#893)", () => {
  test("timed-out oldest holder with a second ready PR: the second is admitted and its job queued", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const list = [jumiPull(890), jumiPull(891)];
    const fresh: Record<number, Pull> = {
      890: jumiPull(890, { mergeableState: "behind" }),
      891: jumiPull(891, { mergeableState: "behind" }),
    };
    const statuses = { "head-890": [checkState("success")], "head-891": [checkState("success")] };
    const { api } = githubApi({ list, fresh, statuses });
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 1_000);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]?.prNumber).toBe(890);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(890);

    // The 2h engine-tick expiry fires on the same base tip: #890 times out,
    // the reconcile continues past it to #891 in the same pass.
    const timedOut = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      api,
      log,
      slots,
      1_000 + STRICT_REFRESH_SLOT_TIMEOUT_MS + 1
    );
    expect(timedOut.jobs).toHaveLength(1);
    expect(timedOut.jobs[0]?.prNumber).toBe(891);
    expect(timedOut.jobs[0]?.strictBaseSha).toBe("base-2");
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(891);
    expect(await slots.getTerminal("o", "r", "main")).toMatchObject({ prNumber: 890, reason: "timeout" });
    expect(logs.some((m) => m.includes("timed out for #890"))).toBe(true);
    expect(logs.some((m) => m.includes("admitted #891"))).toBe(true);
  });

  test("tick expiry admits the next ready PR and queues its job", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const list = [jumiPull(890), jumiPull(891)];
    const fresh: Record<number, Pull> = {
      890: jumiPull(890, { mergeableState: "behind" }),
      891: jumiPull(891, { mergeableState: "behind" }),
    };
    const statuses = { "head-890": [checkState("success")], "head-891": [checkState("success")] };
    const { api } = githubApi({ list, fresh, statuses });
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);

    const enqueued: IssueJob[] = [];
    const summary = await expireStrictRefreshSlotsOnTick({
      slots,
      api: api as never,
      policy,
      enqueueIssue: async (job) => {
        enqueued.push(job);
        return { queued: true, key: `k-${job.prNumber}` };
      },
      nowMs: 1_000 + STRICT_REFRESH_SLOT_TIMEOUT_MS + 1,
    });
    expect(summary).toEqual({ expired: 1, enqueued: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.prNumber).toBe(891);
    expect(enqueued[0]?.mergeOnly).toBe(true);
    expect(enqueued[0]?.strictRefresh).toBe(true);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(891);
  });
});

describe("strict newer-PR activity admits the oldest (#893)", () => {
  function simpleApi(pulls: Pull[]) {
    return {
      listOpenPulls: async () => pulls,
      getBranch: async () => ({ protected: true, strict: true }) as never,
    } as never;
  }

  test("activity on the newer PR returns the oldest PR's job and holds the slot", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const oldest = jumiPull(100);
    const newer = jumiPull(101);
    const api = simpleApi([oldest, newer]);
    const job = await shouldEnqueueStrictRefreshForPR({
      pr: newer,
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: policy as never,
      api,
      sender: "pull_request",
      slots,
      nowMs: 1_000,
    });
    expect(job?.prNumber).toBe(100);
    expect(job?.headSha).toBe("head-100");
    expect(job?.mergeOnly).toBe(true);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
  });

  test("once held, waiter activity stays quiet and the holder stays quiet", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const oldest = jumiPull(100);
    const newer = jumiPull(101);
    const api = simpleApi([oldest, newer]);
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    // Same base tip as the slot: the waiter must not enqueue a speculative refresh.
    const waiting = await shouldEnqueueStrictRefreshForPR({
      pr: { ...newer, base: { ref: "main", sha: "base-2" } },
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: policy as never,
      api,
      slots,
      nowMs: 2_000,
    });
    expect(waiting).toBeNull();
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
  });
});

describe("strict admission failure between admit and enqueue leaves no orphan (#893)", () => {
  function simpleApi(pulls: Pull[]) {
    return {
      listOpenPulls: async () => pulls,
      getBranch: async () => ({ protected: true, strict: true }) as never,
      getRepo: async () => ({
        full_name: "o/r",
        html_url: "https://github.com/o/r",
        clone_url: "https://github.com/o/r.git",
        default_branch: "main",
      }),
    } as never;
  }

  test("crash after admit (no enqueue) is healed by the tick from the durable intent", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = simpleApi([jumiPull(100)]);
    // Admit #100 but never enqueue: simulates a crash between admission and
    // the enqueue call. The slot must carry the durable intent.
    const admitted = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      api,
      undefined,
      slots,
      1_000
    );
    expect(admitted.jobs).toHaveLength(1);
    const held = await slots.getSlot("o", "r", "main");
    expect(held?.prNumber).toBe(100);
    expect(held?.pendingJob?.prNumber).toBe(100);
    expect(held?.pendingJob?.baseSha).toBe("base-2");

    // The next tick (slot not yet expired) drains the intent: the holder's
    // job is queued with no new forge reads, and the intent clears.
    const enqueued: IssueJob[] = [];
    const summary = await expireStrictRefreshSlotsOnTick({
      slots,
      api: api as never,
      policy,
      enqueueIssue: async (job) => {
        enqueued.push(job);
        return { queued: true, key: `k-${job.prNumber}` };
      },
      nowMs: 2_000,
    });
    expect(summary).toEqual({ expired: 0, enqueued: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.prNumber).toBe(100);
    expect(enqueued[0]?.headSha).toBe("head-100");
    expect(enqueued[0]?.strictBaseSha).toBe("base-2");
    const healed = await slots.getSlot("o", "r", "main");
    expect(healed?.prNumber).toBe(100);
    expect(healed?.pendingJob).toBeUndefined();
  });
});
