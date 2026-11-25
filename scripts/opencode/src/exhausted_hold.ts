import { isJumiReviewContext } from "./ci.ts";
import type { Check } from "./ports.ts";
import type { ReviewJobStore } from "./review_jobs.ts";
import type { SkipLatchStore } from "./skip_latches.ts";
import {
  type HoldStatusPort,
  postSuggestionHoldSuccessOrThrow,
  readSuggestionHold,
  suggestionHoldCompletedDescription,
  suggestionHoldSkippedDescription,
} from "./suggestion_hold.ts";

/** True when a `jumi/opencode-review` description is a suggestion-hold `pending`. */
export function isSuggestionHoldPendingDescription(description: string | undefined): boolean {
  return typeof description === "string" && /suggestions? waiting for follow-up/i.test(description);
}

/** True when a `jumi/opencode-review` description is a maintainer-hold `pending`. */
export function isMaintainerHoldPendingDescription(description: string | undefined): boolean {
  return typeof description === "string" && /waiting on maintainer/i.test(description);
}

/** Default disposition for an exhausted follow-up: mirror the standing worker. */
export const EXHAUSTED_FOLLOW_UP_HOLD_KIND = "skipped" as const;
export const EXHAUSTED_FOLLOW_UP_HOLD_REASON = "job failed";

export interface ExhaustedFollowUpHoldRow {
  id?: number;
  kind: string;
  owner: string;
  repo: string;
  issueNumber: number | null;
  headSha: string;
  prNumber?: number | null;
  leasedBy?: string | null;
}

export interface ExhaustedFollowUpHoldStore {
  skipLatches: SkipLatchStore;
  get(id: number): Promise<{ state: unknown; leasedBy: unknown } | undefined>;
}

export type ExhaustedFollowUpHoldApi = HoldStatusPort & {
  listCommitStatuses?: (owner: string, repo: string, sha: string) => Promise<Check[]>;
  getPR?: (owner: string, repo: string, index: number) => Promise<{ html_url?: string }>;
};

export type ExhaustedFollowUpHoldOutcome =
  | { resolved: true; sha: string; description: string }
  | {
      resolved: false;
      reason:
        | "not-follow-up"
        | "no-issue"
        | "no-hold"
        | "head-mismatch"
        | "stale-owner"
        | "maintainer-held"
        | "other-hold"
        | "already-resolved"
        | "post-failed";
    };

/**
 * Shared decision for a terminally exhausted follow-up: resolve a
 * suggestion-origin hold to `success`, never clearing a maintainer hold (or
 * any other hold type). The standing worker and the router reclaim path both
 * funnel through here instead of copying the branch.
 *
 * The write is ownership-safe: when `ownerToken` is present the row must
 * still be leased to that reclaim token, so a stale publisher cannot resolve
 * a hold for a later claim. It throws on forge failure (unlike the
 * best-effort wrapper below) so a reclaim pass can expire the lease and a
 * later pass can finish the write without duplicating the sticky comment.
 */
export async function resolveExhaustedFollowUpHoldOrThrow(opts: {
  api: ExhaustedFollowUpHoldApi;
  store: ExhaustedFollowUpHoldStore;
  row: ExhaustedFollowUpHoldRow;
  /** Reclaim token that must still own the row; omit where no fence applies. */
  ownerToken?: string | null;
  kind?: "completed" | "skipped";
  reason?: string;
}): Promise<ExhaustedFollowUpHoldOutcome> {
  const kind = opts.kind ?? EXHAUSTED_FOLLOW_UP_HOLD_KIND;
  const reason = opts.reason ?? EXHAUSTED_FOLLOW_UP_HOLD_REASON;
  const row = opts.row;
  if (row.kind !== "follow-up") return { resolved: false, reason: "not-follow-up" };
  if (row.issueNumber == null) return { resolved: false, reason: "no-issue" };
  const hold = await readSuggestionHold(opts.store.skipLatches, {
    owner: row.owner,
    repo: row.repo,
    issueNumber: row.issueNumber,
  });
  if (!hold.consumed) return { resolved: false, reason: "no-hold" };
  const count = hold.count ?? 0;
  if (!count) return { resolved: false, reason: "no-hold" };
  const sha = hold.headSha ?? row.headSha;
  if (!sha) return { resolved: false, reason: "no-hold" };
  if (hold.headSha && row.headSha && hold.headSha.toLowerCase() !== row.headSha.toLowerCase()) {
    return { resolved: false, reason: "head-mismatch" };
  }
  if (opts.ownerToken != null && row.id != null) {
    const current = await opts.store.get(row.id);
    if (current?.state !== "leased" || current.leasedBy !== opts.ownerToken) {
      return { resolved: false, reason: "stale-owner" };
    }
  }
  if (typeof opts.api.listCommitStatuses === "function") {
    const statuses = await opts.api.listCommitStatuses(row.owner, row.repo, sha);
    const ours = statuses.filter((status) => isJumiReviewContext(status.context));
    // No statuses for this context (fakes, pre-hold rows): fail open like the
    // legacy unconditional post. A recorded non-pending means someone already
    // resolved it, so there is nothing to clear.
    if (ours.length > 0) {
      const pending = ours.filter((status) => (status.state ?? status.status) === "pending");
      if (pending.length === 0) return { resolved: false, reason: "already-resolved" };
      if (pending.some((status) => isMaintainerHoldPendingDescription(status.description))) {
        return { resolved: false, reason: "maintainer-held" };
      }
      if (pending.some((status) => !isSuggestionHoldPendingDescription(status.description))) {
        return { resolved: false, reason: "other-hold" };
      }
    }
  }
  const description =
    kind === "completed" ? suggestionHoldCompletedDescription(count) : suggestionHoldSkippedDescription(count, reason);
  let targetUrl: string | undefined;
  try {
    // The worked issue number is not the pull number on Jumi PRs, so the
    // pull lookup must use the job's pull number, not the issue number.
    const pr = await opts.api.getPR?.(row.owner, row.repo, row.prNumber ?? row.issueNumber);
    if (pr?.html_url) targetUrl = pr.html_url;
  } catch {
    // Best-effort: the status post below still resolves the hold.
  }
  await postSuggestionHoldSuccessOrThrow(opts.api, row.owner, row.repo, sha, description, targetUrl);
  return { resolved: true, sha, description };
}

/**
 * Resolve a held suggestion `pending` when the follow-up cannot push from the
 * worker tick (mode gate, cancel, terminal failure). Follow-up's own returns
 * already resolve the common paths; this is the backstop for paths that never
 * reach it. One shared decision with the router reclaim path
 * (`resolveExhaustedFollowUpHoldOrThrow`): suggestion-origin holds resolve
 * with the same disposition, maintainer and other holds stay pending.
 * Best-effort: never throws, so a forge outage here cannot fail the tick.
 */
export async function resolveWorkerHeld(
  api: HoldStatusPort & { getPR?: (owner: string, repo: string, index: number) => Promise<{ html_url?: string }> },
  store: ReviewJobStore,
  owner: string,
  repo: string,
  issueNumber: number,
  headSha: string,
  kind: "completed" | "skipped",
  reason?: string,
  prNumber?: number | null
): Promise<void> {
  try {
    await resolveExhaustedFollowUpHoldOrThrow({
      api,
      store,
      row: { kind: "follow-up", owner, repo, issueNumber, headSha, prNumber },
      kind,
      ...(reason !== undefined ? { reason } : {}),
    });
  } catch {
    // Best-effort backstop: a forge outage here must not fail the tick.
  }
}
