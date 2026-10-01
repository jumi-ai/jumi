import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { recordOpenCodeRun, shouldDeferQuotaExit } from "./control_metrics.ts";
import { logDiagnostic } from "./diagnostics.ts";
import { attachRunner, type Engine, EngineFailedError, type EngineResult, type EngineRunOptions } from "./engine.ts";
import { isQuotaError, isQuotaText } from "./quota.ts";
import { type NamedRunner, OPENCODE_RUNNER_TYPE, runnerStamp, usesEffort } from "./runners.ts";

export const OPENCODE_SESSION_DB = "opencode-session.db";
/** Conversation id of the last `agy` child in this worktree; resumed only by the same runner. */
export const AGY_CONVERSATION_FILE = "agy-conversation-id";
/** Thread id of the last `codex` child in this worktree; resumed only by the same runner. */
export const CODEX_THREAD_FILE = "codex-thread-id";
export const CODEX_THREAD_USAGE_FILE = "codex-thread-usage";

const PROVIDER_UNAVAILABLE_RE =
  /rate[\s_-]*limit|too many requests|resource[_\s-]*exhausted|out of quota|\b429\b|insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|exhausted)|usage[_\s-]*limit|hit your (?:usage|free|session) limit|overloaded|\b(?:502|503|504)\b|bad gateway|gateway timeout|service unavailable|provider(?: returned)?(?: error| (?:is )?unavailable)|model (?:not found|does not exist|unavailable|is not available|gone|not available)|unknown model|no such model|not a valid model/i;

export interface ModelHopOptions {
  fallbackModel?: string;
  fallbackVariant?: string;
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  logger?: (message: string) => void;
}

export interface EngineChainOptions extends ModelHopOptions {
  chain?: NamedRunner[];
}

export function looksLikeProviderUnavailable(text: string): boolean {
  return PROVIDER_UNAVAILABLE_RE.test(text);
}

export function modelProviderPrefix(model: string): string {
  const slash = model.indexOf("/");
  if (slash <= 0) return "";
  return model.slice(0, slash).toLowerCase();
}

export function shouldHopInsteadOfQuotaStuck(primaryModel: string, fallbackModel: string | undefined): boolean {
  if (!fallbackModel) return false;
  const primary = modelProviderPrefix(primaryModel);
  const fallback = modelProviderPrefix(fallbackModel);
  if (primary && fallback) return primary !== fallback;
  return primaryModel !== fallbackModel;
}

export function isProviderUnavailableResult(result: EngineResult): boolean {
  if (result.status !== "exit") return false;
  if (result.infra === true) return false;
  if (result.auth === true) return false;
  if (result.exitCode === 143) return false;
  return looksLikeProviderUnavailable(result.message ?? "");
}

export function openCodeSessionDbPath(workdir: string): string {
  return join(workdir, ".jumi-tmp", OPENCODE_SESSION_DB);
}

export function openCodeLogDirPath(workdir: string): string {
  return join(workdir, ".jumi-tmp", "xdg-data", "opencode", "log");
}

export function agyConversationPath(workdir: string): string {
  return join(workdir, ".jumi-tmp", AGY_CONVERSATION_FILE);
}

export function codexThreadPath(workdir: string): string {
  return join(workdir, ".jumi-tmp", CODEX_THREAD_FILE);
}

export function codexThreadUsagePath(workdir: string): string {
  return join(workdir, ".jumi-tmp", CODEX_THREAD_USAGE_FILE);
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export async function hasResumableSession(workdir: string): Promise<boolean> {
  return (
    (await pathIsFile(openCodeSessionDbPath(workdir))) ||
    (await pathIsFile(agyConversationPath(workdir))) ||
    (await pathIsFile(codexThreadPath(workdir)))
  );
}

export async function clearOpenCodeSession(workdir: string): Promise<void> {
  await rm(openCodeSessionDbPath(workdir), { force: true });
  await rm(agyConversationPath(workdir), { force: true });
  await rm(codexThreadPath(workdir), { force: true });
  await rm(codexThreadUsagePath(workdir), { force: true });
  await rm(openCodeLogDirPath(workdir), { recursive: true, force: true });
}

async function remainingCoversTimeout(hop: ModelHopOptions, timeoutMs: number | undefined): Promise<boolean> {
  if (!timeoutMs || timeoutMs <= 0) return true;
  if (!hop.remainingLeaseMs) return true;
  return (await hop.remainingLeaseMs()) >= timeoutMs;
}

async function leaseAllowsHop(hop: ModelHopOptions, timeoutMs: number | undefined): Promise<boolean> {
  if (hop.extendLease && !(await hop.extendLease())) return false;
  return remainingCoversTimeout(hop, timeoutMs);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "cancelled");
}

function isQuotaStuckResult(result: EngineResult): boolean {
  return result.status === "stuck" && isQuotaText(result.message);
}

function shouldHopFromResult(
  result: EngineResult,
  opts: EngineRunOptions,
  currentModel: string,
  nextModel: string
): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted) return false;
  if (result.auth === true) return true;
  if (isProviderUnavailableResult(result)) return true;
  return isQuotaStuckResult(result) && shouldHopInsteadOfQuotaStuck(currentModel, nextModel);
}

function shouldHopFromError(err: unknown, opts: EngineRunOptions, currentModel: string, nextModel: string): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted || isAbortError(err)) return false;
  if (!(err instanceof EngineFailedError) || err.infra) return false;
  if (err.auth) return true;
  if (isQuotaError(err)) return shouldHopInsteadOfQuotaStuck(currentModel, nextModel);
  return looksLikeProviderUnavailable(err.message);
}

function shouldHopQuotaResult(
  result: EngineResult,
  opts: EngineRunOptions,
  currentModel: string,
  nextModel: string
): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted) return false;
  return isQuotaStuckResult(result) && shouldHopInsteadOfQuotaStuck(currentModel, nextModel);
}

function shouldHopQuotaError(err: unknown, opts: EngineRunOptions, currentModel: string, nextModel: string): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted || isAbortError(err)) return false;
  if (!(err instanceof EngineFailedError) || err.infra || err.auth) return false;
  return isQuotaError(err) && shouldHopInsteadOfQuotaStuck(currentModel, nextModel);
}

function refuseQuotaHop(result: EngineResult, currentModel: string, nextModel: string | undefined): EngineResult {
  if (!nextModel || !isQuotaStuckResult(result) || !shouldHopInsteadOfQuotaStuck(currentModel, nextModel)) {
    return result;
  }
  return { ...result, hopRefused: true };
}

function refuseQuotaHopError(err: unknown, currentModel: string, nextModel: string | undefined): void {
  if (!nextModel || !isQuotaError(err) || !shouldHopInsteadOfQuotaStuck(currentModel, nextModel)) return;
  if (err !== null && typeof err === "object") (err as { hopRefused?: boolean }).hopRefused = true;
}

function settleQuotaSigterm(opts: EngineRunOptions, result: EngineResult, hopped: boolean): void {
  if (!shouldDeferQuotaExit(result)) return;
  recordOpenCodeRun(opts.trace?.kind ?? "review", { ...result, hopped });
}

async function beginHop(
  hop: EngineChainOptions,
  opts: EngineRunOptions,
  from: NamedRunner,
  to: NamedRunner
): Promise<void> {
  const log = hop.logger ?? opts.logger;
  if (log) {
    logDiagnostic(log, "opencode_hop", {
      review: opts.reviewLabel ?? null,
      from_model: from.model,
      to_model: to.model,
      hop: true,
    });
  }
  await clearOpenCodeSession(opts.workdir);
}

function engineOptsForRunner(
  opts: EngineRunOptions,
  runner: NamedRunner,
  extra?: Partial<EngineRunOptions>
): EngineRunOptions {
  const fields: Pick<EngineRunOptions, "type" | "model" | "variant" | "effort"> = usesEffort(runner.type)
    ? {
        type: runner.type,
        model: runner.model,
        effort: "effort" in runner ? runner.effort : undefined,
        variant: undefined,
      }
    : {
        type: runner.type,
        model: runner.model,
        variant: "variant" in runner ? runner.variant : undefined,
        effort: undefined,
      };
  return { ...opts, ...fields, ...extra };
}

function lazyChain(opts: EngineRunOptions, hop: EngineChainOptions): NamedRunner[] {
  return [
    { name: "primary", type: OPENCODE_RUNNER_TYPE, model: opts.model, variant: opts.variant },
    { name: "fallback", type: OPENCODE_RUNNER_TYPE, model: hop.fallbackModel!, variant: hop.fallbackVariant },
  ];
}

function stampRunner(result: EngineResult, runner: NamedRunner, chainIndex: number): EngineResult {
  return { ...result, runner: runnerStamp(runner), chainIndex };
}

export function withEngineChain(engine: Engine, hop: EngineChainOptions): Engine {
  // Without a chain the bare engine runs and stamps fall back to the spawn
  // options, which workers never type, so they read `opencode`. A Claude
  // primary must therefore arrive through `chain` (a 1-entry one is fine).
  if (!hop.chain?.length && !hop.fallbackModel) {
    // There is no next runner to hop to, so refuse rather than re-spawn the same one.
    return async (opts: EngineRunOptions): Promise<EngineResult> =>
      opts.hopFromIncomplete === true ? { status: "ok", hopDeclined: true } : engine(opts);
  }

  let chain: NamedRunner[] | undefined;
  if (hop.chain && hop.chain.length >= 2) chain = hop.chain;
  else if (hop.chain?.length === 1 && !hop.fallbackModel) chain = hop.chain;
  let index = 0;

  const runnersFor = (opts: EngineRunOptions): NamedRunner[] => {
    if (chain) return chain;
    chain = lazyChain(opts, hop);
    return chain;
  };

  return async (opts: EngineRunOptions): Promise<EngineResult> => {
    const runners = runnersFor(opts);

    if (opts.hopFromIncomplete === true) {
      // The hop is always from scratch to the *next* runner, so anything that
      // rules that out — a continued session, an abort, no next entry, no lease
      // left — is a refusal. Never re-spawn the runner that just produced nothing.
      const next = opts.continueSession || opts.abortSignal?.aborted ? undefined : runners[index + 1];
      if (!next || !(await leaseAllowsHop(hop, opts.timeoutMs))) {
        // Nothing ran: say so rather than look like a runner that produced nothing.
        return { status: "ok", hopDeclined: true };
      }
      await beginHop(hop, opts, runners[index]!, next);
      index++;
    }

    if (index > 0 && opts.hopFromIncomplete !== true) {
      const current = runners[index]!;
      const next = runners[index + 1];
      let result: EngineResult | undefined;
      try {
        result = stampRunner(
          await engine(engineOptsForRunner(opts, current, { deferQuotaExit: true })),
          current,
          index
        );
      } catch (err) {
        attachRunner(err, runnerStamp(current), index);
        if (!next || !shouldHopQuotaError(err, opts, current.model, next.model)) {
          if (next) refuseQuotaHopError(err, current.model, next.model);
          throw err;
        }
        if (!(await leaseAllowsHop(hop, opts.timeoutMs))) {
          refuseQuotaHopError(err, current.model, next.model);
          throw err;
        }
        await beginHop(hop, opts, current, next);
        index++;
      }
      if (result) {
        if (!next || !shouldHopQuotaResult(result, opts, current.model, next.model)) {
          settleQuotaSigterm(opts, result, false);
          return refuseQuotaHop(result, current.model, next?.model);
        }
        if (!(await leaseAllowsHop(hop, opts.timeoutMs))) {
          settleQuotaSigterm(opts, result, false);
          return refuseQuotaHop(result, current.model, next.model);
        }
        try {
          await beginHop(hop, opts, current, next);
        } catch (err) {
          settleQuotaSigterm(opts, result, false);
          throw err;
        }
        settleQuotaSigterm(opts, result, true);
        index++;
      }
    }

    while (true) {
      const runner = runners[index]!;
      const hopSpawn = index > 0;
      const runOpts: EngineRunOptions = engineOptsForRunner(opts, runner, {
        deferQuotaExit: true,
        ...(hopSpawn ? { continueSession: false, hop: true } : {}),
      });

      let result: EngineResult;
      try {
        result = stampRunner(await engine(runOpts), runner, index);
      } catch (err) {
        attachRunner(err, runnerStamp(runner), index);
        const next = runners[index + 1];
        if (!next || !shouldHopFromError(err, opts, runner.model, next.model)) {
          if (next) refuseQuotaHopError(err, runner.model, next.model);
          throw err;
        }
        if (!(await leaseAllowsHop(hop, opts.timeoutMs))) {
          refuseQuotaHopError(err, runner.model, next.model);
          throw err;
        }
        await beginHop(hop, opts, runner, next);
        index++;
        continue;
      }

      const next = runners[index + 1];
      if (!next || !shouldHopFromResult(result, opts, runner.model, next.model)) {
        settleQuotaSigterm(opts, result, false);
        return refuseQuotaHop(result, runner.model, next?.model);
      }
      if (!(await leaseAllowsHop(hop, opts.timeoutMs))) {
        settleQuotaSigterm(opts, result, false);
        return refuseQuotaHop(result, runner.model, next.model);
      }
      try {
        await beginHop(hop, opts, runner, next);
      } catch (err) {
        settleQuotaSigterm(opts, result, false);
        throw err;
      }
      settleQuotaSigterm(opts, result, true);
      index++;
    }
  };
}

export function withModelHop(engine: Engine, hop: ModelHopOptions): Engine {
  return withEngineChain(engine, hop);
}
