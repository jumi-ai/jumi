import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_KEYS, loadRepoSettings, REPO_SETTINGS_REGISTRY } from "../src/repo_settings.ts";

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
  "reviewDrafts",
  "reviewExclude",
  "strictBranchRefresh",
  "takeoverAuthors",
  "timeouts",
  "trustedSenders",
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
  "reviewDrafts",
  "reviewExclude",
  "setup",
  "strictBranchRefresh",
  "takeoverAuthors",
  "timeouts",
  "trustedSenders",
  "maintainerQuestionsHoldMerge",
  "suggestionsHoldMerge",
];

describe("repo_settings registry", () => {
  test("registry is alphabetical by key", () => {
    const keys = REPO_SETTINGS_REGISTRY.map((def) => def.key);
    expect(keys).toEqual([...keys].sort());
  });

  test("every registry key is known and documented", () => {
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
});
