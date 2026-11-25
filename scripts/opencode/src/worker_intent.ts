import { recordJobCompleted } from "./control_metrics.ts";
import { resolveWorkerHeld } from "./exhausted_hold.ts";
import type { IssueApi } from "./gitea_issues.ts";
import type { ReviewJobRecord, ReviewJobStore } from "./review_jobs.ts";
import type { IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";

/** Prefix for every malformed worker-row settlement reason. */
export const INVALID_JOB_INTENT_PREFIX = "invalid job intent: ";

/** Typed failure for a persisted worker row that cannot be a valid job. */
export class InvalidJobIntentError extends Error {
  readonly detail: string;
  readonly rowId?: number;
  constructor(detail: string, rowId?: number) {
    super(`${INVALID_JOB_INTENT_PREFIX}${detail}`);
    this.name = "InvalidJobIntentError";
    this.detail = detail;
    if (rowId !== undefined) this.rowId = rowId;
  }
}

export type WorkerJobIntentKind =
  | "implement"
  | "follow-up"
  | "follow-up-merge-only"
  | "follow-up-strict-refresh"
  | "conflict";

export type WorkerJobIntent =
  | { kind: "implement" }
  | { kind: "follow-up" }
  | { kind: "follow-up-merge-only" }
  | { kind: "follow-up-strict-refresh" }
  | { kind: "conflict" };

function hasUsablePrNumber(prNumber: unknown): prNumber is number {
  return typeof prNumber === "number" && Number.isFinite(prNumber) && prNumber >= 1;
}

/**
 * Pure decode of a persisted worker row into a discriminated intent.
 * Flags (`mergeOnly`/`strictRefresh`) are only meaningful on `follow-up`;
 * on `implement`/`conflict` they are ignored so rows spread from a
 * merge-only parent keep working. Empty or absent `headSha` is valid.
 * Throws {@link InvalidJobIntentError} for rows that cannot be a valid job.
 */
export function decodeWorkerJobIntent(row: ReviewJobRecord): WorkerJobIntent {
  if (!row.payload) {
    throw new InvalidJobIntentError(`job ${row.id} missing payload`, row.id);
  }
  const kind = row.kind ?? "review";
  if (kind === "implement") return { kind: "implement" };
  if (kind === "conflict") {
    if (!hasUsablePrNumber(row.prNumber)) {
      throw new InvalidJobIntentError(`conflict job ${row.id} missing prNumber`, row.id);
    }
    return { kind: "conflict" };
  }
  if (kind === "follow-up") {
    if (!hasUsablePrNumber(row.prNumber)) {
      throw new InvalidJobIntentError(`follow-up job ${row.id} missing prNumber`, row.id);
    }
    const mergeOnly = Boolean(row.payload.mergeOnly);
    const strictRefresh = Boolean(row.payload.strictRefresh);
    if (strictRefresh && !mergeOnly) {
      throw new InvalidJobIntentError(`follow-up job ${row.id} strictRefresh without mergeOnly`, row.id);
    }
    if (strictRefresh && mergeOnly) return { kind: "follow-up-strict-refresh" };
    if (mergeOnly) return { kind: "follow-up-merge-only" };
    return { kind: "follow-up" };
  }
  throw new InvalidJobIntentError(`job ${row.id} unknown kind ${String(kind)}`, row.id);
}

/**
 * Same rule as {@link decodeWorkerJobIntent}, applied to an `IssueJob`
 * before it is persisted. A missing `follow-up`/`conflict` PR is rejected
 * instead of being coerced to `0`; `strictRefresh` still requires
 * `mergeOnly`. `headSha` may be empty or absent.
 */
export function assertValidIssueJobForEnqueue(job: IssueJob): void {
  const kind = job.mode ?? "implement";
  if (kind === "implement") return;
  if (kind === "conflict") {
    if (!hasUsablePrNumber(job.prNumber)) {
      throw new InvalidJobIntentError("conflict job missing prNumber");
    }
    return;
  }
  if (kind === "follow-up") {
    if (!hasUsablePrNumber(job.prNumber)) {
      throw new InvalidJobIntentError("follow-up job missing prNumber");
    }
    if (job.strictRefresh && !job.mergeOnly) {
      throw new InvalidJobIntentError("follow-up job strictRefresh without mergeOnly");
    }
    return;
  }
  throw new InvalidJobIntentError(`job unknown kind ${String(kind)}`);
}

/**
 * Settle a leased worker row whose persisted payload cannot be a valid job.
 * Stops the heartbeat, then attempts the owner-fenced `markPublished` with
 * state `failed` and an `invalid job intent: ` reason. An error that is not
 * an {@link InvalidJobIntentError} is rethrown for the generic outer worker
 * handler, so only the typed failure settles here. A failed settlement
 * attempt is logged and rethrown without resolving a hold or recording
 * completion, keeping fenced recovery authoritative; a retry after the ledger
 * recovers can still settle the row.
 */
export async function settleInvalidWorkerJobIntent(args: {
  store: ReviewJobStore;
  api: IssueApi;
  row: ReviewJobRecord;
  leasedBy: string;
  error: unknown;
  stopHeartbeat: () => void;
  logger: (message: string) => void;
}): Promise<"processed"> {
  const { store, api, row, leasedBy, error, stopHeartbeat, logger } = args;
  if (!(error instanceof InvalidJobIntentError)) throw error;
  stopHeartbeat();
  const reason = error.message;
  let published: { cancelled: boolean };
  try {
    published = await store.markPublished(row.id, leasedBy, { state: "failed", reason });
  } catch (settleErr) {
    logger(`invalid job intent settle failed ${row.jobKey}: ${errorMessage(settleErr)}`);
    throw settleErr;
  }
  if (published.cancelled) {
    logger(`${row.jobKey} cancelled`);
    return "processed";
  }
  if (row.kind === "follow-up" && row.issueNumber != null) {
    const { owner, repo, issueNumber, headSha, prNumber } = row;
    await resolveWorkerHeld(api, store, owner, repo, issueNumber, headSha, "skipped", "job failed", prNumber);
  }
  recordJobCompleted(row.kind, "failed");
  logger(`${row.jobKey} failed: ${reason}`);
  return "processed";
}
