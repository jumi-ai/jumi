import { readFileSync } from "node:fs";
import type { ForgeKind } from "./forge.ts";

export const RUNNERS_FILE_ENV = "JUMI_RUNNERS_FILE";
export const OPENCODE_RUNNER_TYPE = "opencode";
export const CLAUDE_RUNNER_TYPE = "claude";
export const AGY_RUNNER_TYPE = "agy";
export const CODEX_RUNNER_TYPE = "codex";
/** Catalog default when a `type: codex` entry omits effort. Not a synthesized-chain model. */
export const CODEX_DEFAULT_EFFORT = "high";
/**
 * Deploy-contract required constraint. Homelab (`FORGE` unset, empty, or `gitea`)
 * must not start if a runners file names `type: agy`. `FORGE=github` may.
 * Listed under `required constraints` so a later removal is a major bump.
 */
export const ANTIGRAVITY_HOMELAB_CONSTRAINT = "Antigravity refused unless FORGE=github";
export const SYNTHESIZED_PRIMARY = "primary";
export const SYNTHESIZED_FALLBACK = "fallback";

export interface OpenCodeRunnerConfig {
  type: typeof OPENCODE_RUNNER_TYPE;
  model: string;
  variant?: string;
}

export interface ClaudeRunnerConfig {
  type: typeof CLAUDE_RUNNER_TYPE;
  model: string;
  effort?: string;
}

export interface AgyRunnerConfig {
  type: typeof AGY_RUNNER_TYPE;
  model: string;
  effort?: string;
}

export interface CodexRunnerConfig {
  type: typeof CODEX_RUNNER_TYPE;
  model: string;
  effort: string;
}

export type RunnerConfig = OpenCodeRunnerConfig | ClaudeRunnerConfig | AgyRunnerConfig | CodexRunnerConfig;
export type RunnerType = RunnerConfig["type"];

/**
 * `--effort` levels the installed `claude` binary accepts, proved against that
 * binary by `claude_flag_probe.ts` in the image job. An unknown level is not an
 * error there — claude warns on stderr and runs at the default — so a typo like
 * `hihg` in `JUMI_RUNNERS_FILE` would silently downgrade every run of that
 * runner, and the image probe cannot see operator config. Reject it at load
 * instead, where the operator gets a named error. `agy` has its own levels, so
 * this is claude-only.
 */
export const CLAUDE_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Effort levels a `type: codex` runner may set. `ultra` is refused: it burns the
 * shared ChatGPT pool and is not required for parity. Unknown levels fail at
 * load for the same reason as Claude — a typo must not silently downgrade.
 */
export const CODEX_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** First-party CLI runners that take `effort` rather than OpenCode's `variant`. */
export function usesEffort(
  type: string | undefined
): type is typeof CLAUDE_RUNNER_TYPE | typeof AGY_RUNNER_TYPE | typeof CODEX_RUNNER_TYPE {
  return type === CLAUDE_RUNNER_TYPE || type === AGY_RUNNER_TYPE || type === CODEX_RUNNER_TYPE;
}

export type NamedRunner = RunnerConfig & { name: string };

export interface RunnersCatalog {
  runners: Record<string, RunnerConfig>;
  chain: string[];
}

export interface SynthesizeRunnersInput {
  model: string;
  variant?: string;
  fallbackModel?: string;
  fallbackVariant?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opencodeRunner(model: string, variant?: string): RunnerConfig {
  return variant ? { type: OPENCODE_RUNNER_TYPE, model, variant } : { type: OPENCODE_RUNNER_TYPE, model };
}

function fail(message: string): never {
  throw new Error(message);
}

function effortRunner(
  type: typeof CLAUDE_RUNNER_TYPE | typeof AGY_RUNNER_TYPE,
  model: string,
  effort?: string
): ClaudeRunnerConfig | AgyRunnerConfig {
  return effort ? { type, model, effort } : { type, model };
}

function parseRunner(name: string, spec: unknown): RunnerConfig {
  if (!isPlainObject(spec)) fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} must be an object`);
  if (typeof spec.model !== "string" || !spec.model) {
    fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} missing model`);
  }
  if (spec.type === OPENCODE_RUNNER_TYPE) {
    const variant = spec.variant;
    if (variant != null && typeof variant !== "string") {
      fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} invalid variant`);
    }
    return opencodeRunner(spec.model, typeof variant === "string" && variant ? variant : undefined);
  }
  if (spec.type === CODEX_RUNNER_TYPE) {
    const effort = spec.effort;
    if (effort != null && typeof effort !== "string") {
      fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} invalid effort`);
    }
    const level = typeof effort === "string" && effort ? effort : CODEX_DEFAULT_EFFORT;
    if (!CODEX_EFFORT_LEVELS.includes(level)) {
      fail(
        `Invalid ${RUNNERS_FILE_ENV}: runner ${name} effort ${level} is not one of ${CODEX_EFFORT_LEVELS.join(", ")}`
      );
    }
    return { type: CODEX_RUNNER_TYPE, model: spec.model, effort: level };
  }
  if (usesEffort(spec.type as string | undefined)) {
    const effort = spec.effort;
    if (effort != null && typeof effort !== "string") {
      fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} invalid effort`);
    }
    if (
      spec.type === CLAUDE_RUNNER_TYPE &&
      typeof effort === "string" &&
      effort &&
      !CLAUDE_EFFORT_LEVELS.includes(effort)
    ) {
      fail(
        `Invalid ${RUNNERS_FILE_ENV}: runner ${name} effort ${effort} is not one of ${CLAUDE_EFFORT_LEVELS.join(", ")}`
      );
    }
    return effortRunner(
      spec.type as typeof CLAUDE_RUNNER_TYPE | typeof AGY_RUNNER_TYPE,
      spec.model,
      typeof effort === "string" && effort ? effort : undefined
    );
  }
  fail(`Unknown runner type: ${String(spec.type)}`);
}

export function parseRunnersCatalog(raw: unknown): RunnersCatalog {
  if (!isPlainObject(raw)) fail(`Invalid ${RUNNERS_FILE_ENV}: expected object`);
  if (!isPlainObject(raw.runners)) fail(`Invalid ${RUNNERS_FILE_ENV}: runners must be an object`);
  if (!Array.isArray(raw.chain)) fail(`Invalid ${RUNNERS_FILE_ENV}: chain must be an array`);
  if (raw.chain.length === 0) fail(`Invalid ${RUNNERS_FILE_ENV}: chain must not be empty`);

  const runners: Record<string, RunnerConfig> = {};
  for (const [name, spec] of Object.entries(raw.runners)) {
    runners[name] = parseRunner(name, spec);
  }

  const chain: string[] = [];
  const seen = new Set<string>();
  for (const name of raw.chain) {
    if (typeof name !== "string" || !name) fail(`Invalid ${RUNNERS_FILE_ENV}: chain entries must be names`);
    if (!runners[name]) fail(`Invalid ${RUNNERS_FILE_ENV}: chain references unknown runner ${name}`);
    if (seen.has(name)) fail(`Invalid ${RUNNERS_FILE_ENV}: duplicate runner in chain: ${name}`);
    seen.add(name);
    chain.push(name);
  }
  return { runners, chain };
}

export function parseRunnersFile(path: string): RunnersCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`Invalid ${RUNNERS_FILE_ENV}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseRunnersCatalog(raw);
}

export function synthesizeRunners(input: SynthesizeRunnersInput): RunnersCatalog {
  const runners: Record<string, RunnerConfig> = {
    [SYNTHESIZED_PRIMARY]: opencodeRunner(input.model, input.variant),
  };
  const chain = [SYNTHESIZED_PRIMARY];
  if (input.fallbackModel) {
    runners[SYNTHESIZED_FALLBACK] = opencodeRunner(input.fallbackModel, input.fallbackVariant);
    chain.push(SYNTHESIZED_FALLBACK);
  }
  return { runners, chain };
}

export class AntigravityRefusedError extends Error {
  readonly constraint = ANTIGRAVITY_HOMELAB_CONSTRAINT;

  constructor(runnerNames: readonly string[]) {
    const listed = runnerNames.join(", ");
    super(`${ANTIGRAVITY_HOMELAB_CONSTRAINT}: ${RUNNERS_FILE_ENV} names type ${AGY_RUNNER_TYPE} (${listed})`);
    this.name = "AntigravityRefusedError";
  }
}

/** Fail closed at process start. A synthesized OpenCode chain never names `agy`. */
export function refuseAntigravityUnlessGithub(catalog: RunnersCatalog, forge: ForgeKind): void {
  if (forge === "github") return;
  const names = Object.entries(catalog.runners)
    .filter(([, runner]) => runner.type === AGY_RUNNER_TYPE)
    .map(([name]) => name)
    .sort();
  if (names.length > 0) throw new AntigravityRefusedError(names);
}

export function loadRunnersCatalog(
  path: string | undefined,
  fromEnv: SynthesizeRunnersInput,
  forge: ForgeKind
): RunnersCatalog {
  const catalog = path ? parseRunnersFile(path) : synthesizeRunners(fromEnv);
  refuseAntigravityUnlessGithub(catalog, forge);
  return catalog;
}

export function orderedRunners(catalog: RunnersCatalog): NamedRunner[] {
  return catalog.chain.map((name) => {
    const runner = catalog.runners[name];
    if (!runner) fail(`Unknown runner in chain: ${name}`);
    return { name, ...runner };
  });
}

export function modelsFromCatalog(catalog: RunnersCatalog): SynthesizeRunnersInput {
  const ordered = orderedRunners(catalog);
  const primary = ordered[0];
  if (!primary) fail(`Invalid ${RUNNERS_FILE_ENV}: chain must not be empty`);
  const second = ordered[1];
  return {
    model: primary.model,
    variant: primary.type === OPENCODE_RUNNER_TYPE ? primary.variant : undefined,
    fallbackModel: second?.model,
    fallbackVariant: second?.type === OPENCODE_RUNNER_TYPE ? second.variant : undefined,
  };
}

export interface RunnerStamp {
  type: string;
  model: string;
  variant?: string;
  effort?: string;
}

export function runnerStamp(runner: { type?: string; model: string; variant?: string; effort?: string }): RunnerStamp {
  const type = runner.type ?? OPENCODE_RUNNER_TYPE;
  const level = usesEffort(type) ? runner.effort : runner.variant;
  if (!level) return { type, model: runner.model };
  return usesEffort(type)
    ? { type, model: runner.model, effort: level }
    : { type, model: runner.model, variant: level };
}

/** The one visible attribution line Jumi appends to public artifacts. */
export function formatRunnerStamp(runner: RunnerStamp): string {
  const level = runner.effort ?? runner.variant;
  return `_Jumi · ${runner.type} · ${runner.model}${level ? ` (${level})` : ""}_`;
}

export function appendRunnerStamp(body: string, runner: RunnerStamp | string | undefined): string {
  if (!runner) return body;
  const line = typeof runner === "string" ? runner : formatRunnerStamp(runner);
  const text = body.trimEnd();
  return text ? `${text}\n\n${line}` : line;
}
