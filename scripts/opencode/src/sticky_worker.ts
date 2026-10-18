import type { ClaimedLoop } from "./claimed_worktree.ts";
import { worktreePorcelain } from "./claimed_worktree.ts";
import { logDiagnostic } from "./diagnostics.ts";
import { type Engine, resolveEngine } from "./engine.ts";
import { withEngineChain } from "./fallback.ts";
import { resolveStickyWorkerStart } from "./independent_review.ts";
import { normalizeForge, ProvenanceCollector, type ProvenanceStore } from "./provenance.ts";
import {
  describeAttemptOrder,
  type IndependentReviewConfig,
  type NamedRunner,
  orderChainForJob,
  resolveRunnerSelection,
  rotateChainForStart,
} from "./runners.ts";

export interface StickyWorkerInput {
  chain?: NamedRunner[];
  effectiveChain?: NamedRunner[];
  runnerSelection?: string;
  runnerRandom?: () => number;
  independentReview?: IndependentReviewConfig;
  provenance?: ProvenanceStore;
  provenanceJob?: { forge: string };
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  branch?: string;
  jobKey?: string;
}

export interface StickyWorkerResolution {
  chain: NamedRunner[] | undefined;
  startIndex: number | undefined;
  stickyFamily: string | undefined;
  stickyApplied: boolean;
  reason: string | undefined;
  writerFamilies: string[];
  writers: string[];
}

/** Pure sticky decision for tests: no I/O, no logging. */
export async function decideStickyWorkerChain(input: StickyWorkerInput): Promise<StickyWorkerResolution> {
  const configured = input.chain ?? input.effectiveChain;
  const fallback = input.effectiveChain ?? input.chain;
  if (!configured || configured.length === 0) {
    return {
      chain: fallback,
      startIndex: undefined,
      stickyFamily: undefined,
      stickyApplied: false,
      reason: "no worker chain",
      writerFamilies: [],
      writers: [],
    };
  }
  if (!input.provenance || input.independentReview?.enabled !== true) {
    return {
      chain: fallback,
      startIndex: undefined,
      stickyFamily: undefined,
      stickyApplied: false,
      reason: input.independentReview?.enabled === true ? "no provenance store" : "independent review disabled",
      writerFamilies: [],
      writers: [],
    };
  }
  let lookup: Awaited<ReturnType<NonNullable<typeof input.provenance>["lookupByHead"]>>;
  try {
    lookup = await input.provenance.lookupByHead(
      normalizeForge(input.provenanceJob?.forge),
      input.owner,
      input.repo,
      input.headSha
    );
  } catch (err) {
    return {
      chain: fallback,
      startIndex: undefined,
      stickyFamily: undefined,
      stickyApplied: false,
      reason: `provenance lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      writerFamilies: [],
      writers: [],
    };
  }
  const decision = resolveStickyWorkerStart({ chain: configured, provenance: lookup, policy: input.independentReview });
  if (decision.startIndex == null) {
    return {
      chain: fallback,
      startIndex: undefined,
      stickyFamily: undefined,
      stickyApplied: false,
      reason: decision.reason ?? "no sticky family",
      writerFamilies: decision.writerFamilies,
      writers: decision.writers,
    };
  }
  const rotated = rotateChainForStart(configured, decision.startIndex);
  return {
    chain: rotated,
    startIndex: decision.startIndex,
    stickyFamily: decision.stickyFamily,
    stickyApplied: true,
    reason: undefined,
    writerFamilies: decision.writerFamilies,
    writers: decision.writers,
  };
}

export function logStickyWorkerSelection(
  log: (message: string) => void,
  opts: { owner: string; repo: string; prNumber: number; headSha: string; jobKey?: string },
  selection: string,
  chain: readonly NamedRunner[] | undefined,
  resolution: StickyWorkerResolution
): void {
  if (!chain || chain.length === 0) return;
  if (resolution.stickyApplied) {
    logDiagnostic(log, "runner_selection", {
      job: `${opts.owner}/${opts.repo}#${opts.prNumber}`,
      head: opts.headSha,
      selection,
      start: chain[0]?.name ?? null,
      order: describeAttemptOrder([...chain]),
      sticky: "writer-family",
      sticky_family: resolution.stickyFamily ?? null,
      writers: resolution.writers.join(",") || null,
      writer_groups: resolution.writerFamilies.join(",") || null,
    });
  } else if (resolution.writers.length > 0 && resolution.reason) {
    logDiagnostic(log, "runner_selection", {
      job: `${opts.owner}/${opts.repo}#${opts.prNumber}`,
      head: opts.headSha,
      selection,
      start: chain[0]?.name ?? null,
      order: describeAttemptOrder([...chain]),
      sticky: "fallback-no-writer-in-chain",
      reason: resolution.reason.slice(0, 120),
      writers: resolution.writers.join(",") || null,
      writer_groups: resolution.writerFamilies.join(",") || null,
    });
  }
}

/** Worktree dirtiness probe backed by parent git status (excludes scratch). */
export function worktreeDirtyProbe(loop: ClaimedLoop): () => Promise<boolean | undefined> {
  return async () => {
    try {
      const porcelain = await worktreePorcelain(loop);
      return porcelain.trim().length > 0;
    } catch {
      return undefined;
    }
  };
}

export interface ActiveWorkerEngine {
  chain: NamedRunner[] | undefined;
  engine: Engine;
  collector: ProvenanceCollector;
  resolution: StickyWorkerResolution;
}

/**
 * Build the active worker engine for a follow-up-style job on a PR head.
 * Sticky writer families rotate the configured chain; otherwise the existing
 * effective (random-start) order is preserved. The engine always carries a
 * worktree-dirty probe so clean quota/auth hops are excluded from provenance.
 */
export async function buildActiveWorkerEngine(input: {
  baseEngine: Engine;
  baseChain?: NamedRunner[];
  effectiveChain?: NamedRunner[];
  runnerSelection?: string;
  runnerRandom?: () => number;
  independentReview?: IndependentReviewConfig;
  provenance?: ProvenanceStore;
  provenanceJob?: { forge: string };
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  branch?: string;
  jobKey?: string;
  loop: ClaimedLoop;
  log: (message: string) => void;
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
}): Promise<ActiveWorkerEngine> {
  const configuredBase = input.baseChain ?? input.effectiveChain;
  const resolution = await decideStickyWorkerChain({
    chain: configuredBase,
    effectiveChain: input.effectiveChain,
    runnerSelection: input.runnerSelection,
    runnerRandom: input.runnerRandom,
    independentReview: input.independentReview,
    provenance: input.provenance,
    provenanceJob: input.provenanceJob,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    branch: input.branch,
    jobKey: input.jobKey,
  });
  const selection = resolveRunnerSelection({ selection: input.runnerSelection ?? undefined });
  const activeChain = resolution.chain ?? input.effectiveChain ?? input.baseChain;
  logStickyWorkerSelection(
    input.log,
    { owner: input.owner, repo: input.repo, prNumber: input.prNumber, headSha: input.headSha, jobKey: input.jobKey },
    selection,
    activeChain,
    resolution
  );
  const engine = withEngineChain(input.baseEngine, {
    chain: activeChain,
    selection,
    random: () => 0,
    worktreeDirty: worktreeDirtyProbe(input.loop),
    remainingLeaseMs: input.remainingLeaseMs,
    extendLease: input.extendLease,
    logger: input.log,
  });
  const collector = new ProvenanceCollector(activeChain);
  return { chain: activeChain, engine, collector, resolution };
}

export function baseWorkerEngine(opts: { engine?: Engine; openCodeRunner?: Engine }, fallback: Engine): Engine {
  return resolveEngine(opts, fallback);
}

// Re-export for callers that already order chains themselves.
export { orderChainForJob };
