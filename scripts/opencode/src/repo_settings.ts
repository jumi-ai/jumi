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

export interface RepoSettings {
  automerge: boolean;
  followupOnSuggestions: boolean;
  maxFollowupRounds?: number;
  maxConflictRounds?: number;
  takeoverAuthors: string[];
  ignoreConflictsAuthors: string[];
  /** PR-author logins whose open ❓ questions block the review status in this repository. */
  blockingQuestionAuthors: string[];
}

export type RepoSettingsParse = { ok: true; settings: RepoSettings } | { ok: false; error: string };

const KNOWN_KEYS = new Set([
  "automerge",
  "followup_on_suggestions",
  "max_followup_rounds",
  "max_conflict_rounds",
  "takeover_authors",
  "takeover-authors",
  "takeoverAuthors",
  "ignore_conflicts_authors",
  "ignore-conflicts-authors",
  "ignoreConflictsAuthors",
  "blocking_question_authors",
]);

function parserErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const single = message.replace(/\s+/g, " ").trim();
  return single.length > 500 ? `${single.slice(0, 497)}...` : single || "could not be parsed";
}

/**
 * Parse raw `.jumi.yml` text. Absent `automerge` (or `false`) means off;
 * no schema-version key exists. `followup_on_suggestions` absent means on:
 * a `success` review with suggestions follows up as today; `false` turns
 * that off while failures, blocking questions, red CI, and conflicts run
 * as today. `max_followup_rounds` / `max_conflict_rounds` absent mean the
 * deployment value; `0` is valid and means no rounds of that kind.
 * Absent author lists mean empty; absent `blocking_question_authors` means
 * no repo-listed authors. The error string is the parser's error and is
 * surfaced verbatim in the auto-merge note and the review status.
 * Author lists match whole logins, case-insensitive. Canonical keys are
 * `takeover_authors` and `ignore_conflicts_authors`; hyphen and camelCase
 * spellings are accepted as aliases for the same setting.
 * `blocking_question_authors` must be a list of login strings when present;
 * blank entries are dropped like the deployer CSV.
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
        followupOnSuggestions: true,
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
  if (!("automerge" in record) || record.automerge === undefined) record.automerge = false as unknown as boolean;
  if (typeof record.automerge !== "boolean") return { ok: false, error: `"automerge" must be a boolean` };
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
  const settings: RepoSettings = {
    automerge: record.automerge === true,
    followupOnSuggestions:
      "followup_on_suggestions" in record && record.followup_on_suggestions !== undefined
        ? record.followup_on_suggestions === true
        : true,
    takeoverAuthors: takeover.authors,
    ignoreConflictsAuthors: ignoreConflicts.authors,
    blockingQuestionAuthors,
  };
  if ("max_followup_rounds" in record && record.max_followup_rounds !== undefined)
    settings.maxFollowupRounds = record.max_followup_rounds as number;
  if ("max_conflict_rounds" in record && record.max_conflict_rounds !== undefined)
    settings.maxConflictRounds = record.max_conflict_rounds as number;
  return { ok: true, settings };
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
      followupOnSuggestions: boolean;
      maxFollowupRounds?: number;
      maxConflictRounds?: number;
      takeoverAuthors: string[];
      ignoreConflictsAuthors: string[];
      blockingQuestionAuthors: string[];
    }
  | { state: "invalid"; error: string };

export interface RepoSettingsFileApi {
  getRepoFile?(owner: string, repo: string, path: string, ref: string): Promise<{ found: boolean; content?: string }>;
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
  };
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

function normalizePath(filename: string): string {
  return filename.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Whether any changed file is the root settings file. */
export function prTouchesRepoSettings(files: ReadonlyArray<{ filename: string }>): boolean {
  return files.some((file) => normalizePath(file.filename) === REPO_SETTINGS_PATH);
}
