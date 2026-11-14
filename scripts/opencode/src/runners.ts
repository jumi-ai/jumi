import { readFileSync } from "node:fs";
import { isValidEnvName, RUNNER_AUTH_API_KEY, RUNNER_AUTH_SUBSCRIPTION } from "./claude_credentials.ts";
import { logDiagnostic } from "./diagnostics.ts";
import type { ForgeKind } from "./forge.ts";
import { AGY_RUNNER_TYPE, CLAUDE_RUNNER_TYPE, CODEX_RUNNER_TYPE, OPENCODE_RUNNER_TYPE } from "./runner_types.ts";

export { AGY_RUNNER_TYPE, CLAUDE_RUNNER_TYPE, CODEX_RUNNER_TYPE, OPENCODE_RUNNER_TYPE };

import {
  DEFAULT_RUNNER_COOLDOWN_CONFIG,
  parseRunnerCooldown as parseCooldownFile,
  type RunnerCooldownConfig,
  type RunnerCooldownStore,
} from "./runner_cooldown.ts";

export const RUNNERS_FILE_ENV = "JUMI_RUNNERS_FILE";
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
  /**
   * Credential selector, general across runner types. `undefined` (or
   * `"subscription"`) keeps today's behavior. `"api-key"` bills the run to
   * the key in `authEnv`. Only `type: claude` accepts `"api-key"` today.
   */
  auth?: string;
  /** Parent env var holding the key when `auth` is `"api-key"`. Never a value. */
  authEnv?: string;
}

export interface ClaudeRunnerConfig {
  type: typeof CLAUDE_RUNNER_TYPE;
  model: string;
  effort?: string;
  /** Credential selector: absent (or `"subscription"`) is the setup token, `"api-key"` is `authEnv`. */
  auth?: string;
  /** Parent env var holding the Anthropic API key when `auth` is `"api-key"`. Never a value. */
  authEnv?: string;
}

export interface AgyRunnerConfig {
  type: typeof AGY_RUNNER_TYPE;
  model: string;
  effort?: string;
  /** Accepted for shape parity; `"api-key"` is refused on this runner type. */
  auth?: string;
  /** Refused on this runner type (only meaningful with `"api-key"`). */
  authEnv?: string;
}

export interface CodexRunnerConfig {
  type: typeof CODEX_RUNNER_TYPE;
  model: string;
  effort: string;
  /** Accepted for shape parity; `"api-key"` is refused on this runner type. */
  auth?: string;
  /** Refused on this runner type (only meaningful with `"api-key"`). */
  authEnv?: string;
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

export interface IndependenceGroupMember {
  type: string;
  model: string;
}

export interface IndependentReviewConfig {
  enabled: boolean;
  groups: Record<string, IndependenceGroupMember[]>;
}

export const RUNNER_SELECTION_ORDERED = "ordered" as const;
export const RUNNER_SELECTION_RANDOM_START = "random-start" as const;
export type RunnerSelectionMode = typeof RUNNER_SELECTION_ORDERED | typeof RUNNER_SELECTION_RANDOM_START;
export const RUNNER_SELECTION_MODES: readonly RunnerSelectionMode[] = [
  RUNNER_SELECTION_ORDERED,
  RUNNER_SELECTION_RANDOM_START,
];

export interface RunnersCatalog {
  runners: Record<string, RunnerConfig>;
  chain: string[];
  independentReview?: IndependentReviewConfig;
  selection?: RunnerSelectionMode;
  cooldown?: import("./runner_cooldown.ts").RunnerCooldownConfig;
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

function opencodeRunner(model: string, variant?: string, auth?: { auth?: string; authEnv?: string }): RunnerConfig {
  const runner: OpenCodeRunnerConfig = { type: OPENCODE_RUNNER_TYPE, model };
  if (variant) runner.variant = variant;
  if (auth?.auth !== undefined) runner.auth = auth.auth;
  if (auth?.authEnv !== undefined) runner.authEnv = auth.authEnv;
  return runner;
}

function fail(message: string): never {
  throw new Error(message);
}

function effortRunner(
  type: typeof CLAUDE_RUNNER_TYPE | typeof AGY_RUNNER_TYPE,
  model: string,
  effort?: string,
  auth?: { auth?: string; authEnv?: string }
): ClaudeRunnerConfig | AgyRunnerConfig {
  const runner: { type: string; model: string; effort?: string; auth?: string; authEnv?: string } = { type, model };
  if (effort) runner.effort = effort;
  if (auth?.auth !== undefined) runner.auth = auth.auth;
  if (auth?.authEnv !== undefined) runner.authEnv = auth.authEnv;
  return runner as ClaudeRunnerConfig | AgyRunnerConfig;
}

/**
 * Shared `auth` / `authEnv` shape validation. The `auth` value vocabulary is
 * general across runner types; whether `"api-key"` is usable depends on the
 * runner type and is checked in `parseRunner`, where the type is known.
 */
function parseRunnerAuth(name: string, spec: Record<string, unknown>): { auth?: string; authEnv?: string } {
  const auth = (spec as { auth?: unknown }).auth;
  const authEnv = (spec as { authEnv?: unknown }).authEnv;
  if (auth === undefined || auth === null || auth === "") {
    if (authEnv !== undefined) {
      fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} sets authEnv without auth`);
    }
    return {};
  }
  if (typeof auth !== "string") {
    fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} invalid auth`);
  }
  if (auth !== RUNNER_AUTH_SUBSCRIPTION && auth !== RUNNER_AUTH_API_KEY) {
    fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} unknown auth ${JSON.stringify(auth)}`);
  }
  if (auth === RUNNER_AUTH_SUBSCRIPTION) {
    if (authEnv !== undefined) {
      fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} sets authEnv without api-key auth`);
    }
    return { auth };
  }
  if (typeof authEnv !== "string" || !authEnv) {
    fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} api-key auth requires authEnv`);
  }
  if (!isValidEnvName(authEnv)) {
    fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} invalid authEnv ${JSON.stringify(authEnv)}`);
  }
  return { auth, authEnv };
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
    const credential = parseRunnerAuth(name, spec);
    if (credential.auth === RUNNER_AUTH_API_KEY) {
      fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} api-key auth is only supported on type ${CLAUDE_RUNNER_TYPE}`);
    }
    return opencodeRunner(spec.model, typeof variant === "string" && variant ? variant : undefined, credential);
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
    const credential = parseRunnerAuth(name, spec);
    if (credential.auth === RUNNER_AUTH_API_KEY) {
      fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} api-key auth is only supported on type ${CLAUDE_RUNNER_TYPE}`);
    }
    const runner: CodexRunnerConfig = { type: CODEX_RUNNER_TYPE, model: spec.model, effort: level };
    if (credential.auth !== undefined) runner.auth = credential.auth;
    if (credential.authEnv !== undefined) runner.authEnv = credential.authEnv;
    return runner;
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
    const credential = parseRunnerAuth(name, spec);
    if (credential.auth === RUNNER_AUTH_API_KEY && spec.type !== CLAUDE_RUNNER_TYPE) {
      fail(`Invalid ${RUNNERS_FILE_ENV}: runner ${name} api-key auth is only supported on type ${CLAUDE_RUNNER_TYPE}`);
    }
    return effortRunner(
      spec.type as typeof CLAUDE_RUNNER_TYPE | typeof AGY_RUNNER_TYPE,
      spec.model,
      typeof effort === "string" && effort ? effort : undefined,
      credential
    );
  }
  fail(`Unknown runner type: ${String(spec.type)}`);
}

export function parseIndependentReview(raw: unknown): IndependentReviewConfig | undefined {
  if (raw == null) return undefined;
  if (!isPlainObject(raw)) fail(`Invalid ${RUNNERS_FILE_ENV}: independentReview must be an object`);
  const enabled = (raw as Record<string, unknown>).enabled;
  if (enabled !== true) return undefined;
  const groupsRaw = (raw as Record<string, unknown>).groups;
  if (!isPlainObject(groupsRaw)) fail(`Invalid ${RUNNERS_FILE_ENV}: independentReview.groups must be an object`);
  const entries = Object.entries(groupsRaw);
  if (entries.length === 0) fail(`Invalid ${RUNNERS_FILE_ENV}: independentReview.groups must not be empty`);
  const groups: Record<string, IndependenceGroupMember[]> = {};
  const identityOwners = new Map<string, string>();
  for (const [familyRaw, membersRaw] of entries) {
    const family = familyRaw.trim();
    if (!family) fail(`Invalid ${RUNNERS_FILE_ENV}: independentReview group names must not be empty`);
    if (groups[family]) fail(`Invalid ${RUNNERS_FILE_ENV}: duplicate independence group ${family}`);
    if (!Array.isArray(membersRaw) || membersRaw.length === 0) {
      fail(`Invalid ${RUNNERS_FILE_ENV}: independence group ${family} must be a non-empty array`);
    }
    const members: IndependenceGroupMember[] = [];
    const seenMember = new Set<string>();
    for (const memberRaw of membersRaw) {
      if (!isPlainObject(memberRaw)) {
        fail(`Invalid ${RUNNERS_FILE_ENV}: independence group ${family} members must be {type, model} objects`);
      }
      const typeRaw = (memberRaw as Record<string, unknown>).type;
      const modelRaw = (memberRaw as Record<string, unknown>).model;
      if (typeof typeRaw !== "string" || !typeRaw.trim()) {
        fail(`Invalid ${RUNNERS_FILE_ENV}: independence group ${family} member missing type`);
      }
      if (typeof modelRaw !== "string" || !modelRaw.trim()) {
        fail(`Invalid ${RUNNERS_FILE_ENV}: independence group ${family} member missing model`);
      }
      const type = typeRaw.trim().toLowerCase();
      const model = modelRaw.trim();
      if (
        type !== OPENCODE_RUNNER_TYPE &&
        type !== CLAUDE_RUNNER_TYPE &&
        type !== AGY_RUNNER_TYPE &&
        type !== CODEX_RUNNER_TYPE
      ) {
        fail(`Invalid ${RUNNERS_FILE_ENV}: independence group ${family} unknown type ${typeRaw}`);
      }
      const key = `${type}|${model}`;
      if (seenMember.has(key)) continue;
      seenMember.add(key);
      const owner = identityOwners.get(key);
      if (owner && owner !== family) {
        fail(
          `Invalid ${RUNNERS_FILE_ENV}: independence identity ${type}:${model} in contradictory groups ${owner} and ${family}`
        );
      }
      identityOwners.set(key, family);
      members.push({ type, model });
    }
    groups[family] = members;
  }
  return { enabled: true, groups };
}

export function parseRunnerSelection(raw: unknown): RunnerSelectionMode | undefined {
  if (raw == null) return undefined;
  if (raw === RUNNER_SELECTION_ORDERED) return RUNNER_SELECTION_ORDERED;
  if (raw === RUNNER_SELECTION_RANDOM_START) return RUNNER_SELECTION_RANDOM_START;
  fail(
    `Invalid ${RUNNERS_FILE_ENV}: selection ${JSON.stringify(raw)} must be one of ${RUNNER_SELECTION_MODES.join(", ")}`
  );
}

export function resolveRunnerSelection(catalog: { selection?: string | undefined }): RunnerSelectionMode {
  if (catalog.selection == null) return RUNNER_SELECTION_ORDERED;
  if (catalog.selection === RUNNER_SELECTION_ORDERED || catalog.selection === RUNNER_SELECTION_RANDOM_START) {
    return catalog.selection;
  }
  fail(
    `Invalid ${RUNNERS_FILE_ENV}: selection ${JSON.stringify(catalog.selection)} must be one of ${RUNNER_SELECTION_MODES.join(", ")}`
  );
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
  const independentReview = parseIndependentReview((raw as Record<string, unknown>).independentReview);
  const selection = parseRunnerSelection((raw as Record<string, unknown>).selection);
  const cooldown = parseCooldownFile((raw as Record<string, unknown>).cooldown);
  const catalog: RunnersCatalog = { runners, chain };
  if (independentReview) catalog.independentReview = independentReview;
  if (selection) catalog.selection = selection;
  if (cooldown) catalog.cooldown = cooldown;
  return catalog;
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

/**
 * Uniformly choose a starting position in an eligible chain. The caller passes
 * the already-filtered eligible chain (independent-review exclusions applied,
 * dormant catalog entries never included). Returns 0 for empty input; the
 * engine chain refuses empty chains elsewhere.
 */
export function chooseRandomStartIndex(length: number, random: () => number = Math.random): number {
  if (length <= 0) return 0;
  if (length === 1) return 0;
  const value = random();
  const safe = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.9999999999999999) : 0;
  const index = Math.floor(safe * length);
  return Math.min(Math.max(index, 0), length - 1);
}

/**
 * Rotate an eligible chain around `startIndex`, preserving relative configured
 * order and wrapping. Never mutates the input; each job gets its own array so
 * independent jobs never share ordering state.
 */
export function rotateChainForStart(chain: readonly NamedRunner[], startIndex: number): NamedRunner[] {
  const copy = [...chain];
  if (copy.length <= 1) return copy;
  const normalized = ((Math.trunc(startIndex) % copy.length) + copy.length) % copy.length;
  if (normalized === 0) return copy;
  return [...copy.slice(normalized), ...copy.slice(0, normalized)];
}

export interface CooldownOrdering {
  cooldowns?: RunnerCooldownStore;
  nowMs?: number;
  logger?: (message: string) => void;
  fingerprints?: Record<string, string | undefined>;
}

export function resolveRunnerCooldownConfig(catalog: {
  cooldown?: RunnerCooldownConfig | undefined;
}): RunnerCooldownConfig {
  if (!catalog.cooldown) return { ...DEFAULT_RUNNER_COOLDOWN_CONFIG };
  return { ...DEFAULT_RUNNER_COOLDOWN_CONFIG, ...catalog.cooldown };
}

function applyCooldownToOrder(
  chain: readonly NamedRunner[],
  ordering?: CooldownOrdering
): { healthy: NamedRunner[]; ordered: NamedRunner[]; allCooled: boolean } | undefined {
  if (!ordering?.cooldowns) return undefined;
  const nowMs = ordering.nowMs ?? Date.now();
  const store = ordering.cooldowns;
  const healthy: NamedRunner[] = [];
  const cooled: NamedRunner[] = [];
  for (const runner of chain) {
    if (store.isCooled(runner.name, nowMs, ordering.fingerprints?.[runner.name])) cooled.push(runner);
    else healthy.push(runner);
  }
  if (ordering.logger) {
    for (const runner of cooled) {
      const entry = store.entry(runner.name);
      logDiagnostic(ordering.logger, "runner_skipped_cooldown", {
        runner: runner.name,
        until: entry ? new Date(entry.untilMs).toISOString() : null,
        reason: entry?.reason ?? null,
      });
    }
  }
  if (healthy.length === 0) {
    const byExpiry = [...cooled].sort((a, b) => store.cooldownUntil(a.name) - store.cooldownUntil(b.name));
    if (ordering.logger && byExpiry.length > 0) {
      const first = byExpiry[0]!;
      const entry = store.entry(first.name);
      logDiagnostic(ordering.logger, "runner_cooldown", {
        runner: first.name,
        reason: entry?.reason ?? null,
        until: entry ? new Date(entry.untilMs).toISOString() : null,
        source: entry?.source ?? null,
      });
    }
    return { healthy, ordered: byExpiry, allCooled: true };
  }
  return { healthy, ordered: healthy, allCooled: false };
}

/**
 * Effective attempt order for one fresh job. Ordered (the default when the
 * option is absent) returns a copy in configured order. Random-start uniformly
 * picks a start from the eligible chain and rotates around it. Single-runner
 * chains behave as before.
 */
export function orderChainForJob(
  chain: readonly NamedRunner[],
  selection?: RunnerSelectionMode | string | undefined,
  random: () => number = Math.random,
  cooldownOrdering?: CooldownOrdering
): NamedRunner[] {
  const eligible = applyCooldownToOrder(chain, cooldownOrdering);
  if (!eligible) {
    const copy = [...chain];
    const mode = selection == null ? RUNNER_SELECTION_ORDERED : resolveRunnerSelection({ selection });
    if (mode !== RUNNER_SELECTION_RANDOM_START) return copy;
    if (copy.length <= 1) return copy;
    return rotateChainForStart(copy, chooseRandomStartIndex(copy.length, random));
  }
  if (eligible.allCooled) return eligible.ordered;
  const copy = [...eligible.healthy];
  const mode = selection == null ? RUNNER_SELECTION_ORDERED : resolveRunnerSelection({ selection });
  if (mode !== RUNNER_SELECTION_RANDOM_START) return copy;
  if (copy.length <= 1) return copy;
  return rotateChainForStart(copy, chooseRandomStartIndex(copy.length, random));
}

export function describeAttemptOrder(chain: readonly NamedRunner[]): string {
  return chain.map((runner) => runner.name).join("->");
}

/**
 * Position of `name` in `chain` by runner name. Matches the `name` stored on
 * the ledger row when a previous attempt failed; `-1` when unknown so the
 * caller falls back to a fresh draw.
 */
export function indexOfRunnerByName(chain: readonly NamedRunner[], name: string | null | undefined): number {
  if (!name) return -1;
  return chain.findIndex((runner) => runner.name === name);
}

/** Runner name for a spawn stamp, matched by full identity (type+model+variant/effort+credential). */
export function runnerNameForStamp(
  chain: readonly NamedRunner[],
  stamp: { type: string; model: string; variant?: string; effort?: string; auth?: string } | null | undefined
): string | undefined {
  if (!stamp) return undefined;
  const wantLevel = stamp.effort ?? stamp.variant ?? null;
  const wantAuth = stamp.auth === RUNNER_AUTH_API_KEY ? RUNNER_AUTH_API_KEY : null;
  const candidates = chain.filter((runner) => {
    if (runner.type !== stamp.type || runner.model !== stamp.model) return false;
    const stamped = runnerStamp(runner);
    return (stamped.effort ?? stamped.variant ?? null) === wantLevel;
  });
  if (candidates.length === 0) return undefined;
  if (wantAuth !== null) {
    return candidates.find((runner) => runnerAuth(runner) === wantAuth)?.name;
  }
  return (candidates.find((runner) => runnerAuth(runner) == null) ?? candidates[0])?.name;
}

/**
 * Effective attempt order for a retried job after a runner failure.
 * `random-start` starts on the runner after `failedRunnerName` in configured
 * order (wrapping), independent of the random source, so a runner that is
 * down for a few minutes cannot consume every attempt. `ordered` keeps
 * configured order. Unknown/absent names and single-runner chains fall back
 * to the fresh-job draw.
 */
export function orderChainForRetry(
  chain: readonly NamedRunner[],
  selection?: RunnerSelectionMode | string | undefined,
  random: () => number = Math.random,
  failedRunnerName?: string | null | undefined,
  cooldownOrdering?: CooldownOrdering
): NamedRunner[] {
  if (cooldownOrdering?.cooldowns) {
    const applied = applyCooldownToOrder(chain, cooldownOrdering);
    if (applied) {
      if (applied.allCooled) return applied.ordered;
      const healthy = applied.healthy;
      const mode = selection == null ? RUNNER_SELECTION_ORDERED : resolveRunnerSelection({ selection });
      if (mode !== RUNNER_SELECTION_RANDOM_START) return [...healthy];
      if (healthy.length <= 1) return [...healthy];
      // Rotate the full configured order past the failed runner, then keep
      // only healthy entries in that rotated order. A cooled failed runner is
      // naturally skipped, so a retry never restarts on the dead runner.
      const copy = [...chain];
      const failedIndex = indexOfRunnerByName(copy, failedRunnerName);
      if (failedIndex < 0) return orderChainForJob(healthy, selection, random, cooldownOrdering);
      const rotated = rotateChainForStart(copy, failedIndex + 1);
      const healthySet = new Set(healthy.map((r) => r.name));
      const filtered = rotated.filter((r) => healthySet.has(r.name));
      if (filtered.length > 0) return filtered;
      return [...healthy];
    }
  }
  const copy = [...chain];
  const mode = selection == null ? RUNNER_SELECTION_ORDERED : resolveRunnerSelection({ selection });
  if (mode !== RUNNER_SELECTION_RANDOM_START) return copy;
  if (copy.length <= 1) return copy;
  const failedIndex = indexOfRunnerByName(copy, failedRunnerName);
  if (failedIndex < 0) return orderChainForJob(copy, selection, random);
  return rotateChainForStart(copy, failedIndex + 1);
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
  /**
   * Credential the run was billed to. Present only for API-key runners
   * (`"api-key"`); absent means the subscription token. The public
   * attribution line ignores it; provenance and hop matching do not.
   */
  auth?: string;
}

/** Normalized credential marker: `"api-key"` for API-key runners, else absent. */
export function runnerAuth(runner: { auth?: string | undefined }): string | undefined {
  return runner.auth === RUNNER_AUTH_API_KEY ? RUNNER_AUTH_API_KEY : undefined;
}

export function runnerStamp(runner: {
  type?: string;
  model: string;
  variant?: string;
  effort?: string;
  auth?: string;
}): RunnerStamp {
  const type = runner.type ?? OPENCODE_RUNNER_TYPE;
  const auth = runnerAuth(runner);
  const level = usesEffort(type) ? runner.effort : runner.variant;
  if (!level) return auth ? { type, model: runner.model, auth } : { type, model: runner.model };
  if (usesEffort(type)) {
    return auth ? { type, model: runner.model, effort: level, auth } : { type, model: runner.model, effort: level };
  }
  return auth ? { type, model: runner.model, variant: level, auth } : { type, model: runner.model, variant: level };
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

export { buildOpenCodeArgs } from "./git.ts";
