/**
 * Pi model profile resolution without changing payer or privacy policy.
 *
 * A named Pi profile resolves to an exact provider, model, effort (Pi
 * thinking level), funding pool, credential reference, and model-family
 * identity. One deployment-owned route allowlist is authoritative: all
 * production routes default off. Having a profile, a key, an installed
 * adapter, or a discovered model never enables a route.
 *
 * Checks run at selection time (`selectPiRoute`) and at handoff time
 * (`checkPiHandoff`). A repository may narrow permissions, never add models
 * or accounts (`narrowPiRoutesWithRepo` is an intersection). Callers pass an
 * explicit allowlist; an allowlist inside an isolated fixture never opts
 * production in because production reads only the deployment env
 * (`JUMI_PI_ALLOWED_ROUTES`, default empty) and this module keeps no global.
 *
 * Upstream grounding:
 * - Pi providers/models/auth: https://docs.pi.dev/latest/models,
 *   https://docs.pi.dev/latest/providers
 * - Pi 429/401/403/quota/529/5xx rotation classes:
 *   https://pi.dev/packages/@jeryjs/pi-keyrouter
 * - OpenCode Zen pay-as-you-go (`opencode`, workspace balance) vs Go
 *   subscription (`opencode-go`, shared pool), Go usage endpoint
 *   `GET https://opencode.ai/zen/go/v1/usage`, Contributor training terms,
 *   Google retention: https://opencode.ai/docs/console/go,
 *   https://opencode.ai/docs/console/models, https://getaight.ai/blog/opencode-zen/
 * - Zen endpoint topology `https://opencode.ai/zen/v1/*`:
 *   https://github.com/rabden/pi-opencode-zen/blob/main/docs/zen-gate-notes.md
 *
 * Legacy catalogs and behavior are unchanged: this module is not imported by
 * the legacy dispatch (`engine_dispatch.ts`, `runners.ts`, `config.ts`), and
 * Pi selection never creates an `independentReview` policy.
 */

import { chooseRandomStartIndex } from "./runners.ts";

/** Deployment-owned allowlist env: CSV of allowed Pi route (profile) names. Default off. */
export const PI_ALLOWED_ROUTES_ENV = "JUMI_PI_ALLOWED_ROUTES" as const;

/** Data sensitivity of one request. Contributor SKUs train on data, so private is refused. */
export type PiDataScope = "public" | "private";

/** One configured Pi profile. The credential reference is opaque (never a value). */
export interface PiProfileDefinition {
  provider: string;
  model: string;
  effort?: string;
  /** Provider base URL. Must be a known endpoint; unknown endpoints fail closed. */
  endpoint: string;
  /** Shared funding pool (aliases share one pool). Opaque name, never a secret. */
  fundingPool: string;
  /** Who is billed (for example `workspace-balance` vs `go-subscription`). Opaque name. */
  payer: string;
  /** Opaque credential reference (for example `env:EXAMPLE_ZEN_KEY`). Never a value. */
  credentialRef: string;
  /** Data scopes this route may serve. Contributor routes list only `public`. */
  scopes: PiDataScope[];
  /** Billing SKU (for example `contributor` for training-discounted models). */
  sku?: string;
}

export type PiProfileCatalog = Record<string, PiProfileDefinition>;

/** A resolved Pi route: exact selection plus family identity. */
export interface PiResolvedRoute {
  name: string;
  provider: string;
  model: string;
  effort?: string;
  endpoint: string;
  fundingPool: string;
  payer: string;
  credentialRef: string;
  scopes: PiDataScope[];
  sku?: string;
  /** Model-family identity: provider (lowercased) + model. Ignores effort and billing. */
  family: string;
}

export type PiSelectionMode = "ordered" | "random-start";

/** Known Pi/OpenCode endpoints. Anything else fails closed at resolve time. */
export const KNOWN_PI_ENDPOINTS: readonly string[] = [
  "https://opencode.ai/zen/v1",
  "https://opencode.ai/zen/go/v1",
  "https://opencode.ai/inference/v1",
  "process://claude-code",
];

const GOOGLE_PI_PROVIDERS = new Set(["google", "google-vertex", "google-vertex-ai", "google-generative-ai"]);

export class PiRouteNotFoundError extends Error {
  constructor(name: string) {
    super(`Unknown Pi profile: ${name}`);
    this.name = "PiRouteNotFoundError";
  }
}

export class PiRouteDeniedError extends Error {
  constructor(name: string, reason: string) {
    super(`Pi route denied for ${name}: ${reason}`);
    this.name = "PiRouteDeniedError";
  }
}

export class PiRouteNotAllowedError extends Error {
  constructor(name: string) {
    super(
      `Pi route not allowed: ${name} is configured but not in the deployment allowlist (${PI_ALLOWED_ROUTES_ENV}); refusing without substitution or paid fallback`
    );
    this.name = "PiRouteNotAllowedError";
  }
}

export class PiRouteScopeRefusedError extends Error {
  constructor(name: string, scope: PiDataScope) {
    super(`Pi route refused for ${name}: ${scope} scope is not permitted for this SKU`);
    this.name = "PiRouteScopeRefusedError";
  }
}

/** Parse a deployment allowlist value (CSV string or string array). Default off: unset is `[]`. */
export function parsePiAllowedRoutes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const name = part.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Read the deployment allowlist from env. Unset or blank is `[]` (all routes off). */
export function piAllowedRoutesFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return parsePiAllowedRoutes(env[PI_ALLOWED_ROUTES_ENV]);
}

/** True for Google models, including a Google model served through another payer (Go). */
export function isGooglePiModel(provider: string, model: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  if (GOOGLE_PI_PROVIDERS.has(normalizedProvider)) return true;
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel.includes("gemini") || normalizedModel.includes("gemma") || normalizedModel.includes("google");
}

/** True for training-discounted SKUs (for example Muse Spark Contributor). */
export function isContributorSku(sku: string | undefined): boolean {
  return (sku ?? "").trim().toLowerCase() === "contributor";
}

/** Model-family identity. Ignores effort/thinking level, payer, pool, and credential. */
export function piFamilyOf(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}|${model.trim()}`;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

function isKnownPiEndpoint(endpoint: string): boolean {
  const normalized = normalizeEndpoint(endpoint);
  return KNOWN_PI_ENDPOINTS.some((known) => normalizeEndpoint(known) === normalized);
}

/**
 * Resolve a named profile to its exact route. Fails closed on unknown
 * profiles, unknown endpoints, and Google models (including via Go). Having
 * the profile does not allow it; callers must still check the allowlist.
 */
export function resolvePiProfile(name: string, catalog: PiProfileCatalog): PiResolvedRoute {
  const trimmed = name.trim();
  if (!trimmed) throw new PiRouteNotFoundError(name);
  const def = catalog[trimmed];
  if (!def) throw new PiRouteNotFoundError(name);
  const provider = def.provider.trim();
  const model = def.model.trim();
  if (!provider || !model) throw new PiRouteDeniedError(trimmed, "profile must name a provider and model");
  if (!def.endpoint.trim() || !isKnownPiEndpoint(def.endpoint)) {
    throw new PiRouteDeniedError(trimmed, `unknown endpoint ${def.endpoint.trim() || "(empty)"}`);
  }
  if (isGooglePiModel(provider, model)) {
    throw new PiRouteDeniedError(trimmed, `Google models are denied (provider ${provider}, model ${model})`);
  }
  if (!def.fundingPool.trim() || !def.payer.trim() || !def.credentialRef.trim()) {
    throw new PiRouteDeniedError(trimmed, "profile must name a funding pool, payer, and credential reference");
  }
  if (def.scopes.length === 0) throw new PiRouteDeniedError(trimmed, "profile must allow at least one scope");
  const effort = def.effort?.trim() ? def.effort.trim() : undefined;
  const sku = def.sku?.trim() ? def.sku.trim() : undefined;
  return {
    name: trimmed,
    provider,
    model,
    ...(effort ? { effort } : {}),
    endpoint: def.endpoint.trim(),
    fundingPool: def.fundingPool.trim(),
    payer: def.payer.trim(),
    credentialRef: def.credentialRef.trim(),
    scopes: [...def.scopes],
    ...(sku ? { sku } : {}),
    family: piFamilyOf(provider, model),
  };
}

/** Exact allowlist match. Case-sensitive; all production routes default off. */
export function isPiRouteAllowed(name: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(name.trim());
}

/**
 * Repository narrowing: the effective allowlist is the intersection. A repo
 * list may narrow permissions, never add models or accounts; `undefined`
 * keeps the deployment list.
 */
export function narrowPiRoutesWithRepo(
  deploymentAllowlist: readonly string[],
  repoAllowed: readonly string[] | undefined
): string[] {
  if (repoAllowed === undefined) return [...deploymentAllowlist];
  const deployed = new Set(deploymentAllowlist.map((name) => name.trim()).filter(Boolean));
  return repoAllowed.map((name) => name.trim()).filter((name) => name && deployed.has(name));
}

function throwIfScopeRefused(route: PiResolvedRoute, scope: PiDataScope | undefined): void {
  if (scope === undefined) return;
  if (route.scopes.includes(scope)) {
    if (scope === "private" && isContributorSku(route.sku)) {
      throw new PiRouteScopeRefusedError(route.name, scope);
    }
    return;
  }
  throw new PiRouteScopeRefusedError(route.name, scope);
}

/**
 * Selection check: resolve, deny unknown endpoints/Google models, require an
 * explicit allowlist entry, then enforce the data scope. Fails without
 * substitution or paid fallback: the caller must not pick another route.
 */
export function selectPiRoute(
  name: string,
  catalog: PiProfileCatalog,
  allowlist: readonly string[],
  opts: { scope?: PiDataScope } = {}
): PiResolvedRoute {
  const route = resolvePiProfile(name, catalog);
  if (!isPiRouteAllowed(route.name, allowlist)) throw new PiRouteNotAllowedError(route.name);
  throwIfScopeRefused(route, opts.scope);
  return route;
}

/**
 * Handoff check: re-resolve and re-check the effective (repo-narrowed)
 * allowlist plus scope when a route crosses a stage boundary. Same fail-
 * closed shape as selection; never widens.
 */
export function checkPiHandoff(
  name: string,
  catalog: PiProfileCatalog,
  deploymentAllowlist: readonly string[],
  opts: { repoAllowed?: readonly string[]; scope?: PiDataScope } = {}
): PiResolvedRoute {
  const effective = narrowPiRoutesWithRepo(deploymentAllowlist, opts.repoAllowed);
  return selectPiRoute(name, catalog, effective, { scope: opts.scope });
}

// --- Adapter result contract ---

/** Per-run token usage. Absent (`undefined`) means missing, never zero. */
export interface PiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type PiAdapterKind = "ok" | "auth-expired" | "quota" | "cancelled" | "provider-failure" | "denied";

export interface PiAdapterResult {
  kind: PiAdapterKind;
  /** Absent means the provider reported no usage (missing), never zero. */
  usage?: PiUsage;
  /** True only for auth-expiry results. */
  authExpired?: boolean;
  /** Quota class plus the reset the provider actually stated (never guessed). */
  quota?: { resetting: boolean; resetAtMs?: number; retryAfterMs?: number };
  message?: string;
  /** Whether the caller may retry (quota with reset, transient 5xx/529). */
  retryable?: boolean;
}

/** True only when the adapter reported usage. Missing (`undefined`) is not zero. */
export function hasPiUsage(result: PiAdapterResult): boolean {
  return result.usage !== undefined;
}

const PI_AUTH_RE =
  /invalid_grant|oauth.+expired|expired.+oauth|refresh_token_invalidated|token_invalidated|ProviderAuthError|failed to retrieve token|error getting token source|not logged in|login expired|please run \/login|401\s*Unauthorized|API Error:\s*401/i;

const PI_QUOTA_RE =
  /FreeUsageLimitError|GoUsageLimitError|Free usage exceeded|Free limit reached|Go limit reached|free_tier_limit|account_rate_limit|quota exceeded|insufficient_quota|insufficient balance|Insufficient account funds|Rate limit exceeded|429|too many requests/i;

const PI_CANCEL_RE = /AbortError|cancelled|The operation was aborted/i;

const PI_TRANSIENT_RE = /529|overloaded|fetch failed|Connection error|timeout|timed out|502|503|500/i;

/**
 * Classify one adapter failure into the result contract. Auth expiry stays
 * distinct from quota/reset; cancellation stays distinct from provider
 * failures. Pure string match over the provider text the caller passes in,
 * same discipline as `auth.ts`/`quota.ts`.
 */
export function classifyPiAdapterError(message: string | null | undefined): PiAdapterKind {
  const text = message ?? "";
  if (!text) return "provider-failure";
  if (PI_CANCEL_RE.test(text)) return "cancelled";
  if (PI_AUTH_RE.test(text)) return "auth-expired";
  if (PI_QUOTA_RE.test(text)) return "quota";
  return "provider-failure";
}

export function piAdapterDenied(message: string): PiAdapterResult {
  return { kind: "denied", message, retryable: false };
}

export function piAdapterAuthExpired(message: string): PiAdapterResult {
  return { kind: "auth-expired", message, authExpired: true, retryable: false };
}

export function piAdapterQuota(
  message: string,
  opts: { resetting: boolean; resetAtMs?: number; retryAfterMs?: number } = { resetting: false }
): PiAdapterResult {
  return {
    kind: "quota",
    message,
    quota: { ...opts },
    retryable: true,
  };
}

export function piAdapterCancelled(message: string): PiAdapterResult {
  return { kind: "cancelled", message, retryable: false };
}

export function piAdapterProviderFailure(message: string, retryable?: boolean): PiAdapterResult {
  return { kind: "provider-failure", message, retryable: retryable ?? PI_TRANSIENT_RE.test(message) };
}

// --- Chain order (ordered / random-start), never independent review ---

/**
 * Order one Pi attempt. `ordered` (default) keeps configured order;
 * `random-start` uniformly picks a start from the eligible chain and
 * rotates, wrapping. Mirrors `orderChainForJob` without importing runner
 * policy or enabling independent review: same-family routes stay eligible.
 */
export function orderPiRoutes(
  chain: readonly PiResolvedRoute[],
  selection?: PiSelectionMode | undefined,
  random: () => number = Math.random
): PiResolvedRoute[] {
  const copy = [...chain];
  if (selection !== "random-start" || copy.length <= 1) return copy;
  const start = chooseRandomStartIndex(copy.length, random);
  const normalized = ((Math.trunc(start) % copy.length) + copy.length) % copy.length;
  if (normalized === 0) return copy;
  return [...copy.slice(normalized), ...copy.slice(0, normalized)];
}
