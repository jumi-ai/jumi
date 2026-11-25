import { describe, expect, test } from "bun:test";
import type { ServiceConfig } from "../src/config.ts";
import { PUSH_CONFIRM_DELAY_MS } from "../src/push_confirm.ts";
import { drainPushConfirm } from "../src/push_confirm_drain.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { makeBranch, makeComment, makeConfig, makePR, makeUser } from "./fixtures.ts";

function prWithHead(sha: string, overrides: Record<string, unknown> = {}) {
  return makePR({
    user: makeUser({ login: "jumi" }),
    head: makeBranch({ ref: "jumi/issue-12-foo", sha }),
    title: "Jumi: fix the thing",
    body: "Fixes #12",
    ...overrides,
  });
}

function drainApi(prSha: string, overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const notes: string[] = [];
  const api = {
    getPR: async () => {
      calls.push("getPR");
      return prWithHead(prSha);
    },
    listCommitStatuses: async () => {
      calls.push("listCommitStatuses");
      return [];
    },
    listCheckRuns: async () => {
      calls.push("listCheckRuns");
      return [];
    },
    listActionJobs: async () => {
      calls.push("listActionJobs");
      return [];
    },
    getActionJobLogs: async () => "",
    findStickyIssueComment: async () => {
      calls.push("findStickyIssueComment");
      return undefined;
    },
    createIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
      calls.push("createIssueComment");
      notes.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_o: string, _r: string, id: number, body: string) => {
      calls.push("updateIssueComment");
      notes.push(body);
      return makeComment({ id, body });
    },
    getIssue: async () => {
      throw new Error("not used");
    },
    getRepoFile: async () => ({ found: false }),
    getRepo: async () => ({
      name: "demo",
      full_name: "o/r",
      html_url: "https://example.test/o/r",
      clone_url: "https://example.test/o/r.git",
      default_branch: "main",
      owner: { login: "o" },
    }),
    getCollaboratorPermission: async () => ({ permission: "write" }),
    ...overrides,
  };
  return { api, calls, notes };
}

function config(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return makeConfig({ leaseMs: 60_000, ...overrides });
}

describe("drainPushConfirm", () => {
  test("lost webhook with matching head starts review via CI gate", async () => {
    const store = new MemoryReviewJobStore();
    await store.pushConfirm.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    const { api } = drainApi("sha-a");
    const summary = await drainPushConfirm(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000 + PUSH_CONFIRM_DELAY_MS,
    });
    expect(summary).toEqual({ claimed: 1, completed: 1, retried: 0, blocked: 0 });
    expect(await store.pushConfirm.claimDue("peek", 60_000, 10, 1_000 + PUSH_CONFIRM_DELAY_MS)).toEqual([]);
    const inflight = await store.listInflight(10);
    expect(inflight.length).toBe(1);
    expect(inflight[0]?.headSha).toBe("sha-a");
    expect(inflight[0]?.prNumber).toBe(7);
  });

  test("mismatch retries then reaches the board row after the budget", async () => {
    const store = new MemoryReviewJobStore();
    await store.pushConfirm.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    const { api, notes } = drainApi("sha-other");
    let nowMs = 1_000 + PUSH_CONFIRM_DELAY_MS;
    let blocked = 0;
    for (let i = 0; i < 4; i++) {
      const summary = await drainPushConfirm(store, api as never, config(), () => undefined, 50, { nowMs });
      blocked = summary.blocked;
      nowMs += 200_000;
    }
    expect(blocked).toBe(1);
    const exhausted = await store.pushConfirm.listExhausted(10);
    expect(exhausted.length).toBe(1);
    expect(exhausted[0]?.expectedSha).toBe("sha-a");
    const sit = await store.sits.get("o", "r", 7);
    expect(sit?.reason).toBe("push-unregistered");
    expect(notes.join("\n")).toContain("forge did not register push sha-a");
  });

  test("late synchronize after the read-back does not double-queue", async () => {
    const store = new MemoryReviewJobStore();
    await store.pushConfirm.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    const { api } = drainApi("sha-a");
    const first = await drainPushConfirm(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000 + PUSH_CONFIRM_DELAY_MS,
    });
    expect(first.completed).toBe(1);
    // The late synchronize confirms (no-op, already deleted) and enqueues the same head.
    const { confirmPushFromPrRead } = await import("../src/push_confirm.ts");
    await confirmPushFromPrRead(store, "o", "r", 7, "sha-a");
    const second = await store.enqueue(
      {
        delivery: "late-synchronize",
        owner: "o",
        repo: "r",
        prNumber: 7,
        action: "synchronize",
        headSha: "sha-a",
        receivedAt: new Date().toISOString(),
      },
      { nowMs: 1_000 + PUSH_CONFIRM_DELAY_MS + 1 }
    );
    expect(second.queued).toBe(false);
  });

  test("503 on the PR read retries without counting as a mismatch", async () => {
    const store = new MemoryReviewJobStore();
    await store.pushConfirm.request("o", "r", 7, "sha-a", "branch", "sha-a", 1_000);
    let calls = 0;
    const { api } = drainApi("sha-a", {
      getPR: async () => {
        calls += 1;
        if (calls === 1) throw new Error("forge exploded → 503: Service Unavailable");
        return prWithHead("sha-a");
      },
    });
    const first = await drainPushConfirm(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000 + PUSH_CONFIRM_DELAY_MS,
    });
    expect(first.retried).toBe(1);
    expect(first.completed).toBe(0);
    expect(await store.pushConfirm.listExhausted(10)).toEqual([]);
    const second = await drainPushConfirm(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000 + PUSH_CONFIRM_DELAY_MS + 200_000,
    });
    expect(second.completed).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
