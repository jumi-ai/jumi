import {
  type CiGateWait,
  effectiveBlockingQuestionAuthors,
  effectiveCiGateWait,
  effectiveConflictRounds,
  effectiveFollowupIgnoreLogins,
  effectiveFollowupRounds,
  effectiveIgnoreConflictsLabel,
  effectivePickupLabel,
  effectiveTrustedSenderLogins,
  isSuggestionFollowupEnabled,
  loadRepoSettings,
  type RepoMode,
  type RepoSettingsFileApi,
  type RepoSettingsLoad,
  repoMode,
} from "./repo_settings.ts";
import { errorMessage } from "./util/error.ts";

/** Who and where to read the default-branch `.jumi.yml` for. */
export interface RepoPolicyContext {
  api: RepoSettingsFileApi | undefined;
  owner: string;
  repo: string;
  /** Preferred ref; falls back to `defaultBranch` when absent. */
  ref?: string | undefined | null;
  defaultBranch?: string | undefined | null;
}

/** Deployment values a repository file can narrow or extend. */
export interface RepoPolicyDeployment {
  trustedSenderLogins?: readonly string[] | undefined | null;
  followupIgnoreLogins?: readonly string[] | undefined | null;
  ignoreConflictsLabel?: string | undefined | null;
  blockingQuestionAuthors?: readonly string[] | undefined | null;
  maxFollowupRounds: number;
  maxConflictRounds: number;
}

export type RepoPolicyStatus = "ok" | "missing" | "invalid" | "unreadable";

/** Derived per-repository job policy plus the load it came from. */
export interface RepoPolicy {
  load: RepoSettingsLoad;
  status: RepoPolicyStatus;
  error?: string;
  trustedSenderLogins: readonly string[] | undefined;
  followupIgnoreLogins: string[];
  ignoreConflictsLabel: string;
  blockingQuestionAuthors: string[];
  maxFollowupRounds: number;
  maxConflictRounds: number;
  followupOnSuggestions: boolean;
  pickupLabel: string;
  ciGateWait: CiGateWait;
  mode: RepoMode;
}

export interface ResolveRepoPolicyOptions {
  onUnreadable: "fallback" | "throw";
  /** Memoised policy: when present no forge read happens. */
  reuse?: RepoPolicy | undefined;
}

/** Pure derivation from an already-loaded settings file. Reuses the existing `effective*` helpers. */
export function deriveRepoPolicy(
  load: RepoSettingsLoad,
  deployment: RepoPolicyDeployment
): Omit<RepoPolicy, "load" | "status" | "error"> {
  return {
    trustedSenderLogins: effectiveTrustedSenderLogins(deployment.trustedSenderLogins, load),
    followupIgnoreLogins: effectiveFollowupIgnoreLogins(deployment.followupIgnoreLogins, load),
    ignoreConflictsLabel: effectiveIgnoreConflictsLabel(deployment.ignoreConflictsLabel, load),
    blockingQuestionAuthors: effectiveBlockingQuestionAuthors(deployment.blockingQuestionAuthors, load),
    maxFollowupRounds: effectiveFollowupRounds(deployment.maxFollowupRounds, load),
    maxConflictRounds: effectiveConflictRounds(deployment.maxConflictRounds, load),
    followupOnSuggestions: isSuggestionFollowupEnabled(load),
    pickupLabel: effectivePickupLabel(load),
    ciGateWait: effectiveCiGateWait(load),
    mode: repoMode(load),
  };
}

function deploymentOnlyPolicy(
  load: RepoSettingsLoad,
  status: RepoPolicyStatus,
  deployment: RepoPolicyDeployment,
  error?: string
): RepoPolicy {
  const derived = deriveRepoPolicy(load, deployment);
  return {
    load,
    status,
    ...(error !== undefined ? { error } : {}),
    ...derived,
  };
}

/**
 * Resolve the effective per-repository policy with one `.jumi.yml` read
 * through `loadRepoSettings` (still the only reader). Callers keep their own
 * log wording by reading `status`/`error`. `onUnreadable: "fallback"` returns
 * the deployment-only policy with `status: "unreadable"`; `"throw"` rethrows
 * so the caller can log in its own catch. Empty refs and a missing file API
 * return the deployment-only policy with `status: "missing"` without reading.
 */
export async function resolveRepoPolicy(
  ctx: RepoPolicyContext,
  deployment: RepoPolicyDeployment,
  opts: ResolveRepoPolicyOptions
): Promise<RepoPolicy> {
  if (opts.reuse) return opts.reuse;
  const ref = (ctx.ref ?? ctx.defaultBranch ?? "").trim();
  if (!ref) {
    return deploymentOnlyPolicy({ state: "missing" }, "missing", deployment);
  }
  const api = ctx.api;
  if (!api || typeof api.getRepoFile !== "function") {
    return deploymentOnlyPolicy({ state: "missing" }, "missing", deployment);
  }
  let load: RepoSettingsLoad;
  try {
    load = await loadRepoSettings(api, ctx.owner, ctx.repo, ref);
  } catch (err) {
    if (opts.onUnreadable === "throw") throw err;
    return deploymentOnlyPolicy({ state: "missing" }, "unreadable", deployment, errorMessage(err));
  }
  if (load.state === "missing") {
    return deploymentOnlyPolicy(load, "missing", deployment);
  }
  if (load.state === "invalid") {
    return deploymentOnlyPolicy(load, "invalid", deployment, load.error);
  }
  return {
    load,
    status: "ok",
    ...deriveRepoPolicy(load, deployment),
  };
}
