/**
 * Pi attempt stamp (jumi#939).
 *
 * Extends the additive attempt-mode stamp (`harness_mode`) with the named
 * profile, role, model, actual funding route (pool + payer), and outcome,
 * plus the available token/cache/reasoning usage. Unknown usage stays
 * unknown (absent/NULL), never zero: a provider that states no usage leaves
 * the cell absent so dashboards never mistake "not reported" for "free".
 *
 * Historical rows predate every column and read as absent. Ledger dashboards
 * (`run_usage.ts`) keep their existing label sets: this stamp never adds a
 * per-session metric label. No secrets (never `credentialRef`), no content
 * (never prompts, diffs, or messages), no session ids.
 */

import type { PiAdapterKind, PiResolvedRoute, PiUsage } from "./pi_profiles.ts";

/** Job role behind one Pi attempt. Mirrors `JobKind`. */
export const PI_ATTEMPT_ROLES = ["review", "implement", "follow-up", "conflict"] as const;

export type PiAttemptRole = (typeof PI_ATTEMPT_ROLES)[number];

/** Outcome of one Pi attempt. Mirrors `PiAdapterKind`. */
export type PiAttemptOutcome = PiAdapterKind;

const PI_ATTEMPT_OUTCOMES: readonly PiAttemptOutcome[] = [
  "ok",
  "auth-expired",
  "quota",
  "cancelled",
  "provider-failure",
  "denied",
];

/**
 * Available usage for one attempt. Every cell is optional: absent means the
 * provider did not state it (unknown), never zero. A stated zero stays zero.
 */
export interface PiAttemptUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/**
 * Additive Pi attempt stamp. All identity fields are opaque deployment
 * names (profile, pool, payer), never secrets or content.
 */
export interface PiAttemptStamp {
  profile: string;
  role: PiAttemptRole;
  model: string;
  fundingPool: string;
  payer: string;
  outcome: PiAttemptOutcome;
  usage?: PiAttemptUsage;
}

/** Flat ledger form. Unknown usage cells are NULL (never zero). */
export interface PiAttemptRecord {
  piProfile: string | null;
  piRole: string | null;
  piModel: string | null;
  piFundingPool: string | null;
  piPayer: string | null;
  piOutcome: string | null;
  piTokensInput: number | null;
  piTokensCacheRead: number | null;
  piTokensOutput: number | null;
  piTokensCacheWrite: number | null;
  piTokensReasoning: number | null;
}

export function isPiAttemptRole(value: unknown): value is PiAttemptRole {
  return typeof value === "string" && (PI_ATTEMPT_ROLES as readonly string[]).includes(value);
}

export function isPiAttemptOutcome(value: unknown): value is PiAttemptOutcome {
  return typeof value === "string" && (PI_ATTEMPT_OUTCOMES as readonly string[]).includes(value);
}

function cleanTokenCell(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let num: number;
  if (typeof value === "bigint") {
    num = Number(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    num = Number(trimmed);
  } else if (typeof value === "number") {
    num = value;
  } else {
    return undefined;
  }
  if (!Number.isFinite(num)) return undefined;
  if (num < 0) return undefined;
  return Math.floor(num);
}

/**
 * Normalize provider-reported usage. Present finite cells are preserved
 * (including a stated zero); missing, negative, or non-finite cells stay
 * absent (unknown), never zero. Returns `undefined` when nothing was
 * stated so the stamp omits `usage` entirely.
 */
export function normalizePiAttemptUsage(
  usage: PiUsage | PiAttemptUsage | null | undefined
): PiAttemptUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const out: PiAttemptUsage = {};
  const input = cleanTokenCell((usage as { inputTokens?: unknown }).inputTokens);
  const cached = cleanTokenCell((usage as { cachedInputTokens?: unknown }).cachedInputTokens);
  const output = cleanTokenCell((usage as { outputTokens?: unknown }).outputTokens);
  const cacheWrite = cleanTokenCell((usage as { cacheWriteTokens?: unknown }).cacheWriteTokens);
  const reasoning = cleanTokenCell((usage as { reasoningTokens?: unknown }).reasoningTokens);
  if (input !== undefined) out.inputTokens = input;
  if (cached !== undefined) out.cachedInputTokens = cached;
  if (output !== undefined) out.outputTokens = output;
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined) out.reasoningTokens = reasoning;
  return Object.keys(out).length > 0 ? out : undefined;
}

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build one attempt stamp from the resolved route that actually ran, the
 * role behind the attempt, the adapter outcome, and the usage the provider
 * actually stated. Never carries `credentialRef`, endpoints, content, or
 * session ids. Throws on a blank identity field (fail closed in code).
 */
export function buildPiAttemptStamp(opts: {
  route: PiResolvedRoute;
  role: PiAttemptRole | string;
  outcome: PiAttemptOutcome | string;
  usage?: PiUsage | PiAttemptUsage | null;
}): PiAttemptStamp {
  const profile = cleanName(opts.route?.name);
  const model = cleanName(opts.route?.model);
  const fundingPool = cleanName(opts.route?.fundingPool);
  const payer = cleanName(opts.route?.payer);
  const role = cleanName(opts.role);
  const outcome = cleanName(opts.outcome);
  if (!profile) throw new Error("pi attempt stamp needs a profile name");
  if (!isPiAttemptRole(role)) throw new Error(`pi attempt stamp needs a role (${PI_ATTEMPT_ROLES.join("|")})`);
  if (!model) throw new Error("pi attempt stamp needs a model");
  if (!fundingPool) throw new Error("pi attempt stamp needs a funding pool");
  if (!payer) throw new Error("pi attempt stamp needs a payer");
  if (!isPiAttemptOutcome(outcome)) throw new Error("pi attempt stamp needs an outcome");
  const raw = opts.usage as PiUsage | PiAttemptUsage | null | undefined;
  // One normalizer over all five cells: unknown stays absent, a stated zero
  // stays zero (including cache-write/reasoning-only usage).
  const normalizedUsage = raw && typeof raw === "object" ? normalizePiAttemptUsage(raw) : undefined;
  return {
    profile,
    role,
    model,
    fundingPool,
    payer,
    outcome,
    ...(normalizedUsage ? { usage: normalizedUsage } : {}),
  };
}

/**
 * Flatten a stamp for the ledger. Unknown usage cells are NULL, never zero.
 * Identity fields are trimmed opaque names; secrets never appear here (the
 * builder never accepts a `credentialRef`).
 */
export function piAttemptStampToRecord(stamp: PiAttemptStamp | null | undefined): PiAttemptRecord {
  if (!stamp) {
    return {
      piProfile: null,
      piRole: null,
      piModel: null,
      piFundingPool: null,
      piPayer: null,
      piOutcome: null,
      piTokensInput: null,
      piTokensCacheRead: null,
      piTokensOutput: null,
      piTokensCacheWrite: null,
      piTokensReasoning: null,
    };
  }
  return {
    piProfile: stamp.profile,
    piRole: stamp.role,
    piModel: stamp.model,
    piFundingPool: stamp.fundingPool,
    piPayer: stamp.payer,
    piOutcome: stamp.outcome,
    piTokensInput: stamp.usage?.inputTokens ?? null,
    piTokensCacheRead: stamp.usage?.cachedInputTokens ?? null,
    piTokensOutput: stamp.usage?.outputTokens ?? null,
    piTokensCacheWrite: stamp.usage?.cacheWriteTokens ?? null,
    piTokensReasoning: stamp.usage?.reasoningTokens ?? null,
  };
}

/**
 * Rebuild a stamp from a ledger row. Historical rows (all pi columns NULL)
 * read as `undefined` so old whole-row assertions do not change. A row with
 * a partial identity (for example a profile but no outcome) also reads as
 * `undefined`: a stamp is all-or-nothing, never a half identity.
 */
export function piAttemptStampFromRecord(record: {
  piProfile?: unknown;
  pi_profile?: unknown;
  piRole?: unknown;
  pi_role?: unknown;
  piModel?: unknown;
  pi_model?: unknown;
  piFundingPool?: unknown;
  pi_funding_pool?: unknown;
  piPayer?: unknown;
  pi_payer?: unknown;
  piOutcome?: unknown;
  pi_outcome?: unknown;
  piTokensInput?: unknown;
  pi_tokens_input?: unknown;
  piTokensCacheRead?: unknown;
  pi_tokens_cache_read?: unknown;
  piTokensOutput?: unknown;
  pi_tokens_output?: unknown;
  piTokensCacheWrite?: unknown;
  pi_tokens_cache_write?: unknown;
  piTokensReasoning?: unknown;
  pi_tokens_reasoning?: unknown;
}): PiAttemptStamp | undefined {
  const pick = (camel: unknown, snake: unknown): unknown => (camel !== undefined ? camel : snake);
  const profile = cleanName(pick(record.piProfile, record.pi_profile));
  const role = cleanName(pick(record.piRole, record.pi_role));
  const model = cleanName(pick(record.piModel, record.pi_model));
  const fundingPool = cleanName(pick(record.piFundingPool, record.pi_funding_pool));
  const payer = cleanName(pick(record.piPayer, record.pi_payer));
  const outcome = cleanName(pick(record.piOutcome, record.pi_outcome));
  if (!profile || !role || !model || !fundingPool || !payer || !outcome) return undefined;
  if (!isPiAttemptRole(role) || !isPiAttemptOutcome(outcome)) return undefined;
  const usage: PiAttemptUsage = {};
  const input = cleanTokenCell(pick(record.piTokensInput, record.pi_tokens_input));
  const cached = cleanTokenCell(pick(record.piTokensCacheRead, record.pi_tokens_cache_read));
  const output = cleanTokenCell(pick(record.piTokensOutput, record.pi_tokens_output));
  const cacheWrite = cleanTokenCell(pick(record.piTokensCacheWrite, record.pi_tokens_cache_write));
  const reasoning = cleanTokenCell(pick(record.piTokensReasoning, record.pi_tokens_reasoning));
  if (input !== undefined) usage.inputTokens = input;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (output !== undefined) usage.outputTokens = output;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return {
    profile,
    role,
    model,
    fundingPool,
    payer,
    outcome,
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

/** True when the row carries no Pi stamp (historical or legacy row). */
export function isHistoricalPiAttemptBlank(record: Parameters<typeof piAttemptStampFromRecord>[0]): boolean {
  return piAttemptStampFromRecord(record) === undefined;
}

/** Log/forging-safe one-line stamp. No secrets, content, or session ids. */
export function formatPiAttemptStamp(stamp: PiAttemptStamp): string {
  const usage = stamp.usage
    ? ` input=${stamp.usage.inputTokens ?? "?"} cached=${stamp.usage.cachedInputTokens ?? "?"} output=${stamp.usage.outputTokens ?? "?"} cache_write=${stamp.usage.cacheWriteTokens ?? "?"} reasoning=${stamp.usage.reasoningTokens ?? "?"}`
    : " usage=unknown";
  return (
    `pi profile=${stamp.profile} role=${stamp.role} model=${stamp.model} ` +
    `pool=${stamp.fundingPool} payer=${stamp.payer} outcome=${stamp.outcome}${usage}`
  );
}
