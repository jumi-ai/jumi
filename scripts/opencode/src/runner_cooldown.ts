import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAuthFailure } from "./auth.ts";
import { CLAUDE_CODE_OAUTH_TOKEN_ENV, RUNNER_AUTH_API_KEY } from "./claude_credentials.ts";
import { codexAuthPath, codexPublishedAuthPath } from "./codex_auth.ts";
import { logDiagnostic } from "./diagnostics.ts";
import { EngineFailedError, type EngineResult } from "./engine.ts";
import { isCreditBalanceText, isQuotaError } from "./quota.ts";

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
    return this.keepLater(name, { untilMs, reason: "quota", source });
  }

  recordCredit(name: string, input: { nowMs: number; config?: RunnerCooldownConfig }): RunnerCooldownEntry {
    const config = input.config ?? DEFAULT_RUNNER_COOLDOWN_CONFIG;
    return this.keepLater(name, {
      untilMs: input.nowMs + config.creditMs,
      reason: "credit",
      source: "default",
    });
  }

  recordAuth(
    name: string,
    input: { nowMs: number; config?: RunnerCooldownConfig; fingerprint?: string }
  ): RunnerCooldownEntry {
    const config = input.config ?? DEFAULT_RUNNER_COOLDOWN_CONFIG;
    return this.keepLater(name, {
      untilMs: input.nowMs + config.authMs,
      reason: "auth",
      source: input.fingerprint !== undefined ? "credential" : "default",
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
    });
  }

  /**
   * A shorter cooldown never shortens a longer one: a 6 h credit followed by
   * a 60 min quota keeps the 6 h entry (and its reason/source). The winner is
   * the entry with the later `untilMs`; ties keep the stored entry.
   */
  private keepLater(name: string, entry: RunnerCooldownEntry): RunnerCooldownEntry {
    const prev = this.entries.get(name);
    if (prev && prev.untilMs >= entry.untilMs) return prev;
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
    // Keep the max: a longer process-local cooldown is never shortened by an
    // older persisted row, and a longer persisted row replaces a shorter
    // local one (e.g. after a restart). Ties keep the stored entry.
    const prev = this.entries.get(name);
    if (prev && prev.untilMs >= entry.untilMs) return;
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
  // A generic quota error (e.g. a thrown `429` / `rate limit` without an
  // EngineFailedError wrapper) drives QuotaWaitError/role-wide logic in
  // quota_wait.ts, so it must cool the runner too. Without this the quota hit
  // requeues with a backoff but records no per-runner cooldown.
  if (isQuotaError(err)) return "quota";
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

/** Short stable hash of credential material. The value is never logged. */
export function fingerprintString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

export interface RunnerFingerprintDeps {
  env?: Record<string, string | undefined>;
  home?: string;
  readFile?: (path: string) => string;
}

function readCredentialFile(path: string | undefined, readFile: (path: string) => string): string | undefined {
  if (!path) return undefined;
  try {
    const raw = readFile(path);
    if (!raw.trim()) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Current credential fingerprint for one runner, or undefined when the
 * credential has no stable local reference. Covered sources:
 * - `api-key` runners: the named env var value (rotating the key changes it).
 * - `codex` runners: the published auth file content (`CODEX_AUTH_FILE`),
 *   else the local `~/.codex/auth.json` — a rotated token changes it.
 * - `claude` subscription runners: `CLAUDE_CODE_OAUTH_TOKEN`.
 * Other runners are time-only: auth cools them for `authMs` with no
 * rotation fast-path. Best-effort and sync; unreadable files yield undefined.
 */
export function runnerCredentialFingerprint(
  runner: { type?: string; auth?: string | undefined; authEnv?: string | undefined },
  deps?: RunnerFingerprintDeps
): string | undefined {
  const env = deps?.env ?? process.env;
  const readFile = deps?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  if (runner.auth === RUNNER_AUTH_API_KEY && typeof runner.authEnv === "string" && runner.authEnv) {
    const value = env[runner.authEnv]?.trim();
    return value ? `api-key:${fingerprintString(value)}` : undefined;
  }
  if (runner.type === "codex") {
    const published = codexPublishedAuthPath(env);
    const raw = readCredentialFile(published ?? (deps?.home ? codexAuthPath(deps.home) : undefined), readFile);
    return raw ? `codex-file:${fingerprintString(raw)}` : undefined;
  }
  if (runner.type === "claude") {
    const token = env[CLAUDE_CODE_OAUTH_TOKEN_ENV]?.trim();
    return token ? `claude-oauth:${fingerprintString(token)}` : undefined;
  }
  return undefined;
}

/** Current credential fingerprints by runner name. Never throws. */
export function runnerAuthFingerprints(
  chain:
    | readonly { name: string; type?: string; auth?: string | undefined; authEnv?: string | undefined }[]
    | undefined,
  deps?: RunnerFingerprintDeps
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const runner of chain ?? []) {
    if (!runner?.name) continue;
    try {
      out[runner.name] = runnerCredentialFingerprint(runner, deps);
    } catch {
      out[runner.name] = undefined;
    }
  }
  return out;
}
