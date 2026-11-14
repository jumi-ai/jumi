import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { claudeApiKeyVarNames, RUNNER_AUTH_API_KEY } from "./claude_credentials.ts";
import { recordOpenCodeRun, shouldDeferQuotaExit } from "./control_metrics.ts";
import { logDiagnostic } from "./diagnostics.ts";
import {
  attachRunner,
  type Engine,
  EngineFailedError,
  type EngineResult,
  type EngineRunOptions,
  resolveQuotaResetAtMs,
} from "./engine.ts";
import { looksLikeProviderUnavailable } from "./infra.ts";
import { isCreditBalanceText, isQuotaError, isQuotaText } from "./quota.ts";
import { withLedgerRunUsage } from "./run_usage.ts";
import {
  logRunnerCooldown,
  type RunnerCooldownConfig,
  type RunnerCooldownStore,
  recordRunnerCooldownForFailure,
} from "./runner_cooldown.ts";
import {
  describeAttemptOrder,
  type NamedRunner,
  OPENCODE_RUNNER_TYPE,
  orderChainForJob,
  RUNNER_SELECTION_ORDERED,
  type RunnerSelectionMode,
  type RunnerStamp,
  resolveRunnerSelection,
  runnerStamp,
  usesEffort,
} from "./runners.ts";

export const OPENCODE_SESSION_DB = "opencode-session.db";
/** Conversation id of the last `agy` child in this worktree; resumed only by the same runner. */
export const AGY_CONVERSATION_FILE = "agy-conversation-id";
/** Thread id of the last `codex` child in this worktree; resumed only by the same runner. */
export const CODEX_THREAD_FILE = "codex-thread-id";
export const CODEX_THREAD_USAGE_FILE = "codex-thread-usage";

/** @deprecated Import from `./infra.ts` instead. Re-exported here so existing callers keep working. */
export { looksLikeProviderUnavailable } from "./infra.ts";

export interface ModelHopOptions {
  fallbackModel?: string;
  fallbackVariant?: string;
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  logger?: (message: string) => void;
}

export interface EngineChainOptions extends ModelHopOptions {
  chain?: NamedRunner[];
  /**
   * Opt-in per-factory selection mode. `ordered` (default when absent) keeps
   * configured order. `random-start` uniformly picks a start from the eligible
   * chain once per fresh job and rotates around it. Validated at load; an
   * invalid mode fails process start before any job runs.
   */
  selection?: RunnerSelectionMode | string;
  /** Injectable randomness for deterministic tests. Defaults to `Math.random`. */
  random?: () => number;
  /**
   * Best-effort worktree dirtiness probe for narrowing writer provenance.
   * Return true when the worktree has non-scratch changes, false when clean,
   * undefined when unknown. When absent the chain falls back to a direct
   * `git status --porcelain` in `workdir`; when that also fails the hop stays
   * conservative and counts the failed runner.
   */
  worktreeDirty?: () => Promise<boolean | undefined>;
  /** Per-runner cooldowns: cooled runners are skipped for fresh picks. */
  runnerCooldowns?: RunnerCooldownStore;
  /** Durations for per-runner cooldowns. Defaults cover quota/credit/auth. */
  runnerCooldownConfig?: RunnerCooldownConfig;
  /** Injectable clock for deterministic cooldown tests. Defaults to `Date.now`. */
  cooldownNowMs?: () => number;
  /** Current credential fingerprints by runner name for auth cooldowns. */
  authFingerprints?: Record<string, string | undefined>;
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

/** Credit exhaustion uses the credential, not the model, to decide the hop.
 * Two entries may share type and model and differ only in billing
 * (subscription token vs API key in `authEnv`); the exhausted credential is
 * the API key, so the next runner hops whenever it bills a different
 * credential. The existing refusal stays for the case it was written for:
 * the next runner shares the exhausted credential. */
export function isCreditStuckResult(result: EngineResult): boolean {
  return result.status === "stuck" && isCreditBalanceText(result.message ?? "");
}

function credentialKey(runner: { auth?: string | undefined; authEnv?: string | undefined }): string {
  if (runner.auth === RUNNER_AUTH_API_KEY) return `api-key:${runner.authEnv ?? ""}`;
  return "subscription";
}

export function sameExhaustedCredential(
  current: { auth?: string | undefined; authEnv?: string | undefined },
  next: { auth?: string | undefined; authEnv?: string | undefined }
): boolean {
  return credentialKey(current) === credentialKey(next);
}

export function shouldHopForCreditExhaustion(
  current: { auth?: string | undefined; authEnv?: string | undefined },
  next: { auth?: string | undefined; authEnv?: string | undefined }
): boolean {
  return !sameExhaustedCredential(current, next);
}

function isCreditQuotaError(err: unknown): boolean {
  if (err instanceof EngineFailedError) {
    return isCreditBalanceText(err.message ?? "");
  }
  return false;
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
  const db = openCodeSessionDbPath(workdir);
  await Promise.all([db, `${db}-wal`, `${db}-shm`].map((path) => rm(path, { force: true })));
  await rm(agyConversationPath(workdir), { force: true });
  await rm(codexThreadPath(workdir), { force: true });
  await rm(codexThreadUsagePath(workdir), { force: true });
}

async function leaseAllowsHop(hop: ModelHopOptions, timeoutMs: number | undefined): Promise<boolean> {
  if (hop.extendLease && !(await hop.extendLease())) {
    const log = hop.logger;
    if (log) {
      logDiagnostic(log, "hop_refused", {
        reason: "extend_lease",
        timeout_ms: timeoutMs ?? null,
      });
    }
    return false;
  }
  if (!timeoutMs || timeoutMs <= 0) return true;
  if (!hop.remainingLeaseMs) return true;
  const remaining = await hop.remainingLeaseMs();
  if (remaining >= timeoutMs) return true;
  const log = hop.logger;
  if (log) {
    logDiagnostic(log, "hop_refused", {
      reason: "lease",
      remaining_ms: Math.max(0, Math.floor(remaining)),
      timeout_ms: Math.floor(timeoutMs),
    });
  }
  return false;
}

function cooldownNowMs(hop: EngineChainOptions): number {
  try {
    const now = hop.cooldownNowMs?.();
    if (typeof now === "number" && Number.isFinite(now)) return now;
  } catch {
    // Fall through to Date.now().
  }
  return Date.now();
}

function noteCooldown(
  hop: EngineChainOptions,
  runner: NamedRunner,
  input: { result?: EngineResult; err?: unknown }
): void {
  if (!hop.runnerCooldowns) return;
  const nowMs = cooldownNowMs(hop);
  const entry = recordRunnerCooldownForFailure(hop.runnerCooldowns, runner.name, {
    ...input,
    nowMs,
    config: hop.runnerCooldownConfig,
    authFingerprint: hop.authFingerprints?.[runner.name],
  });
  if (!entry) return;
  const log = hop.logger;
  if (log) {
    logRunnerCooldown(log, {
      runner: runner.name,
      reason: entry.reason,
      untilMs: entry.untilMs,
      source: entry.source,
    });
  }
}

function clearCooldown(hop: EngineChainOptions, runner: NamedRunner): void {
  hop.runnerCooldowns?.clear(runner.name);
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
  current: NamedRunner,
  next: NamedRunner
): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted) return false;
  if (result.auth === true) return true;
  if (isCreditStuckResult(result)) return shouldHopForCreditExhaustion(current, next);
  if (isProviderUnavailableResult(result)) return true;
  return isQuotaStuckResult(result) && shouldHopInsteadOfQuotaStuck(current.model, next.model);
}

function shouldHopFromError(err: unknown, opts: EngineRunOptions, current: NamedRunner, next: NamedRunner): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted || isAbortError(err)) return false;
  if (!(err instanceof EngineFailedError) || err.infra) return false;
  if (err.auth) return true;
  if (isCreditQuotaError(err)) return shouldHopForCreditExhaustion(current, next);
  if (isQuotaError(err)) return shouldHopInsteadOfQuotaStuck(current.model, next.model);
  return looksLikeProviderUnavailable(err.message);
}

function shouldHopQuotaResult(
  result: EngineResult,
  opts: EngineRunOptions,
  current: NamedRunner,
  next: NamedRunner
): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted) return false;
  if (isCreditStuckResult(result)) return shouldHopForCreditExhaustion(current, next);
  return isQuotaStuckResult(result) && shouldHopInsteadOfQuotaStuck(current.model, next.model);
}

function shouldHopQuotaError(err: unknown, opts: EngineRunOptions, current: NamedRunner, next: NamedRunner): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted || isAbortError(err)) return false;
  if (!(err instanceof EngineFailedError) || err.infra || err.auth) return false;
  if (isCreditQuotaError(err)) return shouldHopForCreditExhaustion(current, next);
  return isQuotaError(err) && shouldHopInsteadOfQuotaStuck(current.model, next.model);
}

function wouldHopQuota(current: NamedRunner, next: NamedRunner, result: EngineResult): boolean {
  if (isCreditStuckResult(result)) return shouldHopForCreditExhaustion(current, next);
  return isQuotaStuckResult(result) && shouldHopInsteadOfQuotaStuck(current.model, next.model);
}

function wouldHopQuotaError(current: NamedRunner, next: NamedRunner, err: unknown): boolean {
  if (isCreditQuotaError(err)) return shouldHopForCreditExhaustion(current, next);
  return isQuotaError(err) && shouldHopInsteadOfQuotaStuck(current.model, next.model);
}

function refuseQuotaHop(result: EngineResult, current: NamedRunner, next: NamedRunner | undefined): EngineResult {
  if (!next || !wouldHopQuota(current, next, result)) {
    return result;
  }
  return { ...result, hopRefused: true };
}

function refuseQuotaHopError(err: unknown, current: NamedRunner, next: NamedRunner | undefined): void {
  if (!next || !wouldHopQuotaError(current, next, err)) return;
  if (err !== null && typeof err === "object") (err as { hopRefused?: boolean }).hopRefused = true;
}

function settleQuotaSigterm(opts: EngineRunOptions, result: EngineResult, hopped: boolean, runnerName?: string): void {
  if (!shouldDeferQuotaExit(result)) return;
  recordOpenCodeRun(opts.trace?.kind ?? "review", { ...result, hopped }, runnerName);
}

/** Why a hop happened, for the `opencode_hop` line and alerts. */
export type HopCause = "quota" | "auth" | "provider-down" | "incomplete";

function hopCauseFromResult(result: EngineResult): HopCause {
  if (result.auth === true) return "auth";
  if (isCreditStuckResult(result) || isQuotaStuckResult(result)) return "quota";
  if (isProviderUnavailableResult(result)) return "provider-down";
  return "incomplete";
}

function hopCauseFromError(err: unknown): HopCause {
  if (err instanceof EngineFailedError) {
    if (err.auth) return "auth";
    if (isCreditQuotaError(err) || isQuotaError(err)) return "quota";
  }
  return "provider-down";
}

/** Absolute reset the hop carries, unix seconds, when the result states one. */
function hopResetFromResult(result: EngineResult): number | null {
  const atMs = resolveQuotaResetAtMs(result);
  return typeof atMs === "number" && Number.isFinite(atMs) ? Math.floor(atMs / 1000) : null;
}

/** Absolute reset the hop carries, unix seconds, when the thrown error states a retry delay. */
function hopResetFromError(err: unknown): number | null {
  const retryAfterMs = err instanceof EngineFailedError ? err.retryAfterMs : undefined;
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs)) return null;
  return Math.floor((Date.now() + retryAfterMs) / 1000);
}

async function beginHop(
  hop: EngineChainOptions,
  opts: EngineRunOptions,
  from: NamedRunner,
  to: NamedRunner,
  cause: HopCause,
  resetAtSeconds?: number | null
): Promise<void> {
  const log = hop.logger ?? opts.logger;
  if (log) {
    logDiagnostic(log, "opencode_hop", {
      review: opts.reviewLabel ?? null,
      from_model: from.model,
      to_model: to.model,
      from_runner: from.name,
      to_runner: to.name,
      class: cause,
      reset_at: resetAtSeconds ?? null,
      hop: true,
    });
  }
  await clearOpenCodeSession(opts.workdir);
}

function engineOptsForRunner(
  opts: EngineRunOptions,
  runner: NamedRunner,
  extra?: Partial<EngineRunOptions>,
  keyEnvNames?: readonly string[]
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
  const credential: Pick<EngineRunOptions, "runnerName" | "auth" | "authEnv" | "keyEnvNames"> = {
    runnerName: runner.name,
  };
  if (runner.auth !== undefined) credential.auth = runner.auth;
  if (runner.authEnv !== undefined) credential.authEnv = runner.authEnv;
  if (keyEnvNames && keyEnvNames.length > 0) credential.keyEnvNames = [...keyEnvNames];
  return { ...opts, ...fields, ...credential, ...extra };
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

function porcelainRelevantLines(status: string): string[] {
  const out: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rest = line.length >= 4 ? line.slice(3) : line;
    const parts = rest.includes(" -> ") ? rest.split(" -> ") : [rest];
    let relevant = false;
    for (let part of parts) {
      part = part.trim();
      if (part.startsWith('"') && part.endsWith('"') && part.length >= 2) part = part.slice(1, -1);
      if (part.endsWith("/")) part = part.slice(0, -1);
      if (part !== ".jumi-tmp" && !part.startsWith(".jumi-tmp/") && part !== "") {
        relevant = true;
        break;
      }
    }
    if (relevant) out.push(line);
  }
  return out;
}

async function probeWorktreeDirty(
  workdir: string | undefined,
  custom: EngineChainOptions["worktreeDirty"]
): Promise<boolean | undefined> {
  if (custom) {
    try {
      return await custom();
    } catch {
      return undefined;
    }
  }
  if (!workdir) return undefined;
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return undefined;
    return porcelainRelevantLines(stdout).length > 0;
  } catch {
    return undefined;
  }
}

function narrowedContributors(
  runners: readonly NamedRunner[],
  uptoIndex: number,
  excluded: Set<number>
): RunnerStamp[] {
  const out: RunnerStamp[] = [];
  const seen = new Set<string>();
  const end = Math.min(uptoIndex, runners.length - 1);
  for (let i = 0; i <= end; i++) {
    if (excluded.has(i)) continue;
    const entry = runners[i];
    if (!entry) continue;
    const stamp = runnerStamp(entry);
    const key = `${stamp.type}|${stamp.model}|${stamp.effort ?? stamp.variant ?? ""}|${stamp.auth ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stamp);
  }
  return out;
}

export function withEngineChain(engine: Engine, hop: EngineChainOptions): Engine {
  // Ledger recording wraps the base engine, not the chain: every spawn of any
  // harness (`opencode` / `claude` / `agy` / `codex`) writes one ledger row per
  // model, including hops, retries, and artifact-recovery rounds. One edit
  // here covers the review and worker flows alike; callers only set the
  // ambient recorder for the leased job (server/worker ticks).
  const recording = withLedgerRunUsage(engine);
  // Without a chain the bare engine runs and stamps fall back to the spawn
  // options, which workers never type, so they read `opencode`. A Claude
  // primary must therefore arrive through `chain` (a 1-entry one is fine).
  if (!hop.chain?.length && !hop.fallbackModel) {
    // There is no next runner to hop to, so refuse rather than re-spawn the same one.
    return async (opts: EngineRunOptions): Promise<EngineResult> =>
      opts.hopFromIncomplete === true ? { status: "ok", hopDeclined: true } : recording(opts);
  }
  // Validate early so an invalid mode fails clearly instead of silently
  // running ordered. File load already rejects it at process start.
  const selection = resolveRunnerSelection({ selection: hop.selection ?? undefined });

  let configured: NamedRunner[] | undefined;
  if (hop.chain && hop.chain.length >= 2) configured = [...hop.chain];
  else if (hop.chain?.length === 1 && !hop.fallbackModel) configured = [...hop.chain];
  let effective: NamedRunner[] | undefined;
  let selectionLogged = false;
  let index = 0;

  const ensureEffective = (opts: EngineRunOptions, base: NamedRunner[]): NamedRunner[] => {
    if (effective) return effective;
    // One fresh selection per wrapper (per job): uniformly pick a start from
    // the eligible chain and rotate around it. Continuations and
    // artifact-recovery calls reuse this order; never rerandomize mid-job.
    // `orderChainForJob` copies, so catalog/config ordering is never mutated
    // and independent jobs never share array state. Cooled runners are
    // excluded before the random pick so a dead runner is not rediscovered.
    effective = orderChainForJob(base, selection, hop.random ?? Math.random, {
      ...(hop.runnerCooldowns ? { cooldowns: hop.runnerCooldowns } : {}),
      nowMs: cooldownNowMs(hop),
      logger: hop.logger ?? opts.logger,
      ...(hop.authFingerprints ? { fingerprints: hop.authFingerprints } : {}),
    });
    if (!selectionLogged) {
      selectionLogged = true;
      const log = hop.logger ?? opts.logger;
      if (log && effective.length > 0) {
        logDiagnostic(log, "runner_selection", {
          review: opts.reviewLabel ?? null,
          selection,
          start: effective[0]?.name ?? null,
          order: describeAttemptOrder(effective),
          kind: opts.trace?.kind ?? null,
          job: opts.trace?.jobId ?? null,
        });
      }
    }
    return effective;
  };

  const runnersFor = (opts: EngineRunOptions): NamedRunner[] => {
    if (configured) return ensureEffective(opts, configured);
    if (effective) return effective;
    const lazy = lazyChain(opts, hop);
    // A synthesized 1-2 entry env-compatible chain keeps ordered behavior
    // when the option is absent; an explicit random-start still distributes
    // its two entries. Single-runner chains behave as before.
    if (selection === RUNNER_SELECTION_ORDERED) {
      effective = [...lazy];
      return effective;
    }
    return ensureEffective(opts, lazy);
  };

  const excludedClean = new Set<number>();

  const noteCleanHop = (
    hopIndex: number,
    runnersRef: readonly NamedRunner[],
    log: ((message: string) => void) | undefined
  ) => {
    excludedClean.add(hopIndex);
    if (log) {
      const entry = runnersRef[hopIndex];
      logDiagnostic(log, "provenance", {
        review: null,
        narrowing: "clean-hop-excluded",
        runner: entry?.name ?? null,
        chain_index: hopIndex,
      });
    }
  };

  const attachNarrowed = (result: EngineResult, upto: number, runnersRef: readonly NamedRunner[]): EngineResult => {
    if (result.hopDeclined === true) return result;
    return { ...result, contributors: narrowedContributors(runnersRef, upto, excludedClean) };
  };

  const attachNarrowedError = (err: unknown, upto: number, runnersRef: readonly NamedRunner[]): void => {
    if (err === null || typeof err !== "object") return;
    (err as { contributors?: unknown }).contributors = narrowedContributors(runnersRef, upto, excludedClean);
  };

  const maybeExcludeCleanHop = async (
    hopIndex: number,
    runnersRef: readonly NamedRunner[],
    workdir: string | undefined,
    log: ((message: string) => void) | undefined
  ): Promise<void> => {
    const dirty = await probeWorktreeDirty(workdir, hop.worktreeDirty);
    // Only a definitely-clean worktree excludes the hopped runner. Unknown
    // (undefined) stays conservative and counts it, so ambiguity fails closed.
    if (dirty === false) noteCleanHop(hopIndex, runnersRef, log);
  };

  return async (opts: EngineRunOptions): Promise<EngineResult> => {
    // Resolve (and, on the fresh job, randomly order) before any hop logic so
    // availability hops can still reach entries that originally preceded the
    // selected start. Chain positions below are in effective attempt order.
    const runners = runnersFor(opts);
    const logForHop = hop.logger ?? opts.logger;
    // Parent key-var names across the effective chain. Every Claude spawn
    // strips these from its child env so the operator's variable never leaks
    // into any child under its own name (subscription children included).
    const keyEnvNames = claudeApiKeyVarNames(runners);

    if (opts.hopFromIncomplete === true) {
      // The hop is always from scratch to the *next* runner, so anything that
      // rules that out — a continued session, an abort, no next entry, no lease
      // left — is a refusal. Never re-spawn the runner that just produced nothing.
      const next = opts.continueSession || opts.abortSignal?.aborted ? undefined : runners[index + 1];
      if (!next || !(await leaseAllowsHop(hop, opts.timeoutMs))) {
        // Nothing ran: say so rather than look like a runner that produced nothing.
        return { status: "ok", hopDeclined: true };
      }
      // The incomplete round produced nothing by definition; when the
      // worktree is verifiably clean the previous runner did not contribute.
      await maybeExcludeCleanHop(index, runners, opts.workdir, logForHop);
      await beginHop(hop, opts, runners[index]!, next, "incomplete", null);
      index++;
    }

    if (index > 0 && opts.hopFromIncomplete !== true) {
      const current = runners[index]!;
      const next = runners[index + 1];
      let result: EngineResult | undefined;
      try {
        result = stampRunner(
          await recording(engineOptsForRunner(opts, current, { deferQuotaExit: true }, keyEnvNames)),
          current,
          index
        );
      } catch (err) {
        attachRunner(err, runnerStamp(current), index);
        noteCooldown(hop, current, { err });
        if (!next || !shouldHopQuotaError(err, opts, current, next)) {
          if (next) refuseQuotaHopError(err, current, next);
          attachNarrowedError(err, index, runners);
          throw err;
        }
        if (!(await leaseAllowsHop(hop, opts.timeoutMs))) {
          refuseQuotaHopError(err, current, next);
          attachNarrowedError(err, index, runners);
          throw err;
        }
        await maybeExcludeCleanHop(index, runners, opts.workdir, logForHop);
        await beginHop(hop, opts, current, next, "quota", hopResetFromError(err));
        index++;
      }
      if (result) {
        if (result.status === "ok") clearCooldown(hop, current);
        else noteCooldown(hop, current, { result });
        if (!next || !shouldHopQuotaResult(result, opts, current, next)) {
          settleQuotaSigterm(opts, result, false, current.name);
          return attachNarrowed(refuseQuotaHop(result, current, next), index, runners);
        }
        if (!(await leaseAllowsHop(hop, opts.timeoutMs))) {
          settleQuotaSigterm(opts, result, false, current.name);
          return attachNarrowed(refuseQuotaHop(result, current, next), index, runners);
        }
        try {
          await maybeExcludeCleanHop(index, runners, opts.workdir, logForHop);
          await beginHop(hop, opts, current, next, "quota", hopResetFromResult(result));
        } catch (err) {
          settleQuotaSigterm(opts, result, false, current.name);
          throw err;
        }
        settleQuotaSigterm(opts, result, true, current.name);
        index++;
      }
    }

    while (true) {
      const runner = runners[index]!;
      const hopSpawn = index > 0;
      const runOpts: EngineRunOptions = engineOptsForRunner(
        opts,
        runner,
        {
          deferQuotaExit: true,
          ...(hopSpawn ? { continueSession: false, hop: true } : {}),
        },
        keyEnvNames
      );

      let result: EngineResult;
      try {
        result = stampRunner(await recording(runOpts), runner, index);
      } catch (err) {
        attachRunner(err, runnerStamp(runner), index);
        noteCooldown(hop, runner, { err });
        const next = runners[index + 1];
        if (!next || !shouldHopFromError(err, opts, runner, next)) {
          if (next) refuseQuotaHopError(err, runner, next);
          attachNarrowedError(err, index, runners);
          throw err;
        }
        if (!(await leaseAllowsHop(hop, opts.timeoutMs))) {
          refuseQuotaHopError(err, runner, next);
          attachNarrowedError(err, index, runners);
          throw err;
        }
        await maybeExcludeCleanHop(index, runners, opts.workdir, logForHop);
        await beginHop(hop, opts, runner, next, hopCauseFromError(err), hopResetFromError(err));
        index++;
        continue;
      }

      if (result.status === "ok") clearCooldown(hop, runner);
      else noteCooldown(hop, runner, { result });
      const next = runners[index + 1];
      if (!next || !shouldHopFromResult(result, opts, runner, next)) {
        settleQuotaSigterm(opts, result, false, runner.name);
        return attachNarrowed(refuseQuotaHop(result, runner, next), index, runners);
      }
      if (!(await leaseAllowsHop(hop, opts.timeoutMs))) {
        settleQuotaSigterm(opts, result, false, runner.name);
        return attachNarrowed(refuseQuotaHop(result, runner, next), index, runners);
      }
      try {
        await maybeExcludeCleanHop(index, runners, opts.workdir, logForHop);
        await beginHop(hop, opts, runner, next, hopCauseFromResult(result), hopResetFromResult(result));
      } catch (err) {
        settleQuotaSigterm(opts, result, false, runner.name);
        throw err;
      }
      settleQuotaSigterm(opts, result, true, runner.name);
      index++;
    }
  };
}

export function withModelHop(engine: Engine, hop: ModelHopOptions): Engine {
  return withEngineChain(engine, hop);
}
