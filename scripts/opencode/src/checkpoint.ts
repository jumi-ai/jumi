import { tipTracksAttachments, tipTracksEngineScratch } from "./engine_scratch.ts";
import { tipAddedSentinels } from "./sentinels.ts";
import { isExternalIssueJob } from "./tracker.ts";
import type { IssueJob } from "./types.ts";
import type { GitRunner } from "./workspace.ts";

export const CHECKPOINT_REF_PREFIX = "refs/jumi/wip/";
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 300_000;
export const DEFAULT_CHECKPOINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function checkpointRefForIssue(issueNumber: number): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number for checkpoint ref: ${issueNumber}`);
  }
  return `${CHECKPOINT_REF_PREFIX}${issueNumber}`;
}

function sanitizeCheckpointSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "brief";
}

/** Per-job hidden ref. Internal jobs use the issue number; external briefs have issueNumber 0. */
export function checkpointRefForJob(job: Pick<IssueJob, "issueNumber" | "tracker" | "trackerId">): string {
  if (!isExternalIssueJob(job)) return checkpointRefForIssue(job.issueNumber);
  const tracker = sanitizeCheckpointSegment((job.tracker ?? "").trim() || "ext");
  const id = sanitizeCheckpointSegment((job.trackerId ?? "").trim() || "brief");
  return `${CHECKPOINT_REF_PREFIX}ext-${tracker}-${id}`;
}

/** True for Jumi's private checkpoint namespace (never a branch or PR ref). */
export function isCheckpointRef(ref: string): boolean {
  return ref.startsWith(CHECKPOINT_REF_PREFIX);
}

export interface CheckpointConfig {
  enabled: boolean;
  intervalMs: number;
  maxAgeMs: number;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean: ${value}`);
}

function parseIntervalMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const raw = value.trim();
  if (raw === "0") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for JUMI_CHECKPOINT_INTERVAL_MS: ${value}`);
  }
  return parsed;
}

function parseMaxAgeMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for JUMI_CHECKPOINT_MAX_AGE_MS: ${value}`);
  }
  return parsed;
}

export function resolveCheckpointConfig(env: Record<string, string | undefined> = process.env): CheckpointConfig {
  const enabled = parseBool(env.JUMI_CHECKPOINT_ENABLED, true);
  const intervalMs = parseIntervalMs(env.JUMI_CHECKPOINT_INTERVAL_MS, DEFAULT_CHECKPOINT_INTERVAL_MS);
  const maxAgeMs = parseMaxAgeMs(env.JUMI_CHECKPOINT_MAX_AGE_MS, DEFAULT_CHECKPOINT_MAX_AGE_MS);
  if (!enabled || intervalMs === 0) return { enabled: false, intervalMs, maxAgeMs };
  return { enabled: true, intervalMs, maxAgeMs };
}

/** Minimal loop surface checkpointing needs (a subset of ClaimedLoop). */
export interface CheckpointLoop {
  worktree: string;
  barePath: string;
  env: Record<string, string | undefined>;
  runConfiguredGit: GitRunner;
  refreshGitAuth?: () => Promise<void>;
  refExists: (ref: string) => Promise<boolean>;
}

export function isRefNamespaceRefusal(message: string): boolean {
  return /denied|refus|not allowed|invalid|prohibit|cannot lock|permission/i.test(message);
}

function isMissingRemoteRef(message: string): boolean {
  return /remote ref does not exist|no such ref|not found|\b404\b/i.test(message);
}

export interface PushCheckpointOpts {
  expectedSha?: string;
  branch: string;
  defaultBranch: string;
  log?: (message: string) => void;
}

export interface PushCheckpointResult {
  pushed: boolean;
  sha?: string;
  disabled?: boolean;
  reason?: string;
}

async function tipGuards(loop: CheckpointLoop, opts: { defaultBranch: string }): Promise<string | undefined> {
  if (await tipTracksEngineScratch(loop.runConfiguredGit, { cwd: loop.worktree, env: loop.env })) {
    return "tip tracks engine scratch";
  }
  if (await tipTracksAttachments(loop.runConfiguredGit, { cwd: loop.worktree, env: loop.env })) {
    return "tip tracks attachments";
  }
  const added = await tipAddedSentinels(loop.runConfiguredGit, {
    cwd: loop.worktree,
    env: loop.env,
    defaultBranch: opts.defaultBranch,
  });
  if (added.length > 0) return `tip adds sentinels: ${added.join(", ")}`;
  return undefined;
}

export async function pushCheckpointRef(
  loop: CheckpointLoop,
  ref: string,
  opts: PushCheckpointOpts
): Promise<PushCheckpointResult> {
  if (!isCheckpointRef(ref)) return { pushed: false, reason: "not a checkpoint ref" };
  if (!opts.branch || opts.branch === opts.defaultBranch) {
    return { pushed: false, reason: "refusing to checkpoint the default branch" };
  }
  let head = "";
  try {
    head = (await loop.runConfiguredGit(["rev-parse", "HEAD"], { cwd: loop.worktree, env: loop.env })).trim();
  } catch (err) {
    return { pushed: false, reason: `cannot read HEAD: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!head || /^0+$/.test(head)) return { pushed: false, reason: "no HEAD" };
  if (opts.expectedSha && head === opts.expectedSha) return { pushed: false, reason: "unchanged" };
  try {
    const guard = await tipGuards(loop, { defaultBranch: opts.defaultBranch });
    if (guard) return { pushed: false, reason: guard };
  } catch (err) {
    return { pushed: false, reason: `guard lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    await loop.refreshGitAuth?.();
  } catch {
    // A refresh failure surfaces as a push failure below; never throw here.
  }
  const pushOnce = async (args: string[]): Promise<void> => {
    await loop.runConfiguredGit(args, { cwd: loop.worktree, env: loop.env });
  };
  try {
    await pushOnce(["push", "origin", `HEAD:${ref}`]);
    return { pushed: true, sha: head };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isRefNamespaceRefusal(message)) {
      return { pushed: false, disabled: true, reason: message };
    }
    // A concurrent checkpoint from another attempt can make a plain push
    // non-fast-forward; the lease retries once with the expected base.
    if (opts.expectedSha && /non-fast-forward|fetch first|rejected/i.test(message)) {
      try {
        await pushOnce(["push", `--force-with-lease=${ref}:${opts.expectedSha}`, "origin", `HEAD:${ref}`]);
        return { pushed: true, sha: head };
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        if (isRefNamespaceRefusal(retryMessage)) {
          return { pushed: false, disabled: true, reason: retryMessage };
        }
        return { pushed: false, reason: retryMessage };
      }
    }
    return { pushed: false, reason: message };
  }
}

export interface DeleteCheckpointResult {
  deleted: boolean;
  reason?: string;
}

/**
 * Delete a hidden ref remotely and locally. Deleting a missing ref is not an
 * error (idempotent cleanup after close/merge/skip).
 */
export async function deleteCheckpointRef(
  loop: CheckpointLoop,
  ref: string,
  opts: { log?: (message: string) => void } = {}
): Promise<DeleteCheckpointResult> {
  if (!isCheckpointRef(ref)) return { deleted: false, reason: "not a checkpoint ref" };
  try {
    await loop.refreshGitAuth?.();
  } catch {
    // Fall through to the push attempt, which reports the failure.
  }
  try {
    await loop.runConfiguredGit(["push", "origin", `:${ref}`], { cwd: loop.barePath, env: loop.env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isMissingRemoteRef(message)) {
      // Fall through to local cleanup.
    } else {
      opts.log?.(`checkpoint delete failed for ${ref}: ${message.split("\n")[0]}`);
      return { deleted: false, reason: message };
    }
  }
  try {
    await loop.runConfiguredGit(["update-ref", "-d", ref], { cwd: loop.barePath, env: loop.env });
  } catch {
    // Local ref may never have been fetched; remote delete already landed.
  }
  return { deleted: true };
}

export interface RestoreCheckpointOpts {
  branch: string;
  defaultBranch: string;
  log?: (message: string) => void;
}

export interface RestoreCheckpointResult {
  restored: boolean;
  sha?: string;
  reason?: string;
}

async function isAncestor(loop: CheckpointLoop, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await loop.runConfiguredGit(["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: loop.barePath,
      env: loop.env,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch the hidden ref and, when it is a strict fast-forward of what the
 * local worktree and `origin/<branch>` have, point `refs/heads/<branch>` at
 * it so the normal attach path reuses it. Diverged or stale checkpoints are
 * ignored with one logged line, never applied silently.
 */
export async function restoreCheckpoint(
  loop: CheckpointLoop,
  ref: string,
  opts: RestoreCheckpointOpts
): Promise<RestoreCheckpointResult> {
  if (!isCheckpointRef(ref)) return { restored: false, reason: "not a checkpoint ref" };
  if (!opts.branch || opts.branch === opts.defaultBranch) {
    return { restored: false, reason: "refusing to restore onto the default branch" };
  }
  try {
    await loop.runConfiguredGit(["fetch", "origin", `+${ref}:${ref}`], { cwd: loop.barePath, env: loop.env });
  } catch {
    return { restored: false, reason: "no checkpoint" };
  }
  let checkpointSha = "";
  try {
    if (!(await loop.refExists(ref))) return { restored: false, reason: "no checkpoint" };
    checkpointSha = (await loop.runConfiguredGit(["rev-parse", ref], { cwd: loop.barePath, env: loop.env })).trim();
  } catch {
    return { restored: false, reason: "no checkpoint" };
  }
  if (!checkpointSha || /^0+$/.test(checkpointSha)) return { restored: false, reason: "no checkpoint" };
  let baseSha = "";
  try {
    baseSha = (
      await loop.runConfiguredGit(["rev-parse", `origin/${opts.defaultBranch}`], {
        cwd: loop.barePath,
        env: loop.env,
      })
    ).trim();
  } catch {
    return { restored: false, reason: "unknown base" };
  }
  if (!baseSha) return { restored: false, reason: "unknown base" };
  if (!(await isAncestor(loop, baseSha, checkpointSha))) {
    opts.log?.(`ignoring checkpoint ${ref}: not a descendant of origin/${opts.defaultBranch}`);
    return { restored: false, reason: "checkpoint not descendant of base" };
  }
  const originBranch = `refs/remotes/origin/${opts.branch}`;
  const originExists = await loop.refExists(originBranch).catch(() => false);
  if (!originExists) {
    try {
      await loop.runConfiguredGit(["update-ref", `refs/heads/${opts.branch}`, checkpointSha], {
        cwd: loop.barePath,
        env: loop.env,
      });
    } catch (err) {
      return {
        restored: false,
        reason: `cannot stage checkpoint: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { restored: true, sha: checkpointSha };
  }
  let originSha = "";
  try {
    originSha = (
      await loop.runConfiguredGit(["rev-parse", originBranch], { cwd: loop.barePath, env: loop.env })
    ).trim();
  } catch {
    return { restored: false, reason: "unknown origin branch" };
  }
  if (originSha === checkpointSha) return { restored: false, reason: "already current" };
  if (await isAncestor(loop, originSha, checkpointSha)) {
    try {
      await loop.runConfiguredGit(["update-ref", `refs/heads/${opts.branch}`, checkpointSha], {
        cwd: loop.barePath,
        env: loop.env,
      });
    } catch (err) {
      return {
        restored: false,
        reason: `cannot stage checkpoint: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { restored: true, sha: checkpointSha };
  }
  if (await isAncestor(loop, checkpointSha, originSha)) {
    opts.log?.(`ignoring checkpoint ${ref}: origin/${opts.branch} is ahead`);
    return { restored: false, reason: "origin branch ahead of checkpoint" };
  }
  opts.log?.(`ignoring checkpoint ${ref}: diverged from origin/${opts.branch}`);
  return { restored: false, reason: "checkpoint diverged from PR head" };
}

export interface CheckpointTickerOpts {
  ref: string;
  branch: string;
  defaultBranch: string;
  intervalMs: number;
  enabled: boolean;
  log?: (message: string) => void;
}

export interface CheckpointTicker {
  stop: () => Promise<void>;
  getLastSha: () => string | undefined;
  isDisabled: () => boolean;
}

/**
 * Start the ticker and tie its lifetime to the loop's heartbeat: every exit
 * path (`runClaimedLoop` finally, `destroyRuntimeWorkspace`, `skipClaimedWork`)
 * stops the heartbeat, which then stops the ticker first. Call once after the
 * worktree is attached; no explicit stop is needed on early returns.
 */
export function beginCheckpointing(
  loop: CheckpointLoop & { stopHeartbeat: () => Promise<void> },
  opts: CheckpointTickerOpts
): CheckpointTicker {
  const ticker = startCheckpointTicker(loop, opts);
  const original = loop.stopHeartbeat.bind(loop);
  let stopped = false;
  (loop as { stopHeartbeat: () => Promise<void> }).stopHeartbeat = async () => {
    if (!stopped) {
      stopped = true;
      await ticker.stop().catch(() => undefined);
    }
    await original();
  };
  return ticker;
}

/**
 * Periodic checkpoint while a worker engine runs. Pushes only when HEAD moved
 * since the last checkpoint; failures are logged once and never fail the run.
 * A forge that refuses the custom ref namespace disables the ticker with one
 * logged line.
 */
export function startCheckpointTicker(loop: CheckpointLoop, opts: CheckpointTickerOpts): CheckpointTicker {
  let lastSha: string | undefined;
  let disabled = !opts.enabled || !(opts.intervalMs > 0);
  let stopped = false;
  let inFlight = false;
  let failureLogged = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped || disabled || inFlight) return;
    inFlight = true;
    try {
      const result = await pushCheckpointRef(loop, opts.ref, {
        expectedSha: lastSha,
        branch: opts.branch,
        defaultBranch: opts.defaultBranch,
        log: opts.log,
      });
      if (result.pushed && result.sha) {
        lastSha = result.sha;
        failureLogged = false;
        return;
      }
      if (result.disabled) {
        disabled = true;
        opts.log?.(`checkpointing disabled for this run: forge refused ${opts.ref}`);
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        return;
      }
      // Guard skips (scratch/attachments/sentinels, unchanged, default branch)
      // are quiet: the final push path reports the refusal when it matters.
      if (result.reason && !failureLogged && /guard lookup failed|cannot read HEAD/i.test(result.reason)) {
        failureLogged = true;
        opts.log?.(`checkpoint failed for ${opts.ref}: ${result.reason.split("\n")[0]}`);
      } else if (
        result.reason &&
        !failureLogged &&
        result.reason !== "unchanged" &&
        !/tip tracks|tip adds|default branch|no HEAD/i.test(result.reason)
      ) {
        failureLogged = true;
        opts.log?.(`checkpoint failed for ${opts.ref}: ${result.reason.split("\n")[0]}`);
      }
    } catch (err) {
      if (!failureLogged) {
        failureLogged = true;
        opts.log?.(
          `checkpoint failed for ${opts.ref}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`
        );
      }
    } finally {
      inFlight = false;
    }
  };

  if (!disabled && opts.intervalMs > 0) {
    timer = setInterval(() => {
      void tick();
    }, opts.intervalMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    getLastSha: () => lastSha,
    isDisabled: () => disabled,
  };
}

export interface StaleCheckpoint {
  ref: string;
  commitUnixTime?: number;
}

/**
 * Pure age filter for the stale-ref sweep: refs older than `maxAgeMs` are
 * sweep candidates. Deletion itself stays in `deleteCheckpointRef` so a
 * missing ref is never an error.
 */
export function staleCheckpointRefs(
  refs: readonly StaleCheckpoint[],
  opts: { maxAgeMs: number; nowMs?: number }
): string[] {
  const nowMs = opts.nowMs ?? Date.now();
  return refs
    .filter((entry) => {
      if (!isCheckpointRef(entry.ref)) return false;
      if (entry.commitUnixTime == null || !Number.isFinite(entry.commitUnixTime)) return false;
      return nowMs - entry.commitUnixTime * 1000 > opts.maxAgeMs;
    })
    .map((entry) => entry.ref);
}

export interface SweepStaleCheckpointsOpts {
  maxAgeMs: number;
  nowMs?: number;
  log?: (message: string) => void;
}

/**
 * Production stale-ref sweep: fetch all `refs/jumi/wip/*` from the forge into
 * the bare cache, list them with committer timestamps, and delete entries
 * older than `maxAgeMs` via `deleteCheckpointRef` (remote + local, missing
 * refs are not an error). Best-effort: fetch/listing failures yield an empty
 * sweep and individual delete failures are logged once; never throws.
 */
export async function sweepStaleCheckpoints(
  loop: CheckpointLoop,
  opts: SweepStaleCheckpointsOpts
): Promise<string[]> {
  if (!(opts.maxAgeMs > 0)) return [];
  try {
    await loop.runConfiguredGit(["fetch", "origin", `+${CHECKPOINT_REF_PREFIX}*:${CHECKPOINT_REF_PREFIX}*`], {
      cwd: loop.barePath,
      env: loop.env,
    });
  } catch {
    // Fall through to whatever refs already exist locally.
  }
  let listing = "";
  try {
    listing = await loop.runConfiguredGit(["for-each-ref", "--format=%(refname) %(committerdate:unix)", CHECKPOINT_REF_PREFIX], {
      cwd: loop.barePath,
      env: loop.env,
    });
  } catch {
    return [];
  }
  const entries: StaleCheckpoint[] = [];
  for (const line of listing.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const ref = parts[0];
    const stamp = parts[1];
    if (!ref || stamp === undefined) continue;
    const commitUnixTime = Number.parseInt(stamp, 10);
    entries.push({ ref, commitUnixTime: Number.isFinite(commitUnixTime) ? commitUnixTime : undefined });
  }
  const stale = staleCheckpointRefs(entries, { maxAgeMs: opts.maxAgeMs, nowMs: opts.nowMs });
  const deleted: string[] = [];
  for (const ref of stale) {
    try {
      const result = await deleteCheckpointRef(loop, ref, { log: opts.log });
      if (result.deleted) deleted.push(ref);
    } catch {
      // Best-effort per ref; continue with the rest.
    }
  }
  if (deleted.length > 0) {
    opts.log?.(`checkpoint sweep deleted ${deleted.length} stale ref(s): ${deleted.join(", ")}`);
  }
  return deleted;
}

/**
 * Best-effort forge-side delete of a checkpoint ref (post-push and
 * close/merge/cancel paths that have no worktree). Missing refs and missing
 * forge support are silent; other failures log one line and never throw.
 * Unlike `deleteCheckpointRef` this never runs git, so guarded skip paths
 * stay push-free.
 */
export async function deleteCheckpointRefViaForge(
  api: unknown,
  owner: string,
  repo: string,
  ref: string,
  opts: { log?: (message: string) => void } = {}
): Promise<void> {
  if (!isCheckpointRef(ref)) return;
  const deleteGitRef =
    typeof api === "object" && api !== null
      ? (api as { deleteGitRef?: (owner: string, repo: string, ref: string) => Promise<void> }).deleteGitRef
      : undefined;
  if (typeof deleteGitRef !== "function") return;
  try {
    await (deleteGitRef as (owner: string, repo: string, ref: string) => Promise<void>).call(api, owner, repo, ref);
  } catch (err) {
    opts.log?.(
      `checkpoint delete failed for ${ref}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`
    );
  }
}

/**
 * Best-effort forge-side delete of one issue's checkpoint ref (close/merge/
 * cancel paths that have no worktree). Missing refs and missing forge support
 * are silent; other failures log one line and never throw.
 */
export async function deleteCheckpointForIssueViaForge(
  api: unknown,
  owner: string,
  repo: string,
  issueNumber: number,
  opts: { log?: (message: string) => void } = {}
): Promise<void> {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return;
  await deleteCheckpointRefViaForge(api, owner, repo, checkpointRefForIssue(issueNumber), opts);
}
