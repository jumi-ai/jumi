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

export const REPO_SETTINGS_PATH = ".jumi.yml";

export interface RepoTimeouts {
  review?: number;
  implement?: number;
  followup?: number;
  conflict?: number;
}

export interface RepoSettings {
  automerge: boolean;
  timeouts: RepoTimeouts;
  takeoverAuthors: string[];
  ignoreConflictsAuthors: string[];
  /** PR-author logins whose open ❓ questions block the review status in this repository. */
  blockingQuestionAuthors: string[];
}

export type RepoSettingsParse = { ok: true; settings: RepoSettings } | { ok: false; error: string };

const KNOWN_KEYS = new Set([
  "automerge",
  "timeouts",
  "takeover_authors",
  "takeover-authors",
  "takeoverAuthors",
  "ignore_conflicts_authors",
  "ignore-conflicts-authors",
  "ignoreConflictsAuthors",
  "blocking_question_authors",
]);

/** Repository timeout keys: `followup` controls `follow-up` jobs. Values are whole minutes. */
export const TIMEOUT_KEYS = ["review", "implement", "followup", "conflict"] as const;
export type RepoTimeoutKey = (typeof TIMEOUT_KEYS)[number];

/** Documented minimum for every repository timeout: 1 minute. Below this the file is invalid. */
export const MIN_TIMEOUT_MINUTES = 1;

export const TIMEOUT_LEASE_BUFFER_MS = 10 * 60 * 1000;

function parseTimeoutsValue(value: unknown): RepoSettingsParse {
  if (value === undefined)
    return {
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
      },
    };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `"timeouts" must be a mapping` };
  }
  const record = value as Record<string, unknown>;
  const timeouts: RepoTimeouts = {};
  for (const key of Object.keys(record)) {
    if (!(TIMEOUT_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown key "timeouts.${key}"` };
    }
    const minutes = record[key];
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_TIMEOUT_MINUTES) {
      return { ok: false, error: `"timeouts.${key}" must be an integer number of minutes >= ${MIN_TIMEOUT_MINUTES}` };
    }
    (timeouts as Record<string, number>)[key] = minutes;
  }
  return {
    ok: true,
    settings: {
      automerge: false,
      timeouts,
      takeoverAuthors: [],
      ignoreConflictsAuthors: [],
      blockingQuestionAuthors: [],
    },
  };
}

function parserErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const single = message.replace(/\s+/g, " ").trim();
  return single.length > 500 ? `${single.slice(0, 497)}...` : single || "could not be parsed";
}

/**
 * Parse raw `.jumi.yml` text. Absent `automerge` (or `false`) means off;
 * absent author lists mean empty; no schema-version key exists. The error
 * string is the parser's error and is surfaced verbatim in the auto-merge
 * note and the review status. Author lists match whole logins,
 * case-insensitive. Canonical keys are `takeover_authors` and
 * `ignore_conflicts_authors`; hyphen and camelCase spellings are accepted
 * as aliases for the same setting. `blocking_question_authors` must be a
 * list of login strings when present; blank entries are dropped like the
 * deployer CSV. Absent `timeouts` (or an empty mapping) means no timeout
 * overrides; each present key is whole minutes for that kind (`followup`
 * controls `follow-up` jobs). A value above the deployer maximum runs with
 * the maximum; a value below the documented minimum makes the whole file
 * invalid.
 */
export function parseRepoSettingsText(text: string): RepoSettingsParse {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    return { ok: false, error: parserErrorMessage(err) };
  }
  if (parsed === null || parsed === undefined)
    return {
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
      },
    };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "top-level value must be a mapping" };
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key)) return { ok: false, error: `unknown key "${key}"` };
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
    timeouts = timeoutsParsed.settings.timeouts;
  }
  const takeover = parseAuthorList(record, ["takeover_authors", "takeover-authors", "takeoverAuthors"]);
  if (!takeover.ok) return takeover;
  const ignoreConflicts = parseAuthorList(record, [
    "ignore_conflicts_authors",
    "ignore-conflicts-authors",
    "ignoreConflictsAuthors",
  ]);
  if (!ignoreConflicts.ok) return ignoreConflicts;
  let blockingQuestionAuthors: string[] = [];
  if ("blocking_question_authors" in record && record.blocking_question_authors !== undefined) {
    const value = record.blocking_question_authors;
    if (!Array.isArray(value)) return { ok: false, error: `"blocking_question_authors" must be a list of logins` };
    const logins: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string")
        return { ok: false, error: `"blocking_question_authors" must be a list of logins` };
      const trimmed = entry.trim();
      if (trimmed) logins.push(trimmed);
    }
    blockingQuestionAuthors = logins;
  }
  return {
    ok: true,
    settings: {
      automerge,
      timeouts,
      takeoverAuthors: takeover.authors,
      ignoreConflictsAuthors: ignoreConflicts.authors,
      blockingQuestionAuthors,
    },
  };
}

function canonicalKey(aliases: readonly string[]): string {
  return aliases[0] ?? "";
}

function parseAuthorList(
  record: Record<string, unknown>,
  aliases: readonly string[]
): { ok: true; authors: string[] } | { ok: false; error: string } {
  const present = aliases.filter((key) => key in record && (record as Record<string, unknown>)[key] !== undefined);
  if (present.length > 1) return { ok: false, error: `duplicate setting "${canonicalKey(aliases)}"` };
  const key = present[0];
  if (!key) return { ok: true, authors: [] };
  const value = (record as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return { ok: false, error: `"${canonicalKey(aliases)}" must be a list of logins` };
  const authors: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      return { ok: false, error: `"${canonicalKey(aliases)}" must be a list of logins` };
    }
    authors.push(entry.trim());
  }
  return { ok: true, authors };
}

export type RepoSettingsLoad =
  | { state: "missing" }
  | {
      state: "valid";
      automerge: boolean;
      timeouts: RepoTimeouts;
      takeoverAuthors: string[];
      ignoreConflictsAuthors: string[];
      blockingQuestionAuthors: string[];
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
    timeouts: parsed.settings.timeouts,
    takeoverAuthors: parsed.settings.takeoverAuthors,
    ignoreConflictsAuthors: parsed.settings.ignoreConflictsAuthors,
    blockingQuestionAuthors: parsed.settings.blockingQuestionAuthors,
  };
}

export interface DefaultBranchTimeouts {
  baseMs: number;
  maxMs: number;
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
 * Read the settings file once from the default branch when a job starts and
 * resolve the effective timeout for one kind. Never throws: an unreadable
 * file (or an unknown default branch) runs with the deployment default, and
 * an invalid file is never treated as "no file" for auto-merge but still
 * runs timeouts with the deployment default. Call once per job; a change
 * does not affect an already running job.
 */
export async function resolveEffectiveTimeoutMs(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  kind: string,
  defaultBranch: string | undefined,
  baseMs: number,
  maxMs: number,
  log?: (message: string) => void
): Promise<{ timeoutMs: number; load: RepoSettingsLoad }> {
  const { load } = await loadDefaultBranchSettings(api, owner, repo, defaultBranch, log);
  if (load.state !== "valid") return { timeoutMs: baseMs, load };
  return { timeoutMs: effectiveTimeoutMsForKind(load, kind, baseMs, maxMs), load };
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

function normalizePath(filename: string): string {
  return filename.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Whether any changed file is the root settings file. */
export function prTouchesRepoSettings(files: ReadonlyArray<{ filename: string }>): boolean {
  return files.some((file) => normalizePath(file.filename) === REPO_SETTINGS_PATH);
}
