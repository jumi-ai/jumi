/**
 * Repository settings file: `.jumi.yml` at the root of the repository's
 * default branch. The parent parses and applies it; no setting is handed to
 * a model, and nothing an agent writes during a job changes the settings
 * that job runs under.
 *
 * Strict: a file that does not parse, an unknown key, or a value of the
 * wrong type makes the whole file invalid. Invalid is its own state and is
 * never treated as "no file". A missing file is normal and silent.
 *
 * Adding a key: add one file under `repo_settings_keys/` (named after the
 * YAML key), import it below, and list it in `REPO_SETTINGS_REGISTRY` at the
 * alphabetical position. Keep the registry sorted: parallel additions then
 * land in different hunks instead of conflicting at the same spot. Document
 * the key in `docs/repo-settings.md` (see "Adding a setting" there) and cover
 * it with a per-key test under `test/repo_settings_keys/`.
 */

import { logDiagnostic } from "./diagnostics.ts";
import { isNotFoundError } from "./forge_errors.ts";
import { allowedRunnersSetting } from "./repo_settings_keys/allowed_runners.ts";
import { autoRerunFlakesSetting } from "./repo_settings_keys/auto_rerun_flakes.ts";
import { automergeSetting } from "./repo_settings_keys/automerge.ts";
import { automergeLabelSetting } from "./repo_settings_keys/automerge_label.ts";
import { automergeMethodSetting } from "./repo_settings_keys/automerge_method.ts";
import { blockingQuestionAuthorsSetting } from "./repo_settings_keys/blocking_question_authors.ts";
import { blockingRisksSetting } from "./repo_settings_keys/blocking_risks.ts";
import { branchPrefixSetting } from "./repo_settings_keys/branch_prefix.ts";
import { ciGateSetting } from "./repo_settings_keys/ci_gate.ts";
import { closingKeywordSetting } from "./repo_settings_keys/closing_keyword.ts";
import { commitMessageSetting } from "./repo_settings_keys/commit_message.ts";
import { conflictRegenerateSetting } from "./repo_settings_keys/conflict_regenerate.ts";
import { followupIgnoreLoginsSetting } from "./repo_settings_keys/followup_ignore_logins.ts";
import { followupOnRisksSetting } from "./repo_settings_keys/followup_on_risks.ts";
import { followupOnSuggestionsSetting } from "./repo_settings_keys/followup_on_suggestions.ts";
import { ignoreConflictsAuthorsSetting } from "./repo_settings_keys/ignore_conflicts_authors.ts";
import { ignoreConflictsLabelSetting } from "./repo_settings_keys/ignore_conflicts_label.ts";
import { maintainerQuestionsHoldMergeSetting } from "./repo_settings_keys/maintainer_questions_hold_merge.ts";
import { maxConflictRoundsSetting } from "./repo_settings_keys/max_conflict_rounds.ts";
import { maxFollowupRoundsSetting } from "./repo_settings_keys/max_followup_rounds.ts";
import { maxSuggestionsSetting } from "./repo_settings_keys/max_suggestions.ts";
import { modeSetting } from "./repo_settings_keys/mode.ts";
import { noAutomergeLabelSetting } from "./repo_settings_keys/no_automerge_label.ts";
import { pickupLabelSetting } from "./repo_settings_keys/pickup_label.ts";
import { prTitleSetting } from "./repo_settings_keys/pr_title.ts";
import { retitleAdoptedPrsSetting } from "./repo_settings_keys/retitle_adopted_prs.ts";
import { reviewBudgetSetting } from "./repo_settings_keys/review_budget.ts";
import { reviewCarrySetting } from "./repo_settings_keys/review_carry.ts";
import { reviewDraftsSetting } from "./repo_settings_keys/review_drafts.ts";
import { reviewExcludeSetting } from "./repo_settings_keys/review_exclude.ts";
import { setupSetting } from "./repo_settings_keys/setup.ts";
import { strictBranchRefreshSetting } from "./repo_settings_keys/strict_branch_refresh.ts";
import { suggestionsHoldMergeSetting } from "./repo_settings_keys/suggestions_hold_merge.ts";
import { takeoverAuthorsSetting } from "./repo_settings_keys/takeover_authors.ts";
import { timeoutsSetting } from "./repo_settings_keys/timeouts.ts";
import { trustedSendersSetting } from "./repo_settings_keys/trusted_senders.ts";
import { verifySetting } from "./repo_settings_keys/verify.ts";
import { workerReviewRulesSetting } from "./repo_settings_keys/worker_review_rules.ts";
import {
  type CiGateWait,
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_CLOSING_KEYWORD,
  DEFAULT_COMMIT_MESSAGE_TEMPLATE,
  DEFAULT_IGNORE_CONFLICTS_LABEL,
  DEFAULT_PICKUP_LABEL,
  DEFAULT_PR_TITLE_TEMPLATE,
  REPO_SETUP_KINDS,
  type RepoClosingKeyword,
  type RepoMode,
  type RepoSettingDef,
  type RepoSetup,
  type RepoSetupKind,
  TIMEOUT_KEYS,
  unknownKeyError,
} from "./repo_settings_shared.ts";
import { globToRegExp } from "./review_md.ts";
import { errorMessage } from "./util/error.ts";

export const REPO_SETTINGS_PATH = ".jumi.yml";

/** Default per-repository setup timeout: 10 minutes. */
const DEFAULT_SETUP_TIMEOUT_MINUTES = 10;

/** Default setup timeout in milliseconds. */
export const DEFAULT_SETUP_TIMEOUT_MS = DEFAULT_SETUP_TIMEOUT_MINUTES * 60 * 1000;

/**
 * Re-exported key-definition surface: the registry entries live in
 * `repo_settings_keys/`, but external importers keep importing them here.
 */
export {
  type CiGateWait,
  type ConflictRegenerateEntry,
  DEFAULT_AUTOMERGE_LABEL,
  DEFAULT_COMMIT_MESSAGE_TEMPLATE,
  DEFAULT_NO_AUTOMERGE_LABEL,
  DEFAULT_PR_TITLE_TEMPLATE,
  REVIEW_BUDGET_KEYS,
  type RepoMode,
  type RepoSetup,
  TIMEOUT_KEYS,
} from "./repo_settings_shared.ts";

type RegistryEntry = (typeof REPO_SETTINGS_REGISTRY)[number];

type SettingValue<Entry> = Entry extends RepoSettingDef<string, infer Value> ? Value : never;

/**
 * `RepoSettings` derived from the registry: every `required` entry is a
 * required field, every other entry an optional one. Field value types come
 * from each entry's parser.
 */
type RepoSettings = {
  [Entry in RegistryEntry as Entry extends { presence: "required" } ? Entry["field"] : never]: SettingValue<Entry>;
} & {
  [Entry in RegistryEntry as Entry extends { presence: "required" } ? never : Entry["field"]]?: SettingValue<Entry>;
};

export const REPO_MODE_DISABLED_NOTE =
  "Jumi worker jobs are turned off in this repository's settings (`.jumi.yml` `mode: review-only`). Reviews still run; assigning or labelling will not start work.";

export const REPO_MODE_OFF_REASON = "repository mode is off";
export const REPO_MODE_REVIEW_ONLY_REASON = "repository mode is review-only";

export type RepoSettingsParse = { ok: true; settings: RepoSettings } | { ok: false; error: string };

type RepoTimeoutKey = (typeof TIMEOUT_KEYS)[number];

/** Default CI gate wait mode: `required` waits only for required checks. */
export const DEFAULT_CI_GATE_WAIT: CiGateWait = "required";

const TIMEOUT_LEASE_BUFFER_MS = 10 * 60 * 1000;

/**
 * One entry per top-level `.jumi.yml` key, in alphabetical order: the first
 * invalid key in this order decides the error text, so `parseRepoSettingsText`
 * iterates this array in order. Each entry lives in its own file under
 * `repo_settings_keys/` and reuses the shared helpers with their exact error
 * strings.
 */
export const REPO_SETTINGS_REGISTRY = [
  allowedRunnersSetting,
  autoRerunFlakesSetting,
  automergeSetting,
  automergeLabelSetting,
  automergeMethodSetting,
  blockingQuestionAuthorsSetting,
  blockingRisksSetting,
  branchPrefixSetting,
  ciGateSetting,
  closingKeywordSetting,
  commitMessageSetting,
  conflictRegenerateSetting,
  followupIgnoreLoginsSetting,
  followupOnRisksSetting,
  followupOnSuggestionsSetting,
  ignoreConflictsAuthorsSetting,
  ignoreConflictsLabelSetting,
  maintainerQuestionsHoldMergeSetting,
  maxConflictRoundsSetting,
  maxFollowupRoundsSetting,
  maxSuggestionsSetting,
  modeSetting,
  noAutomergeLabelSetting,
  pickupLabelSetting,
  prTitleSetting,
  retitleAdoptedPrsSetting,
  reviewBudgetSetting,
  reviewCarrySetting,
  reviewDraftsSetting,
  reviewExcludeSetting,
  setupSetting,
  strictBranchRefreshSetting,
  suggestionsHoldMergeSetting,
  takeoverAuthorsSetting,
  timeoutsSetting,
  trustedSendersSetting,
  verifySetting,
  workerReviewRulesSetting,
];

/**
 * Output order for the parsed settings object: registry order, except `early`
 * entries assemble first and `late` entries assemble last. The registry is
 * alphabetical by key, so this order is alphabetical within each placement
 * group; `{ state: "valid", ...parsed.settings }` carries the same keys.
 */
const REPO_SETTINGS_ASSEMBLY_ORDER: readonly RegistryEntry[] = [
  ...REPO_SETTINGS_REGISTRY.filter((def) => def.placement === "early"),
  ...REPO_SETTINGS_REGISTRY.filter((def) => def.placement === undefined),
  ...REPO_SETTINGS_REGISTRY.filter((def) => def.placement === "late"),
];

/** Every top-level `.jumi.yml` key, derived from the registry (alphabetical order). */
export const KNOWN_KEYS = new Set(REPO_SETTINGS_REGISTRY.map((def) => def.key));

/** Render a validated title/commit template for one forge issue. */
export function renderIssueTemplate(template: string, title: string, issueNumber: number): string {
  return template.replaceAll("{title}", title).replaceAll("{issue}", String(issueNumber));
}

function parserErrorMessage(err: unknown): string {
  const message = errorMessage(err);
  const single = message.replace(/\s+/g, " ").trim();
  return single.length > 500 ? `${single.slice(0, 497)}...` : single || "could not be parsed";
}

/**
 * Record one absent key's default: `required` fields take the entry default,
 * `always` fields are present with `undefined`, `optional` fields stay absent.
 * Object and array defaults are cloned so every parse gets its own mutable
 * value instead of sharing the registry's `defaultValue` reference.
 */
function applyAbsentDefault(def: RegistryEntry, values: Map<string, unknown>, present: Set<string>): void {
  if (def.presence === "required") {
    const dv = def.defaultValue;
    if (Array.isArray(dv)) values.set(def.field, [...dv]);
    else if (dv !== null && typeof dv === "object") values.set(def.field, { ...(dv as Record<string, unknown>) });
    else values.set(def.field, dv);
    present.add(def.field);
  } else if (def.presence === "always") {
    values.set(def.field, undefined);
    present.add(def.field);
  }
}

/** Build the settings object in assembly order from validated values. */
function assembleSettings(values: Map<string, unknown>, present: Set<string>): RepoSettings {
  const settings: Record<string, unknown> = {};
  for (const def of REPO_SETTINGS_ASSEMBLY_ORDER) {
    if (present.has(def.field)) settings[def.field] = values.get(def.field);
  }
  return settings as RepoSettings;
}

/** Defaults for a missing or empty file: required defaults plus always-present undefineds. */
function defaultRepoSettingsFromRegistry(): RepoSettings {
  const values = new Map<string, unknown>();
  const present = new Set<string>();
  for (const def of REPO_SETTINGS_REGISTRY) applyAbsentDefault(def, values, present);
  return assembleSettings(values, present);
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
 * ignores it). Absent `conflict_regenerate` means no repository entries.
 * `mode` must be `full`, `review-only`, or `off` when present.
 * Absent `review_drafts` (or `false`) means drafts and `WIP:` titles are
 * skipped, as today; `true` reviews them on every review-dispatch path.
 * Absent `max_suggestions` means the parent ceiling; `0` is valid and means
 * no suggestion. Absent `review_budget` (or an empty mapping) means no
 * budget overrides; each present key is a positive integer, and a value
 * above the deployer maximum runs with the maximum. Absent
 * `automerge_method` means today's merge method (first allowed on GitHub,
 * default style on Gitea); a present value must be one of `merge`,
 * `squash`, `rebase`, `rebase-merge`, or `fast-forward-only`. Absent
 * `strict_branch_refresh` (or `false`) means no Gitea opt-in, as today;
 * `true` lets Gitea strict refresh run when branch protection is unreadable.
 * Absent `worker_review_rules` (or `true`) means implement and follow-up
 * workers receive the base-branch REVIEW.md rules; `false` keeps workers on
 * today's prompts.
 */
export function parseRepoSettingsText(text: string): RepoSettingsParse {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    return { ok: false, error: parserErrorMessage(err) };
  }
  if (parsed === null || parsed === undefined) return { ok: true, settings: defaultRepoSettingsFromRegistry() };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "top-level value must be a mapping" };
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key)) return { ok: false, error: unknownKeyError(key, [...KNOWN_KEYS]) };
  }
  const record = parsed as Record<string, unknown>;
  const values = new Map<string, unknown>();
  const present = new Set<string>();
  for (const def of REPO_SETTINGS_REGISTRY) {
    if (def.key in record && record[def.key] !== undefined) {
      const result = def.parse(record[def.key]);
      if (!result.ok) return result;
      values.set(def.field, result.value);
      present.add(def.field);
    } else {
      applyAbsentDefault(def, values, present);
    }
    // Preserved cross-field rule (checked right after `no_automerge_label`
    // resolves, before `blocking_question_authors`): the pair must differ.
    // Runs whether the keys were present or defaulted, like the old code's
    // unconditional check after both labels parsed.
    if (def.key === "no_automerge_label") {
      const automergeLabel = values.get("automergeLabel") as string;
      const noAutomergeLabel = values.get("noAutomergeLabel") as string;
      if (automergeLabel.toLowerCase() === noAutomergeLabel.toLowerCase()) {
        return { ok: false, error: `"automerge_label" and "no_automerge_label" must be different` };
      }
    }
  }
  return { ok: true, settings: assembleSettings(values, present) };
}

export type RepoSettingsLoad =
  | { state: "missing" }
  | ({ state: "valid" } & RepoSettings)
  | { state: "invalid"; error: string };

/**
 * Single default-branch `.jumi.yml` read held as a tri-state so every
 * follow-up consumer derives from the same load without re-reading.
 * `loaded` wraps the `RepoSettingsLoad` (valid/invalid/missing), `threw` is
 * a read that failed for another reason, `no-branch` is an empty ref or a
 * file-API-less caller (no read attempted).
 */
export type SettingsSnapshot =
  | { state: "loaded"; load: RepoSettingsLoad }
  | { state: "threw"; error: unknown }
  | { state: "no-branch" };

/** Load the default-branch file once into a `SettingsSnapshot`. Never throws. */
export async function loadSettingsSnapshot(
  api: RepoSettingsFileApi | undefined,
  owner: string,
  repo: string,
  defaultBranch: string | undefined | null
): Promise<SettingsSnapshot> {
  const ref = (defaultBranch ?? "").trim();
  if (!ref) return { state: "no-branch" };
  if (!api || typeof api.getRepoFile !== "function") return { state: "no-branch" };
  try {
    const load = await loadRepoSettings(api, owner, repo, ref);
    return { state: "loaded", load };
  } catch (error) {
    return { state: "threw", error };
  }
}

/** Fail-open load for `effective*` derivation: threw/no-branch behave as missing. */
export function failOpenLoadFromSnapshot(snapshot: SettingsSnapshot): RepoSettingsLoad {
  if (snapshot.state === "loaded") return snapshot.load;
  return { state: "missing" };
}

/** Ledger kind to repository timeout key: `follow-up` reads `followup`. */
function timeoutKeyForKind(kind: string): RepoTimeoutKey | undefined {
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

/** Setup key for a ledger kind: `follow-up` reads `followup`, like `timeouts`. */
function setupKeyForKind(kind: string): RepoSetupKind | undefined {
  const normalized = kind === "follow-up" ? "followup" : kind;
  if ((REPO_SETUP_KINDS as readonly string[]).includes(normalized)) return normalized as RepoSetupKind;
  return undefined;
}

/**
 * Repository setup for one job kind. Missing, invalid, or absent `setup`
 * means no setup. A present `setup` whose `kinds` does not include the kind
 * also means no setup. `kinds` can only narrow: there is no way to run setup
 * on a kind that is not one of the four.
 */
export function setupForKind(load: RepoSettingsLoad, kind: string): RepoSetup | undefined {
  if (load.state !== "valid" || !load.setup) return undefined;
  const key = setupKeyForKind(kind);
  if (!key) return undefined;
  if (!load.setup.kinds.includes(key)) return undefined;
  return load.setup;
}

/** Whether this job kind runs the repository setup. */
function setupAppliesToKind(load: RepoSettingsLoad, kind: string): boolean {
  return setupForKind(load, kind) !== undefined;
}

/**
 * Effective setup timeout for one setup. Missing setup runs nothing; the
 * caller checks `setupForKind` first. A value above the deployer maximum
 * (`SETUP_TIMEOUT_MAX_MS`, unset defaults to the 10-minute default) applies
 * as the maximum, so out of the box a repository can only shorten. The job's
 * own timeout and queue lease are not extended: setup time counts inside them.
 */
export function effectiveSetupTimeoutMs(setup: RepoSetup | undefined, maxMs: number): number {
  const wanted = (setup?.timeout ?? DEFAULT_SETUP_TIMEOUT_MINUTES) * 60 * 1000;
  const cap = maxMs > 0 ? maxMs : DEFAULT_SETUP_TIMEOUT_MS;
  return Math.min(wanted, cap);
}

/**
 * Deployer maximum for `setup.timeout` (`SETUP_TIMEOUT_MAX_MS`, unset
 * defaults to the 10-minute default). Never throws: a missing or invalid
 * value degrades to the default with a log line, so a typo never stops a job.
 * Production always threads the loaded config value through instead; this
 * direct-env read is the fallback for paths without a config.
 */
export function resolveSetupTimeoutMaxMs(
  env: Record<string, string | undefined> = process.env,
  log?: (message: string) => void
): number {
  const raw = env.SETUP_TIMEOUT_MAX_MS?.trim();
  if (!raw) return DEFAULT_SETUP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log?.(`Invalid SETUP_TIMEOUT_MAX_MS ${JSON.stringify(raw)}, using default ${DEFAULT_SETUP_TIMEOUT_MS}ms`);
    return DEFAULT_SETUP_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * Whether the Gitea strict-refresh opt-in is enabled. Missing, invalid, or
 * unreadable files behave as `false`. GitHub never reads this key.
 */
export function isStrictBranchRefreshEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return false;
  return (load as { strictBranchRefresh?: boolean }).strictBranchRefresh === true;
}

/**
 * Whether drafts and `WIP:` titles are reviewed in this repository. Missing
 * or invalid files behave as today (`false`): drafts are skipped.
 */
export function isReviewDraftsEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return false;
  return load.reviewDrafts === true;
}

/**
 * Whether a green review is carried across a clean target-branch merge
 * without running a model. Default on: missing, invalid, or unreadable files
 * behave as `true`. The repository opts out with `review_carry: false`.
 */
export function isReviewCarryEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return true;
  return (load as { reviewCarry?: boolean }).reviewCarry !== false;
}

/**
 * Whether adopted PRs may be retitled when Jumi's commits change what they
 * do. Default on: a missing file or missing key means on. An invalid or
 * unreadable file means off, because the retitle is a write. No deployer
 * setting.
 */
export function isRetitleAdoptedPrsEnabled(load: RepoSettingsLoad): boolean {
  if (load.state === "missing") return true;
  if (load.state !== "valid") return false;
  return (load as { retitleAdoptedPrs?: boolean }).retitleAdoptedPrs !== false;
}

/**
 * Load the default-branch settings file and report whether drafts review.
 * Missing, invalid, or unreadable files fall back to `false` (skip drafts,
 * as today). Never throws.
 */
export async function loadReviewDraftsEnabled(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  log?: (message: string) => void
): Promise<boolean> {
  if (!defaultBranch.trim()) return false;
  try {
    const settings = await loadRepoSettings(api, owner, repo, defaultBranch);
    if (settings.state !== "valid") return false;
    return isReviewDraftsEnabled(settings);
  } catch (err) {
    log?.(`review drafts settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Effective budget value for one key. Missing settings, a missing key, or an
 * invalid file runs with the deployment value (`base`). A value above the
 * deployer maximum (`max`) applies as the maximum. Unset, the maximum is
 * the deployment value itself, so a repository can only lower the budget.
 */
function effectiveReviewBudgetValue(
  load: RepoSettingsLoad,
  key: "maxFiles" | "maxPatchBytes",
  base: number,
  max: number
): number {
  if (load.state !== "valid") return base;
  const wanted = key === "maxFiles" ? load.reviewBudget.maxFiles : load.reviewBudget.maxPatchBytes;
  if (wanted === undefined) return base;
  const cap = max > 0 ? max : base;
  return Math.min(wanted, cap);
}

export interface EffectiveReviewBudget {
  maxFiles: number;
  maxPatchBytes: number;
}

/**
 * Effective review size budget. Missing, invalid, or unreadable files run
 * with the deployment values; a higher file value applies as the deployer
 * maximum (which defaults to the deployment value, so a repository can only
 * lower the budget out of the box).
 */
export function effectiveReviewBudget(
  load: RepoSettingsLoad,
  deployment: { maxFiles: number; maxFilesMax: number; maxPatchBytes: number; maxPatchBytesMax: number }
): EffectiveReviewBudget {
  return {
    maxFiles: effectiveReviewBudgetValue(load, "maxFiles", deployment.maxFiles, deployment.maxFilesMax),
    maxPatchBytes: effectiveReviewBudgetValue(
      load,
      "maxPatchBytes",
      deployment.maxPatchBytes,
      deployment.maxPatchBytesMax
    ),
  };
}

/**
 * Load the default-branch settings file and resolve the effective review
 * budget. Missing, invalid, or unreadable files fall back to the deployment
 * values. Never throws.
 */
async function loadEffectiveReviewBudget(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  deployment: { maxFiles: number; maxFilesMax: number; maxPatchBytes: number; maxPatchBytesMax: number },
  log?: (message: string) => void
): Promise<EffectiveReviewBudget> {
  const fallback: EffectiveReviewBudget = { maxFiles: deployment.maxFiles, maxPatchBytes: deployment.maxPatchBytes };
  if (!defaultBranch.trim()) return fallback;
  try {
    const settings = await loadRepoSettings(api, owner, repo, defaultBranch);
    if (settings.state !== "valid") return fallback;
    return effectiveReviewBudget(settings, deployment);
  } catch (err) {
    log?.(`review budget settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
    return fallback;
  }
}

/**
 * Effective 💡 suggestion cap for a repository. `MAX_SUGGESTION_FINDINGS` in
 * `verdict.ts` stays the ceiling: a higher file value applies as the ceiling.
 * Missing or invalid files run with the ceiling.
 */
export function effectiveSuggestionCap(load: RepoSettingsLoad, ceiling: number): number {
  if (load.state !== "valid" || load.maxSuggestions === undefined) return ceiling;
  return Math.min(load.maxSuggestions, ceiling);
}

/**
 * Load the default-branch settings file and resolve the effective 💡 cap.
 * Missing, invalid, or unreadable files fall back to the ceiling. Never throws.
 */
async function loadEffectiveSuggestionCap(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  ceiling: number,
  log?: (message: string) => void
): Promise<number> {
  if (!defaultBranch.trim()) return ceiling;
  try {
    const settings = await loadRepoSettings(api, owner, repo, defaultBranch);
    if (settings.state !== "valid") return ceiling;
    return effectiveSuggestionCap(settings, ceiling);
  } catch (err) {
    log?.(`suggestion settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
    return ceiling;
  }
}

export interface RepoSettingsFileApi {
  getRepoFile?(owner: string, repo: string, path: string, ref: string): Promise<{ found: boolean; content?: string }>;
  getRepo?(owner: string, repo: string): Promise<{ default_branch?: string }>;
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
  return { state: "valid", ...parsed.settings };
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
      log?.(`settings timeouts unreadable for ${owner}/${repo}: ${errorMessage(err)}`);
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
    log?.(`settings timeouts unreadable for ${owner}/${repo}@${ref}: ${errorMessage(err)}`);
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
 * Effective CI gate wait mode from a loaded settings file. Missing, invalid,
 * or absent `ci_gate`/`wait` is today's `#502` behaviour (`required`):
 * nothing ever falls back to `none`.
 */
export function effectiveCiGateWait(load: RepoSettingsLoad): CiGateWait {
  if (load.state !== "valid") return DEFAULT_CI_GATE_WAIT;
  const wait = load.ciGate?.wait;
  if (wait === "all" || wait === "none" || wait === "required") return wait;
  return DEFAULT_CI_GATE_WAIT;
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
    log?.(`mode settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
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
    log?.(`mode settings unreadable for ${owner}/${repo}: ${errorMessage(err)}`);
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

/**
 * Whether 🟡 risk findings fail `jumi/opencode-review`. Missing, invalid, or
 * unreadable files behave as today (`true`): every actionable 🟡 blocks.
 * `blocking_risks: false` leaves 🟡 advisory: still published, but the status
 * stays `success` with an `N non-blocking risk(s)` note.
 */
export function isRiskBlockingEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return true;
  return load.blockingRisks !== false;
}

/**
 * Whether a `success` review whose only findings are non-blocking 🟡 still
 * wakes a follow-up worker. Missing, invalid, or unreadable files behave as
 * today (`true`), the same rule as `followup_on_suggestions` for 💡.
 */
export function isRiskFollowupEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return true;
  return load.followupOnRisks !== false;
}

/**
 * Whether Jumi reruns still-failed CI jobs once per head and check after a
 * worker `no_changes` on red CI. Missing, invalid, or unreadable files
 * behave as today (on): the repository opts out with
 * `auto_rerun_flakes: false`.
 */
export function isAutoRerunFlakesEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return true;
  return load.autoRerunFlakes !== false;
}

/**
 * Whether implement and follow-up workers receive the base-branch REVIEW.md
 * rules. Default on: missing, invalid, or unreadable files behave as today
 * (on when the repo has a REVIEW.md, nothing new when it does not). The
 * repository opts out with `worker_review_rules: false`.
 */
export function isWorkerReviewRulesEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return true;
  return load.workerReviewRules !== false;
}

/**
 * Whether open 💡 suggestions hold the merge for one follow-up round.
 * Only in auto-merge repositories: the deployment switch must be on and the
 * repository must opt in through its valid default-branch file
 * (`automerge: true`, `mode: full`, no `suggestions_hold_merge: false`
 * opt-out) — or through an admitted `automerge` label on the PR
 * (`labelForced`), which also holds when the file is missing (the rest of
 * the policy then uses its defaults: follow-up on, full mode, hold on).
 * `no-automerge` and invalid files never hold; the review caller enforces
 * the `no-automerge` veto through the shared `isAutomergeOptedIn` helper.
 */
export function isSuggestionHoldEnabled(load: RepoSettingsLoad, automergeEnabled = true, labelForced = false): boolean {
  if (!automergeEnabled) return false;
  if (load.state === "missing") return labelForced;
  if (load.state !== "valid") return false;
  if (load.mode !== "full") return false;
  if (load.suggestionsHoldMerge === false) return false;
  if (load.automerge === true) return true;
  return labelForced;
}

/**
 * Whether open `❓ maintainer:` questions hold the merge via a `pending`
 * `jumi/opencode-review` status. Default on: missing, invalid, unreadable,
 * and `automerge: false` files all hold — the status gates every PR, not just
 * auto-merge ones. An explicit `maintainer_questions_hold_merge: false`
 * opts out and keeps today's `success`.
 */
export function isMaintainerQuestionsHoldEnabled(load: RepoSettingsLoad | undefined): boolean {
  if (!load) return true;
  if (load.state !== "valid") return true;
  return load.maintainerQuestionsHoldMerge !== false;
}

interface RepoFollowupPolicy {
  followupOnSuggestions: boolean;
  followupOnRisks: boolean;
  maxFollowupRounds: number;
  maxConflictRounds: number;
}

/**
 * Load the follow-up policy from the default branch. Fail-open: missing,
 * invalid, unreadable, or no file API behaves as today (deployment caps,
 * suggestions on) and never throws. Callers that need fail-closed (auto-
 * merge) keep using `loadRepoSettings` directly.
 */
async function loadRepoFollowupPolicy(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  deployment: { maxFollowupRounds: number; maxConflictRounds: number },
  log?: (message: string) => void
): Promise<RepoFollowupPolicy> {
  const fallback: RepoFollowupPolicy = {
    followupOnSuggestions: true,
    followupOnRisks: true,
    maxFollowupRounds: deployment.maxFollowupRounds,
    maxConflictRounds: deployment.maxConflictRounds,
  };
  try {
    const load = await loadRepoSettings(api, owner, repo, defaultBranch);
    return {
      followupOnSuggestions: isSuggestionFollowupEnabled(load),
      followupOnRisks: isRiskFollowupEnabled(load),
      maxFollowupRounds: effectiveFollowupRounds(deployment.maxFollowupRounds, load),
      maxConflictRounds: effectiveConflictRounds(deployment.maxConflictRounds, load),
    };
  } catch (err) {
    log?.(`follow-up settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
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
    log?.(`blocking settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
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
 * set means no list (`undefined`, write-access fallback). Combining two
 * otherwise valid policies can yield an explicitly empty effective list
 * (`[]`, no eligible senders): the deployment ceiling stays authoritative
 * and the empty list denies everyone without a forge lookup. Invalid,
 * missing, or unreadable files fall back to the deployment list, so an
 * invalid file never widens access. Blank deployment entries are ignored
 * (blank-only counts as unset). Matching stays case-insensitive whole-login
 * at the check site.
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
    log?.(`trusted sender settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
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
    log?.(`followup ignore settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
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
    log?.(`ignore-conflicts label settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
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
    log?.(`pickup label settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
    return DEFAULT_PICKUP_LABEL;
  }
}

/** Effective branch prefix: the file's `branch_prefix` or `jumi`. Missing/invalid/unreadable falls back to `jumi`. */
function effectiveBranchPrefix(settings: RepoSettingsLoad): string {
  if (settings.state !== "valid" || !settings.branchPrefix) return DEFAULT_BRANCH_PREFIX;
  return settings.branchPrefix;
}

/** Effective PR title template: the file's `pr_title` or `{title}`. */
function effectivePrTitleTemplate(settings: RepoSettingsLoad): string {
  if (settings.state !== "valid" || !settings.prTitle) return DEFAULT_PR_TITLE_TEMPLATE;
  return settings.prTitle;
}

/** Effective commit message template: the file's `commit_message` or the default. */
function effectiveCommitMessageTemplate(settings: RepoSettingsLoad): string {
  if (settings.state !== "valid" || !settings.commitMessage) return DEFAULT_COMMIT_MESSAGE_TEMPLATE;
  return settings.commitMessage;
}

/** Effective closing keyword: the file's `closing_keyword` or `closes`. */
function effectiveClosingKeyword(settings: RepoSettingsLoad): RepoClosingKeyword {
  if (settings.state !== "valid" || !settings.closingKeyword) return DEFAULT_CLOSING_KEYWORD;
  return settings.closingKeyword;
}

export interface RepoConventions {
  branchPrefix: string;
  prTitle: string;
  commitMessage: string;
  closingKeyword: RepoClosingKeyword;
}

export function defaultRepoConventions(): RepoConventions {
  return {
    branchPrefix: DEFAULT_BRANCH_PREFIX,
    prTitle: DEFAULT_PR_TITLE_TEMPLATE,
    commitMessage: DEFAULT_COMMIT_MESSAGE_TEMPLATE,
    closingKeyword: DEFAULT_CLOSING_KEYWORD,
  };
}

export function conventionsFromLoad(settings: RepoSettingsLoad): RepoConventions {
  return {
    branchPrefix: effectiveBranchPrefix(settings),
    prTitle: effectivePrTitleTemplate(settings),
    commitMessage: effectiveCommitMessageTemplate(settings),
    closingKeyword: effectiveClosingKeyword(settings),
  };
}

/**
 * Load PR conventions from the default branch only. Missing, invalid, or
 * unreadable files fall back to today's formats (fail-open). Never throws.
 */
export async function loadRepoConventions(
  api: RepoSettingsFileApi,
  owner: string,
  repo: string,
  defaultBranch: string,
  log?: (message: string) => void,
  preloaded?: SettingsSnapshot
): Promise<RepoConventions> {
  const fallback = defaultRepoConventions();
  if (preloaded) {
    const load = failOpenLoadFromSnapshot(preloaded);
    if (load.state !== "valid") return fallback;
    return conventionsFromLoad(load);
  }
  if (!defaultBranch.trim()) return fallback;
  try {
    const settings = await loadRepoSettings(api, owner, repo, defaultBranch);
    if (settings.state !== "valid") {
      if (settings.state === "invalid") {
        log?.(`pr convention settings invalid for ${owner}/${repo}@${defaultBranch}: ${settings.error}`);
      }
      return fallback;
    }
    return conventionsFromLoad(settings);
  } catch (err) {
    log?.(`pr convention settings unreadable for ${owner}/${repo}@${defaultBranch}: ${errorMessage(err)}`);
    return fallback;
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
 * True for a review skip reason produced when the pull head leaves
 * `.jumi.yml` invalid (or sets `mode: off` where the base requires the
 * review check). Both shapes start with the settings path, so one prefix
 * check covers them. Used to keep the strict check (still a `failure`
 * status) while giving the worker a path to fix the pull.
 */
export function isHeadSettingsFailureReason(reason: string | null | undefined): boolean {
  if (typeof reason !== "string") return false;
  return (
    reason.trimStart().startsWith(`${REPO_SETTINGS_PATH} is invalid:`) ||
    reason.trimStart().startsWith(`${REPO_SETTINGS_PATH} sets mode:`)
  );
}

/**
 * Worker-facing feedback for an invalid-head-settings failure. Carries the
 * parser error verbatim (including any "did you mean" suggestion) and
 * explains that merging the file as it is would turn Jumi off in the
 * repository until a release that knows the key is deployed. Default
 * guidance: for an unknown key the pull itself adds to the parser, take the
 * settings-file change out of this pull and keep the code; enabling the key
 * in this repository's own file is a separate pull after a release that
 * knows the key is deployed (and the PR body says so). For a typo or a wrong
 * value, fix the file. Never loosen the parser to get past the check.
 */
export function headSettingsFollowUpFeedback(failure: string): string {
  const trimmed = failure.trim();
  return [
    `The pull head leaves \`.jumi.yml\` invalid:`,
    ``,
    `${trimmed}`,
    ``,
    `Merging the file as it is would turn Jumi off in the repository until a`,
    `release that knows the key is deployed: the deployed parser reads the`,
    `default branch after merge and rejects the same file, so no runner job`,
    `would start.`,
    ``,
    `Default guidance:`,
    `- If this is an unknown key the pull itself adds to the parser, take the`,
    `  \`.jumi.yml\` change out of this pull and keep the code. Enabling the`,
    `  key in this repository's own file is a separate pull after a release`,
    `  that knows the key is deployed, and that pull's body says so.`,
    `- If this is a typo or a wrong value, fix the file.`,
    `- Never make the parser less strict to get past the check.`,
  ].join("\n");
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
  /** Pre-loaded single settings read: when present no forge read happens. */
  preloaded?: SettingsSnapshot;
}): Promise<RepoChainResolution<T>> {
  const base = opts.chain ? [...opts.chain] : [];
  if (opts.preloaded) {
    const snapshot = opts.preloaded;
    if (snapshot.state === "threw") throw snapshot.error;
    if (snapshot.state === "no-branch") return { state: "unrestricted", chain: base };
    const settings = snapshot.load;
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
  /** Pre-loaded single settings read: when present no forge read happens. */
  preloaded?: SettingsSnapshot;
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
      ...(opts.preloaded ? { preloaded: opts.preloaded } : {}),
    });
  } catch (err) {
    const context = opts.unreadableContext ?? `${opts.owner}/${opts.repo}`;
    opts.log?.(`runner settings unreadable for ${context}: ${errorMessage(err)}`);
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
