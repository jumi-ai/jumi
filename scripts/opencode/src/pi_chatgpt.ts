/**
 * Plan-funded ChatGPT/Codex inference for Pi via the supported OSS
 * Sign in with ChatGPT route (jumi#936).
 *
 * Only this route is implemented: the public Responses API at
 * `POST https://api.openai.com/v1/responses` with an OAuth access token
 * authorized for ChatGPT plan usage. No Codex CLI credential
 * (`$HOME/.codex/auth.json`, `chatgpt.com/backend-api`), no alternate
 * client identity, and no platform-key (`sk-`) fallback exist here; each
 * is detected and refused without substitution.
 *
 * Upstream grounding (public docs, never a mock the author wrote):
 * - Overview / client vs host / host-id formats:
 *   https://developers.openai.com/siwc/token-sharing-open-source
 * - Registration (`client_id=dynamic_agent_client`, `ext_agent_host_id`,
 *   loopback, `0600`, `chatgpt.tokens.use.direct`):
 *   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * - Accounts, refresh serialization, revocation, credential security:
 *   https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
 * - Models list (`visibility == "list"`) and inference (`store: false`,
 *   `stream: true`, `response.completed`, `response.failed`):
 *   https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 * - Token lifetimes (access 1h, refresh 30d rotating) and access claims:
 *   https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 * - Structured errors (`subscription_sharing_*`, `chatpass_v2_*`,
 *   401/403/503 admission) and refresh errors (`invalid_grant`, ...):
 *   https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 * - Request limits (`store`/`stream`, unsupported fields, no
 *   `previous_response_id`, tool allow/deny lists):
 *   https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 * - Pi's own OSS implementation of the same flow (dynamic client id,
 *   resource, scope, loopback, login/refresh/toAuth, `store: false`,
 *   `response.completed`, `subscription_sharing_*` surfacing):
 *   `node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js`,
 *   `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`,
 *   `node_modules/@earendil-works/pi-ai/dist/providers/openai.js`
 *
 * Disabled by default: resolving the profile never enables it. Selection
 * still requires `JUMI_PI_ALLOWED_ROUTES` to name
 * {@link PI_CHATGPT_ROUTE_NAME}. Fixture credentials only: no real
 * sign-in, no browser, no vendor charge in CI.
 */

import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type PiAdapterResult,
  type PiProfileDefinition,
  type PiUsage,
  piAdapterAuthExpired,
  piAdapterCancelled,
  piAdapterDenied,
  piAdapterProviderFailure,
  piAdapterQuota,
} from "./pi_profiles.ts";

/** Canonical doc for this route. */
export const PI_CHATGPT_DOC = "https://developers.openai.com/siwc/token-sharing-open-source" as const;

/** Public Responses API: the only inference endpoint on this route. */
export const PI_CHATGPT_RESPONSES_URL = "https://api.openai.com/v1/responses" as const;

/** Account model catalog for the picker (`visibility == "list"` kept). */
export const PI_CHATGPT_MODELS_URL = "https://api.openai.com/v1/models" as const;

/** OAuth token endpoint for code exchange and rotating refresh. */
export const PI_CHATGPT_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token" as const;

/** OAuth authorization endpoint (browser only; never called in CI). */
export const PI_CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize" as const;

/** Resource audience for every token request on this flow. */
export const PI_CHATGPT_RESOURCE = "https://api.openai.com/v1" as const;

/** Plan-usage scope: inference without it is identity only, never billed to the plan. */
export const PI_CHATGPT_DIRECT_SCOPE = "chatgpt.tokens.use.direct" as const;

/** Full requested scope set for initial registration. */
export const PI_CHATGPT_REQUIRED_SCOPES: readonly string[] = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  PI_CHATGPT_DIRECT_SCOPE,
];

/** Exact model eligibility this route serves. No substitution. */
export const PI_CHATGPT_ELIGIBLE_MODEL = "gpt-6.2-sol" as const;

/** Provider base URL for the Pi profile on this route. */
export const PI_CHATGPT_ENDPOINT = "https://api.openai.com/v1" as const;

export const PI_CHATGPT_PROVIDER = "openai" as const;

/** Deployment allowlist name for this route. Default off. */
export const PI_CHATGPT_ROUTE_NAME = "pi-chatgpt-oss" as const;

/** First-time registration entrypoint. Never saved or used for exchange. */
export const PI_CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client" as const;

/** Forbidden Codex CLI serving host: any request pointed here is not this route. */
export const PI_CHATGPT_BACKEND_API_HOST = "chatgpt.com" as const;

/**
 * Request fields the preview rejects on this route. Sending one is a
 * caller bug, not a retryable provider error.
 */
export const PI_CHATGPT_UNSUPPORTED_RESPONSE_FIELDS: readonly string[] = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

export class ChatGptCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptCredentialError";
  }
}

export class ChatGptModelUnavailableError extends Error {
  constructor(requested: string) {
    super(
      `ChatGPT plan route has no model ${requested || "(empty)"}: only ${PI_CHATGPT_ELIGIBLE_MODEL} is served here; refusing without substitution`
    );
    this.name = "ChatGptModelUnavailableError";
  }
}

export class ChatGptDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptDeniedError";
  }
}

/** Stored SIWC credential record (app-defined path, `0600`, one per issued client). */
export interface ChatGptCredentialRecord {
  email?: string;
  subject?: string;
  clientId: string;
  extAgentHostId: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  scopes: string[];
  expiresAtMs: number;
  savedAt: string;
}

/** True for a real issued client id (never the registration entrypoint). */
export function isIssuedChatGptClientId(clientId: string | undefined | null): boolean {
  const trimmed = (clientId ?? "").trim();
  if (!trimmed) return false;
  return trimmed !== PI_CHATGPT_DYNAMIC_CLIENT_ID;
}

/** True when the granted scopes authorize plan usage. */
export function hasChatGptDirectScope(scopes: readonly string[] | undefined | null): boolean {
  if (!scopes) return false;
  return scopes.some((scope) => scope.trim() === PI_CHATGPT_DIRECT_SCOPE);
}

/** Fail closed on registration, scope, token, host, and shape problems. */
export function validateChatGptCredential(record: ChatGptCredentialRecord): void {
  if (!isIssuedChatGptClientId(record.clientId)) {
    throw new ChatGptCredentialError(
      `ChatGPT credential has no issued client_id (got ${JSON.stringify(record.clientId ?? "")}); registration is incomplete`
    );
  }
  if (!record.extAgentHostId.trim()) {
    throw new ChatGptCredentialError(
      "ChatGPT credential has no ext_agent_host_id; the host id must persist across sign-ins"
    );
  }
  if (!record.accessToken.trim() || !record.refreshToken.trim()) {
    throw new ChatGptCredentialError("ChatGPT credential is missing an access or refresh token");
  }
  if (isPlatformKeyCredential(record.accessToken)) {
    throw new ChatGptDeniedError("ChatGPT plan route refuses a platform API key; use the OAuth access token");
  }
  if (!hasChatGptDirectScope(record.scopes)) {
    throw new ChatGptCredentialError(
      `ChatGPT grant lacks ${PI_CHATGPT_DIRECT_SCOPE}: plan usage is disabled, sign-in is identity only`
    );
  }
}

/** True once the access token no longer covers a request. */
export function isChatGptAccessExpired(
  record: Pick<ChatGptCredentialRecord, "expiresAtMs">,
  nowMs = Date.now()
): boolean {
  return record.expiresAtMs <= nowMs;
}

/** True when the caller should refresh before starting a request (3-minute margin). */
export function needsChatGptRefresh(
  record: Pick<ChatGptCredentialRecord, "expiresAtMs">,
  nowMs = Date.now(),
  marginMs = 3 * 60 * 1000
): boolean {
  return record.expiresAtMs - marginMs <= nowMs;
}

/** Redact bearer material from any string before it reaches logs or the forge. */
export function redactChatGptText(
  text: string,
  record?: Pick<ChatGptCredentialRecord, "accessToken" | "refreshToken" | "idToken">
): string {
  let out = text;
  const secrets = [record?.accessToken, record?.refreshToken, record?.idToken].filter(
    (value): value is string => typeof value === "string" && value.length >= 8
  );
  for (const secret of secrets) {
    out = out.split(secret).join("[REDACTED]");
  }
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
  out = out.replace(/oaiapp_[A-Za-z0-9_-]{4,}/g, "[REDACTED-CLIENT]");
  return out;
}

export interface ChatGptResponsesRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Build the only supported inference request: `POST` the public Responses
 * endpoint with the OAuth bearer, `store: false`, `stream: true`, and an
 * `input` array. Unsupported preview fields and any non-public endpoint
 * fail closed instead of being sent.
 */
export function buildChatGptResponsesRequest(opts: {
  accessToken: string;
  model: string;
  input: unknown[];
  instructions?: string;
}): ChatGptResponsesRequest {
  const model = opts.model.trim();
  if (!model) throw new ChatGptModelUnavailableError(opts.model);
  if (model !== PI_CHATGPT_ELIGIBLE_MODEL) throw new ChatGptModelUnavailableError(model);
  if (!opts.accessToken.trim()) throw new ChatGptCredentialError("ChatGPT inference needs an access token");
  if (isPlatformKeyCredential(opts.accessToken)) {
    throw new ChatGptDeniedError("ChatGPT plan route refuses a platform API key; use the OAuth access token");
  }
  if (!Array.isArray(opts.input) || opts.input.length === 0) {
    throw new ChatGptCredentialError("ChatGPT inference needs a non-empty input array");
  }
  const body: Record<string, unknown> = {
    model,
    input: opts.input,
    store: false,
    stream: true,
  };
  if (opts.instructions?.trim()) body.instructions = opts.instructions.trim();
  for (const field of PI_CHATGPT_UNSUPPORTED_RESPONSE_FIELDS) {
    if (field in body) {
      throw new ChatGptDeniedError(`ChatGPT plan route rejects unsupported field ${field}`);
    }
  }
  return {
    url: PI_CHATGPT_RESPONSES_URL,
    method: "POST",
    headers: { Authorization: `Bearer ${opts.accessToken}`, "Content-Type": "application/json" },
    body,
  };
}

/** Keep current account choices (`visibility == "list"`), preserving server order. */
export function filterChatGptListableModels(payload: unknown): Array<{ slug: string; displayName: string }> {
  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const out: Array<{ slug: string; displayName: string }> = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { slug?: unknown; display_name?: unknown; visibility?: unknown };
    if (record.visibility !== "list") continue;
    if (typeof record.slug !== "string" || !record.slug.trim()) continue;
    out.push({
      slug: record.slug.trim(),
      displayName: typeof record.display_name === "string" ? record.display_name : record.slug.trim(),
    });
  }
  return out;
}

/**
 * Exact eligibility, never substitution: the requested model must be
 * {@link PI_CHATGPT_ELIGIBLE_MODEL} and, when a catalog is given, listed
 * for this account. Anything else throws.
 */
export function assertChatGptModelAvailable(requested: string, availableSlugs?: readonly string[]): string {
  const normalized = requested.trim();
  if (normalized !== PI_CHATGPT_ELIGIBLE_MODEL) throw new ChatGptModelUnavailableError(requested);
  if (availableSlugs !== undefined && !availableSlugs.some((slug) => slug.trim() === normalized)) {
    throw new ChatGptModelUnavailableError(requested);
  }
  return normalized;
}

const CHATGPT_CANCEL_RE = /AbortError|cancelled|The operation was aborted/i;

const CHATGPT_AUTH_RE =
  /invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused|token_invalidated|token_revoked|subscription_sharing_invalid_user|Login expired|not logged in|401\s*Unauthorized|API Error:\s*401/i;

const CHATGPT_QUOTA_RE =
  /subscription_sharing_usage_limit_exceeded|subscription_sharing_usage_unavailable|subscription_sharing_user_unavailable|FreeUsageLimitError|GoUsageLimitError|usage limit exceeded|Free usage exceeded|account_rate_limit|quota exceeded|insufficient_quota|429|too many requests|Rate limit exceeded/i;

const CHATGPT_DENIED_RE =
  /subscription_sharing_user_not_eligible|subscription_sharing_route_not_supported|subscription_sharing_unsupported_capability|chatpass_v2_scope_not_authorized|chatpass_v2_invalid_authorization_context|unsupported_capability|route_not_supported|user_not_eligible|403\s*Forbidden/i;

const CHATGPT_TRANSIENT_RE =
  /503|502|500|overloaded|fetch failed|Connection error|timeout|timed out|temporarily unavailable/i;

/** Classify one provider failure into the shared adapter contract. Auth stays distinct from quota and denial. */
export function classifyChatGptError(message: string | null | undefined): PiAdapterResult["kind"] {
  const text = message ?? "";
  if (!text) return "provider-failure";
  if (CHATGPT_CANCEL_RE.test(text)) return "cancelled";
  if (CHATGPT_AUTH_RE.test(text)) return "auth-expired";
  if (CHATGPT_DENIED_RE.test(text)) return "denied";
  if (CHATGPT_QUOTA_RE.test(text)) return "quota";
  return "provider-failure";
}

/** Build the shared result for one provider failure, preserving code and request id in the message. */
export function chatGptResultFromError(message: string, opts: { requestId?: string } = {}): PiAdapterResult {
  const kind = classifyChatGptError(message);
  const suffixed = opts.requestId ? `${message} (request ${opts.requestId})` : message;
  switch (kind) {
    case "cancelled":
      return piAdapterCancelled(suffixed);
    case "auth-expired":
      return piAdapterAuthExpired(suffixed);
    case "denied":
      return piAdapterDenied(suffixed);
    case "quota": {
      const resetting = /subscription_sharing_usage_unavailable|subscription_sharing_user_unavailable/i.test(message);
      return piAdapterQuota(suffixed, { resetting });
    }
    default: {
      const retryable = CHATGPT_TRANSIENT_RE.test(message);
      return piAdapterProviderFailure(suffixed, retryable);
    }
  }
}

export interface ChatGptCompletionInput {
  /** Tool calls observed on the stream (function/custom tools only on this route). */
  toolCalls: Array<{ name: string; argumentsJson: string }>;
  /** Reasoning deltas observed (`reasoning.encrypted_content` stays opaque). */
  reasoningDeltas: string[];
  /** Available usage reported by the provider. Absent means missing, never zero. */
  usage?: PiUsage;
  /** True only after `response.completed` (usage-limit `response.failed` is not completion). */
  completed: boolean;
  /** Failure code when the stream ended as `response.failed`. */
  failedCode?: string;
}

/**
 * Shared-contract result for one Responses stream: tool streams and
 * reasoning ride the message, available usage rides `usage`, and only
 * `response.completed` counts as success. A `response.failed` code reuses
 * the error classifier so quota/denial stay distinct.
 */
export function chatGptResultFromCompletion(input: ChatGptCompletionInput): PiAdapterResult {
  if (input.failedCode) return chatGptResultFromError(input.failedCode);
  if (!input.completed) return piAdapterProviderFailure("ChatGPT stream ended without response.completed", false);
  const result: PiAdapterResult = { kind: "ok", message: "response.completed" };
  if (input.usage !== undefined) result.usage = { ...input.usage };
  void input.toolCalls;
  void input.reasoningDeltas;
  return result;
}

/** True when the stream saw `response.completed` and no `response.failed`. */
export function isChatGptStreamComplete(events: readonly string[]): boolean {
  if (events.includes("response.failed")) return false;
  return events.includes("response.completed");
}

/** True for a Codex CLI credential source (file, serving host, or account header). Never copied here. */
export function isCodexCliCredentialSource(opts: {
  path?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}): boolean {
  const path = (opts.path ?? "").replace(/\\/g, "/");
  if (path.includes(".codex/auth.json")) return true;
  const baseUrl = (opts.baseUrl ?? "").toLowerCase();
  if (baseUrl.includes(PI_CHATGPT_BACKEND_API_HOST) && baseUrl.includes("backend-api")) return true;
  for (const [key, value] of Object.entries(opts.headers ?? {})) {
    if (key.toLowerCase() === "chatgpt-account-id" && value.trim()) return true;
  }
  return false;
}

/** True for a platform API key (`sk-...`); this route sends only the OAuth bearer. */
export function isPlatformKeyCredential(value: string | undefined | null): boolean {
  return !!value && value.trim().startsWith("sk-");
}

/** True when the presented client differs from the issued registration (including the entrypoint). */
export function isAlternateClientIdentity(
  presented: string | undefined | null,
  issued: string | undefined | null
): boolean {
  const left = (presented ?? "").trim();
  const right = (issued ?? "").trim();
  if (!left || !right) return true;
  if (left === PI_CHATGPT_DYNAMIC_CLIENT_ID) return true;
  return left !== right;
}

/** Refuse every unsupported credential source without falling back to another billing path. */
export function assertNoForbiddenChatGptSource(opts: {
  path?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  accessToken?: string;
  presentedClientId?: string;
  issuedClientId?: string;
}): void {
  if (isCodexCliCredentialSource(opts)) {
    throw new ChatGptDeniedError(
      "ChatGPT plan route refuses Codex CLI credentials (auth.json/backend-api/account id); complete Sign in with ChatGPT instead"
    );
  }
  if (isPlatformKeyCredential(opts.accessToken)) {
    throw new ChatGptDeniedError("ChatGPT plan route refuses a platform API key; use the OAuth access token");
  }
  if (
    opts.presentedClientId !== undefined &&
    opts.issuedClientId !== undefined &&
    isAlternateClientIdentity(opts.presentedClientId, opts.issuedClientId)
  ) {
    throw new ChatGptDeniedError("ChatGPT credential presents a different client_id than the issued registration");
  }
}

export interface ChatGptOperatorGate {
  id: "client-registration" | "deployment-scope" | "model-eligibility" | "plan-billing";
  satisfied: boolean;
  detail: string;
}

export interface ChatGptFeasibility {
  feasible: boolean;
  blocked: string[];
  gates: ChatGptOperatorGate[];
}

/**
 * Operator gates for the authorized route. Client registration (issued id +
 * stable host id), deployment scope (allowlist names the route), exact
 * `gpt-6.2-sol` eligibility (account catalog lists it), and provider-side
 * plan billing (direct scope granted, no platform key) must all hold.
 * Anything missing is recorded as blocked; the caller must not substitute.
 */
export function checkChatGptOperatorGates(opts: {
  issuedClientId?: string;
  extAgentHostId?: string;
  allowlist: readonly string[];
  routeName?: string;
  catalogSlugs?: readonly string[];
  scopes?: readonly string[];
  accessToken?: string;
}): ChatGptFeasibility {
  const route = (opts.routeName ?? PI_CHATGPT_ROUTE_NAME).trim() || PI_CHATGPT_ROUTE_NAME;
  const registrationOk = isIssuedChatGptClientId(opts.issuedClientId) && !!opts.extAgentHostId?.trim();
  const scopeOk = opts.allowlist.includes(route);
  const eligibleOk =
    opts.catalogSlugs === undefined
      ? false
      : opts.catalogSlugs.some((slug) => slug.trim() === PI_CHATGPT_ELIGIBLE_MODEL);
  const billingOk = hasChatGptDirectScope(opts.scopes) && !isPlatformKeyCredential(opts.accessToken ?? "");
  const gates: ChatGptOperatorGate[] = [
    {
      id: "client-registration",
      satisfied: registrationOk,
      detail: registrationOk
        ? "issued client_id and stable ext_agent_host_id are stored"
        : "name the agent in the browser and store the issued client_id with a stable ext_agent_host_id",
    },
    {
      id: "deployment-scope",
      satisfied: scopeOk,
      detail: scopeOk
        ? `deployment allowlist names ${route}`
        : `add ${route} to JUMI_PI_ALLOWED_ROUTES for this deployment; empty stays disabled`,
    },
    {
      id: "model-eligibility",
      satisfied: eligibleOk,
      detail: eligibleOk
        ? `${PI_CHATGPT_ELIGIBLE_MODEL} is listed for this ChatGPT account`
        : `confirm ${PI_CHATGPT_ELIGIBLE_MODEL} appears in GET ${PI_CHATGPT_MODELS_URL} with visibility list for this account`,
    },
    {
      id: "plan-billing",
      satisfied: billingOk,
      detail: billingOk
        ? "direct scope granted; usage counts against the ChatGPT plan"
        : `grant ${PI_CHATGPT_DIRECT_SCOPE} and confirm plan billing; platform keys never bill here`,
    },
  ];
  const blocked = gates.filter((gate) => !gate.satisfied).map((gate) => `${gate.id}: ${gate.detail}`);
  return { feasible: blocked.length === 0, blocked, gates };
}

/** Pi profile for this route. Resolves like any profile; the allowlist still gates selection. */
export function chatGptPiProfileDefinition(): PiProfileDefinition {
  return {
    provider: PI_CHATGPT_PROVIDER,
    model: PI_CHATGPT_ELIGIBLE_MODEL,
    endpoint: PI_CHATGPT_ENDPOINT,
    fundingPool: "chatgpt-plan-pool",
    payer: "chatgpt-plan",
    credentialRef: "env:EXAMPLE_CHATGPT_OSS_CREDENTIAL",
    scopes: ["public"],
  };
}

export interface ChatGptFixtureSeed {
  access: string;
  refresh: string;
  clientId: string;
  hostId: string;
  scopes: string[];
  expiresAtMs: number;
  generation?: number;
  revoked?: boolean;
}

export interface ChatGptChildView {
  access: string;
  argv: string[];
  env: Record<string, string>;
  files: Record<string, string>;
  endpoints: string[];
}

export interface ChatGptFixtureSnapshot {
  access: string;
  refresh: string;
  clientId: string;
  hostId: string;
  scopes: string[];
  expiresAtMs: number;
  generation: number;
  revoked: boolean;
}

/**
 * Offline fixture for the SIWC credential shape. Mirrors the fresh-job
 * boundary semantics (`FreshJobCredentialStore`): durable 0600 writes with
 * orphan adoption, serialized rotation that shares one POST, revocation
 * that fails closed without invalidating already-issued bearers, and a
 * child view that carries only the access bearer. Adds expiry (1h access,
 * rotating refresh) and entitlement (`chatgpt.tokens.use.direct`): an
 * expired or identity-only grant fails inference closed.
 */
export class ChatGptFixtureStore {
  private current: ChatGptFixtureSnapshot;
  private issued: Set<string>;
  private queue: Promise<unknown> = Promise.resolve();
  private inflight: Promise<ChatGptFixtureSnapshot> | undefined;
  private refreshPosts = 0;
  private readonly dir: string;
  private readonly postRefresh: (
    refresh: string,
    clientId: string
  ) => Promise<{ access: string; refresh: string; expiresAtMs: number }>;

  constructor(
    dir: string,
    seed: ChatGptFixtureSeed = {
      access: "dummy-chatgpt-access-1",
      refresh: "dummy-chatgpt-refresh-1",
      clientId: "oaiapp_fixture1",
      hostId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
      expiresAtMs: Date.now() + 3600_000,
    },
    postRefresh?: (
      refresh: string,
      clientId: string
    ) => Promise<{ access: string; refresh: string; expiresAtMs: number }>
  ) {
    this.dir = dir;
    this.current = {
      access: seed.access,
      refresh: seed.refresh,
      clientId: seed.clientId,
      hostId: seed.hostId,
      scopes: [...seed.scopes],
      expiresAtMs: seed.expiresAtMs,
      generation: seed.generation ?? 1,
      revoked: seed.revoked ?? false,
    };
    this.issued = new Set([seed.access]);
    this.postRefresh =
      postRefresh ??
      (async (refresh: string) => {
        this.refreshPosts += 1;
        return {
          access: `dummy-chatgpt-access-rotated-${refresh.length}-${this.refreshPosts}`,
          refresh: `${refresh}-next`,
          expiresAtMs: Date.now() + 3600_000,
        };
      });
  }

  get posts(): number {
    return this.refreshPosts;
  }

  private get path(): string {
    return join(this.dir, "chatgpt-oss.json");
  }

  private sibling(): string {
    return join(this.dir, `chatgpt-oss.json.jumi-${crypto.randomUUID()}.tmp`);
  }

  async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = this.sibling();
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ current: this.current, issued: [...this.issued] }, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    await chmod(this.path, 0o600).catch(() => undefined);
    const reread = JSON.parse(await readFile(this.path, "utf8")) as {
      current: ChatGptFixtureSnapshot;
      issued: string[];
    };
    if (reread.current.access !== this.current.access || reread.current.refresh !== this.current.refresh) {
      throw new Error("ChatGPT fixture did not survive a re-read");
    }
  }

  async restart(): Promise<void> {
    try {
      const reread = JSON.parse(await readFile(this.path, "utf8")) as {
        current: ChatGptFixtureSnapshot;
        issued: string[];
      };
      this.current = { ...reread.current, scopes: [...reread.current.scopes] };
      this.issued = new Set(reread.issued ?? [reread.current.access]);
    } catch {
      return;
    }
    const base = basename(this.path);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const orphans = names.filter((name) => name.startsWith(`${base}.jumi-`) && name.endsWith(".tmp"));
    for (const orphan of orphans) {
      try {
        const candidate = JSON.parse(await readFile(join(this.dir, orphan), "utf8")) as {
          current: ChatGptFixtureSnapshot;
        };
        if (!candidate.current?.refresh || candidate.current.revoked) continue;
        if (candidate.current.generation > this.current.generation) {
          this.current = { ...candidate.current, scopes: [...candidate.current.scopes] };
          this.issued.add(candidate.current.access);
        }
      } catch {
        // Unreadable sibling: ignore, then remove below.
      }
      await rm(join(this.dir, orphan), { force: true }).catch(() => undefined);
    }
  }

  refresh(nowMs = Date.now()): Promise<ChatGptFixtureSnapshot> {
    if (this.inflight) return this.inflight;
    const run = this.queue.then(
      () => this.refreshLocked(nowMs),
      () => this.refreshLocked(nowMs)
    );
    this.inflight = run;
    const clear = () => {
      if (this.inflight === run) this.inflight = undefined;
    };
    void run.then(clear, clear);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async refreshLocked(nowMs: number): Promise<ChatGptFixtureSnapshot> {
    void nowMs;
    if (this.current.revoked) throw new Error("ChatGPT grant revoked: sign in again");
    if (!isIssuedChatGptClientId(this.current.clientId)) {
      throw new Error("ChatGPT refresh needs the issued client_id, never dynamic_agent_client");
    }
    const rotated = await this.postRefresh(this.current.refresh, this.current.clientId);
    this.current = {
      access: rotated.access,
      refresh: rotated.refresh,
      clientId: this.current.clientId,
      hostId: this.current.hostId,
      scopes: [...this.current.scopes],
      expiresAtMs: rotated.expiresAtMs,
      generation: this.current.generation + 1,
      revoked: false,
    };
    this.issued.add(this.current.access);
    await this.persist();
    return this.snapshot();
  }

  revoke(): void {
    this.current = { ...this.current, revoked: true };
  }

  expireForTest(nowMs = Date.now()): void {
    void nowMs;
    this.current = { ...this.current, expiresAtMs: Date.now() - 1 };
  }

  dropDirectScopeForTest(): void {
    this.current = {
      ...this.current,
      scopes: this.current.scopes.filter((scope) => scope !== PI_CHATGPT_DIRECT_SCOPE),
    };
  }

  inference(access: string, nowMs = Date.now()): boolean {
    if (this.current.revoked) return false;
    if (!access || !this.issued.has(access)) return false;
    if (this.current.expiresAtMs <= nowMs) return false;
    if (!hasChatGptDirectScope(this.current.scopes)) return false;
    return true;
  }

  childView(argv: string[] = ["inference", "--standalone"]): ChatGptChildView {
    return {
      access: this.current.access,
      argv: [...argv],
      env: { CHATGPT_OSS_ACCESS: this.current.access, HOME: "/empty-job-home", PATH: "/usr/bin:/bin" },
      files: { "chatgpt-oss.json": JSON.stringify({ access: this.current.access, client_id: this.current.clientId }) },
      endpoints: [PI_CHATGPT_RESPONSES_URL, PI_CHATGPT_MODELS_URL],
    };
  }

  snapshot(): ChatGptFixtureSnapshot {
    return { ...this.current, scopes: [...this.current.scopes] };
  }
}

/** Redaction probe for the fixture child view: no refresh, grant file, or forge material escapes. */
export function chatGptChildViewLeaks(view: ChatGptChildView, secret: ChatGptFixtureSnapshot): string | undefined {
  const haystacks = [...Object.values(view.env), ...view.argv, ...Object.values(view.files), ...view.endpoints];
  for (const hay of haystacks) {
    if (secret.refresh && hay.includes(secret.refresh)) return "refresh token reachable from tool context";
    if (secret.hostId && hay.includes(secret.hostId)) return "host id should not ship to the tool context";
  }
  if (view.env["CHATGPT_OSS_REFRESH"] !== undefined) return "renewal authority in tool env";
  if (view.endpoints.some((endpoint) => endpoint.includes("oauth/token"))) {
    return "refresh endpoint must not be published to the tool context";
  }
  if (Object.keys(view.env).some((key) => /FORGE|GITEA|GITHUB|WEBHOOK|SECRETS/.test(key))) {
    return "forge credential in tool env";
  }
  return undefined;
}
