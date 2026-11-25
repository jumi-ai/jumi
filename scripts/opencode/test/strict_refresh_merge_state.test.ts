import { describe, expect, test } from "bun:test";
import type { Check, Pull } from "../src/ports.ts";
import { shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import { MemoryStrictRefreshSlotStore } from "../src/strict_refresh_queue.ts";

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

function pushPayload(after = "base-2") {
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
  } as never;
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

/**
 * GitHub-shaped fake: the open-pull list carries no merge state (as the live
 * list endpoint), while getPR returns the real merge state per PR.
 */
function githubApi(opts: {
  list: Pull[];
  fresh: Record<number, Pull>;
  requiredContexts?: string[];
  statuses?: Record<string, Check[]>;
  counts?: { getPR: number; listOpenPulls: number; getBranch: number };
}) {
  const counts = opts.counts ?? { getPR: 0, listOpenPulls: 0, getBranch: 0 };
  return {
    api: {
      listOpenPulls: async () => {
        counts.listOpenPulls += 1;
        return opts.list;
      },
      getPR: async (_owner: string, _repo: string, index: number) => {
        counts.getPR += 1;
        const fresh = opts.fresh[index];
        if (!fresh) throw new Error(`GitHub pull request #${index} unreadable`);
        return fresh;
      },
      getBranch: async () => {
        counts.getBranch += 1;
        return { protected: true, strict: true, requiredContexts: opts.requiredContexts ?? ["ci"] };
      },
      listCommitStatuses: async (_owner: string, _repo: string, sha: string) => opts.statuses?.[sha] ?? [],
      listCheckRuns: async () => [],
    } as never,
    counts,
  };
}

describe("strict refresh real merge state (#876)", () => {
  test("older conflict and older failed check are skipped; newer ready PR is admitted", async () => {
    const list = [jumiPull(100), jumiPull(101), jumiPull(102)];
    const { api, counts } = githubApi({
      list,
      fresh: {
        100: jumiPull(100, { mergeable: false }),
        101: jumiPull(101, { mergeableState: "blocked" }),
        102: jumiPull(102, { mergeableState: "behind" }),
      },
      statuses: { "head-101": [checkState("failure")], "head-102": [checkState("success")] },
    });
    const slots = new MemoryStrictRefreshSlotStore();
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1000);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prNumber).toBe(102);
    // Bounded by the candidates inspected: one getPR per inspected candidate.
    expect(counts.getPR).toBe(3);
  });

  test("counter-case: the older ready PR is admitted first with a single getPR", async () => {
    const list = [jumiPull(100), jumiPull(101)];
    const { api, counts } = githubApi({
      list,
      fresh: {
        100: jumiPull(100, { mergeableState: "behind" }),
        101: jumiPull(101, { mergeableState: "behind" }),
      },
    });
    const slots = new MemoryStrictRefreshSlotStore();
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1000);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prNumber).toBe(100);
    // Stops at the first ready candidate: the newer PR is never fetched.
    expect(counts.getPR).toBe(1);
  });

  test("holder with pending required checks keeps the slot; no other PR is admitted", async () => {
    const list = [jumiPull(100), jumiPull(101)];
    const fresh: Record<number, Pull> = {
      100: jumiPull(100, { mergeableState: "behind" }),
      101: jumiPull(101, { mergeableState: "behind" }),
    };
    const statuses: Record<string, Check[]> = {};
    const { api, counts } = githubApi({ list, fresh, statuses });
    const slots = new MemoryStrictRefreshSlotStore();
    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1000);
    expect(first.jobs[0]?.prNumber).toBe(100);

    // The holder's refresh starts CI: mergeable_state flips to blocked with
    // the required check still pending. The slot must stay held.
    fresh[100] = jumiPull(100, { mergeableState: "blocked" });
    statuses["head-100"] = [checkState("pending")];
    counts.getPR = 0;
    const second = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 2000);
    expect(second.jobs).toHaveLength(0);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
    expect(await slots.getTerminal("o", "r", "main")).toBeUndefined();
    // Only the holder is inspected; the waiting PR is never fetched.
    expect(counts.getPR).toBe(1);
  });

  test("holder with a failed required check releases as blocked; next ready PR is admitted", async () => {
    const list = [jumiPull(100), jumiPull(101)];
    const fresh: Record<number, Pull> = {
      100: jumiPull(100, { mergeableState: "behind" }),
      101: jumiPull(101, { mergeableState: "behind" }),
    };
    const statuses: Record<string, Check[]> = {};
    const { api } = githubApi({ list, fresh, statuses });
    const slots = new MemoryStrictRefreshSlotStore();
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1000);

    fresh[100] = jumiPull(100, { mergeableState: "blocked" });
    statuses["head-100"] = [checkState("failure")];
    const next = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 2000);
    expect(next.jobs).toHaveLength(1);
    expect(next.jobs[0]?.prNumber).toBe(101);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(101);
    expect(await slots.getTerminal("o", "r", "main")).toMatchObject({ prNumber: 100, reason: "blocked" });
  });
});
