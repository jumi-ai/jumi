import type { ForgeKind } from "./forge.ts";

/** Repository merge flags read by the merge-method strategy. */
export interface ForgeRepoMergeInfo {
  allowAutoMerge?: boolean;
  allowMergeCommit?: boolean;
  allowSquashMerge?: boolean;
  allowRebaseMerge?: boolean;
  allowMergeCommits?: boolean;
  allowRebase?: boolean;
  allowRebaseExplicit?: boolean;
  allowFastForwardOnlyMerge?: boolean;
  defaultMergeStyle?: string;
}

/** Result of the default (unconfigured) merge-method lookup. */
export type MergeDefaultResult =
  | { ok: true; mergeMethod: string }
  | { ok: false; reason: "no-method" | "unknown-style" };

/**
 * Merge-method strategy selected from the capabilities. GitHub speaks
 * `MERGE`/`SQUASH`/`REBASE` with an `allowAutoMerge` kill switch; Gitea
 * speaks its own style names with a `defaultMergeStyle` fallback. Both
 * refuse unknown styles fail-closed (the caller keeps the PR open with the
 * same sticky note text as today).
 */
export interface MergePolicy {
  isAutoMergeDisabled(repo: ForgeRepoMergeInfo): boolean;
  methodForConfiguredRepo(repo: ForgeRepoMergeInfo, method: string): string | undefined;
  defaultMethod(repo: ForgeRepoMergeInfo): MergeDefaultResult;
}

const GITEA_MERGE_STYLES = new Set(["merge", "rebase", "rebase-merge", "squash", "fast-forward-only"]);

const githubMergePolicy: MergePolicy = {
  isAutoMergeDisabled(repo) {
    return repo.allowAutoMerge === false;
  },
  methodForConfiguredRepo(repo, method) {
    switch (method) {
      case "merge":
        return repo.allowMergeCommit === false ? undefined : "MERGE";
      case "squash":
        return repo.allowSquashMerge === false ? undefined : "SQUASH";
      case "rebase":
        return repo.allowRebaseMerge === false ? undefined : "REBASE";
      default:
        return undefined;
    }
  },
  defaultMethod(repo) {
    if (repo.allowMergeCommit === true) return { ok: true, mergeMethod: "MERGE" };
    if (repo.allowSquashMerge === true) return { ok: true, mergeMethod: "SQUASH" };
    if (repo.allowRebaseMerge === true) return { ok: true, mergeMethod: "REBASE" };
    if (repo.allowMergeCommit === false && repo.allowSquashMerge === false && repo.allowRebaseMerge === false) {
      return { ok: false, reason: "no-method" };
    }
    // Unknown (fakes, older forges): the GitHub default is MERGE.
    return { ok: true, mergeMethod: "MERGE" };
  },
};

const giteaMergePolicy: MergePolicy = {
  isAutoMergeDisabled(_repo) {
    return false;
  },
  methodForConfiguredRepo(repo, method) {
    switch (method) {
      case "merge":
        return repo.allowMergeCommits === false ? undefined : "merge";
      case "squash":
        return repo.allowSquashMerge === false ? undefined : "squash";
      case "rebase":
        return repo.allowRebase === false ? undefined : "rebase";
      case "rebase-merge":
        return repo.allowRebaseExplicit === false ? undefined : "rebase-merge";
      case "fast-forward-only":
        return repo.allowFastForwardOnlyMerge === false ? undefined : "fast-forward-only";
      default:
        return undefined;
    }
  },
  defaultMethod(repo) {
    const style = repo.defaultMergeStyle || "merge";
    if (!GITEA_MERGE_STYLES.has(style)) return { ok: false, reason: "unknown-style" };
    return { ok: true, mergeMethod: style };
  },
};

/**
 * One row per forge kind covering exactly the branches flow code used to
 * decide by string comparison:
 * - `readableAutoMergeSchedule`: the forge reports a readable schedule
 *   state, so `wasScheduled` is meaningful (GitHub only).
 * - `supportsAutoMergeRestore`: the forge re-schedules after a push;
 *   otherwise pushes only cancel a schedule set earlier (Gitea is
 *   cancel-only in the restore path).
 * - `takeoverMarker`: the best-effort marker a takeover leaves.
 * - `pickupLabelApplies`: the pickup-label policy applies (GitHub only;
 *   Gitea uses assignees).
 * - `runnerChainsAvailable`: the xai/codex runner chains are offered.
 * - `mergePolicy`: the merge-method strategy for the automerge gates.
 */
export interface ForgeCapabilities {
  kind: ForgeKind;
  readableAutoMergeSchedule: boolean;
  supportsAutoMergeRestore: boolean;
  takeoverMarker: "label" | "assignee";
  pickupLabelApplies: boolean;
  runnerChainsAvailable: boolean;
  mergePolicy: MergePolicy;
}

export const FORGE_CAPABILITIES: Record<ForgeKind, ForgeCapabilities> = {
  gitea: {
    kind: "gitea",
    readableAutoMergeSchedule: false,
    supportsAutoMergeRestore: false,
    takeoverMarker: "assignee",
    pickupLabelApplies: false,
    runnerChainsAvailable: true,
    mergePolicy: giteaMergePolicy,
  },
  github: {
    kind: "github",
    readableAutoMergeSchedule: true,
    supportsAutoMergeRestore: true,
    takeoverMarker: "label",
    pickupLabelApplies: true,
    runnerChainsAvailable: false,
    mergePolicy: githubMergePolicy,
  },
};

/**
 * Resolve the capabilities for a forge kind. Defaults to `"gitea"`,
 * preserving today's `?? "gitea"` behaviour (including blank strings).
 * Accepts the loose `string` inputs entry points keep (`config.forge`,
 * `opts.forgeKind`) so call sites and tests that pass them need no change.
 */
export function forgeCapabilities(kind?: string | ForgeKind | null): ForgeCapabilities {
  const normalized = (kind ?? "gitea").trim().toLowerCase();
  if (normalized === "github") return FORGE_CAPABILITIES.github;
  return FORGE_CAPABILITIES.gitea;
}
