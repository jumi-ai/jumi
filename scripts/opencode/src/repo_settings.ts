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
import { isNotFoundError } from "./forge_errors.ts";
import { globToRegExp } from "./review_md.ts";
import { errorMessage } from "./util/error.ts";

export const REPO_SETTINGS_PATH = ".jumi.yml";

export interface RepoTimeouts {
  review?: number;
  implement?: number;
  followup?: number;
  conflict?: number;
}

export const REPO_SETUP_ON_FAILURES = ["continue", "fail"] as const;

export type RepoSetupOnFailure = (typeof REPO_SETUP_ON_FAILURES)[number];

/** Repository setup kinds: the `timeouts` spelling (`followup`, not `follow-up`). */
export const REPO_SETUP_KINDS = ["review", "implement", "followup", "conflict"] as const;
export type RepoSetupKind = (typeof REPO_SETUP_KINDS)[number];

/** Known sub-keys of the `setup` mapping. */
export const SETUP_KEYS = ["run", "timeout", "on_failure", "kinds"] as const;

/** Default per-repository setup timeout: 10 minutes. */
export const DEFAULT_SETUP_TIMEOUT_MINUTES = 10;

/** Default setup failure policy: run the job anyway. */
export const DEFAULT_SETUP_ON_FAILURE: RepoSetupOnFailure = "continue";

/** Default setup timeout in milliseconds. */
export const DEFAULT_SETUP_TIMEOUT_MS = DEFAULT_SETUP_TIMEOUT_MINUTES * 60 * 1000;

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
export const CONFLICT_REGENERATE_RESERVED = new Set(["Chart.lock", "requirements.lock"]);

export interface RepoReviewBudget {
  maxFiles?: number;
  maxPatchBytes?: number;
}
/**
 * One top-level `.jumi.yml` key, declared exactly once. `REPO_SETTINGS_REGISTRY`
 * below holds one entry per key in today's parser order; `parseRepoSettingsText`
 * is a loop over it, and `RepoSettings`, `KNOWN_KEYS`, and the
 * `loadRepoSettings` output are all derived from it. Adding a key means adding
 * one entry here (plus its `effective*` consumer and a `docs/repo-settings.md`
 * row).
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
export type RepoSettingPresence = "required" | "optional" | "always";

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
function requiredSetting<Field extends string, Value>(def: {
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
function optionalSetting<Field extends string, Value>(def: {
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
function alwaysPresentSetting<Field extends string, Value>(def: {
  key: string;
  field: Field;
  doc: string;
  parse: (raw: unknown) => RepoSettingResult<Value>;
  placement?: "early" | "late";
}): RepoSettingDef<Field, Value> & { readonly presence: "always" } {
  return { ...def, defaultValue: undefined, presence: "always" };
}

type RegistryEntry = (typeof REPO_SETTINGS_REGISTRY)[number];

type SettingValue<Entry> = Entry extends RepoSettingDef<string, infer Value> ? Value : never;

/**
 * `RepoSettings` derived from the registry: every `required` entry is a
 * required field, every other entry an optional one. Field value types come
 * from each entry's parser.
 */
export type RepoSettings = {
  [Entry in RegistryEntry as Entry extends { presence: "required" } ? Entry["field"] : never]: SettingValue<Entry>;
} & {
  [Entry in RegistryEntry as Entry extends { presence: "required" } ? never : Entry["field"]]?: SettingValue<Entry>;
};

export type RepoClosingKeyword = "closes" | "refs";

export type RepoMode = "full" | "review-only" | "off";

export const REPO_MODES: readonly RepoMode[] = ["full", "review-only", "off"];

/** CI gate wait mode: `required` waits only for required checks, `all` waits for every check, `none` never waits. */
export type CiGateWait = "all" | "required" | "none";

export const CI_GATE_WAITS: readonly CiGateWait[] = ["all", "required", "none"];

export const DEFAULT_CI_GATE_WAIT: CiGateWait = "required";

/** Known sub-keys of the `ci_gate` mapping. */
export const CI_GATE_KEYS = ["wait"] as const;

export const AUTOMERGE_METHODS = ["merge", "squash", "rebase", "rebase-merge", "fast-forward-only"] as const;
export type RepoAutomergeMethod = (typeof AUTOMERGE_METHODS)[number];

export const REPO_MODE_DISABLED_NOTE =
  "Jumi worker jobs are turned off in this repository's settings (`.jumi.yml` `mode: review-only`). Reviews still run; assigning or labelling will not start work.";

export const REPO_MODE_OFF_REASON = "repository mode is off";
export const REPO_MODE_REVIEW_ONLY_REASON = "repository mode is review-only";

export type RepoSettingsParse = { ok: true; settings: RepoSettings } | { ok: false; error: string };

/** Repository timeout keys: `followup` controls `follow-up` jobs. Values are whole minutes. */
export const TIMEOUT_KEYS = ["review", "implement", "followup", "conflict"] as const;
export type RepoTimeoutKey = (typeof TIMEOUT_KEYS)[number];

/** Documented minimum for every repository timeout: 1 minute. Below this the file is invalid. */
export const MIN_TIMEOUT_MINUTES = 1;

export const TIMEOUT_LEASE_BUFFER_MS = 10 * 60 * 1000;

/** Repository review-budget keys: `max_files` caps changed files, `max_patch_bytes` caps patch bytes. */
export const REVIEW_BUDGET_KEYS = ["max_files", "max_patch_bytes"] as const;
export type RepoReviewBudgetKey = (typeof REVIEW_BUDGET_KEYS)[number];

/** Documented minimum for every repository review-budget value: 1. Below this the file is invalid. */
export const MIN_REVIEW_BUDGET_VALUE = 1;

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

export const REPO_CLOSING_KEYWORDS: readonly RepoClosingKeyword[] = ["closes", "refs"];

/**
 * One entry per top-level `.jumi.yml` key, in today's parser order: the first
 * invalid key decides the error text, so `parseRepoSettingsText` iterates
 * this array in order. Each entry reuses today's helpers and inline checks
 * with their exact error strings.
 */
export const REPO_SETTINGS_REGISTRY = [
  requiredSetting({
    key: "automerge",
    field: "automerge",
    doc: "Schedule the forge's native auto-merge on opened pull requests once every other gate passes.",
    defaultValue: false,
    placement: "early",
    parse: (raw): RepoSettingResult<boolean> => {
      if (typeof raw !== "boolean") return { ok: false, error: `"automerge" must be a boolean` };
      return { ok: true, value: raw };
    },
  }),
  requiredSetting({
    key: "timeouts",
    field: "timeouts",
    doc: "Per-kind run timeouts in whole minutes; absent keys run with the deployment timeout.",
    defaultValue: {} as RepoTimeouts,
    parse: (raw): RepoSettingResult<RepoTimeouts> => {
      const parsed = parseTimeoutsValue(raw);
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.timeouts };
    },
  }),
  alwaysPresentSetting({
    key: "allowed_runners",
    field: "allowedRunners",
    doc: "Runner allow-list: every job for the repository narrows to chain entries on the list.",
    parse: (raw): RepoSettingResult<string[]> => {
      const parsed = parseStringList(raw, "allowed_runners", {
        notListError: `"allowed_runners" must be a list of runner names`,
      });
      if (!parsed.ok) return parsed;
      if (parsed.values.length === 0) {
        return {
          ok: false,
          error: `"allowed_runners" is empty, so no runner could work on the repository; use mode: off or mode: review-only`,
        };
      }
      return { ok: true, value: parsed.values };
    },
  }),
  requiredSetting({
    key: "review_exclude",
    field: "reviewExclude",
    doc: "Changed files matching these globs are left out of the review (patch withheld).",
    defaultValue: [] as string[],
    parse: (raw): RepoSettingResult<string[]> => {
      const parsed = parseStringList(raw, "review_exclude", {
        notListError: `"review_exclude" must be a list of glob strings`,
        dedupe: false,
      });
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.values };
    },
  }),
  requiredSetting({
    key: "followup_on_suggestions",
    field: "followupOnSuggestions",
    doc: "Follow up on success-with-suggestions reviews; false leaves them as-is.",
    defaultValue: true,
    parse: (raw): RepoSettingResult<boolean> => {
      if (typeof raw !== "boolean") return { ok: false, error: `"followup_on_suggestions" must be a boolean` };
      return { ok: true, value: raw };
    },
  }),
  requiredSetting({
    key: "auto_rerun_flakes",
    field: "autoRerunFlakes",
    doc: "Rerun failed flaky CI jobs once per head and check; false keeps the human-rerun note.",
    defaultValue: true,
    parse: (raw): RepoSettingResult<boolean> => {
      if (typeof raw !== "boolean") return { ok: false, error: `"auto_rerun_flakes" must be a boolean` };
      return { ok: true, value: raw };
    },
  }),
  optionalSetting({
    key: "suggestions_hold_merge",
    field: "suggestionsHoldMerge",
    doc: "Hold the merge for one suggestion follow-up round in auto-merge repositories.",
    placement: "late",
    parse: (raw): RepoSettingResult<boolean> => {
      if (typeof raw !== "boolean") return { ok: false, error: `"suggestions_hold_merge" must be a boolean` };
      return { ok: true, value: raw };
    },
  }),
  optionalSetting({
    key: "maintainer_questions_hold_merge",
    field: "maintainerQuestionsHoldMerge",
    doc: "Hold the merge while open ❓ maintainer: questions remain; false posts success instead of pending.",
    placement: "late",
    parse: (raw): RepoSettingResult<boolean> => {
      if (typeof raw !== "boolean") return { ok: false, error: `"maintainer_questions_hold_merge" must be a boolean` };
      return { ok: true, value: raw };
    },
  }),
  optionalSetting({
    key: "max_followup_rounds",
    field: "maxFollowupRounds",
    doc: "Cap follow-up rounds per pull request; 0 means no follow-up rounds.",
    parse: (raw): RepoSettingResult<number> => {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)
        return { ok: false, error: `"max_followup_rounds" must be a non-negative integer` };
      return { ok: true, value: raw };
    },
  }),
  optionalSetting({
    key: "max_conflict_rounds",
    field: "maxConflictRounds",
    doc: "Cap consecutive failed conflict-resolution rounds per issue; 0 means none.",
    parse: (raw): RepoSettingResult<number> => {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)
        return { ok: false, error: `"max_conflict_rounds" must be a non-negative integer` };
      return { ok: true, value: raw };
    },
  }),
  requiredSetting({
    key: "takeover_authors",
    field: "takeoverAuthors",
    doc: "Pull requests opened by these logins are taken over like a manual handover.",
    defaultValue: [] as string[],
    parse: (raw): RepoSettingResult<string[]> => {
      const parsed = parseStringList(raw, "takeover_authors", {
        notListError: `"takeover_authors" must be a list of logins`,
      });
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.values };
    },
  }),
  requiredSetting({
    key: "ignore_conflicts_authors",
    field: "ignoreConflictsAuthors",
    doc: "Pulls by these authors get the ignore-conflicts behavior without the label.",
    defaultValue: [] as string[],
    parse: (raw): RepoSettingResult<string[]> => {
      const parsed = parseStringList(raw, "ignore_conflicts_authors", {
        notListError: `"ignore_conflicts_authors" must be a list of logins`,
      });
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.values };
    },
  }),
  requiredSetting({
    key: "automerge_label",
    field: "automergeLabel",
    doc: "Per-PR label opting one Jumi PR into auto-merge.",
    defaultValue: DEFAULT_AUTOMERGE_LABEL,
    placement: "early",
    parse: (raw): RepoSettingResult<string> => {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: `"automerge_label" must be a non-blank string` };
      }
      return { ok: true, value: raw.trim() };
    },
  }),
  requiredSetting({
    key: "no_automerge_label",
    field: "noAutomergeLabel",
    doc: "Per-PR label opting one Jumi PR out of auto-merge.",
    defaultValue: DEFAULT_NO_AUTOMERGE_LABEL,
    placement: "early",
    parse: (raw): RepoSettingResult<string> => {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: `"no_automerge_label" must be a non-blank string` };
      }
      return { ok: true, value: raw.trim() };
    },
  }),
  requiredSetting({
    key: "blocking_question_authors",
    field: "blockingQuestionAuthors",
    doc: "PR authors whose open questions block the review status.",
    defaultValue: [] as string[],
    parse: (raw): RepoSettingResult<string[]> => {
      const parsed = parseStringList(raw, "blocking_question_authors", {
        notListError: `"blocking_question_authors" must be a list of logins`,
      });
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.values };
    },
  }),
  alwaysPresentSetting({
    key: "trusted_senders",
    field: "trustedSenders",
    doc: "Repository trusted-sender list; narrows a set deployment list, never widens it.",
    parse: (raw): RepoSettingResult<string[]> => {
      const parsed = parseStringList(raw, "trusted_senders", {
        notListError: `"trusted_senders" must be a list of logins`,
      });
      if (!parsed.ok) return parsed;
      if (parsed.values.length === 0) {
        return {
          ok: false,
          error: `"trusted_senders" is empty, so no sender could work on the repository; use mode: off or mode: review-only`,
        };
      }
      return { ok: true, value: parsed.values };
    },
  }),
  alwaysPresentSetting({
    key: "followup_ignore_logins",
    field: "followupIgnoreLogins",
    doc: "Extra follow-up ignore logins for this repository (union with the deployer list).",
    parse: (raw): RepoSettingResult<string[]> => {
      const parsed = parseStringList(raw, "followup_ignore_logins", {
        notListError: `"followup_ignore_logins" must be a list of logins`,
      });
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.values };
    },
  }),
  optionalSetting({
    key: "ignore_conflicts_label",
    field: "ignoreConflictsLabel",
    doc: "Override for the deployment ignore-conflicts label.",
    parse: (raw): RepoSettingResult<string> => {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: `"ignore_conflicts_label" must be a non-blank string` };
      }
      return { ok: true, value: raw.trim() };
    },
  }),
  optionalSetting({
    key: "pickup_label",
    field: "pickupLabel",
    doc: "Override for the GitHub pickup label (Gitea ignores it).",
    parse: (raw): RepoSettingResult<string> => {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: `"pickup_label" must be a non-blank string` };
      }
      return { ok: true, value: raw.trim() };
    },
  }),
  optionalSetting({
    key: "conflict_regenerate",
    field: "conflictRegenerate",
    doc: "Lockfiles the conflict job rebuilds with a shell command instead of the model.",
    parse: (raw): RepoSettingResult<ConflictRegenerateEntry[]> => {
      const parsed = parseConflictRegenerateValue(raw);
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.entries };
    },
  }),
  requiredSetting({
    key: "mode",
    field: "mode",
    doc: "Repository mode: full work, reviews only, or everything off.",
    defaultValue: "full" as RepoMode,
    parse: (raw): RepoSettingResult<RepoMode> => {
      if (typeof raw !== "string" || !(REPO_MODES as readonly string[]).includes(raw)) {
        return { ok: false, error: `"mode" must be one of "full", "review-only", "off"` };
      }
      return { ok: true, value: raw as RepoMode };
    },
  }),
  optionalSetting({
    key: "branch_prefix",
    field: "branchPrefix",
    doc: "Branch prefix for issue branches (<prefix>/issue-<N>-<slug>).",
    parse: (raw): RepoSettingResult<string> => {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: `"branch_prefix" must be a non-blank string` };
      }
      const validated = validateBranchPrefix(raw);
      if (!validated.ok) return validated;
      return { ok: true, value: validated.prefix };
    },
  }),
  optionalSetting({
    key: "pr_title",
    field: "prTitle",
    doc: "Pull-request title template for forge issues ({title} and {issue} only).",
    parse: (raw): RepoSettingResult<string> => {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: `"pr_title" must be a non-blank string` };
      }
      const validated = validatePrTemplate("pr_title", raw);
      if (!validated.ok) return validated;
      return { ok: true, value: validated.template };
    },
  }),
  optionalSetting({
    key: "commit_message",
    field: "commitMessage",
    doc: "Commit message template for the parent's leftover commit.",
    parse: (raw): RepoSettingResult<string> => {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: `"commit_message" must be a non-blank string` };
      }
      const validated = validatePrTemplate("commit_message", raw);
      if (!validated.ok) return validated;
      return { ok: true, value: validated.template };
    },
  }),
  optionalSetting({
    key: "closing_keyword",
    field: "closingKeyword",
    doc: "Closing keyword behavior: closes (Fixes #N) or refs (non-closing Refs #N).",
    parse: (raw): RepoSettingResult<RepoClosingKeyword> => {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: `"closing_keyword" must be a non-blank string` };
      }
      const trimmed = raw.trim();
      if (!(REPO_CLOSING_KEYWORDS as readonly string[]).includes(trimmed)) {
        return { ok: false, error: `"closing_keyword" must be one of "closes", "refs"` };
      }
      return { ok: true, value: trimmed as RepoClosingKeyword };
    },
  }),
  requiredSetting({
    key: "review_drafts",
    field: "reviewDrafts",
    doc: "Review draft PRs and WIP:-titled PRs on every review-dispatch path.",
    defaultValue: false,
    parse: (raw): RepoSettingResult<boolean> => {
      if (typeof raw !== "boolean") return { ok: false, error: `"review_drafts" must be a boolean` };
      return { ok: true, value: raw };
    },
  }),
  optionalSetting({
    key: "max_suggestions",
    field: "maxSuggestions",
    doc: "Cap for suggestion findings in this repository; 0 means no suggestions.",
    parse: (raw): RepoSettingResult<number> => {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)
        return { ok: false, error: `"max_suggestions" must be a non-negative integer` };
      return { ok: true, value: raw };
    },
  }),
  requiredSetting({
    key: "review_budget",
    field: "reviewBudget",
    doc: "Review size budget overrides (max_files, max_patch_bytes).",
    defaultValue: {} as RepoReviewBudget,
    parse: (raw): RepoSettingResult<RepoReviewBudget> => {
      const parsed = parseReviewBudgetValue(raw);
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.reviewBudget };
    },
  }),
  optionalSetting({
    key: "ci_gate",
    field: "ciGate",
    doc: "CI gate wait mode: required, all, or none.",
    parse: (raw): RepoSettingResult<{ wait: CiGateWait } | undefined> => {
      const parsed = parseCiGateValue(raw);
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.ciGate };
    },
  }),
  optionalSetting({
    key: "automerge_method",
    field: "automergeMethod",
    doc: "Merge method Jumi schedules with.",
    parse: (raw): RepoSettingResult<RepoAutomergeMethod> => {
      if (typeof raw !== "string" || !(AUTOMERGE_METHODS as readonly string[]).includes(raw)) {
        return {
          ok: false,
          error: `"automerge_method" must be one of "merge", "squash", "rebase", "rebase-merge", "fast-forward-only"`,
        };
      }
      return { ok: true, value: raw as RepoAutomergeMethod };
    },
  }),
  optionalSetting({
    key: "setup",
    field: "setup",
    doc: "Repository preparation command run once per job before the first engine spawn.",
    parse: (raw): RepoSettingResult<RepoSetup | undefined> => {
      const parsed = parseSetupValue(raw);
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.setup };
    },
  }),
];

/**
 * Output order for the parsed settings object: registry order, except `early`
 * entries assemble first and `late` entries assemble last. This reproduces the
 * legacy `loadRepoSettings` key order exactly (the identity labels parsed late
 * but output early; `suggestions_hold_merge` parsed early but output late), so
 * `{ state: "valid", ...parsed.settings }` keeps identical keys.
 */
const REPO_SETTINGS_ASSEMBLY_ORDER: readonly RegistryEntry[] = [
  ...REPO_SETTINGS_REGISTRY.filter((def) => def.placement === "early"),
  ...REPO_SETTINGS_REGISTRY.filter((def) => def.placement === undefined),
  ...REPO_SETTINGS_REGISTRY.filter((def) => def.placement === "late"),
];

/** Every top-level `.jumi.yml` key, derived from the registry (registry order). */
export const KNOWN_KEYS = new Set(REPO_SETTINGS_REGISTRY.map((def) => def.key));

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

/** Render a validated title/commit template for one forge issue. */
export function renderIssueTemplate(template: string, title: string, issueNumber: number): string {
  return template.replaceAll("{title}", title).replaceAll("{issue}", String(issueNumber));
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

type ConflictRegenerateParse = { ok: true; entries: ConflictRegenerateEntry[] } | { ok: false; error: string };

const CONFLICT_REGENERATE_KEYS = ["file", "run"] as const;

function parseConflictRegenerateValue(value: unknown): ConflictRegenerateParse {
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

type SetupParse = { ok: true; setup?: RepoSetup } | { ok: false; error: string };

function parseSetupValue(value: unknown): SetupParse {
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

function parseReviewBudgetValue(value: unknown): ReviewBudgetParse {
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

function parseCiGateValue(value: unknown): CiGateParse {
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
 * `squash`, `rebase`, `rebase-merge`, or `fast-forward-only`.
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

/** Setup key for a ledger kind: `follow-up` reads `followup`, like `timeouts`. */
export function setupKeyForKind(kind: string): RepoSetupKind | undefined {
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
export function setupAppliesToKind(load: RepoSettingsLoad, kind: string): boolean {
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
 * Whether drafts and `WIP:` titles are reviewed in this repository. Missing
 * or invalid files behave as today (`false`): drafts are skipped.
 */
export function isReviewDraftsEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return false;
  return load.reviewDrafts === true;
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
export function effectiveReviewBudgetValue(
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
export async function loadEffectiveReviewBudget(
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
export async function loadEffectiveSuggestionCap(
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
 * Whether Jumi reruns failed flaky CI jobs once per head and check.
 * Missing, invalid, or unreadable files behave as today (on): the
 * repository opts out with `auto_rerun_flakes: false`.
 */
export function isAutoRerunFlakesEnabled(load: RepoSettingsLoad): boolean {
  if (load.state !== "valid") return true;
  return load.autoRerunFlakes !== false;
}

/**
 * Whether open 💡 suggestions hold the merge for one follow-up round.
 * Only in auto-merge repositories: the default-branch file must be valid,
 * set `automerge: true`, run in `mode: full`, and not opt out with
 * `suggestions_hold_merge: false` — and the deployment switch must be on.
 * Missing, invalid, or unreadable files never hold; neither does
 * `automerge: false`. An explicit `suggestions_hold_merge: true` with
 * `automerge: false` still never holds.
 */
export function isSuggestionHoldEnabled(load: RepoSettingsLoad, automergeEnabled = true): boolean {
  if (!automergeEnabled) return false;
  if (load.state !== "valid") return false;
  if (load.mode !== "full") return false;
  if (load.automerge !== true) return false;
  if (load.suggestionsHoldMerge === false) return false;
  return true;
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
export function effectiveBranchPrefix(settings: RepoSettingsLoad): string {
  if (settings.state !== "valid" || !settings.branchPrefix) return DEFAULT_BRANCH_PREFIX;
  return settings.branchPrefix;
}

/** Effective PR title template: the file's `pr_title` or `{title}`. */
export function effectivePrTitleTemplate(settings: RepoSettingsLoad): string {
  if (settings.state !== "valid" || !settings.prTitle) return DEFAULT_PR_TITLE_TEMPLATE;
  return settings.prTitle;
}

/** Effective commit message template: the file's `commit_message` or the default. */
export function effectiveCommitMessageTemplate(settings: RepoSettingsLoad): string {
  if (settings.state !== "valid" || !settings.commitMessage) return DEFAULT_COMMIT_MESSAGE_TEMPLATE;
  return settings.commitMessage;
}

/** Effective closing keyword: the file's `closing_keyword` or `closes`. */
export function effectiveClosingKeyword(settings: RepoSettingsLoad): RepoClosingKeyword {
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
