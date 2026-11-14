import {
  CI_LOOKUP_BUDGET_MS,
  type CiGateResolverApi,
  type CiInspection,
  ciWaitForInspection,
  encodeCiAbsentWait,
  inspectCi,
  type RequiredCiResolver,
  resolveCiGate,
} from "./ci.ts";
import type { EnqueueResult } from "./queue.ts";
import type { ReviewApi } from "./review.ts";
import type { EnqueueReviewOpts } from "./review_jobs.ts";
import type { ReviewJob } from "./types.ts";

export interface ReviewGateQueue {
  enqueue(job: ReviewJob, opts?: EnqueueReviewOpts): EnqueueResult | Promise<EnqueueResult>;
}

export type CiGateApi = Pick<
  ReviewApi,
  "listCommitStatuses" | "listCheckRuns" | "listActionJobs" | "getActionJobLogs"
> &
  Partial<RequiredCiResolver> &
  Partial<Pick<CiGateResolverApi, "getRepoFile" | "getRepo">>;

function gatePrefix(wait: string): string {
  return wait === "required" ? "CI gate" : `CI gate (wait=${wait})`;
}

function wakePrefix(wait: string): string {
  return wait === "required" ? "CI wake" : `CI wake (wait=${wait})`;
}

function logGatePass(
  logger: ((message: string) => void) | undefined,
  job: ReviewJob,
  ci: CiInspection,
  wait: string
): void {
  if (wait !== "required") {
    if (wait === "none" && ci.pendingOptional.length > 0) {
      logger?.(
        `${gatePrefix(wait)}: dispatching with pending: ${ci.pendingOptional.join(", ")} for ${job.owner}/${job.repo}#${job.prNumber}@${job.headSha}`
      );
      return;
    }
    if (wait !== "required") {
      logger?.(`${gatePrefix(wait)}: dispatching for ${job.owner}/${job.repo}#${job.prNumber}@${job.headSha}`);
    }
    return;
  }
  if (ci.pendingOptional.length > 0) {
    logger?.(
      `CI gate: required checks done, ignoring pending optional: ${ci.pendingOptional.join(", ")} for ${job.owner}/${job.repo}#${job.prNumber}@${job.headSha}`
    );
  }
}

/**
 * Router-side CI gate: store a review whose CI is not yet ready as waiting
 * (not dispatchable) so control creates no Job until the CI-completion wake
 * promotes it. Uses the same `CiInspection` the review path uses. Heads with
 * no checks wait until the lookup budget expires, then become dispatchable.
 * Failures and successes stay dispatchable (existing failed handling applies).
 * Without a forge (`ciApi` unset), enqueues dispatchable.
 */
export async function enqueueReviewWithCiGate(
  queue: ReviewGateQueue,
  job: ReviewJob,
  opts: {
    ciApi?: CiGateApi;
    home: string;
    logger?: (message: string) => void;
    nowMs?: number;
    baseBranch?: string;
    defaultBranch?: string;
  }
): Promise<EnqueueResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const api = opts.ciApi;
  if (!api) return queue.enqueue(job);
  const gate = await resolveCiGate(api, {
    owner: job.owner,
    repo: job.repo,
    prNumber: job.prNumber,
    ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
    ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
    ...(opts.logger ? { log: opts.logger } : {}),
  });
  const waitMode = gate.wait;
  const requiredContexts = gate.requiredContexts;
  let ci: CiInspection;
  try {
    ci = await inspectCi({
      api,
      owner: job.owner,
      repo: job.repo,
      sha: job.headSha,
      home: opts.home,
      issueNumber: job.prNumber,
      log: opts.logger,
      ...(requiredContexts ? { requiredContexts } : {}),
      ...(waitMode !== "required" ? { wait: waitMode } : {}),
    });
  } catch (err) {
    if (waitMode === "none") {
      opts.logger?.(
        `${gatePrefix(waitMode)}: dispatching after lookup failure for ${job.owner}/${job.repo}#${job.prNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
      return queue.enqueue(job);
    }
    opts.logger?.(
      `${gatePrefix(waitMode)} lookup failed for ${job.owner}/${job.repo}#${job.prNumber}, waiting on budget: ${err instanceof Error ? err.message : String(err)}`
    );
    return queue.enqueue(job, {
      waitUntilMs: nowMs + CI_LOOKUP_BUDGET_MS,
      waitMarker: encodeCiAbsentWait(nowMs),
      nowMs,
    });
  }
  const wait = ciWaitForInspection(ci, nowMs, waitMode);
  if (!wait) {
    logGatePass(opts.logger, job, ci, waitMode);
    return queue.enqueue(job);
  }
  opts.logger?.(
    `${gatePrefix(waitMode)} waiting for ${job.owner}/${job.repo}#${job.prNumber}@${job.headSha} pending=${ci.pending} empty=${ci.empty} lookupFailed=${Boolean(ci.lookupFailed)} until=${new Date(wait.untilMs).toISOString()}`
  );
  return queue.enqueue(job, { waitUntilMs: wait.untilMs, waitMarker: wait.marker, nowMs });
}

/**
 * CI-completion wake gate for an already-queued head. Inspects the head's CI
 * and only enqueues (which promotes a waiting row) when the head is ready.
 * While CI is still pending, or while a no-checks head is still inside its
 * lookup budget, the wake is a no-op so no Job is created. Without a forge,
 * falls back to a plain enqueue (existing behavior).
 */
export async function enqueueCiWakeWithGate(
  queue: ReviewGateQueue,
  job: ReviewJob,
  opts: {
    ciApi?: CiGateApi;
    home: string;
    logger?: (message: string) => void;
    nowMs?: number;
    baseBranch?: string;
    defaultBranch?: string;
  }
): Promise<EnqueueResult | { key: string; queued: false; waiting: true }> {
  const api = opts.ciApi;
  if (!api) return queue.enqueue(job);
  const key = `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`;
  const gate = await resolveCiGate(api, {
    owner: job.owner,
    repo: job.repo,
    prNumber: job.prNumber,
    ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
    ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
    ...(opts.logger ? { log: opts.logger } : {}),
  });
  const waitMode = gate.wait;
  const requiredContexts = gate.requiredContexts;
  let ci: CiInspection;
  try {
    ci = await inspectCi({
      api,
      owner: job.owner,
      repo: job.repo,
      sha: job.headSha,
      home: opts.home,
      issueNumber: job.prNumber,
      log: opts.logger,
      ...(requiredContexts ? { requiredContexts } : {}),
      ...(waitMode !== "required" ? { wait: waitMode } : {}),
    });
  } catch (err) {
    if (waitMode === "none") {
      opts.logger?.(
        `${wakePrefix(waitMode)} dispatching after lookup failure for ${job.owner}/${job.repo}#${job.prNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
      return queue.enqueue(job);
    }
    opts.logger?.(
      `${wakePrefix(waitMode)} lookup failed for ${job.owner}/${job.repo}#${job.prNumber}, keeping budget wait: ${err instanceof Error ? err.message : String(err)}`
    );
    const nowMs = opts.nowMs ?? Date.now();
    await queue.enqueue(job, {
      waitUntilMs: nowMs + CI_LOOKUP_BUDGET_MS,
      waitMarker: encodeCiAbsentWait(nowMs),
      nowMs,
    });
    return { key, queued: false, waiting: true };
  }
  if (ci.pending) {
    opts.logger?.(
      `${wakePrefix(waitMode)} still pending for ${job.owner}/${job.repo}#${job.prNumber}@${job.headSha}, keeping wait`
    );
    return { key, queued: false, waiting: true };
  }
  if ((ci.empty || ci.lookupFailed) && ci.failed.length === 0) {
    if (waitMode === "none") {
      logGatePass(opts.logger, job, ci, waitMode);
      return queue.enqueue(job);
    }
    const nowMs = opts.nowMs ?? Date.now();
    opts.logger?.(
      `${wakePrefix(waitMode)} lookup incomplete for ${job.owner}/${job.repo}#${job.prNumber}@${job.headSha} empty=${ci.empty} lookupFailed=${Boolean(ci.lookupFailed)}, keeping budget wait`
    );
    await queue.enqueue(job, {
      waitUntilMs: nowMs + CI_LOOKUP_BUDGET_MS,
      waitMarker: encodeCiAbsentWait(nowMs),
      nowMs,
    });
    return { key, queued: false, waiting: true };
  }
  logGatePass(opts.logger, job, ci, waitMode);
  return queue.enqueue(job);
}
