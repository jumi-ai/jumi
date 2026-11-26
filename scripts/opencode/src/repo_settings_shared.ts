/**
 * Shared definitions for the `.jumi.yml` repository settings keys.
 *
 * Each top-level key's `RepoSettingDef` lives in its own file under
 * `repo_settings_keys/` (one file per key, named after the YAML key), and
 * `repo_settings.ts` only imports those files into `REPO_SETTINGS_REGISTRY`
 * in alphabetical order. Adding a key means adding one new file plus one
 * import line and one registry line at the sorted position, so two parallel
 * additions land in different hunks instead of appending at the same spot.
 *
 * This module holds everything a key definition needs (types, factories,
 * defaults, and the parse/validate helpers) and imports nothing from the
 * registry, so the dependency graph stays acyclic: keys import from here,
 * the registry imports the keys.
 */

export interface RepoTimeouts {
  review?: number;
  implement?: number;
  followup?: number;
  conflict?: number;
}

const REPO_SETUP_ON_FAILURES = ["continue", "fail"] as const;

type RepoSetupOnFailure = (typeof REPO_SETUP_ON_FAILURES)[number];

/** Repository setup kinds: the `timeouts` spelling (`followup`, not `follow-up`). */
export const REPO_SETUP_KINDS = ["review", "implement", "followup", "conflict"] as const;
export type RepoSetupKind = (typeof REPO_SETUP_KINDS)[number];

/** Known sub-keys of the `setup` mapping. */
const SETUP_KEYS = ["run", "timeout", "on_failure", "kinds"] as const;

/** Default setup failure policy: run the job anyway. */
const DEFAULT_SETUP_ON_FAILURE: RepoSetupOnFailure = "continue";

export interface RepoSetup {
  /** Shell script run from the worktree root with `sh -e`. */
  run: string;
  /** Whole minutes. Absent means the default. */
  timeout?: number;
  /** What to do when setup fails, times out, or leaves a dirty tree. */
  onFailure: RepoSetupOnFailure;
  /** Kinds the setup runs on. Absent means all four. */
  kinds: RepoSetupKind[];
}

export interface ConflictRegenerateEntry {
  file: string;
  run: string;
}

/** Basenames the built-in helm handling owns. A `conflict_regenerate` entry may not reuse one. */
const CONFLICT_REGENERATE_RESERVED = new Set(["Chart.lock", "requirements.lock"]);

export interface RepoReviewBudget {
  maxFiles?: number;
  maxPatchBytes?: number;
}
/**
 * One top-level `.jumi.yml` key, declared exactly once. `REPO_SETTINGS_REGISTRY`
 * in `repo_settings.ts` holds one entry per key in alphabetical order;
 * `parseRepoSettingsText` is a loop over it, and `RepoSettings`, `KNOWN_KEYS`, and the
 * `loadRepoSettings` output are all derived from it. Adding a key means adding
 * one entry file under `repo_settings_keys/` (plus its `effective*` consumer and a
 * `docs/repo-settings.md` row).
 */
export type RepoSettingResult<Value> = { ok: true; value: Value } | { ok: false; error: string };

/**
 * Presence of a field on the parsed settings object. `required` fields are
 * always present (an absent key takes the entry default); `optional` fields are
 * present only when the YAML key is present; `always` fields are type-optional
 * but always present, possibly `undefined` (the legacy `allowed_runners` /
 * `trusted_senders` / `followup_ignore_logins` quirk: the old copy spread them
 * unconditionally, so `in` sees them on every load).
 */
type RepoSettingPresence = "required" | "optional" | "always";

export interface RepoSettingDef<Field extends string, Value> {
  /** The exact YAML spelling (snake_case). */
  readonly key: string;
  /** The `RepoSettings` field this key fills. */
  readonly field: Field;
  /** One-line summary for readers adding a key. */
  readonly doc: string;
  /** Value used when the key is absent (`undefined` keeps an optional field absent). */
  readonly defaultValue: Value | undefined;
  readonly presence: RepoSettingPresence;
  /**
   * Legacy output-order quirk: `early` entries assemble first (in registry
   * order), `late` entries assemble last; everything else assembles in
   * registry order. Only the identity labels (`early`) and
   * `suggestions_hold_merge` (`late`) need it. It reproduces the legacy
   * `loadRepoSettings` key order exactly, so
   * `{ state: "valid", ...parsed.settings }` keeps identical keys.
   */
  readonly placement?: "early" | "late";
  readonly parse: (raw: unknown) => RepoSettingResult<Value>;
}

/** An entry for a field that is always present. The author passes the absent-value default. */
export function requiredSetting<Field extends string, Value>(def: {
  key: string;
  field: Field;
  doc: string;
  defaultValue: Value;
  parse: (raw: unknown) => RepoSettingResult<Value>;
  placement?: "early" | "late";
}): RepoSettingDef<Field, Value> & { readonly presence: "required" } {
  return { ...def, presence: "required" };
}

/** An entry for a field that is present only when the YAML key is present. */
export function optionalSetting<Field extends string, Value>(def: {
  key: string;
  field: Field;
  doc: string;
  parse: (raw: unknown) => RepoSettingResult<Value>;
  placement?: "early" | "late";
}): RepoSettingDef<Field, Value> & { readonly presence: "optional" } {
  return { ...def, defaultValue: undefined, presence: "optional" };
}

/**
 * An entry for a type-optional field that is still always present (possibly
 * `undefined`). Only for the three legacy unconditional copies.
 */
export function alwaysPresentSetting<Field extends string, Value>(def: {
  key: string;
  field: Field;
  doc: string;
  parse: (raw: unknown) => RepoSettingResult<Value>;
  placement?: "early" | "late";
}): RepoSettingDef<Field, Value> & { readonly presence: "always" } {
  return { ...def, defaultValue: undefined, presence: "always" };
}

export type RepoClosingKeyword = "closes" | "refs";

export type RepoMode = "full" | "review-only" | "off";

const REPO_MODES: readonly RepoMode[] = ["full", "review-only", "off"];

/** CI gate wait mode: `required` waits only for required checks, `all` waits for every check, `none` never waits. */
export type CiGateWait = "all" | "required" | "none";

const CI_GATE_WAITS: readonly CiGateWait[] = ["all", "required", "none"];

/** Known sub-keys of the `ci_gate` mapping. */
const CI_GATE_KEYS = ["wait"] as const;

const AUTOMERGE_METHODS = ["merge", "squash", "rebase", "rebase-merge", "fast-forward-only"] as const;
export type RepoAutomergeMethod = (typeof AUTOMERGE_METHODS)[number];

/** Repository timeout keys: `followup` controls `follow-up` jobs. Values are whole minutes. */
export const TIMEOUT_KEYS = ["review", "implement", "followup", "conflict"] as const;

/** Documented minimum for every repository timeout: 1 minute. Below this the file is invalid. */
const MIN_TIMEOUT_MINUTES = 1;

/** Repository review-budget keys: `max_files` caps changed files, `max_patch_bytes` caps patch bytes. */
export const REVIEW_BUDGET_KEYS = ["max_files", "max_patch_bytes"] as const;

/** Documented minimum for every repository review-budget value: 1. Below this the file is invalid. */
const MIN_REVIEW_BUDGET_VALUE = 1;

/** Default per-issue auto-merge opt-in label. Repository `.jumi.yml` may rename it. */
export const DEFAULT_AUTOMERGE_LABEL = "automerge";
/** Default per-issue auto-merge opt-out label. Repository `.jumi.yml` may rename it. */
export const DEFAULT_NO_AUTOMERGE_LABEL = "no-automerge";
/** Default GitHub pickup label. Repository `.jumi.yml` may rename it with `pickup_label`. Gitea ignores it. */
export const DEFAULT_PICKUP_LABEL = "jumi";
/** Default ignore-conflicts label. Repository `.jumi.yml` may rename it with `ignore_conflicts_label`. */
export const DEFAULT_IGNORE_CONFLICTS_LABEL = "ignore-conflicts";

/** Default branch prefix: `jumi/issue-<N>-<slug>`. */
export const DEFAULT_BRANCH_PREFIX = "jumi";
/** Default PR title template: the issue title verbatim. */
export const DEFAULT_PR_TITLE_TEMPLATE = "{title}";
/** Default commit message template for the parent's leftover commit. */
export const DEFAULT_COMMIT_MESSAGE_TEMPLATE = "Implement #{issue}: {title}";
/** Default closing behavior: closing keywords that close the issue on merge. */
export const DEFAULT_CLOSING_KEYWORD: RepoClosingKeyword = "closes";

const REPO_CLOSING_KEYWORDS: readonly RepoClosingKeyword[] = ["closes", "refs"];

export { AUTOMERGE_METHODS, REPO_CLOSING_KEYWORDS, REPO_MODES };

/**
 * Validate a `branch_prefix` value. One or more path segments of
 * `[a-z0-9._-]`; no leading or trailing slash, no empty segments, no `.` or
 * `..`, and the sample branch `<prefix>/issue-1-x` must pass `git
 * check-ref-format` rules. Prefixes colliding with Jumi's internal refs
 * (`jumi/target`, `jumi/pr-*`, `refs/jumi/wip/`) are rejected.
 */
export function validateBranchPrefix(value: string): { ok: true; prefix: string } | { ok: false; error: string } {
  const prefix = value.trim();
  if (!prefix) return { ok: false, error: `"branch_prefix" must be a non-blank string` };
  if (prefix.startsWith("/") || prefix.endsWith("/")) {
    return { ok: false, error: `"branch_prefix" must not have a leading or trailing slash` };
  }
  if (prefix.includes("//")) {
    return { ok: false, error: `"branch_prefix" must not contain empty path segments` };
  }
  const segments = prefix.split("/");
  for (const segment of segments) {
    if (!segment) return { ok: false, error: `"branch_prefix" must not contain empty path segments` };
    if (segment === "." || segment === "..") {
      return { ok: false, error: `"branch_prefix" must not contain "." or ".." segments` };
    }
    if (!/^[a-z0-9._-]+$/.test(segment)) {
      return { ok: false, error: `"branch_prefix" segments must match [a-z0-9._-]` };
    }
    if (segment.startsWith(".")) {
      return { ok: false, error: `"branch_prefix" segments must not start with "."` };
    }
    if (segment.endsWith(".lock")) {
      return { ok: false, error: `"branch_prefix" segments must not end with ".lock"` };
    }
  }
  if (prefix.includes("..")) {
    return { ok: false, error: `"branch_prefix" must not contain ".."` };
  }
  if (prefix.includes("@{")) {
    return { ok: false, error: `"branch_prefix" must not contain "@{"` };
  }
  // Collisions with Jumi's internal refs: the review checkout uses
  // `jumi/target` and `jumi/pr-<n>` branches, and checkpoints live under
  // `refs/jumi/wip/`. A prefix that is or sits under one of those would
  // collide with them on the forge.
  if (prefix === "jumi/target" || prefix.startsWith("jumi/target/")) {
    return { ok: false, error: `"branch_prefix" must not collide with Jumi's internal ref "jumi/target"` };
  }
  if (prefix === "jumi/pr" || prefix.startsWith("jumi/pr-") || prefix.startsWith("jumi/pr/")) {
    return { ok: false, error: `"branch_prefix" must not collide with Jumi's internal refs "jumi/pr-*"` };
  }
  if (prefix === "refs" || prefix.startsWith("refs/")) {
    return { ok: false, error: `"branch_prefix" must not collide with Jumi's internal refs "refs/jumi/wip/"` };
  }
  // The full branch `<prefix>/issue-1-x` must pass `git check-ref-format`.
  const sample = `${prefix}/issue-1-x`;
  const refError = checkRefFormatError(sample);
  if (refError) return { ok: false, error: `"branch_prefix" ${refError}` };
  return { ok: true, prefix };
}

/** Subset of `git check-ref-format` rules relevant to constructed branches. */
function checkRefFormatError(ref: string): string | undefined {
  if (!ref || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".") || ref.includes("//")) {
    return `makes an invalid branch name "${ref}"`;
  }
  if (ref.includes("..") || ref.includes("@{")) {
    return `makes an invalid branch name "${ref}"`;
  }
  for (const component of ref.split("/")) {
    if (!component || component.startsWith(".") || component.endsWith(".lock")) {
      return `makes an invalid branch name "${ref}"`;
    }
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git forbids control chars and these symbols.
  if (/[\x00-\x20~^:?*[\\]/.test(ref)) {
    return `makes an invalid branch name "${ref}"`;
  }
  return undefined;
}

/**
 * Validate a `pr_title` / `commit_message` template. The only placeholders
 * are `{title}` and `{issue}`; any other `{...}` or stray brace makes the
 * whole file invalid.
 */
export function validatePrTemplate(
  key: "pr_title" | "commit_message",
  value: string
): { ok: true; template: string } | { ok: false; error: string } {
  if (!value.trim()) return { ok: false, error: `"${key}" must be a non-blank string` };
  const withoutValid = value.replaceAll("{title}", "").replaceAll("{issue}", "");
  if (withoutValid.includes("{") || withoutValid.includes("}")) {
    const named = /\{[^{}]*\}/.exec(withoutValid)?.[0];
    if (named) return { ok: false, error: `"${key}" contains unknown placeholder "${named}"` };
    return { ok: false, error: `"${key}" contains a stray "{" or "}"` };
  }
  return { ok: true, template: value };
}

/**
 * Normalize a key for "did you mean" suggestions: lowercase, `-` → `_`,
 * camelCase → snake_case. Canonical keys are already in that form, so a
 * normalized unknown key that matches a known key is almost certainly a
 * misspelling of it.
 */
function normalizeKey(key: string): string {
  return key
    .replace(/-/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** `unknown key "k"` plus a suggestion when `k` normalizes to a known key. */
export function unknownKeyError(key: string, known: readonly string[], prefix = ""): string {
  const normalized = normalizeKey(key);
  const canonical = known.find((candidate) => candidate === normalized);
  const shown = prefix ? `${prefix}.${key}` : key;
  if (canonical && canonical !== key) {
    const suggestion = prefix ? `${prefix}.${canonical}` : canonical;
    return `unknown key "${shown}" (did you mean "${suggestion}"?)`;
  }
  return `unknown key "${shown}"`;
}

type ConflictRegenerateParse = { ok: true; entries: ConflictRegenerateEntry[] } | { ok: false; error: string };

const CONFLICT_REGENERATE_KEYS = ["file", "run"] as const;

export function parseConflictRegenerateValue(value: unknown): ConflictRegenerateParse {
  if (!Array.isArray(value)) return { ok: false, error: `"conflict_regenerate" must be a list of mappings` };
  const entries: ConflictRegenerateEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const label = `conflict_regenerate[${index}]`;
    const entry = value[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `"${label}" must be a mapping with exactly "file" and "run"` };
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!(CONFLICT_REGENERATE_KEYS as readonly string[]).includes(key)) {
        return { ok: false, error: unknownKeyError(key, CONFLICT_REGENERATE_KEYS, label) };
      }
    }
    for (const key of CONFLICT_REGENERATE_KEYS) {
      if (!(key in record)) {
        return { ok: false, error: `"${label}" must have exactly "file" and "run"` };
      }
    }
    const file = record.file;
    const run = record.run;
    if (typeof file !== "string" || !file.trim()) {
      return { ok: false, error: `"${label}.file" must be a non-blank string` };
    }
    if (typeof run !== "string" || !run.trim()) {
      return { ok: false, error: `"${label}.run" must be a non-blank string` };
    }
    const name = file.trim();
    if (name.includes("/")) {
      return { ok: false, error: `"${label}.file" must be a basename without a slash` };
    }
    if (CONFLICT_REGENERATE_RESERVED.has(name)) {
      return { ok: false, error: `"${label}.file" duplicates a built-in lockfile` };
    }
    if (seen.has(name)) {
      return { ok: false, error: `"${label}.file" duplicates another entry` };
    }
    seen.add(name);
    entries.push({ file: name, run: (run as string).trim() });
  }
  return { ok: true, entries };
}

type TimeoutsParse = { ok: true; timeouts: RepoTimeouts } | { ok: false; error: string };

export function parseTimeoutsValue(value: unknown): TimeoutsParse {
  if (value === undefined) return { ok: true, timeouts: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `"timeouts" must be a mapping` };
  }
  const record = value as Record<string, unknown>;
  const timeouts: RepoTimeouts = {};
  for (const key of Object.keys(record)) {
    if (!(TIMEOUT_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: unknownKeyError(key, TIMEOUT_KEYS, "timeouts") };
    }
    const minutes = record[key];
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_TIMEOUT_MINUTES) {
      return { ok: false, error: `"timeouts.${key}" must be an integer number of minutes >= ${MIN_TIMEOUT_MINUTES}` };
    }
    (timeouts as Record<string, number>)[key] = minutes;
  }
  return { ok: true, timeouts };
}

type SetupParse = { ok: true; setup?: RepoSetup } | { ok: false; error: string };

export function parseSetupValue(value: unknown): SetupParse {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `"setup" must be a mapping` };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(SETUP_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: unknownKeyError(key, SETUP_KEYS, "setup") };
    }
  }
  if (!("run" in record) || record.run === undefined) {
    return { ok: false, error: `"setup.run" must be a non-blank string` };
  }
  if (typeof record.run !== "string" || !record.run.trim()) {
    return { ok: false, error: `"setup.run" must be a non-blank string` };
  }
  const run = record.run;
  let timeout: number | undefined;
  if ("timeout" in record && record.timeout !== undefined) {
    const minutes = record.timeout;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_TIMEOUT_MINUTES) {
      return { ok: false, error: `"setup.timeout" must be an integer number of minutes >= ${MIN_TIMEOUT_MINUTES}` };
    }
    timeout = minutes;
  }
  let onFailure: RepoSetupOnFailure = DEFAULT_SETUP_ON_FAILURE;
  if ("on_failure" in record && record.on_failure !== undefined) {
    if (
      typeof record.on_failure !== "string" ||
      !(REPO_SETUP_ON_FAILURES as readonly string[]).includes(record.on_failure)
    ) {
      return { ok: false, error: `"setup.on_failure" must be one of "continue", "fail"` };
    }
    onFailure = record.on_failure as RepoSetupOnFailure;
  }
  let kinds: RepoSetupKind[] = [...REPO_SETUP_KINDS];
  if ("kinds" in record && record.kinds !== undefined) {
    if (!Array.isArray(record.kinds)) {
      return { ok: false, error: `"setup.kinds" must be a list of job kinds` };
    }
    if (record.kinds.length === 0) {
      return { ok: false, error: `"setup.kinds" must not contain blank entries` };
    }
    const parsed: RepoSetupKind[] = [];
    for (const entry of record.kinds) {
      if (typeof entry !== "string" || entry.trim() === "") {
        return { ok: false, error: `"setup.kinds" must not contain blank entries` };
      }
      const trimmed = entry.trim();
      if (!(REPO_SETUP_KINDS as readonly string[]).includes(trimmed)) {
        return {
          ok: false,
          error: `"setup.kinds" must be one of "review", "implement", "followup", "conflict"`,
        };
      }
      if (!parsed.includes(trimmed as RepoSetupKind)) parsed.push(trimmed as RepoSetupKind);
    }
    kinds = parsed;
  }
  return {
    ok: true,
    setup: {
      run,
      ...(timeout !== undefined ? { timeout } : {}),
      onFailure,
      kinds,
    },
  };
}

type ReviewBudgetParse = { ok: true; reviewBudget: RepoReviewBudget } | { ok: false; error: string };

export function parseReviewBudgetValue(value: unknown): ReviewBudgetParse {
  if (value === undefined) return { ok: true, reviewBudget: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `"review_budget" must be a mapping` };
  }
  const record = value as Record<string, unknown>;
  const reviewBudget: RepoReviewBudget = {};
  for (const key of Object.keys(record)) {
    if (!(REVIEW_BUDGET_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: unknownKeyError(key, REVIEW_BUDGET_KEYS, "review_budget") };
    }
    const budget = record[key];
    if (typeof budget !== "number" || !Number.isInteger(budget) || budget < MIN_REVIEW_BUDGET_VALUE) {
      return {
        ok: false,
        error: `"review_budget.${key}" must be a positive integer`,
      };
    }
    if (key === "max_files") reviewBudget.maxFiles = budget;
    else reviewBudget.maxPatchBytes = budget;
  }
  return { ok: true, reviewBudget };
}

type CiGateParse = { ok: true; ciGate?: { wait: CiGateWait } } | { ok: false; error: string };

export function parseCiGateValue(value: unknown): CiGateParse {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `"ci_gate" must be a mapping` };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CI_GATE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: unknownKeyError(key, CI_GATE_KEYS, "ci_gate") };
    }
  }
  if (!("wait" in record) || record.wait === undefined) return { ok: true, ciGate: { wait: "required" } };
  const wait = record.wait;
  if (typeof wait !== "string" || !(CI_GATE_WAITS as readonly string[]).includes(wait)) {
    return { ok: false, error: `"ci_gate.wait" must be one of "all", "required", "none"` };
  }
  return { ok: true, ciGate: { wait: wait as CiGateWait } };
}

/**
 * Parse one list-of-strings setting. A non-list value keeps the caller's
 * `notListError`; a blank or non-string entry makes the whole file invalid.
 * Duplicates are dropped (unless `dedupe: false`), never an error.
 */
export function parseStringList(
  value: unknown,
  key: string,
  opts: { notListError: string; dedupe?: boolean }
): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: opts.notListError };
  const dedupe = opts.dedupe ?? true;
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return { ok: false, error: `"${key}" must not contain blank entries` };
    }
    const trimmed = entry.trim();
    if (dedupe && values.includes(trimmed)) continue;
    values.push(trimmed);
  }
  return { ok: true, values };
}
