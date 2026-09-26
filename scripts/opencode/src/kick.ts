import { AUTH_DEATH_REASON, looksLikeProviderAuthDeath } from "./auth.ts";
import { isCiWaitSkipReason } from "./ci.ts";

/**
 * Requeue-a-review kick ("replace the empty commit").
 *
 * A failed or skipped review of one commit can be queued again without a
 * push and without rerunning CI. The kick runs on the board listener, never
 * pushes, never touches CI, and never creates an empty commit.
 */

export const KICK_PATHS = new Set(["/api/board/kick", "/board/kick"]);

export function isKickPath(pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return KICK_PATHS.has(normalized);
}

export interface KickItem {
  owner: string;
  repo: string;
  /** PR number (review jobs only). */
  number: number;
  /** Same commit as the terminal row. */
  commit: string;
}

export interface KickRequest extends KickItem {
  /** Must equal the terminal row's current reason, or the call is rejected. */
  kick: string;
  /** Idempotency key from header or body. Empty means no dedupe. */
  idempotencyKey: string;
}

export type KickRejectCode = "bad-request" | "not-found" | "stale-kick" | "conflict" | "not-kickable";

export interface KickNotKickable {
  kickable: false;
  code: KickRejectCode;
  /** Why there is no kick. A new commit would fail the same way for auth/forge. */
  why: string;
}

export interface Kickable {
  kickable: true;
}

const STATUS_DESCRIPTION_RE =
  /status description|description[\s\S]{0,80}(reject|422|validat|too long|too large|exceed|invalid)|422[\s\S]{0,80}description|validat[\s\S]{0,80}description/i;

export function isStatusDescriptionRejection(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return STATUS_DESCRIPTION_RE.test(reason);
}

export function isAuthFailureReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return looksLikeProviderAuthDeath(reason) || reason.includes(AUTH_DEATH_REASON);
}

const WIP_REASONS = new Set(["draft or WIP pull request", "PR title disables review"]);

function isBlockedDependencyReason(reason: string): boolean {
  const text = reason.trim();
  if (text.startsWith("blocked on ")) return true;
  if (text === "stuck: dependency cycle") return true;
  if (text === "stuck: blocked-by rejected") return true;
  return false;
}

function isRepoMutexReason(reason: string): boolean {
  return reason === "claim is live" || reason === "repo-mutex";
}

function isStalledOrKilledReason(reason: string): boolean {
  const text = reason.toLowerCase();
  if (text.includes("stalled")) return true;
  if (text.includes("killed")) return true;
  if (text.includes("max attempts exceeded")) return true;
  if (/(^|[^0-9])143([^0-9]|$)/.test(text) && text.includes("exit")) return true;
  if (text.includes("sigterm") || text.includes("sigkill")) return true;
  return false;
}

/**
 * Terminal review failures that must stay status lines. Returns the `why`
 * for the 422, or undefined when the reason may be kicked.
 */
export function disabledKickWhy(reason: string): string | undefined {
  if (isAuthFailureReason(reason)) {
    return (
      "No kick: provider auth is dead for this commit. " +
      "Requeueing the same commit would fail the same way; fix credentials and push a new commit."
    );
  }
  if (isStatusDescriptionRejection(reason)) {
    return (
      "No kick: the forge rejected the review status description for this commit. " +
      "Requeueing the same commit would post the same description and fail the same way; push a new commit."
    );
  }
  if (isCiWaitSkipReason(reason)) {
    return "No kick: waiting for CI stays a status line until the sibling check finishes.";
  }
  if (isRepoMutexReason(reason)) {
    return "No kick: an in-flight job for this pull request stays a status line until it finishes.";
  }
  if (WIP_REASONS.has(reason.trim())) {
    return "No kick: a WIP title stays a status line until the pull request is marked ready.";
  }
  if (isBlockedDependencyReason(reason)) {
    return "No kick: a blocked dependency stays a status line until the blocker clears.";
  }
  if (isStalledOrKilledReason(reason)) {
    return "No kick: a stalled or killed job is reclaimed by the lease loop, never auto-retried by this endpoint.";
  }
  return undefined;
}

/** Terminal states eligible for a same-commit requeue. Succeeded/cancelled never are. */
export function isKickableTerminalState(state: string): boolean {
  return state === "failed" || state === "skipped";
}

function strField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

/** Parse a kick body. The actor is never read here: it always comes from the edge identity. */
export function parseKickBody(body: unknown, headerIdempotencyKey: string): KickRequest | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "expected a JSON object" };
  }
  const rec = body as Record<string, unknown>;
  const owner = strField(rec.owner).trim();
  const repo = strField(rec.repo).trim();
  const number = numField(rec.number) ?? numField(rec.prNumber) ?? numField(rec.pr_number) ?? numField(rec.issueNumber);
  const commit = (strField(rec.commit) || strField(rec.headSha) || strField(rec.head_sha) || strField(rec.sha)).trim();
  const kick = (
    strField(rec.kick) ||
    strField(rec.kickId) ||
    strField(rec.kick_id) ||
    strField(rec.id) ||
    strField(rec.reason)
  ).trim();
  const idempotencyKey = (
    headerIdempotencyKey ||
    strField(rec.idempotencyKey) ||
    strField(rec.idempotency_key) ||
    strField(rec["idempotency-key"])
  ).trim();

  if (!owner) return { error: "missing owner" };
  if (!repo) return { error: "missing repo" };
  if (number == null || !Number.isFinite(number) || number <= 0) return { error: "missing number" };
  if (!commit) return { error: "missing commit" };
  if (!kick) return { error: "missing kick" };
  return { owner, repo, number, commit, kick, idempotencyKey };
}

/** Current reason of a terminal row: the publish reason, else the error text. */
export function terminalReasonOf(row: { resultReason: string | null; error: string | null }): string {
  return (row.resultReason ?? row.error ?? "").trim();
}
