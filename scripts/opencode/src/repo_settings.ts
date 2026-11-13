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
  /**
   * Runner allow-list for the repository. `undefined` (key absent) means no
   * restriction: the repository uses the full active chain. A defined list
   * (possibly empty) narrows every job for the repository to chain entries
   * whose name is on the list. Narrowing only: names outside the active
   * chain grant nothing.
   */
  allowedRunners?: string[];
  /** PR-author logins whose open ❓ questions block the review status in this repository. */
  blockingQuestionAuthors: string[];
}

export type RepoSettingsParse = { ok: true; settings: RepoSettings } | { ok: false; error: string };

const KNOWN_KEYS = new Set(["automerge", "allowed_runners", "blocking_question_authors"]);

function parserErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const single = message.replace(/\s+/g, " ").trim();
  return single.length > 500 ? `${single.slice(0, 497)}...` : single || "could not be parsed";
}

/**
 * Parse raw `.jumi.yml` text. Absent `automerge` (or `false`) means off;
 * absent `allowed_runners` means no runner restriction; absent
 * `blocking_question_authors` means no repo-listed authors.
 * `blocking_question_authors` must be a list of login strings when present;
 * blank entries are dropped like the deployer CSV. No schema-version key
 * exists. The error string is the parser's error and is surfaced verbatim
 * in the auto-merge note and the review status.
 */
export function parseRepoSettingsText(text: string): RepoSettingsParse {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    return { ok: false, error: parserErrorMessage(err) };
  }
  if (parsed === null || parsed === undefined)
    return { ok: true, settings: { automerge: false, allowedRunners: undefined, blockingQuestionAuthors: [] } };
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
  let allowedRunners: string[] | undefined;
  if ("allowed_runners" in record && record.allowed_runners !== undefined) {
    const value = record.allowed_runners;
    if (!Array.isArray(value)) return { ok: false, error: `"allowed_runners" must be a list of runner names` };
    const names: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") return { ok: false, error: `"allowed_runners" must be a list of runner names` };
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (!names.includes(trimmed)) names.push(trimmed);
    }
    allowedRunners = names;
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
  return { ok: true, settings: { automerge, allowedRunners, blockingQuestionAuthors } };
}

export type RepoSettingsLoad =
  | { state: "missing" }
  | { state: "valid"; automerge: boolean; allowedRunners?: string[]; blockingQuestionAuthors: string[] }
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
    allowedRunners: parsed.settings.allowedRunners,
    blockingQuestionAuthors: parsed.settings.blockingQuestionAuthors,
  };
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
