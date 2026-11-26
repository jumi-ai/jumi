import { BOARD_BULK_SCRIPT } from "./board_bulk_page.ts";
import {
  DEVICE_LOGIN_BOARD_CANCEL_PATH,
  DEVICE_LOGIN_BOARD_START_PATH,
  DEVICE_LOGIN_BOARD_STATUS_PATH,
  handleDeviceLoginCancel,
  handleDeviceLoginStart,
  handleDeviceLoginStatus,
} from "./board_device_login.ts";
import { BOARD_MCP_KICK_ACTOR, BOARD_MCP_PATH, handleBoardMcp } from "./board_mcp.ts";
import {
  BOARD_BULK_PATH,
  BULK_CATALOG_SUFFIX,
  bulkEligibleForRequeueItem,
  handleBulkHttpRequest,
} from "./bulk_requeue.ts";
import {
  disabledKickWhy,
  isFailingVerdictRow,
  isImplementKickId,
  isKickableReviewRow,
  isKickPath,
  isReopenKickId,
  isStuckKickId,
  kickReasonOf,
  parseImplementKickBody,
  parseKickBody,
  parseReopenKickBody,
  parseStuckKickBody,
  rawKickIdOf,
} from "./kick.ts";
import { parseSkipWhy } from "./pr_decision.ts";
import { fetchRequeueForgeSnapshot } from "./requeue_gate.ts";
import type { KickLogRecord, ReviewJobRecord, ReviewJobStore } from "./review_jobs.ts";
import {
  implementIdempotencyMismatch,
  isBlockedOnReason,
  isQueueUnavailable,
  isUniqueViolation,
  reopenIdempotencyMismatch,
  stuckIdempotencyMismatch,
} from "./review_jobs.ts";
import type { RouterSitReason, RouterSitRecord } from "./router_sits.ts";
import { cancelReviewWork } from "./stuck.ts";
import { errorMessage } from "./util/error.ts";
import { redactGitSecrets } from "./workspace.ts";
import { latchedXaiGrantNotice } from "./xai_auth.ts";

/**
 * Operator board read API + same-commit requeue kick.
 *
 * Served by the router on a second port (3001), never on the webhook host.
 * Polling GET only for the page; POST /api/board/kick requeues a failed or
 * skipped review of the same commit without a push, without rerunning CI,
 * and without an empty commit. In-progress comes from the job ledger
 * (queued or leased); sitting rows come from persisted refusals
 * (`router_sits`). The router stays a single replica; no leader election.
 *
 * Two factories, one page: the browser talks only to the homelab board.
 * The homelab board (FORGE unset/empty/gitea) may include the other factory
 * by calling that factory's board listener server-side. The peer listener
 * is internal-only (no public ingress; ingress changes live outside this
 * repo) and trusts only the bearer, never an identity header forwarded from
 * an arbitrary caller. The username attached after the homelab edge check is
 * the identity kick logging must record; it is never forwarded to the peer
 * and the peer never reads it.
 */

export const BOARD_PORT = 3001;

/** Env: internal peer board listener URL (homelab only). Unset disables the hop. */
export const BOARD_PEER_URL_ENV = "BOARD_PEER_URL";
/** Env: bearer for the peer board hop. Unset means that forge is unavailable. */
export const BOARD_PEER_TOKEN_ENV = "BOARD_PEER_TOKEN";

/** Peer board fetch budget: a slow peer must not hang the homelab board. */
const PEER_BOARD_TIMEOUT_MS = 5_000;

/** Peer board body cap: a compromised peer must not spike homelab memory per poll. */
export const PEER_BOARD_MAX_BYTES = 1_048_576;

/** Forge name of the isolated GitHub factory. Homelab is anything else (gitea). */
export const PEER_FORGE = "github";

/** Peer kick forward budget: a slow peer must not hang the homelab kick. */
const PEER_KICK_TIMEOUT_MS = PEER_BOARD_TIMEOUT_MS;

/** Peer kick response cap: a compromised peer must not spike homelab memory per kick. */
const PEER_KICK_MAX_BYTES = PEER_BOARD_MAX_BYTES;

const BOARD_API_PATH = "/api/board";
const BOARD_KICK_PATH = "/api/board/kick";
const BOARD_PAGE_PATHS = new Set(["/", "/board"]);

/** Ingress injects one of these; the webhook secret is never a substitute.
 * 3001 must only be reachable via that auth proxy (ingress is out of scope):
 * a direct-to-pod route would let anyone self-assert these headers. */
const EDGE_IDENTITY_HEADERS = [
  "x-forwarded-user",
  "x-forwarded-email",
  "x-auth-request-user",
  "x-remote-user",
] as const;

function hasEdgeIdentity(request: Request): boolean {
  return boardUsername(request) !== undefined;
}

/**
 * Username attached after the homelab edge check. First non-empty edge
 * identity header. Kick logging must record this value; the peer must never
 * accept it from a forwarded header (it trusts the bearer instead).
 */
export function boardUsername(request: Request): string | undefined {
  for (const header of EDGE_IDENTITY_HEADERS) {
    const value = request.headers.get(header);
    if (value != null && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function edgeActor(request: Request): string {
  return boardUsername(request) ?? "";
}

/**
 * Peer bearer check. Accepts `Bearer <token>` (and the bare token, like the
 * webhook auth token). Never reads edge identity headers.
 */
function hasBearerAuth(request: Request, expectedToken?: string): boolean {
  const expected = (expectedToken ?? "").trim();
  if (expected === "") return false;
  const actual = (request.headers.get("authorization") ?? "").trim();
  if (actual === "") return false;
  return actual === expected || actual === `Bearer ${expected}`;
}

/** Only the homelab board fans out. The peer never calls back (one-way hop). */
function isHomelabForge(forge?: string): boolean {
  return (forge ?? "gitea") !== PEER_FORGE;
}

/**
 * Public origin of this board behind the ingress.
 *
 * The page is served over HTTPS while the board process sees a cleartext hop
 * from the ingress, so `new URL(request.url).origin` is the internal origin,
 * not the browser one. Only the ingress can reach the board port and it sets
 * the forwarded protocol/host, so those headers are the public origin.
 */
function boardPublicOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = (request.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  const host = (request.headers.get("x-forwarded-host") ?? "").split(",")[0].trim();
  const scheme = proto === "http" || proto === "https" ? proto : url.protocol.replace(":", "").toLowerCase();
  const hostPart = host || url.host;
  try {
    return new URL(`${scheme}://${hostPart}`).origin;
  } catch {
    return url.origin;
  }
}

/** Same-origin guard shared by every confirm path. Absent Origin is allowed. */
export function isAllowedBoardOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  return normalized === boardPublicOrigin(request);
}

function idempotencyKeyOf(request: Request): string {
  const value = request.headers.get("idempotency-key") ?? request.headers.get("x-idempotency-key") ?? "";
  return value.trim();
}

interface BoardKick {
  /** Server-provided effect text for this kick. */
  effect: string;
  /** Kick id the page must send back. Absent on legacy payloads. */
  kick: string;
}

export interface BoardItem {
  /** Internal code: ledger kind+state for in-progress, sit code for sits. Never the card headline. */
  reason: string;
  /** Server-supplied one-sentence headline. The page renders this; reason may stay in the inspector only. */
  message?: string;
  owner: string;
  repo: string;
  /** Pull or issue number (shared number space). */
  number: number;
  /** Job kind for ledger rows; "sit" for refusal rows. */
  kind: string;
  /** Which factory produced this row. Local rows carry the local forge. Used by the forge switch. */
  forge?: string;
  /** Commit SHA when the ledger knows one. Omitted otherwise. */
  commit?: string;
  /** Alias of commit for clients that expect headSha. Omitted otherwise. */
  headSha?: string;
  /** Epoch ms when the sit was decided. Sits only. */
  decidedAt?: number;
  /**
   * Additive presentation metadata: epoch ms when an in-progress ledger row
   * was enqueued. Lets the page show queue age without a new endpoint.
   * Omitted for sits and for rows the ledger did not timestamp.
   */
  createdAt?: number;
  /**
   * Additive presentation metadata: true when a requeueable review row is a
   * published failing verdict (succeeded with a failure trailer) rather than
   * a failed review execution. Lets the page group verdict findings apart
   * from execution failures without inferring from prose.
   */
  failingVerdict?: boolean;
  /** At most one kick. Absent when there is no button payload. */
  kick?: BoardKick;
  bulkEligible?: boolean;
}

export const BOARD_NEEDS_KICK_PAGE_SIZE = 200;

/** In-progress page size: same cap as needs_kick, with an explicit overflow count. */
export const BOARD_IN_PROGRESS_PAGE_SIZE = 200;

export interface BoardGroups {
  in_progress: BoardItem[];
  needs_kick: BoardItem[];
  sitting: BoardItem[];
  needs_kick_overflow?: number;
  /** Count of in-progress rows beyond the page cap. Absent when nothing was cut. */
  in_progress_overflow?: number;
}

export interface BoardPeerStatus {
  available: boolean;
  forge: string;
  /** Peer forge origin for row links. Rendered as href only, never fetched. */
  forgeUrl?: string;
  in_progress?: BoardItem[];
  inProgress?: BoardItem[];
  needs_kick?: BoardItem[];
  needsKick?: BoardItem[];
  needs_kick_overflow?: number;
  needsKickOverflow?: number;
  in_progress_overflow?: number;
  inProgressOverflow?: number;
  sitting?: BoardItem[];
  sitting_on_purpose?: BoardItem[];
  /** Stable unavailable marker. Never a token, URL, or forge secret. */
  error?: string;
}

/**
 * Sits with no button: waits the operator cannot finish from this page
 * (draft/not-ready, CI), plus already done, nothing to ship, or already queued.
 */
const NO_KICK_SITS = new Set<string>([
  "terminal-result",
  "no-changes",
  "repo-mutex",
  "ci-not-completed",
  "draft-wip",
  "waiting-maintainer",
]);

/** One sentence per sit reason, supplied by the server. The page renders this as the headline. */
const SIT_MESSAGES: Record<string, string> = {
  "ci-not-completed": "Waiting for CI to finish before review can start.",
  "draft-wip": "Pull is draft or not ready and is waiting to be marked ready.",
  "foreign-branch": "Pull comes from a foreign branch and cannot be picked up here.",
  "no-closer": "No closing issue is linked to this pull.",
  "implement-latch": "Stuck latch is holding follow-up for the open closer.",
  "no-changes": "Finished with nothing to ship.",
  "terminal-result": "Finished with a terminal result.",
  "repo-mutex": "Already working on this pull in another job.",
  "no-write-access": "Sender lacks write access for this pull.",
  "not-labeled": "Pull is not labeled for pickup.",
  "conflict-ignored": "conflicted, left to author (ignore label)",
  "waiting-maintainer": "Waiting on a maintainer answer.",
  "push-unregistered": "Jumi pushed a commit the forge did not register.",
};

export function sitMessage(reason: RouterSitReason): string {
  return SIT_MESSAGES[reason] ?? "Sitting on purpose.";
}

/**
 * A click that only removes the board row must say it only removes the row.
 * A stuck latch queues a worker job: conflict resolution when the latch is
 * a conflict cap, follow-up otherwise. The confirm names the job that will
 * actually run.
 */
const STUCK_FOLLOWUP_EFFECT = "Clear the stuck latch and queue follow-up on the open closer";
const STUCK_CONFLICT_EFFECT = "Clear the stuck latch and queue conflict resolution on the open closer";

const SIT_KICK_EFFECTS: Record<string, string> = {
  "foreign-branch": "Remove this board row only",
  "no-closer": "Remove this board row only",
  "implement-latch": STUCK_FOLLOWUP_EFFECT,
  "no-write-access": "Remove this board row only",
  "not-labeled": "Remove this board row only",
  "conflict-ignored": "Report conflict left to author (no job queued)",
  "push-unregistered": "Remove this board row only",
};

/** Effect text for a stuck-latch kick: conflict resolution for a conflict-capped latch, follow-up otherwise. */
function stuckKickEffect(stuckReason?: string | null): string {
  return parseSkipWhy(stuckReason).kickKind === "conflict" ? STUCK_CONFLICT_EFFECT : STUCK_FOLLOWUP_EFFECT;
}

/** Kick id the page must send for each kickable sit. Owner-only payloads never confirm these. */
const SIT_KICK_IDS: Record<string, string> = {
  "foreign-branch": "sit-clear",
  "no-closer": "sit-clear",
  "implement-latch": "stuck",
  "no-write-access": "sit-clear",
  "not-labeled": "sit-clear",
  "conflict-ignored": "sit-clear",
  "push-unregistered": "sit-clear",
};

function kickForSit(reason: RouterSitReason, stuckReason?: string | null): BoardKick | undefined {
  if (NO_KICK_SITS.has(reason)) return undefined;
  const effect =
    reason === "implement-latch"
      ? stuckKickEffect(stuckReason)
      : (SIT_KICK_EFFECTS[reason] ?? "Remove this board row only");
  const kick = SIT_KICK_IDS[reason] ?? "sit-clear";
  return { effect, kick };
}

/** Server-provided effect for the same-commit requeue kick. The page confirms this text. */
export const REQUEUE_KICK_EFFECT = "Rerun the review on the same commit, with no push and no CI rerun";

/** Server-provided effect for a blocked-implement re-check kick. The page confirms this text. */
export const BLOCKED_IMPLEMENT_KICK_EFFECT = "Re-check dependencies and queue implement if nothing blocks it";

function boardCatalogHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Kick catalog version baked into the image.
 *
 * The page embeds this and the API echoes it. When the catalog changes the
 * image changes, the versions stop matching, and the old page stops offering
 * kicks until it is refreshed. An old page can never outlive a new catalog.
 */
export const BOARD_KICK_CATALOG_VERSION: string = boardCatalogHash(
  JSON.stringify({
    effects: SIT_KICK_EFFECTS,
    ids: SIT_KICK_IDS,
    none: [...NO_KICK_SITS].sort(),
    requeue: REQUEUE_KICK_EFFECT,
    blockedImplement: BLOCKED_IMPLEMENT_KICK_EFFECT,
    stuckConflict: STUCK_CONFLICT_EFFECT,
    peerForward: "peer-kick-v1",
    bulk: BULK_CATALOG_SUFFIX,
  })
);

function primaryNumber(row: ReviewJobRecord): number {
  if (row.kind === "review") return row.prNumber;
  if (typeof row.issueNumber === "number" && Number.isFinite(row.issueNumber) && row.issueNumber !== 0) {
    return row.issueNumber;
  }
  return row.prNumber;
}

/** Sit reasons whose only board action dismisses the row. Never a retry. */
const BOARD_DISMISSAL_SIT_REASONS: ReadonlySet<string> = new Set([
  "foreign-branch",
  "no-closer",
  "no-write-access",
  "not-labeled",
]);

/** True for a sit whose kick only removes the board row. */
export function isDismissalSitReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && BOARD_DISMISSAL_SIT_REASONS.has(reason);
}

/**
 * Presentation grouping for one board item. Pure and prose-free: verdict is
 * the ledger's `failingVerdict` flag, never a message match; maintainer
 * answer is the structured `waiting-maintainer` sit code, never prose.
 */
export type BoardAttentionKind =
  | "exec-failure"
  | "verdict"
  | "stuck-recovery"
  | "blocked"
  | "answer-needed"
  | "dismissal"
  | "waiting"
  | "running"
  | "queued";

export function boardAttentionKindOf(item: BoardItem): BoardAttentionKind {
  const reason = (item.reason ?? "").trim();
  // In-progress rows: running (leased) sorts before queued.
  if (reason.endsWith(" leased")) return "running";
  if (reason.endsWith(" queued")) return "queued";
  if (reason === "implement-latch") return "stuck-recovery";
  if (reason === "implement skipped") return "blocked";
  if (reason === "waiting-maintainer") return "answer-needed";
  if (isDismissalSitReason(reason)) return "dismissal";
  if (item.failingVerdict === true) return "verdict";
  if (item.kick?.effect === REQUEUE_KICK_EFFECT) return "exec-failure";
  // Requeue rows without the exact effect string (peer payloads, older
  // images) still read as execution failures when they carry a commit kick.
  if (item.kind === "review" && item.kick && (item.commit || item.headSha)) return "exec-failure";
  return "waiting";
}

function inflightMessage(kind: string, state: string): string {
  const key = `${kind} ${state}`;
  const messages: Record<string, string> = {
    "review queued": "Review is queued and waiting for a worker.",
    "review leased": "Review is running.",
    "implement queued": "Implement is queued and waiting for a worker.",
    "implement leased": "Implement is running.",
    "follow-up queued": "Follow-up is queued and waiting for a worker.",
    "follow-up leased": "Follow-up is running.",
    "conflict queued": "Conflict merge is queued and waiting for a worker.",
    "conflict leased": "Conflict merge is running.",
  };
  return messages[key] ?? `${kind} is ${state}.`;
}

function inflightItem(row: ReviewJobRecord, forge?: string): BoardItem {
  const reason = `${row.kind} ${row.state}`;
  const item: BoardItem = {
    reason,
    message: inflightMessage(row.kind, row.state),
    owner: row.owner,
    repo: row.repo,
    number: primaryNumber(row),
    kind: row.kind,
  };
  if (forge) item.forge = forge;
  const sha = (row.headSha ?? "").trim();
  if (sha !== "") {
    item.commit = sha;
    item.headSha = sha;
  }
  if (Number.isFinite(row.createdAt)) item.createdAt = row.createdAt;
  return item;
}

function sitItem(
  sit: RouterSitRecord,
  forge?: string,
  stuckReason?: string | null
): { item: BoardItem; kickable: boolean } {
  const baseMessage = sitMessage(sit.reason);
  const trimmedStuck = (stuckReason ?? "").trim();
  // An implement-latch sit names its stuck latch (including the repeated
  // finding display) so a human sees why follow-up stopped. Other sits keep
  // their generic sentence. Truncated by the board sanitizer.
  const message = sit.reason === "implement-latch" && trimmedStuck ? `${baseMessage} ${trimmedStuck}` : baseMessage;
  const item: BoardItem = {
    reason: sit.reason,
    message,
    owner: sit.owner,
    repo: sit.repo,
    number: sit.number,
    kind: "sit",
    decidedAt: sit.decidedAt,
  };
  if (forge) item.forge = forge;
  const kick = kickForSit(sit.reason, stuckReason);
  if (kick) item.kick = kick;
  return { item, kickable: kick !== undefined };
}

export interface BoardStore {
  listInflight(limit?: number): Promise<ReviewJobRecord[]>;
  listTerminalReviews?(limit?: number): Promise<ReviewJobRecord[]>;
  listTerminalImplements?(limit?: number): Promise<ReviewJobRecord[]>;
  /** Stuck skip reason per issue, when the ledger tracks it. Lets an implement-latch sit name conflict resolution. */
  readIssueSkipLatch?(owner: string, repo: string, issueNumber: number): Promise<{ skipReason: string | null }>;
  /** Strict-refresh slots whose retry budget is exhausted. Surfaced as needs_kick. */
  strictSlots?: {
    listNeedsKick(): Promise<
      Array<{
        owner: string;
        repo: string;
        baseBranch: string;
        prNumber: number;
        headSha: string;
        lastError?: string | null;
      }>
    >;
  };
  sits: {
    list(): Promise<RouterSitRecord[]>;
    listClosedPulls?(): Promise<Array<{ owner: string; repo: string; number: number }>>;
  };
}

/** Best-effort stuck reason for an implement-latch sit. Never fails the board read. */
async function stuckReasonForSit(store: BoardStore, sit: RouterSitRecord): Promise<string | null> {
  if (sit.reason !== "implement-latch") return null;
  try {
    const latch = await store.readIssueSkipLatch?.(sit.owner, sit.repo, sit.number);
    return latch?.skipReason ?? null;
  } catch {
    return null;
  }
}

function requeueMessage(state: string, reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") return `Review ${state} — ready to requeue on the same commit.`;
  return `Review ${state}: ${trimmed} — ready to requeue.`;
}

function requeueItem(row: ReviewJobRecord, reason: string, forge?: string): BoardItem {
  const failing = isFailingVerdictRow(row);
  const item: BoardItem = {
    reason: failing ? `${row.kind} failed` : `${row.kind} ${row.state}`,
    message: requeueMessage(failing ? "failed" : row.state, reason),
    owner: row.owner,
    repo: row.repo,
    number: row.prNumber,
    kind: row.kind,
    kick: { effect: REQUEUE_KICK_EFFECT, kick: reason },
    ...(bulkEligibleForRequeueItem(row) ? { bulkEligible: true as const } : {}),
  };
  if (forge) item.forge = forge;
  const sha = (row.headSha ?? "").trim();
  if (sha !== "") {
    item.commit = sha;
    item.headSha = sha;
  }
  if (failing) item.failingVerdict = true;
  if (Number.isFinite(row.createdAt)) item.createdAt = row.createdAt;
  return item;
}

function blockedImplementItem(row: ReviewJobRecord, reason: string, forge?: string): BoardItem {
  const trimmed = reason.trim();
  const issueNumber =
    typeof row.issueNumber === "number" && Number.isFinite(row.issueNumber) && row.issueNumber > 0
      ? row.issueNumber
      : row.prNumber;
  const item: BoardItem = {
    reason: "implement skipped",
    message: trimmed,
    owner: row.owner,
    repo: row.repo,
    number: issueNumber,
    kind: "implement",
    kick: { effect: BLOCKED_IMPLEMENT_KICK_EFFECT, kick: "implement" },
  };
  if (forge) item.forge = forge;
  return item;
}

function isBlockedImplementRow(row: ReviewJobRecord): boolean {
  if (row.kind !== "implement") return false;
  if (row.state !== "skipped") return false;
  return isBlockedOnReason((row.resultReason ?? "").trim());
}

export async function buildBoardGroups(store: BoardStore, forge?: string): Promise<BoardGroups> {
  const [inflight, sits, terminals, terminalImplements, closedPulls] = await Promise.all([
    // Fetch up to the ledger cap (500) so a long queue reports an exact
    // overflow count instead of describing a capped view as exhaustive.
    store.listInflight(500),
    store.sits.list(),
    store.listTerminalReviews ? store.listTerminalReviews() : Promise.resolve([]),
    store.listTerminalImplements ? store.listTerminalImplements() : Promise.resolve([]),
    store.sits.listClosedPulls ? store.sits.listClosedPulls() : Promise.resolve([]),
  ]);
  const closedKeys = new Set(
    closedPulls.map((pull) => `${pull.owner.toLowerCase()}/${pull.repo.toLowerCase()}#${pull.number}`)
  );
  // A closed pull never shows as in progress: the close webhook cancels its
  // review rows, and this read-time filter is the backstop for a missed
  // webhook (e.g. a ci-wait-pending row parked until its 24h fallback).
  // Same key shape as needs_kick below.
  const all_in_progress = inflight
    .filter((row) => !closedKeys.has(`${row.owner.toLowerCase()}/${row.repo.toLowerCase()}#${primaryNumber(row)}`))
    .map((row) => inflightItem(row, forge));
  // Running rows sort before queued rows so the operator sees what Jumi is
  // doing before what is waiting for a worker. Queued age comes from the
  // oldest queued createdAt the ledger reported.
  all_in_progress.sort((a, b) => {
    const aRun = a.reason.endsWith(" leased") ? 0 : 1;
    const bRun = b.reason.endsWith(" leased") ? 0 : 1;
    if (aRun !== bRun) return aRun - bRun;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
  let in_progress = all_in_progress;
  let in_progress_overflow: number | undefined;
  if (all_in_progress.length > BOARD_IN_PROGRESS_PAGE_SIZE) {
    in_progress_overflow = all_in_progress.length - BOARD_IN_PROGRESS_PAGE_SIZE;
    in_progress = all_in_progress.slice(0, BOARD_IN_PROGRESS_PAGE_SIZE);
  }
  // A sit that duplicates a job already in progress is not a second problem:
  // hide it here. Recording and clearing are unchanged; this is read-time only.
  // Dedup against the full in-progress list, not the capped display slice, so
  // a sit duplicating a queued row past the cap stays hidden.
  const inflightKeys = new Set(
    all_in_progress.map((item) => `${item.owner.toLowerCase()}/${item.repo.toLowerCase()}#${item.number}`)
  );
  const inflightJobKeys = new Set(inflight.map((row) => row.jobKey));
  // PR numbers with any queued/leased work (review, follow-up, or conflict).
  // A failing-verdict review row hides while a follow-up for the same pull is
  // in flight: the follow-up is already addressing the verdict.
  const inflightPullKeys = new Set(
    inflight
      .filter((row) => typeof row.prNumber === "number" && Number.isFinite(row.prNumber) && row.prNumber > 0)
      .map((row) => `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}#${row.prNumber}`)
  );
  // Latest terminal review per pull only: older commits are history, not the current head.
  const latestByPull = new Map<string, ReviewJobRecord>();
  for (const row of terminals) {
    if (row.kind !== "review") continue;
    const key = `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}#${row.prNumber}`;
    const existing = latestByPull.get(key);
    if (!existing || row.id > existing.id) latestByPull.set(key, row);
  }
  const needs_kick: BoardItem[] = [];
  const requeueKeys = new Set<string>();
  for (const row of latestByPull.values()) {
    const key = `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}#${row.prNumber}`;
    if (inflightKeys.has(key)) continue;
    if (closedKeys.has(key)) continue;
    if (inflightJobKeys.has(row.jobKey)) continue;
    if (!isKickableReviewRow(row)) continue;
    // A failing-verdict review hides while a follow-up for the same pull is
    // already queued or running: the follow-up is addressing the verdict.
    if (isFailingVerdictRow(row) && inflightPullKeys.has(key)) continue;
    const reason = kickReasonOf(row);
    if (reason === "") continue;
    if (disabledKickWhy(reason)) continue;
    if ((row.headSha ?? "").trim() === "") continue;
    needs_kick.push(requeueItem(row, reason, forge));
    requeueKeys.add(key);
  }
  // Latest blocked implement per issue only: an open issue whose latest
  // implement is skipped behind dependencies is offered as an implement
  // kick. The row goes away once a new implement row is queued (in-flight)
  // or the issue closes.
  const latestImplementByIssue = new Map<string, ReviewJobRecord>();
  for (const row of terminalImplements) {
    if (row.kind !== "implement") continue;
    const issueNumber =
      typeof row.issueNumber === "number" && Number.isFinite(row.issueNumber) && row.issueNumber > 0
        ? row.issueNumber
        : row.prNumber;
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) continue;
    const key = `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}#${issueNumber}`;
    const existing = latestImplementByIssue.get(key);
    if (!existing || row.id > existing.id) latestImplementByIssue.set(key, row);
  }
  for (const row of latestImplementByIssue.values()) {
    if (!isBlockedImplementRow(row)) continue;
    const issueNumber =
      typeof row.issueNumber === "number" && Number.isFinite(row.issueNumber) && row.issueNumber > 0
        ? row.issueNumber
        : row.prNumber;
    const key = `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}#${issueNumber}`;
    if (inflightKeys.has(key)) continue;
    if (closedKeys.has(key)) continue;
    if (inflightJobKeys.has(row.jobKey)) continue;
    const reason = (row.resultReason ?? "").trim();
    if (reason === "") continue;
    needs_kick.push(blockedImplementItem(row, reason, forge));
  }
  try {
    const strictNeeds = (await store.strictSlots?.listNeedsKick()) ?? [];
    for (const slot of strictNeeds) {
      const key = `${slot.owner.toLowerCase()}/${slot.repo.toLowerCase()}#${slot.prNumber}`;
      if (inflightKeys.has(key)) continue;
      if (closedKeys.has(key)) continue;
      const err = (slot.lastError ?? "refresh retries exhausted").trim().slice(0, 300);
      const message = `Strict refresh needs attention on ${slot.owner}/${slot.repo}#${slot.baseBranch} (holder #${slot.prNumber}): ${err}`;
      const item: BoardItem = {
        reason: "strict-refresh-needs-kick",
        message,
        owner: slot.owner,
        repo: slot.repo,
        number: slot.prNumber,
        kind: "follow-up",
      };
      if (forge) item.forge = forge;
      const sha = (slot.headSha ?? "").trim();
      if (sha !== "") {
        item.commit = sha;
        item.headSha = sha;
      }
      needs_kick.push(item);
    }
  } catch {
    // Best-effort: a strict-slot read never fails the board.
  }
  const sitting: BoardItem[] = [];
  // Resolve stuck reasons up front so an implement-latch sit on a
  // conflict-capped latch names conflict resolution in its kick effect.
  const stuckReasons = new Map<string, string | null>();
  await Promise.all(
    sits.map(async (sit) => {
      stuckReasons.set(
        `${sit.owner.toLowerCase()}/${sit.repo.toLowerCase()}#${sit.number}`,
        await stuckReasonForSit(store, sit)
      );
    })
  );
  for (const sit of sits) {
    const key = `${sit.owner.toLowerCase()}/${sit.repo.toLowerCase()}#${sit.number}`;
    if (inflightKeys.has(key)) continue;
    // A requeueable terminal replaces its terminal-result sit: the row is
    // offered as a requeue kick above, never as "Sitting on purpose".
    if (sit.reason === "terminal-result" && requeueKeys.has(key)) continue;
    const { item, kickable } = sitItem(sit, forge, stuckReasons.get(key) ?? null);
    if (kickable) needs_kick.push(item);
    else sitting.push(item);
  }
  if (needs_kick.length > BOARD_NEEDS_KICK_PAGE_SIZE) {
    const overflow = needs_kick.length - BOARD_NEEDS_KICK_PAGE_SIZE;
    return {
      in_progress,
      needs_kick: needs_kick.slice(0, BOARD_NEEDS_KICK_PAGE_SIZE),
      sitting,
      needs_kick_overflow: overflow,
      ...(in_progress_overflow ? { in_progress_overflow } : {}),
    };
  }
  return {
    in_progress,
    needs_kick,
    sitting,
    ...(in_progress_overflow ? { in_progress_overflow } : {}),
  };
}

/** Keep only the public board shape. Drops tokens, payloads, and forge secrets. */
function sanitizeBoardItem(value: unknown, fallbackForge: string): BoardItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const owner = typeof rec.owner === "string" ? rec.owner : undefined;
  const repo = typeof rec.repo === "string" ? rec.repo : undefined;
  const reason = typeof rec.reason === "string" ? rec.reason : undefined;
  const kind = typeof rec.kind === "string" ? rec.kind : undefined;
  const number =
    typeof rec.number === "number" && Number.isInteger(rec.number) && rec.number > 0 ? rec.number : undefined;
  if (!owner || !repo || !reason || !kind || number === undefined) return undefined;
  const item: BoardItem = { reason, owner, repo, number, kind };
  if (typeof rec.message === "string" && rec.message.trim() !== "") {
    item.message = rec.message.trim().slice(0, 500);
  }
  const forge = typeof rec.forge === "string" && rec.forge.trim() !== "" ? rec.forge.trim() : fallbackForge;
  if (forge) item.forge = forge;
  if (typeof rec.commit === "string" && rec.commit.trim() !== "") item.commit = rec.commit.trim();
  if (typeof rec.headSha === "string" && rec.headSha.trim() !== "") item.headSha = rec.headSha.trim();
  if (typeof rec.decidedAt === "number" && Number.isFinite(rec.decidedAt)) item.decidedAt = rec.decidedAt;
  if (typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt)) item.createdAt = rec.createdAt;
  if (rec.failingVerdict === true) item.failingVerdict = true;
  if (rec.bulkEligible === true) item.bulkEligible = true;
  const kick = rec.kick as { effect?: unknown; kick?: unknown } | undefined;
  if (kick && typeof kick === "object" && typeof kick.effect === "string" && kick.effect.trim() !== "") {
    const id = typeof kick.kick === "string" && kick.kick.trim() !== "" ? kick.kick.trim() : "sit-clear";
    item.kick = { effect: kick.effect, kick: id };
  }
  return item;
}

function sanitizeBoardList(value: unknown, fallbackForge: string): BoardItem[] {
  if (!Array.isArray(value)) return [];
  const out: BoardItem[] = [];
  for (const entry of value) {
    const item = sanitizeBoardItem(entry, fallbackForge);
    if (item) out.push(item);
  }
  return out.slice(0, 500);
}

function peerUnavailable(forge: string = PEER_FORGE): BoardPeerStatus {
  return { available: false, forge, error: "peer unavailable" };
}

type BoardFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

async function fetchPeerBoard(
  peerUrl: string,
  peerToken: string,
  fetchFn: BoardFetchFn = fetch,
  timeoutMs: number = PEER_BOARD_TIMEOUT_MS
): Promise<BoardPeerStatus> {
  const url = peerUrl.trim();
  const token = peerToken.trim();
  if (url === "" || token === "") return peerUnavailable();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return peerUnavailable();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return peerUnavailable();
  // Never forward edge identity headers and never send forge credentials:
  // the hop carries only the bearer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(parsed.toString(), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return peerUnavailable();
    const declaredLength = response.headers?.get("content-length");
    if (declaredLength != null) {
      const declared = Number.parseInt(declaredLength, 10);
      if (Number.isFinite(declared) && declared > PEER_BOARD_MAX_BYTES) return peerUnavailable();
    }
    // Stream with an incremental budget: a peer can omit Content-Length and
    // send a chunked body, so never buffer it whole before the cap runs.
    const reader = response.body?.getReader();
    if (!reader) return peerUnavailable();
    const chunks: Uint8Array[] = [];
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      seen += value.byteLength;
      if (seen > PEER_BOARD_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return peerUnavailable();
      }
      chunks.push(value);
    }
    let body: Record<string, unknown>;
    try {
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return peerUnavailable();
    }
    // Pin every row to PEER_FORGE. Both the top-level body.forge and each
    // row's own rec.forge are peer-supplied and untrusted for filtering, so
    // a compromised peer cannot tag rows with the local forge name.
    // Peer kicks are kept: the page offers the same control as a local row
    // and the homelab kick endpoint forwards peer-forge kicks to the peer
    // board listener over the bearer hop (never acting on the local store).
    const pinForge = (items: BoardItem[]): BoardItem[] => items.map((item) => ({ ...item, forge: PEER_FORGE }));
    const in_progress = pinForge(sanitizeBoardList(body.in_progress ?? body.inProgress, PEER_FORGE));
    const needs_kick = pinForge(sanitizeBoardList(body.needs_kick ?? body.needsKick, PEER_FORGE));
    const sitting = pinForge(sanitizeBoardList(body.sitting ?? body.sitting_on_purpose, PEER_FORGE));
    const overflowRaw = body.needs_kick_overflow ?? body.needsKickOverflow;
    const overflow =
      typeof overflowRaw === "number" && Number.isInteger(overflowRaw) && overflowRaw > 0 ? overflowRaw : undefined;
    const inProgressOverflowRaw = body.in_progress_overflow ?? body.inProgressOverflow;
    const inProgressOverflow =
      typeof inProgressOverflowRaw === "number" && Number.isInteger(inProgressOverflowRaw) && inProgressOverflowRaw > 0
        ? inProgressOverflowRaw
        : undefined;
    const peerForgeUrl =
      typeof body.forgeUrl === "string" && /^https?:\/\/[^/\s]/i.test(body.forgeUrl.trim())
        ? body.forgeUrl.trim()
        : undefined;
    return {
      available: true,
      forge: PEER_FORGE,
      ...(peerForgeUrl ? { forgeUrl: peerForgeUrl } : {}),
      in_progress,
      inProgress: [...in_progress],
      needs_kick,
      needsKick: [...needs_kick],
      ...(overflow ? { needs_kick_overflow: overflow, needsKickOverflow: overflow } : {}),
      ...(inProgressOverflow
        ? { in_progress_overflow: inProgressOverflow, inProgressOverflow: inProgressOverflow }
        : {}),
      sitting,
      sitting_on_purpose: [...sitting],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Peer-forge kick forwarding (homelab only, one-way).
 *
 * The homelab board keeps every existing check before forwarding (edge
 * identity, Origin, idempotency, catalog) and records the actor, forge, row
 * coordinates, and result in its kick log. The peer stays the authority: it
 * re-validates against its own store and its 409/422 come back verbatim.
 * Forge is pinned server-side to PEER_FORGE and the hop URL is derived from
 * the server-configured peerUrl plus a fixed path, so a crafted forge or URL
 * in the request can never redirect the hop. Edge identity headers are never
 * forwarded; the hop carries only the bearer.
 */
function peerForgeFieldOf(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const rec = body as Record<string, unknown>;
  const value = rec.forge;
  return typeof value === "string" ? value.trim() : "";
}

function isPeerForgeKick(body: unknown): boolean {
  return peerForgeFieldOf(body) === PEER_FORGE;
}

function peerKickUrlOf(peerUrl: string): string | undefined {
  const trimmed = peerUrl.trim();
  if (trimmed === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  try {
    return new URL(BOARD_KICK_PATH, parsed.toString()).toString();
  } catch {
    return undefined;
  }
}

function strOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

function extractForwardIdentity(
  body: unknown
): { owner: string; repo: string; number: number; commit: string; kick: string } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const rec = body as Record<string, unknown>;
  const owner = strOrEmpty(rec.owner).trim();
  const repo = strOrEmpty(rec.repo).trim();
  const number =
    numOrUndefined(rec.number) ??
    numOrUndefined(rec.prNumber) ??
    numOrUndefined(rec.pr_number) ??
    numOrUndefined(rec.issueNumber) ??
    numOrUndefined(rec.issue_number);
  if (!owner || !repo || number === undefined) return undefined;
  const commit = (
    strOrEmpty(rec.commit) ||
    strOrEmpty(rec.headSha) ||
    strOrEmpty(rec.head_sha) ||
    strOrEmpty(rec.sha)
  ).trim();
  const kick = rawKickIdOf(body) || (isSitClearPayload(body) ? "sit-clear" : "");
  return { owner, repo, number, commit, kick };
}

function forwardedKickMismatch(
  input: { owner: string; repo: string; number: number; commit: string; kick: string },
  prior: { owner: string; repo: string; number: number; commit: string; kick: string }
): boolean {
  return (
    prior.owner !== input.owner ||
    prior.repo !== input.repo ||
    prior.number !== input.number ||
    prior.commit !== input.commit ||
    prior.kick !== input.kick
  );
}

function forwardedMismatchResponse(prior: { owner: string; repo: string; number: number; commit: string }): Response {
  return json(400, {
    error: `Idempotency key was already used for ${prior.owner}/${prior.repo}#${prior.number} @ ${prior.commit} with a different kick; use a fresh key for a different item.`,
    code: "bad-request",
    terminalJobId: null,
    newJobId: null,
  });
}

function replayForwardedPrior(prior: { result: string }): Response {
  if (prior.result === "peer-ok") {
    return json(200, { ok: true, deduped: true, forwarded: true, forge: PEER_FORGE });
  }
  if (prior.result === "peer-not-found") {
    return json(404, {
      error: "already decided: not-found",
      code: "not-found",
      terminalJobId: null,
      newJobId: null,
      deduped: true,
    });
  }
  if (prior.result === "peer-stale-kick" || prior.result === "peer-conflict") {
    const code = prior.result === "peer-conflict" ? "conflict" : "stale-kick";
    return json(409, {
      error: `already decided: ${prior.result.replace(/^peer-/, "")}`,
      code,
      terminalJobId: null,
      newJobId: null,
      deduped: true,
    });
  }
  return json(422, {
    error: `already decided: ${(prior.result || "not-kickable").replace(/^peer-/, "")}`,
    code: "not-kickable",
    terminalJobId: null,
    newJobId: null,
    deduped: true,
  });
}

function peerResultForStatus(status: number, peerBody: unknown): string | undefined {
  if (status === 200) return "peer-ok";
  if (status === 404) return "peer-not-found";
  if (status === 409) {
    const code =
      peerBody && typeof peerBody === "object" && !Array.isArray(peerBody)
        ? (peerBody as Record<string, unknown>).code
        : undefined;
    return code === "conflict" ? "peer-conflict" : "peer-stale-kick";
  }
  if (status === 422) return "peer-not-kickable";
  return undefined;
}

const FORWARD_BODY_FIELDS = new Set([
  "owner",
  "repo",
  "number",
  "prNumber",
  "pr_number",
  "issueNumber",
  "issue_number",
  "commit",
  "headSha",
  "head_sha",
  "sha",
  "kick",
  "kickId",
  "kick_id",
  "id",
  "reason",
  "idempotencyKey",
  "idempotency_key",
  "idempotency-key",
]);

function sanitizeForwardBody(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return out;
  const rec = body as Record<string, unknown>;
  for (const key of FORWARD_BODY_FIELDS) {
    if (key in rec) out[key] = rec[key];
  }
  return out;
}

async function readCappedPeerKickBody(response: Response): Promise<{ text: string; tooLarge: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      const text = await response.text();
      if (text.length > PEER_KICK_MAX_BYTES) return { text: "", tooLarge: true };
      return { text, tooLarge: false };
    } catch {
      return { text: "", tooLarge: true };
    }
  }
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    seen += value.byteLength;
    if (seen > PEER_KICK_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return { text: "", tooLarge: true };
    }
    chunks.push(value);
  }
  try {
    return { text: new TextDecoder().decode(Buffer.concat(chunks)), tooLarge: false };
  } catch {
    return { text: "", tooLarge: true };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function pageResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export interface BoardHandlerDeps {
  store: ReviewJobStore;
  getGrantNotice?: () => string | undefined;
  logger?: (message: string) => void;
  /** Local factory name for forge tagging/filtering. Defaults to homelab gitea. */
  forge?: string;
  /** Server-configured forge origin for links. Rendered as href only, never fetched. */
  forgeUrl?: string;
  /** Internal peer listener URL. Unset disables the hop (peer unavailable). */
  peerUrl?: string;
  /** Bearer for the peer hop. Unset means that forge is unavailable. Never invent one. */
  peerToken?: string;
  /**
   * Bearer for the read-only MCP endpoint (`POST /mcp`). Unset or empty
   * disables it: `/mcp` answers 404. Never the peer token; never an edge
   * identity header.
   */
  mcpToken?: string;
  /**
   * Bearer that additionally arms the MCP `kick` tool (`POST /mcp`). Unset
   * or empty means no kick tool for anyone and `/mcp` behaves as without it.
   * Never the read token and never the peer token: when it equals either,
   * the kick tool stays disarmed. Never an edge identity header.
   */
  mcpKickToken?: string;
  /**
   * Router secrets redacted from every MCP string (bot token, webhook
   * secrets, peer/MCP tokens). The bearer itself is never logged or returned.
   */
  mcpSecrets?: Array<string | undefined>;
  fetchFn?: BoardFetchFn;
  peerTimeoutMs?: number;
  /**
   * HOME for the review stuck file fallback. Ledger mode (DATABASE_URL) clears
   * the skip-latch row via the store; without a ledger the same kick clears
   * the state file via `cancelReviewWork`. Unset keeps today's behaviour.
   */
  home?: string;
  /**
   * Forge client for the close-then-reopen kick. Only getPR/close/reopen are
   * used; there is never a push and never a job insert on this path.
   */
  forgeApi?: BoardPullForge;
}

export interface BoardPullForge {
  getPR(
    owner: string,
    repo: string,
    index: number
  ): Promise<{ state: string; merged: boolean; head?: { sha: string } }>;
  closePullRequest(owner: string, repo: string, index: number): Promise<unknown>;
  reopenPullRequest(owner: string, repo: string, index: number): Promise<unknown>;
  /**
   * Implement kick forge surface. Optional so existing reopen-only seams
   * keep working. When present, the implement kick queues first and then
   * adds the pickup label so the forge matches; it never opens a pull.
   */
  addIssueLabel?(owner: string, repo: string, index: number, label: string): Promise<unknown>;
  getRepo?(owner: string, repo: string): Promise<{ default_branch?: string; full_name?: string }>;
  getRepoFile?(owner: string, repo: string, path: string, ref: string): Promise<{ found: boolean; content?: string }>;
  /** Dependency re-check surface for a blocked implement kick. Optional; absent means no re-check. */
  listIssueDependencies?(owner: string, repo: string, index: number): Promise<import("./ports.ts").LinkedIssue[]>;
  listOpenPulls?(owner: string, repo: string): Promise<import("./ports.ts").Pull[]>;
}

function normalizePathname(raw: string): string {
  if (raw.length > 1 && raw.endsWith("/")) return raw.slice(0, -1);
  return raw;
}

function withForgeGroups(groups: BoardGroups, forge: string): BoardGroups {
  const tag = (item: BoardItem): BoardItem => ({ ...item, forge: item.forge ?? forge });
  return {
    in_progress: groups.in_progress.map(tag),
    needs_kick: groups.needs_kick.map(tag),
    sitting: groups.sitting.map(tag),
    ...(groups.needs_kick_overflow ? { needs_kick_overflow: groups.needs_kick_overflow } : {}),
    ...(groups.in_progress_overflow ? { in_progress_overflow: groups.in_progress_overflow } : {}),
  };
}

/**
 * Operator board page.
 *
 * Served with the board on the same origin (port 3001). The browser only
 * talks to this origin (`/api/board` GET plus `/api/board/kick` POST); it
 * never calls the forge. Forge URLs below are link hrefs only.
 *
 * Layout contract:
 * - Needs attention first, grouped by next action with counts and reasons:
 *   review execution failures, published findings (failing verdicts),
 *   stuck-job recovery, dependency re-checks, and maintainer answers.
 *   Dependency waits, drafts, unlabeled rows, and terminal no-ops stay out
 *   of the execution-failure group.
 * - Running & queued puts running jobs before queued jobs, shows
 *   running/queued counts and the oldest queued age, collapses a long queue
 *   behind a labeled disclosure, and marks capped views as capped.
 * - Waiting / ignored is collapsed by reason. A dismissal-only action says
 *   Remove from board, lives in secondary controls, and keeps the same
 *   effect and confirmation.
 * - Runner sign-in is reachable from the header without scrolling through
 *   jobs; its effects and access rules are unchanged.
 * - Rows lead with repository, number, and short status. Raw reason,
 *   commit, timestamps, and consequence text stay in the desktop inspector
 *   or the phone detail sheet. Forge filtering, keyboard access, selection,
 *   focus, and disclosures survive refresh where possible. A failed refresh
 *   marks data stale and blocks actions until a fresh response; peer
 *   availability is tracked independently.
 * - Confirm names the server-provided side effect (`kick.effect`) before it
 *   commits. Narrow viewports confirm in a bottom sheet; wide viewports
 *   confirm in the inspector. Actionable confirms keep one primary control;
 *   dismissal-only confirms use secondary controls.
 * - Tablet widths and up are list plus detail, not a centered phone column.
 * - The grant notice is a single line.
 * - The embedded catalog version must match the API `catalog`; on mismatch
 *   the page hides kick buttons until refreshed, so an old page cannot
 *   outlive a new kick catalog.
 */
export function renderBoardPage(catalog: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="jumi-board-catalog" content="${catalog}">
<title>Operator board</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; font-size: 15px; line-height: 1.4; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #8884; }
header h1 { font-size: 17px; margin: 0 8px 0 0; }
header nav { display: flex; flex-wrap: wrap; gap: 8px; font-size: 13px; }
header nav a { padding: 4px 8px; }
.grant { flex-basis: 100%; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.85; }
.catalog-note { font-size: 12px; opacity: 0.7; }
#catalog-mismatch { padding: 8px 12px; font-size: 13px; background: #fff3cd; color: #442d00; }
#load-error { padding: 8px 12px; font-size: 13px; }
#stale { padding: 8px 12px; font-size: 13px; background: #f8d7da; color: #58151c; }
#peer-note { padding: 8px 12px; font-size: 13px; opacity: 0.85; }
#layout { display: block; padding: 0 0 40px; }
#lists { display: block; }
section.list { padding: 8px 12px; }
section.list h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; margin: 8px 0; }
.group-count { font-size: 13px; opacity: 0.8; }
details.group { border: 1px solid #8883; border-radius: 8px; margin: 8px 0; padding: 4px 8px; }
details.group summary { cursor: pointer; padding: 6px 4px; font-weight: 600; }
details.group summary .why { font-weight: 400; opacity: 0.75; font-size: 13px; }
ul.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
li.row { border: 1px solid #8884; border-radius: 8px; padding: 8px 10px; }
li.row.selected { outline: 2px solid currentColor; }
li.row:focus { outline: 2px solid currentColor; }
.row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.reason { font-weight: 650; margin: 0; overflow-wrap: anywhere; }
.sub { font-size: 13px; opacity: 0.8; overflow-wrap: anywhere; }
.status-line { font-size: 13px; opacity: 0.8; margin-top: 6px; }
.row-actions { margin-top: 8px; display: flex; gap: 8px; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #8888; background: transparent; }
button.primary { background: #0b5fff; border-color: #0b5fff; color: #fff; font-weight: 650; }
button.secondary { opacity: 0.85; }
button:disabled { opacity: 0.45; }
#inspector { border-top: 1px solid #8884; padding: 12px; }
#inspector h2 { font-size: 15px; margin: 0 0 4px; overflow-wrap: anywhere; }
.consequence { font-size: 13px; border-left: 3px solid #0b5fff; padding-left: 8px; }
.forge-link { font-size: 13px; }
#signin-panel { border-bottom: 1px solid #8884; padding: 8px 12px; }
#signin-panel h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; margin: 8px 0; }
#grok { border-top: 1px solid #8884; }
#grok .grok-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
#grok input, #grok select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid #8888; background: transparent; max-width: 100%; }
#grok .grok-link { display: inline-block; padding: 10px 12px; margin-top: 8px; }
#grok .grok-code { display: inline-block; padding: 10px 12px; margin: 8px 0 0 8px; font-size: 18px; font-weight: 700; letter-spacing: 0.06em; border: 1px dashed #8888; border-radius: 8px; user-select: all; -webkit-user-select: all; }
#grok .grok-expiry { font-size: 13px; opacity: 0.85; margin-top: 6px; }
#grok .grok-state { font-size: 13px; margin-top: 6px; }
#codex { border-top: 1px solid #8884; }
#codex .codex-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
#codex input, #codex select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid #8888; background: transparent; max-width: 100%; }
#codex .codex-link { display: inline-block; padding: 10px 12px; margin-top: 8px; }
#codex .codex-code { display: inline-block; padding: 10px 12px; margin: 8px 0 0 8px; font-size: 18px; font-weight: 700; letter-spacing: 0.06em; border: 1px dashed #8888; border-radius: 8px; user-select: all; -webkit-user-select: all; }
#codex .codex-expiry { font-size: 13px; opacity: 0.85; margin-top: 6px; }
#codex .codex-state { font-size: 13px; margin-top: 6px; }
#sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); }
#sheet { position: fixed; left: 0; right: 0; bottom: 0; max-height: 80vh; overflow: auto; background: Canvas; border-top-left-radius: 12px; border-top-right-radius: 12px; padding: 14px; border-top: 1px solid #8886; }
@media (min-width: 700px) {
  #layout { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); align-items: start; }
  #inspector { border-top: none; border-left: 1px solid #8884; position: sticky; top: 0; min-height: 40vh; }
}
@media (min-width: 1100px) {
  #layout { grid-template-columns: minmax(0,1fr) 420px; }
}
</style>
</head>
<body>
<header>
<h1>Board</h1>
<nav aria-label="Board sections">
<a href="#needs-attention">Needs attention</a>
<a href="#running">Running &amp; queued</a>
<a href="#waiting">Waiting / ignored</a>
<a href="#signin-panel">Runner sign-in</a>
</nav>
<label>Forge <select id="forge-switch" aria-label="Forge">
<option value="gitea">gitea</option>
<option value="github">github</option>
</select></label>
<button id="refresh" class="secondary" type="button">Refresh</button>
<span id="catalog" class="catalog-note" title="Kick catalog baked into this page">catalog ${catalog.slice(0, 8)}</span>
<div id="grant" class="grant" hidden></div>
</header>
<div id="catalog-mismatch" hidden>Board updated — refresh to get the latest kick list.</div>
<div id="stale" hidden>Data is stale — actions are disabled until a fresh response loads. Use Refresh to load again.</div>
<div id="load-error" hidden></div>
<div id="peer-note" hidden></div>
<section id="signin-panel" aria-label="Runner sign-in">
<h2>Runner sign-in</h2>
<div class="sub">Runner sign-in lives here so it stays reachable without scrolling through jobs. Effects and access rules are unchanged.</div>
<section class="list" aria-label="Grok sign-in" id="grok">
<h2>Grok sign-in</h2>
<div class="sub">Start a Grok device login on one homelab engine or worker ordinal. No exec into the pod.</div>
<div class="grok-controls">
<label>Role <select id="grok-role" aria-label="Ordinal role">
<option value="worker">worker</option>
<option value="engine">engine</option>
</select></label>
<label>Ordinal <input id="grok-ordinal" inputmode="text" autocomplete="off" spellcheck="false" placeholder="jumi-worker-0" aria-label="Ordinal host"></label>
<button id="grok-check" class="secondary" type="button">Check status</button>
<button id="grok-start" class="primary" type="button">Start Grok sign-in</button>
<button id="grok-cancel" class="secondary" type="button">Cancel sign-in</button>
</div>
<div id="grok-note" class="sub"></div>
<div id="grok-result" hidden>
<a id="grok-link" class="grok-link" href="#" rel="noopener" target="_blank">Open provider page</a>
<code id="grok-code" class="grok-code" title="Device code"></code>
<div id="grok-expiry" class="grok-expiry"></div>
<div id="grok-state" class="grok-state"></div>
</div>
</section>
<section class="list" aria-label="Codex sign-in" id="codex">
<h2>Codex sign-in</h2>
<div class="sub">Start a Codex device login on the always-on control role. No exec into the pod. Long-running per-ordinal logins keep working until they move.</div>
<div class="codex-controls">
<label>Role <input id="codex-role" value="control" disabled aria-label="Control role"></label>
<label>Target <input id="codex-ordinal" value="control" disabled aria-label="Control host"></label>
<button id="codex-check" class="secondary" type="button">Check status</button>
<button id="codex-start" class="primary" type="button">Start Codex sign-in</button>
<button id="codex-cancel" class="secondary" type="button">Cancel sign-in</button>
</div>
<div id="codex-note" class="sub"></div>
<div id="codex-result" hidden>
<a id="codex-link" class="codex-link" href="#" rel="noopener" target="_blank">Open provider page</a>
<code id="codex-code" class="codex-code" title="Device code"></code>
<div id="codex-expiry" class="codex-expiry"></div>
<div id="codex-state" class="codex-state"></div>
</div>
</section>
</section>
<main id="layout">
<div id="lists">
<section class="list" aria-label="Needs attention" id="needs-attention">
<h2>Needs attention</h2>
<div id="needs-groups"></div>
</section>
<section class="list" aria-label="Running and queued" id="running">
<h2>Running &amp; queued</h2>
<div id="run-counts" class="group-count"></div>
<div id="run-lists"></div>
</section>
<section class="list" aria-label="Waiting or ignored" id="waiting">
<h2>Waiting / ignored</h2>
<div id="waiting-groups"></div>
</section>
<ul id="inprogress" class="rows" hidden></ul>
<ul id="sitting" class="rows" hidden></ul>
</div>
<aside id="inspector" aria-live="polite" aria-label="Detail"></aside>
</main>
<div id="sheet-wrap" hidden>
<div id="sheet-backdrop"></div>
<div id="sheet" role="dialog" aria-modal="true" aria-label="Confirm action"></div>
</div>
<script>
const PAGE_CATALOG = ${JSON.stringify(catalog)};
const REQUEUE_EFFECT = ${JSON.stringify(REQUEUE_KICK_EFFECT)};
const BLOCKED_EFFECT = ${JSON.stringify(BLOCKED_IMPLEMENT_KICK_EFFECT)};
const QUEUE_COLLAPSE_AT = 10;
const DISMISSAL_REASONS = { "foreign-branch": 1, "no-closer": 1, "no-write-access": 1, "not-labeled": 1 };
const state = { data: null, selected: null, forge: "gitea", catalogOk: true, stale: false, openGroups: {} };
const $ = (id) => document.getElementById(id);
const narrow = () => !window.matchMedia("(min-width: 700px)").matches;
function keyOf(item) { const forge = item.forge || (state.data && state.data.forge) || "gitea"; return forge + "/" + item.owner + "/" + item.repo + "/" + item.kind + "#" + item.number; }
function groupsOf(data) {
  const inProgress = [...(data.in_progress || data.inProgress || [])];
  const needsKick = [...(data.needs_kick || data.needsKick || [])];
  const sitting = [...(data.sitting || data.sitting_on_purpose || [])];
  let needsKickOverflow = data.needs_kick_overflow || data.needsKickOverflow || 0;
  let inProgressOverflow = data.in_progress_overflow || data.inProgressOverflow || 0;
  const peers = data.peers && typeof data.peers === "object" ? Object.values(data.peers) : [];
  let peerAvailable = true;
  let peerNote = "";
  for (const p of peers) {
    if (!p || typeof p !== "object") continue;
    if (!p.available) { peerAvailable = false; peerNote = "Peer (" + (p.forge || "github") + ") unavailable — showing local rows only."; continue; }
    inProgress.push(...(p.in_progress || p.inProgress || []));
    needsKick.push(...(p.needs_kick || p.needsKick || []));
    sitting.push(...(p.sitting || p.sitting_on_purpose || []));
    needsKickOverflow += p.needs_kick_overflow || p.needsKickOverflow || 0;
    inProgressOverflow += p.in_progress_overflow || p.inProgressOverflow || 0;
    peerNote = "";
  }
  return { inProgress, needsKick, sitting, needsKickOverflow, inProgressOverflow, peerAvailable, peerNote };
}
function forgeOf(item, data) { return item.forge || data.forge || "gitea"; }
function forgeBaseFor(item, data) {
  const forge = forgeOf(item, data);
  if (forge === (data.forge || "gitea")) return (data.forgeUrl || "").replace(/\\/+$/, "");
  const peer = data.peers && data.peers[forge];
  if (peer && typeof peer.forgeUrl === "string") {
    const trimmed = peer.forgeUrl.trim().replace(/\\/+$/, "");
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("http://") || lower.startsWith("https://")) return trimmed;
  }
  return "";
}
function forgeHref(item, data) {
  const base = forgeBaseFor(item, data);
  if (!base) return null;
  if (item.kind === "sit") return null;
  const forge = forgeOf(item, data);
  const path = item.kind === "review" ? (forge === "github" ? "pull" : "pulls") : "issues";
  return base + "/" + encodeURIComponent(item.owner) + "/" + encodeURIComponent(item.repo) + "/" + path + "/" + item.number;
}
function isDismissal(item) { return Boolean(item.kick) && DISMISSAL_REASONS[item.reason]; }
function attentionKind(item) {
  const reason = (item.reason || "").trim();
  if (reason.endsWith(" leased")) return "running";
  if (reason.endsWith(" queued")) return "queued";
  if (reason === "implement-latch") return "stuck-recovery";
  if (reason === "implement skipped") return "blocked";
  if (reason === "waiting-maintainer") return "answer-needed";
  if (DISMISSAL_REASONS[reason]) return "dismissal";
  if (item.failingVerdict === true) return "verdict";
  if (item.kick && item.kick.effect === REQUEUE_EFFECT) return "exec-failure";
  if (item.kind === "review" && item.kick && (item.commit || item.headSha)) return "exec-failure";
  return "waiting";
}
function shortStatus(item) {
  const kind = attentionKind(item);
  if (kind === "running") return "Running " + item.kind;
  if (kind === "queued") return "Queued " + item.kind;
  if (kind === "exec-failure") return "Review failed";
  if (kind === "verdict") return "Findings published";
  if (kind === "stuck-recovery") {
    const effect = item.kick && item.kick.effect ? item.kick.effect : "";
    if (/conflict/i.test(effect)) return "Stuck — conflict recovery";
    return "Stuck — follow-up recovery";
  }
  if (kind === "blocked") return "Blocked — re-check ready";
  if (kind === "answer-needed") return "Needs maintainer answer";
  if (kind === "dismissal") return "Can remove from board";
  return item.reason;
}
function headlineOf(item) { return (typeof item.message === "string" && item.message.trim() !== "" ? item.message : item.reason); }
function isActionable(item) {
  if (state.stale) return false;
  if (!state.catalogOk) return false;
  if (!item.kick || typeof item.kick.effect !== "string" || item.kick.effect.trim() === "") return false;
  if (item.reason === "conflict-ignored") return false;
  return true;
}
function isPrimaryAction(item) {
  if (!isActionable(item)) return false;
  return !isDismissal(item);
}
function kickLabelOf(item) {
  if (isDismissal(item)) return "Remove from board";
  const id = item.kick && typeof item.kick.kick === "string" ? item.kick.kick.trim() : "";
  if (id === "stuck" || id === "follow-up" || id === "followup" || id === "stuck-latch") {
    const effect = item.kick && typeof item.kick.effect === "string" ? item.kick.effect : "";
    if (/conflict/i.test(effect)) return "Clear latch and queue conflict resolution";
    return "Clear latch and queue follow-up";
  }
  if (id === "implement") return "Re-check and queue implement";
  const effect = item.kick && typeof item.kick.effect === "string" ? item.kick.effect : "";
  if (effect === REQUEUE_EFFECT) return "Requeue review";
  if ((typeof item.commit === "string" && item.commit.trim() !== "") || (typeof item.headSha === "string" && item.headSha.trim() !== "")) return "Requeue review";
  return "Remove from board";
}
function ageText(ms) {
  if (!ms || ms <= 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h";
  return Math.floor(h / 24) + "d";
}
async function load() {
  const errBox = $("load-error");
  const staleBox = $("stale");
  errBox.hidden = true;
  errBox.textContent = "";
  let res;
  try {
    res = await fetch("/api/board", { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
  } catch (err) {
    state.stale = true;
    staleBox.hidden = false;
    errBox.hidden = false;
    errBox.textContent = "Board unavailable. Data is stale — actions are disabled until a fresh response loads. Use Refresh to load again.";
    render();
    return;
  }
  if (!res.ok) {
    state.stale = true;
    staleBox.hidden = false;
    errBox.hidden = false;
    errBox.textContent = res.status === 401 ? "Sign in via the edge proxy, then Refresh. Data is stale — actions are disabled." : "Board unavailable (" + res.status + "). Data is stale — actions are disabled. Use Refresh to load again.";
    render();
    return;
  }
  const data = await res.json();
  state.stale = false;
  staleBox.hidden = true;
  state.data = data;
  const serverForge = data.forge || "gitea";
  if (!$("forge-switch").dataset.touched) state.forge = serverForge;
  $("forge-switch").value = state.forge;
  state.catalogOk = data.catalog === PAGE_CATALOG;
  $("catalog-mismatch").hidden = state.catalogOk;
  if (!state.catalogOk) closeConfirm();
  const grant = $("grant");
  if (typeof data.grant === "string" && data.grant.trim() !== "") {
    grant.hidden = false;
    grant.textContent = data.grant.split("\\n")[0];
    grant.title = grant.textContent;
  } else {
    grant.hidden = true;
    grant.textContent = "";
  }
  if (state.selected) {
    const all = [...groupsOf(data).inProgress, ...groupsOf(data).needsKick, ...groupsOf(data).sitting];
    const stillThere = all.some((item) => keyOf(item) === state.selected && forgeOf(item, data) === state.forge);
    if (!stillThere) state.selected = null;
  }
  render();
}
function rowItem(item, opts) {
  const li = document.createElement("li");
  li.className = "row" + (state.selected === keyOf(item) ? " selected" : "");
  li.tabIndex = 0;
  li.dataset.key = keyOf(item);
  const head = document.createElement("div");
  head.className = "row-head";
  const h = document.createElement("p");
  h.className = "reason";
  h.textContent = item.owner + "/" + item.repo + "#" + item.number + " · " + shortStatus(item);
  head.appendChild(h);
  li.appendChild(head);
  const sub = document.createElement("div");
  sub.className = "sub";
  let subText = item.kind + " · " + forgeOf(item, state.data);
  if (item.commit) subText += " · " + String(item.commit).slice(0, 8);
  else if (item.headSha) subText += " · " + String(item.headSha).slice(0, 8);
  sub.textContent = subText;
  li.appendChild(sub);
  const actionable = isActionable(item);
  if (actionable) {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = kickLabelOf(item);
    btn.className = isPrimaryAction(item) ? "primary" : "secondary";
    if (state.stale || !state.catalogOk) btn.disabled = true;
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); if (state.stale) return; state.selected = keyOf(item); render(); openConfirm(item); });
    actions.appendChild(btn);
    li.appendChild(actions);
  } else if (attentionKind(item) === "dismissal" || !item.kick) {
    const line = document.createElement("div");
    line.className = "status-line";
    line.textContent = item.reason === "conflict-ignored" ? "Left to author — no board action" : "Waiting — no board action";
    li.appendChild(line);
  }
  const activate = () => { state.selected = keyOf(item); render(); const el = $("inspector").querySelector("button"); if (el && !narrow()) { } };
  li.addEventListener("click", activate);
  li.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activate(); } });
  return li;
}
function renderNeeds(groups, data, forge) {
  const box = $("needs-groups");
  box.textContent = "";
  const needs = groups.needsKick.filter((item) => forgeOf(item, data) === forge);
  const waitingMaintainer = groups.sitting.filter((item) => forgeOf(item, data) === forge && item.reason === "waiting-maintainer");
  const defs = [
    { key: "exec-failure", title: "Review execution failed", why: "Requeue the same commit; prose stays in detail." },
    { key: "verdict", title: "Published findings", why: "A failing verdict was published; requeue to address it." },
    { key: "stuck-recovery", title: "Stuck recovery", why: "Clear the latch and queue follow-up or conflict resolution." },
    { key: "blocked", title: "Dependency wait", why: "Re-check dependencies and queue implement when unblocked." },
    { key: "answer-needed", title: "Needs maintainer answer", why: "A maintainer question is waiting on the forge." },
  ];
  let total = 0;
  for (const def of defs) {
    let items = [];
    if (def.key === "answer-needed") items = waitingMaintainer;
    else if (def.key === "exec-failure") items = needs.filter((i) => attentionKind(i) === "exec-failure");
    else if (def.key === "verdict") items = needs.filter((i) => attentionKind(i) === "verdict");
    else if (def.key === "stuck-recovery") items = needs.filter((i) => attentionKind(i) === "stuck-recovery");
    else if (def.key === "blocked") items = needs.filter((i) => attentionKind(i) === "blocked");
    total += items.length;
    const det = document.createElement("details");
    det.className = "group";
    det.dataset.group = "needs-" + def.key;
    const wasOpen = state.openGroups["needs-" + def.key];
    det.open = wasOpen === undefined ? items.length > 0 : wasOpen;
    det.addEventListener("toggle", () => { state.openGroups["needs-" + def.key] = det.open; });
    const sum = document.createElement("summary");
    sum.textContent = def.title + " (" + items.length + ") — " + def.why;
    det.appendChild(sum);
    if (items.length === 0) {
      const p = document.createElement("div");
      p.className = "sub";
      p.textContent = "None — nothing in this group.";
      det.appendChild(p);
    } else {
      const ul = document.createElement("ul");
      ul.className = "rows";
      for (const item of items) ul.appendChild(rowItem(item, { section: "needs" }));
      det.appendChild(ul);
    }
    box.appendChild(det);
  }
  if (groups.needsKickOverflow > 0) {
    const p = document.createElement("div");
    p.className = "sub";
    p.textContent = "Showing " + needs.length + " of " + (needs.length + groups.needsKickOverflow) + " — capped, not exhaustive. Refresh shows the latest.";
    box.appendChild(p);
  }
  return total;
}
function renderRunning(groups, data, forge) {
  const counts = $("run-counts");
  const lists = $("run-lists");
  counts.textContent = "";
  lists.textContent = "";
  const all = groups.inProgress.filter((item) => forgeOf(item, data) === forge);
  const running = all.filter((i) => attentionKind(i) === "running");
  const queued = all.filter((i) => attentionKind(i) !== "running");
  const queuedAges = queued.map((i) => (typeof i.createdAt === "number" ? Date.now() - i.createdAt : 0)).filter((n) => n > 0);
  const oldest = queuedAges.length > 0 ? Math.max.apply(null, queuedAges) : 0;
  let text = "Running (" + running.length + ") · Queued (" + queued.length + ")";
  if (queued.length > 0) text += oldest > 0 ? " · Oldest queued " + ageText(oldest) : " · Oldest queued unknown";
  if (groups.inProgressOverflow > 0) text += " · Showing " + all.length + " of " + (all.length + groups.inProgressOverflow) + " — capped, not exhaustive";
  counts.textContent = text;
  const peerNote = $("peer-note");
  if (!groups.peerAvailable) { peerNote.hidden = false; peerNote.textContent = groups.peerNote; }
  else if (groups.peerNote) { peerNote.hidden = false; peerNote.textContent = groups.peerNote; }
  else { peerNote.hidden = true; peerNote.textContent = ""; }
  if (all.length === 0) {
    const li = document.createElement("div");
    li.className = "sub";
    li.textContent = groups.peerAvailable ? "None — nothing running or queued on this forge." : "None locally — peer unavailable, showing local rows only.";
    lists.appendChild(li);
    return;
  }
  const runHead = document.createElement("div");
  runHead.className = "sub";
  runHead.textContent = "Running first (" + running.length + ")";
  lists.appendChild(runHead);
  const runUl = document.createElement("ul");
  runUl.className = "rows";
  for (const item of running) runUl.appendChild(rowItem(item, { section: "inprogress" }));
  if (running.length === 0) {
    const li = document.createElement("div");
    li.className = "sub";
    li.textContent = "None running.";
    lists.appendChild(li);
  } else lists.appendChild(runUl);
  const qHead = document.createElement("div");
  qHead.className = "sub";
  qHead.textContent = "Queued (" + queued.length + ")";
  lists.appendChild(qHead);
  if (queued.length === 0) {
    const li = document.createElement("div");
    li.className = "sub";
    li.textContent = "None queued.";
    lists.appendChild(li);
  } else if (queued.length <= QUEUE_COLLAPSE_AT) {
    const qUl = document.createElement("ul");
    qUl.className = "rows";
    for (const item of queued) qUl.appendChild(rowItem(item, { section: "inprogress" }));
    lists.appendChild(qUl);
  } else {
    const first = queued.slice(0, QUEUE_COLLAPSE_AT);
    const rest = queued.slice(QUEUE_COLLAPSE_AT);
    const qUl = document.createElement("ul");
    qUl.className = "rows";
    for (const item of first) qUl.appendChild(rowItem(item, { section: "inprogress" }));
    lists.appendChild(qUl);
    const det = document.createElement("details");
    det.className = "group";
    det.dataset.group = "queued-rest";
    det.open = state.openGroups["queued-rest"] === true;
    det.addEventListener("toggle", () => { state.openGroups["queued-rest"] = det.open; });
    const sum = document.createElement("summary");
    sum.textContent = "Show " + rest.length + " more queued";
    det.appendChild(sum);
    const rUl = document.createElement("ul");
    rUl.className = "rows";
    for (const item of rest) rUl.appendChild(rowItem(item, { section: "inprogress" }));
    det.appendChild(rUl);
    lists.appendChild(det);
  }
  if (groups.inProgressOverflow > 0) {
    const p = document.createElement("div");
    p.className = "sub";
    p.textContent = "Capped view: oldest queued age covers visible rows only.";
    lists.appendChild(p);
  }
}
function renderWaiting(groups, data, forge) {
  const box = $("waiting-groups");
  box.textContent = "";
  const waiting = [...groups.sitting.filter((i) => i.reason !== "waiting-maintainer"), ...groups.needsKick.filter((i) => attentionKind(i) === "dismissal" || attentionKind(i) === "waiting")];
  const filtered = waiting.filter((item) => forgeOf(item, data) === forge);
  const byReason = {};
  for (const item of filtered) {
    const r = item.reason;
    if (!byReason[r]) byReason[r] = [];
    byReason[r].push(item);
  }
  const reasons = Object.keys(byReason).sort();
  if (reasons.length === 0) {
    const p = document.createElement("div");
    p.className = "sub";
    p.textContent = "None — nothing waiting on this forge.";
    box.appendChild(p);
    return;
  }
  for (const reason of reasons) {
    const items = byReason[reason];
    const det = document.createElement("details");
    det.className = "group";
    det.dataset.group = "waiting-" + reason;
    const wasOpen = state.openGroups["waiting-" + reason];
    det.open = wasOpen === undefined ? false : wasOpen;
    det.addEventListener("toggle", () => { state.openGroups["waiting-" + reason] = det.open; });
    const dismissible = items.filter(isDismissal).length;
    const sum = document.createElement("summary");
    sum.textContent = reason + " (" + items.length + ")" + (dismissible > 0 ? " — " + dismissible + " can remove from board" : " — waiting");
    det.appendChild(sum);
    const ul = document.createElement("ul");
    ul.className = "rows";
    for (const item of items) ul.appendChild(rowItem(item, { section: "waiting" }));
    det.appendChild(ul);
    box.appendChild(det);
  }
}
function render() {
  const data = state.data;
  if (!data) { $("inspector").textContent = "Select a row to see detail."; return; }
  const groups = groupsOf(data);
  const inList = $("inprogress");
  const sitList = $("sitting");
  if (inList) inList.textContent = "";
  if (sitList) sitList.textContent = "";
  const focusedKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  renderNeeds(groups, data, state.forge);
  renderRunning(groups, data, state.forge);
  renderWaiting(groups, data, state.forge);
  renderInspector();
  if (focusedKey) {
    const next = document.querySelector('[data-key="' + focusedKey + '"]');
    if (next && document.activeElement !== next) { try { next.focus({ preventScroll: true }); } catch (e) {} }
  }
}
function selectedItem() {
  const data = state.data;
  if (!data || !state.selected) return null;
  const groups = groupsOf(data);
  const all = [...groups.inProgress, ...groups.needsKick, ...groups.sitting];
  return all.find((item) => keyOf(item) === state.selected && forgeOf(item, data) === state.forge) || null;
}
function confirmBlock(item, data, confirmIdPrefix) {
  const wrap = document.createElement("div");
  const hasKick = Boolean(item.kick && typeof item.kick.effect === "string");
  const kickId = item.kick && typeof item.kick.kick === "string" && item.kick.kick.trim() !== "" ? item.kick.kick.trim() : "";
  const idempotencyKey = (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + "-" + Math.floor(Math.random() * 1e9));
  if (state.stale) {
    const note = document.createElement("p");
    note.className = "consequence";
    note.textContent = "Data is stale — actions are disabled until a fresh response loads.";
    wrap.appendChild(note);
    return wrap;
  }
  if (hasKick && state.catalogOk) {
    const note = document.createElement("p");
    note.className = "consequence";
    note.textContent = "This will: " + item.kick.effect;
    wrap.appendChild(note);
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = isDismissal(item) ? "secondary" : "primary";
    primary.id = confirmIdPrefix + "-confirm";
    primary.textContent = kickLabelOf(item);
    const msg = document.createElement("div");
    msg.className = "sub";
    msg.id = confirmIdPrefix + "-msg";
    primary.addEventListener("click", async () => {
      if (state.stale) { msg.textContent = "Data is stale — refresh before confirming."; return; }
      if (!state.catalogOk) {
        msg.textContent = "Board updated — refresh to get the latest kick list before confirming.";
        return;
      }
      msg.textContent = "Working…";
      try {
        const payload = { owner: item.owner, repo: item.repo, number: item.number, forge: forgeOf(item, data) };
        if (typeof item.commit === "string" && item.commit.trim() !== "") payload.commit = item.commit;
        else if (typeof item.headSha === "string" && item.headSha.trim() !== "") payload.commit = item.headSha;
        if (kickId) payload.kick = kickId;
        payload.idempotencyKey = idempotencyKey;
        const res = await fetch("/api/board/kick", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          closeConfirm();
          await load();
        } else if (res.status === 409 || res.status === 422 || res.status === 503) {
          let detail = "";
          try {
            const data = await res.json();
            if (data && typeof data.error === "string" && data.error.trim() !== "") detail = data.error.trim();
          } catch {}
          if (detail !== "") {
            msg.textContent = detail;
          } else if (res.status === 409) {
            msg.textContent = "That kick is no longer offered for this row.";
          } else if (res.status === 503) {
            msg.textContent = "Peer unavailable. Close and confirm again to try once more.";
          } else {
            msg.textContent = "Kick did not land (422). Close and confirm again to try once more.";
          }
        } else if (res.status === 404) {
          msg.textContent = "That row is gone. Refresh to update the list.";
        } else if (res.status === 401) {
          msg.textContent = "Sign in via the edge proxy, then try again.";
        } else {
          msg.textContent = "Kick did not land (" + res.status + "). Close and confirm again to try once more.";
        }
      } catch (err) {
        msg.textContent = "Kick did not land. Close and confirm again to try once more.";
      }
    });
    wrap.appendChild(primary);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "secondary";
    close.textContent = "Close";
    close.addEventListener("click", closeConfirm);
    wrap.appendChild(document.createTextNode(" "));
    wrap.appendChild(close);
    wrap.appendChild(msg);
  } else if (hasKick && !state.catalogOk) {
    const note = document.createElement("p");
    note.className = "consequence";
    note.textContent = "Board updated — refresh to get the latest kick list before confirming.";
    wrap.appendChild(note);
  }
  return wrap;
}
function renderInspector() {
  const box = $("inspector");
  box.textContent = "";
  const data = state.data;
  const item = selectedItem();
  if (!item || !data) { box.textContent = "Select a row to see detail."; return; }
  const title = document.createElement("h2");
  title.textContent = item.owner + "/" + item.repo + "#" + item.number + " · " + shortStatus(item);
  box.appendChild(title);
  const msg = document.createElement("div");
  msg.className = "sub";
  msg.textContent = headlineOf(item);
  box.appendChild(msg);
  const sub = document.createElement("div");
  sub.className = "sub";
  let subText = item.owner + "/" + item.repo + "#" + item.number + " · " + item.kind + " · " + forgeOf(item, data) + " · " + item.reason;
  if (item.commit) subText += " · " + item.commit;
  else if (item.headSha) subText += " · " + item.headSha;
  if (typeof item.decidedAt === "number") subText += " · decided " + new Date(item.decidedAt).toLocaleString();
  if (typeof item.createdAt === "number") subText += " · enqueued " + new Date(item.createdAt).toLocaleString();
  if (item.failingVerdict === true) subText += " · failing verdict";
  sub.textContent = subText;
  box.appendChild(sub);
  const href = forgeHref(item, data);
  if (href) {
    const link = document.createElement("a");
    link.className = "forge-link";
    link.href = href;
    link.rel = "noopener";
    link.textContent = "Open in forge";
    box.appendChild(link);
  }
  box.appendChild(confirmBlock(item, data, "insp"));
}
function openConfirm(item) {
  if (state.stale) { render(); return; }
  if (!narrow()) { render(); const btn = $("inspector").querySelector("button.primary, button.secondary"); if (btn) btn.focus(); return; }
  const wrap = $("sheet-wrap");
  const sheet = $("sheet");
  sheet.textContent = "";
  const data = state.data;
  const title = document.createElement("h2");
  title.textContent = item.owner + "/" + item.repo + "#" + item.number + " · " + shortStatus(item);
  sheet.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = item.owner + "/" + item.repo + "#" + item.number + " · " + forgeOf(item, data);
  sheet.appendChild(sub);
  const msg = document.createElement("div");
  msg.className = "sub";
  msg.textContent = headlineOf(item);
  sheet.appendChild(msg);
  sheet.appendChild(confirmBlock(item, data, "sheet"));
  wrap.hidden = false;
}
function closeConfirm() { $("sheet-wrap").hidden = true; }
$("forge-switch").addEventListener("change", (ev) => {
  state.forge = ev.target.value;
  ev.target.dataset.touched = "1";
  const item = selectedItem();
  if (item && forgeOf(item, state.data) !== state.forge) state.selected = null;
  closeConfirm();
  render();
});
$("refresh").addEventListener("click", load);
$("sheet-backdrop").addEventListener("click", closeConfirm);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeConfirm(); });
window.addEventListener("resize", () => { if (!narrow()) closeConfirm(); });
const DEVICE_LOGIN_STOP = ["signed-in", "expired", "denied", "error", "cancelled"];
function mountDeviceLogin(cfg) {
  const client = { status: null, pollTimer: 0, starting: false };
  function els() {
    return {
      section: $(cfg.id),
      role: $(cfg.id + "-role"),
      ordinal: $(cfg.id + "-ordinal"),
      check: $(cfg.id + "-check"),
      start: $(cfg.id + "-start"),
      cancel: $(cfg.id + "-cancel"),
      note: $(cfg.id + "-note"),
      result: $(cfg.id + "-result"),
      link: $(cfg.id + "-link"),
      code: $(cfg.id + "-code"),
      expiry: $(cfg.id + "-expiry"),
      state: $(cfg.id + "-state"),
    };
  }
  function ordinalOf() {
    if (cfg.fixedOrdinal) return { role: cfg.fixedRole || "control", ordinal: cfg.fixedOrdinal };
    const box = els();
    const role = box.role ? (box.role.value === "engine" ? "engine" : box.role.value === "control" ? "control" : "worker") : "worker";
    const ordinal = box.ordinal ? box.ordinal.value.trim() : "";
    return { role, ordinal };
  }
  function note(text) {
    const box = els();
    if (!box.note) return;
    box.note.textContent = text;
  }
  function renderStatus(status) {
    const box = els();
    client.status = status || null;
    if (!box.result) return;
    if (!status || status.available === false) {
      box.result.hidden = true;
      return;
    }
    const hasRunner = status[cfg.runnerField] === true;
    if (box.start) box.start.style.display = hasRunner ? "" : "none";
    if (!hasRunner) {
      note(cfg.unavailableNote);
      box.result.hidden = true;
      return;
    }
    if (status.leased === true) {
      note("That ordinal holds a leased job; sign-in is refused until the job finishes.");
    } else if (status[cfg.authField] === true) {
      note(cfg.authPresentNote);
    } else if (status.state === "idle" || status.state === "cancelled") {
      note("");
    }
    if (!status.url || !status.userCode) {
      box.result.hidden = true;
      if (box.state) {
        box.state.textContent = "State: " + (status.state || "idle");
        box.result.hidden = false;
        if (box.link) box.link.style.display = "none";
        if (box.code) box.code.style.display = "none";
        if (box.expiry) box.expiry.textContent = "";
      }
      return;
    }
    box.result.hidden = false;
    if (box.link) {
      box.link.style.display = "";
      box.link.href = status.url;
      box.link.textContent = "Open provider page";
    }
    if (box.code) {
      box.code.style.display = "";
      box.code.textContent = status.userCode;
    }
    if (box.expiry) {
      box.expiry.textContent = typeof status.expiresAt === "number"
        ? "Code expires " + new Date(status.expiresAt).toLocaleTimeString()
        : "";
    }
    if (box.state) box.state.textContent = "State: " + (status.state || "waiting");
  }
  function statusUrl(role, ordinal) {
    let url = "/api/board/device-login/status?ordinal=" + encodeURIComponent(ordinal) + "&role=" + encodeURIComponent(role);
    if (cfg.provider) url += "&provider=" + encodeURIComponent(cfg.provider);
    return url;
  }
  function writeBody(role, ordinal) {
    const body = { ordinal: ordinal, role: role };
    if (cfg.provider) body.provider = cfg.provider;
    return body;
  }
  async function fetchStatus(showErrors) {
    const picked = ordinalOf();
    if (!picked.ordinal) {
      if (showErrors) note("Enter the ordinal host (for example jumi-worker-0).");
      return null;
    }
    try {
      const res = await fetch(statusUrl(picked.role, picked.ordinal), { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
      if (res.status === 401) {
        if (showErrors) note("Sign in via the edge proxy, then check again.");
        return null;
      }
      if (!res.ok) {
        if (showErrors) note("Ordinal unavailable (" + res.status + "). The router reaches it once the chart change lands.");
        renderStatus({ available: false });
        return null;
      }
      const status = await res.json();
      renderStatus(status);
      if (status && DEVICE_LOGIN_STOP.includes(status.state)) stopPoll();
      return status;
    } catch (err) {
      if (showErrors) note("Ordinal unavailable. The router reaches it once the chart change lands.");
      renderStatus({ available: false });
      return null;
    }
  }
  function stopPoll() {
    if (client.pollTimer) {
      clearInterval(client.pollTimer);
      client.pollTimer = 0;
    }
  }
  function startPoll() {
    stopPoll();
    client.pollTimer = setInterval(() => { fetchStatus(false); }, 5000);
  }
  function startedStatus(role, ordinal, status) {
    const next = {
      ordinal: ordinal,
      role: role,
      leased: false,
      available: true,
      state: status.state || "waiting",
      url: status.url,
      userCode: status.userCode,
      expiresAt: status.expiresAt,
    };
    next[cfg.runnerField] = true;
    next[cfg.authField] = false;
    return next;
  }
  function openConfirm(role, ordinal) {
    const wrap = $("sheet-wrap");
    const sheet = $("sheet");
    if (!wrap || !sheet) return;
    sheet.textContent = "";
    const title = document.createElement("h2");
    title.textContent = cfg.confirmPrompt + ordinal + "?";
    sheet.appendChild(title);
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = role === "control" ? "control role" : role + " ordinal " + ordinal;
    sheet.appendChild(sub);
    const consequence = document.createElement("p");
    consequence.className = "consequence";
    consequence.textContent = cfg.confirmEffect;
    sheet.appendChild(consequence);
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "primary";
    primary.textContent = cfg.confirmPrompt + ordinal;
    const msg = document.createElement("div");
    msg.className = "sub";
    primary.addEventListener("click", async () => {
      if (client.starting) return;
      client.starting = true;
      primary.disabled = true;
      msg.textContent = "Working…";
      try {
        const res = await fetch("/api/board/device-login/start", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(writeBody(role, ordinal))
        });
        if (res.ok) {
          const status = await res.json();
          closeConfirm();
          renderStatus(startedStatus(role, ordinal, status));
          startPoll();
        } else if (res.status === 409) {
          msg.textContent = "That ordinal holds a leased job; sign-in is refused until the job finishes.";
        } else if (res.status === 422) {
          msg.textContent = cfg.unavailableNote;
        } else if (res.status === 401) {
          msg.textContent = "Sign in via the edge proxy, then try again.";
        } else if (res.status === 403) {
          msg.textContent = "Forbidden origin.";
        } else {
          msg.textContent = "Sign-in did not start (" + res.status + ").";
        }
      } catch (err) {
        msg.textContent = "Sign-in did not start.";
      } finally {
        client.starting = false;
        primary.disabled = false;
      }
    });
    sheet.appendChild(primary);
    sheet.appendChild(document.createTextNode(" "));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "secondary";
    close.textContent = "Close";
    close.addEventListener("click", closeConfirm);
    sheet.appendChild(close);
    sheet.appendChild(msg);
    wrap.hidden = false;
  }
  function updateVisibility() {
    const box = els();
    if (!box.section) return;
    const data = state.data;
    const forge = (data && data.forge) || state.forge || "gitea";
    const isGithub = forge === "github" || state.forge === "github";
    box.section.style.display = isGithub ? "none" : "";
  }
  const box = els();
  if (!box.start) return;
  if (box.role) box.role.addEventListener("change", () => { fetchStatus(false); });
  if (box.check) box.check.addEventListener("click", () => { fetchStatus(true); });
  if (box.cancel) box.cancel.addEventListener("click", async () => {
    const picked = ordinalOf();
    if (!picked.ordinal) {
      note("Enter the ordinal host first.");
      return;
    }
    try {
      const res = await fetch("/api/board/device-login/cancel", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(writeBody(picked.role, picked.ordinal))
      });
      if (res.ok) {
        stopPoll();
        note("Sign-in cancelled.");
        fetchStatus(false);
      } else {
        note("Cancel did not land (" + res.status + ").");
      }
    } catch (err) {
      note("Cancel did not land.");
    }
  });
  box.start.addEventListener("click", () => {
    const picked = ordinalOf();
    if (!picked.ordinal) {
      note("Enter the ordinal host (for example jumi-worker-0).");
      return;
    }
    openConfirm(picked.role, picked.ordinal);
  });
  const switchEl = $("forge-switch");
  if (switchEl) switchEl.addEventListener("change", updateVisibility);
  const previousRender = render;
  render = function () { previousRender(); updateVisibility(); };
  updateVisibility();
}
mountDeviceLogin({
  id: "grok",
  runnerField: "hasXaiRunner",
  authField: "authPresent",
  unavailableNote: "Grok sign-in is unavailable on this ordinal (no OpenCode xAI runner in its chain).",
  authPresentNote: "That ordinal already holds an xAI oauth entry (presence is not a healthy grant).",
  confirmPrompt: "Start Grok sign-in on ",
  confirmEffect: "This will: run a Grok device login on that pod and write that pod's Grok auth file.",
});
mountDeviceLogin({
  id: "codex",
  provider: "codex",
  fixedOrdinal: "control",
  fixedRole: "control",
  runnerField: "hasCodexRunner",
  authField: "codexAuthPresent",
  unavailableNote: "Codex sign-in is unavailable on control (the control role owns the Codex login).",
  authPresentNote: "Control already holds a Codex ChatGPT credential (presence is not a healthy grant).",
  confirmPrompt: "Start Codex sign-in on ",
  confirmEffect: "This will: run a Codex device login on control and write control's retained Codex auth file.",
});
setInterval(load, 15000);
load();
${BOARD_BULK_SCRIPT}
</script>
</body>
</html>`;
}

export function createBoardFetchHandler(deps: BoardHandlerDeps) {
  const logger = deps.logger ?? ((message: string) => console.log(`[board] ${message}`));
  const getGrant = deps.getGrantNotice ?? latchedXaiGrantNotice;
  const localForge = (deps.forge ?? "gitea").trim() || "gitea";
  const forgeUrl = deps.forgeUrl ?? "";
  const peerUrl = (deps.peerUrl ?? "").trim();
  const peerToken = (deps.peerToken ?? "").trim();
  const fetchFn = deps.fetchFn ?? fetch;
  const peerTimeoutMs = deps.peerTimeoutMs ?? PEER_BOARD_TIMEOUT_MS;
  // One-way hop: only the homelab board fans out. The peer (github factory)
  // never calls back, so the other factory still cannot reach the homelab forge.
  const shouldFetchPeer = isHomelabForge(localForge) && peerUrl !== "" && peerToken !== "";
  const homelab = isHomelabForge(localForge);
  // MCP kick arming (static per process): the kick bearer arms `kick` only
  // when set and distinct from both the read bearer and the peer bearer. A
  // clash disarms the tool and logs one startup line saying why (never the
  // token itself).
  const mcpTokenStatic = (deps.mcpToken ?? "").trim();
  const mcpKickTokenStatic = (deps.mcpKickToken ?? "").trim();
  let mcpKickArmed = false;
  if (mcpKickTokenStatic !== "") {
    if (mcpTokenStatic !== "" && mcpKickTokenStatic === mcpTokenStatic) {
      logger("board mcp kick disabled: kick token equals the read token");
    } else if (peerToken !== "" && mcpKickTokenStatic === peerToken) {
      logger("board mcp kick disabled: kick token equals the peer token");
    } else if (mcpTokenStatic !== "") {
      mcpKickArmed = true;
    }
  }
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    const pathname = normalizePathname(url.pathname);
    // Board MCP for operator agents. Bearer only, same on both forges:
    // unset or empty read token disables the endpoint (404, nothing else
    // changes); missing or wrong bearer is 401. The read bearer lists the
    // three read tools; the kick bearer additionally arms `kick`. A kick
    // bearer equal to the read or peer bearer never arms the tool. Never
    // reads edge identity headers, and the peer token never authenticates
    // here. Other methods are 405.
    if (pathname === BOARD_MCP_PATH) {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      const mcpToken = (deps.mcpToken ?? "").trim();
      if (mcpToken === "") return json(404, { error: "not found" });
      const mcpKickToken = (deps.mcpKickToken ?? "").trim();
      const kickBearer = mcpKickArmed && mcpKickToken !== "" && hasBearerAuth(request, mcpKickToken);
      const readBearer = hasBearerAuth(request, mcpToken);
      if (!kickBearer && !readBearer) return json(401, { error: "missing bearer" });
      const canKick = kickBearer;
      return handleBoardMcp(request, {
        store: deps.store,
        forge: localForge,
        secrets: deps.mcpSecrets ?? [],
        logger,
        canKick,
        runKick: async (body: unknown, idempotencyKey: string) => {
          // Inner kick logs echo the refusal `why`, which can carry a
          // planted secret from the ledger: redact them with the same MCP
          // secrets before they reach the server log.
          const mcpSecrets = deps.mcpSecrets ?? [];
          const mcpLogger = (message: string) => logger(redactGitSecrets(message, mcpSecrets));
          return handleMcpKick(body, idempotencyKey, deps.store, mcpLogger, deps.forgeApi, localForge, deps.home);
        },
      });
    }
    // Same-commit requeue kick plus sit-clear kick, both forge-gated.
    // Homelab requires the edge identity (and logs the username attached after
    // that check); the peer trusts only the bearer and never reads forwarded
    // identity headers. The client never invents kick ids for sits; identity
    // is owner/repo/number and the server re-checks kickability.
    // /board/kick is an alias for the requeue path.
    if (pathname === BOARD_KICK_PATH || isKickPath(pathname)) {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      if (!homelab) {
        if (!hasBearerAuth(request, peerToken)) return json(401, { error: "missing bearer" });
        return handleKick(request, deps.store, logger, deps.forgeApi, { peer: true });
      }
      const kickActor = boardUsername(request);
      if (!kickActor) return json(401, { error: "missing edge identity" });
      return handleKick(request, deps.store, logger, deps.forgeApi, {
        actor: kickActor,
        peerUrl,
        peerToken,
        fetchFn,
        peerTimeoutMs,
        home: deps.home,
      });
    }
    if (pathname === BOARD_BULK_PATH) {
      const originAllowed = isAllowedBoardOrigin(request);
      const bulkKey = idempotencyKeyOf(request);
      if (!homelab) {
        if (!hasBearerAuth(request, peerToken)) return json(401, { error: "missing bearer" });
        return handleBulkHttpRequest(request, {
          store: deps.store,
          forgeApi: deps.forgeApi,
          actor: "",
          localForge,
          peerUrl: "",
          peerToken: "",
          fetchFn,
          logger,
          isOriginAllowed: originAllowed,
          headerKey: bulkKey,
        });
      }
      const bulkActor = boardUsername(request);
      if (!bulkActor) return json(401, { error: "missing edge identity" });
      return handleBulkHttpRequest(request, {
        store: deps.store,
        forgeApi: deps.forgeApi,
        actor: bulkActor,
        localForge,
        peerUrl,
        peerToken,
        fetchFn,
        peerTimeoutMs,
        logger,
        isOriginAllowed: originAllowed,
        headerKey: bulkKey,
      });
    }
    // Device login for one homelab ordinal (Grok and Codex). Not a kick:
    // distinct paths, fixed per-provider invocation, confirm names the
    // ordinal and the provider. The peer (isolated GitHub factory) has no
    // control: its Grok hop is skip-if-unauthed and it has no Codex control.
    if (
      pathname === DEVICE_LOGIN_BOARD_STATUS_PATH ||
      pathname === DEVICE_LOGIN_BOARD_START_PATH ||
      pathname === DEVICE_LOGIN_BOARD_CANCEL_PATH
    ) {
      if (!homelab) return json(404, { error: "not found" });
      if (pathname === DEVICE_LOGIN_BOARD_STATUS_PATH) {
        if (request.method !== "GET") return json(405, { error: "method not allowed" });
        return handleDeviceLoginStatus(request, { fetchFn, logger });
      }
      if (pathname === DEVICE_LOGIN_BOARD_START_PATH) {
        if (request.method !== "POST") return json(405, { error: "method not allowed" });
        return handleDeviceLoginStart(request, { fetchFn, logger });
      }
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      return handleDeviceLoginCancel(request, { fetchFn, logger });
    }
    if (pathname === BOARD_API_PATH) {
      if (request.method !== "GET") return json(405, { error: "method not allowed" });
      // Auth path is gated on the forge. The peer listener is bearer-only and
      // never reads edge headers; homelab requires edge identity and never
      // accepts the bearer (the outgoing hop credential is not an incoming one).
      if (!homelab) {
        if (!hasBearerAuth(request, peerToken)) return json(401, { error: "missing bearer" });
        let groups: BoardGroups;
        try {
          groups = withForgeGroups(await buildBoardGroups(deps.store, localForge), localForge);
        } catch (err) {
          logger(`board unavailable: ${errorMessage(err)}`);
          return json(503, { error: "queue unavailable" });
        }
        const grant = getGrant();
        const grantLine = typeof grant === "string" && grant.trim() !== "" ? grant.split("\n")[0]?.trim() : undefined;
        const body: Record<string, unknown> = {
          in_progress: groups.in_progress,
          inProgress: [...groups.in_progress],
          needs_kick: groups.needs_kick,
          needsKick: [...groups.needs_kick],
          ...(groups.needs_kick_overflow
            ? { needs_kick_overflow: groups.needs_kick_overflow, needsKickOverflow: groups.needs_kick_overflow }
            : {}),
          ...(groups.in_progress_overflow
            ? { in_progress_overflow: groups.in_progress_overflow, inProgressOverflow: groups.in_progress_overflow }
            : {}),
          sitting: groups.sitting,
          sitting_on_purpose: [...groups.sitting],
          forge: localForge,
          forgeUrl,
          catalog: BOARD_KICK_CATALOG_VERSION,
          peers: {},
        };
        if (grantLine) body.grant = grantLine;
        return json(200, body);
      }
      // Browser path: the homelab edge checks the person. The webhook HMAC
      // secret and auth token are not accepted here.
      const username = boardUsername(request);
      if (!username) return json(401, { error: "missing edge identity" });
      let groups: BoardGroups;
      try {
        groups = withForgeGroups(await buildBoardGroups(deps.store, localForge), localForge);
      } catch (err) {
        logger(`board unavailable: ${errorMessage(err)}`);
        return json(503, { error: "queue unavailable" });
      }
      const grant = getGrant();
      const grantLine = typeof grant === "string" && grant.trim() !== "" ? grant.split("\n")[0]?.trim() : undefined;
      // Top-level lists stay local-only: the homelab side does not list the
      // other factory's rows there. Peer rows live under `peers`.
      const body: Record<string, unknown> = {
        in_progress: groups.in_progress,
        inProgress: [...groups.in_progress],
        needs_kick: groups.needs_kick,
        needsKick: [...groups.needs_kick],
        ...(groups.needs_kick_overflow
          ? { needs_kick_overflow: groups.needs_kick_overflow, needsKickOverflow: groups.needs_kick_overflow }
          : {}),
        ...(groups.in_progress_overflow
          ? { in_progress_overflow: groups.in_progress_overflow, inProgressOverflow: groups.in_progress_overflow }
          : {}),
        sitting: groups.sitting,
        sitting_on_purpose: [...groups.sitting],
        forge: localForge,
        forgeUrl,
        catalog: BOARD_KICK_CATALOG_VERSION,
        peers: {} as Record<string, BoardPeerStatus>,
      };
      if (grantLine) body.grant = grantLine;
      if (!shouldFetchPeer) {
        (body.peers as Record<string, BoardPeerStatus>)[PEER_FORGE] = peerUnavailable();
        return json(200, body);
      }
      try {
        const peer = await fetchPeerBoard(peerUrl, peerToken, fetchFn, peerTimeoutMs);
        // Key by the constant, not the peer-supplied forge string, so a
        // misconfigured or compromised peer cannot collide with the local namespace.
        peer.forge = PEER_FORGE;
        (body.peers as Record<string, BoardPeerStatus>)[PEER_FORGE] = peer;
      } catch (err) {
        // No invented token, no crash: an unset or unreachable peer is unavailable.
        logger(`peer board unavailable: ${errorMessage(err)}`);
        (body.peers as Record<string, BoardPeerStatus>)[PEER_FORGE] = peerUnavailable();
      }
      return json(200, body);
    }
    if (BOARD_PAGE_PATHS.has(pathname)) {
      if (request.method !== "GET") return json(405, { error: "method not allowed" });
      if (!homelab) {
        // The peer has no browser page; keep the bearer JSON shape so a
        // peerUrl pointing at /board still serves the hop. Edge headers
        // alone never authenticate the peer.
        if (!hasBearerAuth(request, peerToken)) return json(401, { error: "missing bearer" });
        let groups: BoardGroups;
        try {
          groups = withForgeGroups(await buildBoardGroups(deps.store, localForge), localForge);
        } catch (err) {
          logger(`board unavailable: ${errorMessage(err)}`);
          return json(503, { error: "queue unavailable" });
        }
        return json(200, {
          forge: localForge,
          forgeUrl,
          catalog: BOARD_KICK_CATALOG_VERSION,
          in_progress: groups.in_progress,
          inProgress: [...groups.in_progress],
          needs_kick: groups.needs_kick,
          needsKick: [...groups.needs_kick],
          ...(groups.needs_kick_overflow
            ? { needs_kick_overflow: groups.needs_kick_overflow, needsKickOverflow: groups.needs_kick_overflow }
            : {}),
          ...(groups.in_progress_overflow
            ? { in_progress_overflow: groups.in_progress_overflow, inProgressOverflow: groups.in_progress_overflow }
            : {}),
          sitting: groups.sitting,
          sitting_on_purpose: [...groups.sitting],
          peers: {},
        });
      }
      if (!hasEdgeIdentity(request)) return json(401, { error: "missing edge identity" });
      return pageResponse(renderBoardPage(BOARD_KICK_CATALOG_VERSION));
    }
    return json(404, { error: "not found" });
  };
}

async function handleKick(
  request: Request,
  store: ReviewJobStore,
  logger: (message: string) => void,
  forgeApi?: BoardPullForge,
  opts?: {
    actor?: string;
    peer?: boolean;
    peerUrl?: string;
    peerToken?: string;
    fetchFn?: BoardFetchFn;
    peerTimeoutMs?: number;
    home?: string;
  }
): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method not allowed" });
  // Forge-gated auth happens at the call site. Homelab passes the username
  // attached after the edge check (the actor kick logging must record); the
  // peer passes peer:true after the bearer check and never reads forwarded
  // identity headers. The actor never comes from a body field.
  const isPeer = opts?.peer === true;
  let actor: string;
  if (isPeer) {
    actor = "";
  } else if (opts?.actor) {
    actor = opts.actor;
  } else {
    actor = edgeActor(request);
  }
  if (!isPeer && !actor) return json(401, { error: "missing edge identity" });
  // Same-origin JSON only: the kick is state-changing behind edge-proxy
  // cookie auth, so a simple-request CSRF (e.g. cross-origin text/plain
  // form) must not fire it. Compares against the public origin behind the
  // ingress (forwarded proto/host), not the internal cleartext hop URL.
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return json(400, { error: "invalid kick payload" });
  if (!isAllowedBoardOrigin(request)) return json(403, { error: "forbidden" });
  let body: unknown;
  try {
    const text = await request.text();
    body = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const headerKey = idempotencyKeyOf(request);
  // Peer-forge forwarding (homelab only, one-way). A peer row the peer marks
  // kickable is applied to the peer store, never the homelab store. Forge is
  // pinned server-side: only an exact PEER_FORGE value forwards, and the hop
  // URL is derived from the server-configured peerUrl plus a fixed path.
  const peer =
    !isPeer && isPeerForgeKick(body)
      ? {
          peerUrl: opts?.peerUrl ?? "",
          peerToken: opts?.peerToken ?? "",
          fetchFn: opts?.fetchFn ?? fetch,
          peerTimeoutMs: opts?.peerTimeoutMs ?? PEER_KICK_TIMEOUT_MS,
        }
      : undefined;
  return handleKickBody(body, headerKey, store, logger, forgeApi, actor, peer, isPeer ? undefined : actor, opts?.home);
}

/**
 * Body-level kick shared by the HTTP route and the MCP `kick` tool. The
 * `Request`-level checks (edge identity, content-type, Origin) live in
 * `handleKick`; the MCP path replaces them with its bearer check and calls
 * this directly. No kick logic is duplicated: sit-clear, requeue, reopen,
 * implement and stuck run the same handlers with the same validation,
 * refusals, kick-log entries and idempotency replay.
 */
async function handleKickBody(
  body: unknown,
  headerIdempotencyKey: string,
  store: ReviewJobStore,
  logger: (message: string) => void,
  forgeApi: BoardPullForge | undefined,
  actor: string,
  peer?: { peerUrl: string; peerToken: string; fetchFn: BoardFetchFn; peerTimeoutMs: number },
  sitActor?: string,
  home?: string
): Promise<Response> {
  if (peer && isPeerForgeKick(body)) {
    return handleForwardedKick(headerIdempotencyKey, body, store, logger, {
      actor,
      peerUrl: peer.peerUrl,
      peerToken: peer.peerToken,
      fetchFn: peer.fetchFn,
      peerTimeoutMs: peer.peerTimeoutMs,
    });
  }
  // Sit-clear kick (default branch): an owner/repo/number-only payload clears
  // a kickable sit. Requeue payloads carry a commit and kick id and fall
  // through to requeueKick below. The reopen kick carries kick=reopen and
  // never inserts a job: close-then-reopen wakes via the reopen webhook.
  // The implement kick carries kick=implement and requeues a no-changes
  // implement without opening a pull request.
  if (isSitClearPayload(body)) {
    return handleSitClearBody(body, store, logger, sitActor);
  }
  if (isReopenKickId(rawKickIdOf(body))) {
    return handleReopenKickBody(body, headerIdempotencyKey, store, logger, forgeApi, actor);
  }
  if (isImplementKickId(rawKickIdOf(body))) {
    return handleImplementKickBody(body, headerIdempotencyKey, store, logger, forgeApi, actor);
  }
  if (isStuckKickId(rawKickIdOf(body))) {
    return handleStuckKickBody(body, headerIdempotencyKey, store, logger, actor);
  }
  const parsed = parseKickBody(body, headerIdempotencyKey);
  if ("error" in parsed) return json(400, { error: parsed.error });
  const delivery = `board-kick:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;
  const forgeSnapshot = await fetchRequeueForgeSnapshot(forgeApi, parsed, logger, actor);
  if (forgeSnapshot === "unavailable") return json(503, { error: "forge unavailable" });
  try {
    const outcome = await store.requeueKick({
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.number,
      headSha: parsed.commit,
      kick: parsed.kick,
      actor,
      idempotencyKey: parsed.idempotencyKey,
      delivery,
      ...(forgeSnapshot ? { forge: forgeSnapshot } : {}),
    });
    if (outcome.status === "ok") {
      const cleared = outcome.clearedReviewStuck ?? null;
      // File fallback: without a ledger the review stuck state lives in the
      // HOME file, not the skip-latch row the store just cleared. Best-effort:
      // the latch row is already cleared and the job queued, so a file failure
      // never rolls back the kick.
      if (cleared && home && !process.env.DATABASE_URL?.trim()) {
        try {
          await cancelReviewWork({
            home,
            owner: parsed.owner,
            repo: parsed.repo,
            prNumber: parsed.number,
            ...(store.skipLatches ? { skipLatches: store.skipLatches } : {}),
          });
        } catch (err) {
          logger(
            `kick cleared file failed actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number}: ${errorMessage(err)}`
          );
        }
      }
      logger(
        `kick ok actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} @ ${parsed.commit} kick=${JSON.stringify(parsed.kick)} job=${outcome.job.id} terminal=${outcome.terminalId}${outcome.deduped ? " deduped" : ""}${cleared ? ` cleared review stuck latch ${JSON.stringify(cleared)}` : ""}`
      );
      return json(200, {
        ok: true,
        jobId: outcome.job.id,
        newJobId: outcome.job.id,
        key: outcome.job.jobKey,
        terminalJobId: outcome.terminalId,
        deduped: outcome.deduped,
        ...(cleared ? { clearedReviewStuck: cleared } : {}),
      });
    }
    logger(
      `kick ${outcome.code} actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} @ ${parsed.commit} kick=${JSON.stringify(parsed.kick)}: ${outcome.why}`
    );
    const status =
      outcome.code === "not-found"
        ? 404
        : outcome.code === "stale-kick" || outcome.code === "conflict"
          ? 409
          : outcome.code === "not-kickable"
            ? 422
            : 400;
    return json(status, {
      error: outcome.why,
      code: outcome.code,
      terminalJobId: outcome.terminalId,
      newJobId: outcome.newJobId,
      ...(outcome.deduped ? { deduped: true } : {}),
    });
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`kick unavailable: ${errorMessage(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    logger(`kick failed: ${errorMessage(err)}`);
    return json(503, { error: "queue unavailable" });
  }
}

/**
 * MCP `kick` entry point. Same body-level kick as the HTTP route (same
 * validation, refusals, kick-log entries and idempotency replay) with the
 * actor fixed to `board-mcp`. Local factory only: a `forge` argument naming
 * any other factory (including the peer forge) is a tool-level refusal, and
 * nothing is ever forwarded over the peer hop.
 */
async function handleMcpKick(
  body: unknown,
  headerIdempotencyKey: string,
  store: ReviewJobStore,
  logger: (message: string) => void,
  forgeApi: BoardPullForge | undefined,
  localForge: string,
  home?: string
): Promise<Response> {
  const forgeField = peerForgeFieldOf(body);
  if (forgeField !== "" && forgeField !== localForge) {
    const rec = body as Record<string, unknown>;
    const owner = typeof rec.owner === "string" ? rec.owner.trim() : "";
    const repo = typeof rec.repo === "string" ? rec.repo.trim() : "";
    const coords = owner && repo ? `${owner}/${repo}` : "-/-";
    logger(
      `board mcp kick refused actor=${BOARD_MCP_KICK_ACTOR} forge=${forgeField} ${coords}: peer forge kicks are not supported over MCP`
    );
    return json(400, {
      error: "peer forge kicks are not supported over MCP: configure one MCP server per factory",
      code: "bad-request",
      terminalJobId: null,
      newJobId: null,
    });
  }
  return handleKickBody(
    body,
    headerIdempotencyKey,
    store,
    logger,
    forgeApi,
    BOARD_MCP_KICK_ACTOR,
    undefined,
    BOARD_MCP_KICK_ACTOR,
    home
  );
}

/**
 * Forward a peer-forge kick to the peer board listener.
 *
 * Keeps every homelab check (edge identity and Origin already passed at the
 * call site), then idempotency on the homelab log, then the bearer hop. The
 * peer re-validates against its own store; its 409/422 come back verbatim.
 * Never touches the homelab sit/job stores: the only homelab write is the
 * kick-log record (actor, forge, coordinates, result). Transport failures
 * and peer auth failures are 503 with a clear error, never a fake success.
 */
async function handleForwardedKick(
  headerIdempotencyKey: string,
  body: unknown,
  store: ReviewJobStore,
  logger: (message: string) => void,
  opts: { actor: string; peerUrl: string; peerToken: string; fetchFn: BoardFetchFn; peerTimeoutMs: number }
): Promise<Response> {
  const { actor, peerUrl, peerToken, fetchFn, peerTimeoutMs } = opts;
  const headerKey = headerIdempotencyKey;
  const identity = extractForwardIdentity(body);
  if (!identity) return json(400, { error: "invalid kick payload" });
  const rec = body as Record<string, unknown>;
  const bodyKey = (
    strOrEmpty(rec.idempotencyKey) ||
    strOrEmpty(rec.idempotency_key) ||
    strOrEmpty(rec["idempotency-key"])
  ).trim();
  const idempotencyKey = (headerKey || bodyKey).trim();
  const coords = `${identity.owner}/${identity.repo}#${identity.number} @ ${identity.commit || "-"}`;
  const kickLabel = identity.kick || "sit-clear";

  // Homelab idempotency before the hop. Peer results are stored with a peer-
  // prefix so a local prior can never replay as a peer success (and a peer
  // prior can never replay as a local success on the peer path).
  if (idempotencyKey !== "") {
    let prior: Awaited<ReturnType<ReviewJobStore["getKickByIdempotencyKey"]>> | undefined;
    try {
      prior = await store.getKickByIdempotencyKey(idempotencyKey);
    } catch (err) {
      logger(`kick forward unavailable actor=${actor} forge=${PEER_FORGE} ${coords}: ${errorMessage(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    if (prior) {
      if (!prior.result.startsWith("peer-")) {
        return forwardedMismatchResponse(prior);
      }
      if (
        forwardedKickMismatch(identity, {
          owner: prior.owner,
          repo: prior.repo,
          number: prior.number,
          commit: prior.commit,
          kick: prior.kick,
        })
      ) {
        return forwardedMismatchResponse(prior);
      }
      logger(
        `kick forward replay actor=${actor} forge=${PEER_FORGE} ${coords} kick=${JSON.stringify(kickLabel)} result=${prior.result}`
      );
      return replayForwardedPrior(prior);
    }
  }

  const kickUrl = peerKickUrlOf(peerUrl);
  const token = peerToken.trim();
  if (!kickUrl || token === "") {
    logger(`kick forward unavailable actor=${actor} forge=${PEER_FORGE} ${coords}: peer unavailable`);
    return json(503, { error: "peer unavailable" });
  }

  const forwardBody = sanitizeForwardBody(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), peerTimeoutMs);
  let peerResponse: Response;
  try {
    peerResponse = await fetchFn(kickUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(idempotencyKey !== "" ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(forwardBody),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (err) {
    logger(
      `kick forward unavailable actor=${actor} forge=${PEER_FORGE} ${coords} kick=${JSON.stringify(kickLabel)}: ${errorMessage(err)}`
    );
    return json(503, { error: "peer unavailable" });
  } finally {
    clearTimeout(timer);
  }

  // Peer auth failures are homelab misconfig, not an operator auth problem:
  // surface as unavailable instead of a misleading edge sign-in message.
  if (peerResponse.status === 401 || peerResponse.status === 403) {
    logger(
      `kick forward unavailable actor=${actor} forge=${PEER_FORGE} ${coords}: peer rejected hop (${peerResponse.status})`
    );
    return json(503, { error: "peer unavailable" });
  }

  const { text, tooLarge } = await readCappedPeerKickBody(peerResponse).catch(() => ({
    text: "",
    tooLarge: true as const,
  }));
  if (tooLarge) {
    logger(`kick forward unavailable actor=${actor} forge=${PEER_FORGE} ${coords}: peer response too large`);
    return json(503, { error: "peer unavailable" });
  }
  let peerBody: unknown;
  try {
    peerBody = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  } catch {
    logger(`kick forward unavailable actor=${actor} forge=${PEER_FORGE} ${coords}: peer returned invalid JSON`);
    return json(503, { error: "peer unavailable" });
  }

  const status = peerResponse.status;
  const result = peerResultForStatus(status, peerBody);
  if (result !== undefined) {
    try {
      await store.recordReopenKick({
        owner: identity.owner,
        repo: identity.repo,
        number: identity.number,
        commit: identity.commit,
        kick: identity.kick || "sit-clear",
        actor,
        idempotencyKey,
        result,
      });
    } catch (err) {
      if (idempotencyKey !== "" && isUniqueViolation(err)) {
        let prior: Awaited<ReturnType<ReviewJobStore["getKickByIdempotencyKey"]>> | undefined;
        try {
          prior = await store.getKickByIdempotencyKey(idempotencyKey);
        } catch {
          return json(503, { error: "queue unavailable" });
        }
        if (!prior) return json(503, { error: "queue unavailable" });
        if (!prior.result.startsWith("peer-")) return forwardedMismatchResponse(prior);
        if (
          forwardedKickMismatch(identity, {
            owner: prior.owner,
            repo: prior.repo,
            number: prior.number,
            commit: prior.commit,
            kick: prior.kick,
          })
        ) {
          return forwardedMismatchResponse(prior);
        }
        return replayForwardedPrior(prior);
      }
      logger(`kick forward unavailable actor=${actor} forge=${PEER_FORGE} ${coords}: ${errorMessage(err)}`);
      return json(503, { error: "queue unavailable" });
    }
  }

  if (result === "peer-ok") {
    logger(`kick forward ok actor=${actor} forge=${PEER_FORGE} ${coords} kick=${JSON.stringify(kickLabel)}`);
  } else if (result !== undefined) {
    const detail =
      peerBody && typeof peerBody === "object" && !Array.isArray(peerBody)
        ? String((peerBody as Record<string, unknown>).error ?? result.replace(/^peer-/, ""))
        : result.replace(/^peer-/, "");
    logger(
      `kick forward ${result.replace(/^peer-/, "")} actor=${actor} forge=${PEER_FORGE} ${coords} kick=${JSON.stringify(kickLabel)}: ${detail}`
    );
  } else {
    logger(`kick forward pass-through actor=${actor} forge=${PEER_FORGE} ${coords} status=${status}`);
  }
  return json(status, peerBody);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function isNotFoundForgeError(err: unknown): boolean {
  return err instanceof Error && (/→ 404\b/.test(err.message) || /→ 410\b/.test(err.message));
}

/**
 * Reopen kick for a foreign or reuse pull.
 *
 * Same route and same edge-identity/idempotency rules as the requeue kick,
 * but a different kick id (`reopen`). It never inserts a job and never
 * pushes: a closed pull is closed-then-reopened so the existing reopen
 * webhook wake enqueues, and the board waits for that row. An already-open
 * pull is a no-op: an open pull is never closed to "refresh" it.
 */
async function handleReopenKickBody(
  body: unknown,
  headerIdempotencyKey: string,
  store: ReviewJobStore,
  logger: (message: string) => void,
  forgeApi: BoardPullForge | undefined,
  actor: string
): Promise<Response> {
  const parsed = parseReopenKickBody(body, headerIdempotencyKey);
  if ("error" in parsed) return json(400, { error: parsed.error });
  const item = { owner: parsed.owner, repo: parsed.repo, number: parsed.number, kick: parsed.kick };

  if (parsed.idempotencyKey) {
    let prior: Awaited<ReturnType<ReviewJobStore["getKickByIdempotencyKey"]>>;
    try {
      prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey);
    } catch (err) {
      logger(`reopen kick unavailable: ${errorMessage(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    if (prior) {
      if (reopenIdempotencyMismatch(item, prior)) {
        return json(400, {
          error: `Idempotency key was already used for ${prior.owner}/${prior.repo}#${prior.number} @ ${prior.commit} with a different kick; use a fresh key for a different item.`,
          code: "bad-request",
          terminalJobId: null,
          newJobId: null,
        });
      }
      return replayReopenPrior(prior, item);
    }
  }

  if (!forgeApi) {
    logger(`reopen kick unavailable actor=${actor} ${item.owner}/${item.repo}#${item.number}: no forge`);
    return json(503, { error: "forge unavailable" });
  }

  let pr: { state: string; merged: boolean; head?: { sha: string } };
  try {
    pr = await forgeApi.getPR(item.owner, item.repo, item.number);
  } catch (err) {
    if (isNotFoundForgeError(err)) {
      const logged = await recordReopenBestEffort(store, logger, parsed, actor, "", "not-found");
      if (logged === "conflict") {
        const prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey).catch(() => undefined);
        return reopenKeyConflictResponse(prior, item);
      }
      return json(404, {
        error: `No pull request for ${item.owner}/${item.repo}#${item.number}.`,
        code: "not-found",
        terminalJobId: null,
        newJobId: null,
      });
    }
    logger(
      `reopen kick forge unavailable actor=${actor} ${item.owner}/${item.repo}#${item.number}: ${errorMessage(err)}`
    );
    return json(503, { error: "forge unavailable" });
  }

  if (pr.merged) {
    const logged = await recordReopenBestEffort(store, logger, parsed, actor, pr.head?.sha ?? "", "not-kickable");
    if (logged === "conflict") {
      const prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey).catch(() => undefined);
      return reopenKeyConflictResponse(prior, item);
    }
    logger(`reopen kick not-kickable actor=${actor} ${item.owner}/${item.repo}#${item.number}: merged`);
    return json(422, {
      error: "No kick: pull request is merged; reopen would not wake.",
      code: "not-kickable",
      terminalJobId: null,
      newJobId: null,
    });
  }

  if (pr.state === "open") {
    try {
      const logged = await recordReopenLogged(store, parsed, actor, pr.head?.sha ?? "", "noop-open");
      if (logged === "conflict") {
        const prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey).catch(() => undefined);
        return reopenKeyConflictResponse(prior, item);
      }
    } catch (err) {
      logger(`reopen kick unavailable actor=${actor} ${item.owner}/${item.repo}#${item.number}: ${errorMessage(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    logger(`reopen kick noop-open actor=${actor} ${item.owner}/${item.repo}#${item.number}`);
    return json(200, {
      ok: true,
      owner: item.owner,
      repo: item.repo,
      number: item.number,
      reopened: false,
      noop: true,
      deduped: false,
    });
  }

  try {
    await forgeApi.closePullRequest(item.owner, item.repo, item.number);
    await forgeApi.reopenPullRequest(item.owner, item.repo, item.number);
  } catch (err) {
    if (isNotFoundForgeError(err)) {
      const logged = await recordReopenBestEffort(store, logger, parsed, actor, pr.head?.sha ?? "", "not-found");
      if (logged === "conflict") {
        const prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey).catch(() => undefined);
        return reopenKeyConflictResponse(prior, item);
      }
      return json(404, {
        error: `No pull request for ${item.owner}/${item.repo}#${item.number}.`,
        code: "not-found",
        terminalJobId: null,
        newJobId: null,
      });
    }
    logger(
      `reopen kick forge unavailable actor=${actor} ${item.owner}/${item.repo}#${item.number}: ${errorMessage(err)}`
    );
    return json(503, { error: "forge unavailable" });
  }

  try {
    const logged = await recordReopenLogged(store, parsed, actor, pr.head?.sha ?? "", "ok");
    if (logged === "conflict") {
      const prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey).catch(() => undefined);
      return reopenKeyConflictResponse(prior, item);
    }
  } catch (err) {
    logger(`reopen kick unavailable actor=${actor} ${item.owner}/${item.repo}#${item.number}: ${errorMessage(err)}`);
    return json(503, { error: "queue unavailable" });
  }
  logger(`reopen kick ok actor=${actor} ${item.owner}/${item.repo}#${item.number}`);
  return json(200, {
    ok: true,
    owner: item.owner,
    repo: item.repo,
    number: item.number,
    reopened: true,
    deduped: false,
  });
}

/**
 * Response for a lost idempotency race: the insert hit a unique violation
 * after the pre-check saw nothing. A same-item prior replays; a
 * different-item prior is the same 400 the pre-check returns; a failed
 * re-read is 503, never a success claim for an item with no ledger row.
 */
function reopenKeyConflictResponse(
  prior: KickLogRecord | undefined,
  item: { owner: string; repo: string; number: number; kick: string }
): Response {
  if (!prior) return json(503, { error: "queue unavailable" });
  if (reopenIdempotencyMismatch(item, prior)) {
    return json(400, {
      error: `Idempotency key was already used for ${prior.owner}/${prior.repo}#${prior.number} @ ${prior.commit} with a different kick; use a fresh key for a different item.`,
      code: "bad-request",
      terminalJobId: null,
      newJobId: null,
    });
  }
  return replayReopenPrior(prior, item);
}

function replayReopenPrior(
  prior: { owner: string; repo: string; number: number; commit: string; result: string },
  item: { owner: string; repo: string; number: number }
): Response {
  if (prior.result === "ok") {
    return json(200, {
      ok: true,
      owner: item.owner,
      repo: item.repo,
      number: item.number,
      reopened: true,
      deduped: true,
    });
  }
  if (prior.result === "noop-open") {
    return json(200, {
      ok: true,
      owner: item.owner,
      repo: item.repo,
      number: item.number,
      reopened: false,
      noop: true,
      deduped: true,
    });
  }
  if (prior.result === "not-found") {
    return json(404, {
      error: "already decided: not-found",
      code: "not-found",
      terminalJobId: null,
      newJobId: null,
      deduped: true,
    });
  }
  if (prior.result === "not-kickable") {
    return json(422, {
      error: "already decided: not-kickable",
      code: "not-kickable",
      terminalJobId: null,
      newJobId: null,
      deduped: true,
    });
  }
  if (prior.result === "stale-kick") {
    return json(409, {
      error: "already decided: stale-kick",
      code: "stale-kick",
      terminalJobId: null,
      newJobId: null,
      deduped: true,
    });
  }
  if (prior.result === "conflict") {
    return json(409, {
      error: "already decided: conflict",
      code: "conflict",
      terminalJobId: null,
      newJobId: null,
      deduped: true,
    });
  }
  return json(422, {
    error: `already decided: ${prior.result}`,
    code: "not-kickable",
    terminalJobId: null,
    newJobId: null,
    deduped: true,
  });
}

async function recordReopenLogged(
  store: ReviewJobStore,
  parsed: { owner: string; repo: string; number: number; kick: string; idempotencyKey: string },
  actor: string,
  commit: string,
  result: string
): Promise<"ok" | "conflict"> {
  try {
    await store.recordReopenKick({
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      commit,
      kick: parsed.kick,
      actor,
      idempotencyKey: parsed.idempotencyKey,
      result,
    });
    return "ok";
  } catch (err) {
    if (parsed.idempotencyKey && isUniqueViolation(err)) return "conflict";
    throw err;
  }
}

async function recordReopenBestEffort(
  store: ReviewJobStore,
  logger: (message: string) => void,
  parsed: { owner: string; repo: string; number: number; kick: string; idempotencyKey: string },
  actor: string,
  commit: string,
  result: string
): Promise<"ok" | "conflict"> {
  try {
    return await recordReopenLogged(store, parsed, actor, commit, result);
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`reopen kick unavailable: ${errorMessage(err)}`);
      return "ok";
    }
    throw err;
  }
}

/**
 * Implement kick for a no-changes terminal.
 *
 * Same route and same edge-identity/idempotency rules as the requeue kick,
 * but a different kick id (`implement`). It clears the latch and inserts
 * the implement job in one transaction, then updates the forge label so the
 * forge matches. The label change alone is never the wake: a label
 * remove/re-add with the same body stays terminal, and the bot-applied
 * label after this kick never reaches the queue (Gitea `labeled` is not an
 * enqueue action; GitHub skips `sender is bot`). A human re-label still
 * dedupes against the queued row instead of inserting a second job. It
 * never opens a pull request; the worker owns PR creation.
 */
async function handleImplementKickBody(
  body: unknown,
  headerIdempotencyKey: string,
  store: ReviewJobStore,
  logger: (message: string) => void,
  forgeApi: BoardPullForge | undefined,
  actor: string
): Promise<Response> {
  const parsed = parseImplementKickBody(body, headerIdempotencyKey);
  if ("error" in parsed) return json(400, { error: parsed.error });
  const item = { owner: parsed.owner, repo: parsed.repo, issueNumber: parsed.number, kick: parsed.kick };

  if (parsed.idempotencyKey) {
    let prior: Awaited<ReturnType<ReviewJobStore["getKickByIdempotencyKey"]>>;
    try {
      prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey);
    } catch (err) {
      logger(`implement kick unavailable: ${errorMessage(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    if (prior) {
      if (implementIdempotencyMismatch(item, prior)) {
        return json(400, {
          error: `Idempotency key was already used for ${prior.owner}/${prior.repo}#${prior.number} @ ${prior.commit} with a different kick; use a fresh key for a different item.`,
          code: "bad-request",
          terminalJobId: null,
          newJobId: null,
        });
      }
      return await replayImplementPrior(store, prior, item);
    }
  }

  if (!forgeApi?.addIssueLabel) {
    logger(`implement kick unavailable actor=${actor} ${item.owner}/${item.repo}#${item.issueNumber}: no forge`);
    return json(503, { error: "forge unavailable" });
  }

  // A blocked implement re-checks live dependencies before queueing anything.
  // Peek the latest implement terminal: only a `blocked on ` row needs the
  // forge check. A no-changes row (and every other refusal) goes straight to
  // the store, exactly as today.
  let blockedTerminal: ReviewJobRecord | undefined;
  try {
    const rows = await store.listRowsForNumber(item.owner, item.repo, item.issueNumber, 50);
    const implTerminals = rows
      .filter((row) => row.kind === "implement" && (row.state === "succeeded" || row.state === "skipped"))
      .sort((a, b) => a.id - b.id);
    const latest = implTerminals.length > 0 ? implTerminals[implTerminals.length - 1] : undefined;
    if (latest && latest.state === "skipped" && isBlockedOnReason(latest.resultReason)) blockedTerminal = latest;
  } catch (err) {
    logger(`implement kick unavailable: ${errorMessage(err)}`);
    return json(503, { error: "queue unavailable" });
  }

  if (blockedTerminal) {
    const listDeps = forgeApi.listIssueDependencies;
    const listPulls = forgeApi.listOpenPulls;
    if (typeof listDeps !== "function" || typeof listPulls !== "function") {
      logger(`implement kick unavailable actor=${actor} ${item.owner}/${item.repo}#${item.issueNumber}: no forge`);
      return json(503, { error: "forge unavailable" });
    }
    let check: Awaited<ReturnType<typeof import("./dependencies.ts").checkIssueBlockers>>;
    try {
      const { checkIssueBlockers } = await import("./dependencies.ts");
      check = await checkIssueBlockers(
        {
          listIssueDependencies: (owner, repo, index) =>
            (listDeps as NonNullable<typeof listDeps>).call(forgeApi, owner, repo, index) as never,
          listOpenPulls: (owner, repo) =>
            (listPulls as NonNullable<typeof listPulls>).call(forgeApi, owner, repo) as never,
        },
        item.owner,
        item.repo,
        item.issueNumber
      );
    } catch (err) {
      logger(
        `implement kick forge unavailable actor=${actor} ${item.owner}/${item.repo}#${item.issueNumber}: ${errorMessage(err)}`
      );
      return json(503, { error: "forge unavailable" });
    }
    if (check.status === "stuck") {
      const logged = await recordImplementKickBestEffort(
        store,
        logger,
        parsed,
        actor,
        blockedTerminal.id,
        "not-kickable"
      );
      if (logged === "conflict") return await replayImplementKeyConflict(store, parsed, item);
      if (logged === "unavailable") return json(503, { error: "queue unavailable" });
      logger(
        `implement kick not-kickable actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} kick=${JSON.stringify(parsed.kick)}: ${check.reason}`
      );
      return json(422, {
        error: check.reason,
        code: "not-kickable",
        terminalJobId: blockedTerminal.id,
        newJobId: null,
      });
    }
    if (check.status === "blocked") {
      const { blockedOnComment } = await import("./dependencies.ts");
      const why = blockedOnComment(check.blockers, item.owner, item.repo);
      const logged = await recordImplementKickBestEffort(
        store,
        logger,
        parsed,
        actor,
        blockedTerminal.id,
        "still-blocked"
      );
      if (logged === "conflict") return await replayImplementKeyConflict(store, parsed, item);
      if (logged === "unavailable") return json(503, { error: "queue unavailable" });
      logger(
        `implement kick still-blocked actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} kick=${JSON.stringify(parsed.kick)}: ${why}`
      );
      return json(409, {
        error: why,
        code: "still-blocked",
        terminalJobId: blockedTerminal.id,
        newJobId: null,
      });
    }
    // Ready falls through to the store queue below, exactly as the no-changes retry.
  }

  const delivery = `board-kick:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;
  let outcome: Awaited<ReturnType<ReviewJobStore["implementKick"]>>;
  try {
    outcome = await store.implementKick({
      owner: parsed.owner,
      repo: parsed.repo,
      issueNumber: parsed.number,
      kick: parsed.kick,
      actor,
      idempotencyKey: parsed.idempotencyKey,
      delivery,
    });
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`implement kick unavailable: ${errorMessage(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    if (parsed.idempotencyKey && isUniqueViolation(err)) {
      let prior: KickLogRecord | undefined;
      try {
        prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey);
      } catch {
        return json(503, { error: "queue unavailable" });
      }
      if (!prior) return json(503, { error: "queue unavailable" });
      if (implementIdempotencyMismatch(item, prior)) {
        return json(400, {
          error: `Idempotency key was already used for ${prior.owner}/${prior.repo}#${prior.number} @ ${prior.commit} with a different kick; use a fresh key for a different item.`,
          code: "bad-request",
          terminalJobId: null,
          newJobId: null,
        });
      }
      return await replayImplementPrior(store, prior, item);
    }
    logger(`implement kick failed: ${errorMessage(err)}`);
    return json(503, { error: "queue unavailable" });
  }

  if (outcome.status === "ok") {
    // The latch clear + job insert already committed. Now make the forge
    // match by ensuring the pickup label is present. Best-effort: the job
    // is already queued, so a label failure is logged, never a rollback
    // and never a second pull request. The label is the repository's
    // `pickup_label` when the file names one (`jumi` otherwise); Gitea
    // ignores the key and keeps using assignment.
    try {
      let pickupLabel = "jumi";
      try {
        const getRepo = forgeApi.getRepo;
        const getRepoFile = forgeApi.getRepoFile;
        if (typeof getRepo === "function" && typeof getRepoFile === "function") {
          const { fallbackPolicyDeployment, resolveRepoPolicy } = await import("./repo_policy.ts");
          const info = await getRepo.call(forgeApi, item.owner, item.repo).catch(() => undefined);
          const defaultBranch =
            info && typeof info.default_branch === "string" && info.default_branch.trim()
              ? info.default_branch.trim()
              : "";
          if (defaultBranch) {
            const policy = await resolveRepoPolicy(
              { api: forgeApi, owner: item.owner, repo: item.repo, ref: defaultBranch },
              fallbackPolicyDeployment(),
              { onUnreadable: "fallback" }
            ).catch(() => undefined);
            pickupLabel = policy?.pickupLabel ?? "jumi";
          }
        }
      } catch {
        // Fall back to `jumi`.
      }
      await forgeApi.addIssueLabel(item.owner, item.repo, item.issueNumber, pickupLabel);
    } catch (err) {
      logger(
        `implement kick label failed actor=${actor} ${item.owner}/${item.repo}#${item.issueNumber}: ${errorMessage(err)}`
      );
    }
    logger(
      `implement kick ok actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} kick=${JSON.stringify(parsed.kick)} job=${outcome.job.id} terminal=${outcome.terminalId}${outcome.deduped ? " deduped" : ""}`
    );
    return json(200, {
      ok: true,
      jobId: outcome.job.id,
      newJobId: outcome.job.id,
      key: outcome.job.jobKey,
      terminalJobId: outcome.terminalId,
      deduped: outcome.deduped,
    });
  }

  logger(
    `implement kick ${outcome.code} actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} kick=${JSON.stringify(parsed.kick)}: ${outcome.why}`
  );
  const status =
    outcome.code === "not-found"
      ? 404
      : outcome.code === "stale-kick" || outcome.code === "conflict" || outcome.code === "still-blocked"
        ? 409
        : outcome.code === "not-kickable"
          ? 422
          : 400;
  return json(status, {
    error: outcome.why,
    code: outcome.code,
    terminalJobId: outcome.terminalId,
    newJobId: outcome.newJobId,
    ...(outcome.deduped ? { deduped: true } : {}),
  });
}

async function recordImplementKickBestEffort(
  store: ReviewJobStore,
  logger: (message: string) => void,
  parsed: { owner: string; repo: string; number: number; kick: string; idempotencyKey: string },
  actor: string,
  terminalJobId: number | null,
  result: string
): Promise<"ok" | "conflict" | "unavailable"> {
  try {
    await store.recordImplementKick({
      owner: parsed.owner,
      repo: parsed.repo,
      issueNumber: parsed.number,
      kick: parsed.kick,
      actor,
      idempotencyKey: parsed.idempotencyKey,
      result,
      terminalJobId,
      newJobId: null,
    });
    return "ok";
  } catch (err) {
    if (parsed.idempotencyKey && isUniqueViolation(err)) return "conflict";
    if (isQueueUnavailable(err)) {
      logger(`implement kick unavailable: ${errorMessage(err)}`);
      return "unavailable";
    }
    throw err;
  }
}

async function replayImplementKeyConflict(
  store: ReviewJobStore,
  parsed: { owner: string; repo: string; number: number; kick: string; idempotencyKey: string },
  item: { owner: string; repo: string; issueNumber: number; kick: string }
): Promise<Response> {
  let prior: KickLogRecord | undefined;
  try {
    prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey);
  } catch {
    return json(503, { error: "queue unavailable" });
  }
  if (!prior) return json(503, { error: "queue unavailable" });
  if (implementIdempotencyMismatch(item, prior)) {
    return json(400, {
      error: `Idempotency key was already used for ${prior.owner}/${prior.repo}#${prior.number} @ ${prior.commit} with a different kick; use a fresh key for a different item.`,
      code: "bad-request",
      terminalJobId: null,
      newJobId: null,
    });
  }
  return replayImplementPrior(store, prior, item);
}

async function replayImplementPrior(
  store: ReviewJobStore,
  prior: KickLogRecord,
  item: { owner: string; repo: string; issueNumber: number }
): Promise<Response> {
  void item;
  if (prior.result === "ok") {
    if (prior.newJobId != null) {
      try {
        const job = await store.get(prior.newJobId);
        if (job) {
          return json(200, {
            ok: true,
            jobId: prior.newJobId,
            newJobId: prior.newJobId,
            key: job.jobKey,
            terminalJobId: prior.terminalJobId,
            deduped: true,
          });
        }
      } catch {
        // Fall through to the key-less shape rather than failing a replay
        // for a ledger row that already committed.
      }
    }
    return json(200, {
      ok: true,
      jobId: prior.newJobId,
      newJobId: prior.newJobId,
      terminalJobId: prior.terminalJobId,
      deduped: true,
    });
  }
  if (prior.result === "not-found") {
    return json(404, {
      error: "already decided: not-found",
      code: "not-found",
      terminalJobId: prior.terminalJobId,
      newJobId: prior.newJobId,
      deduped: true,
    });
  }
  if (prior.result === "stale-kick" || prior.result === "conflict") {
    const code = prior.result === "conflict" ? "conflict" : "stale-kick";
    const status = 409;
    return json(status, {
      error: `already decided: ${prior.result}`,
      code,
      terminalJobId: prior.terminalJobId,
      newJobId: prior.newJobId,
      deduped: true,
    });
  }
  if (prior.result === "still-blocked") {
    return json(409, {
      error: "already decided: still-blocked",
      code: "still-blocked",
      terminalJobId: prior.terminalJobId,
      newJobId: prior.newJobId,
      deduped: true,
    });
  }
  return json(422, {
    error: `already decided: ${prior.result}`,
    code: "not-kickable",
    terminalJobId: prior.terminalJobId,
    newJobId: prior.newJobId,
    deduped: true,
  });
}

/** Owner/repo/number-only payloads are sit clears; commit/kick payloads requeue. */
function isSitClearPayload(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const rec = body as Record<string, unknown>;
  if (
    nonEmptyString(rec.commit) ||
    nonEmptyString(rec.headSha) ||
    nonEmptyString(rec.head_sha) ||
    nonEmptyString(rec.sha)
  ) {
    return false;
  }
  // The page always sends a kick id; "sit-clear" is the id for plain
  // sit clears. Anything else is a typed kick.
  for (const field of ["kick", "kickId", "kick_id", "id", "reason"] as const) {
    const value = rec[field];
    if (typeof value === "string" && value.trim() !== "" && value.trim() !== "sit-clear") return false;
  }
  return true;
}

async function handleSitClearBody(
  body: unknown,
  store: ReviewJobStore,
  logger: (message: string) => void,
  kickActor?: string
): Promise<Response> {
  const record = body as { owner?: unknown; repo?: unknown; number?: unknown };
  const owner = typeof record.owner === "string" ? record.owner.trim() : "";
  const repo = typeof record.repo === "string" ? record.repo.trim() : "";
  const number = typeof record.number === "number" ? record.number : Number.NaN;
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    return json(400, { error: "invalid kick payload" });
  }
  let sit: RouterSitRecord | undefined;
  try {
    sit = await store.sits.get(owner, repo, number);
  } catch (err) {
    logger(`board unavailable: ${errorMessage(err)}`);
    return json(503, { error: "queue unavailable" });
  }
  if (!sit) return json(404, { error: "sit not found" });
  // A stuck latch is never confirmed by an owner-only payload: the page
  // sends the stuck kick id so one click clears the latch and queues
  // follow-up (or conflict resolution) on the open closer in a single transaction.
  if (sit.reason === "implement-latch") {
    return json(400, { error: "missing kick" });
  }
  // A conflict left to the author stays left: report the waiting reason
  // instead of clearing the row and appearing to do nothing.
  if (sit.reason === "conflict-ignored") {
    if (kickActor) logger(`board kick ${owner}/${repo}#${number} ${sit.reason} by ${kickActor}`);
    else logger(`board kick ${owner}/${repo}#${number} ${sit.reason}`);
    return json(409, { error: sitMessage(sit.reason), code: "conflict-ignored" });
  }
  const kick = kickForSit(sit.reason);
  if (!kick) return json(409, { error: "no kick for this row" });
  try {
    await store.sits.clear(owner, repo, number);
  } catch (err) {
    logger(`board unavailable: ${errorMessage(err)}`);
    return json(503, { error: "queue unavailable" });
  }
  if (sit.reason === "push-unregistered") {
    try {
      await store.pushConfirm?.dismiss(owner, repo, number);
    } catch (err) {
      logger(`push confirm dismiss failed ${owner}/${repo}#${number}: ${errorMessage(err)}`);
    }
  }
  // The username attached after the edge check is what the kick log records.
  // The peer never forwards identity headers, so its kicks log without one.
  if (kickActor) logger(`board kick ${owner}/${repo}#${number} ${sit.reason} by ${kickActor}`);
  else logger(`board kick ${owner}/${repo}#${number} ${sit.reason}`);
  return json(200, { ok: true, owner, repo, number, effect: kick.effect });
}

/**
 * Stuck-latch kick for an open closer.
 *
 * Same route and same edge-identity/idempotency rules as the other kicks,
 * but a different kick id (`stuck`, aliases `follow-up`/`followup`/
 * `stuck-latch`). It clears the issue skip latch and inserts a worker job
 * for the open closer in one transaction; the sit row goes away
 * because that enqueue landed, never via a bare sit delete. A
 * conflict-capped latch (or a currently unmergeable pull) queues conflict
 * resolution; any other stuck latch queues follow-up. It never opens
 * a second pull, never unassigns, and never adds a pickup label: the
 * inserted job is the wake. The implement retry path is untouched.
 */
async function handleStuckKickBody(
  body: unknown,
  headerIdempotencyKey: string,
  store: ReviewJobStore,
  logger: (message: string) => void,
  actor: string
): Promise<Response> {
  const parsed = parseStuckKickBody(body, headerIdempotencyKey);
  if ("error" in parsed) return json(400, { error: parsed.error });
  const item = { owner: parsed.owner, repo: parsed.repo, issueNumber: parsed.number, kick: parsed.kick };

  if (parsed.idempotencyKey) {
    let prior: Awaited<ReturnType<ReviewJobStore["getKickByIdempotencyKey"]>>;
    try {
      prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey);
    } catch (err) {
      logger(`stuck kick unavailable: ${errorMessage(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    if (prior) {
      if (stuckIdempotencyMismatch(item, prior)) {
        return json(400, {
          error: `Idempotency key was already used for ${prior.owner}/${prior.repo}#${prior.number} @ ${prior.commit} with a different kick; use a fresh key for a different item.`,
          code: "bad-request",
          terminalJobId: null,
          newJobId: null,
        });
      }
      return await replayStuckPrior(store, prior);
    }
  }

  const delivery = `board-kick:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;
  // Optional caller-supplied closer state. The page does not send these; a
  // conflict-capped latch queues conflict resolution without them. When
  // present, `mergeable: false` queues conflict resolution for a currently
  // unmergeable pull even when the latch itself is not a conflict cap.
  const rawBody = body as Record<string, unknown>;
  const mergeable = typeof rawBody.mergeable === "boolean" ? rawBody.mergeable : undefined;
  const headSha =
    typeof rawBody.headSha === "string" && rawBody.headSha.trim() !== ""
      ? rawBody.headSha.trim()
      : typeof rawBody.head_sha === "string" && rawBody.head_sha.trim() !== ""
        ? rawBody.head_sha.trim()
        : undefined;
  let outcome: Awaited<ReturnType<ReviewJobStore["stuckKick"]>>;
  try {
    outcome = await store.stuckKick({
      owner: parsed.owner,
      repo: parsed.repo,
      issueNumber: parsed.number,
      kick: parsed.kick,
      actor,
      idempotencyKey: parsed.idempotencyKey,
      delivery,
      ...(mergeable !== undefined ? { mergeable } : {}),
      ...(headSha !== undefined ? { headSha } : {}),
    });
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`stuck kick unavailable: ${errorMessage(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    if (parsed.idempotencyKey && isUniqueViolation(err)) {
      let prior: KickLogRecord | undefined;
      try {
        prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey);
      } catch {
        return json(503, { error: "queue unavailable" });
      }
      if (!prior) return json(503, { error: "queue unavailable" });
      if (stuckIdempotencyMismatch(item, prior)) {
        return json(400, {
          error: `Idempotency key was already used for ${prior.owner}/${prior.repo}#${prior.number} @ ${prior.commit} with a different kick; use a fresh key for a different item.`,
          code: "bad-request",
          terminalJobId: null,
          newJobId: null,
        });
      }
      return await replayStuckPrior(store, prior);
    }
    logger(`stuck kick failed: ${errorMessage(err)}`);
    return json(503, { error: "queue unavailable" });
  }

  if (outcome.status === "ok") {
    logger(
      `stuck kick ok actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} kick=${JSON.stringify(parsed.kick)} kind=${outcome.job.kind} job=${outcome.job.id} terminal=${outcome.terminalId}${outcome.deduped ? " deduped" : ""}`
    );
    return json(200, {
      ok: true,
      jobId: outcome.job.id,
      newJobId: outcome.job.id,
      key: outcome.job.jobKey,
      kind: outcome.job.kind,
      terminalJobId: outcome.terminalId,
      deduped: outcome.deduped,
    });
  }

  logger(
    `stuck kick ${outcome.code} actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} kick=${JSON.stringify(parsed.kick)}: ${outcome.why}`
  );
  const status =
    outcome.code === "not-found"
      ? 404
      : outcome.code === "stale-kick" || outcome.code === "conflict"
        ? 409
        : outcome.code === "not-kickable"
          ? 422
          : 400;
  return json(status, {
    error: outcome.why,
    code: outcome.code,
    terminalJobId: outcome.terminalId,
    newJobId: outcome.newJobId,
    ...(outcome.deduped ? { deduped: true } : {}),
  });
}

async function replayStuckPrior(store: ReviewJobStore, prior: KickLogRecord): Promise<Response> {
  if (prior.result === "ok") {
    if (prior.newJobId != null) {
      try {
        const job = await store.get(prior.newJobId);
        if (job) {
          return json(200, {
            ok: true,
            jobId: prior.newJobId,
            newJobId: prior.newJobId,
            key: job.jobKey,
            kind: job.kind,
            terminalJobId: prior.terminalJobId,
            deduped: true,
          });
        }
      } catch {
        // Fall through to the key-less shape rather than failing a replay
        // for a ledger row that already committed.
      }
    }
    return json(200, {
      ok: true,
      jobId: prior.newJobId,
      newJobId: prior.newJobId,
      terminalJobId: prior.terminalJobId,
      deduped: true,
    });
  }
  if (prior.result === "not-found") {
    return json(404, {
      error: "already decided: not-found",
      code: "not-found",
      terminalJobId: prior.terminalJobId,
      newJobId: prior.newJobId,
      deduped: true,
    });
  }
  if (prior.result === "stale-kick" || prior.result === "conflict") {
    const code = prior.result === "conflict" ? "conflict" : "stale-kick";
    const status = 409;
    return json(status, {
      error: `already decided: ${prior.result}`,
      code,
      terminalJobId: prior.terminalJobId,
      newJobId: prior.newJobId,
      deduped: true,
    });
  }
  return json(422, {
    error: `already decided: ${prior.result}`,
    code: "not-kickable",
    terminalJobId: prior.terminalJobId,
    newJobId: prior.newJobId,
    deduped: true,
  });
}
