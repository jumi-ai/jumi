import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_KEYS, loadRepoSettings, parseRepoSettingsText, REPO_SETTINGS_REGISTRY } from "../src/repo_settings.ts";

const page = readFileSync(join(process.cwd(), "..", "..", "docs", "repo-settings.md"), "utf8");

function keyTableSection(text: string): string {
  const start = text.indexOf("## Key table");
  const end = text.indexOf("## Complete example");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

const fullFixture = `automerge: true
timeouts:
  review: 10
  implement: 120
  followup: 60
  conflict: 60
allowed_runners:
  - primary
review_exclude:
  - "**/generated/**"
followup_on_suggestions: false
suggestions_hold_merge: true
maintainer_questions_hold_merge: true
max_followup_rounds: 2
max_conflict_rounds: 1
takeover_authors:
  - renovate
ignore_conflicts_authors:
  - renovate
automerge_label: ship-it
no_automerge_label: hold-it
blocking_question_authors:
  - alice
trusted_senders:
  - alice
followup_ignore_logins:
  - preview-bot
ignore_conflicts_label: ignore-conflicts
pickup_label: jumi
conflict_regenerate:
  - file: package-lock.json
    run: npm install --package-lock-only --ignore-scripts
mode: full
worker_review_rules: true
branch_prefix: bot/jumi
pr_title: "feat: {title}"
commit_message: "chore: {title} (#{issue})"
closing_keyword: refs
review_drafts: true
max_suggestions: 2
review_budget:
  max_files: 300
  max_patch_bytes: 2000000
ci_gate:
  wait: all
automerge_method: squash
setup:
  run: make setup
  timeout: 5
  on_failure: fail
  kinds: [review]
verify:
  run: bun run lint
  timeout: 5
  attempts: 1
  kinds: [implement, followup]
`;

// Load key order for an empty file: `early` entries first, then the rest in
// registry (alphabetical) order. Late entries are absent here.
const expectedNoneKeys = [
  "state",
  "automerge",
  "automergeLabel",
  "noAutomergeLabel",
  "allowedRunners",
  "autoRerunFlakes",
  "blockingQuestionAuthors",
  "followupIgnoreLogins",
  "followupOnSuggestions",
  "ignoreConflictsAuthors",
  "mode",
  "reviewBudget",
  "reviewCarry",
  "reviewDrafts",
  "reviewExclude",
  "strictBranchRefresh",
  "takeoverAuthors",
  "timeouts",
  "trustedSenders",
  "workerReviewRules",
];

// Load key order for the full fixture: `early`, then registry order, then `late`.
const expectedFullKeys = [
  "state",
  "automerge",
  "automergeLabel",
  "noAutomergeLabel",
  "allowedRunners",
  "autoRerunFlakes",
  "automergeMethod",
  "blockingQuestionAuthors",
  "branchPrefix",
  "ciGate",
  "closingKeyword",
  "commitMessage",
  "conflictRegenerate",
  "followupIgnoreLogins",
  "followupOnSuggestions",
  "ignoreConflictsAuthors",
  "ignoreConflictsLabel",
  "maxConflictRounds",
  "maxFollowupRounds",
  "maxSuggestions",
  "mode",
  "pickupLabel",
  "prTitle",
  "reviewBudget",
  "reviewCarry",
  "reviewDrafts",
  "reviewExclude",
  "setup",
  "strictBranchRefresh",
  "takeoverAuthors",
  "timeouts",
  "trustedSenders",
  "verify",
  "workerReviewRules",
  "maintainerQuestionsHoldMerge",
  "suggestionsHoldMerge",
];

// One invalid value per key, with the pre-refactor error string.
const invalidPerKey: Array<[string, string, string]> = [
  ["automerge", 'automerge: "yes"\n', '"automerge" must be a boolean'],
  ["timeouts", "timeouts:\n  review: 0\n", '"timeouts.review" must be an integer number of minutes >= 1'],
  [
    "allowed_runners",
    "allowed_runners: []\n",
    '"allowed_runners" is empty, so no runner could work on the repository; use mode: off or mode: review-only',
  ],
  ["review_exclude", 'review_exclude:\n  - ""\n', '"review_exclude" must not contain blank entries'],
  ["followup_on_suggestions", 'followup_on_suggestions: "yes"\n', '"followup_on_suggestions" must be a boolean'],
  ["auto_rerun_flakes", 'auto_rerun_flakes: "yes"\n', '"auto_rerun_flakes" must be a boolean'],
  ["suggestions_hold_merge", "suggestions_hold_merge: 1\n", '"suggestions_hold_merge" must be a boolean'],
  [
    "maintainer_questions_hold_merge",
    "maintainer_questions_hold_merge: 1\n",
    '"maintainer_questions_hold_merge" must be a boolean',
  ],
  ["max_followup_rounds", "max_followup_rounds: -1\n", '"max_followup_rounds" must be a non-negative integer'],
  ["max_conflict_rounds", "max_conflict_rounds: 1.5\n", '"max_conflict_rounds" must be a non-negative integer'],
  ["takeover_authors", 'takeover_authors:\n  - ""\n', '"takeover_authors" must not contain blank entries'],
  ["ignore_conflicts_authors", "ignore_conflicts_authors: 5\n", '"ignore_conflicts_authors" must be a list of logins'],
  ["automerge_label", 'automerge_label: ""\n', '"automerge_label" must be a non-blank string'],
  ["no_automerge_label", "no_automerge_label: 42\n", '"no_automerge_label" must be a non-blank string'],
  [
    "blocking_question_authors",
    'blocking_question_authors:\n  - ok\n  - ""\n',
    '"blocking_question_authors" must not contain blank entries',
  ],
  [
    "trusted_senders",
    "trusted_senders: []\n",
    '"trusted_senders" is empty, so no sender could work on the repository; use mode: off or mode: review-only',
  ],
  ["followup_ignore_logins", 'followup_ignore_logins: "bot"\n', '"followup_ignore_logins" must be a list of logins'],
  ["ignore_conflicts_label", 'ignore_conflicts_label: ""\n', '"ignore_conflicts_label" must be a non-blank string'],
  ["pickup_label", "pickup_label: 7\n", '"pickup_label" must be a non-blank string'],
  ["conflict_regenerate", 'conflict_regenerate: "x"\n', '"conflict_regenerate" must be a list of mappings'],
  ["mode", "mode: sometimes\n", '"mode" must be one of "full", "review-only", "off"'],
  ["branch_prefix", 'branch_prefix: ""\n', '"branch_prefix" must be a non-blank string'],
  ["pr_title", 'pr_title: "{bogus}"\n', '"pr_title" contains unknown placeholder "{bogus}"'],
  ["commit_message", 'commit_message: "a { b"\n', '"commit_message" contains a stray "{" or "}"'],
  ["closing_keyword", "closing_keyword: sometimes\n", '"closing_keyword" must be one of "closes", "refs"'],
  ["review_drafts", 'review_drafts: "yes"\n', '"review_drafts" must be a boolean'],
  ["max_suggestions", "max_suggestions: -1\n", '"max_suggestions" must be a non-negative integer'],
  ["review_budget", "review_budget:\n  max_files: 0\n", '"review_budget.max_files" must be a positive integer'],
  ["ci_gate", "ci_gate:\n  wait: sometimes\n", '"ci_gate.wait" must be one of "all", "required", "none"'],
  [
    "automerge_method",
    "automerge_method: ff\n",
    '"automerge_method" must be one of "merge", "squash", "rebase", "rebase-merge", "fast-forward-only"',
  ],
  ["setup", "setup: {}\n", '"setup.run" must be a non-blank string'],
  ["verify", "verify: {}\n", '"verify.run" must be a non-blank string'],
  ["strict_branch_refresh", 'strict_branch_refresh: "yes"\n', '"strict_branch_refresh" must be a boolean'],
  ["review_carry", 'review_carry: "yes"\n', '"review_carry" must be a boolean'],
  ["worker_review_rules", 'worker_review_rules: "yes"\n', '"worker_review_rules" must be a boolean'],
];

describe("repo_settings registry", () => {
  test("registry is alphabetical by key", () => {
    const keys = REPO_SETTINGS_REGISTRY.map((def) => def.key);
    expect(keys).toEqual([...keys].sort());
  });

  test("every registry key is known and documented", () => {
    expect(REPO_SETTINGS_REGISTRY).toHaveLength(35);
    const table = keyTableSection(page);
    for (const def of REPO_SETTINGS_REGISTRY) {
      expect(KNOWN_KEYS.has(def.key)).toBe(true);
      expect(table).toContain(`\`${def.key}\``);
    }
  });

  test("every documented key is a registry key", () => {
    const table = keyTableSection(page);
    const documented = new Set<string>();
    for (const line of table.split("\n")) {
      const match = /^\| `([^`]+)`/.exec(line);
      if (!match) continue;
      documented.add((match[1] as string).split(".")[0] as string);
    }
    expect(documented.size).toBeGreaterThan(0);
    for (const key of documented) {
      expect(KNOWN_KEYS.has(key)).toBe(true);
    }
  });

  test("every registry key has a per-key definition file and vice versa", () => {
    const dir = join(process.cwd(), "src", "repo_settings_keys");
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => file.replace(/\.ts$/, ""));
    expect(new Set(files)).toEqual(new Set(REPO_SETTINGS_REGISTRY.map((def) => def.key)));
  });

  test("every registry key has a per-key test file and vice versa", () => {
    const dir = join(process.cwd(), "test", "repo_settings_keys");
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => file.replace(/\.test\.ts$/, ""));
    expect(new Set(files)).toEqual(new Set(REPO_SETTINGS_REGISTRY.map((def) => def.key)));
  });

  test("empty fixture keeps the load key set", async () => {
    const load = await loadRepoSettings(
      { getRepoFile: async () => ({ found: true, content: "{}\n" }) },
      "o",
      "r",
      "main"
    );
    expect(load.state).toBe("valid");
    if (load.state !== "valid") return;
    expect(Object.keys(load)).toEqual(expectedNoneKeys);
  });

  test("full fixture keeps the load key set", async () => {
    const load = await loadRepoSettings(
      { getRepoFile: async () => ({ found: true, content: fullFixture }) },
      "o",
      "r",
      "main"
    );
    expect(load.state).toBe("valid");
    if (load.state !== "valid") return;
    expect(Object.keys(load)).toEqual(expectedFullKeys);
  });

  test("one invalid value per key gives today's error", () => {
    expect(invalidPerKey).toHaveLength(REPO_SETTINGS_REGISTRY.length);
    for (const [key, text, error] of invalidPerKey) {
      expect(REPO_SETTINGS_REGISTRY.some((def) => def.key === key)).toBe(true);
      expect(parseRepoSettingsText(text)).toEqual({ ok: false, error });
    }
  });
});
