import { boardUsername, isAllowedBoardOrigin } from "./board.ts";

/**
 * Router-side proxy for one ordinal's Grok device login.
 *
 * The login process runs on the ordinal (engine/worker `:3010`); the router
 * is diskless and never runs it. The board polls the ordinal through these
 * routes and the operator starts/cancels through them. This is not a kick:
 * the paths are `/api/board/device-login/*`, never the kick route.
 *
 * - Constant ordinal port 3010, never via an environment variable. Keep in
 *   sync with `ORDINAL_DEVICE_LOGIN_PORT` in `device_login.ts`.
 * - The start control accepts no free-form command: the body carries only
 *   ordinal + role and the ordinal always runs one fixed invocation.
 * - The actor is the existing edge identity, never a field in the body. The
 *   router forwards the edge headers server-side; the ordinal reads the
 *   actor from them.
 * - Same-origin guard as every other board write: a foreign Origin is
 *   forbidden, reconstructed the same way the board already does.
 * - Responses never carry token material: only url, user code, expiry, and
 *   state. Logs record actor, ordinal, provider, and result only.
 * - The isolated GitHub factory has no control: the peer listener answers
 *   these paths with 404 and the page hides the section there.
 */

export const DEVICE_LOGIN_ORDINAL_PORT = 3010;
export const DEVICE_LOGIN_PROVIDER = "xai";

export const DEVICE_LOGIN_BOARD_STATUS_PATH = "/api/board/device-login/status";
export const DEVICE_LOGIN_BOARD_START_PATH = "/api/board/device-login/start";
export const DEVICE_LOGIN_BOARD_CANCEL_PATH = "/api/board/device-login/cancel";

const ORDINAL_STATUS_PATH = "/api/device-login/status";
const ORDINAL_START_PATH = "/api/device-login/start";
const ORDINAL_CANCEL_PATH = "/api/device-login/cancel";

export const DEVICE_LOGIN_FETCH_TIMEOUT_MS = 5_000;
export const DEVICE_LOGIN_FETCH_MAX_BYTES = 1_048_576;

export type DeviceLoginBoardState = "idle" | "waiting" | "signed-in" | "expired" | "denied" | "error" | "cancelled";

export interface DeviceLoginBoardStatus {
  ordinal: string;
  role: "engine" | "worker";
  hasXaiRunner: boolean;
  authPresent: boolean;
  leased: boolean;
  state: DeviceLoginBoardState;
  url?: string;
  userCode?: string;
  expiresAt?: number;
  error?: string;
  available: boolean;
}

export type BoardDeviceFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidDeviceRole(value: unknown): value is "engine" | "worker" {
  return value === "engine" || value === "worker";
}

/**
 * Ordinal host validation: a DNS name (single label or FQDN) with no scheme,
 * port, path, userinfo, or IP literal. The chart makes `<ordinal>:3010`
 * reachable from the router; a refused connection until then is fine.
 */
export function isValidOrdinalHost(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const host = value.trim();
  if (host === "" || host.length > 253) return false;
  if (host.includes("/") || host.includes(":") || host.includes("@") || host.includes(" ")) return false;
  if (host.includes("..")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const labels = host.toLowerCase().split(".");
  if (labels.some((label) => label === "" || !DNS_LABEL.test(label))) return false;
  return true;
}

const ALLOWED_STATES: ReadonlySet<string> = new Set([
  "idle",
  "waiting",
  "signed-in",
  "expired",
  "denied",
  "error",
  "cancelled",
]);

function asTrimmedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, max);
}

function asHttpsUrl(value: unknown): string | undefined {
  const trimmed = asTrimmedString(value, 2048);
  if (!trimmed) return undefined;
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(trimmed)) return undefined;
  return trimmed;
}

function asUserCode(value: unknown): string | undefined {
  const trimmed = asTrimmedString(value, 64);
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Keep only the public board shape. Drops tokens, auth files, and anything
 * the ordinal should never have sent (access, refresh, token, key, auth).
 */
export function sanitizeDeviceLoginStatus(
  value: unknown,
  fallbackOrdinal: string,
  fallbackRole: "engine" | "worker"
): DeviceLoginBoardStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const ordinal = asTrimmedString(rec.ordinal, 253) ?? fallbackOrdinal;
  const role = isValidDeviceRole(rec.role) ? rec.role : fallbackRole;
  const hasXaiRunner = rec.hasXaiRunner === true;
  const authPresent = rec.authPresent === true;
  const leased = rec.leased === true;
  const rawState = typeof rec.state === "string" ? rec.state.trim() : "idle";
  const state = (ALLOWED_STATES.has(rawState) ? rawState : "error") as DeviceLoginBoardState;
  const status: DeviceLoginBoardStatus = {
    ordinal,
    role,
    hasXaiRunner,
    authPresent,
    leased,
    state,
    available: true,
  };
  const url = asHttpsUrl(rec.url);
  if (url) status.url = url;
  const userCode = asUserCode(rec.userCode ?? rec.user_code);
  if (userCode) status.userCode = userCode;
  if (typeof rec.expiresAt === "number" && Number.isFinite(rec.expiresAt)) status.expiresAt = rec.expiresAt;
  const error = asTrimmedString(rec.error, 500);
  if (error) status.error = error;
  return status;
}

export function deviceLoginOrdinalUnavailable(ordinal: string, role: "engine" | "worker"): DeviceLoginBoardStatus {
  return { ordinal, role, hasXaiRunner: false, authPresent: false, leased: false, state: "error", available: false };
}

function forwardedHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    "x-forwarded-user",
    "x-forwarded-email",
    "x-auth-request-user",
    "x-remote-user",
    "x-forwarded-proto",
    "x-forwarded-host",
    "origin",
  ]) {
    const value = request.headers.get(name);
    if (value != null && value !== "") out[name] = value;
  }
  return out;
}

async function readCappedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers?.get("content-length");
  if (declared != null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) throw new Error("ordinal body too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ordinal body unreadable");
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("ordinal body too large");
    }
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)) as string) as unknown;
}

async function fetchOrdinal(
  ordinal: string,
  path: string,
  request: Request,
  init: RequestInit,
  fetchFn: BoardDeviceFetchFn,
  timeoutMs: number
): Promise<Response> {
  const target = `http://${ordinal}:${DEVICE_LOGIN_ORDINAL_PORT}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(target, {
      ...init,
      headers: { ...forwardedHeaders(request), ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
      redirect: "error",
    });
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

function ordinalOf(body: unknown, query: URLSearchParams): string {
  const rec = (body ?? {}) as Record<string, unknown>;
  const fromBody = typeof rec.ordinal === "string" ? rec.ordinal.trim() : "";
  if (fromBody !== "") return fromBody;
  return (query.get("ordinal") ?? "").trim();
}

function roleOf(body: unknown, query: URLSearchParams): string {
  const rec = (body ?? {}) as Record<string, unknown>;
  const fromBody = typeof rec.role === "string" ? rec.role.trim() : "";
  if (fromBody !== "") return fromBody;
  return (query.get("role") ?? "").trim();
}

export interface DeviceLoginProxyDeps {
  fetchFn?: BoardDeviceFetchFn;
  timeoutMs?: number;
  logger?: (message: string) => void;
}

export async function handleDeviceLoginStatus(request: Request, deps: DeviceLoginProxyDeps = {}): Promise<Response> {
  const logger = deps.logger ?? ((message: string) => console.log(`[board] ${message}`));
  const actor = boardUsername(request) ?? "";
  if (!actor) return json(401, { error: "missing edge identity" });
  const url = new URL(request.url);
  const ordinal = (url.searchParams.get("ordinal") ?? "").trim();
  const role = (url.searchParams.get("role") ?? "").trim();
  if (!isValidOrdinalHost(ordinal)) return json(400, { error: "invalid ordinal" });
  if (!isValidDeviceRole(role)) return json(400, { error: "invalid role" });
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEVICE_LOGIN_FETCH_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchOrdinal(
      ordinal,
      ORDINAL_STATUS_PATH,
      request,
      { method: "GET", headers: { Accept: "application/json" } },
      fetchFn,
      timeoutMs
    );
  } catch (err) {
    logger(`device login status unavailable ordinal=${ordinal}: ${err instanceof Error ? err.message : String(err)}`);
    return json(502, { error: "ordinal unavailable", ordinal, role, available: false });
  }
  if (!response.ok) {
    return json(502, { error: "ordinal unavailable", ordinal, role, available: false });
  }
  let parsed: unknown;
  try {
    parsed = await readCappedJson(response, DEVICE_LOGIN_FETCH_MAX_BYTES);
  } catch {
    return json(502, { error: "ordinal unavailable", ordinal, role, available: false });
  }
  const status = sanitizeDeviceLoginStatus(parsed, ordinal, role);
  if (!status) return json(502, { error: "ordinal unavailable", ordinal, role, available: false });
  return json(200, status);
}

async function handleDeviceLoginWrite(
  request: Request,
  kind: "start" | "cancel",
  deps: DeviceLoginProxyDeps = {}
): Promise<Response> {
  const logger = deps.logger ?? ((message: string) => console.log(`[board] ${message}`));
  const actor = boardUsername(request) ?? "";
  if (!actor) return json(401, { error: "missing edge identity" });
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return json(400, { error: "invalid device login payload" });
  if (!isAllowedBoardOrigin(request)) return json(403, { error: "forbidden" });
  let body: unknown;
  try {
    const text = await request.text();
    body = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const url = new URL(request.url);
  const ordinal = ordinalOf(body, url.searchParams);
  const role = roleOf(body, url.searchParams);
  if (!isValidOrdinalHost(ordinal)) return json(400, { error: "invalid ordinal" });
  if (!isValidDeviceRole(role)) return json(400, { error: "invalid role" });
  // The body carries only ordinal + role. A command field, an actor field, or
  // any other free-form input is never forwarded: the ordinal runs one fixed
  // invocation and reads the actor from the forwarded edge headers.
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEVICE_LOGIN_FETCH_TIMEOUT_MS;
  const ordinalPath = kind === "start" ? ORDINAL_START_PATH : ORDINAL_CANCEL_PATH;
  let response: Response;
  try {
    response = await fetchOrdinal(
      ordinal,
      ordinalPath,
      request,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" },
      fetchFn,
      timeoutMs
    );
  } catch (err) {
    logger(
      `device login ${kind} unavailable actor=${actor} ordinal=${ordinal} provider=${DEVICE_LOGIN_PROVIDER}: ${err instanceof Error ? err.message : String(err)}`
    );
    return json(502, { error: "ordinal unavailable", ordinal, role, available: false });
  }
  if (!response.ok) {
    let code: unknown;
    try {
      code = await readCappedJson(response, DEVICE_LOGIN_FETCH_MAX_BYTES);
    } catch {
      code = undefined;
    }
    const rec = (code ?? {}) as Record<string, unknown>;
    const errCode = typeof rec.code === "string" ? rec.code : undefined;
    if (response.status === 409)
      return json(409, { error: "Ordinal holds a leased job; refusing login", code: "leased", ordinal, role });
    if (response.status === 422) {
      return json(422, {
        error:
          errCode === "ephemeral-home"
            ? "Refusing device login on an ephemeral HOME"
            : "xAI runner not configured in chain",
        code: errCode ?? "no-xai-runner",
        ordinal,
        role,
      });
    }
    if (response.status === 401 || response.status === 403)
      return json(502, { error: "ordinal unavailable", ordinal, role, available: false });
    return json(502, { error: "ordinal unavailable", ordinal, role, available: false });
  }
  if (kind === "cancel") {
    logger(`device login actor=${actor} ordinal=${ordinal} provider=${DEVICE_LOGIN_PROVIDER} result=cancelled`);
    return json(200, { ok: true, ordinal, role, state: "cancelled" });
  }
  let parsed: unknown;
  try {
    parsed = await readCappedJson(response, DEVICE_LOGIN_FETCH_MAX_BYTES);
  } catch {
    return json(502, { error: "ordinal unavailable", ordinal, role, available: false });
  }
  const rec = (parsed ?? {}) as Record<string, unknown>;
  const state = typeof rec.state === "string" ? rec.state : "waiting";
  const out: Record<string, unknown> = { ok: true, ordinal, role, state };
  const outUrl = asHttpsUrl(rec.url);
  if (outUrl) out.url = outUrl;
  const outCode = asUserCode(rec.userCode ?? rec.user_code);
  if (outCode) out.userCode = outCode;
  if (typeof rec.expiresAt === "number" && Number.isFinite(rec.expiresAt)) out.expiresAt = rec.expiresAt;
  logger(`device login actor=${actor} ordinal=${ordinal} provider=${DEVICE_LOGIN_PROVIDER} result=started`);
  return json(200, out);
}

export function handleDeviceLoginStart(request: Request, deps: DeviceLoginProxyDeps = {}): Promise<Response> {
  return handleDeviceLoginWrite(request, "start", deps);
}

export function handleDeviceLoginCancel(request: Request, deps: DeviceLoginProxyDeps = {}): Promise<Response> {
  return handleDeviceLoginWrite(request, "cancel", deps);
}
