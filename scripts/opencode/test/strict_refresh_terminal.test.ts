import { describe, expect, test } from "bun:test";
import type { Pull } from "../src/ports.ts";
import { shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import { MemoryStrictRefreshSlotStore, STRICT_REFRESH_SLOT_TIMEOUT_MS } from "../src/strict_refresh_queue.ts";
import {
  expireStrictRefreshSlotsOnTick,
  isStrictRefreshRetryableSkipReason,
  releaseStrictSlotForTerminalJob,
  STRICT_REFRESH_JOB_ENDED_TERMINAL_REASON,
  settleStrictSlotForWorkerOutcome,
  shouldReleaseStrictSlotForTerminalOutcome,
} from "../src/strict_refresh_terminal.ts";
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

function strictApi(pulls: Pull[], listOpenPulls?: () => Promise<Pull[]>) {
  return {
    listOpenPulls: listOpenPulls ?? (async () => pulls),
    getBranch: async () => ({ protected: true, strict: true }) as never,
    getRepo: async () => ({
      full_name: "o/r",
      html_url: "https://github.com/o/r",
      clone_url: "https://github.com/o/r.git",
      default_branch: "main",
    }),
    listCommitStatuses: async () => [{ context: "jumi/opencode-review", state: "success" }],
    listCheckRuns: async () => [],
  } as never;
}

function strictJob(prNumber: number, headSha: string, baseSha: string): IssueJob {
  return {
    delivery: "d1",
    owner: "o",
    repo: "r",
    issueNumber: 1000 + prNumber,
    action: "push",
    title: `Fix ${prNumber}`,
    body: `Fixes #${1000 + prNumber}`,
    htmlUrl: `https://github.com/o/r/pull/${prNumber}`,
    issueUpdatedAt: new Date().toISOString(),
    defaultBranch: "main",
    cloneUrl: "https://github.com/o/r.git",
    receivedAt: new Date().toISOString(),
    mode: "follow-up",
    prNumber,
    headSha,
    mergeOnly: true,
    strictRefresh: true,
    strictBaseSha: baseSha,
  };
}

const TERMINAL_SKIP_REASONS = [
  "strict refresh: competing head update",
  "strict refresh: strictness off",
  "strict refresh: auto-merge no longer armed",
  "strict refresh: closing issue not picked up or closed",
  "strict refresh: not eligible",
  "strict refresh: left to author (ignore-conflicts)",
  "strict refresh: not behind",
  "strict refresh: branch writer refused the merge",
];

describe("strict terminal release on job outcome (#875)", () => {
  test.each(TERMINAL_SKIP_REASONS)("skipped %p releases the slot and admits the next ready PR", async (reason) => {
    const slots = new MemoryStrictRefreshSlotStore();
    const holder = jumiPull(100);
    const next = jumiPull(101);
    const api = strictApi([holder, next]);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 1_000);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]?.prNumber).toBe(100);

    const released = await settleStrictSlotForWorkerOutcome({
      slots,
      job: strictJob(100, "head-100", "base-2"),
      status: "skipped",
      reason,
      log,
      nowMs: 2_000,
    });
    expect(released).toBe(true);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
    expect(await slots.getTerminal("o", "r", "main")).toMatchObject({
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-2",
      reason: STRICT_REFRESH_JOB_ENDED_TERMINAL_REASON,
    });
    expect(logs.some((m) => m.includes("released (holder #100 job ended:"))).toBe(true);

    // The released holder is not re-admitted at the same (head, base); the next oldest ready PR is.
    const admitted = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 3_000);
    expect(admitted.jobs).toHaveLength(1);
    expect(admitted.jobs[0]?.prNumber).toBe(101);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(101);
  });

  test("failed without retries left releases the slot with job-ended", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const holder = jumiPull(100);
    const next = jumiPull(101);
    const api = strictApi([holder, next]);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 1_000);
    const released = await settleStrictSlotForWorkerOutcome({
      slots,
      job: strictJob(100, "head-100", "base-2"),
      status: "failed",
      reason: "Jumi failed: max attempts exceeded",
      log,
      nowMs: 2_000,
    });
    expect(released).toBe(true);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
    expect((await slots.getTerminal("o", "r", "main"))?.reason).toBe(STRICT_REFRESH_JOB_ENDED_TERMINAL_REASON);

    const admitted = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 3_000);
    expect(admitted.jobs).toHaveLength(1);
    expect(admitted.jobs[0]?.prNumber).toBe(101);
  });

  test("branch writer busy (retryable) keeps the slot; success keeps the slot", async () => {
    for (const outcome of [
      { status: "skipped", reason: "strict refresh: branch writer busy; retry after writer finishes (claimed)" },
      { status: "pushed", reason: undefined },
      { status: "no-changes", reason: "no-changes" },
    ] as const) {
      const slots = new MemoryStrictRefreshSlotStore();
      const api = strictApi([jumiPull(100), jumiPull(101)]);
      await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
      const released = await settleStrictSlotForWorkerOutcome({
        slots,
        job: strictJob(100, "head-100", "base-2"),
        status: outcome.status,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        nowMs: 2_000,
      });
      expect(released).toBe(false);
      expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
      expect(await slots.getTerminal("o", "r", "main")).toBeUndefined();
    }
    expect(isStrictRefreshRetryableSkipReason("strict refresh: branch writer busy; retry later")).toBe(true);
    expect(isStrictRefreshRetryableSkipReason("strict refresh: competing head update")).toBe(false);
    expect(
      shouldReleaseStrictSlotForTerminalOutcome({ strictRefresh: true, mergeOnly: true, prNumber: 1 }, "skipped")
    ).toBe(true);
    expect(
      shouldReleaseStrictSlotForTerminalOutcome({ strictRefresh: true, mergeOnly: true, prNumber: 1 }, "cancelled")
    ).toBe(false);
    expect(shouldReleaseStrictSlotForTerminalOutcome({ mergeOnly: true, prNumber: 1 }, "failed")).toBe(false);
  });

  test("a stale result for an older admission does not release the newer holder", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = strictApi([jumiPull(100), jumiPull(101)]);
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    // The holder's job ends stale: the slot moved on (newer admission for #101).
    await slots.release("o", "r", "main", { nowMs: 2_000 });
    expect(
      await slots.tryAdmit({
        owner: "o",
        repo: "r",
        baseBranch: "main",
        prNumber: 101,
        headSha: "head-101",
        baseSha: "base-2",
        admittedAtMs: 2_000,
        updatedAtMs: 2_000,
      })
    ).toBe(true);

    const logs: string[] = [];
    const stale = await releaseStrictSlotForTerminalJob({
      slots,
      owner: "o",
      repo: "r",
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-2",
      reason: "strict refresh: competing head update",
      log: (m) => logs.push(m),
      nowMs: 3_000,
    });
    expect(stale).toBe(false);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(101);
    expect(logs).toHaveLength(0);

    // A same-PR result for a superseded head does not release either.
    await slots.release("o", "r", "main", { nowMs: 4_000 });
    await slots.tryAdmit({
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 100,
      headSha: "head-100-new",
      baseSha: "base-2",
      admittedAtMs: 4_000,
      updatedAtMs: 4_000,
    });
    const superseded = await releaseStrictSlotForTerminalJob({
      slots,
      owner: "o",
      repo: "r",
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-2",
      reason: "strict refresh: competing head update",
      nowMs: 5_000,
    });
    expect(superseded).toBe(false);
    expect((await slots.getSlot("o", "r", "main"))?.headSha).toBe("head-100-new");
  });
});

describe("strict engine-tick expiry (#875)", () => {
  test("expired slot is released and the next ready PR admitted with one listOpenPulls", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const holder = jumiPull(100);
    const next = jumiPull(101);
    let listOpenPulls = 0;
    const api = strictApi([holder, next], async () => {
      listOpenPulls += 1;
      return [holder, next];
    });
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, log, slots, 1_000);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
    listOpenPulls = 0;

    const enqueued: IssueJob[] = [];
    const summary = await expireStrictRefreshSlotsOnTick({
      slots,
      api,
      policy,
      enqueueIssue: async (job) => {
        enqueued.push(job);
        return { queued: true, key: `k-${job.prNumber}` };
      },
      log,
      nowMs: 1_000 + STRICT_REFRESH_SLOT_TIMEOUT_MS + 1,
    });
    expect(summary).toEqual({ expired: 1, enqueued: 1 });
    expect(listOpenPulls).toBe(1);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(101);
    expect((await slots.getTerminal("o", "r", "main"))?.reason).toBe("timeout");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.prNumber).toBe(101);
    expect(enqueued[0]?.mergeOnly).toBe(true);
    expect(enqueued[0]?.strictRefresh).toBe(true);
    expect(logs.some((m) => m.includes("timed out for #100"))).toBe(true);
  });

  test("a tick with no expired slot makes no forge calls", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const freshApi = {
      listOpenPulls: async (): Promise<Pull[]> => {
        throw new Error("listOpenPulls must not be called");
      },
      getRepo: async () => {
        throw new Error("getRepo must not be called");
      },
      getBranch: async () => {
        throw new Error("getBranch must not be called");
      },
    } as never;
    await slots.tryAdmit({
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-2",
      admittedAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    let enqueued = 0;
    const summary = await expireStrictRefreshSlotsOnTick({
      slots,
      api: freshApi,
      policy,
      enqueueIssue: async () => {
        enqueued += 1;
        return { queued: true, key: "k" };
      },
      nowMs: 2_000,
    });
    expect(summary).toEqual({ expired: 0, enqueued: 0 });
    expect(enqueued).toBe(0);
    // The fresh slot is untouched.
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
  });
});
