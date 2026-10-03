import {
  isImplementKickId,
  isKickPath,
  isReopenKickId,
  isStuckKickId,
  parseImplementKickBody,
  parseKickBody,
  parseReopenKickBody,
  parseStuckKickBody,
  rawKickIdOf,
} from "./kick.ts";
import type { KickLogRecord, ReviewJobRecord, ReviewJobStore } from "./review_jobs.ts";
import {
  implementIdempotencyMismatch,
  isQueueUnavailable,
  isUniqueViolation,
  reopenIdempotencyMismatch,
  stuckIdempotencyMismatch,
} from "./review_jobs.ts";
import type { RouterSitReason, RouterSitRecord } from "./router_sits.ts";
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
export const PEER_BOARD_TIMEOUT_MS = 5_000;

/** Peer board body cap: a compromised peer must not spike homelab memory per poll. */
export const PEER_BOARD_MAX_BYTES = 1_048_576;

/** Forge name of the isolated GitHub factory. Homelab is anything else (gitea). */
export const PEER_FORGE = "github";

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

export function hasEdgeIdentity(request: Request): boolean {
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

export function edgeActor(request: Request): string {
  return boardUsername(request) ?? "";
}

/**
 * Peer bearer check. Accepts `Bearer <token>` (and the bare token, like the
 * webhook auth token). Never reads edge identity headers.
 */
export function hasBearerAuth(request: Request, expectedToken?: string): boolean {
  const expected = (expectedToken ?? "").trim();
  if (expected === "") return false;
  const actual = (request.headers.get("authorization") ?? "").trim();
  if (actual === "") return false;
  return actual === expected || actual === `Bearer ${expected}`;
}

/** Only the homelab board fans out. The peer never calls back (one-way hop). */
export function isHomelabForge(forge?: string): boolean {
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
export function boardPublicOrigin(request: Request): string {
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

export interface BoardKick {
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
  /** At most one kick. Absent when there is no button payload. */
  kick?: BoardKick;
}

export interface BoardGroups {
  in_progress: BoardItem[];
  needs_kick: BoardItem[];
  sitting: BoardItem[];
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
  sitting?: BoardItem[];
  sitting_on_purpose?: BoardItem[];
  /** Stable unavailable marker. Never a token, URL, or forge secret. */
  error?: string;
}

/**
 * Sits with no button: waits the operator cannot finish from this page
 * (draft/not-ready, CI), plus already done, nothing to ship, or already queued.
 */
const NO_KICK_SITS = new Set<string>(["terminal-result", "no-changes", "repo-mutex", "ci-not-completed", "draft-wip"]);

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
};

export function sitMessage(reason: RouterSitReason): string {
  return SIT_MESSAGES[reason] ?? "Sitting on purpose.";
}

/**
 * A click that only removes the board row must say it only removes the row.
 * Only the stuck latch queues follow-up; every other kickable sit is a
 * row-only clear, so its effect names just that.
 */
const SIT_KICK_EFFECTS: Record<string, string> = {
  "foreign-branch": "Remove this board row only",
  "no-closer": "Remove this board row only",
  "implement-latch": "Clear the stuck latch and queue follow-up on the open closer",
  "no-write-access": "Remove this board row only",
  "not-labeled": "Remove this board row only",
};

/** Kick id the page must send for each kickable sit. Owner-only payloads never confirm these. */
const SIT_KICK_IDS: Record<string, string> = {
  "foreign-branch": "sit-clear",
  "no-closer": "sit-clear",
  "implement-latch": "stuck",
  "no-write-access": "sit-clear",
  "not-labeled": "sit-clear",
};

function kickForSit(reason: RouterSitReason): BoardKick | undefined {
  if (NO_KICK_SITS.has(reason)) return undefined;
  const effect = SIT_KICK_EFFECTS[reason] ?? "Remove this board row only";
  const kick = SIT_KICK_IDS[reason] ?? "sit-clear";
  return { effect, kick };
}

export { kickForSit };

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
  JSON.stringify({ effects: SIT_KICK_EFFECTS, ids: SIT_KICK_IDS, none: [...NO_KICK_SITS].sort() })
);

function primaryNumber(row: ReviewJobRecord): number {
  if (row.kind === "review") return row.prNumber;
  if (typeof row.issueNumber === "number" && Number.isFinite(row.issueNumber) && row.issueNumber !== 0) {
    return row.issueNumber;
  }
  return row.prNumber;
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
  return item;
}

function sitItem(sit: RouterSitRecord, forge?: string): { item: BoardItem; kickable: boolean } {
  const item: BoardItem = {
    reason: sit.reason,
    message: sitMessage(sit.reason),
    owner: sit.owner,
    repo: sit.repo,
    number: sit.number,
    kind: "sit",
    decidedAt: sit.decidedAt,
  };
  if (forge) item.forge = forge;
  const kick = kickForSit(sit.reason);
  if (kick) item.kick = kick;
  return { item, kickable: kick !== undefined };
}

export interface BoardStore {
  listInflight(limit?: number): Promise<ReviewJobRecord[]>;
  sits: { list(): Promise<RouterSitRecord[]> };
}

export async function buildBoardGroups(store: BoardStore, forge?: string): Promise<BoardGroups> {
  const [inflight, sits] = await Promise.all([store.listInflight(200), store.sits.list()]);
  const in_progress = inflight.map((row) => inflightItem(row, forge));
  // A sit that duplicates a job already in progress is not a second problem:
  // hide it here. Recording and clearing are unchanged; this is read-time only.
  const inflightKeys = new Set(
    in_progress.map((item) => `${item.owner.toLowerCase()}/${item.repo.toLowerCase()}#${item.number}`)
  );
  const needs_kick: BoardItem[] = [];
  const sitting: BoardItem[] = [];
  for (const sit of sits) {
    const key = `${sit.owner.toLowerCase()}/${sit.repo.toLowerCase()}#${sit.number}`;
    if (inflightKeys.has(key)) continue;
    const { item, kickable } = sitItem(sit, forge);
    if (kickable) needs_kick.push(item);
    else sitting.push(item);
  }
  return { in_progress, needs_kick, sitting };
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

export type BoardFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchPeerBoard(
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
    // Peer sits are read-only from here: strip kick so the page never POSTs
    // peer coordinates to the homelab kick endpoint (which acts only on the
    // local sit store and has no forwarding hop).
    const pinForge = (items: BoardItem[]): BoardItem[] =>
      items.map((item) => {
        const copy = { ...item, forge: PEER_FORGE };
        delete copy.kick;
        return copy;
      });
    const in_progress = pinForge(sanitizeBoardList(body.in_progress ?? body.inProgress, PEER_FORGE));
    const needs_kick = pinForge(sanitizeBoardList(body.needs_kick ?? body.needsKick, PEER_FORGE));
    const sitting = pinForge(sanitizeBoardList(body.sitting ?? body.sitting_on_purpose, PEER_FORGE));
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
      sitting,
      sitting_on_purpose: [...sitting],
    };
  } finally {
    clearTimeout(timer);
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
  fetchFn?: BoardFetchFn;
  peerTimeoutMs?: number;
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
 * - Phone: two lists (In progress, Sitting). Message is the headline; reason
 *   stays as code in the inspector only. A button naming the real side effect
 *   renders only when the payload carries `kick`. Sitting on purpose
 *   is a status line, never a disabled button.
 * - Confirm names the server-provided side effect (`kick.effect`) before it
 *   commits. Narrow viewports confirm in a bottom sheet; wide viewports
 *   confirm in the inspector. Consequence text is a note, not extra buttons.
 *   Each confirm has exactly one primary control.
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
.grant { flex-basis: 100%; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.85; }
.catalog-note { font-size: 12px; opacity: 0.7; }
#catalog-mismatch { padding: 8px 12px; font-size: 13px; background: #fff3cd; color: #442d00; }
#load-error { padding: 8px 12px; font-size: 13px; }
#layout { display: block; padding: 0 0 40px; }
#lists { display: block; }
section.list { padding: 8px 12px; }
section.list h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; margin: 8px 0; }
ul.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
li.row { border: 1px solid #8884; border-radius: 8px; padding: 8px 10px; }
li.row.selected { outline: 2px solid currentColor; }
.row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.reason { font-weight: 650; margin: 0; overflow-wrap: anywhere; }
.sub { font-size: 13px; opacity: 0.8; overflow-wrap: anywhere; }
.status-line { font-size: 13px; opacity: 0.8; margin-top: 6px; }
.row-actions { margin-top: 8px; display: flex; gap: 8px; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #8888; background: transparent; }
button.primary { background: #0b5fff; border-color: #0b5fff; color: #fff; font-weight: 650; }
button.secondary { opacity: 0.85; }
#inspector { border-top: 1px solid #8884; padding: 12px; }
#inspector h2 { font-size: 15px; margin: 0 0 4px; overflow-wrap: anywhere; }
.consequence { font-size: 13px; border-left: 3px solid #0b5fff; padding-left: 8px; }
.forge-link { font-size: 13px; }
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
<label>Forge <select id="forge-switch" aria-label="Forge">
<option value="gitea">gitea</option>
<option value="github">github</option>
</select></label>
<button id="refresh" class="secondary" type="button">Refresh</button>
<span id="catalog" class="catalog-note" title="Kick catalog baked into this page">catalog ${catalog.slice(0, 8)}</span>
<div id="grant" class="grant" hidden></div>
</header>
<div id="catalog-mismatch" hidden>Board updated — refresh to get the latest kick list.</div>
<div id="load-error" hidden></div>
<main id="layout">
<div id="lists">
<section class="list" aria-label="In progress">
<h2>In progress</h2>
<ul id="inprogress" class="rows"></ul>
</section>
<section class="list" aria-label="Sitting">
<h2>Sitting</h2>
<ul id="sitting" class="rows"></ul>
</section>
</div>
<aside id="inspector" aria-live="polite" aria-label="Detail"></aside>
</main>
<div id="sheet-wrap" hidden>
<div id="sheet-backdrop"></div>
<div id="sheet" role="dialog" aria-modal="true" aria-label="Confirm action"></div>
</div>
<script>
const PAGE_CATALOG = ${JSON.stringify(catalog)};
const state = { data: null, selected: null, forge: "gitea", catalogOk: true };
const $ = (id) => document.getElementById(id);
const narrow = () => !window.matchMedia("(min-width: 700px)").matches;
function keyOf(item) { const forge = item.forge || (state.data && state.data.forge) || "gitea"; return forge + "/" + item.owner + "/" + item.repo + "/" + item.kind + "#" + item.number; }
function groupsOf(data) {
  const inProgress = [...(data.in_progress || data.inProgress || [])];
  const needsKick = [...(data.needs_kick || data.needsKick || [])];
  const sitting = [...(data.sitting || data.sitting_on_purpose || [])];
  const peers = data.peers && typeof data.peers === "object" ? Object.values(data.peers) : [];
  for (const p of peers) {
    if (!p || typeof p !== "object" || !p.available) continue;
    inProgress.push(...(p.in_progress || p.inProgress || []));
    needsKick.push(...(p.needs_kick || p.needsKick || []));
    sitting.push(...(p.sitting || p.sitting_on_purpose || []));
  }
  return { inProgress, sitting: [...needsKick, ...sitting] };
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
function isLocalRow(item, data) { return forgeOf(item, data) === (data.forge || "gitea"); }
function forgeHref(item, data) {
  const base = forgeBaseFor(item, data);
  if (!base) return null;
  if (item.kind === "sit") return null;
  const forge = forgeOf(item, data);
  const path = item.kind === "review" ? (forge === "github" ? "pull" : "pulls") : "issues";
  return base + "/" + encodeURIComponent(item.owner) + "/" + encodeURIComponent(item.repo) + "/" + path + "/" + item.number;
}
async function load() {
  const errBox = $("load-error");
  errBox.hidden = true;
  errBox.textContent = "";
  let res;
  try {
    res = await fetch("/api/board", { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
  } catch (err) {
    errBox.hidden = false;
    errBox.textContent = "Board unavailable. Use Refresh to load again.";
    return;
  }
  if (!res.ok) {
    errBox.hidden = false;
    errBox.textContent = res.status === 401 ? "Sign in via the edge proxy, then Refresh." : "Board unavailable (" + res.status + "). Use Refresh to load again.";
    return;
  }
  const data = await res.json();
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
    const all = [...groupsOf(data).inProgress, ...groupsOf(data).sitting];
    const stillThere = all.some((item) => keyOf(item) === state.selected && forgeOf(item, data) === state.forge);
    if (!stillThere) state.selected = null;
  }
  render();
}
function headlineOf(item) { return (typeof item.message === "string" && item.message.trim() !== "" ? item.message : item.reason); }
function kickLabelOf(item) {
  const id = item.kick && typeof item.kick.kick === "string" ? item.kick.kick.trim() : "";
  if (id === "stuck" || id === "follow-up" || id === "followup" || id === "stuck-latch") return "Clear latch and queue follow-up";
  return "Remove row";
}
function rowItem(item, opts) {
  const li = document.createElement("li");
  li.className = "row" + (state.selected === keyOf(item) ? " selected" : "");
  const head = document.createElement("div");
  head.className = "row-head";
  const h = document.createElement("p");
  h.className = "reason";
  h.textContent = headlineOf(item);
  head.appendChild(h);
  li.appendChild(head);
  const sub = document.createElement("div");
  sub.className = "sub";
  let subText = item.owner + "/" + item.repo + "#" + item.number + " · " + item.kind;
  if (item.commit) subText += " · " + String(item.commit).slice(0, 8);
  sub.textContent = subText;
  li.appendChild(sub);
  const hasKick = Boolean(item.kick && typeof item.kick.effect === "string" && item.kick.effect.trim() !== "") && isLocalRow(item, state.data);
  if (opts.section === "sitting" && hasKick && state.catalogOk) {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = kickLabelOf(item);
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); state.selected = keyOf(item); render(); openConfirm(item); });
    actions.appendChild(btn);
    li.appendChild(actions);
  } else if (opts.section === "sitting" && !hasKick) {
    const line = document.createElement("div");
    line.className = "status-line";
    line.textContent = "Sitting on purpose";
    li.appendChild(line);
  }
  li.addEventListener("click", () => { state.selected = keyOf(item); render(); if (!narrow()) { const el = $("inspector").querySelector("button.primary"); } });
  return li;
}
function render() {
  const data = state.data;
  if (!data) { $("inspector").textContent = "Select a row to see detail."; return; }
  const groups = groupsOf(data);
  const inList = $("inprogress");
  const sitList = $("sitting");
  inList.textContent = "";
  sitList.textContent = "";
  const inFiltered = groups.inProgress.filter((item) => forgeOf(item, data) === state.forge);
  const sitFiltered = groups.sitting.filter((item) => forgeOf(item, data) === state.forge);
  if (inFiltered.length === 0) {
    const li = document.createElement("li");
    li.className = "row";
    li.textContent = "Nothing in progress on this forge.";
    inList.appendChild(li);
  } else {
    for (const item of inFiltered) inList.appendChild(rowItem(item, { section: "inprogress" }));
  }
  if (sitFiltered.length === 0) {
    const li = document.createElement("li");
    li.className = "row";
    li.textContent = "Nothing sitting on this forge.";
    sitList.appendChild(li);
  } else {
    for (const item of sitFiltered) sitList.appendChild(rowItem(item, { section: "sitting" }));
  }
  renderInspector();
}
function selectedItem() {
  const data = state.data;
  if (!data || !state.selected) return null;
  const all = [...groupsOf(data).inProgress, ...groupsOf(data).sitting];
  return all.find((item) => keyOf(item) === state.selected && forgeOf(item, data) === state.forge) || null;
}
function confirmBlock(item, data, confirmIdPrefix) {
  const wrap = document.createElement("div");
  const hasKick = Boolean(item.kick && typeof item.kick.effect === "string") && isLocalRow(item, data);
  const kickId = item.kick && typeof item.kick.kick === "string" && item.kick.kick.trim() !== "" ? item.kick.kick.trim() : "";
  const idempotencyKey = (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + "-" + Math.floor(Math.random() * 1e9));
  if (hasKick && state.catalogOk) {
    const note = document.createElement("p");
    note.className = "consequence";
    note.textContent = "This will: " + item.kick.effect;
    wrap.appendChild(note);
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "primary";
    primary.id = confirmIdPrefix + "-confirm";
    primary.textContent = kickLabelOf(item);
    const msg = document.createElement("div");
    msg.className = "sub";
    msg.id = confirmIdPrefix + "-msg";
    primary.addEventListener("click", async () => {
      if (!state.catalogOk) {
        msg.textContent = "Board updated — refresh to get the latest kick list before confirming.";
        return;
      }
      msg.textContent = "Working…";
      try {
        const payload = { owner: item.owner, repo: item.repo, number: item.number };
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
        } else if (res.status === 409) {
          msg.textContent = "That kick is no longer offered for this row.";
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
  title.textContent = headlineOf(item);
  box.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "sub";
  let subText = item.owner + "/" + item.repo + "#" + item.number + " · " + item.kind + " · " + forgeOf(item, data) + " · " + item.reason;
  if (item.commit) subText += " · " + item.commit;
  if (typeof item.decidedAt === "number") subText += " · decided " + new Date(item.decidedAt).toLocaleString();
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
  if (!narrow()) { render(); const btn = $("inspector").querySelector("button.primary"); if (btn) btn.focus(); return; }
  const wrap = $("sheet-wrap");
  const sheet = $("sheet");
  sheet.textContent = "";
  const data = state.data;
  const title = document.createElement("h2");
  title.textContent = headlineOf(item);
  sheet.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = item.owner + "/" + item.repo + "#" + item.number + " · " + forgeOf(item, data);
  sheet.appendChild(sub);
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
setInterval(load, 15000);
load();
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
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    const pathname = normalizePathname(url.pathname);
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
      return handleKick(request, deps.store, logger, deps.forgeApi, { actor: kickActor });
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
          logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
          return json(503, { error: "queue unavailable" });
        }
        const grant = getGrant();
        const grantLine = typeof grant === "string" && grant.trim() !== "" ? grant.split("\n")[0]?.trim() : undefined;
        const body: Record<string, unknown> = {
          in_progress: groups.in_progress,
          inProgress: [...groups.in_progress],
          needs_kick: groups.needs_kick,
          needsKick: [...groups.needs_kick],
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
        logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
        logger(`peer board unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
          logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
  opts?: { actor?: string; peer?: boolean }
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
  // Sit-clear kick (default branch): an owner/repo/number-only payload clears
  // a kickable sit. Requeue payloads carry a commit and kick id and fall
  // through to requeueKick below. The reopen kick carries kick=reopen and
  // never inserts a job: close-then-reopen wakes via the reopen webhook.
  // The implement kick carries kick=implement and requeues a no-changes
  // implement without opening a pull request.
  if (isSitClearPayload(body)) {
    return handleSitClear(request, body, store, logger, isPeer ? undefined : actor);
  }
  if (isReopenKickId(rawKickIdOf(body))) {
    return handleReopenKick(request, body, store, logger, forgeApi, actor);
  }
  if (isImplementKickId(rawKickIdOf(body))) {
    return handleImplementKick(request, body, store, logger, forgeApi, actor);
  }
  if (isStuckKickId(rawKickIdOf(body))) {
    return handleStuckKick(request, body, store, logger, actor);
  }
  const parsed = parseKickBody(body, idempotencyKeyOf(request));
  if ("error" in parsed) return json(400, { error: parsed.error });
  const delivery = `board-kick:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;
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
    });
    if (outcome.status === "ok") {
      logger(
        `kick ok actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} @ ${parsed.commit} kick=${JSON.stringify(parsed.kick)} job=${outcome.job.id} terminal=${outcome.terminalId}${outcome.deduped ? " deduped" : ""}`
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
      logger(`kick unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    logger(`kick failed: ${err instanceof Error ? err.message : String(err)}`);
    return json(503, { error: "queue unavailable" });
  }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function isNotFoundForgeError(err: unknown): boolean {
  return err instanceof Error && /→ 404\b/.test(err.message);
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
async function handleReopenKick(
  request: Request,
  body: unknown,
  store: ReviewJobStore,
  logger: (message: string) => void,
  forgeApi: BoardPullForge | undefined,
  actor: string
): Promise<Response> {
  const parsed = parseReopenKickBody(body, idempotencyKeyOf(request));
  if ("error" in parsed) return json(400, { error: parsed.error });
  const item = { owner: parsed.owner, repo: parsed.repo, number: parsed.number, kick: parsed.kick };

  if (parsed.idempotencyKey) {
    let prior: Awaited<ReturnType<ReviewJobStore["getKickByIdempotencyKey"]>>;
    try {
      prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey);
    } catch (err) {
      logger(`reopen kick unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
      `reopen kick forge unavailable actor=${actor} ${item.owner}/${item.repo}#${item.number}: ${err instanceof Error ? err.message : String(err)}`
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
      logger(
        `reopen kick unavailable actor=${actor} ${item.owner}/${item.repo}#${item.number}: ${err instanceof Error ? err.message : String(err)}`
      );
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
      `reopen kick forge unavailable actor=${actor} ${item.owner}/${item.repo}#${item.number}: ${err instanceof Error ? err.message : String(err)}`
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
    logger(
      `reopen kick unavailable actor=${actor} ${item.owner}/${item.repo}#${item.number}: ${err instanceof Error ? err.message : String(err)}`
    );
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
      logger(`reopen kick unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
async function handleImplementKick(
  request: Request,
  body: unknown,
  store: ReviewJobStore,
  logger: (message: string) => void,
  forgeApi: BoardPullForge | undefined,
  actor: string
): Promise<Response> {
  const parsed = parseImplementKickBody(body, idempotencyKeyOf(request));
  if ("error" in parsed) return json(400, { error: parsed.error });
  const item = { owner: parsed.owner, repo: parsed.repo, issueNumber: parsed.number, kick: parsed.kick };

  if (parsed.idempotencyKey) {
    let prior: Awaited<ReturnType<ReviewJobStore["getKickByIdempotencyKey"]>>;
    try {
      prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey);
    } catch (err) {
      logger(`implement kick unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
      logger(`implement kick unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
    logger(`implement kick failed: ${err instanceof Error ? err.message : String(err)}`);
    return json(503, { error: "queue unavailable" });
  }

  if (outcome.status === "ok") {
    // The latch clear + job insert already committed. Now make the forge
    // match by ensuring the pickup label is present. Best-effort: the job
    // is already queued, so a label failure is logged, never a rollback
    // and never a second pull request.
    try {
      await forgeApi.addIssueLabel(item.owner, item.repo, item.issueNumber, "jumi");
    } catch (err) {
      logger(
        `implement kick label failed actor=${actor} ${item.owner}/${item.repo}#${item.issueNumber}: ${err instanceof Error ? err.message : String(err)}`
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

async function handleSitClear(
  request: Request,
  body: unknown,
  store: ReviewJobStore,
  logger: (message: string) => void,
  kickActor?: string
): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return json(400, { error: "invalid kick payload" });
  if (!isAllowedBoardOrigin(request)) return json(403, { error: "forbidden" });
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
    logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return json(503, { error: "queue unavailable" });
  }
  if (!sit) return json(404, { error: "sit not found" });
  // A stuck latch is never confirmed by an owner-only payload: the page
  // sends the stuck kick id so one click clears the latch and queues
  // follow-up on the open closer in a single transaction.
  if (sit.reason === "implement-latch") {
    return json(400, { error: "missing kick" });
  }
  const kick = kickForSit(sit.reason);
  if (!kick) return json(409, { error: "no kick for this row" });
  try {
    await store.sits.clear(owner, repo, number);
  } catch (err) {
    logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return json(503, { error: "queue unavailable" });
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
 * `stuck-latch`). It clears the issue skip latch and inserts a follow-up
 * job for the open closer in one transaction; the sit row goes away
 * because that enqueue landed, never via a bare sit delete. It never opens
 * a second pull, never unassigns, and never adds a pickup label: the
 * inserted job is the wake. The implement retry path is untouched.
 */
async function handleStuckKick(
  request: Request,
  body: unknown,
  store: ReviewJobStore,
  logger: (message: string) => void,
  actor: string
): Promise<Response> {
  const parsed = parseStuckKickBody(body, idempotencyKeyOf(request));
  if ("error" in parsed) return json(400, { error: parsed.error });
  const item = { owner: parsed.owner, repo: parsed.repo, issueNumber: parsed.number, kick: parsed.kick };

  if (parsed.idempotencyKey) {
    let prior: Awaited<ReturnType<ReviewJobStore["getKickByIdempotencyKey"]>>;
    try {
      prior = await store.getKickByIdempotencyKey(parsed.idempotencyKey);
    } catch (err) {
      logger(`stuck kick unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
    });
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`stuck kick unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
    logger(`stuck kick failed: ${err instanceof Error ? err.message : String(err)}`);
    return json(503, { error: "queue unavailable" });
  }

  if (outcome.status === "ok") {
    logger(
      `stuck kick ok actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number} kick=${JSON.stringify(parsed.kick)} job=${outcome.job.id} terminal=${outcome.terminalId}${outcome.deduped ? " deduped" : ""}`
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
