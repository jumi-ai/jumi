import type { StrictRefreshSlotStore } from "./strict_refresh_queue.ts";

/**
 * Durable strict-refresh obligation helpers (issue #894).
 *
 * Reuses the automerge-reconcile / push-confirm durable-obligation pattern:
 * one row per target branch, monotonic admission generation, lease-free
 * generation fencing, bounded retry with backoff, then a visible board row.
 * No general polling: forge reads happen only when an obligation Jumi itself
 * created is due.
 */

export const STRICT_REFRESH_RETRY_MAX_ATTEMPTS = 5;
export const STRICT_REFRESH_RETRY_BACKOFFS_MS = [30_000, 60_000, 120_000, 300_000] as const;
export const STRICT_REFRESH_RETRY_PREFIX = "strict-refresh-retry:";

export function parseStrictRetryMarker(
  marker: string | null | undefined
): { count: number; firstFailAt: number } | undefined {
  if (!marker?.startsWith(STRICT_REFRESH_RETRY_PREFIX)) return undefined;
  const parts = marker.slice(STRICT_REFRESH_RETRY_PREFIX.length).split(":");
  const count = Number(parts[0]);
  const firstFailAt = Number(parts[1]);
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(firstFailAt)) return undefined;
  return { count, firstFailAt };
}

export function encodeStrictRetryMarker(count: number, firstFailAt: number): string {
  return `${STRICT_REFRESH_RETRY_PREFIX}${count}:${firstFailAt}`;
}

export function strictRetryBackoffMs(count: number): number {
  const idx = Math.min(Math.max(count, 1), STRICT_REFRESH_RETRY_BACKOFFS_MS.length) - 1;
  return STRICT_REFRESH_RETRY_BACKOFFS_MS[idx] ?? 300_000;
}

/** Next retry state, or null when the bounded budget is exhausted. */
export function nextStrictRetry(
  retryMarker: string | null | undefined,
  nowMs: number
): { marker: string; dueAtMs: number; count: number } | null {
  const prev = parseStrictRetryMarker(retryMarker);
  const count = (prev?.count ?? 0) + 1;
  if (count > STRICT_REFRESH_RETRY_MAX_ATTEMPTS) return null;
  const firstFailAt = prev?.firstFailAt ?? nowMs;
  return { marker: encodeStrictRetryMarker(count, firstFailAt), dueAtMs: nowMs + strictRetryBackoffMs(count), count };
}

export function strictNeedsKickMessage(opts: {
  owner: string;
  repo: string;
  baseBranch: string;
  prNumber: number;
  lastError: string | null;
}): string {
  const where = `${opts.owner}/${opts.repo}#${opts.baseBranch}`;
  const holder = `#${opts.prNumber}`;
  const err = (opts.lastError ?? "refresh retries exhausted").trim().slice(0, 300);
  return `Strict refresh needs attention on ${where} (holder ${holder}): ${err}`;
}

/** Best-effort transfer of the refresh obligation to a replacing job. Never throws. */
export async function transferStrictObligationToReplacement(
  slots: StrictRefreshSlotStore | undefined,
  opts: {
    owner: string;
    repo: string;
    baseBranch: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    pendingJob?: import("./strict_refresh_queue.ts").StrictRefreshPendingJob | null;
    nowMs?: number;
    log?: (message: string) => void;
    /**
     * Caller-observed generation to fence on: the handoff only lands when
     * the stored generation still matches. Without it the transfer fences
     * on its own fresh read, so a newer admission landing between the
     * caller's read and this read is clobbered back.
     */
    expectedGeneration?: number;
  }
): Promise<boolean> {
  if (!slots) return false;
  try {
    const held = await slots.getSlot(opts.owner, opts.repo, opts.baseBranch);
    if (!held) return false;
    if (held.prNumber !== opts.prNumber) return false;
    const fenceGeneration = opts.expectedGeneration ?? held.generation;
    if (opts.expectedGeneration !== undefined && (held.generation ?? 0) !== opts.expectedGeneration) return false;
    const nextGeneration = (fenceGeneration ?? 0) + 1;
    const ok = await slots.handoff(opts.owner, opts.repo, opts.baseBranch, {
      expectedPrNumber: held.prNumber,
      expectedGeneration: fenceGeneration,
      next: {
        owner: opts.owner,
        repo: opts.repo,
        baseBranch: opts.baseBranch,
        prNumber: opts.prNumber,
        headSha: opts.headSha,
        baseSha: opts.baseSha,
        admittedAtMs: held.admittedAtMs,
        updatedAtMs: opts.nowMs ?? Date.now(),
        laps: held.laps ?? 0,
        generation: nextGeneration,
        phase: "held",
      },
      pendingJob: opts.pendingJob ?? held.pendingJob ?? null,
      nowMs: opts.nowMs,
    });
    if (ok)
      opts.log?.(
        `strict refresh slot ${opts.owner}/${opts.repo}#${opts.baseBranch} obligation moved to replacement job for #${opts.prNumber}`
      );
    return ok;
  } catch (err) {
    opts.log?.(`strict refresh obligation transfer failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Enqueue-time transfer: when a new job supersedes a queued strict-refresh
 * holder for the same PR, move the slot's obligation to the replacing job
 * (which must still do the merge-main intent). Finds the held slot by PR
 * across branches; no forge reads. Never throws.
 */
export async function transferStrictSlotOnEnqueue(
  slots: StrictRefreshSlotStore | undefined,
  job: {
    owner: string;
    repo: string;
    prNumber?: number;
    headSha?: string;
    strictBaseSha?: string;
    issueNumber: number;
    title: string;
    body: string;
    htmlUrl: string;
    issueUpdatedAt: string;
    defaultBranch: string;
    cloneUrl: string;
  },
  nowMs?: number
): Promise<void> {
  if (!slots || typeof job.prNumber !== "number") return;
  try {
    const held = await slots.listHeldSlots();
    const slot = held.find((s) => s.owner === job.owner && s.repo === job.repo && s.prNumber === job.prNumber);
    if (!slot) return;
    const headSha = job.headSha ?? slot.headSha;
    const baseSha = job.strictBaseSha ?? slot.baseSha;
    // Same-head re-queue (for example the tick retry drain re-enqueues the
    // stored intent): the slot already names this head, so a handoff would
    // clear the bounded retry budget (retryMarker/dueAt/lastError) and bump
    // the generation, letting retries loop forever without exhausting.
    // No-op to keep the budget intact.
    if (
      (slot.headSha ?? "").toLowerCase() === (headSha ?? "").toLowerCase() &&
      (slot.baseSha ?? "").toLowerCase() === (baseSha ?? "").toLowerCase()
    )
      return;
    await transferStrictObligationToReplacement(slots, {
      owner: slot.owner,
      repo: slot.repo,
      baseBranch: slot.baseBranch,
      prNumber: slot.prNumber,
      headSha,
      baseSha,
      pendingJob: {
        owner: job.owner,
        repo: job.repo,
        issueNumber: job.issueNumber,
        prNumber: slot.prNumber,
        headSha,
        baseSha,
        title: job.title,
        body: job.body,
        htmlUrl: job.htmlUrl,
        issueUpdatedAt: job.issueUpdatedAt,
        defaultBranch: job.defaultBranch,
        cloneUrl: job.cloneUrl,
      },
      ...(nowMs !== undefined ? { nowMs } : {}),
    });
  } catch {
    // Best-effort.
  }
}
