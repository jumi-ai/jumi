import { looksLikeProviderAuthDeath } from "./auth.ts";
import { EngineFailedError } from "./engine.ts";

const PROVIDER_UNAVAILABLE_RE =
  /rate[\s_-]*limit|too many requests|resource[_\s-]*exhausted|out of quota|\b429\b|insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|exhausted)|usage[_\s-]*limit|hit your (?:usage|free|session) limit|overloaded|\b(?:500|502|503|504)\b|bad gateway|gateway timeout|internal[\s_-]*server[\s_-]*error|service unavailable|provider(?: returned)?(?: error| (?:is )?unavailable)|model (?:not found|does not exist|unavailable|is not available|gone|not available)|unknown model|no such model|not a valid model|is not supported when using[^\n]{0,200}account/i;

export function looksLikeProviderUnavailable(text: string): boolean {
  return PROVIDER_UNAVAILABLE_RE.test(text);
}

export const INFRA_SHORT_MS = 2_000;
export const INFRA_MAX_RETRIES = 8;
export const INFRA_BUDGET_MS = 20 * 60 * 1000;
export const INFRA_BREAKER_CONSECUTIVE = 3;
export const INFRA_BREAKER_COOLDOWN_MS = 60_000;
export const INFRA_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
export const INFRA_RETRY_PREFIX = "infra-retry:";
export const INFRA_SPAWN_REASON = "Jumi failed: infra/spawn";

const INFRA_STDERR_RE =
  /EACCES|EPERM|spawn |spawnSync|interpreter|SIGSEGV|segmentation fault|Executable not found|not found in \$PATH/i;

export function looksLikeInfraStderr(text: string): boolean {
  return INFRA_STDERR_RE.test(text);
}

export function sessionDbGrew(dbBefore: number | null | undefined, dbAfter: number | null | undefined): boolean {
  return dbAfter != null && dbAfter > 0 && (dbBefore == null || dbAfter > dbBefore);
}

export function classifyOpenCodeInfra(input: {
  durationMs: number;
  stderr?: string;
  dbBefore?: number | null;
  dbAfter?: number | null;
  tokensExist?: boolean;
}): boolean {
  if (input.tokensExist) return false;
  if (looksLikeProviderUnavailable(input.stderr ?? "")) return false;
  if (looksLikeProviderAuthDeath(input.stderr ?? "")) return false;
  if (input.durationMs >= INFRA_SHORT_MS) return false;
  if (looksLikeInfraStderr(input.stderr ?? "")) return true;
  if (sessionDbGrew(input.dbBefore, input.dbAfter)) return false;
  return true;
}

export function isInfraFailure(err: unknown): boolean {
  if (err instanceof EngineFailedError) return err.infra;
  const text = err instanceof Error ? err.message : String(err);
  if (looksLikeProviderAuthDeath(text)) return false;
  return looksLikeInfraStderr(text);
}

export function isInfraRetryMarker(error: string | null | undefined): boolean {
  return Boolean(error?.startsWith(INFRA_RETRY_PREFIX));
}

export function parseInfraMarker(error: string | null | undefined): { count: number; firstFailAt: number } | undefined {
  if (!isInfraRetryMarker(error) || !error) return undefined;
  const parts = error.slice(INFRA_RETRY_PREFIX.length).split(":");
  const count = Number(parts[0]);
  const firstFailAt = Number(parts[1]);
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(firstFailAt)) return undefined;
  return { count, firstFailAt };
}

export function encodeInfraMarker(count: number, firstFailAt: number): string {
  return `${INFRA_RETRY_PREFIX}${count}:${firstFailAt}`;
}

export function infraBackoffMs(count: number): number {
  const index = Math.min(Math.max(count, 1), INFRA_BACKOFF_MS.length) - 1;
  return INFRA_BACKOFF_MS[index] ?? 60_000;
}

export type InfraDecision =
  | { action: "requeue"; count: number; firstFailAt: number; backoffMs: number; marker: string }
  | { action: "exhaust"; reason: string };

export function decideInfraRetry(prevError: string | null | undefined, nowMs: number): InfraDecision {
  const prev = parseInfraMarker(prevError);
  const count = (prev?.count ?? 0) + 1;
  const firstFailAt = prev?.firstFailAt ?? nowMs;
  if (count >= INFRA_MAX_RETRIES || nowMs - firstFailAt >= INFRA_BUDGET_MS) {
    return { action: "exhaust", reason: INFRA_SPAWN_REASON };
  }
  return {
    action: "requeue",
    count,
    firstFailAt,
    backoffMs: infraBackoffMs(count),
    marker: encodeInfraMarker(count, firstFailAt),
  };
}

export class InfraCircuitBreaker {
  private consecutive = 0;
  private mode: "closed" | "open" | "half-open" = "closed";
  private openUntil = 0;

  constructor(
    private readonly consecutiveLimit = INFRA_BREAKER_CONSECUTIVE,
    private readonly cooldownMs = INFRA_BREAKER_COOLDOWN_MS
  ) {}

  reset(): void {
    this.consecutive = 0;
    this.mode = "closed";
    this.openUntil = 0;
  }

  canLease(now = Date.now()): boolean {
    if (this.mode === "closed") return true;
    if (this.mode === "open") {
      if (now >= this.openUntil) {
        this.mode = "half-open";
        return true;
      }
      return false;
    }
    return true;
  }

  recordInfra(now = Date.now()): void {
    this.consecutive += 1;
    if (this.mode === "half-open" || this.consecutive >= this.consecutiveLimit) {
      this.mode = "open";
      this.openUntil = now + this.cooldownMs;
    }
  }

  recordModelReached(): void {
    this.consecutive = 0;
    this.mode = "closed";
  }
}

export const engineInfraBreaker = new InfraCircuitBreaker();
export const workerInfraBreaker = new InfraCircuitBreaker();
