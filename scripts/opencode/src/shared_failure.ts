/** Shared CI failure coordination (issue #628). */

import { sharedFailureReasonFor, sharedFailureStickyFor } from "./pr_decision.ts";

/** Window in which another PR's recorded fingerprint counts as shared. */
export const SHARED_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A first PR with no new push for this long can be taken over. */
export const SHARED_FAILURE_TAKEOVER_MS = 6 * 60 * 60 * 1000;

export interface SharedFailureLedgerEntry {
  prNumber: number;
  check: string;
  fingerprint: string;
  /** When set, this PR waits on `waiterFor` instead of owning the fix. */
  waiterFor?: number | null;
  updatedAt: number;
  headSha?: string;
}

export function sharedFailureLockKey(owner: string, repo: string, fingerprint: string): string {
  return `shared-failure:${owner}/${repo}#${fingerprint}`;
}

export function sharedFailureSticky(firstPr: number, check: string, defaultBranch: string): string {
  return sharedFailureStickyFor(firstPr, check, defaultBranch);
}

export function sharedFailureReason(firstPr: number, check: string): string {
  return sharedFailureReasonFor(firstPr, check);
}

export function isSharedFailureReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith("waiting on #");
}

function ultimateFirst(entry: SharedFailureLedgerEntry): number {
  return entry.waiterFor ?? entry.prNumber;
}

/**
 * Pick the live first PR for one fingerprint. `entries` are recent ledger
 * rows for the same repo+fingerprint+check (already window-filtered).
 * A first counts only when it is still open and (for takeover) recently
 * pushed; a merged first no longer counts as shared so the next wake runs
 * normally. Waiter rows resolve to their ultimate first.
 */
export function pickSharedFirst(
  entries: SharedFailureLedgerEntry[],
  opts: {
    excludePr: number;
    isOpen: (prNumber: number) => boolean;
    isLivePush: (prNumber: number) => boolean;
    isMerged?: (prNumber: number) => boolean;
  }
): { firstPr: number; check: string } | undefined {
  const sorted = [...entries].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const entry of sorted) {
    if (entry.prNumber === opts.excludePr) continue;
    const first = ultimateFirst(entry);
    if (first === opts.excludePr) continue;
    if (opts.isMerged?.(first)) continue;
    if (!opts.isOpen(first)) continue;
    if (!opts.isLivePush(first)) continue;
    // The entry must be within the caller-provided window; callers filter,
    // but a waiter that points at a live first is enough to share.
    return { firstPr: first, check: entry.check };
  }
  return undefined;
}

/** Oldest waiter becomes first when the first closes or goes stale. */
export function pickTakeoverWaiter(
  waiters: Array<{ prNumber: number; updatedAt: number }>
): { prNumber: number } | undefined {
  if (waiters.length === 0) return undefined;
  const sorted = [...waiters].sort((a, b) => a.updatedAt - b.updatedAt || a.prNumber - b.prNumber);
  const first = sorted[0];
  return first ? { prNumber: first.prNumber } : undefined;
}

/** Waiters that point at `firstPr` and are still open. */
export function waitersForFirst(
  entries: SharedFailureLedgerEntry[],
  firstPr: number,
  isOpen: (prNumber: number) => boolean
): number[] {
  const out = new Set<number>();
  for (const entry of entries) {
    if (entry.waiterFor !== firstPr) continue;
    if (!isOpen(entry.prNumber)) continue;
    out.add(entry.prNumber);
  }
  return [...out].sort((a, b) => a - b);
}

export interface SharedWaiterMergeTarget {
  prNumber: number;
  headSha: string;
  title: string;
  body: string;
  htmlUrl: string;
  issueUpdatedAt: string;
}

/**
 * Merge-only follow-ups for waiters whose first just merged. Each job only
 * brings the branch up to date with the default branch, pushes, and stops;
 * it never calls the feedback engine unless the merge conflicts.
 */
export function buildWaiterMergeJobs(opts: {
  owner: string;
  repo: string;
  defaultBranch: string;
  cloneUrl: string;
  waiters: SharedWaiterMergeTarget[];
  sender: string;
}): Array<Omit<import("./types.ts").IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; mode: "follow-up" }> {
  return opts.waiters.map((waiter) => ({
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: waiter.prNumber,
    action: "push",
    title: waiter.title,
    body: waiter.body,
    htmlUrl: waiter.htmlUrl,
    issueUpdatedAt: waiter.issueUpdatedAt,
    defaultBranch: opts.defaultBranch,
    cloneUrl: opts.cloneUrl,
    mode: "follow-up" as const,
    prNumber: waiter.prNumber,
    headSha: waiter.headSha,
    trigger: { event: "push", sender: opts.sender },
    mergeOnly: true as const,
  }));
}
