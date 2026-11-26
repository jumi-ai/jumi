import { describe, expect, test } from "bun:test";
import type { Pull } from "../src/ports.ts";
import { workerJobKey } from "../src/review_jobs.ts";
import { shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import { MemoryStrictRefreshSlotStore, STRICT_REFRESH_MAX_LAPS } from "../src/strict_refresh_queue.ts";

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

function pushPayload(after: string): any {
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

function strictApi(pulls: Pull[]) {
  return {
    listOpenPulls: async () => pulls,
    getBranch: async () => ({ protected: true, strict: true }) as never,
    listCommitStatuses: async () => [{ context: "jumi/opencode-review", state: "success" }],
    listCheckRuns: async () => [],
  } as never;
}

describe("strict re-refresh on base move (#874)", () => {
  test("holder re-refreshes once per new base; duplicate delivery is a no-op; head-only is not a refresh", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const holder = jumiPull(863);
    const waiting = jumiPull(864);
    const pulls = [holder, waiting];
    const api = strictApi(pulls);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-1"), policy, api, log, slots, 1_000);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]?.prNumber).toBe(863);
    expect(first.jobs[0]?.strictBaseSha).toBe("base-1");
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(863);

    // Base moves past the holder (another PR merged without the slot).
    const second = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 2_000);
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0]?.prNumber).toBe(863);
    expect(second.jobs[0]?.strictBaseSha).toBe("base-2");
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(863);
    expect((await slots.getSlot("o", "r", "main"))?.laps).toBe(1);
    expect(logs.some((m) => m.includes("re-refresh #863 for base base-2") && m.includes("(lap 1/"))).toBe(true);

    // Duplicate delivery for the same (head, base) tip: no second job.
    const dup = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 3_000);
    expect(dup.jobs).toHaveLength(0);
    expect((await slots.getSlot("o", "r", "main"))?.laps).toBe(1);

    // Head-only move (the refresh commit landing): touch, no new job.
    const movedHead = jumiPull(863, {
      head: { ref: holder.head.ref, sha: "head-863-new", repo: holder.head.repo },
    });
    const headApi = strictApi([movedHead, waiting]);
    const headMove = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, headApi, log, slots, 4_000);
    expect(headMove.jobs).toHaveLength(0);
    const slotAfterHead = await slots.getSlot("o", "r", "main");
    expect(slotAfterHead?.prNumber).toBe(863);
    expect(slotAfterHead?.headSha).toBe("head-863-new");
    expect(slotAfterHead?.laps).toBe(1);
  });

  test("base moves past the lap budget release the slot with reason laps and admit the next", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const holder = jumiPull(863);
    const next = jumiPull(864);
    const pulls = [holder, next];
    const api = strictApi(pulls);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-1"), policy, api, log, slots, 1_000);
    for (let i = 2; i <= 1 + STRICT_REFRESH_MAX_LAPS; i++) {
      const res = await shouldEnqueueStrictRefreshOnPush(pushPayload(`base-${i}`), policy, api, log, slots, i * 1_000);
      expect(res.jobs).toHaveLength(1);
      expect(res.jobs[0]?.prNumber).toBe(863);
    }
    expect((await slots.getSlot("o", "r", "main"))?.laps).toBe(STRICT_REFRESH_MAX_LAPS);

    // One more base move exceeds the budget: release with laps, admit the next.
    const exceeded = await shouldEnqueueStrictRefreshOnPush(
      pushPayload(`base-${2 + STRICT_REFRESH_MAX_LAPS}`),
      policy,
      api,
      log,
      slots,
      99_000
    );
    expect(exceeded.jobs).toHaveLength(1);
    expect(exceeded.jobs[0]?.prNumber).toBe(864);
    expect(logs.some((m) => m.includes("exceeded refresh laps") && m.includes("#863"))).toBe(true);
    const terminal = await slots.getTerminal("o", "r", "main");
    expect(terminal?.reason).toBe("laps");
    expect(terminal?.prNumber).toBe(863);

    // The released holder is not re-admitted at the same (head, base).
    const again = await shouldEnqueueStrictRefreshOnPush(
      pushPayload(`base-${2 + STRICT_REFRESH_MAX_LAPS}`),
      policy,
      api,
      log,
      slots,
      100_000
    );
    expect(again.jobs).toHaveLength(0);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(864);
  });

  test("strict refresh worker key is head+base: same tip dedupes, new base supersedes", async () => {
    const baseJob = {
      owner: "o",
      repo: "r",
      issueNumber: 1863,
      action: "push",
      title: "t",
      body: "",
      htmlUrl: "",
      issueUpdatedAt: "",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      mode: "follow-up",
      prNumber: 863,
      headSha: "head-863",
      trigger: { event: "push" },
      mergeOnly: true,
      strictRefresh: true,
      strictBaseSha: "base-2",
    } as unknown as import("../src/types.ts").IssueJob;
    const sameTip = { ...baseJob };
    const newBase = { ...baseJob, strictBaseSha: "base-3" };
    expect(workerJobKey(sameTip)).toBe(workerJobKey(baseJob));
    expect(workerJobKey(newBase)).not.toBe(workerJobKey(baseJob));
  });
});
