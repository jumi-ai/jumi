import type { ReviewJobRecord, ReviewJobStore } from "./review_jobs.ts";
import type { RouterSitReason, RouterSitRecord } from "./router_sits.ts";
import { latchedXaiGrantNotice } from "./xai_auth.ts";

/**
 * Operator board read API.
 *
 * Served by the router on a second port (3001), never on the webhook host.
 * Polling GET only; no forge webhooks are pushed to the browser and no
 * per-row forge calls are made. In-progress comes from the job ledger
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

/** Forge name of the isolated GitHub factory. Homelab is anything else (gitea). */
export const PEER_FORGE = "github";

const BOARD_PATHS = new Set(["/", "/board", "/api/board"]);

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

export interface BoardKick {
  /** Server-provided effect text for this kick. */
  effect: string;
}

export interface BoardItem {
  /** Headline reason: ledger kind+state for in-progress, sit code for sits. */
  reason: string;
  owner: string;
  repo: string;
  /** Pull or issue number (shared number space). */
  number: number;
  /** Job kind for ledger rows; "sit" for refusal rows. */
  kind: string;
  /** Which factory produced this row. Local rows carry the local forge. */
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
  in_progress?: BoardItem[];
  inProgress?: BoardItem[];
  needs_kick?: BoardItem[];
  needsKick?: BoardItem[];
  sitting?: BoardItem[];
  sitting_on_purpose?: BoardItem[];
  /** Stable unavailable marker. Never a token, URL, or forge secret. */
  error?: string;
}

/** Sits with no button: already done, nothing to ship, or already queued. */
const NO_KICK_SITS = new Set<string>(["terminal-result", "no-changes", "repo-mutex"]);

const SIT_KICK_EFFECTS: Record<string, string> = {
  "ci-not-completed": "Re-check once CI finishes",
  "draft-wip": "Re-evaluate when marked ready",
  "foreign-branch": "Re-evaluate if the branch becomes local",
  "no-closer": "Re-evaluate when a closing issue is linked",
  "implement-latch": "Re-evaluate after the owning job finishes",
  "no-write-access": "Re-evaluate when the sender gains write access",
  "not-labeled": "Re-evaluate when labeled for pickup",
};

function kickForSit(reason: RouterSitReason): BoardKick | undefined {
  if (NO_KICK_SITS.has(reason)) return undefined;
  const effect = SIT_KICK_EFFECTS[reason] ?? "Re-evaluate on the next webhook";
  return { effect };
}

function primaryNumber(row: ReviewJobRecord): number {
  if (row.kind === "review") return row.prNumber;
  if (typeof row.issueNumber === "number" && Number.isFinite(row.issueNumber) && row.issueNumber !== 0) {
    return row.issueNumber;
  }
  return row.prNumber;
}

function inflightItem(row: ReviewJobRecord, forge?: string): BoardItem {
  const item: BoardItem = {
    reason: `${row.kind} ${row.state}`,
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
  const needs_kick: BoardItem[] = [];
  const sitting: BoardItem[] = [];
  for (const sit of sits) {
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
  const number = typeof rec.number === "number" && Number.isFinite(rec.number) ? rec.number : undefined;
  if (!owner || !repo || !reason || !kind || number === undefined) return undefined;
  const item: BoardItem = { reason, owner, repo, number, kind };
  const forge = typeof rec.forge === "string" && rec.forge.trim() !== "" ? rec.forge.trim() : fallbackForge;
  if (forge) item.forge = forge;
  if (typeof rec.commit === "string" && rec.commit.trim() !== "") item.commit = rec.commit.trim();
  if (typeof rec.headSha === "string" && rec.headSha.trim() !== "") item.headSha = rec.headSha.trim();
  if (typeof rec.decidedAt === "number" && Number.isFinite(rec.decidedAt)) item.decidedAt = rec.decidedAt;
  const kick = rec.kick as { effect?: unknown } | undefined;
  if (kick && typeof kick === "object" && typeof kick.effect === "string" && kick.effect.trim() !== "") {
    item.kick = { effect: kick.effect };
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
    throw new Error("peer unavailable");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("peer unavailable");
  // Never forward edge identity headers and never send forge credentials:
  // the hop carries only the bearer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(parsed.toString(), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("peer unavailable");
    const body = (await response.json()) as Record<string, unknown>;
    // Pin every row to PEER_FORGE. Both the top-level body.forge and each
    // row's own rec.forge are peer-supplied and untrusted for filtering, so
    // a compromised peer cannot tag rows with the local forge name.
    const pinForge = (items: BoardItem[]): BoardItem[] => items.map((item) => ({ ...item, forge: PEER_FORGE }));
    const in_progress = pinForge(sanitizeBoardList(body.in_progress ?? body.inProgress, PEER_FORGE));
    const needs_kick = pinForge(sanitizeBoardList(body.needs_kick ?? body.needsKick, PEER_FORGE));
    const sitting = pinForge(sanitizeBoardList(body.sitting ?? body.sitting_on_purpose, PEER_FORGE));
    return {
      available: true,
      forge: PEER_FORGE,
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

export interface BoardHandlerDeps {
  store: ReviewJobStore;
  getGrantNotice?: () => string | undefined;
  logger?: (message: string) => void;
  /** Local factory name for forge tagging/filtering. Defaults to homelab gitea. */
  forge?: string;
  /** Internal peer listener URL. Unset disables the hop (peer unavailable). */
  peerUrl?: string;
  /** Bearer for the peer hop. Unset means that forge is unavailable. Never invent one. */
  peerToken?: string;
  fetchFn?: BoardFetchFn;
  peerTimeoutMs?: number;
}

export function createBoardFetchHandler(deps: BoardHandlerDeps) {
  const logger = deps.logger ?? ((message: string) => console.log(`[board] ${message}`));
  const getGrant = deps.getGrantNotice ?? latchedXaiGrantNotice;
  const localForge = (deps.forge ?? "gitea").trim() || "gitea";
  const peerUrl = (deps.peerUrl ?? "").trim();
  const peerToken = (deps.peerToken ?? "").trim();
  const fetchFn = deps.fetchFn ?? fetch;
  const peerTimeoutMs = deps.peerTimeoutMs ?? PEER_BOARD_TIMEOUT_MS;
  // One-way hop: only the homelab board fans out. The peer (github factory)
  // never calls back, so the other factory still cannot reach the homelab forge.
  const shouldFetchPeer = isHomelabForge(localForge) && peerUrl !== "" && peerToken !== "";
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    const pathname = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    if (!BOARD_PATHS.has(pathname)) return json(404, { error: "not found" });
    if (request.method !== "GET") return json(405, { error: "method not allowed" });
    // Auth path is gated on the forge. The peer listener is bearer-only and
    // never reads edge headers; homelab requires edge identity and never
    // accepts the bearer (the outgoing hop credential is not an incoming one).
    const homelab = isHomelabForge(localForge);
    if (!homelab) {
      if (!hasBearerAuth(request, peerToken)) return json(401, { error: "missing bearer" });
      let groups: BoardGroups;
      try {
        groups = await buildBoardGroups(deps.store, localForge);
      } catch (err) {
        logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return json(503, { error: "queue unavailable" });
      }
      return json(200, {
        forge: localForge,
        in_progress: groups.in_progress,
        inProgress: [...groups.in_progress],
        needs_kick: groups.needs_kick,
        needsKick: [...groups.needs_kick],
        sitting: groups.sitting,
        sitting_on_purpose: [...groups.sitting],
        peers: {},
      });
    }
    // Browser path: the homelab edge checks the person. The webhook HMAC
    // secret and auth token are not accepted here.
    const username = boardUsername(request);
    if (!username) return json(401, { error: "missing edge identity" });
    let groups: BoardGroups;
    try {
      groups = await buildBoardGroups(deps.store, localForge);
    } catch (err) {
      logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return json(503, { error: "queue unavailable" });
    }
    const grant = getGrant();
    const grantLine = typeof grant === "string" && grant.trim() !== "" ? grant.split("\n")[0]?.trim() : undefined;
    // Top-level lists stay local-only: the homelab side does not list the
    // other factory's rows there. Peer rows live under `peers`.
    const body: Record<string, unknown> = {
      forge: localForge,
      in_progress: groups.in_progress,
      inProgress: [...groups.in_progress],
      needs_kick: groups.needs_kick,
      needsKick: [...groups.needs_kick],
      sitting: groups.sitting,
      sitting_on_purpose: [...groups.sitting],
      peers: {} as Record<string, BoardPeerStatus>,
    };
    if (grantLine) body.grant = grantLine;
    if (!shouldFetchPeer) {
      if (isHomelabForge(localForge)) {
        (body.peers as Record<string, BoardPeerStatus>)[PEER_FORGE] = peerUnavailable();
      }
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
  };
}
