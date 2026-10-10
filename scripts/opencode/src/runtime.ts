import {
  attachIssueWorktree,
  attachPrWorktree,
  type ClaimedEarlyResult,
  type ClaimedLoop,
  ensureBareCache,
} from "./claimed_worktree.ts";
import { type Engine, type EngineResult, type EngineRunOptions, runEngineStamped } from "./engine.ts";
import type { RunnerStamp } from "./runners.ts";

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
 *   host and hand over a path: it asks the runtime for the bare-cache clone
 *   (`ensureBareCache`) and the worktree attach (`attachIssueWorktree` /
 *   `attachPrWorktree`), then runs the engine and destroys through it.
 *   The claim lifecycle around that — `beginClaimedWorktree` /
 *   `openClaimedLoop` up front, and the terminal-claim stamp versus
 *   `forgetSerialized` on the way out — stays in core: stamping a terminal
 *   claim needs a forge read and follows the core's per-flow rules, so
 *   `destroyRuntimeWorkspace` deliberately covers only the
 *   stop-heartbeat / forget / detach teardown plus the push-landed contract.
 * - The engine child receives no forge token. Clone credentials are injected
 *   by the parent through `GitAuthResolver`, as today.
 * - Auth is a mount the operator already has (`/data`, `/work` volumes from
 *   `deploy/contract.md`). The runtime does not log in and does not copy one
 *   ordinal's auth onto another.
 */

export type RuntimeName = "standing-pod";

export const STANDING_POD_RUNTIME: RuntimeName = "standing-pod";

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
  onRunner: (runner: RunnerStamp, chainIndex?: number) => void
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
  // Best-effort on the way out: attempt every step and throw the first error
  // at the end (non-landed only), so one failing teardown step cannot leak the
  // rest. Landed paths keep swallowing + logging as today.
  let firstErr: unknown;
  try {
    await loop.stopHeartbeat();
  } catch (err) {
    opts.logger?.(`runtime destroy heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    if (firstErr === undefined) firstErr = err;
  }
  if (!opts.pushLanded) {
    try {
      await loop.forgetSerialized();
    } catch (err) {
      opts.logger?.(`runtime destroy forget failed: ${err instanceof Error ? err.message : String(err)}`);
      if (firstErr === undefined) firstErr = err;
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
    if (firstErr === undefined) firstErr = err;
  }
  if (firstErr !== undefined && !opts.pushLanded) throw firstErr;
}

/** The live runtime both factories keep using. Neither factory selects docker. */
export const standingPodRuntime = {
  name: STANDING_POD_RUNTIME,
  ensureBareCache: runtimeEnsureBareCache,
  attachIssueWorktree: runtimeAttachIssueWorktree,
  attachPrWorktree: runtimeAttachPrWorktree,
  runRuntimeEngine,
  destroyRuntimeWorkspace,
};

export type StandingPodRuntime = typeof standingPodRuntime;
