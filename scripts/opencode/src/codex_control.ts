import { chmod, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { codexAuthPath } from "./codex_auth.ts";

/**
 * Codex control-plane auth: one `control` replica owns the ChatGPT refresh
 * grant and publishes a token-only `auth.json` to a Kubernetes Secret.
 *
 * Job pods hold no refresh token. `control` refreshes when the remaining
 * access-token life drops below a fraction of its total lifetime, writes the
 * rotated pair atomically and durably (never only in memory), then publishes:
 *
 * ```json
 * {
 *   "auth_mode": "chatgpt",
 *   "tokens": {
 *     "id_token": "<current>",
 *     "access_token": "<current>",
 *     "refresh_token": "",
 *     "account_id": "<current>"
 *   },
 *   "last_refresh": "<iso>"
 * }
 * ```
 *
 * The shape is the one `src/codex_token_probe.ts` proves against the pinned
 * binary: `refresh_token: ""` runs with the seeded bearer and zero token
 * POSTs while `exp` is far off; a missing key, a missing `last_refresh`, or
 * a two-part `id_token` starts logged out. Publishing refuses any document
 * that fails that shape, and no published document ever contains a refresh
 * token.
 *
 * Refresh is a plain authenticated HTTP POST to the same token endpoint the
 * pinned binary uses (`https://auth.openai.com/oauth/token` with the public
 * `app_EMoamEEZ73f0CkXaXp7hrann` client id), overridable for tests with
 * `CODEX_REFRESH_TOKEN_URL_OVERRIDE` — the same env name the binary reads.
 * The binary offers no headless refresh command (`codex login` is device-auth
 * only), so this follows the durable write path in `src/xai_auth.ts` instead
 * of asking the binary to refresh.
 */

export const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";

/**
 * Refresh when remaining life drops below this fraction of total lifetime.
 * Total lifetime is `exp - last_refresh` (the `last_refresh` the login wrote,
 * not a hardcoded number of days: a 5-day point would refresh on every loop
 * when the real lifetime is shorter). Access tokens are ~1h, so 0.25 means
 * ~15min remaining — before the binary's own 5-minute proactive window, so
 * job pods never trigger a refresh.
 */
export const CODEX_REFRESH_THRESHOLD_FRACTION = 0.25;

/** Cap on the one refresh POST. Runs on the control loop, not per job. */
export const CODEX_TOKEN_TIMEOUT_MS = 30_000;

/** Max bytes of a token-endpoint error body kept for classification. Never logged with tokens. */
const MAX_ERROR_BODY = 8_000;

/** K8s Secret data key job pods mount. */
export const CODEX_SECRET_DATA_KEY = "auth.json";

export type CodexAuthFile = Record<string, unknown>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CodexGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexGrantError";
  }
}

/** The token endpoint answered 401 with a terminal refresh code: re-login, do not retry. */
export class CodexLoginDeadError extends CodexGrantError {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "CodexLoginDeadError";
    this.reason = reason;
  }
}

export class CodexPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPublishError";
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function jwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** `exp` of a JWT access token, in ms. Undefined when not a readable JWT. */
export function codexAccessExpiryMs(token: string | undefined): number | undefined {
  const payload = jwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  return exp * 1000;
}

function codexIssuedAtMs(token: string | undefined): number | undefined {
  const payload = jwtPayload(token);
  const iat = payload?.iat;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return undefined;
  return iat * 1000;
}

export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  account_id?: string;
}

function readTokens(auth: CodexAuthFile): CodexTokens | undefined {
  const raw = auth.tokens;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (!nonEmptyString(rec.access_token) || !nonEmptyString(rec.id_token)) return undefined;
  if (typeof rec.refresh_token !== "string") return undefined;
  const out: CodexTokens = {
    access_token: rec.access_token,
    refresh_token: rec.refresh_token,
    id_token: rec.id_token,
  };
  if (nonEmptyString(rec.account_id)) out.account_id = rec.account_id;
  return out;
}

function lastRefreshMs(auth: CodexAuthFile): number | undefined {
  const raw = auth.last_refresh;
  if (!nonEmptyString(raw)) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Total access-token lifetime in ms: `exp - last_refresh`, falling back to
 * `exp - iat` when the file has no parseable `last_refresh` (older logins).
 * Undefined when neither start is known — callers treat that as needs-refresh
 * rather than inventing a lifetime.
 */
export function codexTokenLifetimeMs(auth: CodexAuthFile): number | undefined {
  const tokens = readTokens(auth);
  const exp = codexAccessExpiryMs(tokens?.access_token);
  if (exp == null) return undefined;
  const start = lastRefreshMs(auth) ?? codexIssuedAtMs(tokens?.access_token);
  if (start == null) return undefined;
  const lifetime = exp - start;
  return lifetime > 0 ? lifetime : undefined;
}

export function codexAccessRemainingMs(auth: CodexAuthFile, nowMs: number): number | undefined {
  const tokens = readTokens(auth);
  const exp = codexAccessExpiryMs(tokens?.access_token);
  if (exp == null) return undefined;
  return exp - nowMs;
}

/**
 * Refresh when remaining life drops below `fraction` of total lifetime.
 * No expiry at all is "does not cover": refresh. Unknown lifetime is also
 * refresh (fail closed toward a live grant, never toward a stale bearer).
 */
export function shouldRefreshCodex(
  auth: CodexAuthFile,
  nowMs: number,
  fraction: number = CODEX_REFRESH_THRESHOLD_FRACTION
): boolean {
  const tokens = readTokens(auth);
  if (!tokens) return false;
  if (!tokens.refresh_token) return false;
  const exp = codexAccessExpiryMs(tokens.access_token);
  if (exp == null) return true;
  const remaining = exp - nowMs;
  if (remaining <= 0) return true;
  const lifetime = codexTokenLifetimeMs(auth);
  if (lifetime == null) return true;
  return remaining < fraction * lifetime;
}

export function codexRefreshTokenUrl(override?: string): string {
  const envOverride = process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV]?.trim();
  if (nonEmptyString(override)) return override.trim();
  if (nonEmptyString(envOverride)) return envOverride;
  return CODEX_REFRESH_TOKEN_URL;
}

export interface CodexRefreshResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
}

function scrubbedBodyText(text: string): string {
  // Error bodies can echo request fields on some backends. Keep the
  // classification signal (error codes) without keeping token material.
  // The caller never logs the raw body; this is only for the thrown message.
  return text
    .replace(/"refresh_token"\s*:\s*"[^"]*"/gi, '"refresh_token":"[redacted]"')
    .replace(/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"[redacted]"')
    .replace(/"id_token"\s*:\s*"[^"]*"/gi, '"id_token":"[redacted]"')
    .slice(0, MAX_ERROR_BODY);
}

/**
 * Terminal refresh codes: any 401 from the token endpoint means the refresh
 * grant is unusable and retrying will not help (upstream treats every 401 as
 * permanent: unknown codes become `Other` → fail fast). Known codes keep
 * their name; an unrecognized 401 still stops refresh as `unauthorized`.
 * Returns the matched reason, or undefined when the status is not 401.
 */
export function codexLoginDeathReason(status: number, body: string): string | undefined {
  if (status !== 401) return undefined;
  const lower = body.toLowerCase();
  if (lower.includes("refresh_token_reused")) return "refresh_token_reused";
  if (lower.includes("refresh_token_expired")) return "refresh_token_expired";
  if (lower.includes("refresh_token_invalidated")) return "refresh_token_invalidated";
  if (lower.includes("invalid_refresh_token")) return "invalid_refresh_token";
  return "unauthorized";
}

export async function postCodexRefresh(
  refreshToken: string,
  deps: { fetchImpl?: FetchLike; tokenUrl?: string } = {}
): Promise<{ accessToken: string; refreshToken?: string; idToken?: string }> {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = deps.tokenUrl ?? codexRefreshTokenUrl();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(CODEX_TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CodexGrantError(
      `Codex token refresh transport failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const death = codexLoginDeathReason(response.status, raw);
    if (death) {
      throw new CodexLoginDeadError(death, `Codex refresh token is dead (${death}); run Codex login again`);
    }
    throw new CodexGrantError(
      `Codex token refresh failed (${response.status})${raw ? `: ${scrubbedBodyText(raw)}` : ""}`
    );
  }
  let parsed: CodexRefreshResponse;
  try {
    parsed = (await response.json()) as CodexRefreshResponse;
  } catch {
    throw new CodexGrantError("Codex token refresh returned non-JSON");
  }
  if (!nonEmptyString(parsed.access_token)) {
    throw new CodexGrantError("Codex token refresh response has no access_token");
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
    idToken: typeof parsed.id_token === "string" ? parsed.id_token : undefined,
  };
}

export async function durableCodexAuthPath(home: string): Promise<string> {
  const path = codexAuthPath(home);
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function readCodexAuthFile(path: string): Promise<CodexAuthFile> {
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
    throw new Error(`Codex auth file must contain a JSON object: ${path}`);
  }
  return parsed as CodexAuthFile;
}

function tmpSiblingPath(path: string): string {
  return join(dirname(path), `${basename(path)}.jumi-${crypto.randomUUID()}.tmp`);
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
 * Atomic, durable Codex auth write: sibling + fsync + rename + re-read.
 * Mirrors `writeDurableAuth` in `src/xai_auth.ts`. Callers treat a throw as
 * "the new pair is not durable".
 */
export async function writeCodexAuthDurably(path: string, auth: CodexAuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
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
  const reread = await readCodexAuthFile(path);
  if (JSON.stringify(reread.tokens) !== JSON.stringify(auth.tokens)) {
    throw new Error(`Codex credential did not survive a re-read of ${path}`);
  }
}

/**
 * Build the token-only document job pods mount. The refresh grant never
 * leaves `control`: `refresh_token` is always `""`. Throws when the source
 * has no usable access/id/account to publish.
 */
export function buildTokenOnlyAuth(full: CodexAuthFile, lastRefreshIso?: string): CodexAuthFile {
  const tokens = readTokens(full);
  if (!tokens) throw new CodexPublishError("Codex auth has no tokens to publish");
  if (!nonEmptyString(tokens.account_id)) throw new CodexPublishError("Codex auth has no account_id to publish");
  const lastRefresh =
    nonEmptyString(lastRefreshIso) && Number.isFinite(Date.parse(lastRefreshIso))
      ? (lastRefreshIso as string)
      : typeof full.last_refresh === "string" && Number.isFinite(Date.parse(full.last_refresh))
        ? (full.last_refresh as string)
        : new Date().toISOString();
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: "",
      account_id: tokens.account_id,
    },
    last_refresh: lastRefresh,
  };
}

function isThreePartJwt(value: unknown): value is string {
  return typeof value === "string" && value.split(".").length === 3 && value.split(".").every((p) => p.trim() !== "");
}

/**
 * The publish gate: the exact shape `src/codex_token_probe.ts` proves. Any
 * document that fails this is refused and never reaches the Secret.
 */
export function isPublishableCodexAuth(doc: unknown): boolean {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const rec = doc as Record<string, unknown>;
  if (rec.auth_mode !== "chatgpt") return false;
  if (!nonEmptyString(rec.last_refresh) || !Number.isFinite(Date.parse(rec.last_refresh as string))) return false;
  const tokens = rec.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return false;
  const t = tokens as Record<string, unknown>;
  if (t.refresh_token !== "") return false;
  if (!isThreePartJwt(t.access_token)) return false;
  if (!isThreePartJwt(t.id_token)) return false;
  if (!nonEmptyString(t.account_id)) return false;
  return true;
}

/** Fail closed: no published document may carry a refresh token. */
export function assertNoRefreshToken(doc: unknown, realRefresh?: string): void {
  const text = JSON.stringify(doc ?? {});
  if (/"refresh_token"\s*:\s*"(?!")/.test(text)) {
    throw new CodexPublishError("Refusing to publish a Codex document holding a refresh token");
  }
  if (nonEmptyString(realRefresh) && text.includes(realRefresh as string)) {
    throw new CodexPublishError("Refusing to publish a Codex document holding refresh material");
  }
}

export interface K8sPublishDeps {
  apiUrl: string;
  namespace: string;
  secretName: string;
  token: string;
  fetchImpl?: FetchLike;
  dataKey?: string;
}

export function k8sSecretUrl(apiUrl: string, namespace: string, secretName: string): string {
  const base = apiUrl.replace(/\/+$/, "");
  return `${base}/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(secretName)}`;
}

function b64encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Atomic Secret update through plain authenticated HTTP: GET for
 * `resourceVersion`, then PUT the full object (or POST when missing). No
 * Kubernetes client library. Refuses documents that fail the publish shape.
 * Never logs tokens.
 */
export async function publishTokenOnlyAuth(doc: CodexAuthFile, deps: K8sPublishDeps): Promise<void> {
  if (!isPublishableCodexAuth(doc)) {
    throw new CodexPublishError("Refusing to publish a Codex document that fails the token-only shape");
  }
  assertNoRefreshToken(doc);
  const key = deps.dataKey ?? CODEX_SECRET_DATA_KEY;
  const payload = `${JSON.stringify(doc, null, 2)}\n`;
  const data = { [key]: b64encode(payload) };
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${deps.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const url = k8sSecretUrl(deps.apiUrl, deps.namespace, deps.secretName);
  let resourceVersion: string | undefined;
  try {
    const existing = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
    if (existing.ok) {
      const parsed = (await existing.json()) as { metadata?: { resourceVersion?: unknown } };
      if (typeof parsed?.metadata?.resourceVersion === "string") {
        resourceVersion = parsed.metadata.resourceVersion;
      }
    } else if (existing.status !== 404) {
      const body = (await existing.text().catch(() => "")).slice(0, 500);
      throw new CodexPublishError(`Codex Secret read failed (${existing.status})${body ? `: ${body}` : ""}`);
    }
  } catch (err) {
    if (err instanceof CodexPublishError) throw err;
    throw new CodexPublishError(`Codex Secret read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body: Record<string, unknown> = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: deps.secretName,
      namespace: deps.namespace,
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    type: "Opaque",
    data,
  };
  let response: Response;
  try {
    if (resourceVersion) {
      response = await fetchImpl(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } else {
      response = await fetchImpl(
        `${deps.apiUrl.replace(/\/+$/, "")}/api/v1/namespaces/${encodeURIComponent(deps.namespace)}/secrets`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        }
      );
    }
  } catch (err) {
    throw new CodexPublishError(`Codex Secret write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (response.status === 409 && resourceVersion) {
    throw new CodexPublishError("Codex Secret write conflicted; retry the publish");
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 500);
    throw new CodexPublishError(`Codex Secret write failed (${response.status})${text ? `: ${text}` : ""}`);
  }
}

// ---- metrics ----

export interface CodexControlSnapshot {
  remainingSeconds?: number;
  lifetimeSeconds?: number;
  lastRefreshTimestampSeconds?: number;
  loginDead: boolean;
  loginDeadReason?: string;
  publishFailures: number;
  lastPublishTimestampSeconds?: number;
}

const controlSnapshot: CodexControlSnapshot = {
  loginDead: false,
  publishFailures: 0,
};

export function resetCodexControlMetricsForTests(): void {
  controlSnapshot.remainingSeconds = undefined;
  controlSnapshot.lifetimeSeconds = undefined;
  controlSnapshot.lastRefreshTimestampSeconds = undefined;
  controlSnapshot.loginDead = false;
  controlSnapshot.loginDeadReason = undefined;
  controlSnapshot.publishFailures = 0;
  controlSnapshot.lastPublishTimestampSeconds = undefined;
}

export function setCodexControlSnapshot(patch: Partial<CodexControlSnapshot>): void {
  Object.assign(controlSnapshot, patch);
}

export function getCodexControlSnapshot(): CodexControlSnapshot {
  return { ...controlSnapshot };
}

function fmtInt(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-1";
  return String(Math.floor(value));
}

export function renderCodexControlMetrics(): string {
  const s = controlSnapshot;
  const lines = [
    "# HELP codex_access_token_seconds_remaining Seconds until the Codex access token expires (-1 unknown)",
    "# TYPE codex_access_token_seconds_remaining gauge",
    `codex_access_token_seconds_remaining ${fmtInt(s.remainingSeconds)}`,
    "# HELP codex_access_token_lifetime_seconds Total Codex access token lifetime in seconds (-1 unknown)",
    "# TYPE codex_access_token_lifetime_seconds gauge",
    `codex_access_token_lifetime_seconds ${fmtInt(s.lifetimeSeconds)}`,
    "# HELP codex_last_refresh_timestamp_seconds Unix time of the last successful Codex refresh (0 never)",
    "# TYPE codex_last_refresh_timestamp_seconds gauge",
    `codex_last_refresh_timestamp_seconds ${s.lastRefreshTimestampSeconds ?? 0}`,
    "# HELP codex_login_dead 1 when the Codex refresh grant is dead (re-login required)",
    "# TYPE codex_login_dead gauge",
  ];
  if (s.loginDeadReason) {
    const reason = s.loginDeadReason.replaceAll("\\", "\\\\").replaceAll('"', '\\"').slice(0, 64);
    lines.push(`codex_login_dead{reason="${reason}"} 1`);
  } else {
    lines.push(`codex_login_dead ${s.loginDead ? 1 : 0}`);
  }
  lines.push(
    "# HELP codex_publish_failures_total Failed Codex Secret publishes",
    "# TYPE codex_publish_failures_total counter",
    `codex_publish_failures_total ${s.publishFailures}`
  );
  if (s.lastPublishTimestampSeconds != null) {
    lines.push(
      "# HELP codex_last_publish_timestamp_seconds Unix time of the last successful Codex Secret publish",
      "# TYPE codex_last_publish_timestamp_seconds gauge",
      `codex_last_publish_timestamp_seconds ${s.lastPublishTimestampSeconds}`
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One-line operator notice when the refresh grant is dead. No tokens. */
export function codexLoginDeadNotice(): string | undefined {
  if (!controlSnapshot.loginDead) return undefined;
  const reason = controlSnapshot.loginDeadReason ?? "refresh grant refused";
  return `Codex login dead (${reason}); run Codex sign-in on control to restore`;
}
