/**
 * Pi OpenCode Go subscription transport (jumi#935).
 *
 * The Go inference route, not the OpenCode CLI: model traffic goes to the
 * Console gateway (`https://opencode.ai/inference/go`) through Pi's
 * `opencode-go` provider, which Console already validates (session-aware
 * client). This module is the transport the future Pi harness plugs in; it
 * performs no production inference on its own and stays disabled until the
 * remaining verification clears (see the README subsection and the docs
 * below).
 *
 * Contract, per https://opencode.ai/docs/console/go and
 * https://opencode.ai/docs/console/harnesses (plus the Pi page at
 * https://opencode.ai/docs/console/harnesses/pi):
 * - Identity: the client names the actual agent (`User-Agent: jumi/1.0`,
 *   `x-opencode-client: jumi`), never a generic SDK or HTTP-library name.
 * - Session: one opaque `x-opencode-session` value, stable within a
 *   conversation and unrelated to repo or user identity. In Pi sessions this
 *   is the agent session id (a uuid, generated per conversation); this module
 *   never derives it from a repo path, username, or HOME. Decision and
 *   embedding requests are exempt from the header upstream, but Jumi makes no
 *   unattended decision/embedding calls through this transport.
 * - Model: the exact Spark Contributor SKU only
 *   (`opencode-go/muse-spark-1.3-contributor`, `sku: "contributor"`), served
 *   in the approved scope only. Contributor SKUs train on request data, so
 *   the private scope is refused in code (`PiRouteScopeRefusedError`).
 * - Key: the static Go key arrives fresh on every spawn/call
 *   (`OPENCODE_API_KEY_FILE` re-read wins over `OPENCODE_API_KEY`; missing,
 *   unreadable, or empty with no env fallback fails closed as provider auth
 *   death before any fetch). The key is never logged, never written into the
 *   workdir, and never appears in error text.
 * - Limits: subscription limits (5-hour / weekly / monthly, `403
 *   EntitlementError` vs rate-limited quota) block with a rate-limited
 *   status. Extra Usage (console-balance overage, on by default only for Go
 *   Teams) is spend and stays disabled: exactly one attempt per call, never a
 *   metered failover to another route.
 *
 * Shared contracts reused, not reinvented: route selection and the adapter
 * error/result shapes come from `src/pi_profiles.ts` (allowlist, Google and
 * unknown-endpoint denials, scope refusal, `classifyPiAdapterError`, the
 * `PiAdapterResult` constructors), and the fresh-job credential boundary is
 * `src/fresh_job_credential_boundary.ts` (`opencode-go` row: allowed, static
 * key, no refresh to serialize).
 *
 * Unverified, explicitly not claimed here: real account entitlement and
 * unattended use under https://opencode.ai/legal/terms-of-service. CI never
 * logs in, never contacts vendors, and never asserts billing: every test in
 * `test/pi_opencode_go.test.ts` runs against loopback doubles.
 */

import { readFileSync } from "node:fs";
import type { ClientIdentity } from "@earendil-works/pi-ai/utils/identity";
import { formatUserAgent, getAttributionHeaders } from "@earendil-works/pi-ai/utils/identity";
import {
  classifyPiAdapterError,
  isContributorSku,
  type PiAdapterKind,
  type PiAdapterResult,
  type PiDataScope,
  type PiProfileCatalog,
  type PiResolvedRoute,
  PiRouteDeniedError,
  type PiUsage,
  piAdapterAuthExpired,
  piAdapterCancelled,
  piAdapterDenied,
  piAdapterProviderFailure,
  piAdapterQuota,
  selectPiRoute,
} from "./pi_profiles.ts";

/** Pi provider id for Go. Covered models bill the Go subscription pool. */
export const PI_GO_PROVIDER_ID = "opencode-go" as const;

/** The only model this transport serves: the exact Spark Contributor SKU. */
export const PI_GO_MODEL_ID = "muse-spark-1.3-contributor" as const;

/** Billing SKU the route must carry. Contributor SKUs train on request data. */
export const PI_GO_SKU = "contributor" as const;

/** Actual-agent User-Agent, never a generic SDK or HTTP-library name. */
export const PI_GO_USER_AGENT = "jumi/1.0" as const;

/** Attribution name sent as `x-opencode-client` on Go requests. */
export const PI_GO_CLIENT_NAME = "jumi" as const;

/** Attribution URL identifying the agent. Plain JSON, safe to persist. */
export const PI_GO_CLIENT_URL = "https://github.com/jumi-ai/jumi" as const;

/** Per-conversation routing header Go requires on inference requests. */
export const PI_GO_SESSION_HEADER = "x-opencode-session" as const;

/** Static Go key env, fallback when no key file is configured. */
export const PI_GO_KEY_ENV = "OPENCODE_API_KEY" as const;

/** Mounted-Secret file holding the Go key. Re-read fresh on every call. */
export const PI_GO_KEY_FILE_ENV = "OPENCODE_API_KEY_FILE" as const;

/** Production Go gateway base URL (docs: Base URLs, Go row). */
export const PI_GO_BASE_URL = "https://opencode.ai/inference/go" as const;

/** Operator-only usage endpoint (docs: Usage). Never called by CI. */
export const PI_GO_USAGE_URL = "https://opencode.ai/inference/go/v1/usage" as const;

/** OpenAI chat-completions path appended to the Go base URL (docs: Base URLs). */
export const PI_GO_CHAT_COMPLETIONS_PATH = "/openai/v1/chat/completions" as const;

// --- Key delivery (fresh-job: static key, re-read per call, fail closed) ---

export interface PiGoKeyResolution {
  /** Trimmed key, or `undefined` when no usable key exists. Never logged. */
  key: string | undefined;
  /** Configured key-file path, if any. A path, never a key. */
  filePath: string | undefined;
  /** Why the file did not yield a key, when a path is configured. Key-free. */
  fileError: string | undefined;
}

/**
 * Resolve the Go key for one call. `OPENCODE_API_KEY_FILE` is re-read fresh
 * every time so a rotated Secret applies to the next call with no restart;
 * when set with readable non-empty contents it wins over `OPENCODE_API_KEY`.
 * Missing, unreadable, or empty with no env fallback yields no key: the
 * caller fails closed as provider auth death before any fetch. Never throws
 * and never returns the key inside an error string.
 */
export function resolvePiGoApiKey(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8")
): PiGoKeyResolution {
  const filePath = env[PI_GO_KEY_FILE_ENV]?.trim() ? env[PI_GO_KEY_FILE_ENV]!.trim() : undefined;
  const envKey = env[PI_GO_KEY_ENV]?.trim() ? env[PI_GO_KEY_ENV]!.trim() : undefined;
  if (!filePath) return { key: envKey, filePath: undefined, fileError: undefined };
  try {
    const content = readFile(filePath).trim();
    if (content) return { key: content, filePath, fileError: undefined };
    return { key: envKey, filePath, fileError: "empty" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { key: envKey, filePath, fileError: reason };
  }
}

/** Key-free configuration reason for a call with no usable key. */
export function piGoMissingKeyMessage(filePath?: string, fileError?: string): string {
  if (filePath) {
    return (
      `${PI_GO_KEY_FILE_ENV} is missing, unreadable, or empty (${filePath}` +
      `${fileError ? `: ${fileError.slice(0, 120)}` : ""}) and ${PI_GO_KEY_ENV} is not set: ` +
      `refusing the OpenCode Go request (provider auth failure)`
    );
  }
  return `${PI_GO_KEY_ENV} is not set: refusing the OpenCode Go request (provider auth failure)`;
}

// --- Session identity (opaque, stable within a conversation) ---

const PI_GO_GENERATED_SESSION_RE = /^ses_[0-9a-f]{32}$/;

/** Pi agent session ids: uuid shape, charset-checked upstream (`assertValidSessionId`). */
const PI_AGENT_SESSION_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * True for session ids this transport sends: either a generated `ses_` id
 * or a Pi agent session id. Rejects repo paths, URLs, emails, whitespace,
 * and empty or overlong values, so a caller cannot smuggle repo or user
 * identity into the routing header.
 */
export function isPiGoSessionId(id: string): boolean {
  if (!id || id.length > 128) return false;
  // The `ses_` namespace is this transport's: anything claiming it must be a
  // well-formed generated id, so a truncated or constant `ses_` value fails
  // closed instead of routing under a colliding id.
  if (id.startsWith("ses_")) return PI_GO_GENERATED_SESSION_RE.test(id);
  if (!PI_AGENT_SESSION_RE.test(id)) return false;
  if (id.includes("@") || id.includes("/") || id.includes("\\") || /\s/.test(id)) return false;
  return true;
}

/** Fail closed before any fetch when the session id is not opaque. */
export function assertPiGoSessionId(id: string): void {
  if (!isPiGoSessionId(id)) {
    throw new Error(`refusing the OpenCode Go request: session id is not an opaque conversation id`);
  }
}

/**
 * Mint one opaque conversation id (`ses_` + 32 hex). The caller creates one
 * per conversation and reuses it for every request in that conversation; it
 * is never derived from a repo path, username, or HOME.
 */
export function createPiGoSessionId(randomHex: () => string = defaultRandomHex): string {
  return `ses_${randomHex()}`;
}

function defaultRandomHex(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

// --- Agent identification (actual agent, not a generic SDK name) ---

/** Client identity naming the actual agent on every Go request. */
export function buildPiGoIdentity(): ClientIdentity {
  return {
    userAgent: { custom: PI_GO_USER_AGENT },
    attribution: { name: PI_GO_CLIENT_NAME, url: PI_GO_CLIENT_URL, categories: ["cli-agent"] },
  };
}

/** Wire headers for one Go request: bearer, stable session, actual agent. */
export function buildPiGoHeaders(input: {
  apiKey: string;
  sessionId: string;
  identity?: ClientIdentity;
}): Record<string, string> {
  const identity = input.identity ?? buildPiGoIdentity();
  const attribution = getAttributionHeaders({ provider: PI_GO_PROVIDER_ID, baseUrl: PI_GO_BASE_URL }, identity);
  return {
    authorization: `Bearer ${input.apiKey}`,
    [PI_GO_SESSION_HEADER]: input.sessionId,
    "User-Agent": formatUserAgent(identity),
    ...attribution,
  };
}

// --- Route selection (exact SKU, approved scope, allowlist) ---

/**
 * Select the Go route: shared allowlist + scope checks, then exact-shape
 * enforcement. Only `opencode-go` / `muse-spark-1.3-contributor` with the
 * Contributor SKU passes; anything else (Zen payer, wrong model, wrong SKU)
 * is denied without substitution or paid fallback. `scope` is required so a
 * caller cannot drift private data into a training SKU by omission; the only
 * approved scope for this SKU is `public`.
 */
export function selectPiGoRoute(
  name: string,
  catalog: PiProfileCatalog,
  allowlist: readonly string[],
  opts: { scope: PiDataScope }
): PiResolvedRoute {
  const route = selectPiRoute(name, catalog, allowlist, { scope: opts.scope });
  if (route.provider !== PI_GO_PROVIDER_ID) {
    throw new PiRouteDeniedError(route.name, `Go transport needs provider ${PI_GO_PROVIDER_ID}, got ${route.provider}`);
  }
  if (route.model !== PI_GO_MODEL_ID) {
    throw new PiRouteDeniedError(route.name, `Go transport serves only ${PI_GO_MODEL_ID}, got ${route.model}`);
  }
  if (!isContributorSku(route.sku)) {
    throw new PiRouteDeniedError(route.name, `Go transport needs SKU ${PI_GO_SKU}, got ${route.sku ?? "(none)"}`);
  }
  return route;
}

// --- Stream options (validated once, stable for the conversation) ---

export interface PiGoStreamOptionsInput {
  /** Static Go key. Missing fails closed before any fetch. */
  apiKey: string | undefined;
  /** Opaque conversation id, reused for every request in the conversation. */
  sessionId: string;
  identity?: ClientIdentity;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  env?: Record<string, string>;
}

/**
 * Build validated per-request options for `ModelRuntime.stream*` on the Go
 * model: key present, session opaque, identity naming the actual agent. The
 * same object shape (same session id) is reused for every turn, so routing
 * and prompt-cache affinity stay stable. Throws fail-closed on a missing key
 * or a non-opaque session id, before the runtime can fetch.
 */
export function buildPiGoStreamOptions(input: PiGoStreamOptionsInput): {
  apiKey: string;
  sessionId: string;
  identity: ClientIdentity;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  env?: Record<string, string>;
} {
  if (!input.apiKey) {
    throw new Error(piGoMissingKeyMessage());
  }
  assertPiGoSessionId(input.sessionId);
  return {
    apiKey: input.apiKey,
    sessionId: input.sessionId,
    identity: input.identity ?? buildPiGoIdentity(),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.env ? { env: input.env } : {}),
  };
}

// --- Transport wrapper (headers enforced at the provider boundary) ---

/**
 * Wrap a provider API surface (for example the `opencode-go` entry from
 * `opencodeGoProvider()`) so every request carries the Go routing header
 * from the loop's stable session id plus the actual-agent identity. The
 * loop's `sessionId` is the single source of truth: when present it is
 * validated and overwrites any pre-set `x-opencode-session` so affinity
 * stays stable for the whole conversation. When no loop id is present, a
 * pre-set header is validated in place and kept (Console also recognizes
 * Pi's native session header); the agent User-Agent and client attribution
 * are always enforced.
 */
export function withPiGoTransport<TStreams>(streams: TStreams): TStreams {
  const source = streams as {
    stream?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
    streamSimple?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
  };
  const identity = buildPiGoIdentity();
  const wrap = (fn: ((model: unknown, context: unknown, options?: Record<string, unknown>) => unknown) | undefined) => {
    if (!fn) return fn;
    return (model: unknown, context: unknown, options?: Record<string, unknown>) => {
      const current = { ...(options ?? {}) };
      const headers = { ...((current.headers as Record<string, string> | undefined) ?? {}) };
      const sessionId = current.sessionId;
      if (typeof sessionId === "string" && sessionId) {
        assertPiGoSessionId(sessionId);
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === PI_GO_SESSION_HEADER) delete headers[key];
        }
        headers[PI_GO_SESSION_HEADER] = sessionId;
      } else {
        const existing = Object.entries(headers).find(([key]) => key.toLowerCase() === PI_GO_SESSION_HEADER);
        if (existing) assertPiGoSessionId(existing[1]);
      }
      headers["User-Agent"] = formatUserAgent(identity);
      const attribution = getAttributionHeaders({ provider: PI_GO_PROVIDER_ID, baseUrl: PI_GO_BASE_URL }, identity);
      for (const [key, value] of Object.entries(attribution)) headers[key] = value;
      return fn(model, context, { ...current, headers });
    };
  };
  return {
    ...(streams as Record<string, unknown>),
    ...(source.stream ? { stream: wrap(source.stream) } : {}),
    ...(source.streamSimple ? { streamSimple: wrap(source.streamSimple) } : {}),
  } as TStreams;
}

// --- Error contract (shared kinds; entitlement is denied, never quota) ---

const PI_GO_ENTITLEMENT_RE = /entitlementerror|go subscription required|subscription required/i;

/**
 * Classify one Go failure into the shared adapter kinds. A missing Go
 * subscription (`403 EntitlementError`, "OpenCode Go subscription required.")
 * is denied (fix: subscribe), distinct from quota and from auth expiry; a
 * missing session header (`400 MissingSessionID`) is a provider failure of
 * this client, never retryable spend. Everything else delegates to the shared
 * `classifyPiAdapterError` (401 auth expiry, 429/quota, cancellation,
 * transient 5xx/529).
 */
export function classifyPiGoError(message: string | null | undefined): PiAdapterKind {
  const text = message ?? "";
  if (PI_GO_ENTITLEMENT_RE.test(text)) return "denied";
  return classifyPiAdapterError(text);
}

/**
 * Map one Go failure message into the shared adapter result. `usage` is
 * attached only when the provider reported it (missing is never zero).
 * Quota carries no stated reset here (the HTTP path adds `Retry-After` when
 * the gateway sends one); it stays retryable-after-reset and the caller must
 * block, never fail over to a metered route.
 */
export function toPiGoAdapterResult(
  message: string,
  usage?: PiUsage,
  quota?: { resetting?: boolean; resetAtMs?: number; retryAfterMs?: number }
): PiAdapterResult {
  const kind = classifyPiGoError(message);
  const withUsage = usage ? { usage } : {};
  switch (kind) {
    case "auth-expired":
      return { ...piAdapterAuthExpired(message), ...withUsage };
    case "quota":
      return {
        ...piAdapterQuota(message, { resetting: quota?.resetting ?? false, ...(quota ?? {}) }),
        ...withUsage,
      };
    case "cancelled":
      return { ...piAdapterCancelled(message), ...withUsage };
    case "denied":
      return { ...piAdapterDenied(message), ...withUsage };
    default:
      return { ...piAdapterProviderFailure(message), ...withUsage };
  }
}

// --- Single-attempt HTTP inference (loopback-testable, no failover) ---

export interface PiGoChatCompletionInput {
  /** Gateway base URL. Explicit: tests use loopback, never the vendor. */
  baseUrl: string;
  /** Static Go key. Missing fails closed with no fetch. */
  apiKey: string | undefined;
  /** Opaque conversation id. Invalid fails closed with no fetch. */
  sessionId: string;
  messages?: Array<{ role: string; content: string }>;
  fetchImpl?: typeof fetch;
  identity?: ClientIdentity;
  signal?: AbortSignal;
}

/**
 * POST one OpenAI chat-completions request to the Go gateway and map the
 * outcome into the shared adapter result. Exactly one attempt: no retry, no
 * substitution, no paid failover. Extra Usage stays disabled: a quota
 * refusal returns `quota` and the caller blocks. Missing key or session id
 * returns `auth-expired` / throws before any fetch, so the gateway observes
 * zero requests. Error text returned here never contains the key.
 */
export async function postPiGoChatCompletion(input: PiGoChatCompletionInput): Promise<PiAdapterResult> {
  if (!input.apiKey) {
    return piAdapterAuthExpired(piGoMissingKeyMessage());
  }
  assertPiGoSessionId(input.sessionId);
  const url = `${input.baseUrl.replace(/\/+$/, "")}${PI_GO_CHAT_COMPLETIONS_PATH}`;
  const headers = {
    ...buildPiGoHeaders({ apiKey: input.apiKey, sessionId: input.sessionId, identity: input.identity }),
    "content-type": "application/json",
  };
  const body = JSON.stringify({
    model: PI_GO_MODEL_ID,
    messages: input.messages ?? [{ role: "user", content: "hi" }],
  });
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers,
      body,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toPiGoAdapterResult(message);
  }
  if (response.ok) {
    return piGoOkFromBody(await response.text().catch(() => ""));
  }
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const text = (await response.text().catch(() => "")).slice(0, 2000);
  const message = `Go request failed (${response.status}): ${text || response.statusText}`.slice(0, 2000);
  if (response.status === 401) return toPiGoAdapterResult(`API Error: 401 Unauthorized: ${text}`);
  if (response.status === 403 && PI_GO_ENTITLEMENT_RE.test(text)) return toPiGoAdapterResult(text);
  if (response.status === 429 || /rate-limited|rate limited|Go limit reached|usage limit/i.test(text)) {
    return toPiGoAdapterResult(message, undefined, {
      resetting: retryAfterMs !== undefined || /reset/i.test(text),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return toPiGoAdapterResult(message);
}

function piGoOkFromBody(text: string): PiAdapterResult {
  if (!text) return { kind: "ok", message: "Go request succeeded" };
  try {
    const body = JSON.parse(text) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const prompt = body.usage?.prompt_tokens;
    const completion = body.usage?.completion_tokens;
    if (typeof prompt === "number" && typeof completion === "number") {
      const usage: PiUsage = { inputTokens: prompt, outputTokens: completion };
      return { kind: "ok", usage, message: "Go request succeeded" };
    }
    return { kind: "ok", message: "Go request succeeded" };
  } catch {
    return { kind: "ok", message: "Go request succeeded" };
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}
