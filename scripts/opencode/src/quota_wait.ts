import type { EngineResult } from "./engine.ts";
import { EngineFailedError, thrownChainIndex, thrownRunner } from "./engine.ts";
import { shouldHopInsteadOfQuotaStuck } from "./fallback.ts";
import {
  decideQuotaRetry,
  isQuotaError,
  isQuotaText,
  isResettingQuotaText,
  type QuotaClass,
  QuotaWaitError,
  quotaClassOf,
} from "./quota.ts";

export { isQuotaWaitError, QuotaWaitError } from "./quota.ts";

export function isResettingQuotaResult(result: EngineResult): boolean {
  return quotaClassOf({ quota: result.quota, message: result.message }) === "resetting";
}

export function isResettingQuotaError(err: unknown): boolean {
  if (err instanceof QuotaWaitError) return true;
  if (err instanceof EngineFailedError) {
    return quotaClassOf({ quota: err.quota, message: err.message, engineFailure: true }) === "resetting";
  }
  if (!isQuotaError(err)) return false;
  const text = err instanceof Error ? err.message : String(err);
  return isResettingQuotaText(text);
}

function stampedProducerModel(input: {
  result?: EngineResult;
  err?: unknown;
  runnerModel?: string;
}): string | undefined {
  return input.runnerModel ?? input.result?.runner?.model ?? thrownRunner(input.err)?.model;
}

export function laterModelsAfter(
  chain: readonly { model: string }[] | undefined,
  producerModel: string | undefined,
  chainIndex?: number
): string[] {
  if (!chain?.length) return [];
  if (chainIndex != null && chainIndex >= 0) return chain.slice(chainIndex + 1).map((runner) => runner.model);
  if (!producerModel) return [];
  const idx = chain.findIndex((runner) => runner.model === producerModel);
  if (idx < 0) return [];
  return chain.slice(idx + 1).map((runner) => runner.model);
}

function stampedChainIndex(input: { result?: EngineResult; err?: unknown }): number | undefined {
  if (input.result?.chainIndex != null) return input.result.chainIndex;
  return thrownChainIndex(input.err);
}

function hopWasRefused(input: { result?: EngineResult; err?: unknown; hopRefused?: boolean }): boolean {
  if (input.hopRefused === true || input.result?.hopRefused === true) return true;
  return (
    input.err !== null && typeof input.err === "object" && (input.err as { hopRefused?: boolean }).hopRefused === true
  );
}

export function laterRunnerCanTakeQuota(
  producerModel: string | undefined,
  laterModels: readonly string[] | undefined,
  hopRefused: boolean
): boolean {
  if (hopRefused || !producerModel) return false;
  const next = laterModels?.[0];
  if (!next) return false;
  return shouldHopInsteadOfQuotaStuck(producerModel, next);
}

export function throwIfQuotaWait(input: {
  result?: EngineResult;
  err?: unknown;
  model: string;
  fallbackModel?: string;
  chain?: readonly { model: string }[];
  laterModels?: readonly string[];
  runnerModel?: string;
  hopRefused?: boolean;
  previousError?: string | null;
  nowMs?: number;
  random?: () => number;
}): void {
  const producer = stampedProducerModel(input);
  const later = input.laterModels ?? laterModelsAfter(input.chain, producer, stampedChainIndex(input));
  if (laterRunnerCanTakeQuota(producer, later, hopWasRefused(input))) return;
  let kind: QuotaClass | undefined;
  let retryAfterMs: number | undefined;
  if (input.result) {
    if (input.result.status !== "stuck" || !isQuotaText(input.result.message)) return;
    kind = quotaClassOf({ quota: input.result.quota, message: input.result.message });
    retryAfterMs = input.result.retryAfterMs;
  } else if (input.err) {
    if (input.err instanceof QuotaWaitError) throw input.err;
    if (!isQuotaError(input.err) && !isResettingQuotaError(input.err)) return;
    if (input.err instanceof EngineFailedError) {
      kind = quotaClassOf({ quota: input.err.quota, message: input.err.message, engineFailure: true });
      retryAfterMs = input.err.retryAfterMs;
    } else {
      const text = input.err instanceof Error ? input.err.message : String(input.err);
      kind = quotaClassOf({ message: text });
    }
  } else {
    return;
  }
  if (kind !== "resetting") return;
  const decision = decideQuotaRetry(input.previousError, input.nowMs ?? Date.now(), retryAfterMs, input.random);
  if (decision.action === "exhaust") return;
  throw new QuotaWaitError(decision);
}
