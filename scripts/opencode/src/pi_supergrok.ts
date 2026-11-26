/**
 * Pi direct SuperGrok subscription route, gated and disabled (jumi#938).
 *
 * SuperGrok is a different payer from Grok on Go: Go bills the
 * `go-subscription` pool through the Console gateway with a static key,
 * while a direct SuperGrok subscription bills the `supergrok-subscription`
 * pool through `https://api.x.ai/v1` with an OAuth subscription bearer.
 * The two pools, payers, and credential forms are never interchangeable,
 * and this module refuses every cross-payer substitution without failover.
 *
 * Upstream grounding (public docs, never a mock the author wrote):
 * - Weekly pool covers eligible first-party usage only across supported
 *   Grok and Cursor surfaces; Pi is not listed as a supported surface, and
 *   third-party models in Cursor are Additional Usage, never included:
 *   https://docs.x.ai/x-subscription/usage-limits
 * - Current subscription tiers and the included-usage ladder:
 *   https://x.ai/pricing
 * - Pi providers/models/auth (built-in `xai` provider uses `XAI_API_KEY`;
 *   subscription sign-in is `/login`, never an env key):
 *   https://docs.pi.dev/latest/providers, https://docs.pi.dev/latest/models
 * - Negative evidence (why no third-party extension is adopted): the only
 *   published Pi SuperGrok extensions are unofficial, reuse the public
 *   Grok-CLI OAuth `client_id` (client impersonation: the consent screen
 *   says "Grok Build"/"Grok CLI"), fall back to `XAI_API_KEY`, and warn
 *   about HTTP 403 for some SuperGrok tiers even after a successful login:
 *   https://pi.dev/packages/pi-xai-supergrok,
 *   https://pi.dev/packages/pi-supergrok,
 *   https://pi.dev/packages/pi-xai-oauth
 *
 * Gate status: unresolved, kept disabled. Resolving or selecting the
 * profile never enables it; selection additionally requires the deployment
 * allowlist to name {@link PI_SUPERGROK_ROUTE_NAME} (default off), and the
 * operator gates in {@link checkSupergrokOperatorGates} (actual tier,
 * embedded unattended Pi client, subscription-pool billing, vendor
 * confirmation) are all unsatisfied until a human provides first-party
 * evidence. The fresh-job row stays `blocked` in
 * `src/fresh_job_credential_boundary.ts` (`direct-supergrok`): an empty
 * `HOME` holds no grant and copying one in is the forbidden shared token
 * store. Standing pods with a retained `HOME` stay on the parent-owned
 * `src/xai_auth.ts` path, never through Pi.
 *
 * Forbidden here, each refused without substitution:
 * - client impersonation (reusing the Grok-CLI public client id or any
 *   third-party `supergrok`/`xai-auth` extension identity from Pi),
 * - third-party token reuse (copying `~/.grok/auth.json`, another
 *   install's `auth.json`, or any bearer minted for a different client),
 * - API fallback (`XAI_API_KEY` / `xai-*` per-token billing),
 * - Go fallback (`opencode-go` provider, Console gateway, Go pool).
 *
 * Shared contracts reused, not reinvented: route selection and the adapter
 * error/result shapes come from `src/pi_profiles.ts` (allowlist, endpoint
 * and Google denials, scope refusal, `classifyPiAdapterError`, the
 * `PiAdapterResult` constructors), and the fresh-job credential boundary is
 * the `direct-supergrok` row. CI never signs in, never contacts vendors,
 * and never asserts billing: every test in `test/pi_supergrok.test.ts`
 * runs against loopback doubles and dummy credentials.
 */

import {
  classifyPiAdapterError,
  type PiAdapterKind,
  type PiAdapterResult,
  type PiDataScope,
  type PiProfileCatalog,
  type PiProfileDefinition,
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

/** Deployment allowlist name for this route. Default off. */
export const PI_SUPERGROK_ROUTE_NAME = "pi-supergrok-direct" as const;

/** Canonical usage-limits doc: weekly pool, eligible surfaces, top-ups. */
export const PI_SUPERGROK_DOC = "https://docs.x.ai/x-subscription/usage-limits" as const;

/** Current tier ladder. Operator-only: CI never asserts billing. */
export const PI_SUPERGROK_PRICING_URL = "https://x.ai/pricing" as const;

/** Built-in Pi provider id. Third-party `supergrok`/`xai-auth` ids are refused. */
export const PI_SUPERGROK_PROVIDER_ID = "xai" as const;

/** Official xAI API base. The direct subscription bearer goes here. */
export const PI_SUPERGROK_ENDPOINT = "https://api.x.ai/v1" as const;

/** OpenAI-compatible chat-completions path on the xAI base. */
export const PI_SUPERGROK_CHAT_COMPLETIONS_PATH = "/chat/completions" as const;

/** Who is billed on this route. Never the Go subscription. */
export const PI_SUPERGROK_PAYER = "supergrok-subscription" as const;

/** Shared funding pool on this route. Never the Go pool. */
export const PI_SUPERGROK_POOL = "supergrok-pool" as const;

/** Go payer/pool, named only to refuse them here. */
export const PI_SUPERGROK_GO_PAYER = "go-subscription" as const;
export const PI_SUPERGROK_GO_POOL = "go-pool" as const;

/**
 * Public Grok-CLI OAuth client id (ships in OpenCode; not a secret).
 * Reusing it from Pi is client impersonation and is refused here: an
 * authorized route needs its own embedded unattended client, confirmed by
 * the vendor, not a borrowed id.
 */
export const PI_SUPERGROK_GROK_CLI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828" as const;

/** Third-party Pi provider ids. Registering one is not this route. */
export const PI_SUPERGROK_THIRD_PARTY_PROVIDERS: readonly string[] = ["supergrok", "xai-auth"];

/** Open questions keeping the route disabled. Each needs operator/vendor evidence. */
export const PI_SUPERGROK_OPEN_QUESTIONS: readonly string[] = [
  "operator-tier: which SuperGrok / X Subscription tier the operator holds and that its weekly pool covers unattended Pi inference",
  "unattended-client: an embedded Pi client authorized for headless subscription OAuth (no browser, no borrowed Grok-CLI client id), confirmed by current vendor docs",
  "eligible-surface: confirmation that Pi inference counts as eligible first-party usage under the weekly pool (not Additional Usage / top-up spend)",
  "entitlement-mapping: which account catalog / tier maps to which grok-* model ids, so selection cannot substitute a model the tier does not cover",
];

export class SupergrokPiDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupergrokPiDeniedError";
  }
}

/** True for the borrowed public client id. Never authorized from Pi. */
export function isSupergrokImpersonatedClientId(clientId: string | undefined | null): boolean {
  return (clientId ?? "").trim() === PI_SUPERGROK_GROK_CLI_CLIENT_ID;
}

/** True for per-token API credentials. API billing is never this route. */
export function isSupergrokApiKeyCredential(value: string | undefined | null): boolean {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return false;
  return /^sk-[A-Za-z0-9_-]{8,}$/.test(trimmed) || /^xai-[A-Za-z0-9_-]{8,}$/.test(trimmed);
}

/** True when a profile bills the Go pool instead of the SuperGrok pool. */
export function isSupergrokGoPool(payer: string | undefined, pool: string | undefined): boolean {
  return (payer ?? "").trim() === PI_SUPERGROK_GO_PAYER || (pool ?? "").trim() === PI_SUPERGROK_GO_POOL;
}

/**
 * Refuse every forbidden credential source without substitution: a borrowed
 * client id (impersonation), a third-party provider id or token path, an
 * API key (per-token payer), or anything routed at the Go gateway/pool.
 */
export function assertNoForbiddenSupergrokSource(opts: {
  clientId?: string;
  provider?: string;
  accessToken?: string;
  payer?: string;
  pool?: string;
  endpoint?: string;
  tokenPath?: string;
}): void {
  if (isSupergrokImpersonatedClientId(opts.clientId)) {
    throw new SupergrokPiDeniedError(
      "refusing SuperGrok Pi route: borrowed Grok-CLI client id is client impersonation, not an authorized Pi client"
    );
  }
  const provider = (opts.provider ?? "").trim().toLowerCase();
  if ((PI_SUPERGROK_THIRD_PARTY_PROVIDERS as readonly string[]).includes(provider)) {
    throw new SupergrokPiDeniedError(
      `refusing SuperGrok Pi route: third-party Pi provider '${opts.provider}' is not the authorized route`
    );
  }
  if (isSupergrokApiKeyCredential(opts.accessToken)) {
    throw new SupergrokPiDeniedError(
      "refusing SuperGrok Pi route: API-key credential bills per-token, not the SuperGrok subscription pool"
    );
  }
  if (isSupergrokGoPool(opts.payer, opts.pool)) {
    throw new SupergrokPiDeniedError(
      "refusing SuperGrok Pi route: Go payer/pool is a different subscription, not SuperGrok"
    );
  }
  const endpoint = (opts.endpoint ?? "").trim().toLowerCase();
  if (endpoint.includes("opencode.ai")) {
    throw new SupergrokPiDeniedError(
      "refusing SuperGrok Pi route: Console gateway endpoints bill Go, not the SuperGrok pool"
    );
  }
  const tokenPath = (opts.tokenPath ?? "").trim();
  if (tokenPath.includes(".grok/auth.json") || tokenPath.includes("codex/auth.json")) {
    throw new SupergrokPiDeniedError(
      "refusing SuperGrok Pi route: third-party token reuse across installs/clients is not authorized"
    );
  }
}

/** Fixture-only profile. Fictional credential ref; the allowlist still gates selection. */
export function supergrokPiProfileDefinition(): PiProfileDefinition {
  return {
    provider: PI_SUPERGROK_PROVIDER_ID,
    model: "example-grok-fictional",
    endpoint: PI_SUPERGROK_ENDPOINT,
    fundingPool: PI_SUPERGROK_POOL,
    payer: PI_SUPERGROK_PAYER,
    credentialRef: "env:EXAMPLE_SUPERGROK_OAUTH_CREDENTIAL",
    scopes: ["public"],
  };
}

/**
 * Selection check for the direct SuperGrok route: resolve, require an
 * explicit allowlist entry, then enforce the SuperGrok payer/pool,
 * the official endpoint, the public-only scope, and the forbidden-source
 * refusals. Fails without substitution or paid fallback.
 */
export function selectSupergrokPiRoute(
  name: string,
  catalog: PiProfileCatalog,
  allowlist: readonly string[],
  opts: { scope: PiDataScope; clientId?: string; provider?: string; accessToken?: string; tokenPath?: string }
): PiResolvedRoute {
  const route = selectPiRoute(name, catalog, allowlist, { scope: opts.scope });
  if (route.provider !== PI_SUPERGROK_PROVIDER_ID) {
    throw new PiRouteDeniedError(
      route.name,
      `SuperGrok route needs provider ${PI_SUPERGROK_PROVIDER_ID}, got ${route.provider}`
    );
  }
  if (route.endpoint.replace(/\/+$/, "") !== PI_SUPERGROK_ENDPOINT) {
    throw new PiRouteDeniedError(
      route.name,
      `SuperGrok route needs endpoint ${PI_SUPERGROK_ENDPOINT}, got ${route.endpoint}`
    );
  }
  if (route.payer !== PI_SUPERGROK_PAYER || route.fundingPool !== PI_SUPERGROK_POOL) {
    throw new PiRouteDeniedError(
      route.name,
      `SuperGrok route needs payer ${PI_SUPERGROK_PAYER} / pool ${PI_SUPERGROK_POOL}, got ${route.payer} / ${route.fundingPool}`
    );
  }
  if (route.scopes.includes("private")) {
    throw new PiRouteDeniedError(
      route.name,
      "SuperGrok route serves public scope only until data handling is confirmed"
    );
  }
  assertNoForbiddenSupergrokSource({
    clientId: opts.clientId,
    provider: opts.provider ?? route.provider,
    accessToken: opts.accessToken,
    payer: route.payer,
    pool: route.fundingPool,
    endpoint: route.endpoint,
    tokenPath: opts.tokenPath,
  });
  return route;
}

declare module "./pi_profiles.ts" {
  interface PiResolvedRoute {
    scopeIncludesPrivate?(): boolean;
  }
}

// --- Operator gates (all unsatisfied until a human provides evidence) ---

export interface SupergrokOperatorGate {
  id: "operator-tier" | "unattended-client" | "eligible-surface" | "entitlement-mapping" | "deployment-scope";
  satisfied: boolean;
  detail: string;
}

export interface SupergrokFeasibility {
  feasible: boolean;
  blocked: string[];
  gates: SupergrokOperatorGate[];
}

/**
 * Operator gates for the authorized route. The deployment allowlist must
 * name the route, and a human must confirm the actual tier, the embedded
 * unattended Pi client, eligible-surface billing, and the tier-to-model
 * mapping. Anything missing is recorded as blocked; the caller must not
 * substitute another payer, client, or endpoint. Real sign-in and billing
 * evidence are operator-only and separate from CI.
 */
export function checkSupergrokOperatorGates(opts: {
  allowlist: readonly string[];
  routeName?: string;
  tierConfirmed?: boolean;
  unattendedClientConfirmed?: boolean;
  eligibleSurfaceConfirmed?: boolean;
  entitlementMappingConfirmed?: boolean;
}): SupergrokFeasibility {
  const route = (opts.routeName ?? PI_SUPERGROK_ROUTE_NAME).trim() || PI_SUPERGROK_ROUTE_NAME;
  const gates: SupergrokOperatorGate[] = [
    {
      id: "deployment-scope",
      satisfied: opts.allowlist.includes(route),
      detail: opts.allowlist.includes(route)
        ? `deployment allowlist names ${route}`
        : `add ${route} to JUMI_PI_ALLOWED_ROUTES for this deployment; empty stays disabled`,
    },
    {
      id: "operator-tier",
      satisfied: opts.tierConfirmed === true,
      detail:
        opts.tierConfirmed === true
          ? "operator confirmed the SuperGrok / X Subscription tier covering this use"
          : "confirm the operator's actual tier (SuperGrok vs X Subscription Plus/Premium/Super/Ultra) and its weekly pool",
    },
    {
      id: "unattended-client",
      satisfied: opts.unattendedClientConfirmed === true,
      detail:
        opts.unattendedClientConfirmed === true
          ? "embedded unattended Pi client confirmed by current vendor docs"
          : "confirm an embedded unattended Pi client in current vendor docs; borrowed Grok-CLI client ids and third-party extensions do not count",
    },
    {
      id: "eligible-surface",
      satisfied: opts.eligibleSurfaceConfirmed === true,
      detail:
        opts.eligibleSurfaceConfirmed === true
          ? "Pi inference confirmed as eligible first-party usage under the weekly pool"
          : "confirm Pi inference is an eligible first-party surface (not Additional Usage / top-up spend) in current terms or vendor confirmation",
    },
    {
      id: "entitlement-mapping",
      satisfied: opts.entitlementMappingConfirmed === true,
      detail:
        opts.entitlementMappingConfirmed === true
          ? "tier-to-model entitlement mapping confirmed for the requested model"
          : "confirm which grok-* model ids the tier covers; no model substitution without it",
    },
  ];
  const blocked = gates.filter((gate) => !gate.satisfied).map((gate) => `${gate.id}: ${gate.detail}`);
  return { feasible: blocked.length === 0, blocked, gates };
}

/** Disabled-route notice naming the missing evidence. Never a billing claim. */
export function supergrokBlockedReason(feasibility?: SupergrokFeasibility): string {
  const blocked = feasibility?.blocked ?? [...PI_SUPERGROK_OPEN_QUESTIONS];
  return (
    `direct SuperGrok Pi route ${PI_SUPERGROK_ROUTE_NAME} stays disabled: ` +
    `${blocked.join("; ")}. See ${PI_SUPERGROK_DOC} and ${PI_SUPERGROK_PRICING_URL}.`
  );
}

// --- Session identity (opaque, stable within a conversation) ---

const SUPERGROK_GENERATED_SESSION_RE = /^ses_[0-9a-f]{32}$/;
const PI_AGENT_SESSION_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** True for session ids this route sends: generated `ses_` or Pi agent session ids. */
export function isSupergrokSessionId(id: string): boolean {
  if (!id || id.length > 128) return false;
  if (id.startsWith("ses_")) return SUPERGROK_GENERATED_SESSION_RE.test(id);
  if (!PI_AGENT_SESSION_RE.test(id)) return false;
  if (id.includes("@") || id.includes("/") || id.includes("\\") || /\s/.test(id)) return false;
  return true;
}

/** Fail closed before any fetch when the session id is not opaque. */
export function assertSupergrokSessionId(id: string): void {
  if (!isSupergrokSessionId(id)) {
    throw new Error("refusing the SuperGrok request: session id is not an opaque conversation id");
  }
}

/** Mint one opaque conversation id. Never derived from a repo path, username, or HOME. */
export function createSupergrokSessionId(randomHex: () => string = defaultRandomHex): string {
  return `ses_${randomHex()}`;
}

function defaultRandomHex(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

// --- Error contract (shared kinds; tier/entitlement is denied, never quota) ---

const SUPERGROK_ENTITLEMENT_RE =
  /subscription required|no supergrok|supergrok required|entitlement|not entitled|plan required|upgrade.*plan|403.*premium/i;

const SUPERGROK_TIER_403_RE = /403/;

const SUPERGROK_QUOTA_RE =
  /weekly pool|rate[- ]limited|usage limit|quota|too many requests|429|top-?up|additional usage/i;

/**
 * Classify one SuperGrok failure into the shared adapter kinds. A missing
 * subscription or tier (403, entitlement wording) is denied (fix: check
 * the tier, never fail over to API/Go); auth expiry stays distinct from
 * quota; cancellation stays distinct from provider failures.
 */
export function classifySupergrokPiError(message: string | null | undefined): PiAdapterKind {
  const text = message ?? "";
  if (!text) return "provider-failure";
  if (SUPERGROK_ENTITLEMENT_RE.test(text)) return "denied";
  if (SUPERGROK_TIER_403_RE.test(text) && /supergrok|subscription|entitle|premium|plan/i.test(text)) return "denied";
  const shared = classifyPiAdapterError(text);
  if (shared === "cancelled" || shared === "auth-expired") return shared;
  if (SUPERGROK_QUOTA_RE.test(text)) return "quota";
  return shared;
}

/**
 * Map one SuperGrok failure into the shared adapter result. `usage` is
 * attached only when the provider reported it (missing is never zero).
 * Quota carries the reset the provider actually stated, never a guess,
 * and stays retryable-after-reset with no metered failover.
 */
export function toSupergrokPiAdapterResult(
  message: string,
  usage?: PiUsage,
  quota?: { resetting?: boolean; resetAtMs?: number; retryAfterMs?: number }
): PiAdapterResult {
  const kind = classifySupergrokPiError(message);
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

export interface SupergrokChatCompletionInput {
  /** API base URL. Explicit: tests use loopback, never the vendor. */
  baseUrl: string;
  /** OAuth subscription bearer. Missing fails closed with no fetch. Never logged. */
  accessToken: string | undefined;
  /** Opaque conversation id. Invalid fails closed with no fetch. */
  sessionId: string;
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Key-free configuration reason. Never contains a credential. */
export function supergrokMissingCredentialMessage(): string {
  return "refusing the SuperGrok request: no OAuth subscription bearer (provider auth failure)";
}

/**
 * POST one OpenAI chat-completions request to the xAI base and map the
 * outcome into the shared adapter result. Exactly one attempt: no retry,
 * no substitution, no API/Go failover. Top-ups (Additional Usage spend)
 * stay disabled: a quota refusal returns `quota` and the caller blocks.
 * Missing bearer or session id returns `auth-expired` / throws before any
 * fetch, so the endpoint observes zero requests. Error text never contains
 * the bearer.
 */
export async function postSupergrokChatCompletion(input: SupergrokChatCompletionInput): Promise<PiAdapterResult> {
  if (!input.accessToken) {
    return piAdapterAuthExpired(supergrokMissingCredentialMessage());
  }
  assertSupergrokSessionId(input.sessionId);
  const url = `${input.baseUrl.replace(/\/+$/, "")}${PI_SUPERGROK_CHAT_COMPLETIONS_PATH}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.accessToken}`,
    "x-supergrok-session": input.sessionId,
    "content-type": "application/json",
  };
  const body = JSON.stringify({
    model: input.model ?? "example-grok-fictional",
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
    return toSupergrokPiAdapterResult(redactSupergrokPiText(message, [input.accessToken]));
  }
  if (response.ok) {
    return supergrokOkFromBody(await response.text().catch(() => ""));
  }
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const text = redactSupergrokPiText((await response.text().catch(() => "")).slice(0, 2000), [input.accessToken]);
  const message = `SuperGrok request failed (${response.status}): ${text || response.statusText}`.slice(0, 2000);
  if (response.status === 401) return toSupergrokPiAdapterResult(`API Error: 401 Unauthorized: ${text}`);
  if (response.status === 403) {
    if (SUPERGROK_ENTITLEMENT_RE.test(text) || /supergrok|subscription|entitle|premium|plan/i.test(text)) {
      return toSupergrokPiAdapterResult(text);
    }
    return toSupergrokPiAdapterResult(text);
  }
  if (response.status === 429 || /rate-limited|rate limited|quota|usage limit|weekly.*pool/i.test(text)) {
    return toSupergrokPiAdapterResult(message, undefined, {
      resetting: retryAfterMs !== undefined || /reset/i.test(text),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return toSupergrokPiAdapterResult(message);
}

function supergrokOkFromBody(text: string): PiAdapterResult {
  if (!text) return { kind: "ok", message: "SuperGrok request succeeded" };
  try {
    const body = JSON.parse(text) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const prompt = body.usage?.prompt_tokens;
    const completion = body.usage?.completion_tokens;
    if (typeof prompt === "number" && typeof completion === "number") {
      const usage: PiUsage = { inputTokens: prompt, outputTokens: completion };
      return { kind: "ok", usage, message: "SuperGrok request succeeded" };
    }
    return { kind: "ok", message: "SuperGrok request succeeded" };
  } catch {
    return { kind: "ok", message: "SuperGrok request succeeded" };
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

// --- Redaction (child output, logs, and error text never carry credentials) ---

/**
 * Scrub subscription credentials from text: bearer, refresh, user/device
 * codes, and any extra secrets the caller names. Idempotent; safe on
 * already-redacted text.
 */
export function redactSupergrokPiText(text: string, extraSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    const trimmed = (secret ?? "").trim();
    if (trimmed.length >= 8) out = out.split(trimmed).join("[redacted]");
  }
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  out = out.replace(/(refresh[_-]?token["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  out = out.replace(/(user[_-]?code["'\s:=]+)[A-Za-z0-9-]{4,}/gi, "$1[redacted]");
  return out;
}

// --- Fixture credential store (dummy credentials only; offline proof) ---

export interface SupergrokFixtureSeed {
  access: string;
  refresh: string;
  expiresAtMs: number;
  generation?: number;
  revoked?: boolean;
}

export interface SupergrokChildView {
  access: string;
  argv: string[];
  env: Record<string, string>;
  files: Record<string, string>;
  endpoints: string[];
}

export interface SupergrokFixtureSnapshot {
  access: string;
  refresh: string;
  expiresAtMs: number;
  generation: number;
  revoked: boolean;
}

function leakIn(haystacks: readonly string[], secret: string): boolean {
  if (!secret) return false;
  return haystacks.some((hay) => hay.includes(secret));
}

/** The only view a tool context may observe. Refresh never appears here. */
export function supergrokChildView(access: string): SupergrokChildView {
  return {
    access,
    argv: ["inference", "--standalone"],
    env: { SUPERGROK_BEARER: access, HOME: "/empty-job-home", PATH: "/usr/bin:/bin" },
    files: { "credential.json": JSON.stringify({ access }) },
    endpoints: ["https://api.x.ai/v1/chat/completions (bearer only; no refresh endpoint published)"],
  };
}

/** Name the leak, if the tool-context view exposes renewal authority or another payer. */
export function supergrokChildViewLeaks(
  view: SupergrokChildView,
  secret: SupergrokFixtureSnapshot
): string | undefined {
  const haystacks = [...Object.values(view.env), ...view.argv, ...Object.values(view.files), ...view.endpoints];
  if (leakIn(haystacks, secret.refresh)) return "refresh token reachable from tool context";
  if (leakIn(haystacks, "xai-") && view.env.XAI_API_KEY !== undefined) return "API-key credential in tool env";
  if (leakIn(haystacks, "opencode-go")) return "Go routing in SuperGrok tool context";
  if (Object.keys(view.env).some((key) => /FORGE|GITEA|GITHUB|WEBHOOK|SECRETS/.test(key))) {
    return "forge credential in tool env";
  }
  if (/\.grok\/auth\.json|codex\/auth\.json/.test(haystacks.join(" "))) return "third-party token path in tool context";
  return undefined;
}

/**
 * Offline fixture store with dummy credentials. Mirrors the production
 * shape (`src/xai_auth.ts` parent-owned grant): rotation does not revoke
 * an already-issued bearer; only revocation or expiry fails inference
 * closed. Concurrent refresh shares one POST double.
 */
export class SupergrokFixtureStore {
  private current: SupergrokFixtureSnapshot;
  private issued: Set<string>;
  private queue: Promise<unknown> = Promise.resolve();
  private inflight: Promise<SupergrokFixtureSnapshot> | undefined;
  private refreshPosts = 0;
  private readonly postRefresh: (refresh: string) => Promise<{ access: string; refresh: string }>;
  private readonly now: () => number;

  constructor(
    seed: SupergrokFixtureSeed,
    opts: {
      postRefresh?: (refresh: string) => Promise<{ access: string; refresh: string }>;
      now?: () => number;
    } = {}
  ) {
    this.current = {
      access: seed.access,
      refresh: seed.refresh,
      expiresAtMs: seed.expiresAtMs,
      generation: seed.generation ?? 1,
      revoked: seed.revoked ?? false,
    };
    this.issued = new Set([seed.access]);
    this.now = opts.now ?? (() => Date.now());
    this.postRefresh =
      opts.postRefresh ??
      (async (refresh: string) => {
        this.refreshPosts += 1;
        return { access: `dummy-supergrok-access-${refresh.length}-${this.refreshPosts}`, refresh: `${refresh}-next` };
      });
  }

  get posts(): number {
    return this.refreshPosts;
  }

  snapshot(): SupergrokFixtureSnapshot {
    return { ...this.current };
  }

  isExpired(at = this.now()): boolean {
    return at >= this.current.expiresAtMs;
  }

  /** Permitted inference: an issued, unrevoked, unexpired bearer succeeds. */
  inference(access: string, at = this.now()): boolean {
    if (this.current.revoked) return false;
    if (!access || !this.issued.has(access)) return false;
    if (access === this.current.access && at >= this.current.expiresAtMs) return false;
    return true;
  }

  /** Serialized renewal: concurrent callers share the one in-flight POST. */
  refresh(): Promise<SupergrokFixtureSnapshot> {
    if (this.inflight) return this.inflight;
    const run = this.queue.then(
      () => this.refreshLocked(),
      () => this.refreshLocked()
    );
    this.inflight = run;
    const clear = () => {
      if (this.inflight === run) this.inflight = undefined;
    };
    void run.then(clear, clear);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async refreshLocked(): Promise<SupergrokFixtureSnapshot> {
    if (this.current.revoked) throw new Error("grant revoked: re-login required");
    const rotated = await this.postRefresh(this.current.refresh);
    this.current = {
      access: rotated.access,
      refresh: rotated.refresh,
      expiresAtMs: this.now() + 3_600_000,
      generation: this.current.generation + 1,
      revoked: false,
    };
    this.issued.add(this.current.access);
    return { ...this.current };
  }

  revoke(): void {
    this.current = { ...this.current, revoked: true };
  }

  expire(): void {
    this.current = { ...this.current, expiresAtMs: this.now() - 1 };
  }

  childView(): SupergrokChildView {
    return supergrokChildView(this.current.access);
  }
}
