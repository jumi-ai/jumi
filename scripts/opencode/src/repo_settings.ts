/**
 * Repository settings file: `.jumi.yml` at the root of the repository's
 * default branch. The parent parses and applies it; no setting is handed to
 * a model, and nothing an agent writes during a job changes the settings
 * that job runs under.
 *
 * Strict: a file that does not parse, an unknown key, or a value of the
 * wrong type makes the whole file invalid. Invalid is its own state and is
 * never treated as "no file". A missing file is normal and silent.
 */

import { logDiagnostic } from "./diagnostics.ts";
import { globToRegExp } from "./review_md.ts";

export const REPO_SETTINGS_PATH = ".jumi.yml";

export interface RepoTimeouts {
  review?: number;
  implement?: number;
  followup?: number;
  conflict?: number;
}

export interface RepoSettings {
  automerge: boolean;
  /** Label that opts one Jumi PR into auto-merge. Case-insensitive. Default `automerge`. */
  automergeLabel: string;
  /** Label that opts one Jumi PR out of auto-merge. Case-insensitive. Default `no-automerge`. */
  noAutomergeLabel: string;
  timeouts: RepoTimeouts;
  /**
   * Runner allow-list for the repository. `undefined` (key absent) means no
   * restriction: the repository uses the full active chain. A defined list
   * (possibly empty) narrows every job for the repository to chain entries
   * whose name is on the list. Narrowing only: names outside the active
   * chain grant nothing.
   */
  allowedRunners?: string[];
  reviewExclude: string[];
  followupOnSuggestions: boolean;
  maxFollowupRounds?: number;
  maxConflictRounds?: number;
  takeoverAuthors: string[];
  ignoreConflictsAuthors: string[];
  /** PR-author logins whose open ❓ questions block the review status in this repository. */
  blockingQuestionAuthors: string[];
  /**
   * Trusted senders for the repository. `undefined` (key absent) means no
   * repository list: the deployment list (or write access when unset) decides.
   * A defined list narrows a set deployment list (intersection) and never
   * widens it. An explicitly empty list is invalid.
   */
  trustedSenders?: string[];
  /** Extra follow-up ignore logins for this repository. Union with the deployment list. */
  followupIgnoreLogins?: string[];
  /** Override for `IGNORE_CONFLICTS_LABEL` in this repository. `undefined` means the deployment value. */
  ignoreConflictsLabel?: string;
  /** Override for the GitHub pickup label in this repository. `undefined` means `jumi`. Gitea ignores it. */
  pickupLabel?: string;
  /** Repository mode: full work, reviews only, or everything off. Absent means full. */
  mode: RepoMode;
}

export type RepoMode = "full" | "review-only" | "off";

export const REPO_MODES: readonly RepoMode[] = ["full", "review-only", "off"];

export const REPO_MODE_DISABLED_NOTE =
  "Jumi worker jobs are turned off in this repository's settings (`.jumi.yml` `mode: review-only`). Reviews still run; assigning or labelling will not start work.";

export const REPO_MODE_OFF_REASON = "repository mode is off";
export const REPO_MODE_REVIEW_ONLY_REASON = "repository mode is review-only";

export type RepoSettingsParse = { ok: true; settings: RepoSettings } | { ok: false; error: string };

export const KNOWN_KEYS = new Set([
  "automerge",
  "automerge_label",
  "no_automerge_label",
  "allowed_runners",
  "timeouts",
  "review_exclude",
  "followup_on_suggestions",
  "max_followup_rounds",
  "max_conflict_rounds",
  "takeover_authors",
  "ignore_conflicts_authors",
  "blocking_question_authors",
  "trusted_senders",
  "followup_ignore_logins",
  "ignore_conflicts_label",
  "pickup_label",
  "mode",
]);

/** Repository timeout keys: `followup` controls `follow-up` jobs. Values are whole minutes. */
export const TIMEOUT_KEYS = ["review", "implement", "followup", "conflict"] as const;
export type RepoTimeoutKey = (typeof TIMEOUT_KEYS)[number];

/** Documented minimum for every repository timeout: 1 minute. Below this the file is invalid. */
export const MIN_TIMEOUT_MINUTES = 1;

export const TIMEOUT_LEASE_BUFFER_MS = 10 * 60 * 1000;

/** Default per-issue auto-merge opt-in label. Repository `.jumi.yml` may rename it. */
export const DEFAULT_AUTOMERGE_LABEL = "automerge";
/** Default per-issue auto-merge opt-out label. Repository `.jumi.yml` may rename it. */
export const DEFAULT_NO_AUTOMERGE_LABEL = "no-automerge";
/** Default GitHub pickup label. Repository `.jumi.yml` may rename it with `pickup_label`. Gitea ignores it. */
export const DEFAULT_PICKUP_LABEL = "jumi";
/** Default ignore-conflicts label. Repository `.jumi.yml` may rename it with `ignore_conflicts_label`. */
export const DEFAULT_IGNORE_CONFLICTS_LABEL = "ignore-conflicts";

/** Default settings: every site that needs default values uses this. */
function defaultRepoSettings(): RepoSettings {
  return {
    automerge: false,
    automergeLabel: DEFAULT_AUTOMERGE_LABEL,
    noAutomergeLabel: DEFAULT_NO_AUTOMERGE_LABEL,
    timeouts: {},
    allowedRunners: undefined,
    reviewExclude: [],
    followupOnSuggestions: true,
    takeoverAuthors: [],
    ignoreConflictsAuthors: [],
    blockingQuestionAuthors: [],
    trustedSenders: undefined,
    followupIgnoreLogins: undefined,
    ignoreConflictsLabel: undefined,
    pickupLabel: undefined,
    mode: "full",
  };
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
function unknownKeyError(key: string, known: readonly string[], prefix = ""): string {
  const normalized = normalizeKey(key);
  const canonical = known.find((candidate) => candidate === normalized);
  const shown = prefix ? `${prefix}.${key}` : key;
  if (canonical && canonical !== key) {
    const suggestion = prefix ? `${prefix}.${canonical}` : canonical;
    return `unknown key "${shown}" (did you mean "${suggestion}"?)`;
  }
  return `unknown key "${shown}"`;
}

type TimeoutsParse = { ok: true; timeouts: RepoTimeouts } | { ok: false; error: string };

function parseTimeoutsValue(value: unknown): TimeoutsParse {
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

function parserErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const single = message.replace(/\s+/g, " ").trim();
  return single.length > 500 ? `${single.slice(0, 497)}...` : single || "could not be parsed";
}

/**
 * Parse raw `.jumi.yml` text. Absent `automerge` (or `false`) means off;
 * absent `automerge_label` means `automerge`; absent `no_automerge_label`
 * means `no-automerge`; a blank, non-string, or identical (case-insensitive)
 * label pair makes the whole file invalid;
 * absent `allowed_runners` means no runner restriction (an explicitly empty
 * list is invalid: no runner could work on the repository, so use
 * `mode: off` or `mode: review-only` instead);
 * absent `review_exclude` means nothing is left out; absent author lists
 * mean empty; absent `mode` means `full`. No schema-version key exists. The
 * error string is the parser's error and is surfaced verbatim in the
 * auto-merge note and the review status. Each key has exactly one spelling
 * (snake_case); an unknown key that normalizes to a known key names the
 * known key as a suggestion. Author lists match whole logins,
 * case-insensitive. Every list key rejects blank or non-string entries:
 * a blank entry makes the whole file invalid instead of being dropped.
 * `followup_on_suggestions` absent means on: a `success` review with
 * suggestions follows up as today; `false` turns that off while failures,
 * blocking questions, red CI, and conflicts run as today.
 * `max_followup_rounds` / `max_conflict_rounds` absent mean the deployment
 * value; `0` is valid and means no rounds of that kind. Absent `timeouts`
 * (or an empty mapping) means no timeout overrides; each present key is
 * whole minutes for that kind (`followup` controls `follow-up` jobs). A
 * value above the deployer maximum runs with the maximum; a value below
 * the documented minimum makes the whole file invalid. Absent
 * `blocking_question_authors` means no repo-listed authors.
 * Absent `trusted_senders` means no repository list (the deployment list or
 * write access decides); a present list narrows a set deployment list
 * (intersection) and never widens it, and an explicitly empty list makes the
 * whole file invalid. Absent `followup_ignore_logins` means no extra
 * ignores (union with the deployment list). Absent `ignore_conflicts_label`
 * means the deployment value; absent `pickup_label` means `jumi` (Gitea
 * ignores it). `mode` must be
 * `full`, `review-only`, or `off` when present.
 */
export function parseRepoSettingsText(text: string): RepoSettingsParse {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    return { ok: false, error: parserErrorMessage(err) };
  }
  if (parsed === null || parsed === undefined) return { ok: true, settings: defaultRepoSettings() };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "top-level value must be a mapping" };
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key)) return { ok: false, error: unknownKeyError(key, [...KNOWN_KEYS]) };
  }
  const record = parsed as Record<string, unknown>;
  let automerge = false;
  if ("automerge" in record && record.automerge !== undefined) {
    if (typeof record.automerge !== "boolean") return { ok: false, error: `"automerge" must be a boolean` };
    automerge = record.automerge;
  }
  let timeouts: RepoTimeouts = {};
  if ("timeouts" in record && record.timeouts !== undefined) {
    const timeoutsParsed = parseTimeoutsValue(record.timeouts);
    if (!timeoutsParsed.ok) return timeoutsParsed;
    timeouts = timeoutsParsed.timeouts;
  }
  let allowedRunners: string[] | undefined;
  if ("allowed_runners" in record && record.allowed_runners !== undefined) {
    const parsed = parseStringList(record.allowed_runners, "allowed_runners", {
      notListError: `"allowed_runners" must be a list of runner names`,
    });
    if (!parsed.ok) return parsed;
    if (parsed.values.length === 0) {
      return {
        ok: false,
        error: `"allowed_runners" is empty, so no runner could work on the repository; use mode: off or mode: review-only`,
      };
    }
    allowedRunners = parsed.values;
  }
  let reviewExclude: string[] = [];
  if ("review_exclude" in record && record.review_exclude !== undefined) {
    const parsed = parseStringList(record.review_exclude, "review_exclude", {
      notListError: `"review_exclude" must be a list of glob strings`,
      dedupe: false,
    });
    if (!parsed.ok) return parsed;
    reviewExclude = parsed.values;
  }
  if (
    "followup_on_suggestions" in record &&
    record.followup_on_suggestions !== undefined &&
    typeof record.followup_on_suggestions !== "boolean"
  )
    return { ok: false, error: `"followup_on_suggestions" must be a boolean` };
  for (const key of ["max_followup_rounds", "max_conflict_rounds"] as const) {
    if (key in record && record[key] !== undefined) {
      const value = record[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        return { ok: false, error: `"${key}" must be a non-negative integer` };
    }
  }
  const takeover = parseAuthorList(record, "takeover_authors");
  if (!takeover.ok) return takeover;
  const ignoreConflicts = parseAuthorList(record, "ignore_conflicts_authors");
  if (!ignoreConflicts.ok) return ignoreConflicts;
  let automergeLabel = DEFAULT_AUTOMERGE_LABEL;
  if ("automerge_label" in record && record.automerge_label !== undefined) {
    if (typeof record.automerge_label !== "string" || !record.automerge_label.trim()) {
      return { ok: false, error: `"automerge_label" must be a non-blank string` };
    }
    automergeLabel = record.automerge_label.trim();
  }
  let noAutomergeLabel = DEFAULT_NO_AUTOMERGE_LABEL;
  if ("no_automerge_label" in record && record.no_automerge_label !== undefined) {
    if (typeof record.no_automerge_label !== "string" || !record.no_automerge_label.trim()) {
      return { ok: false, error: `"no_automerge_label" must be a non-blank string` };
    }
    noAutomergeLabel = record.no_automerge_label.trim();
  }
  if (automergeLabel.toLowerCase() === noAutomergeLabel.toLowerCase()) {
    return { ok: false, error: `"automerge_label" and "no_automerge_label" must be different` };
  }
  let blockingQuestionAuthors: string[] = [];
  if ("blocking_question_authors" in record && record.blocking_question_authors !== undefined) {
    const parsed = parseStringList(record.blocking_question_authors, "blocking_question_authors", {
      notListError: `"blocking_question_authors" must be a list of logins`,
    });
    if (!parsed.ok) return parsed;
    blockingQuestionAuthors = parsed.values;
  }
  let trustedSenders: string[] | undefined;
  if ("trusted_senders" in record && record.trusted_senders !== undefined) {
    const parsed = parseStringList(record.trusted_senders, "trusted_senders", {
      notListError: `"trusted_senders" must be a list of logins`,
    });
    if (!parsed.ok) return parsed;
    if (parsed.values.length === 0) {
      return {
        ok: false,
        error: `"trusted_senders" is empty, so no sender could work on the repository; use mode: off or mode: review-only`,
      };
    }
    trustedSenders = parsed.values;
  }
  let followupIgnoreLogins: string[] | undefined;
  if ("followup_ignore_logins" in record && record.followup_ignore_logins !== undefined) {
    const parsed = parseStringList(record.followup_ignore_logins, "followup_ignore_logins", {
      notListError: `"followup_ignore_logins" must be a list of logins`,
    });
    if (!parsed.ok) return parsed;
    followupIgnoreLogins = parsed.values;
  }
  let ignoreConflictsLabel: string | undefined;
  if ("ignore_conflicts_label" in record && record.ignore_conflicts_label !== undefined) {
    if (typeof record.ignore_conflicts_label !== "string" || !record.ignore_conflicts_label.trim()) {
      return { ok: false, error: `"ignore_conflicts_label" must be a non-blank string` };
    }
    ignoreConflictsLabel = record.ignore_conflicts_label.trim();
  }
  let pickupLabel: string | undefined;
  if ("pickup_label" in record && record.pickup_label !== undefined) {
    if (typeof record.pickup_label !== "string" || !record.pickup_label.trim()) {
      return { ok: false, error: `"pickup_label" must be a non-blank string` };
    }
    pickupLabel = record.pickup_label.trim();
  }
  let mode: RepoMode = "full";
  if ("mode" in record && record.mode !== undefined) {
    if (typeof record.mode !== "string" || !(REPO_MODES as readonly string[]).includes(record.mode)) {
      return { ok: false, error: `"mode" must be one of "full", "review-only", "off"` };
    }
    mode = record.mode as RepoMode;
  }
  const settings: RepoSettings = {
    automerge,
    automergeLabel,
    noAutomergeLabel,
    timeouts,
    allowedRunners,
    reviewExclude,
    followupOnSuggestions:
      "followup_on_suggestions" in record && record.followup_on_suggestions !== undefined
        ? record.followup_on_suggestions === true
        : true,
    takeoverAuthors: takeover.authors,
    ignoreConflictsAuthors: ignoreConflicts.authors,
    blockingQuestionAuthors,
    trustedSenders,
    followupIgnoreLogins,
    ...(ignoreConflictsLabel !== undefined ? { ignoreConflictsLabel } : {}),
    ...(pickupLabel !== undefined ? { pickupLabel } : {}),
    mode,
  };
  if ("max_followup_rounds" in record && record.max_followup_rounds !== undefined)
    settings.maxFollowupRounds = record.max_followup_rounds as number;
  if ("max_conflict_rounds" in record && record.max_conflict_rounds !== undefined)
    settings.maxConflictRounds = record.max_conflict_rounds as number;
  return { ok: true, settings };
}

/**
 * Parse one list-of-strings setting. A non-list value keeps the caller's
 * `notListError`; a blank or non-string entry makes the whole file invalid.
 * Duplicates are dropped (unless `dedupe: false`), never an error.
 */
function parseStringList(
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

function parseAuthorList(
  record: Record<string, unknown>,
  key: string
): { ok: true; authors: string[] } | { ok: false; error: string } {
  if (!(key in record) || record[key] === undefined) return { ok: true, authors: [] };
  const parsed = parseStringList(record[key], key, { notListError: `"${key}" must be a list of logins` });
  if (!parsed.ok) return parsed;
  return { ok: true, authors: parsed.values };
}

export type RepoSettingsLoad =
  | { state: "missing" }
  | {
      state: "valid";
      automerge: boolean;
      automergeLabel: string;
      noAutomergeLabel: string;
      timeouts: RepoTimeouts;
      allowedRunners?: string[];
      reviewExclude: string[];
      followupOnSuggestions: boolean;
      maxFollowupRounds?: number;
      maxConflictRounds?: number;
      takeoverAuthors: string[];
      ignoreConflictsAuthors: string[];
      blockingQuestionAuthors: string[];
      trustedSenders?: string[];
      followupIgnoreLogins?: string[];
      ignoreConflictsLabel?: string;
      pickupLabel?: string;
      mode: RepoMode;
    }
  | { state: "invalid"; error: string };

/** Ledger kind to repository timeout key: `follow-up` reads `followup`. */
export function timeoutKeyForKind(kind: string): RepoTimeoutKey | undefined {
  if (kind === "follow-up") return "followup";
  if ((TIMEOUT_KEYS as readonly string[]).includes(kind)) return kind as RepoTimeoutKey;
  return undefined;
}

/**
 * Effective run timeout for one kind. Missing settings, a missing key, or an
 * invalid file runs with the deployment default (`baseMs`). A value above
 * the deployer maximum (`maxMs`) is applied as the maximum. Unset, the
 * maximum is the deployment timeout itself, so a repository can only shorten.
 */
export function effectiveTimeoutMsForKind(load: RepoSettingsLoad, kind: string, baseMs: number, maxMs: number): number {
  if (load.state !== "valid") return baseMs;
  const key = timeoutKeyForKind(kind);
  if (!key) return baseMs;
  const minutes = load.timeouts[key];
  if (minutes === undefined) return baseMs;
  const wanted = minutes * 60 * 1000;
  const cap = maxMs > 0 ? maxMs : baseMs;
  return Math.min(wanted, cap);
}

/**
 * Queue lease that covers the effective timeout. The buffer is the
 * deployment's 10-minute reclaim margin: the effective lease never drops
 * below the configured `LEASE_MS`, and grows past it when a longer repository
 * timeout needs it, so a job allowed to run longer is not reclaimed halfway.
 */
export function effectiveLeaseMs(configLeaseMs: number, effectiveTimeoutMs: number): number {
  return Math.max(configLeaseMs, effectiveTimeoutMs + TIMEOUT_LEASE_BUFFER_MS);
}

export interface RepoSettingsFileApi {
  getRepoFile?(owner: string, repo: string, path: string, ref: string): Promise<{ found: boolean; content?: string }>;
  getRepo?(owner: string, repo: string): Promise<{ default_branch?: string }>;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /→ 404\b/.test(err.message);
}

/**
 * Load the settings file at a ref (a default-branch name for scheduling, a
 * head SHA for review). Missing (or no file API) is `{state:"missing"}`.
 * Reads that fail for another reason throw so the caller can fail closed.
 */
export async function loadRepoSettings(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  ref: string
): Promise<RepoSettingsLoad> {
  const getFile = api.getRepoFile;
  if (typeof getFile !== "function") return { state: "missing" };
  let file: { found: boolean; content?: string };
  try {
    file = await getFile.call(api, owner, repo, REPO_SETTINGS_PATH, ref);
  } catch (err) {
    if (isNotFoundError(err)) return { state: "missing" };
    throw err;
  }
  if (file.found !== true || typeof file.content !== "string") return { state: "missing" };
  const parsed = parseRepoSettingsText(file.content);
  if (!parsed.ok) return { state: "invalid", error: parsed.error };
  return {
    state: "valid",
    automerge: parsed.settings.automerge,
    automergeLabel: parsed.settings.automergeLabel,
    noAutomergeLabel: parsed.settings.noAutomergeLabel,
    timeouts: parsed.settings.timeouts,
    allowedRunners: parsed.settings.allowedRunners,
    reviewExclude: parsed.settings.reviewExclude,
    followupOnSuggestions: parsed.settings.followupOnSuggestions,
    ...(parsed.settings.maxFollowupRounds !== undefined
      ? { maxFollowupRounds: parsed.settings.maxFollowupRounds }
      : {}),
    ...(parsed.settings.maxConflictRounds !== undefined
      ? { maxConflictRounds: parsed.settings.maxConflictRounds }
      : {}),
    takeoverAuthors: parsed.settings.takeoverAuthors,
    ignoreConflictsAuthors: parsed.settings.ignoreConflictsAuthors,
    blockingQuestionAuthors: parsed.settings.blockingQuestionAuthors,
    trustedSenders: parsed.settings.trustedSenders,
    followupIgnoreLogins: parsed.settings.followupIgnoreLogins,
    ...(parsed.settings.ignoreConflictsLabel !== undefined
      ? { ignoreConflictsLabel: parsed.settings.ignoreConflictsLabel }
      : {}),
    ...(parsed.settings.pickupLabel !== undefined ? { pickupLabel: parsed.settings.pickupLabel } : {}),
    mode: parsed.settings.mode,
  };
}

/**
 * Load the settings file once from the default branch. Never throws:
 * unreadable stays `{state:"missing"}` so the caller runs with deployment
 * defaults. Resolves the default branch via `getRepo` when no hint is
 * given (review jobs); worker jobs pass `job.defaultBranch` directly.
 */
export async function loadDefaultBranchSettings(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string | undefined,
  log?: (message: string) => void
): Promise<{ load: RepoSettingsLoad; ref: string | undefined }> {
  let ref = defaultBranch;
  if (!ref) {
    try {
      const getRepo = api.getRepo;
      if (typeof getRepo !== "function") return { load: { state: "missing" }, ref: undefined };
      const info = await getRepo.call(api, owner, repo);
      ref = info?.default_branch;
    } catch (err) {
      log?.(`settings timeouts unreadable for ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`);
      return { load: { state: "missing" }, ref: undefined };
    }
    if (!ref) return { load: { state: "missing" }, ref: undefined };
  }
  try {
    const load = await loadRepoSettings(api, owner, repo, ref);
    if (load.state === "invalid") {
      log?.(`settings timeouts invalid for ${owner}/${repo}@${ref}: ${load.error}`);
    }
    return { load, ref };
  } catch (err) {
    log?.(
      `settings timeouts unreadable for ${owner}/${repo}@${ref}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { load: { state: "missing" }, ref };
  }
}

/**
 * Repository mode from a loaded settings file. Missing or invalid files are
 * today's behavior (`full`): this setting adds no new invalid-file rule, and
 * an unreadable file also falls back to `full` via the loaders below.
 */
export function repoMode(settings: RepoSettingsLoad): RepoMode {
  if (settings.state !== "valid") return "full";
  return settings.mode;
}

/**
 * Load the mode at a default-branch ref. Missing, invalid, or unreadable
 * files fall back to `full` so one repository's file never changes another
 * repository. Never throws.
 */
export async function loadRepoMode(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  log?: (message: string) => void
): Promise<RepoMode> {
  if (!defaultBranch.trim()) return "full";
  let settings: RepoSettingsLoad;
  try {
    settings = await loadRepoSettings(api, owner, repo, defaultBranch);
  } catch (err) {
    log?.(
      `mode settings unreadable for ${owner}/${repo}@${defaultBranch}: ${err instanceof Error ? err.message : String(err)}`
    );
    return "full";
  }
  if (settings.state === "invalid") {
    log?.(`mode settings invalid for ${owner}/${repo}@${defaultBranch}: ${settings.error}`);
    return "full";
  }
  return repoMode(settings);
}

export interface RepoModeRepoApi extends RepoSettingsFileApi {
  getRepo?(owner: string, repo: string): Promise<{ default_branch: string }>;
}

/**
 * Resolve the mode via the repository's default branch. Missing, invalid,
 * unreadable, or branchless repositories fall back to `full`. Never throws.
 */
export async function resolveRepoMode(
  api: RepoModeRepoApi,
  owner: string,
  repo: string,
  log?: (message: string) => void
): Promise<RepoMode> {
  try {
    const getRepo = api.getRepo;
    if (typeof getRepo !== "function") return "full";
    const info = await getRepo.call(api, owner, repo);
    const defaultBranch = info.default_branch?.trim() ? info.default_branch : "";
    if (!defaultBranch) return "full";
    return await loadRepoMode(api, owner, repo, defaultBranch, log);
  } catch (err) {
    log?.(`mode settings unreadable for ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`);
    return "full";
  }
}

/**
 * Follow-up policy from a loaded settings file. Missing or invalid behaves
 * as today: suggestions still follow up and both caps stay at the
 * deployment values. A higher file value never exceeds the deployment
 * ceiling; zero is valid and means no rounds of that kind.
 */
export function effectiveFollowupRounds(deploymentMax: number, load: RepoSettingsLoad): number {
  if (load.state === "valid" && load.maxFollowupRounds !== undefined)
    return Math.min(deploymentMax, load.maxFollowupRounds);
  return deploymentMax;
}

export function effectiveConflictRounds(deploymentMax: number, load: RepoSettingsLoad): number {
  if (load.state === "valid" && load.maxConflictRounds !== undefined)
    return Math.min(deploymentMax, load.maxConflictRounds);
  return deploymentMax;
}

export function isSuggestionFollowupEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return true;
  return load.followupOnSuggestions !== false;
}

export interface RepoFollowupPolicy {
  followupOnSuggestions: boolean;
  maxFollowupRounds: number;
  maxConflictRounds: number;
}

/**
 * Load the follow-up policy from the default branch. Fail-open: missing,
 * invalid, unreadable, or no file API behaves as today (deployment caps,
 * suggestions on) and never throws. Callers that need fail-closed (auto-
 * merge) keep using `loadRepoSettings` directly.
 */
export async function loadRepoFollowupPolicy(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  deployment: { maxFollowupRounds: number; maxConflictRounds: number },
  log?: (message: string) => void
): Promise<RepoFollowupPolicy> {
  const fallback: RepoFollowupPolicy = {
    followupOnSuggestions: true,
    maxFollowupRounds: deployment.maxFollowupRounds,
    maxConflictRounds: deployment.maxConflictRounds,
  };
  try {
    const load = await loadRepoSettings(api, owner, repo, defaultBranch);
    return {
      followupOnSuggestions: isSuggestionFollowupEnabled(load),
      maxFollowupRounds: effectiveFollowupRounds(deployment.maxFollowupRounds, load),
      maxConflictRounds: effectiveConflictRounds(deployment.maxConflictRounds, load),
    };
  } catch (err) {
    log?.(
      `follow-up settings unreadable for ${owner}/${repo}@${defaultBranch}: ${err instanceof Error ? err.message : String(err)}`
    );
    return fallback;
  }
}

/**
 * Effective blocking-question authors for a repository: the deployer's list
 * plus the repository file's list. The file cannot remove a login the
 * deployer listed; matching stays case-insensitive whole-login. Invalid or
 * missing files contribute nothing (the deployer list still applies).
 */
export function effectiveBlockingQuestionAuthors(
  deployerAuthors: readonly string[] | undefined | null,
  settings: RepoSettingsLoad
): string[] {
  const merged = [...(deployerAuthors ?? [])];
  const seen = new Set(merged.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  if (settings.state === "valid") {
    for (const entry of settings.blockingQuestionAuthors) {
      const key = entry.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(entry.trim());
    }
  }
  return merged;
}

/**
 * Load the default-branch settings file and merge its
 * `blocking_question_authors` with the deployer list. Missing, invalid, or
 * unreadable files fall back to the deployer list so one repository's file
 * never changes another repository. Never throws.
 */
export async function loadEffectiveBlockingQuestionAuthors(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  deployerAuthors: readonly string[] | undefined | null,
  log?: (message: string) => void
): Promise<string[]> {
  if (!defaultBranch.trim()) return [...(deployerAuthors ?? [])];
  let settings: RepoSettingsLoad;
  try {
    settings = await loadRepoSettings(api, owner, repo, defaultBranch);
  } catch (err) {
    log?.(
      `blocking settings unreadable for ${owner}/${repo}@${defaultBranch}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [...(deployerAuthors ?? [])];
  }
  if (settings.state === "invalid") {
    log?.(`blocking settings invalid for ${owner}/${repo}@${defaultBranch}: ${settings.error}`);
    return [...(deployerAuthors ?? [])];
  }
  return effectiveBlockingQuestionAuthors(deployerAuthors, settings);
}

/**
 * Effective trusted senders for a repository. When the deployment list is
 * set, the effective list is the intersection: a repository can narrow it,
 * never widen it. When the deployment leaves it unset, the repository list
 * is the list (listing is the admit, same as the env list today). Neither
 * set means no list (write-access fallback). Invalid, missing, or unreadable
 * files fall back to the deployment list, so an invalid file never widens
 * access. Matching stays case-insensitive whole-login at the check site.
 */
export function effectiveTrustedSenderLogins(
  deployerLogins: readonly string[] | undefined | null,
  settings: RepoSettingsLoad
): readonly string[] | undefined {
  const deployer = [...(deployerLogins ?? [])].filter((entry) => entry.trim() !== "");
  const hasDeployer = deployer.some((entry) => entry.trim() !== "");
  if (settings.state !== "valid" || settings.trustedSenders === undefined) {
    return hasDeployer ? deployer : undefined;
  }
  const repo = settings.trustedSenders;
  if (!hasDeployer) return [...repo];
  const deployerKeys = new Set(deployer.map((entry) => entry.trim().toLowerCase()));
  return repo.filter((entry) => deployerKeys.has(entry.trim().toLowerCase()));
}

/**
 * Load the default-branch settings file and intersect its `trusted_senders`
 * with the deployer list. Missing, invalid, or unreadable files fall back to
 * the deployer list so one repository's file never widens access. Never
 * throws.
 */
export async function loadEffectiveTrustedSenderLogins(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  deployerLogins: readonly string[] | undefined | null,
  log?: (message: string) => void
): Promise<readonly string[] | undefined> {
  if (!defaultBranch.trim())
    return (deployerLogins ?? []).some((entry) => entry.trim() !== "") ? [...(deployerLogins ?? [])] : undefined;
  let settings: RepoSettingsLoad;
  try {
    settings = await loadRepoSettings(api, owner, repo, defaultBranch);
  } catch (err) {
    log?.(
      `trusted sender settings unreadable for ${owner}/${repo}@${defaultBranch}: ${err instanceof Error ? err.message : String(err)}`
    );
    const deployer = [...(deployerLogins ?? [])].filter((entry) => entry.trim() !== "");
    return deployer.length > 0 ? deployer : undefined;
  }
  if (settings.state === "invalid") {
    log?.(`trusted sender settings invalid for ${owner}/${repo}@${defaultBranch}: ${settings.error}`);
    const deployer = [...(deployerLogins ?? [])].filter((entry) => entry.trim() !== "");
    return deployer.length > 0 ? deployer : undefined;
  }
  return effectiveTrustedSenderLogins(deployerLogins, settings);
}

/**
 * Effective follow-up ignore logins for a repository: the deployer's list
 * plus the repository file's list. The file cannot remove a login the
 * deployer listed, the same rule as `blocking_question_authors`. Invalid or
 * missing files contribute nothing (the deployer list still applies).
 */
export function effectiveFollowupIgnoreLogins(
  deployerLogins: readonly string[] | undefined | null,
  settings: RepoSettingsLoad
): string[] {
  const merged = [...(deployerLogins ?? [])];
  const seen = new Set(merged.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  if (settings.state === "valid") {
    for (const entry of settings.followupIgnoreLogins ?? []) {
      const key = entry.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(entry.trim());
    }
  }
  return merged;
}

/**
 * Load the default-branch settings file and merge its
 * `followup_ignore_logins` with the deployer list. Missing, invalid, or
 * unreadable files fall back to the deployer list. Never throws.
 */
export async function loadEffectiveFollowupIgnoreLogins(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  deployerLogins: readonly string[] | undefined | null,
  log?: (message: string) => void
): Promise<string[]> {
  if (!defaultBranch.trim()) return [...(deployerLogins ?? [])];
  let settings: RepoSettingsLoad;
  try {
    settings = await loadRepoSettings(api, owner, repo, defaultBranch);
  } catch (err) {
    log?.(
      `followup ignore settings unreadable for ${owner}/${repo}@${defaultBranch}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [...(deployerLogins ?? [])];
  }
  if (settings.state === "invalid") {
    log?.(`followup ignore settings invalid for ${owner}/${repo}@${defaultBranch}: ${settings.error}`);
    return [...(deployerLogins ?? [])];
  }
  return effectiveFollowupIgnoreLogins(deployerLogins, settings);
}

/**
 * Effective ignore-conflicts label for a repository: the file's
 * `ignore_conflicts_label` when present, otherwise the deployment value.
 * Missing, invalid, or unreadable files fall back to the deployment value.
 */
export function effectiveIgnoreConflictsLabel(
  deployerLabel: string | undefined | null,
  settings: RepoSettingsLoad
): string {
  const fallback = (deployerLabel ?? "").trim() ? (deployerLabel as string).trim() : DEFAULT_IGNORE_CONFLICTS_LABEL;
  if (settings.state !== "valid" || !settings.ignoreConflictsLabel) return fallback;
  return settings.ignoreConflictsLabel;
}

/**
 * Load the default-branch settings file and resolve its
 * `ignore_conflicts_label` against the deployment value. Missing, invalid, or
 * unreadable files fall back to the deployment value. Never throws.
 */
export async function loadEffectiveIgnoreConflictsLabel(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  deployerLabel: string | undefined | null,
  log?: (message: string) => void
): Promise<string> {
  const fallback = (deployerLabel ?? "").trim() ? (deployerLabel as string).trim() : DEFAULT_IGNORE_CONFLICTS_LABEL;
  if (!defaultBranch.trim()) return fallback;
  try {
    const settings = await loadRepoSettings(api, owner, repo, defaultBranch);
    if (settings.state !== "valid") {
      if (settings.state === "invalid")
        log?.(`ignore-conflicts label settings invalid for ${owner}/${repo}@${defaultBranch}: ${settings.error}`);
      return fallback;
    }
    return effectiveIgnoreConflictsLabel(deployerLabel, settings);
  } catch (err) {
    log?.(
      `ignore-conflicts label settings unreadable for ${owner}/${repo}@${defaultBranch}: ${err instanceof Error ? err.message : String(err)}`
    );
    return fallback;
  }
}

/**
 * Effective GitHub pickup label for a repository: the file's `pickup_label`
 * when present, otherwise `jumi`. Missing, invalid, or unreadable files fall
 * back to `jumi`. Gitea ignores the key and keeps using assignment.
 */
export function effectivePickupLabel(settings: RepoSettingsLoad): string {
  if (settings.state !== "valid" || !settings.pickupLabel) return DEFAULT_PICKUP_LABEL;
  return settings.pickupLabel;
}

/**
 * Load the default-branch settings file and resolve its `pickup_label`.
 * Missing, invalid, or unreadable files fall back to `jumi`. Never throws.
 */
export async function loadEffectivePickupLabel(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  log?: (message: string) => void
): Promise<string> {
  if (!defaultBranch.trim()) return DEFAULT_PICKUP_LABEL;
  try {
    const settings = await loadRepoSettings(api, owner, repo, defaultBranch);
    if (settings.state === "invalid") {
      log?.(`pickup label settings invalid for ${owner}/${repo}@${defaultBranch}: ${settings.error}`);
      return DEFAULT_PICKUP_LABEL;
    }
    return effectivePickupLabel(settings);
  } catch (err) {
    log?.(
      `pickup label settings unreadable for ${owner}/${repo}@${defaultBranch}: ${err instanceof Error ? err.message : String(err)}`
    );
    return DEFAULT_PICKUP_LABEL;
  }
}

function normalizePath(filename: string): string {
  return filename.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Whether any changed file is the root settings file. */
export function prTouchesRepoSettings(files: ReadonlyArray<{ filename: string }>): boolean {
  return files.some((file) => normalizePath(file.filename) === REPO_SETTINGS_PATH);
}

/** Failure text for an invalid default-branch settings file. Names the parser error. */
export function invalidRepoSettingsReason(error: string): string {
  return `${REPO_SETTINGS_PATH} is invalid: ${error}`;
}

/**
 * Fail-closed text when the repository's runner allow-list leaves no
 * eligible runner. Names the repository setting as the cause.
 */
export function noAllowedRunnerReason(owner: string, repo: string, allowed: readonly string[]): string {
  const listed = allowed.length > 0 ? allowed.join(", ") : "(empty list)";
  return (
    `repository settings left no eligible runner for ${owner}/${repo}: ` +
    `` +
    `allowed_runners [${listed}] matches no runner in the active chain`
  );
}

export interface NarrowedChain<T extends { name: string }> {
  /** Chain entries whose name is on the allow-list, in configured order. */
  chain: T[];
  /** Allow-list names that match no chain entry. Never an error. */
  unknownNames: string[];
}

/**
 * Narrowing only: keep the chain entries whose name is on the repository
 * allow-list, preserving configured order. `undefined` (key absent) keeps
 * the full chain. Names outside the active chain grant nothing; they are
 * reported via `log` and otherwise ignored.
 */
export function narrowChainForRepo<T extends { name: string }>(
  chain: readonly T[],
  allowedRunners: readonly string[] | undefined,
  log?: (message: string) => void
): NarrowedChain<T> {
  if (allowedRunners === undefined) return { chain: [...chain], unknownNames: [] };
  const allowed = new Set(allowedRunners);
  const narrowed = chain.filter((entry) => allowed.has(entry.name));
  const chainNames = new Set(chain.map((entry) => entry.name));
  const unknownNames = [...allowed].filter((name) => !chainNames.has(name));
  if (unknownNames.length > 0) {
    log?.(`repository settings list unknown runner(s): ${unknownNames.join(", ")} (not in the active chain)`);
  }
  return { chain: narrowed, unknownNames };
}

export type RepoChainResolution<T extends { name: string }> =
  | { state: "unrestricted"; chain: T[] }
  | { state: "narrowed"; chain: T[]; unknownNames: string[] }
  | { state: "empty"; reason: string; unknownNames: string[] }
  | { state: "invalid"; reason: string };

/**
 * Resolve the effective chain for one repository job from the default-branch
 * settings. Missing (or no file API, or an empty ref) is unrestricted.
 * Reads that fail for another reason throw so the caller can log and fail
 * open; only an invalid file and an allow-list that matches nothing fail
 * closed here.
 */
export async function resolveRepoChain<T extends { name: string }>(opts: {
  api: RepoSettingsFileApi;
  owner: string;
  repo: string;
  defaultBranch: string;
  chain: readonly T[] | undefined;
  log?: (message: string) => void;
}): Promise<RepoChainResolution<T>> {
  const base = opts.chain ? [...opts.chain] : [];
  if (!opts.defaultBranch.trim()) return { state: "unrestricted", chain: base };
  const settings = await loadRepoSettings(opts.api, opts.owner, opts.repo, opts.defaultBranch);
  if (settings.state === "missing") return { state: "unrestricted", chain: base };
  if (settings.state === "invalid") return { state: "invalid", reason: invalidRepoSettingsReason(settings.error) };
  if (settings.allowedRunners === undefined) return { state: "unrestricted", chain: base };
  const narrowed = narrowChainForRepo(base, settings.allowedRunners, opts.log);
  if (narrowed.chain.length === 0) {
    return {
      state: "empty",
      reason: noAllowedRunnerReason(opts.owner, opts.repo, settings.allowedRunners),
      unknownNames: narrowed.unknownNames,
    };
  }
  return { state: "narrowed", chain: narrowed.chain, unknownNames: narrowed.unknownNames };
}

export type RepoChainApply<T> =
  | { failedClosed: false; chain: T[] | undefined; narrowed: boolean }
  | { failedClosed: true; reason: string };

/**
 * Shared resolve→log→publish→return step for every job that runs on a
 * runner chain. `resolveRepoChain` runs inside the `try` (unreadable fails
 * open with a log); the `invalid`/`empty` publish runs after the `catch` so
 * a publish failure propagates instead of continuing on the full chain.
 * The caller passes its own `publish` (review status, worker comment, PR
 * sticky) and returns `skipped` when `failedClosed` is true.
 */
export async function applyRepoChain<T extends { name: string }>(opts: {
  api: RepoSettingsFileApi;
  owner: string;
  repo: string;
  defaultBranch: string;
  chain: readonly T[] | undefined;
  log?: (message: string) => void;
  /** Extra diagnostic fields, e.g. `{ review: "o/r#7", head }` or `{ job: "o/r#7", head }`. */
  diagBase?: Record<string, string | null | undefined>;
  /** Log context for the fail-open unreadable line. Defaults to `owner/repo`. */
  unreadableContext?: string;
  publish: (reason: string) => Promise<void>;
}): Promise<RepoChainApply<T>> {
  const base = opts.chain ? [...opts.chain] : undefined;
  if (!opts.chain || opts.chain.length === 0) return { failedClosed: false, chain: base, narrowed: false };
  let resolution: RepoChainResolution<T>;
  try {
    resolution = await resolveRepoChain({
      api: opts.api,
      owner: opts.owner,
      repo: opts.repo,
      defaultBranch: opts.defaultBranch,
      chain: opts.chain,
      log: opts.log,
    });
  } catch (err) {
    const context = opts.unreadableContext ?? `${opts.owner}/${opts.repo}`;
    opts.log?.(`runner settings unreadable for ${context}: ${err instanceof Error ? err.message : String(err)}`);
    return { failedClosed: false, chain: base, narrowed: false };
  }
  if (resolution.state === "invalid" || resolution.state === "empty") {
    if (opts.log) {
      logDiagnostic(opts.log, "repo_settings", {
        ...(opts.diagBase ?? {}),
        state: resolution.state,
        reason: resolution.reason,
      });
    }
    await opts.publish(resolution.reason);
    return { failedClosed: true, reason: resolution.reason };
  }
  if (resolution.state === "narrowed") {
    if (opts.log) {
      logDiagnostic(opts.log, "repo_settings", {
        ...(opts.diagBase ?? {}),
        state: "narrowed",
        eligible: resolution.chain.map((runner) => runner.name).join(",") || null,
      });
    }
    return { failedClosed: false, chain: resolution.chain, narrowed: true };
  }
  return { failedClosed: false, chain: base, narrowed: false };
}
/**
 * Compile `review_exclude` patterns to matchers over repository-relative
 * file paths. Uses the same gitignore-style glob dialect as `REVIEW.md`
 * path sections (`globToRegExp`). An invalid glob never matches: the
 * repository still reviews in full instead of failing the review.
 */
export function compileReviewExcludePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      out.push(globToRegExp(pattern));
    } catch {}
  }
  return out;
}

/** True when this repository-relative path is left out of the review. */
export function isReviewExcluded(filename: string, compiled: readonly RegExp[]): boolean {
  if (compiled.length === 0) return false;
  const normalized = normalizePath(filename);
  if (normalized === REPO_SETTINGS_PATH) return false;
  return compiled.some((matcher) => matcher.test(normalized));
}

/** Split changed files into reviewed and left-out sets. The settings file itself is never left out. */
export function partitionReviewExcludedFiles<T extends { filename: string }>(
  files: readonly T[],
  compiled: readonly RegExp[]
): { included: T[]; excluded: T[] } {
  const included: T[] = [];
  const excluded: T[] = [];
  for (const file of files) {
    if (isReviewExcluded(file.filename, compiled)) excluded.push(file);
    else included.push(file);
  }
  return { included, excluded };
}
