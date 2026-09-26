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
 */

export const BOARD_PORT = 3001;

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
  for (const header of EDGE_IDENTITY_HEADERS) {
    const value = request.headers.get(header);
    if (value != null && value.trim() !== "") return true;
  }
  return false;
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
  /** Forge this row belongs to (server-configured). Used by the forge switch. */
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
  JSON.stringify({ effects: SIT_KICK_EFFECTS, none: [...NO_KICK_SITS].sort() })
);

function primaryNumber(row: ReviewJobRecord): number {
  if (row.kind === "review") return row.prNumber;
  if (typeof row.issueNumber === "number" && Number.isFinite(row.issueNumber) && row.issueNumber !== 0) {
    return row.issueNumber;
  }
  return row.prNumber;
}

function inflightItem(row: ReviewJobRecord): BoardItem {
  const item: BoardItem = {
    reason: `${row.kind} ${row.state}`,
    owner: row.owner,
    repo: row.repo,
    number: primaryNumber(row),
    kind: row.kind,
  };
  const sha = (row.headSha ?? "").trim();
  if (sha !== "") {
    item.commit = sha;
    item.headSha = sha;
  }
  return item;
}

function sitItem(sit: RouterSitRecord): { item: BoardItem; kickable: boolean } {
  const item: BoardItem = {
    reason: sit.reason,
    owner: sit.owner,
    repo: sit.repo,
    number: sit.number,
    kind: "sit",
    decidedAt: sit.decidedAt,
  };
  const kick = kickForSit(sit.reason);
  if (kick) item.kick = kick;
  return { item, kickable: kick !== undefined };
}

export interface BoardStore {
  listInflight(limit?: number): Promise<ReviewJobRecord[]>;
  sits: { list(): Promise<RouterSitRecord[]> };
}

export async function buildBoardGroups(store: BoardStore): Promise<BoardGroups> {
  const [inflight, sits] = await Promise.all([store.listInflight(200), store.sits.list()]);
  const in_progress = inflight.map(inflightItem);
  const needs_kick: BoardItem[] = [];
  const sitting: BoardItem[] = [];
  for (const sit of sits) {
    const { item, kickable } = sitItem(sit);
    if (kickable) needs_kick.push(item);
    else sitting.push(item);
  }
  return { in_progress, needs_kick, sitting };
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
  /** Server-configured forge name (gitea or github). Used for filtering and links. */
  forge?: string;
  /** Server-configured forge origin for links. Rendered as href only, never fetched. */
  forgeUrl?: string;
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
 * - Phone: two lists (In progress, Sitting). Reason is the headline. A Kick
 *   button renders only when the payload carries `kick`. Sitting on purpose
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
<div id="sheet" role="dialog" aria-modal="true" aria-label="Confirm kick"></div>
</div>
<script>
const PAGE_CATALOG = ${JSON.stringify(catalog)};
const state = { data: null, selected: null, forge: "gitea", catalogOk: true };
const $ = (id) => document.getElementById(id);
const narrow = () => !window.matchMedia("(min-width: 700px)").matches;
function keyOf(item) { const forge = item.forge || (state.data && state.data.forge) || "gitea"; return forge + "/" + item.owner + "/" + item.repo + "/" + item.kind + "#" + item.number; }
function groupsOf(data) {
  const inProgress = data.in_progress || data.inProgress || [];
  const needsKick = data.needs_kick || data.needsKick || [];
  const sitting = data.sitting || data.sitting_on_purpose || [];
  return { inProgress, sitting: [...needsKick, ...sitting] };
}
function forgeOf(item, data) { return item.forge || data.forge || "gitea"; }
function forgeHref(item, data) {
  const base = (data.forgeUrl || "").replace(/\\/+$/, "");
  if (!base) return null;
  if (item.kind === "sit") return null;
  const forge = forgeOf(item, data);
  const path = item.kind === "review" ? (forge === "github" ? "pull" : "pulls") : "issues";
  return base + "/" + item.owner + "/" + item.repo + "/" + path + "/" + item.number;
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
function rowItem(item, opts) {
  const li = document.createElement("li");
  li.className = "row" + (state.selected === keyOf(item) ? " selected" : "");
  const head = document.createElement("div");
  head.className = "row-head";
  const h = document.createElement("p");
  h.className = "reason";
  h.textContent = item.reason;
  head.appendChild(h);
  li.appendChild(head);
  const sub = document.createElement("div");
  sub.className = "sub";
  let subText = item.owner + "/" + item.repo + "#" + item.number + " · " + item.kind;
  if (item.commit) subText += " · " + String(item.commit).slice(0, 8);
  sub.textContent = subText;
  li.appendChild(sub);
  const hasKick = Boolean(item.kick && typeof item.kick.effect === "string" && item.kick.effect.trim() !== "");
  if (opts.section === "sitting" && hasKick && state.catalogOk) {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Kick";
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); state.selected = keyOf(item); render(); openConfirm(item); });
    actions.appendChild(btn);
    li.appendChild(actions);
  } else if (opts.section === "sitting" && !hasKick) {
    const line = document.createElement("div");
    line.className = "status-line";
    line.textContent = "Sitting on purpose · " + item.reason;
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
  const hasKick = Boolean(item.kick && typeof item.kick.effect === "string");
  if (hasKick && state.catalogOk) {
    const note = document.createElement("p");
    note.className = "consequence";
    note.textContent = "This will: " + item.kick.effect;
    wrap.appendChild(note);
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "primary";
    primary.id = confirmIdPrefix + "-confirm";
    primary.textContent = "Confirm kick";
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
        const res = await fetch("/api/board/kick", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ owner: item.owner, repo: item.repo, number: item.number })
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
  title.textContent = item.reason;
  box.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "sub";
  let subText = item.owner + "/" + item.repo + "#" + item.number + " · " + item.kind + " · " + forgeOf(item, data);
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
  title.textContent = item.reason;
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
  const forgeName = deps.forge ?? "gitea";
  const forgeUrl = deps.forgeUrl ?? "";
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    const pathname = normalizePathname(url.pathname);
    // Kick commit: same origin POST. Only a sit the server marked kickable
    // can be cleared. The client never invents kick ids; identity is
    // owner/repo/number and the server re-checks kickability.
    if (pathname === BOARD_KICK_PATH) {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      if (!hasEdgeIdentity(request)) return json(401, { error: "missing edge identity" });
      const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") return json(400, { error: "invalid kick payload" });
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json(403, { error: "forbidden" });
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid kick payload" });
      }
      const record = payload as { owner?: unknown; repo?: unknown; number?: unknown };
      const owner = typeof record.owner === "string" ? record.owner.trim() : "";
      const repo = typeof record.repo === "string" ? record.repo.trim() : "";
      const number = typeof record.number === "number" ? record.number : Number.NaN;
      if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
        return json(400, { error: "invalid kick payload" });
      }
      let sit: RouterSitRecord | undefined;
      try {
        sit = await deps.store.sits.get(owner, repo, number);
      } catch (err) {
        logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return json(503, { error: "queue unavailable" });
      }
      if (!sit) return json(404, { error: "sit not found" });
      const kick = kickForSit(sit.reason);
      if (!kick) return json(409, { error: "no kick for this row" });
      try {
        await deps.store.sits.clear(owner, repo, number);
      } catch (err) {
        logger(`board unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return json(503, { error: "queue unavailable" });
      }
      logger(`board kick ${owner}/${repo}#${number} ${sit.reason}`);
      return json(200, { ok: true, owner, repo, number, effect: kick.effect });
    }
    if (pathname === BOARD_API_PATH) {
      if (request.method !== "GET") return json(405, { error: "method not allowed" });
      // Edge identity only. The webhook HMAC secret and auth token are not accepted here.
      if (!hasEdgeIdentity(request)) return json(401, { error: "missing edge identity" });
      let groups: BoardGroups;
      try {
        groups = withForgeGroups(await buildBoardGroups(deps.store), forgeName);
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
        forge: forgeName,
        forgeUrl,
        catalog: BOARD_KICK_CATALOG_VERSION,
      };
      if (grantLine) body.grant = grantLine;
      return json(200, body);
    }
    if (BOARD_PAGE_PATHS.has(pathname)) {
      if (request.method !== "GET") return json(405, { error: "method not allowed" });
      if (!hasEdgeIdentity(request)) return json(401, { error: "missing edge identity" });
      return pageResponse(renderBoardPage(BOARD_KICK_CATALOG_VERSION));
    }
    return json(404, { error: "not found" });
  };
}
