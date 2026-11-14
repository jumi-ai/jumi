import { type RunnerStamp, type RunnerType, runnerStamp } from "./runners.ts";
import { redactGitSecrets } from "./workspace.ts";

export type TraceKind = "review" | "implement" | "follow-up" | "conflict";

export interface TraceContext {
  kind: TraceKind;
  owner: string;
  repo: string;
  sha?: string;
  jobId?: string;
}

export interface EngineRunOptions {
  type?: RunnerType;
  model: string;
  variant?: string;
  effort?: string;
  /**
   * Catalog entry name behind this spawn (`chain` entry). Present when the
   * spawn came through a named chain; absent for direct engine calls.
   * Usage rows and logs use it so same-model entries stay countable.
   */
  runnerName?: string;
  /**
   * Credential selector from the catalog entry (`"api-key"` for API-key
   * runners, else the subscription default). General across runner types;
   * only `type: claude` honors `"api-key"` today.
   */
  auth?: string;
  /** Parent env var holding the key when `auth` is `"api-key"`. */
  authEnv?: string;
  /** Parent key-var names across the whole chain (stripped from every child). */
  keyEnvNames?: string[];
  workdir: string;
  home?: string;
  sanitizeEnv?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  reviewLabel?: string;
  memorySampleIntervalMs?: number;
  /** Interval for the live per-run log-file quota poll. Defaults to QUOTA_POLL_INTERVAL_MS; 0 disables. */
  quotaPollIntervalMs?: number;
  extraEnv?: Record<string, string>;
  /** Configured forge URL (`config.giteaUrl`) so the webfetch deny follows config when `extraEnv` has no `GIT_AUTH_HOST`. */
  forgeUrl?: string;
  abortSignal?: AbortSignal;
  onPid?: (pid: number) => void | Promise<void>;
  logger?: (message: string) => void;
  trace?: TraceContext;
  prompt?: string;
  continueSession?: boolean;
  hop?: boolean;
  hopFromIncomplete?: boolean;
  deferQuotaExit?: boolean;
  /**
   * Staged base-branch instructions for `kind === "review"` (outside the
   * tracked checkout, e.g. under the spawn's `.jumi-tmp`). Workers never set
   * this. Runners use it to load the base `AGENTS.md`/`CLAUDE.md` and skills
   * without loading the head's project config.
   */
  baseInstructionsDir?: string;
}

export type EngineStatus = "ok" | "timeout" | "exit" | "stuck";

export type QuotaClass = "resetting" | "hard";

/**
 * Absolute unix timestamp (ms) at which the provider says the quota resets,
 * from what the result actually states. An explicit `quotaResetAtMs` (Codex
 * absolute dates) wins; otherwise a quota result carrying `retryAfterMs` (the
 * opencode runner's delay form) resolves to `nowMs + retryAfterMs`. Returns
 * undefined when the result carries no stated reset — never guessed — or when
 * it is not a quota result.
 */
export function resolveQuotaResetAtMs(
  result: { quota?: QuotaClass | null; quotaResetAtMs?: number; retryAfterMs?: number },
  nowMs = Date.now()
): number | undefined {
  if (result.quota == null) return undefined;
  if (typeof result.quotaResetAtMs === "number" && Number.isFinite(result.quotaResetAtMs)) {
    return result.quotaResetAtMs;
  }
  if (typeof result.retryAfterMs === "number" && Number.isFinite(result.retryAfterMs)) {
    return nowMs + result.retryAfterMs;
  }
  return undefined;
}

export interface EngineResult {
  status: EngineStatus;
  exitCode?: number | null;
  stdout?: string;
  message?: string;
  infra?: boolean;
  auth?: boolean;
  durationMs?: number;
  quota?: QuotaClass;
  retryAfterMs?: number;
  /**
   * Absolute unix timestamp (ms) when the provider says the quota resets, if
   * the quota message actually states one. Set by the harness on quota
   * results only; metrics record it per runner and the hop line carries it.
   * Absent when the message carries no reset time — never guessed.
   */
  quotaResetAtMs?: number;
  /** The runner that actually produced this result (after any hop). */
  runner?: RunnerStamp;
  /** Position of `runner` in the engine chain. Model text is not unique. */
  chainIndex?: number;
  /** Set when a `hopFromIncomplete` run was refused: no runner was spawned, so there is no result. */
  hopDeclined?: boolean;
  /** A later runner remained, but this quota hop was refused (lease, session, or abort). */
  hopRefused?: boolean;
  /**
   * Narrowed writer set for this engine call: every effective-chain entry up
   * to `chainIndex` except quota/auth/provider-unavailable hops that left a
   * clean worktree. Absent means the worktree state was unknown and the
   * caller must conservatively count every tried runner.
   */
  contributors?: RunnerStamp[];
}

export type Engine = (opts: EngineRunOptions) => Promise<EngineResult>;

export class EngineFailedError extends Error {
  readonly infra: boolean;
  readonly auth: boolean;
  readonly quota?: QuotaClass;
  readonly retryAfterMs?: number;
  /** The runner whose spawn failed; set by the engine chain or `throwIfEngineFailed`. */
  runner?: RunnerStamp;
  /** Position of `runner` in the engine chain. Model text is not unique. */
  chainIndex?: number;
  /** A later runner remained, but this quota hop was refused (lease, session, or abort). */
  hopRefused?: boolean;
  /**
   * Narrowed writer set for the failed engine call, same semantics as
   * `EngineResult.contributors`. Absent means unknown: count every tried runner.
   */
  contributors?: RunnerStamp[];

  constructor(message: string, infra = false, extras?: { quota?: QuotaClass; retryAfterMs?: number; auth?: boolean }) {
    super(message);
    this.name = "EngineFailedError";
    this.auth = extras?.auth === true;
    this.infra = this.auth ? false : infra;
    if (extras?.quota) this.quota = extras.quota;
    if (extras?.retryAfterMs != null) this.retryAfterMs = extras.retryAfterMs;
  }
}

export function redactEngineText(text: string, opts: Pick<EngineRunOptions, "extraEnv">): string {
  return redactGitSecrets(text, [opts.extraEnv?.GIT_AUTH_TOKEN]);
}

export function resolveEngine(opts: { engine?: Engine; openCodeRunner?: Engine }, fallback: Engine): Engine {
  return opts.engine ?? opts.openCodeRunner ?? fallback;
}

export function throwIfEngineFailed(result: EngineResult): void {
  if (result.status === "ok") return;
  const err = new EngineFailedError(result.message ?? `engine ${result.status}`, result.infra === true, {
    quota: result.quota,
    retryAfterMs: result.retryAfterMs,
    auth: result.auth === true,
  });
  if (result.runner) err.runner = result.runner;
  if (result.chainIndex != null) err.chainIndex = result.chainIndex;
  if (result.hopRefused) err.hopRefused = true;
  if (result.contributors) err.contributors = result.contributors;
  throw err;
}

/** Record on a thrown spawn error which runner failed, unless an inner layer already did. */
export function attachRunner(err: unknown, runner: RunnerStamp, chainIndex?: number): void {
  if (err === null || typeof err !== "object") return;
  const carrier = err as { runner?: RunnerStamp; chainIndex?: number };
  if (!carrier.runner) carrier.runner = runner;
  if (carrier.chainIndex == null && chainIndex != null) carrier.chainIndex = chainIndex;
}

/** Runner that produced `result`, falling back to the options the caller spawned with. */
export function resultRunner(
  result: EngineResult,
  opts: Pick<EngineRunOptions, "type" | "model" | "variant" | "effort">
): RunnerStamp {
  return result.runner ?? runnerStamp(opts);
}

/** Runner attached to a thrown spawn error, if any. */
export function thrownRunner(err: unknown): RunnerStamp | undefined {
  if (err === null || typeof err !== "object") return undefined;
  return (err as { runner?: RunnerStamp }).runner;
}

/** Chain position attached to a thrown spawn error, if any. */
export function thrownChainIndex(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const index = (err as { chainIndex?: number }).chainIndex;
  return typeof index === "number" ? index : undefined;
}

/**
 * Spawn `engine` and report the runner behind this spawn to `onRunner`, whether
 * the spawn returns or throws, so failure diaries carry the runner that failed.
 * The chain position rides along so provenance can conservatively include an
 * earlier failed runner whose edits could survive into a later hop.
 */
export async function runEngineStamped(
  engine: Engine,
  opts: EngineRunOptions,
  onRunner: (runner: RunnerStamp, chainIndex?: number) => void
): Promise<EngineResult> {
  let result: EngineResult;
  try {
    result = await engine(opts);
  } catch (err) {
    attachRunner(err, runnerStamp(opts));
    onRunner(thrownRunner(err) ?? runnerStamp(opts), thrownChainIndex(err));
    throw err;
  }
  onRunner(resultRunner(result, opts), result.chainIndex);
  return result;
}
