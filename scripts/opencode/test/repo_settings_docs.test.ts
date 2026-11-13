import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_KEYS, parseRepoSettingsText, TIMEOUT_KEYS } from "../src/repo_settings.ts";

const page = readFileSync(join(process.cwd(), "..", "..", "docs", "repo-settings.md"), "utf8");

function yamlBlocks(text: string): string[] {
  const out: string[] = [];
  const fence = /```yaml\n([\s\S]*?)```/g;
  let match = fence.exec(text);
  while (match) {
    out.push(match[1] ?? "");
    match = fence.exec(text);
  }
  return out;
}

function keyTableSection(text: string): string {
  const start = text.indexOf("## Key table");
  const end = text.indexOf("## Complete example");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("repo-settings docs", () => {
  test("the complete example parses as valid", () => {
    const complete = yamlBlocks(page).find((block) => block.includes("allowed_runners:"));
    expect(complete).toBeDefined();
    const parsed = parseRepoSettingsText(complete ?? "");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.automerge).toBe(true);
    expect(parsed.settings.mode).toBe("full");
    expect(parsed.settings.allowedRunners).toEqual(["primary"]);
    expect(parsed.settings.reviewExclude.length).toBeGreaterThan(0);
    expect(parsed.settings.followupOnSuggestions).toBe(false);
    expect(parsed.settings.takeoverAuthors.length).toBeGreaterThan(0);
    expect(parsed.settings.ignoreConflictsAuthors.length).toBeGreaterThan(0);
    expect(parsed.settings.blockingQuestionAuthors.length).toBeGreaterThan(0);
    expect(parsed.settings.maxFollowupRounds).toBeDefined();
    expect(parsed.settings.maxConflictRounds).toBeDefined();
    for (const key of TIMEOUT_KEYS) {
      expect(parsed.settings.timeouts[key]).toBeDefined();
    }
  });

  test("every known key appears in the page table", () => {
    const table = keyTableSection(page);
    for (const key of KNOWN_KEYS) {
      expect(table).toContain(`\`${key}\``);
    }
  });

  test("every timeout key appears as its own timeouts.* row", () => {
    const table = keyTableSection(page);
    for (const key of TIMEOUT_KEYS) {
      expect(table).toContain(`\`timeouts.${key}\``);
    }
  });
});
