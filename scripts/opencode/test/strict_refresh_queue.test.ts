import { describe, expect, test } from "bun:test";
import type { Pull } from "../src/ports.ts";
import { shouldEnqueueStrictRefreshForPR, shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import {
  compareStrictRefreshOrder,
  isStrictRefreshBlocked,
  isStrictRefreshTerminalEvidence,
  MemoryStrictRefreshSlotStore,
  STRICT_REFRESH_SLOT_TIMEOUT_MS,
} from "../src/strict_refresh_queue.ts";

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

function strictApi(pulls: Pull[], strict: boolean | undefined = true) {
  return {
    listOpenPulls: async () => pulls,
    getBranch: async () =>
      strict === undefined ? ({ protected: true } as never) : ({ protected: true, strict } as never),
  } as never;
}

describe("strict single-slot ordering and blockers", () => {
  test("oldest ready first; PR number breaks created_at ties", () => {
    const a = jumiPull(102, { created_at: "2026-05-23T00:00:00Z" });
    const b = jumiPull(100, { created_at: "2026-05-23T00:00:00Z" });
    const c = jumiPull(101, { created_at: "2026-05-22T00:00:00Z" });
    expect([a, b, c].sort(compareStrictRefreshOrder).map((pr) => pr.number)).toEqual([101, 100, 102]);
  });

  test("dirty, blocked, and mergeable false are blockers; behind/clean/unknown are not", () => {
    expect(isStrictRefreshBlocked(jumiPull(1, { mergeableState: "dirty" }))).toBe(true);
    expect(isStrictRefreshBlocked(jumiPull(1, { mergeableState: "blocked" }))).toBe(true);
    expect(isStrictRefreshBlocked(jumiPull(1, { mergeable: false }))).toBe(true);
    expect(isStrictRefreshBlocked(jumiPull(1, { mergeableState: "behind" }))).toBe(false);
    expect(isStrictRefreshBlocked(jumiPull(1, { mergeableState: "clean" }))).toBe(false);
    expect(isStrictRefreshBlocked(jumiPull(1, { mergeableState: "unknown" }))).toBe(false);
    expect(isStrictRefreshBlocked(jumiPull(1))).toBe(false);
  });

  test("terminal evidence matches only on same PR, head, and base", () => {
    const terminal = { prNumber: 100, headSha: "head-100", baseSha: "base-2", reason: "blocked", atMs: 1 };
    expect(isStrictRefreshTerminalEvidence(100, "head-100", "base-2", terminal)).toBe(true);
    expect(isStrictRefreshTerminalEvidence(100, "HEAD-100", "BASE-2", terminal)).toBe(true);
    expect(isStrictRefreshTerminalEvidence(101, "head-100", "base-2", terminal)).toBe(false);
    expect(isStrictRefreshTerminalEvidence(100, "head-other", "base-2", terminal)).toBe(false);
    expect(isStrictRefreshTerminalEvidence(100, "head-100", "base-3", terminal)).toBe(false);
    expect(isStrictRefreshTerminalEvidence(100, "head-100", "base-2", undefined)).toBe(false);
  });
});

describe("strict single-slot push regression (ten stale PRs)", () => {
  test("exactly one refresh for the oldest; holder blocks the other nine until it merges", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const pulls = Array.from({ length: 10 }, (_, i) => jumiPull(100 + i));
    const api = strictApi(pulls);
    const first = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]?.prNumber).toBe(100);
    expect(first.jobs[0]?.strictBaseSha).toBe("base-2");

    // While the holder awaits CI/review/merge, no other PR gets a speculative push.
    const second = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 2_000);
    expect(second.jobs).toHaveLength(0);

    // Repeating the same base (duplicate delivery) still admits nothing.
    const dup = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 3_000);
    expect(dup.jobs).toHaveLength(0);

    // The holder merges: it leaves the open list and the target advances.
    const remaining = pulls.filter((pr) => pr.number !== 100);
    const afterMergeApi = strictApi(remaining);
    const next = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-3"),
      policy,
      afterMergeApi,
      undefined,
      slots,
      4_000
    );
    expect(next.jobs).toHaveLength(1);
    expect(next.jobs[0]?.prNumber).toBe(101);
    expect(next.jobs[0]?.strictBaseSha).toBe("base-3");
  });

  test("without a slot store the same call still admits only the oldest", async () => {
    const pulls = Array.from({ length: 10 }, (_, i) => jumiPull(200 + i));
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, strictApi(pulls));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prNumber).toBe(200);
  });

  test("older blocked PR does not hold the queue ahead of a ready one", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const blocked = jumiPull(100, { mergeableState: "dirty" });
    const ready = jumiPull(101);
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([blocked, ready]),
      undefined,
      slots,
      1_000
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prNumber).toBe(101);
  });
});

describe("strict single-slot terminal, close, and timeout", () => {
  test("blocked holder releases and the next eligible proceeds without reselecting on unchanged evidence", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const holder = jumiPull(100);
    const next = jumiPull(101);
    await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([holder, next]),
      undefined,
      slots,
      1_000
    );
    // Holder's head becomes conflicted; the next push advances the queue.
    const blockedHolder = jumiPull(100, { mergeableState: "dirty" });
    const admitted = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([blockedHolder, next]),
      undefined,
      slots,
      2_000
    );
    expect(admitted.jobs).toHaveLength(1);
    expect(admitted.jobs[0]?.prNumber).toBe(101);

    // Unchanged evidence does not reselect the blocked candidate after the new holder merges.
    const afterNextMerges = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-3"),
      policy,
      strictApi([blockedHolder]),
      undefined,
      slots,
      3_000
    );
    expect(afterNextMerges.jobs).toHaveLength(0);

    // A relevant change (new head) makes the previously blocked PR eligible again.
    const unblocked = jumiPull(100, {
      head: { ref: blockedHolder.head.ref, sha: "head-100-new", repo: blockedHolder.head.repo },
    });
    const revived = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-3"),
      policy,
      strictApi([unblocked]),
      undefined,
      new MemoryStrictRefreshSlotStore(),
      4_000
    );
    expect(revived.jobs).toHaveLength(1);
    expect(revived.jobs[0]?.prNumber).toBe(100);
  });

  test("timed-out holder releases and is skipped on unchanged evidence", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const holder = jumiPull(100);
    const next = jumiPull(101);
    await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([holder, next]),
      undefined,
      slots,
      1_000
    );
    const timedOut = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([holder, next]),
      undefined,
      slots,
      1_000 + STRICT_REFRESH_SLOT_TIMEOUT_MS + 1
    );
    expect(timedOut.jobs).toHaveLength(1);
    expect(timedOut.jobs[0]?.prNumber).toBe(101);
  });

  test("closing the holder and cancelling auto-merge release without re-arming", async () => {
    const closeSlots = new MemoryStrictRefreshSlotStore();
    const holder = jumiPull(100);
    const next = jumiPull(101);
    await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([holder, next]),
      undefined,
      closeSlots,
      1_000
    );
    // Holder closed: gone from the open list, next proceeds, closed PR never re-armed.
    const afterClose = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([next]),
      undefined,
      closeSlots,
      2_000
    );
    expect(afterClose.jobs).toHaveLength(1);
    expect(afterClose.jobs[0]?.prNumber).toBe(101);

    const cancelSlots = new MemoryStrictRefreshSlotStore();
    await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([holder, next]),
      undefined,
      cancelSlots,
      1_000
    );
    // Human cancels auto-merge on the holder: ineligible, next proceeds, no re-arm.
    const cancelled = jumiPull(100, { autoMergeEnabled: false });
    const afterCancel = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      strictApi([cancelled, next]),
      undefined,
      cancelSlots,
      2_000
    );
    expect(afterCancel.jobs).toHaveLength(1);
    expect(afterCancel.jobs[0]?.prNumber).toBe(101);
  });
});

describe("strict single-slot admission across events and branches", () => {
  test("competing push and PR-activity events do not admit two PRs for the same target", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const first = jumiPull(100);
    const second = jumiPull(101);
    const pulls = [first, second];
    const api = strictApi(pulls);
    const fromPush = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      api,
      undefined,
      slots,
      1_000
    );
    expect(fromPush.jobs).toHaveLength(1);

    // PR activity for the waiting PR must not enqueue a speculative refresh.
    const waiting = await shouldEnqueueStrictRefreshForPR({
      pr: second,
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: policy as never,
      api,
      sender: "pull_request",
      slots,
      nowMs: 2_000,
    });
    expect(waiting).toBeNull();

    // PR activity for the holder must not start a second refresh either.
    const holderAgain = await shouldEnqueueStrictRefreshForPR({
      pr: first,
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: policy as never,
      api,
      sender: "pull_request",
      slots,
      nowMs: 3_000,
    });
    expect(holderAgain).toBeNull();
  });

  test("out-of-order base events do not start a second refresh or clear the slot", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const first = jumiPull(100);
    const second = jumiPull(101);
    const api = strictApi([first, second]);
    await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 1_000);
    const stale = await shouldEnqueueStrictRefreshOnPush(pushPayload("base-2"), policy, api, undefined, slots, 2_000);
    expect(stale.jobs).toHaveLength(0);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
  });

  test("distinct target branches progress independently", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const mainFirst = jumiPull(100);
    const mainSecond = jumiPull(101);
    const developFirst = jumiPull(200, { base: { ref: "develop", sha: "d-base-1" } });
    const api = {
      listOpenPulls: async () => [mainFirst, mainSecond, developFirst],
      getBranch: async () => ({ protected: true, strict: true }),
    } as never;
    const mainPush = {
      ...pushPayload("base-2"),
      ref: "refs/heads/main",
    } as never;
    const developPush = {
      ...pushPayload("d-base-2"),
      ref: "refs/heads/develop",
    } as never;
    const mainAdmitted = await shouldEnqueueStrictRefreshOnPush(mainPush, policy, api, undefined, slots, 1_000);
    expect(mainAdmitted.jobs).toHaveLength(1);
    expect(mainAdmitted.jobs[0]?.prNumber).toBe(100);
    const developAdmitted = await shouldEnqueueStrictRefreshOnPush(developPush, policy, api, undefined, slots, 2_000);
    expect(developAdmitted.jobs).toHaveLength(1);
    expect(developAdmitted.jobs[0]?.prNumber).toBe(200);
  });

  test("unknown strictness keeps the slot; explicit off releases it", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    await slots.tryAdmit({
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-1",
      admittedAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    const pulls = [jumiPull(100)];
    // Transient lookup failure reads as unknown: fail-closed, slot stays.
    const unknownApi = {
      listOpenPulls: async () => pulls,
      getBranch: async () => {
        throw new Error("boom");
      },
    } as never;
    const unknownResult = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      unknownApi,
      undefined,
      slots,
      2_000
    );
    expect(unknownResult.jobs).toHaveLength(0);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);

    // Explicitly unprotected branch releases the slot.
    const offApi = strictApi(pulls, false);
    const offResult = await shouldEnqueueStrictRefreshOnPush(
      pushPayload("base-2"),
      policy,
      offApi,
      undefined,
      slots,
      3_000
    );
    expect(offResult.jobs).toHaveLength(0);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();

    // Same fail-closed rule on the PR-activity path: unknown keeps the slot.
    await slots.tryAdmit({
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-2",
      admittedAtMs: 4_000,
      updatedAtMs: 4_000,
    });
    const prUnknownApi = {
      listOpenPulls: async () => pulls,
      getBranch: async () => {
        throw new Error("boom");
      },
    } as never;
    const prUnknown = await shouldEnqueueStrictRefreshForPR({
      pr: pulls[0] as never,
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: policy as never,
      api: prUnknownApi,
      slots,
      nowMs: 5_000,
    });
    expect(prUnknown).toBeNull();
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
  });

  test("Pg touch binds the held pr to $4 and the new tip to $5/$6/$7", async () => {
    const { PgStrictRefreshSlotStore } = await import("../src/strict_refresh_queue.ts");
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      unsafe: async (sql: string, params: unknown[]) => {
        seen.push({ sql, params });
        return [];
      },
    };
    const sql = {
      unsafe: async (query: string, params?: unknown[]) => {
        seen.push({ sql: query, params: params ?? [] });
        return [];
      },
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    };
    const store = new PgStrictRefreshSlotStore(sql as never);
    await store.touch("o", "r", "main", 100, "head-100", "base-2", 1_000);
    const touch = seen.find((call) => call.sql.includes("SET head_sha"));
    expect(touch).toBeDefined();
    expect(touch?.sql).toContain("head_sha = $5");
    expect(touch?.sql).toContain("base_sha = $6");
    expect(touch?.sql).toContain("updated_at = $7::timestamptz");
    expect(touch?.sql).toContain("pr_number = $4");
    expect(touch?.params).toEqual(["o", "r", "main", 100, "head-100", "base-2", expect.any(String)]);
  });
});
