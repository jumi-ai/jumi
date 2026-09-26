import { createHash } from "node:crypto";
import { chmod, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { opencodeAuthPath } from "./opencode_auth.ts";

/**
 * The long-lived process owns the xAI refresh grant.
 *
 * Upstream OpenCode refreshes from inside the child: it POSTs the refresh
 * token, keeps the rotated pair in memory, and persists it best-effort with no
 * flush on exit. A review that is killed — timeout, quota abort, unassign, pod
 * restart — therefore rotates the grant and takes the new refresh token with
 * it. The next process reads a refresh token xAI no longer accepts and Grok is
 * dead until a human runs `/connect`.
 *
 * So the parent refreshes instead, on the durable auth file, before the child
 * starts, and hands the child a credential that can call the model but cannot
 * refresh. A child exit cannot burn the grant.
 */

export const XAI_PROVIDER_ID = "xai";

/**
 * Device-flow token endpoint and public client id, read out of the installed
 * OpenCode binary (`auth.x.ai` strings in `opencode` 1.15.5) so the parent
 * presents the same grant the child would have. The client id is public — it
 * ships in every OpenCode build — and is not a secret.
 */
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

/**
 * OpenCode refreshes when the access token is within this much of expiry. The
 * parent must not leave a child inside that window: the child would refresh and
 * lose the rotated pair, which is the whole failure this module prevents.
 * Measured against the installed binary (its own 120s constant).
 */
export const OPENCODE_REFRESH_SKEW_MS = 120_000;

/** Clock margin between this pod and xAI on top of the skew. */
export const CLOCK_MARGIN_MS = 60_000;

/** Access tokens last 6 hours (measured 2026-09-22: `expires_in` 21600). */
export const XAI_DEFAULT_EXPIRES_IN_SECONDS = 21_600;

/** Cap on the one refresh POST, which runs under the per-process lock. */
export const XAI_TOKEN_TIMEOUT_MS = 30_000;

/** Marks a sibling written by {@link writeDurableAuth}; see `adoptOrphanXaiSibling`. */
const TMP_INFIX = ".jumi-";
const TMP_SUFFIX = ".tmp";

export type XaiChildAuthShape = "api" | "oauth";

/**
 * The shape the child is handed. Not operator config: `src/xai_child_auth_probe.ts`
 * fails the image job when the installed binary stops accepting it, which is
 * where this would be flipped to `oauth` — see {@link XaiChildCredential}.
 */
export const XAI_CHILD_AUTH_SHAPE: XaiChildAuthShape = "api";

/** What the durable auth file holds for a SuperGrok subscription. */
export interface XaiOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires?: number;
}

/**
 * What the child gets. `api` is the shipped shape: OpenCode sends it as
 * `Authorization: Bearer <key>` and never enters the refresh path, proved
 * against the installed binary by `src/xai_child_auth_probe.ts`.
 *
 * `oauth` (access + expiry, no refresh field) is the documented fallback for an
 * OpenCode that stops accepting `api` for this provider. Measured against
 * OpenCode 1.15.5 it is rejected before any request is made ("xAI API key is
 * missing"), which still fails that one review closed rather than presenting
 * the parent's refresh token — but it is not the shape to reach for first.
 */
export type XaiChildCredential = { type: "api"; key: string } | { type: "oauth"; access: string; expires: number };

export type AuthFile = Record<string, unknown>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface XaiTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Fail closed: no Grok this job, and the caller must not POST the grant again. */
export class XaiGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XaiGrantError";
  }
}

/**
 * The token endpoint answered with a non-success status, or a 2xx with no
 * access token. Only a 400 or 401 means the grant is spent.
 */
export class XaiRefreshRejected extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`xAI token refresh failed (${status})${body ? `: ${body}` : ""}`);
    this.name = "XaiRefreshRejected";
    this.status = status;
  }
}

/**
 * Per-process state. `rejectedGrants` keys on the refresh token xAI refused, so
 * a second job in this process cannot POST the same dead grant; a human
 * `/connect` writes a different refresh token and is not latched.
 * `unwrittenPairs` holds a rotated pair whose durable write failed, keyed by the
 * refresh token still on the file, so the next attempt retries the write of the
 * token already in memory instead of POSTing a second time.
 */
const rejectedGrants = new Set<string>();
const unwrittenPairs = new Map<string, XaiOAuthCredential>();
let queue: Promise<unknown> = Promise.resolve();

export function resetXaiAuthStateForTests(): void {
  rejectedGrants.clear();
  unwrittenPairs.clear();
  queue = Promise.resolve();
}

function grantKey(refresh: string): string {
  return createHash("sha256").update(refresh).digest("hex");
}

export function hasLatchedXaiGrant(): boolean {
  return rejectedGrants.size > 0;
}

/**
 * One-line operator notice when this process already knows the xAI refresh
 * grant is spent. Single line, no secrets: the board renders it as one row,
 * never as a banner. Undefined when the process knows of no grant problem.
 */
export function latchedXaiGrantNotice(): string | undefined {
  if (!hasLatchedXaiGrant()) return undefined;
  return "xAI refresh grant refused; run /connect to restore Grok";
}

export function isXaiModel(model: string | undefined): boolean {
  return (model ?? "").split("/")[0] === XAI_PROVIDER_ID;
}

/** `exp` of a JWT access token, in ms. Undefined when it is not a readable JWT. */
export function jwtExpiryMs(token: string | undefined): number | undefined {
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { exp?: unknown };
    if (typeof claims?.exp !== "number" || !Number.isFinite(claims.exp)) return undefined;
    return claims.exp * 1000;
  } catch {
    return undefined;
  }
}

/** The earlier of the access token's own expiry and the stored expiry. */
export function credentialExpiryMs(entry: { access?: string; expires?: number } | undefined): number | undefined {
  const stored = typeof entry?.expires === "number" && Number.isFinite(entry.expires) ? entry.expires : undefined;
  const claimed = jwtExpiryMs(entry?.access);
  if (stored == null) return claimed;
  if (claimed == null) return stored;
  return Math.min(stored, claimed);
}

/**
 * The job's timeout, plus the window OpenCode would refresh in, plus clock
 * margin. A token with less remaining life than this does not cover the job.
 */
export function jobBudgetMs(timeoutMs: number | undefined): number {
  const job = timeoutMs && timeoutMs > 0 ? timeoutMs : 0;
  return job + OPENCODE_REFRESH_SKEW_MS + CLOCK_MARGIN_MS;
}

/** No expiry at all is treated as "does not cover": refresh. */
export function coversJob(entry: { access?: string; expires?: number }, budgetMs: number, now: number): boolean {
  const expiry = credentialExpiryMs(entry);
  if (expiry == null) return false;
  return expiry - now >= budgetMs;
}

export function childXaiCredential(entry: XaiOAuthCredential, shape: XaiChildAuthShape): XaiChildCredential {
  if (shape === "oauth") {
    return { type: "oauth", access: entry.access, expires: entry.expires ?? 0 };
  }
  return { type: "api", key: entry.access };
}

function asXaiGrantEntry(value: unknown): XaiOAuthCredential | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as { type?: unknown; access?: unknown; refresh?: unknown; expires?: unknown };
  if (entry.type !== "oauth" || typeof entry.access !== "string" || !entry.access) return undefined;
  return {
    type: "oauth",
    access: entry.access,
    refresh: typeof entry.refresh === "string" ? entry.refresh : "",
    expires: typeof entry.expires === "number" ? entry.expires : undefined,
  };
}

/**
 * The file a durable write must land on.
 *
 * On the homelab the path the process reads is a symlink onto a Retain volume,
 * and init deletes and recreates that symlink on every start — a write that
 * replaces the symlink with a regular file is gone after restart. Resolving it
 * first keeps the symlink intact, so a human `/connect` (exec, HOME on the
 * ephemeral volume) still updates the same file. On the GitHub factory HOME is
 * already the Retain volume and this resolves to itself.
 */
export async function durableAuthPath(home: string): Promise<string> {
  const path = opencodeAuthPath(home);
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function readAuthFile(path: string): Promise<AuthFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {};
    throw err;
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenCode auth file must contain a JSON object: ${path}`);
  }
  return parsed as AuthFile;
}

export function readXaiCredential(auth: AuthFile): XaiOAuthCredential | undefined {
  return asXaiGrantEntry(auth[XAI_PROVIDER_ID]);
}

function tmpSiblingPath(path: string): string {
  return join(dirname(path), `${basename(path)}${TMP_INFIX}${crypto.randomUUID()}${TMP_SUFFIX}`);
}

function isTmpSibling(name: string, base: string): boolean {
  return name.startsWith(`${base}${TMP_INFIX}`) && name.endsWith(TMP_SUFFIX);
}

async function fsyncDir(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some filesystems; the rename still
    // ordered the data, and the verifying re-read below is the real gate.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Write the whole auth file to a sibling, fsync it, rename it into place, then
 * re-read and confirm. Callers treat a throw as "the new pair is not durable":
 * the pair stays in memory and the next attempt retries this write.
 */
export async function writeDurableAuth(path: string, auth: AuthFile): Promise<void> {
  const tmp = tmpSiblingPath(path);
  const text = `${JSON.stringify(auth, null, 2)}\n`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await chmod(path, 0o600).catch(() => undefined);
  await fsyncDir(dirname(path));

  const reread = await readAuthFile(path);
  if (JSON.stringify(reread[XAI_PROVIDER_ID]) !== JSON.stringify(auth[XAI_PROVIDER_ID])) {
    throw new Error(`xAI credential did not survive a re-read of ${path}`);
  }
}

/**
 * Prove `dirname(path)` takes a sibling the way {@link writeDurableAuth} makes
 * one: open, write, fsync, close, remove. Run before a POST so a directory that
 * cannot take the rotated pair fails closed while the grant on the file is live.
 * Not `access(W_OK)`: that passes on a full filesystem.
 */
async function probeSiblingWrite(path: string): Promise<void> {
  const tmp = tmpSiblingPath(path);
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile("\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * A completed write whose rename did not land leaves a sibling holding a refresh
 * token that is newer than the one on the file — and xAI has already rotated
 * away from the file's. Adopt it on startup, before any refresh, so the process
 * does not POST a grant the sibling already replaced.
 */
export async function adoptOrphanXaiSibling(home: string, logger?: (message: string) => void): Promise<boolean> {
  const path = await durableAuthPath(home);
  const dir = dirname(path);
  const base = basename(path);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  const siblings = names.filter((name) => isTmpSibling(name, base)).map((name) => join(dir, name));
  if (siblings.length === 0) return false;

  const current = readXaiCredential(await readAuthFile(path).catch(() => ({})));
  let bestPath: string | undefined;
  let bestExpires = credentialExpiryMs(current) ?? 0;
  for (const sibling of siblings) {
    const candidate = readXaiCredential(await readAuthFile(sibling).catch(() => ({})));
    if (!candidate?.refresh) continue;
    const expires = credentialExpiryMs(candidate) ?? 0;
    if (expires <= bestExpires) continue;
    bestPath = sibling;
    bestExpires = expires;
  }

  let adopted = false;
  if (bestPath) {
    await rename(bestPath, path);
    await chmod(path, 0o600).catch(() => undefined);
    await fsyncDir(dir);
    adopted = true;
    logger?.(`adopted a newer xAI credential from an unrenamed sibling at ${path}`);
  }
  for (const sibling of siblings) {
    if (sibling === bestPath) continue;
    await rm(sibling, { force: true }).catch(() => undefined);
  }
  return adopted;
}

/**
 * One POST. Callers must never make a second one for the same grant.
 *
 * Bounded: this runs under the per-process lock, so a token endpoint that never
 * answers would stall every other job behind it, not just this one.
 */
export async function postXaiRefresh(
  refresh: string,
  deps: { fetchImpl?: FetchLike; tokenUrl?: string } = {}
): Promise<XaiTokenResponse> {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(deps.tokenUrl ?? XAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: XAI_CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(XAI_TOKEN_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new XaiRefreshRejected(response.status, body);
  }
  const parsed = (await response.json()) as XaiTokenResponse;
  if (!parsed?.access_token) throw new XaiRefreshRejected(response.status, "response has no access_token");
  return parsed;
}

export interface EnsureXaiCredentialOptions {
  home: string;
  /** The job's own timeout; the budget is this plus skew plus clock margin. */
  timeoutMs?: number;
  childShape?: XaiChildAuthShape;
  now?: () => number;
  fetchImpl?: FetchLike;
  tokenUrl?: string;
  logger?: (message: string) => void;
}

export interface XaiJobCredential {
  /** The durable file this credential came from. */
  path: string;
  /** What to seed into the child's isolated auth file. */
  child: XaiChildCredential;
  refreshed: boolean;
}

async function persist(path: string, auth: AuthFile, pair: XaiOAuthCredential): Promise<void> {
  await writeDurableAuth(path, { ...auth, [XAI_PROVIDER_ID]: pair });
}

function assertCoversJob(pair: XaiOAuthCredential, budgetMs: number, now: number): void {
  if (coversJob(pair, budgetMs, now)) return;
  throw new XaiGrantError(
    `xAI access token still does not cover a ${budgetMs}ms job after a verified refresh; not starting Grok`
  );
}

function isSpentGrantStatus(status: number): boolean {
  return status === 400 || status === 401;
}

async function ensureLocked(opts: EnsureXaiCredentialOptions): Promise<XaiJobCredential | undefined> {
  const now = opts.now ?? (() => Date.now());
  const path = await durableAuthPath(opts.home);
  const auth = await readAuthFile(path);
  const entry = readXaiCredential(auth);
  // No entry, or an API key rather than a subscription: nothing to own here.
  if (!entry) return undefined;

  const budgetMs = jobBudgetMs(opts.timeoutMs);
  const shape = opts.childShape ?? XAI_CHILD_AUTH_SHAPE;

  if (entry.refresh) {
    const pending = unwrittenPairs.get(grantKey(entry.refresh));
    if (pending) {
      // xAI already rotated away from the pair on the file. Retry the write of
      // the token in memory; never POST a second time for it.
      opts.logger?.("retrying the durable write of an already-rotated xAI credential");
      await persist(path, auth, pending);
      unwrittenPairs.delete(grantKey(entry.refresh));
      assertCoversJob(pending, budgetMs, now());
      return { path, child: childXaiCredential(pending, shape), refreshed: true };
    }
  }

  if (coversJob(entry, budgetMs, now())) {
    return { path, child: childXaiCredential(entry, shape), refreshed: false };
  }

  if (!entry.refresh) {
    throw new XaiGrantError("xAI access token does not cover this job and the auth file holds no refresh token");
  }
  const key = grantKey(entry.refresh);
  if (rejectedGrants.has(key)) {
    throw new XaiGrantError("xAI already refused this refresh token in this process; a human must run /connect");
  }

  try {
    await probeSiblingWrite(path);
  } catch (err) {
    // Nothing was POSTed: the grant on the file is still live and a later job
    // may try again once the directory takes a write.
    const reason = err instanceof Error ? err.message : String(err);
    throw new XaiGrantError(`cannot write a new xAI credential beside ${path}; not refreshing: ${reason}`);
  }

  let response: XaiTokenResponse;
  try {
    response = await postXaiRefresh(entry.refresh, { fetchImpl: opts.fetchImpl, tokenUrl: opts.tokenUrl });
  } catch (err) {
    // A 400 or 401 means the grant is spent; latch it so no later job POSTs it
    // again. Any other status (429, 5xx, a 2xx with no access token) or a
    // transport error proves nothing about the grant, so the job fails closed
    // without latching and a later job may POST again.
    if (err instanceof XaiRefreshRejected && isSpentGrantStatus(err.status)) rejectedGrants.add(key);
    throw new XaiGrantError(err instanceof Error ? err.message : String(err));
  }

  const pair: XaiOAuthCredential = {
    type: "oauth",
    access: response.access_token,
    refresh: response.refresh_token || entry.refresh,
    expires: now() + (response.expires_in ?? XAI_DEFAULT_EXPIRES_IN_SECONDS) * 1000,
  };
  // Held before the write so a failed write is retried, not re-POSTed.
  unwrittenPairs.set(key, pair);
  await persist(path, auth, pair);
  unwrittenPairs.delete(key);
  opts.logger?.(`refreshed the xAI access token on ${path} before starting the job`);
  assertCoversJob(pair, budgetMs, now());
  return { path, child: childXaiCredential(pair, shape), refreshed: true };
}

/**
 * Refresh at job start when the access token would not last the job, land the
 * new pair on the durable file, and return the credential for the child.
 *
 * Serialized per process, but only across this function: the lock is released
 * before the child starts, so a later job may rotate the grant while an earlier
 * child is still using its access token. Rotation does not revoke an access
 * token already issued.
 */
export function ensureXaiCredentialForJob(opts: EnsureXaiCredentialOptions): Promise<XaiJobCredential | undefined> {
  const run = queue.then(
    () => ensureLocked(opts),
    () => ensureLocked(opts)
  );
  queue = run.catch(() => undefined);
  return run;
}

/**
 * The child's copy of the auth file. The xAI subscription is replaced by a
 * credential with no refresh token — the one the parent just verified when it
 * has one, otherwise the same shape built from whatever is on the file, so a
 * child that never got a parent refresh still cannot rotate the grant.
 *
 * The child and the server are the same user, so this is not about hiding the
 * parent file: the grant is protected because what the child holds cannot
 * refresh. Other providers are copied through untouched.
 */
export function childAuthFile(
  auth: AuthFile,
  child?: XaiChildCredential,
  shape: XaiChildAuthShape = XAI_CHILD_AUTH_SHAPE
): AuthFile {
  const out: AuthFile = { ...auth };
  const entry = readXaiCredential(auth);
  const seeded = child ?? (entry ? childXaiCredential(entry, shape) : undefined);
  if (seeded) out[XAI_PROVIDER_ID] = seeded;
  return out;
}
