import { describe, expect, test } from "bun:test";
import { withEngineChain } from "../src/fallback.ts";
import { resolveIndependentReviewers, resolveStickyWorkerStart } from "../src/independent_review.ts";
import { MemoryProvenanceStore, ProvenanceCollector } from "../src/provenance.ts";
import { type NamedRunner, orderChainForJob, rotateChainForStart } from "../src/runners.ts";
import { decideStickyWorkerChain, logStickyWorkerSelection } from "../src/sticky_worker.ts";

const codex: NamedRunner = { name: "codex", type: "codex", model: "gpt-6", effort: "high" };
const claude: NamedRunner = { name: "claude", type: "claude", model: "claude-opus-5", effort: "high" };
const grok: NamedRunner = { name: "grok", type: "opencode", model: "xai/grok-4.6", variant: "high" };

function policy() {
  return {
    enabled: true as const,
    groups: {
      codex: [{ type: "codex", model: "gpt-6" }],
      opus: [{ type: "claude", model: "claude-opus-5" }],
      grok: [{ type: "opencode", model: "xai/grok-4.6" }],
    },
  };
}

function known(
  contributors: Array<{ type: string; model: string; effort?: string; variant?: string }>,
  publisher?: { type: string; model: string; effort?: string; variant?: string }
) {
  return {
    status: "known" as const,
    forge: "gitea",
    owner: "o",
    repo: "r",
    prNumber: 7,
    branch: "b",
    headSha: "h",
    contributors,
    publisher: publisher ?? contributors[contributors.length - 1] ?? null,
  };
}

describe("sticky writer family", () => {
  test("follow-up restarts on the existing writer family", async () => {
    const store = new MemoryProvenanceStore();
    await store.confirmPublication({
      forge: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 7,
      branch: "b",
      headSha: "head1",
      contributors: [{ type: "claude", model: "claude-opus-5", effort: "high" }],
      publisher: { type: "claude", model: "claude-opus-5", effort: "high" },
      jobId: 1,
      jobKey: "k1",
      delivery: "d1",
      jobKind: "implement",
    });
    const decision = await decideStickyWorkerChain({
      chain: [codex, claude, grok],
      effectiveChain: [grok, codex, claude],
      runnerSelection: "random-start",
      independentReview: policy(),
      provenance: store,
      provenanceJob: { forge: "gitea" },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "head1",
    });
    expect(decision.stickyApplied).toBe(true);
    expect(decision.stickyFamily).toBe("opus");
    expect(decision.chain?.map((r) => r.name)).toEqual(["claude", "grok", "codex"]);
  });

  test("writer family no longer in chain falls back to random-start with diagnostic", async () => {
    const store = new MemoryProvenanceStore();
    await store.confirmPublication({
      forge: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 7,
      branch: "b",
      headSha: "head1",
      contributors: [{ type: "codex", model: "gpt-6", effort: "high" }],
      publisher: { type: "codex", model: "gpt-6", effort: "high" },
      jobId: 1,
      jobKey: "k1",
      delivery: "d1",
      jobKind: "implement",
    });
    const logs: string[] = [];
    const decision = await decideStickyWorkerChain({
      chain: [claude, grok],
      effectiveChain: [grok, claude],
      runnerSelection: "random-start",
      independentReview: policy(),
      provenance: store,
      provenanceJob: { forge: "gitea" },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "head1",
    });
    expect(decision.stickyApplied).toBe(false);
    expect(decision.reason).toMatch(/no writer family in worker chain/);
    // Fallback preserves the ordinary random-start order.
    expect(decision.chain?.map((r) => r.name)).toEqual(["grok", "claude"]);
    logStickyWorkerSelection(
      (m) => logs.push(m),
      { owner: "o", repo: "r", prNumber: 7, headSha: "head1" },
      "random-start",
      decision.chain,
      decision
    );
    expect(logs.join("\n")).toContain("runner_selection");
    expect(logs.join("\n")).toContain("fallback-no-writer-in-chain");
  });

  test("first implementation and unknown provenance still use uniform random-start", async () => {
    const store = new MemoryProvenanceStore();
    const unknown = await decideStickyWorkerChain({
      chain: [codex, claude, grok],
      effectiveChain: [grok, codex, claude],
      runnerSelection: "random-start",
      independentReview: policy(),
      provenance: store,
      provenanceJob: { forge: "gitea" },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "never-published",
    });
    expect(unknown.stickyApplied).toBe(false);
    expect(unknown.chain?.map((r) => r.name)).toEqual(["grok", "codex", "claude"]);
    // Uniform random-start still distributes first implementations.
    const starts = new Set<string>();
    for (const r of [() => 0, () => 0.34, () => 0.67, () => 0.99]) {
      starts.add(orderChainForJob([codex, claude, grok], "random-start", r)[0]?.name ?? "");
    }
    expect(starts.size).toBeGreaterThan(1);
    expect(rotateChainForStart([codex, claude, grok], 1).map((r) => r.name)).toEqual(["claude", "grok", "codex"]);
  });

  test("multi-round PR under random-start keeps a reviewer eligible for five rounds", async () => {
    const store = new MemoryProvenanceStore();
    const workerChain: NamedRunner[] = [codex, claude, grok];
    // Round 0: first implement picks claude as the writer.
    await store.confirmPublication({
      forge: "gitea",
      owner: "o",
      repo: "r",
      prNumber: 7,
      branch: "b",
      headSha: "head0",
      contributors: [{ type: "claude", model: "claude-opus-5", effort: "high" }],
      publisher: { type: "claude", model: "claude-opus-5", effort: "high" },
      jobId: 1,
      jobKey: "k1",
      delivery: "d1",
      jobKind: "implement",
    });
    for (let round = 1; round <= 5; round++) {
      const head = `head${round - 1}`;
      const decision = await decideStickyWorkerChain({
        chain: workerChain,
        effectiveChain: orderChainForJob(workerChain, "random-start", () => (round * 0.37) % 1),
        runnerSelection: "random-start",
        independentReview: policy(),
        provenance: store,
        provenanceJob: { forge: "gitea" },
        owner: "o",
        repo: "r",
        prNumber: 7,
        headSha: head,
      });
      // Every follow-up restarts on the existing writer family.
      expect(decision.stickyApplied).toBe(true);
      expect(decision.chain?.[0]?.name).toBe("claude");
      // Reviewer excludes only the writer family and stays eligible.
      const lookup = await store.lookupForReview({
        forge: "gitea",
        owner: "o",
        repo: "r",
        prNumber: 7,
        headSha: head,
        branch: "b",
      });
      const outcome = resolveIndependentReviewers({
        chain: workerChain,
        provenance: lookup,
        policy: policy(),
        headSha: head,
      });
      expect(outcome.kind).toBe("selected");
      if (outcome.kind === "selected") {
        expect(outcome.eligible.length).toBe(2);
        expect(outcome.eligible.map((r) => r.name).sort()).toEqual(["codex", "grok"]);
      }
      // Follow-up pushes with only the sticky writer contributing.
      await store.confirmPublication({
        forge: "gitea",
        owner: "o",
        repo: "r",
        prNumber: 7,
        branch: "b",
        headSha: `head${round}`,
        contributors: [{ type: "claude", model: "claude-opus-5", effort: "high" }],
        publisher: { type: "claude", model: "claude-opus-5", effort: "high" },
        jobId: 10 + round,
        jobKey: `follow${round}`,
        delivery: `d${round}`,
        jobKind: "follow-up",
      });
    }
    const finalLookup = await store.lookupByHead("gitea", "o", "r", "head5");
    expect(finalLookup.status).toBe("known");
    expect(finalLookup.contributors).toEqual([{ type: "claude", model: "claude-opus-5", effort: "high" }]);
  });

  test("sticky quota hop records the hop runner only when it pushed", async () => {
    const quota = { status: "exit" as const, exitCode: 1, message: "429 rate limit exceeded" };
    // Clean hop: first runner left no changes, so only the pusher counts.
    const cleanCalls: string[] = [];
    const cleanResult = await withEngineChain(
      async (opts) => {
        cleanCalls.push(opts.model);
        if (cleanCalls.length === 1) return quota;
        return { status: "ok" as const, runner: { type: "claude", model: "x" } };
      },
      { chain: [claude, grok], selection: "ordered", worktreeDirty: async () => false }
    )({ model: claude.model, workdir: "/tmp/clean" });
    expect(cleanCalls).toEqual([claude.model, grok.model]);
    expect(cleanResult.contributors).toEqual([{ type: "opencode", model: "xai/grok-4.6", variant: "high" }]);
    const cleanCollector = new ProvenanceCollector([claude, grok]);
    cleanCollector.noteResult(cleanResult, { model: claude.model });
    expect(cleanCollector.getContributors()).toEqual([{ type: "opencode", model: "xai/grok-4.6", variant: "high" }]);

    // Dirty hop: first runner changed files then failed, so both count.
    const dirtyCalls: string[] = [];
    const dirtyResult = await withEngineChain(
      async (opts) => {
        dirtyCalls.push(opts.model);
        if (dirtyCalls.length === 1) return quota;
        return { status: "ok" as const };
      },
      { chain: [claude, grok], selection: "ordered", worktreeDirty: async () => true }
    )({ model: claude.model, workdir: "/tmp/dirty" });
    expect(dirtyResult.contributors).toEqual([
      { type: "claude", model: "claude-opus-5", effort: "high" },
      { type: "opencode", model: "xai/grok-4.6", variant: "high" },
    ]);
  });

  test("quota exit with clean worktree leaves only the pusher; dirty failure keeps both", async () => {
    const quota = { status: "exit" as const, exitCode: 1, message: "provider unavailable: overloaded 503" };
    const clean = await withEngineChain(
      async (opts) => {
        if (opts.model === claude.model) return quota;
        return { status: "ok" as const };
      },
      { chain: [claude, grok], selection: "ordered", worktreeDirty: async () => false }
    )({ model: claude.model, workdir: "/tmp" });
    expect(clean.contributors).toEqual([{ type: "opencode", model: "xai/grok-4.6", variant: "high" }]);

    const dirty = await withEngineChain(
      async (opts) => {
        if (opts.model === claude.model) return quota;
        return { status: "ok" as const };
      },
      { chain: [claude, grok], selection: "ordered", worktreeDirty: async () => true }
    )({ model: claude.model, workdir: "/tmp" });
    expect(dirty.contributors).toEqual([
      { type: "claude", model: "claude-opus-5", effort: "high" },
      { type: "opencode", model: "xai/grok-4.6", variant: "high" },
    ]);

    // Unknown worktree state fails closed and keeps both.
    const unknown = await withEngineChain(
      async (opts) => {
        if (opts.model === claude.model) return quota;
        return { status: "ok" as const };
      },
      { chain: [claude, grok], selection: "ordered", worktreeDirty: async () => undefined }
    )({ model: claude.model, workdir: "/tmp" });
    expect(unknown.contributors).toEqual([
      { type: "claude", model: "claude-opus-5", effort: "high" },
      { type: "opencode", model: "xai/grok-4.6", variant: "high" },
    ]);
  });

  test("resolveStickyWorkerStart prefers publisher family and validates chains", () => {
    const opusWriter = known([{ type: "claude", model: "claude-opus-5", effort: "high" }]);
    const direct = resolveStickyWorkerStart({ chain: [codex, claude, grok], provenance: opusWriter, policy: policy() });
    expect(direct.startIndex).toBe(1);
    expect(direct.stickyFamily).toBe("opus");
    const mixed = resolveStickyWorkerStart({
      chain: [codex, claude, grok],
      provenance: known(
        [
          { type: "claude", model: "claude-opus-5", effort: "high" },
          { type: "opencode", model: "xai/grok-4.6", variant: "high" },
        ],
        { type: "opencode", model: "xai/grok-4.6", variant: "high" }
      ),
      policy: policy(),
    });
    expect(mixed.startIndex).toBe(2);
    expect(mixed.stickyFamily).toBe("grok");
  });
});
