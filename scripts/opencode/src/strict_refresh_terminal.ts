import { type StrictRefreshPolicy, shouldEnqueueStrictRefreshOnPush } from "./strict_refresh.ts";
import { nextStrictRetry, strictNeedsKickMessage } from "./strict_refresh_obligation.ts";
import {
  STRICT_REFRESH_SLOT_TIMEOUT_MS,
  type StrictRefreshPendingJob,
  type StrictRefreshSlotStore,
} from "./strict_refresh_queue.ts";
import type { IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";

/**
 * Terminal reasons recorded for a strict-refresh slot: `timeout` and
 * `blocked` come from the event-driven reconcile; `job-ended` records a
 * merge-only job for the holder that ended without refreshing.
 */
export const STRICT_REFRESH_JOB_ENDED_TERMINAL_REASON = "job-ended";

const RETRYABLE_BUSY_PREFIX = "strict refresh: branch writer busy";

/**
 * Forge/API/network failures are retryable with backoff and a bounded
 * budget; only real ineligibility records terminal evidence. Retryable:
 * branch-writer-busy (writer still runs), pull-request unreadable (e.g. a
 * 503 during the strict re-check), strictness unknown (transient getBranch
 * failure), and generic 5xx/timeout/network text. Terminal: conflict,
 * failing checks, strictness off, competing head, left-to-author,
 * not eligible, not behind, auto-merge off.
 */
export function isStrictRefreshRetryableSkipReason(reason: string | undefined): boolean {
  if (typeof reason !== "string") return false;
  const lower = reason.toLowerCase();
  if (lower.startsWith(RETRYABLE_BUSY_PREFIX)) return true;
  if (lower.includes("pull request unreadable")) return true;
  if (lower.includes("strictness unknown")) return true;
  if (lower.includes("strict refresh: strictness off or unknown")) return false;
  return (
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("500") ||
    lower.includes("504") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("econn") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("socket") ||
    lower.includes("rate limit") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout") ||
    lower.includes("internal server error")
  );
}

/**
 * Whether a terminal worker outcome for a strict-refresh merge-only job must
 * free the slot. Skipped (any reason except a retryable forge failure) and
 * failed without retries left release; success (`pushed`), up-to-date
 * (`no-changes`) and anything still retryable keep the slot. Retryable skips
 * are drained by the tick with backoff, never released here.
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
 * holder's (PR, head, generation): a late result for an older admission
 * never frees a newer holder. Records the job's (head, base) pair as
 * terminal (`job-ended`) so the released holder is not re-admitted on
 * unchanged evidence. Returns true when a slot was released.
 */
export async function releaseStrictSlotForTerminalJob(opts: {
  slots: StrictRefreshSlotStore;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha?: string;
  reason: string;
  expectedGeneration?: number;
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
    if (opts.expectedGeneration !== undefined && (slot.generation ?? 0) !== opts.expectedGeneration) continue;
    const ok = await opts.slots.releaseIfHolder(slot.owner, slot.repo, slot.baseBranch, slot.prNumber, slot.headSha, {
      terminal: {
        prNumber: slot.prNumber,
        headSha: slot.headSha,
        baseSha: opts.baseSha ?? slot.baseSha,
        reason: STRICT_REFRESH_JOB_ENDED_TERMINAL_REASON,
      },
      nowMs: now,
      ...(opts.expectedGeneration !== undefined ? { expectedGeneration: opts.expectedGeneration } : {}),
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
  job: StrictWorkerJobLike & {
    issueNumber?: number;
    title?: string;
    body?: string;
    htmlUrl?: string;
    issueUpdatedAt?: string;
    defaultBranch?: string;
    cloneUrl?: string;
    baseBranch?: string;
  };
  status: string;
  reason?: string;
  log?: (message: string) => void;
  nowMs?: number;
}): Promise<boolean> {
  if (!opts.slots) return false;
  if (typeof opts.job.prNumber !== "number") return false;
  if (!opts.job.strictRefresh || !opts.job.mergeOnly) return false;
  const now = opts.nowMs ?? Date.now();
  const reason = opts.reason ?? opts.status;
  try {
    // Retryable forge failures never blacklist: backoff with a bounded
    // budget, then surface a needs_kick board row. Fenced by generation.
    if (opts.status === "skipped" && isStrictRefreshRetryableSkipReason(opts.reason)) {
      const held = await opts.slots.listHeldSlots();
      const slot = held.find(
        (s) =>
          s.owner === opts.job.owner &&
          s.repo === opts.job.repo &&
          s.prNumber === opts.job.prNumber &&
          (s.headSha ?? "").toLowerCase() === (opts.job.headSha ?? "").toLowerCase()
      );
      if (!slot) return false;
      const generation = slot.generation ?? 1;
      const next = nextStrictRetry(slot.retryMarker, now);
      if (!next) {
        await opts.slots.markNeedsKick(slot.owner, slot.repo, slot.baseBranch, generation, reason, now);
        opts.log?.(
          `strict refresh slot ${slot.owner}/${slot.repo}#${slot.baseBranch} needs attention (holder #${slot.prNumber}): ${reason}`
        );
        return false;
      }
      const pending: StrictRefreshPendingJob | undefined =
        slot.pendingJob ??
        (opts.job.cloneUrl && opts.job.defaultBranch
          ? {
              owner: opts.job.owner,
              repo: opts.job.repo,
              issueNumber: opts.job.issueNumber ?? opts.job.prNumber ?? 0,
              prNumber: opts.job.prNumber,
              headSha: opts.job.headSha ?? slot.headSha,
              baseSha: opts.job.strictBaseSha ?? slot.baseSha,
              title: opts.job.title ?? "",
              body: opts.job.body ?? "",
              htmlUrl: opts.job.htmlUrl ?? "",
              issueUpdatedAt: opts.job.issueUpdatedAt ?? new Date(now).toISOString(),
              defaultBranch: opts.job.defaultBranch,
              cloneUrl: opts.job.cloneUrl,
            }
          : undefined);
      await opts.slots.setRetry(
        slot.owner,
        slot.repo,
        slot.baseBranch,
        generation,
        next.marker,
        next.dueAtMs,
        reason,
        now,
        pending ?? null
      );
      opts.log?.(
        `strict refresh slot ${slot.owner}/${slot.repo}#${slot.baseBranch} retry ${next.count} for #${slot.prNumber} due in ${next.dueAtMs - now}ms: ${reason}`
      );
      return false;
    }
    if (!shouldReleaseStrictSlotForTerminalOutcome(opts.job, opts.status, opts.reason)) return false;
    return await releaseStrictSlotForTerminalJob({
      slots: opts.slots,
      owner: opts.job.owner,
      repo: opts.job.repo,
      prNumber: opts.job.prNumber,
      headSha: opts.job.headSha ?? "",
      ...(opts.job.strictBaseSha ? { baseSha: opts.job.strictBaseSha } : {}),
      reason,
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

/**
 * Settle a cancelled strict-refresh merge-only job.
 *
 * A merge-only row ends `cancelled` in two cases: it was replaced by a newer
 * job for the same PR (the refresh obligation moves to the replacing job,
 * which must still do the merge-main intent), or it was genuinely stopped
 * (unlabel, close, cancel by operator). The caller tells the two apart with
 * `hasSuccessor`: a successor keeps the slot (transferring the obligation to
 * the successor's head/base), while a genuine stop releases into an
 * admit-next obligation drained by the tick.
 */
export async function settleStrictSlotForCancelledJob(opts: {
  slots: StrictRefreshSlotStore | undefined;
  owner: string;
  repo: string;
  baseBranch: string;
  prNumber: number;
  headSha: string;
  hasSuccessor: boolean;
  successor?: { headSha: string; baseSha: string; pendingJob?: StrictRefreshPendingJob | null };
  log?: (message: string) => void;
  nowMs?: number;
}): Promise<"kept" | "transferred" | "admit-next" | "ignored"> {
  if (!opts.slots) return "ignored";
  const now = opts.nowMs ?? Date.now();
  try {
    const slot = await opts.slots.getSlot(opts.owner, opts.repo, opts.baseBranch);
    if (!slot || slot.prNumber !== opts.prNumber) return "ignored";
    if ((slot.headSha ?? "").toLowerCase() !== (opts.headSha ?? "").toLowerCase()) return "ignored";
    const generation = slot.generation ?? 1;
    if (opts.hasSuccessor && opts.successor) {
      const { transferStrictObligationToReplacement } = await import("./strict_refresh_obligation.ts");
      const ok = await transferStrictObligationToReplacement(opts.slots, {
        owner: opts.owner,
        repo: opts.repo,
        baseBranch: opts.baseBranch,
        prNumber: opts.prNumber,
        headSha: opts.successor.headSha,
        baseSha: opts.successor.baseSha,
        ...(opts.successor.pendingJob ? { pendingJob: opts.successor.pendingJob } : {}),
        nowMs: now,
        ...(opts.log ? { log: opts.log } : {}),
      });
      void generation;
      return ok ? "transferred" : "kept";
    }
    await opts.slots.releaseToAdmitNext(opts.owner, opts.repo, opts.baseBranch, generation, now);
    opts.log?.(
      `strict refresh slot ${opts.owner}/${opts.repo}#${opts.baseBranch} stopped for #${opts.prNumber}; admit-next due`
    );
    return "admit-next";
  } catch (err) {
    opts.log?.(`strict refresh cancel settle failed: ${errorMessage(err)}`);
    return "ignored";
  }
}

/** Board rows for retry-exhausted strict slots. The message names branch, holder and last error. */
export async function listStrictNeedsKickBoardRows(
  slots: StrictRefreshSlotStore | undefined
): Promise<
  Array<{ owner: string; repo: string; number: number; message: string; baseBranch: string; lastError: string | null }>
> {
  if (!slots || typeof slots.listNeedsKick !== "function") return [];
  try {
    const rows = await slots.listNeedsKick();
    return rows.map((slot) => ({
      owner: slot.owner,
      repo: slot.repo,
      number: slot.prNumber,
      baseBranch: slot.baseBranch,
      lastError: slot.lastError ?? null,
      message: strictNeedsKickMessage({
        owner: slot.owner,
        repo: slot.repo,
        baseBranch: slot.baseBranch,
        prNumber: slot.prNumber,
        lastError: slot.lastError ?? null,
      }),
    }));
  } catch {
    return [];
  }
}

export type StrictRefreshTickApi = Parameters<typeof shouldEnqueueStrictRefreshOnPush>[2] & {
  getRepo(
    owner: string,
    repo: string
  ): Promise<{ full_name: string; html_url: string; clone_url: string; default_branch: string }>;
};

/** Read the live branch tip instead of trusting the stored base SHA. Best-effort: null when unreadable. */
async function readFreshBranchTip(
  api: StrictRefreshTickApi,
  owner: string,
  repo: string,
  branch: string,
  log?: (message: string) => void
): Promise<string | null> {
  const getBranch = (
    api as { getBranch?: (o: string, r: string, b: string) => Promise<{ sha?: string; commit?: { sha?: string } }> }
  ).getBranch;
  if (typeof getBranch !== "function") return null;
  try {
    const fetched = await getBranch.call(api, owner, repo, branch);
    const sha = (fetched as { sha?: string })?.sha ?? (fetched as { commit?: { sha?: string } })?.commit?.sha ?? "";
    return typeof sha === "string" && sha.trim() ? sha.trim() : null;
  } catch (err) {
    log?.(`strict refresh branch tip unreadable for ${owner}/${repo}@${branch}: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Engine-tick drain for strict-refresh obligations (issues #875, #894).
 * Ledger state only unless an obligation is due: pending intents drain with
 * no forge reads; due retries re-queue the stored intent; admit-next drains
 * with one open-PR list for that branch; expiry re-reads the branch tip
 * instead of trusting the stored base SHA. A tick with nothing due makes no
 * forge calls.
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
  let enqueued = 0;
  const enqueueStored = async (slot: (typeof held)[number], deliveryPrefix: string): Promise<void> => {
    const p = slot.pendingJob;
    if (!p) return;
    const job: IssueJob = {
      owner: p.owner,
      repo: p.repo,
      issueNumber: p.issueNumber,
      action: "push",
      title: p.title,
      body: p.body,
      htmlUrl: p.htmlUrl,
      issueUpdatedAt: p.issueUpdatedAt,
      defaultBranch: p.defaultBranch,
      cloneUrl: p.cloneUrl,
      mode: "follow-up",
      prNumber: p.prNumber,
      headSha: p.headSha,
      trigger: { event: "push", sender: deliveryPrefix },
      mergeOnly: true,
      strictRefresh: true,
      strictBaseSha: p.baseSha,
      delivery: `strict-refresh-${deliveryPrefix}-${p.owner}-${p.repo}-${slot.baseBranch}-${p.prNumber}-${now}`,
      receivedAt: new Date(now).toISOString(),
    };
    const res = (await opts.enqueueIssue(job)) as { queued?: boolean } | undefined;
    await opts.slots
      .clearPending(slot.owner, slot.repo, slot.baseBranch, slot.prNumber, slot.headSha)
      .catch(() => undefined);
    if ((res as { queued?: boolean } | undefined)?.queued !== false) enqueued += 1;
    opts.log?.(
      `queued ${job.owner}/${job.repo}#${job.prNumber} delivery=${job.delivery} strict-refresh-${deliveryPrefix}`
    );
  };
  for (const slot of held) {
    if (slot.phase === "needs-kick") continue;
    const retryDue = slot.phase === "retry" && slot.dueAtMs != null && slot.dueAtMs <= now && slot.pendingJob;
    const pendingFresh =
      now - slot.admittedAtMs <= STRICT_REFRESH_SLOT_TIMEOUT_MS && slot.pendingJob && slot.phase !== "retry";
    if (retryDue || pendingFresh) {
      try {
        await enqueueStored(slot, retryDue ? "retry" : "pending");
      } catch (err) {
        opts.log?.(`strict refresh pending drain failed: ${errorMessage(err)}`);
      }
    }
  }
  // Admit-next obligations: a released slot with possible ready waiters.
  // One open-PR list per due branch, bounded by the stored obligation.
  try {
    const dueAdmit = typeof opts.slots.listAdmitNextDue === "function" ? await opts.slots.listAdmitNextDue(now) : [];
    for (const target of dueAdmit) {
      try {
        let repo: { full_name: string; html_url: string; clone_url: string; default_branch: string };
        try {
          repo = await opts.api.getRepo(target.owner, target.repo);
        } catch (err) {
          opts.log?.(`strict refresh tick repo lookup failed for ${target.owner}/${target.repo}: ${errorMessage(err)}`);
          continue;
        }
        const freshTip = await readFreshBranchTip(opts.api, target.owner, target.repo, target.baseBranch, opts.log);
        const { jobs } = await shouldEnqueueStrictRefreshOnPush(
          {
            ref: `refs/heads/${target.baseBranch}`,
            before: freshTip ?? "",
            after: freshTip ?? "",
            repository: {
              full_name: repo.full_name,
              default_branch: repo.default_branch,
              clone_url: repo.clone_url,
              html_url: repo.html_url,
            },
            pusher: { login: "strict-refresh-admit-next" },
            sender: { login: "strict-refresh-admit-next" },
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
            delivery: `strict-refresh-admit-next-${target.owner}-${target.repo}-${target.baseBranch}-${now}`,
            receivedAt: new Date(now).toISOString(),
          };
          try {
            await opts.enqueueIssue(job);
          } catch (err) {
            opts.log?.(`strict refresh tick enqueue failed: ${errorMessage(err)}`);
            continue;
          }
          await opts.slots
            .clearPending(job.owner, job.repo, target.baseBranch, job.prNumber ?? 0, job.headSha ?? "")
            .catch(() => undefined);
          enqueued += 1;
          opts.log?.(
            `queued ${job.owner}/${job.repo}#${job.prNumber} delivery=${job.delivery} strict-refresh-admit-next`
          );
        }
      } catch (err) {
        opts.log?.(`strict refresh admit-next failed: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    opts.log?.(`strict refresh admit-next drain failed: ${errorMessage(err)}`);
  }
  const expired = held.filter((slot) => now - slot.admittedAtMs > STRICT_REFRESH_SLOT_TIMEOUT_MS);
  for (const slot of expired) {
    try {
      let repo: { full_name: string; html_url: string; clone_url: string; default_branch: string };
      try {
        repo = await opts.api.getRepo(slot.owner, slot.repo);
      } catch (err) {
        opts.log?.(`strict refresh tick repo lookup failed for ${slot.owner}/${slot.repo}: ${errorMessage(err)}`);
        continue;
      }
      // Re-read the branch tip instead of trusting the stored base SHA, so a
      // lost main-push event does not carry into reconciliation.
      const freshTip = await readFreshBranchTip(opts.api, slot.owner, slot.repo, slot.baseBranch, opts.log);
      const tip = freshTip ?? slot.baseSha;
      const { jobs } = await shouldEnqueueStrictRefreshOnPush(
        {
          ref: `refs/heads/${slot.baseBranch}`,
          before: tip,
          after: tip,
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
        try {
          await opts.enqueueIssue(job);
        } catch (err) {
          opts.log?.(`strict refresh tick enqueue failed: ${errorMessage(err)}`);
          continue;
        }
        await opts.slots
          .clearPending(job.owner, job.repo, slot.baseBranch, job.prNumber ?? 0, job.headSha ?? "")
          .catch(() => undefined);
        enqueued += 1;
        opts.log?.(`queued ${job.owner}/${job.repo}#${job.prNumber} delivery=${job.delivery} strict-refresh-timeout`);
      }
    } catch (err) {
      opts.log?.(`strict refresh tick reconcile failed: ${errorMessage(err)}`);
    }
  }
  return { expired: expired.length, enqueued };
}
