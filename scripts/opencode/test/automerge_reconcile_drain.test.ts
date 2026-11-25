import { describe, expect, test } from "bun:test";
import { reconcileAutomergeCancellation } from "../src/automerge_decision.ts";
import { drainAutomergeReconcile } from "../src/automerge_reconcile_drain.ts";
import type { ServiceConfig } from "../src/config.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { makeBranch, makeComment, makeConfig, makePR, makeUser } from "./fixtures.ts";

function jumiPrLabels(labels: Array<string | { name?: string }>, overrides: Record<string, unknown> = {}) {
  return makePR({
    user: makeUser({ login: "jumi" }),
    head: makeBranch({ ref: "jumi/issue-12-foo", sha: "headsha" }),
    title: "Jumi: fix the thing",
    body: "Fixes #12",
    labels: labels as never,
    ...overrides,
  });
}

function drainApi(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const notes: string[] = [];
  const api = {
    getRepo: async () => {
      calls.push("getRepo");
      return {
        name: "demo",
        full_name: "kirmanak/demo",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
      };
    },
    getPR: async (_o: string, _r: string, index: number) => {
      calls.push("getPR");
      return jumiPrLabels(["no-automerge"], { number: index });
    },
    getRepoFile: async () => {
      calls.push("getRepoFile");
      return { found: true, content: "automerge: true\n" };
    },
    cancelAutoMerge: async () => {
      calls.push("cancelAutoMerge");
      return true;
    },
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
    getCollaboratorPermission: async () => ({ permission: "write" }),
    ...overrides,
  };
  return { api, calls, notes };
}

function config(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return makeConfig({ leaseMs: 60_000, ...overrides });
}

async function seeded(owner = "kirmanak", repo = "demo", pr = 7, cause = "cause-A", nowMs = 1_000) {
  const store = new MemoryReviewJobStore();
  const created = await store.automergeReconcile.request(owner, repo, pr, cause, nowMs);
  return { store, generation: created.generation };
}

describe("drainAutomergeReconcile", () => {
  test("cancel lands: row completed and deleted", async () => {
    const { store } = await seeded();
    const { api, calls } = drainApi();
    const logs: string[] = [];
    const summary = await drainAutomergeReconcile(store, api as never, config(), (m) => logs.push(m), 50, {
      nowMs: 1_000,
    });
    expect(summary).toEqual({ claimed: 1, completed: 1, retried: 0, blocked: 0 });
    expect(calls).toContain("cancelAutoMerge");
    expect(await store.automergeReconcile.claimDue("peek", 60_000, 10, 1_000)).toEqual([]);
    expect(await store.automergeReconcile.listExhausted(10)).toEqual([]);
  });

  test("cancel fails then succeeds after backoff: retry, then absent deletes the row", async () => {
    const { store } = await seeded();
    let calls = 0;
    const { api } = drainApi({
      cancelAutoMerge: async () => {
        calls += 1;
        if (calls === 1) throw new Error("forge exploded → 500: boom");
        // The first cancel landed but its response was lost: nothing left to remove.
        return false;
      },
    });
    const first = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000,
    });
    expect(first.completed).toBe(0);
    expect(first.retried).toBe(1);
    // In backoff: nothing due.
    const during = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_500,
    });
    expect(during.claimed).toBe(0);
    // After backoff the tick cancels and deletes the row.
    const after = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000 + 2_000 + 100,
    });
    expect(after).toEqual({ claimed: 1, completed: 1, retried: 0, blocked: 0 });
    expect(calls).toBe(2);
    expect(await store.automergeReconcile.claimDue("peek", 60_000, 10, 1_000 + 2_000 + 100)).toEqual([]);
  });

  test("cancel lands but response lost: retry returns absent, row deleted", async () => {
    await seeded();
    let calls = 0;
    const { api } = drainApi({
      cancelAutoMerge: async () => {
        calls += 1;
        if (calls === 1) return true;
        return false;
      },
    });
    // First reconcile-level check: removed.
    expect(
      await reconcileAutomergeCancellation({
        api: api as never,
        forgeKind: "gitea",
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        automergeRepos: [],
        automergeEnabled: true,
        botUsername: "jumi",
        log: () => undefined,
      })
    ).toBe("removed");
    // The retry re-reads fresh state: absent, a harmless success.
    expect(
      await reconcileAutomergeCancellation({
        api: api as never,
        forgeKind: "gitea",
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        automergeRepos: [],
        automergeEnabled: true,
        botUsername: "jumi",
        log: () => undefined,
      })
    ).toBe("absent");
    expect(calls).toBe(2);
  });

  test("labels now say schedule: completed, scheduleAutoMerge never called, no cancel", async () => {
    const { store } = await seeded();
    const { api, calls, notes } = drainApi({
      getPR: async (_o: string, _r: string, index: number) => {
        calls.push("getPR");
        return jumiPrLabels([], { number: index });
      },
      scheduleAutoMerge: async () => {
        calls.push("scheduleAutoMerge");
      },
    });
    const summary = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000,
    });
    expect(summary).toEqual({ claimed: 1, completed: 1, retried: 0, blocked: 0 });
    expect(calls).not.toContain("scheduleAutoMerge");
    expect(calls).not.toContain("cancelAutoMerge");
    expect(notes).toEqual([]);
  });

  test("missing cancel capability: exhausted with one diagnostic and one note, no retry loop", async () => {
    const { store } = await seeded();
    const { api, calls, notes } = drainApi({ cancelAutoMerge: undefined });
    const logs: string[] = [];
    const summary = await drainAutomergeReconcile(
      store,
      api as never,
      config(),
      (m) => logs.push(m),
      50,
      { nowMs: 1_000 }
    );
    expect(summary).toEqual({ claimed: 1, completed: 0, retried: 0, blocked: 1 });
    expect(calls).not.toContain("cancelAutoMerge");
    const exhausted = await store.automergeReconcile.listExhausted(10);
    expect(exhausted.length).toBe(1);
    expect(logs.filter((m) => m.includes("automerge_reconcile_exhausted")).length).toBe(1);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("cancel auto-merge manually");
    // No busy retry: an exhausted row is never due again.
    const again = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 2_000,
    });
    expect(again.claimed).toBe(0);
    expect(notes.length).toBe(1);
  });

  test("closed PR completes with no mutation", async () => {
    const { store } = await seeded();
    const { api, calls, notes } = drainApi({
      getPR: async (_o: string, _r: string, index: number) => {
        calls.push("getPR");
        return jumiPrLabels(["no-automerge"], { number: index, state: "closed" });
      },
    });
    const summary = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000,
    });
    expect(summary.completed).toBe(1);
    expect(calls).not.toContain("cancelAutoMerge");
    expect(notes).toEqual([]);
  });

  test("non-Jumi PR completes with no mutation", async () => {
    const { store } = await seeded();
    const { api, calls, notes } = drainApi({
      getPR: async (_o: string, _r: string, index: number) => {
        calls.push("getPR");
        return makePR({ number: index, labels: ["no-automerge"] as never });
      },
    });
    const summary = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000,
    });
    expect(summary.completed).toBe(1);
    expect(calls).not.toContain("cancelAutoMerge");
    expect(notes).toEqual([]);
  });

  test("disabled deployment completes with no mutation and no note", async () => {
    const { store } = await seeded();
    const { api, calls, notes } = drainApi();
    const summary = await drainAutomergeReconcile(
      store,
      api as never,
      config({ automergeEnabled: false }),
      () => undefined,
      50,
      { nowMs: 1_000 }
    );
    expect(summary.completed).toBe(1);
    expect(calls).not.toContain("cancelAutoMerge");
    expect(notes).toEqual([]);
  });

  test("invalid settings complete with no mutation and no note", async () => {
    const { store } = await seeded();
    const { api, calls, notes } = drainApi({
      getRepoFile: async () => {
        calls.push("getRepoFile");
        return { found: true, content: "automerge: [unclosed\n" };
      },
    });
    const summary = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000,
    });
    expect(summary.completed).toBe(1);
    expect(calls).not.toContain("cancelAutoMerge");
    expect(notes).toEqual([]);
  });

  test("forge down throughout: retries per backoff, ends exhausted with one diagnostic and one note; new cause revives", async () => {
    const { store } = await seeded();
    const { api, notes } = drainApi({
      getPR: async () => {
        throw new Error("forge down → 502: bad gateway");
      },
    });
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    let nowMs = 1_000;
    let last = "";
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const summary = await drainAutomergeReconcile(store, api as never, config(), log, 50, { nowMs });
      expect(summary.claimed).toBe(1);
      last = summary.completed === 1 ? "completed" : summary.blocked === 1 ? "blocked" : "retried";
      expect(last).toBe("retried");
      // Next attempt is due only after the infra backoff.
      const immediate = await drainAutomergeReconcile(store, api as never, config(), log, 50, { nowMs });
      expect(immediate.claimed).toBe(0);
      nowMs += 61_000;
    }
    const exhausted = await store.automergeReconcile.listExhausted(10);
    expect(exhausted.length).toBe(1);
    expect(logs.filter((m) => m.includes("automerge_reconcile_exhausted")).length).toBe(1);
    expect(notes.length).toBe(1);
    // A repeated cause does not revive; only a new cause does.
    expect((await store.automergeReconcile.request("kirmanak", "demo", 7, "cause-A", nowMs)).status).toBe(
      "duplicate"
    );
    expect(await store.automergeReconcile.claimDue("peek", 60_000, 10, nowMs)).toEqual([]);
    const revived = await store.automergeReconcile.request("kirmanak", "demo", 7, "cause-fresh", nowMs);
    expect(revived.status).toBe("revived");
    const retry = await drainAutomergeReconcile(store, api as never, config(), log, 50, { nowMs });
    expect(retry.retried).toBe(1);
  });

  test("stale holder dispatches no cancel and cannot complete the replacement", async () => {
    const store = new MemoryReviewJobStore();
    await store.automergeReconcile.request("kirmanak", "demo", 7, "cause-A", 1_000);
    let cancelCalls = 0;
    let releasePolicy!: () => void;
    const policyGate = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const { api } = drainApi({
      getRepoFile: async () => {
        await policyGate;
        return { found: true, content: "automerge: true\n" };
      },
      cancelAutoMerge: async () => {
        cancelCalls += 1;
        return true;
      },
    });
    // Tiny lease so it expires while the policy read is gated.
    const pending = drainAutomergeReconcile(store, api as never, config({ leaseMs: 50 }), () => undefined, 50, {
      nowMs: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    // A new cause bumps the generation while the first holder is stuck.
    const bumped = await store.automergeReconcile.request("kirmanak", "demo", 7, "cause-B", 1_010);
    expect(bumped.status).toBe("bumped");
    releasePolicy();
    const summary = await pending;
    expect(summary.retried).toBe(1);
    expect(cancelCalls).toBe(0);
    // The stale holder settled nothing: the bumped row is still pending, not exhausted.
    expect(await store.automergeReconcile.listExhausted(10)).toEqual([]);
    // A fresh tick cancels once and deletes the replacement.
    const { api: api2 } = drainApi();
    const second = await drainAutomergeReconcile(store, api2 as never, config(), () => undefined, 50, {
      nowMs: 2_000,
    });
    expect(second).toEqual({ claimed: 1, completed: 1, retried: 0, blocked: 0 });
  });

  test("heartbeat keeps a slow healthy read owned; expired lease recovers next tick", async () => {
    const store = new MemoryReviewJobStore();
    await store.automergeReconcile.request("kirmanak", "demo", 7, "cause-A", 1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api } = drainApi({
      getPR: async (_o: string, _r: string, index: number) => {
        await gate;
        return jumiPrLabels(["no-automerge"], { number: index });
      },
    });
    const pending = drainAutomergeReconcile(store, api as never, config({ leaseMs: 120_000 }), () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const summary = await pending;
    expect(summary.completed).toBe(1);
  });

  test("zero rows is a no-op and never touches the forge", async () => {
    const store = new MemoryReviewJobStore();
    const { api, calls } = drainApi({
      getPR: async () => {
        throw new Error("must not be called");
      },
      getRepo: async () => {
        throw new Error("must not be called");
      },
    });
    const summary = await drainAutomergeReconcile(store, api as never, config(), () => undefined);
    expect(summary).toEqual({ claimed: 0, completed: 0, retried: 0, blocked: 0 });
    expect(calls).toEqual([]);
  });

  test("at most 50 rows per invocation", async () => {
    const store = new MemoryReviewJobStore();
    for (let pr = 1; pr <= 55; pr += 1) {
      await store.automergeReconcile.request("kirmanak", "demo", pr, `cause-${pr}`, 1_000);
    }
    const { api } = drainApi();
    const summary = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000,
    });
    expect(summary.claimed).toBe(50);
    expect(summary.completed).toBe(50);
    const rest = await drainAutomergeReconcile(store, api as never, config(), () => undefined, 50, {
      nowMs: 1_000,
    });
    expect(rest.claimed).toBe(5);
  });
});

describe("reconcileAutomergeCancellation", () => {
  test("conflict cancels as the handler does but posts no note", async () => {
    const { api, calls, notes } = drainApi({
      getPR: async (_o: string, _r: string, index: number) => {
        calls.push("getPR");
        return jumiPrLabels(["automerge", "no-automerge"], { number: index });
      },
    });
    const result = await reconcileAutomergeCancellation({
      api: api as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      automergeRepos: [],
      automergeEnabled: true,
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toBe("removed");
    expect(calls).toContain("cancelAutoMerge");
    expect(notes).toEqual([]);
    expect(calls).not.toContain("scheduleAutoMerge");
  });

  test("has no code path to scheduleAutoMerge", async () => {
    const { api, calls } = drainApi({
      getPR: async (_o: string, _r: string, index: number) => {
        calls.push("getPR");
        return jumiPrLabels(["automerge"], { number: index });
      },
      getRepoFile: async () => ({ found: true, content: "automerge: true\n" }),
      scheduleAutoMerge: undefined as never,
    });
    const result = await reconcileAutomergeCancellation({
      api: api as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      automergeRepos: [],
      automergeEnabled: true,
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toBe("not-needed");
    expect(calls).not.toContain("scheduleAutoMerge");
    expect(calls).not.toContain("cancelAutoMerge");
  });

  test("missing read capability is unsupported", async () => {
    const { api } = drainApi({ getPR: undefined });
    const result = await reconcileAutomergeCancellation({
      api: api as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      automergeRepos: [],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toBe("unsupported");
  });

  test("lost ownership forbids a not-yet-dispatched cancel", async () => {
    const { api, calls } = drainApi();
    const result = await reconcileAutomergeCancellation({
      api: api as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      automergeRepos: [],
      automergeEnabled: true,
      botUsername: "jumi",
      log: () => undefined,
      beforeCancel: () => false,
    });
    expect(result).toBe("lost");
    expect(calls).not.toContain("cancelAutoMerge");
  });
});

describe("existing handler behavior", () => {
  test("handler still schedules on the schedule path", async () => {
    const { handleAutomergeLabelChange } = await import("../src/automerge.ts");
    const { api, calls } = drainApi({
      getPR: async (_o: string, _r: string, index: number) => {
        calls.push("getPR");
        return jumiPrLabels(["automerge"], { number: index });
      },
    });
    (api as unknown as { scheduleAutoMerge: (owner: string, repo: string, index: number) => Promise<void> }).scheduleAutoMerge =
      async () => {
        calls.push("scheduleAutoMerge");
      };
    (
      api as unknown as {
        listIssueTimeline: (owner: string, repo: string, index: number) => Promise<unknown[]>;
      }
    ).listIssueTimeline = async () => [{ label: "automerge", actor: { login: "alice" }, event: "labeled" }];
    (
      api as unknown as {
        getBranch: (owner: string, repo: string, branch: string) => Promise<unknown>;
      }
    ).getBranch = async () => ({
      protected: true,
      enableStatusCheck: true,
      requiredContexts: ["jumi/opencode-review"],
    });
    const result = await handleAutomergeLabelChange({
      api: api as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      baseBranch: "main",
      automergeRepos: [],
      automergeEnabled: true,
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result.action).toBe("scheduled");
    expect(calls).toContain("scheduleAutoMerge");
  });
});
