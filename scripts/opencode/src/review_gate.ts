import { CI_LOOKUP_BUDGET_MS, type CiInspection, ciWaitForInspection, encodeCiAbsentWait, inspectCi } from "./ci.ts";
import type { EnqueueResult } from "./queue.ts";
import type { ReviewApi } from "./review.ts";
import type { EnqueueReviewOpts } from "./review_jobs.ts";
import type { ReviewJob } from "./types.ts";

export interface ReviewGateQueue {
  enqueue(job: ReviewJob, opts?: EnqueueReviewOpts): EnqueueResult | Promise<EnqueueResult>;
}

export type CiGateApi = Pick<ReviewApi, "listCommitStatuses" | "listCheckRuns" | "listActionJobs" | "getActionJobLogs">;

/**
 * Router-side CI gate: store a review whose head CI is pending as waiting
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
  }
): Promise<EnqueueResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const api = opts.ciApi;
  if (!api) return queue.enqueue(job);
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
    });
  } catch (err) {
    opts.logger?.(
      `CI gate lookup failed for ${job.owner}/${job.repo}#${job.prNumber}, waiting on budget: ${err instanceof Error ? err.message : String(err)}`
    );
    return queue.enqueue(job, {
      waitUntilMs: nowMs + CI_LOOKUP_BUDGET_MS,
      waitMarker: encodeCiAbsentWait(nowMs),
      nowMs,
    });
  }
  const wait = ciWaitForInspection(ci, nowMs);
  if (!wait) return queue.enqueue(job);
  opts.logger?.(
    `CI gate waiting for ${job.owner}/${job.repo}#${job.prNumber}@${job.headSha} pending=${ci.pending} empty=${ci.empty} lookupFailed=${Boolean(ci.lookupFailed)} until=${new Date(wait.untilMs).toISOString()}`
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
  }
): Promise<EnqueueResult | { key: string; queued: false; waiting: true }> {
  const api = opts.ciApi;
  if (!api) return queue.enqueue(job);
  const key = `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`;
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
    });
  } catch (err) {
    opts.logger?.(
      `CI wake lookup failed for ${job.owner}/${job.repo}#${job.prNumber}, keeping budget wait: ${err instanceof Error ? err.message : String(err)}`
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
    opts.logger?.(`CI wake still pending for ${job.owner}/${job.repo}#${job.prNumber}@${job.headSha}, keeping wait`);
    return { key, queued: false, waiting: true };
  }
  if ((ci.empty || ci.lookupFailed) && ci.failed.length === 0) {
    const nowMs = opts.nowMs ?? Date.now();
    opts.logger?.(
      `CI wake lookup incomplete for ${job.owner}/${job.repo}#${job.prNumber}@${job.headSha} empty=${ci.empty} lookupFailed=${Boolean(ci.lookupFailed)}, keeping budget wait`
    );
    await queue.enqueue(job, {
      waitUntilMs: nowMs + CI_LOOKUP_BUDGET_MS,
      waitMarker: encodeCiAbsentWait(nowMs),
      nowMs,
    });
    return { key, queued: false, waiting: true };
  }
  return queue.enqueue(job);
}
