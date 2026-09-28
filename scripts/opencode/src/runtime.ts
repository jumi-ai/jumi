import {
  attachIssueWorktree,
  attachPrWorktree,
  type BeginClaimedWorktreeOpts,
  beginClaimedWorktree,
  type ClaimedEarlyResult,
  type ClaimedLoop,
  type ClaimedWorktree,
  ensureBareCache,
  isClaimedEarlyResult,
  openClaimedLoop,
} from "./claimed_worktree.ts";
import { type Engine, type EngineResult, type EngineRunOptions, runEngineStamped } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import type { NamedRunner, RunnerStamp } from "./runners.ts";
import type { GitAuthResolver, GitRunner } from "./workspace.ts";

/**
 * Runtime seam: the live computer stays the standing pod.
 *
 * A job runs inside the process that leased it. The control-plane contract
 * says a runtime is the computer a job boots: provision a workspace at a ref,
 * run the engine, stream logs, kill on timeout or cancel, hand artifacts back,
 * and destroy. The standing pod is the only live computer.
 *
 * - Both live factories (homelab gitea and the isolated github factory, and
 *   the opencode/claude engines behind `orderedRunners`) keep using this
 *   runtime. Same pickup, same pods, same cgroup. This module does not call
 *   the Kubernetes API, does not create Jobs, and does not run on Actions.
 * - Timeout and kill belong to the runtime (engine `timeoutMs` + abort).
 *   No memory API: the pod limit stays the cgroup.
 * - Logs stream to the parent via `logger`. This is not a second trace store.
 * - The runtime owns clone and worktree. The parent does not clone on the
 *   host and hand over a path: it asks the runtime to provision at a ref.
 * - The engine child receives no forge token. Clone credentials are injected
 *   by the parent through `GitAuthResolver`, as today.
 * - Auth is a mount the operator already has (`/data`, `/work` volumes from
 *   `deploy/contract.md`). The runtime does not log in and does not copy one
 *   ordinal's auth onto another.
 */

export type RuntimeName = "standing-pod";

export const STANDING_POD_RUNTIME: RuntimeName = "standing-pod";

export interface RuntimeProvisionBase {
  home: string;
  workdir: string;
  branch: string;
  defaultBranch: string;
  cloneUrl: string;
  giteaUrl: string;
  giteaToken?: string;
  botUsername?: string;
  gitAuthResolver?: GitAuthResolver;
  gitRunner?: GitRunner;
  abortSignal?: AbortSignal;
  logger?: (message: string) => void;
  engine?: Engine;
  openCodeRunner?: Engine;
  fallbackEngine?: Engine;
  chain?: NamedRunner[];
  fallbackModel?: string;
  fallbackVariant?: string;
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  useClaim?: boolean;
  sanitizeOpenCodeEnv?: boolean;
  heartbeatIntervalMs?: number;
  job: { owner: string; repo: string; issueNumber: number; issueUpdatedAt: string };
}

export interface RuntimeIssueSession {
  kind: "issue";
  claimed: ClaimedWorktree;
  loop: ClaimedLoop;
  workdir: string;
  headSha: string;
}

export interface RuntimePrSession {
  kind: "pr";
  claimed: ClaimedWorktree;
  loop: ClaimedLoop;
  workdir: string;
  headSha: string;
  baseSha: string;
}

export type RuntimeSession = RuntimeIssueSession | RuntimePrSession;

function beginOpts(opts: RuntimeProvisionBase, extra?: Partial<BeginClaimedWorktreeOpts>): BeginClaimedWorktreeOpts {
  return {
    job: opts.job,
    home: opts.home,
    workdir: opts.workdir,
    engine: opts.engine,
    openCodeRunner: opts.openCodeRunner,
    gitRunner: opts.gitRunner,
    abortSignal: opts.abortSignal,
    useClaim: opts.useClaim,
    sanitizeOpenCodeEnv: opts.sanitizeOpenCodeEnv,
    fallbackEngine: opts.fallbackEngine ?? registeredEngine,
    fallbackModel: opts.fallbackModel,
    fallbackVariant: opts.fallbackVariant,
    chain: opts.chain,
    remainingLeaseMs: opts.remainingLeaseMs,
    extendLease: opts.extendLease,
    logger: opts.logger,
    branch: opts.branch,
    ...extra,
  };
}

function loopOpts(opts: RuntimeProvisionBase): {
  giteaUrl: string;
  giteaToken: string;
  botUsername: string;
  gitAuthResolver?: GitAuthResolver;
  heartbeatIntervalMs?: number;
} {
  return {
    giteaUrl: opts.giteaUrl,
    giteaToken: opts.giteaToken ?? "",
    botUsername: opts.botUsername ?? "jumi",
    gitAuthResolver: opts.gitAuthResolver,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
  };
}

/**
 * Provision a workspace at a ref through the standing pod.
 * Owns the bare cache clone and the worktree attach; the caller never clones
 * on the host itself.
 */
export async function provisionIssueWorkspace(
  opts: RuntimeProvisionBase
): Promise<RuntimeIssueSession | ClaimedEarlyResult> {
  const claimed = await beginClaimedWorktree(beginOpts(opts));
  if (isClaimedEarlyResult(claimed)) return claimed;
  const loop = openClaimedLoop(claimed, loopOpts(opts));
  const log = opts.logger ?? (() => undefined);
  await ensureBareCache(loop, {
    cloneUrl: opts.cloneUrl,
    giteaUrl: opts.giteaUrl,
    abortSignal: opts.abortSignal,
    log,
  });
  const headSha = await attachIssueWorktree(loop, {
    branch: opts.branch,
    defaultBranch: opts.defaultBranch,
    abortSignal: opts.abortSignal,
    log,
  });
  await loop.stampHeadSha(headSha);
  return { kind: "issue", claimed, loop, workdir: claimed.worktree, headSha };
}

/** Provision a PR workspace at its head ref through the standing pod. */
export async function provisionPrWorkspace(opts: RuntimeProvisionBase): Promise<RuntimePrSession | ClaimedEarlyResult> {
  const claimed = await beginClaimedWorktree(beginOpts(opts));
  if (isClaimedEarlyResult(claimed)) return claimed;
  const loop = openClaimedLoop(claimed, loopOpts(opts));
  const log = opts.logger ?? (() => undefined);
  await ensureBareCache(loop, {
    cloneUrl: opts.cloneUrl,
    giteaUrl: opts.giteaUrl,
    abortSignal: opts.abortSignal,
    log,
  });
  const attached = await attachPrWorktree(loop, {
    branch: opts.branch,
    defaultBranch: opts.defaultBranch,
    abortSignal: opts.abortSignal,
    log,
  });
  if (isClaimedEarlyResult(attached)) {
    await loop.stopHeartbeat();
    await loop.forgetSerialized();
    await loop.detachWorktree();
    return attached;
  }
  await loop.stampHeadSha(attached.headSha);
  return {
    kind: "pr",
    claimed,
    loop,
    workdir: claimed.worktree,
    headSha: attached.headSha,
    baseSha: attached.baseSha,
  };
}

/**
 * Runtime-owned clone and worktree operations. The parent calls these rather
 * than cloning on the host itself; the implementation lives here so the
 * runtime owns the bare cache and the worktree attach/detach.
 */
export async function runtimeEnsureBareCache(
  loop: ClaimedLoop,
  opts: { cloneUrl: string; giteaUrl: string; abortSignal?: AbortSignal; log: (message: string) => void }
): Promise<void> {
  return ensureBareCache(loop, opts);
}

export async function runtimeAttachIssueWorktree(
  loop: ClaimedLoop,
  opts: { branch: string; defaultBranch: string; abortSignal?: AbortSignal; log: (message: string) => void }
): Promise<string> {
  return attachIssueWorktree(loop, opts);
}

export async function runtimeAttachPrWorktree(
  loop: ClaimedLoop,
  opts: { branch: string; defaultBranch: string; abortSignal?: AbortSignal; log: (message: string) => void }
): Promise<{ headSha: string; baseSha: string } | ClaimedEarlyResult> {
  return attachPrWorktree(loop, opts);
}

/**
 * Run the engine on the runtime's computer. Streams logs to the parent via
 * `opts.logger`. Timeout and abort kill the child; no memory API.
 */
export async function runRuntimeEngine(
  loop: ClaimedLoop,
  engine: Engine,
  opts: EngineRunOptions,
  onRunner: (runner: RunnerStamp) => void
): Promise<EngineResult> {
  return runEngineStamped(engine, { ...opts, workdir: loop.worktree }, onRunner);
}

/**
 * Destroy runs on success, failure, timeout, and cancel. A failed destroy
 * must not discard a push that already landed: destroy errors are logged and
 * swallowed when `pushLanded` is true, and the caller's prior result is
 * returned unchanged.
 */
export async function destroyRuntimeWorkspace(
  loop: ClaimedLoop,
  opts: { pushLanded: boolean; logger?: (message: string) => void }
): Promise<void> {
  try {
    await loop.stopHeartbeat();
  } catch (err) {
    opts.logger?.(`runtime destroy heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!opts.pushLanded) throw err;
  }
  if (!opts.pushLanded) {
    try {
      await loop.forgetSerialized();
    } catch (err) {
      opts.logger?.(`runtime destroy forget failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  } else {
    await loop.forgetSerialized().catch((err: unknown) => {
      opts.logger?.(`runtime destroy forget failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  try {
    await loop.detachWorktree();
  } catch (err) {
    // Best effort on the way out; a push that already landed stays landed.
    opts.logger?.(`runtime destroy detach failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!opts.pushLanded) throw err;
  }
}

/** The live runtime both factories keep using. Neither factory selects docker. */
export const standingPodRuntime = {
  name: STANDING_POD_RUNTIME,
  provisionIssueWorkspace,
  provisionPrWorkspace,
  ensureBareCache: runtimeEnsureBareCache,
  attachIssueWorktree: runtimeAttachIssueWorktree,
  attachPrWorktree: runtimeAttachPrWorktree,
  runRuntimeEngine,
  destroyRuntimeWorkspace,
};

export type StandingPodRuntime = typeof standingPodRuntime;
