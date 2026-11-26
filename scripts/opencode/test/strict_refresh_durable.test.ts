import { describe, expect, test } from "bun:test";
import { buildBoardGroups } from "../src/board.ts";
import type { Pull } from "../src/ports.ts";
import { shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import {
  encodeStrictRetryMarker,
  parseStrictRetryMarker,
  STRICT_REFRESH_RETRY_BACKOFFS_MS,
  STRICT_REFRESH_RETRY_MAX_ATTEMPTS,
  STRICT_REFRESH_RETRY_PREFIX,
  strictRetryBackoffMs,
  transferStrictSlotOnEnqueue,
} from "../src/strict_refresh_obligation.ts";
import { MemoryStrictRefreshSlotStore, type StrictRefreshPhase } from "../src/strict_refresh_queue.ts";
import {
  expireStrictRefreshSlotsOnTick,
  isStrictRefreshRetryableSkipReason,
  listStrictNeedsKickBoardRows,
  selectStrictRefreshSuccessor,
  settleStrictSlotForCancelledJob,
  settleStrictSlotForWorkerOutcome,
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

function strictApi(pulls: Pull[]) {
  return {
    listOpenPulls: async () => pulls,
    getBranch: async (_o: string, _r: string, b: string) => ({ protected: true, strict: true, sha: "base-2" }) as never,
    getRepo: async () => ({
      full_name: "o/r",
      html_url: "https://github.com/o/r",
      clone_url: "https://github.com/o/r.git",
      default_branch: "main",
    }),
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

describe("strict durable obligation (#894)", () => {
  test("obligation helpers use the bounded retry budget", () => {
    expect(STRICT_REFRESH_RETRY_MAX_ATTEMPTS).toBe(5);
    expect(STRICT_REFRESH_RETRY_BACKOFFS_MS.length).toBeGreaterThan(0);
    expect(STRICT_REFRESH_RETRY_PREFIX).toBe("strict-refresh-retry:");
    expect(strictRetryBackoffMs(1)).toBeGreaterThan(0);
    const marker = encodeStrictRetryMarker(1, 1_000);
    expect(parseStrictRetryMarker(marker)).toMatchObject({ count: 1 });
    expect(isStrictRefreshRetryableSkipReason("503 Service Unavailable")).toBe(true);
    const phase: StrictRefreshPhase = "held";
    expect(phase).toBe("held");
  });

  test("superseded merge-only keeps the slot and the replacing job refreshes", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = strictApi([jumiPull(890), jumiPull(891)]);
    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]?.prNumber).toBe(890);
    const genBefore = (await slots.getSlot("o", "r", "main"))?.generation ?? 0;

    await transferStrictSlotOnEnqueue(
      slots,
      {
        owner: "o",
        repo: "r",
        prNumber: 890,
        headSha: "head-890-new",
        strictBaseSha: "base-2",
        issueNumber: 1890,
        title: "Fix 890",
        body: "Fixes #1890",
        htmlUrl: "https://github.com/o/r/pull/890",
        issueUpdatedAt: new Date(2_000).toISOString(),
        defaultBranch: "main",
        cloneUrl: "https://github.com/o/r.git",
      },
      2_000
    );
    const held = await slots.getSlot("o", "r", "main");
    expect(held?.prNumber).toBe(890);
    expect(held?.headSha).toBe("head-890-new");
    expect(held?.generation ?? 0).toBeGreaterThan(genBefore);
  });

  test("stopped job releases and admits next", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const holder = jumiPull(100);
    const next = jumiPull(101);
    const api = strictApi([holder, next]);
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);

    const settled = await settleStrictSlotForCancelledJob({
      slots,
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 100,
      headSha: "head-100",
      hasSuccessor: false,
      nowMs: 2_000,
    });
    expect(settled).toBe("admit-next");
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
    const due = await slots.listAdmitNextDue(2_000);
    expect(due).toHaveLength(1);

    const enqueued: IssueJob[] = [];
    const summary = await expireStrictRefreshSlotsOnTick({
      slots,
      api,
      policy,
      enqueueIssue: async (job) => {
        enqueued.push(job);
        return { queued: true, key: `k-${job.prNumber}` };
      },
      nowMs: 2_000,
    });
    expect(summary.enqueued).toBe(1);
    expect(enqueued[0]?.prNumber).toBe(100);
  });

  test("503 during re-check retries and does not blacklist", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = strictApi([jumiPull(100)]);
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    expect(isStrictRefreshRetryableSkipReason("strict refresh: pull request unreadable")).toBe(true);
    expect(isStrictRefreshRetryableSkipReason("strict refresh: strictness unknown")).toBe(true);
    expect(isStrictRefreshRetryableSkipReason("strict refresh: strictness off")).toBe(false);

    const released = await settleStrictSlotForWorkerOutcome({
      slots,
      job: strictJob(100, "head-100", "base-2"),
      status: "skipped",
      reason: "strict refresh: pull request unreadable",
      nowMs: 2_000,
    });
    expect(released).toBe(false);
    const held = await slots.getSlot("o", "r", "main");
    expect(held?.prNumber).toBe(100);
    expect(held?.phase).toBe("retry");
    expect(await slots.getTerminal("o", "r", "main")).toBeUndefined();
  });

  test("budget exhaustion produces the board row", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = strictApi([jumiPull(100)]);
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    for (let i = 0; i < 6; i += 1) {
      await settleStrictSlotForWorkerOutcome({
        slots,
        job: strictJob(100, "head-100", "base-2"),
        status: "skipped",
        reason: "strict refresh: pull request unreadable (503 Service Unavailable)",
        nowMs: 2_000 + i * 60_000,
      });
    }
    const held = await slots.getSlot("o", "r", "main");
    expect(held?.phase).toBe("needs-kick");
    const needs = await slots.listNeedsKick();
    expect(needs).toHaveLength(1);

    const groups = await buildBoardGroups(
      {
        listInflight: async () => [],
        sits: { list: async () => [] },
        strictSlots: slots,
      } as never,
      "gitea"
    );
    const listed = await listStrictNeedsKickBoardRows(slots);
    expect(listed).toHaveLength(1);
    const row = groups.needs_kick.find((item) => item.reason === "strict-refresh-needs-kick");
    expect(row).toBeDefined();
    expect(row?.message).toContain("main");
    expect(row?.message).toContain("#100");
    expect(row?.number).toBe(100);
  });

  test("stale release does not clobber a newer admission", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
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
    const first = await slots.getSlot("o", "r", "main");
    const ok = await slots.handoff("o", "r", "main", {
      expectedPrNumber: 100,
      expectedGeneration: first?.generation,
      next: {
        owner: "o",
        repo: "r",
        baseBranch: "main",
        prNumber: 101,
        headSha: "head-101",
        baseSha: "base-2",
        admittedAtMs: 2_000,
        updatedAtMs: 2_000,
      },
      nowMs: 2_000,
    });
    expect(ok).toBe(true);
    const stale = await slots.releaseIfHolder("o", "r", "main", 100, "head-100", {
      nowMs: 3_000,
      expectedGeneration: first?.generation,
    });
    expect(stale).toBe(false);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(101);
  });

  test("same-head enqueue transfer preserves the retry budget", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = strictApi([jumiPull(100)]);
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    const admitted = await slots.getSlot("o", "r", "main");
    expect(admitted?.prNumber).toBe(100);
    const generation = admitted?.generation ?? 0;
    const headSha = admitted?.headSha ?? "head-100";
    const baseSha = admitted?.baseSha ?? "base-2";

    for (let i = 0; i < 6; i += 1) {
      const now = 2_000 + i * 60_000;
      await settleStrictSlotForWorkerOutcome({
        slots,
        job: strictJob(100, headSha, baseSha),
        status: "skipped",
        reason: "strict refresh: pull request unreadable (503 Service Unavailable)",
        nowMs: now,
      });
      // The tick retry drain re-enqueues the stored intent through
      // transferStrictSlotOnEnqueue: a same-head handoff must not reset the
      // bounded budget, or needs-kick is never reached.
      await transferStrictSlotOnEnqueue(
        slots,
        {
          owner: "o",
          repo: "r",
          prNumber: 100,
          headSha,
          strictBaseSha: baseSha,
          issueNumber: 1100,
          title: "Fix 100",
          body: "Fixes #1100",
          htmlUrl: "https://github.com/o/r/pull/100",
          issueUpdatedAt: new Date(now + 1_000).toISOString(),
          defaultBranch: "main",
          cloneUrl: "https://github.com/o/r.git",
        },
        now + 1_000
      );
      const held = await slots.getSlot("o", "r", "main");
      if (i < 5) {
        expect(held?.phase).toBe("retry");
        expect(held?.generation).toBe(generation);
      }
    }
    expect((await slots.getSlot("o", "r", "main"))?.phase).toBe("needs-kick");
    expect(await slots.listNeedsKick()).toHaveLength(1);
  });

  test("cancelled settle picks the replacing strict-refresh follow-up", async () => {
    const rows = [
      {
        id: 1,
        jobKey: "implement:o/r#1100",
        kind: "implement",
        owner: "o",
        repo: "r",
        prNumber: 100,
        headSha: "head-100",
        issueNumber: 1100,
        payload: null,
      },
      {
        id: 2,
        jobKey: "follow-up:o/r#100:head-100",
        kind: "follow-up",
        owner: "o",
        repo: "r",
        prNumber: 100,
        headSha: "head-100",
        issueNumber: 1100,
        payload: { mergeOnly: true },
      },
      {
        id: 3,
        jobKey: "follow-up:o/r#100:head-100:base-1",
        kind: "follow-up",
        owner: "o",
        repo: "r",
        prNumber: 100,
        headSha: "head-100",
        issueNumber: 1100,
        payload: { strictRefresh: true, mergeOnly: true, strictBaseSha: "base-1", title: "old" },
      },
      {
        id: 4,
        jobKey: "follow-up:o/r#100:head-100-new:base-2",
        kind: "follow-up",
        owner: "o",
        repo: "r",
        prNumber: 100,
        headSha: "head-100-new",
        issueNumber: 1100,
        payload: {
          strictRefresh: true,
          mergeOnly: true,
          strictBaseSha: "base-2",
          title: "Fix 100",
          body: "Fixes #1100",
          htmlUrl: "https://github.com/o/r/pull/100",
          issueUpdatedAt: new Date(2_000).toISOString(),
          defaultBranch: "main",
          cloneUrl: "https://github.com/o/r.git",
        },
      },
    ];
    const opts = {
      owner: "o",
      repo: "r",
      prNumber: 100,
      excludeJobKey: "follow-up:o/r#100:head-100:base-1",
      fallbackHeadSha: "head-100",
      fallbackBaseSha: "base-1",
    };
    const next = selectStrictRefreshSuccessor(rows, opts);
    expect(next?.headSha).toBe("head-100-new");
    expect(next?.baseSha).toBe("base-2");
    expect(next?.pendingJob).toMatchObject({
      owner: "o",
      repo: "r",
      issueNumber: 1100,
      prNumber: 100,
      headSha: "head-100-new",
      baseSha: "base-2",
      title: "Fix 100",
    });
    // The cancelled job itself never counts as its own successor: excluding
    // the newest strict row falls back to the older strict follow-up, not to
    // the implement or non-strict rows.
    const older = selectStrictRefreshSuccessor(rows, {
      ...opts,
      excludeJobKey: "follow-up:o/r#100:head-100-new:base-2",
    });
    expect(older?.headSha).toBe("head-100");
    expect(older?.baseSha).toBe("base-1");
    expect(selectStrictRefreshSuccessor(rows.slice(0, 2), opts)).toBeUndefined();
  });

  test("strict needs-kick hides while its follow-up is inflight", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
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
    const generation = (await slots.getSlot("o", "r", "main"))?.generation ?? 1;
    await slots.markNeedsKick("o", "r", "main", generation, "strict refresh: pull request unreadable", 2_000);

    const followUp = {
      id: 7,
      jobKey: "follow-up:o/r#100:head-100",
      kind: "follow-up",
      owner: "o",
      repo: "r",
      prNumber: 100,
      headSha: "head-100",
      issueNumber: 1100,
      state: "queued",
      createdAt: 1_000,
    };
    const withInflight = await buildBoardGroups(
      {
        listInflight: async () => [followUp],
        sits: { list: async () => [] },
        strictSlots: slots,
      } as never,
      "gitea"
    );
    expect(withInflight.in_progress).toHaveLength(1);
    expect(withInflight.needs_kick.find((item) => item.reason === "strict-refresh-needs-kick")).toBeUndefined();

    const drained = await buildBoardGroups(
      {
        listInflight: async () => [],
        sits: { list: async () => [] },
        strictSlots: slots,
      } as never,
      "gitea"
    );
    expect(drained.needs_kick.find((item) => item.reason === "strict-refresh-needs-kick")?.number).toBe(100);
  });
});
