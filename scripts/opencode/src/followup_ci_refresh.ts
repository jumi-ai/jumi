import { readCiLatch } from "./ci.ts";
import { recordCiRefreshes, splitCiRefreshBudget } from "./ci_refresh.ts";
import type { FollowUpResult } from "./followup.ts";
import type { Pull } from "./ports.ts";
import type { SkipLatchKey, SkipLatchStore } from "./skip_latches.ts";
import { errorMessage } from "./util/error.ts";

type RunMergeOnly = (ctx: Record<string, unknown>, claimed: Record<string, unknown>) => Promise<FollowUpResult>;

export const CLEAN_BASE_MERGE_ONLY_REASON = "worker result was a clean base merge only; not pushed";

export function isCleanBaseMergeOnlyResult(
  mergeResult: { status: string; conflicted: boolean; openCodeRan: boolean },
  porcelain: string,
  aheadOfOrigin: number,
  postMergeSha?: string,
  finalSha?: string
): boolean {
  // A committed worker fix leaves a clean worktree too. Only a HEAD that is
  // still the post-merge SHA proves the worker added no commits.
  if (!postMergeSha || !finalSha || postMergeSha !== finalSha) return false;
  return (
    !porcelain &&
    aheadOfOrigin > 0 &&
    mergeResult.status === "merged" &&
    !mergeResult.conflicted &&
    !mergeResult.openCodeRan
  );
}

/**
 * Mechanical refresh first for red CI: on a CI-only wake, run the existing
 * merge-only path instead of a worker run. Budgeted once per (base SHA,
 * failing check); a second red on the refreshed head with the same base runs
 * the normal CI follow-up. Returns a result when the refresh handled the
 * wake, or undefined to continue to the worker.
 */
export async function maybeRunCiRefreshBeforeWorker(deps: {
  opts: Record<string, unknown>;
  pr: Pull;
  ci: { unhandled: Array<{ name: string }> };
  ciWake: boolean;
  snapshotMergeable: boolean | null | undefined;
  leftToAuthor: boolean;
  latches: SkipLatchStore;
  latchKey: SkipLatchKey;
  owner: string;
  repo: string;
  issueNumber: number;
  home: string;
  log: (message: string) => void;
  now: () => Date;
  forgetClaim: () => Promise<void>;
  effectiveTrustedUpFront: readonly string[] | undefined;
  claimed: Record<string, unknown>;
  sticky: (text: string, prNumber: number) => Promise<void>;
  preRunIsRun: boolean;
  preRunHasFeedback: boolean;
  isMergeOnlyJob: boolean;
  isStrictRefreshJob: boolean;
  runMergeOnly: RunMergeOnly;
}): Promise<FollowUpResult | undefined> {
  if (!deps.preRunIsRun || deps.preRunHasFeedback || !deps.ciWake) return undefined;
  if (deps.isMergeOnlyJob || deps.isStrictRefreshJob) return undefined;
  const refreshBaseSha = (deps.pr.base.sha ?? "").trim();
  const refreshChecks = deps.ci.unhandled;
  if (!refreshBaseSha || refreshChecks.length === 0) return undefined;
  if (deps.leftToAuthor || deps.snapshotMergeable === false) return undefined;
  try {
    const ciLatchState = await readCiLatch(deps.latches, deps.latchKey);
    const { toRefresh } = splitCiRefreshBudget(ciLatchState, refreshBaseSha, refreshChecks);
    if (toRefresh.length === 0) return undefined;
    const mergeOnlyResult = await deps.runMergeOnly(
      {
        ...deps.opts,
        pr: deps.pr,
        latches: deps.latches,
        latchKey: deps.latchKey,
        log: deps.log,
        now: deps.now,
        forgetClaim: deps.forgetClaim,
        effectiveTrustedUpFront: deps.effectiveTrustedUpFront,
      },
      deps.claimed
    );
    if (mergeOnlyResult.status === "pushed") {
      await recordCiRefreshes({
        home: deps.home,
        owner: deps.owner,
        repo: deps.repo,
        issueNumber: deps.issueNumber,
        prNumber: deps.pr.number,
        baseSha: refreshBaseSha,
        checkNames: toRefresh.map((check) => check.name),
        now: deps.now,
        skipLatches: deps.latches,
      });
      const refreshReason = `ci refresh: merged ${deps.pr.base.ref}@${refreshBaseSha.slice(0, 12)} without a worker run`;
      deps.log(refreshReason);
      await deps.sticky(refreshReason, deps.pr.number);
      return mergeOnlyResult;
    }
    if (mergeOnlyResult.status !== "no-changes") return mergeOnlyResult;
    deps.log(
      `ci refresh: head already contains ${deps.pr.base.ref}@${refreshBaseSha.slice(0, 12)}; running normal CI follow-up`
    );
    return undefined;
  } catch (err) {
    deps.log(`ci refresh failed, running normal CI follow-up: ${errorMessage(err)}`);
    return undefined;
  }
}
