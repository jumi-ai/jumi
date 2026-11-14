import { isAuthFailure } from "./auth.ts";
import { logDiagnostic } from "./diagnostics.ts";
import { EngineFailedError, type EngineResult } from "./engine.ts";
import { isCreditBalanceText } from "./quota.ts";

export const RUNNER_QUOTA_COOLDOWN_DEFAULT_MS = 60 * 60 * 1000;
export const RUNNER_QUOTA_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;
export const RUNNER_CREDIT_COOLDOWN_DEFAULT_MS = 6 * 60 * 60 * 1000;
export const RUNNER_AUTH_COOLDOWN_DEFAULT_MS = 30 * 60 * 1000;

export interface RunnerCooldownConfig {
  quotaMs: number;
  quotaMaxMs: number;
  creditMs: number;
  authMs: number;
}

export const DEFAULT_RUNNER_COOLDOWN_CONFIG: RunnerCooldownConfig = {
  quotaMs: RUNNER_QUOTA_COOLDOWN_DEFAULT_MS,
  quotaMaxMs: RUNNER_QUOTA_COOLDOWN_MAX_MS,
  creditMs: RUNNER_CREDIT_COOLDOWN_DEFAULT_MS,
  authMs: RUNNER_AUTH_COOLDOWN_DEFAULT_MS,
};

export function resolveRunnerCooldown(input?: Partial<RunnerCooldownConfig> | null): RunnerCooldownConfig {
  if (!input) return { ...DEFAULT_RUNNER_COOLDOWN_CONFIG };
  return {
    quotaMs: input.quotaMs ?? DEFAULT_RUNNER_COOLDOWN_CONFIG.quotaMs,
    quotaMaxMs: input.quotaMaxMs ?? DEFAULT_RUNNER_COOLDOWN_CONFIG.quotaMaxMs,
    creditMs: input.creditMs ?? DEFAULT_RUNNER_COOLDOWN_CONFIG.creditMs,
    authMs: input.authMs ?? DEFAULT_RUNNER_COOLDOWN_CONFIG.authMs,
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function checkCooldownField(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    fail(`Invalid JUMI_RUNNERS_FILE: cooldown ${name} must be a positive number of milliseconds`);
  }
  return n;
}

export function parseRunnerCooldown(raw: unknown): RunnerCooldownConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(`Invalid JUMI_RUNNERS_FILE: cooldown must be an object`);
  }
  const rec = raw as Record<string, unknown>;
  const quotaMs = checkCooldownField("quotaMs", rec.quotaMs ?? rec.quota ?? rec.quotaCooldownMs);
  const quotaMaxMs = checkCooldownField("quotaMaxMs", rec.quotaMaxMs ?? rec.quotaMax ?? rec.maxQuotaMs);
  const creditMs = checkCooldownField("creditMs", rec.creditMs ?? rec.credit ?? rec.creditCooldownMs);
  const authMs = checkCooldownField("authMs", rec.authMs ?? rec.auth ?? rec.authCooldownMs);
  if (quotaMs === undefined && quotaMaxMs === undefined && creditMs === undefined && authMs === undefined) {
    return { ...DEFAULT_RUNNER_COOLDOWN_CONFIG };
  }
  return {
    quotaMs: quotaMs ?? DEFAULT_RUNNER_COOLDOWN_CONFIG.quotaMs,
    quotaMaxMs: quotaMaxMs ?? DEFAULT_RUNNER_COOLDOWN_CONFIG.quotaMaxMs,
    creditMs: creditMs ?? DEFAULT_RUNNER_COOLDOWN_CONFIG.creditMs,
    authMs: authMs ?? DEFAULT_RUNNER_COOLDOWN_CONFIG.authMs,
  };
}

export type RunnerCooldownReason = "quota" | "credit" | "auth";
export type RunnerCooldownSource = "parsed" | "default" | "credential";

export interface RunnerCooldownEntry {
  untilMs: number;
  reason: RunnerCooldownReason;
  source: RunnerCooldownSource;
  fingerprint?: string;
}

export class RunnerCooldownStore {
  private readonly entries = new Map<string, RunnerCooldownEntry>();

  recordQuota(
    name: string,
    input: { retryAfterMs?: number; nowMs: number; config?: RunnerCooldownConfig }
  ): RunnerCooldownEntry {
    const config = input.config ?? DEFAULT_RUNNER_COOLDOWN_CONFIG;
    const nowMs = input.nowMs;
    let untilMs: number;
    let source: RunnerCooldownSource;
    if (input.retryAfterMs != null && Number.isFinite(input.retryAfterMs) && input.retryAfterMs > 0) {
      untilMs = nowMs + Math.min(input.retryAfterMs, config.quotaMaxMs);
      source = "parsed";
    } else {
      untilMs = nowMs + config.quotaMs;
      source = "default";
    }
    const entry: RunnerCooldownEntry = { untilMs, reason: "quota", source };
    this.entries.set(name, entry);
    return entry;
  }

  recordCredit(name: string, input: { nowMs: number; config?: RunnerCooldownConfig }): RunnerCooldownEntry {
    const config = input.config ?? DEFAULT_RUNNER_COOLDOWN_CONFIG;
    const entry: RunnerCooldownEntry = {
      untilMs: input.nowMs + config.creditMs,
      reason: "credit",
      source: "default",
    };
    this.entries.set(name, entry);
    return entry;
  }

  recordAuth(
    name: string,
    input: { nowMs: number; config?: RunnerCooldownConfig; fingerprint?: string }
  ): RunnerCooldownEntry {
    const config = input.config ?? DEFAULT_RUNNER_COOLDOWN_CONFIG;
    const entry: RunnerCooldownEntry = {
      untilMs: input.nowMs + config.authMs,
      reason: "auth",
      source: input.fingerprint !== undefined ? "credential" : "default",
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
    };
    this.entries.set(name, entry);
    return entry;
  }

  clear(name: string): void {
    this.entries.delete(name);
  }

  reset(): void {
    this.entries.clear();
  }

  restore(name: string, entry: RunnerCooldownEntry): void {
    if (!name || !Number.isFinite(entry.untilMs)) return;
    this.entries.set(name, { ...entry });
  }

  isCooled(name: string, nowMs: number, currentFingerprint?: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    if (nowMs >= entry.untilMs) {
      this.entries.delete(name);
      return false;
    }
    if (
      entry.reason === "auth" &&
      currentFingerprint !== undefined &&
      entry.fingerprint !== undefined &&
      currentFingerprint !== entry.fingerprint
    ) {
      this.entries.delete(name);
      return false;
    }
    return true;
  }

  cooldownUntil(name: string): number {
    return this.entries.get(name)?.untilMs ?? 0;
  }

  entry(name: string): RunnerCooldownEntry | undefined {
    return this.entries.get(name);
  }

  prune(nowMs: number): void {
    for (const [name, entry] of this.entries) {
      if (nowMs >= entry.untilMs) this.entries.delete(name);
    }
  }

  earliestExpiry(nowMs: number): number | undefined {
    this.prune(nowMs);
    let earliest: number | undefined;
    for (const entry of this.entries.values()) {
      if (earliest === undefined || entry.untilMs < earliest) earliest = entry.untilMs;
    }
    return earliest;
  }

  earliestCooledName(nowMs: number): string | undefined {
    this.prune(nowMs);
    let best: string | undefined;
    let bestUntil = Infinity;
    for (const [name, entry] of this.entries) {
      if (entry.untilMs < bestUntil) {
        bestUntil = entry.untilMs;
        best = name;
      }
    }
    return best;
  }

  size(): number {
    return this.entries.size;
  }
}

export const engineRunnerCooldowns = new RunnerCooldownStore();
export const workerRunnerCooldowns = new RunnerCooldownStore();

export function isCreditFailureResult(result: EngineResult): boolean {
  return result.status === "stuck" && isCreditBalanceText(result.message ?? "");
}

export function isCreditFailureError(err: unknown): boolean {
  if (err instanceof EngineFailedError) return isCreditBalanceText(err.message ?? "");
  return false;
}

export function classifyCooldownFailure(input: {
  result?: EngineResult;
  err?: unknown;
}): RunnerCooldownReason | undefined {
  if (input.result) {
    const r = input.result;
    if (isCreditFailureResult(r)) return "credit";
    if (r.auth === true) return "auth";
    if (r.quota === "resetting" || r.quota === "hard") return "quota";
    return undefined;
  }
  const err = input.err;
  if (!err) return undefined;
  if (err instanceof EngineFailedError) {
    if (isCreditFailureError(err)) return "credit";
    if (err.auth === true) return "auth";
    if (err.quota === "resetting" || err.quota === "hard") return "quota";
    return undefined;
  }
  if (isAuthFailure(err)) return "auth";
  if (isCreditBalanceText(err instanceof Error ? err.message : String(err))) return "credit";
  return undefined;
}

export function recordRunnerCooldownForFailure(
  store: RunnerCooldownStore,
  runnerName: string,
  input: {
    result?: EngineResult;
    err?: unknown;
    nowMs: number;
    config?: RunnerCooldownConfig;
    authFingerprint?: string;
  }
): RunnerCooldownEntry | undefined {
  const reason = classifyCooldownFailure(input);
  if (!reason) return undefined;
  if (reason === "credit") return store.recordCredit(runnerName, { nowMs: input.nowMs, config: input.config });
  if (reason === "auth") {
    return store.recordAuth(runnerName, {
      nowMs: input.nowMs,
      config: input.config,
      ...(input.authFingerprint !== undefined ? { fingerprint: input.authFingerprint } : {}),
    });
  }
  const retryAfterMs = input.result?.retryAfterMs ?? (input.err as { retryAfterMs?: number } | undefined)?.retryAfterMs;
  return store.recordQuota(runnerName, { retryAfterMs, nowMs: input.nowMs, config: input.config });
}

export function healthyRunnerNames(
  chain: readonly { name: string }[],
  store: RunnerCooldownStore | undefined,
  nowMs: number,
  fingerprints?: Record<string, string | undefined>
): string[] {
  if (!store) return chain.map((r) => r.name);
  return chain.filter((r) => !store.isCooled(r.name, nowMs, fingerprints?.[r.name])).map((r) => r.name);
}

export function allRunnersCooled(
  chain: readonly { name: string }[],
  store: RunnerCooldownStore | undefined,
  nowMs: number,
  fingerprints?: Record<string, string | undefined>
): boolean {
  if (!chain.length) return false;
  if (!store) return false;
  return chain.every((r) => store.isCooled(r.name, nowMs, fingerprints?.[r.name]));
}

export function earliestCooldownEnd(
  chain: readonly { name: string }[],
  store: RunnerCooldownStore | undefined,
  nowMs: number
): number | undefined {
  if (!store) return undefined;
  store.prune(nowMs);
  let earliest: number | undefined;
  for (const r of chain) {
    const until = store.cooldownUntil(r.name);
    if (until > nowMs && (earliest === undefined || until < earliest)) earliest = until;
  }
  return earliest;
}

export function logRunnerCooldown(
  log: (message: string) => void,
  input: { runner: string; reason: RunnerCooldownReason; untilMs: number; source: RunnerCooldownSource }
): void {
  logDiagnostic(log, "runner_cooldown", {
    runner: input.runner,
    reason: input.reason,
    until: new Date(input.untilMs).toISOString(),
    source: input.source,
  });
}

export function logRunnerSkippedCooldown(
  log: (message: string) => void,
  input: { runner: string; untilMs: number; reason: RunnerCooldownReason }
): void {
  logDiagnostic(log, "runner_skipped_cooldown", {
    runner: input.runner,
    until: new Date(input.untilMs).toISOString(),
    reason: input.reason,
  });
}
