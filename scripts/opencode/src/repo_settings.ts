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
  /** PR-author logins whose open ❓ questions block the review status in this repository. */
  blockingQuestionAuthors: string[];
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

const KNOWN_KEYS = new Set(["automerge", "blocking_question_authors", "mode"]);

function parserErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const single = message.replace(/\s+/g, " ").trim();
  return single.length > 500 ? `${single.slice(0, 497)}...` : single || "could not be parsed";
}

/**
 * Parse raw `.jumi.yml` text. Absent `automerge` (or `false`) means off;
 * absent `blocking_question_authors` means no repo-listed authors; absent
 * `mode` means `full`. `blocking_question_authors` must be a list of login
 * strings when present; blank entries are dropped like the deployer CSV.
 * `mode` must be `full`, `review-only`, or `off` when present. No
 * schema-version key exists. The error string is the parser's error and is
 * surfaced verbatim in the auto-merge note and the review status.
 */
export function parseRepoSettingsText(text: string): RepoSettingsParse {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    return { ok: false, error: parserErrorMessage(err) };
  }
  if (parsed === null || parsed === undefined)
    return { ok: true, settings: { automerge: false, blockingQuestionAuthors: [], mode: "full" } };
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
  let mode: RepoMode = "full";
  if ("mode" in record && record.mode !== undefined) {
    if (typeof record.mode !== "string" || !(REPO_MODES as readonly string[]).includes(record.mode)) {
      return { ok: false, error: `"mode" must be one of "full", "review-only", "off"` };
    }
    mode = record.mode as RepoMode;
  }
  return { ok: true, settings: { automerge, blockingQuestionAuthors, mode } };
}

export type RepoSettingsLoad =
  | { state: "missing" }
  | { state: "valid"; automerge: boolean; blockingQuestionAuthors: string[]; mode: RepoMode }
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
    blockingQuestionAuthors: parsed.settings.blockingQuestionAuthors,
    mode: parsed.settings.mode,
  };
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
