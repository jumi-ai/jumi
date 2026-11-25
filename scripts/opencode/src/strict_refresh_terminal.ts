import { type StrictRefreshPolicy, shouldEnqueueStrictRefreshOnPush } from "./strict_refresh.ts";
import { STRICT_REFRESH_SLOT_TIMEOUT_MS, type StrictRefreshSlotStore } from "./strict_refresh_queue.ts";
import type { IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";

/**
 * Terminal reasons recorded for a strict-refresh slot: `timeout` and
 * `blocked` come from the event-driven reconcile; `job-ended` records a
 * merge-only job for the holder that ended without refreshing.
 */
export const STRICT_REFRESH_JOB_ENDED_TERMINAL_REASON = "job-ended";

const RETRYABLE_BUSY_PREFIX = "strict refresh: branch writer busy";

/** Only the branch-writer-busy skip is retryable: the writer still runs, so the slot stays. */
export function isStrictRefreshRetryableSkipReason(reason: string | undefined): boolean {
  if (typeof reason !== "string") return false;
  return reason.toLowerCase().startsWith(RETRYABLE_BUSY_PREFIX);
}

/**
 * Whether a terminal worker outcome for a strict-refresh merge-only job must
 * free the slot. Skipped (any reason except the retryable branch-writer-busy)
 * and failed without retries left release; success (`pushed`), up-to-date
 * (`no-changes`) and anything still retryable keep the slot.
 */
export function shouldReleaseStrictSlotForTerminalOutcome(
  job: { strictRefresh?: boolean; mergeOnly?: boolean; prNumber?: number },
  status: string,
  reason?: string
): boolean {
  if (!job.strictRefresh || !job.mergeOnly) return false;
  if (typeof job.prNumber !== "number") return false;
  if (status === "failed") return true;
  if (status !== "skipped") return false;
  return !isStrictRefreshRetryableSkipReason(reason);
}

/**
 * Release the slot held for a terminal strict-refresh job, fenced on the
 * holder's (PR, head): a late result for an older admission never frees a
 * newer holder. Records the job's (head, base) pair as terminal
 * (`job-ended`) so the released holder is not re-admitted on unchanged
 * evidence. Returns true when a slot was released.
 */
export async function releaseStrictSlotForTerminalJob(opts: {
  slots: StrictRefreshSlotStore;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha?: string;
  reason: string;
  log?: (message: string) => void;
  nowMs?: number;
}): Promise<boolean> {
  const wantHead = (opts.headSha ?? "").toLowerCase();
  if (!wantHead) return false;
  const now = opts.nowMs ?? Date.now();
  const held = await opts.slots.listHeldSlots();
  let released = false;
  for (const slot of held) {
    if (slot.owner !== opts.owner || slot.repo !== opts.repo || slot.prNumber !== opts.prNumber) continue;
    if ((slot.headSha ?? "").toLowerCase() !== wantHead) continue;
    const ok = await opts.slots.releaseIfHolder(slot.owner, slot.repo, slot.baseBranch, slot.prNumber, slot.headSha, {
      terminal: {
        prNumber: slot.prNumber,
        headSha: slot.headSha,
        baseSha: opts.baseSha ?? slot.baseSha,
        reason: STRICT_REFRESH_JOB_ENDED_TERMINAL_REASON,
      },
      nowMs: now,
    });
    if (ok) {
      opts.log?.(
        `strict refresh slot ${slot.owner}/${slot.repo}#${slot.baseBranch} released (holder #${slot.prNumber} job ended: ${opts.reason})`
      );
      released = true;
    }
  }
  return released;
}

type StrictWorkerJobLike = {
  strictRefresh?: boolean;
  mergeOnly?: boolean;
  prNumber?: number;
  headSha?: string;
  strictBaseSha?: string;
  owner: string;
  repo: string;
};

/** Best-effort terminal release for a worker-settled strict-refresh job. Never throws. */
export async function settleStrictSlotForWorkerOutcome(opts: {
  slots: StrictRefreshSlotStore | undefined;
  job: StrictWorkerJobLike;
  status: string;
  reason?: string;
  log?: (message: string) => void;
  nowMs?: number;
}): Promise<boolean> {
  if (!opts.slots) return false;
  if (!shouldReleaseStrictSlotForTerminalOutcome(opts.job, opts.status, opts.reason)) return false;
  if (typeof opts.job.prNumber !== "number") return false;
  try {
    return await releaseStrictSlotForTerminalJob({
      slots: opts.slots,
      owner: opts.job.owner,
      repo: opts.job.repo,
      prNumber: opts.job.prNumber,
      headSha: opts.job.headSha ?? "",
      ...(opts.job.strictBaseSha ? { baseSha: opts.job.strictBaseSha } : {}),
      reason: opts.reason ?? opts.status,
      ...(opts.log ? { log: opts.log } : {}),
      ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    });
  } catch (err) {
    opts.log?.(`strict refresh slot release failed: ${errorMessage(err)}`);
    return false;
  }
}

/** Same as above for a ledger row (reclaim paths), where only the payload carries the job flags. */
export async function settleStrictSlotForWorkerRow(opts: {
  slots: StrictRefreshSlotStore | undefined;
  row: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    payload?: { strictRefresh?: boolean; mergeOnly?: boolean; strictBaseSha?: string } | null;
  };
  status: string;
  reason?: string;
  log?: (message: string) => void;
  nowMs?: number;
}): Promise<boolean> {
  return settleStrictSlotForWorkerOutcome({
    slots: opts.slots,
    job: {
      strictRefresh: opts.row.payload?.strictRefresh,
      mergeOnly: opts.row.payload?.mergeOnly,
      prNumber: opts.row.prNumber,
      headSha: opts.row.headSha,
      ...(opts.row.payload?.strictBaseSha ? { strictBaseSha: opts.row.payload.strictBaseSha } : {}),
      owner: opts.row.owner,
      repo: opts.row.repo,
    },
    status: opts.status,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
}

export type StrictRefreshTickApi = Parameters<typeof shouldEnqueueStrictRefreshOnPush>[2] & {
  getRepo(
    owner: string,
    repo: string
  ): Promise<{ full_name: string; html_url: string; clone_url: string; default_branch: string }>;
};

/**
 * Engine-tick expiry for strict-refresh slots (issue #875). Reads held slots
 * from the slot store (ledger state only, no forge), and for each slot older
 * than `STRICT_REFRESH_SLOT_TIMEOUT_MS` runs one admission for that target
 * branch through the same path pushes use. The forge is only called when a
 * slot has actually expired: one `listOpenPulls` per expired slot, plus the
 * repo/branch reads that path already performs. A tick with no expired slot
 * makes no forge calls.
 */
export async function expireStrictRefreshSlotsOnTick(opts: {
  slots: StrictRefreshSlotStore;
  api: StrictRefreshTickApi;
  policy: StrictRefreshPolicy;
  enqueueIssue: (job: IssueJob) => Promise<unknown>;
  log?: (message: string) => void;
  nowMs?: number;
}): Promise<{ expired: number; enqueued: number }> {
  const now = opts.nowMs ?? Date.now();
  const held = await opts.slots.listHeldSlots();
  const expired = held.filter((slot) => now - slot.admittedAtMs > STRICT_REFRESH_SLOT_TIMEOUT_MS);
  let enqueued = 0;
  for (const slot of expired) {
    try {
      let repo: { full_name: string; html_url: string; clone_url: string; default_branch: string };
      try {
        repo = await opts.api.getRepo(slot.owner, slot.repo);
      } catch (err) {
        opts.log?.(`strict refresh tick repo lookup failed for ${slot.owner}/${slot.repo}: ${errorMessage(err)}`);
        continue;
      }
      const { jobs } = await shouldEnqueueStrictRefreshOnPush(
        {
          ref: `refs/heads/${slot.baseBranch}`,
          before: slot.baseSha,
          after: slot.baseSha,
          repository: {
            full_name: repo.full_name,
            default_branch: repo.default_branch,
            clone_url: repo.clone_url,
            html_url: repo.html_url,
          },
          pusher: { login: "strict-refresh-timeout" },
          sender: { login: "strict-refresh-timeout" },
        } as never,
        opts.policy,
        opts.api,
        opts.log,
        opts.slots,
        now
      );
      for (const partial of jobs) {
        const job: IssueJob = {
          ...partial,
          delivery: `strict-refresh-timeout-${slot.owner}-${slot.repo}-${slot.baseBranch}-${slot.prNumber}-${now}`,
          receivedAt: new Date(now).toISOString(),
        };
        await opts.enqueueIssue(job);
        enqueued += 1;
        opts.log?.(`queued ${job.owner}/${job.repo}#${job.prNumber} delivery=${job.delivery} strict-refresh-timeout`);
      }
    } catch (err) {
      opts.log?.(`strict refresh tick reconcile failed: ${errorMessage(err)}`);
    }
  }
  return { expired: expired.length, enqueued };
}
