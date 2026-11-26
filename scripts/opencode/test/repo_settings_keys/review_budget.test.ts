import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("review_budget setting", () => {
  test("a zero budget value is invalid", () => {
    expect(parseRepoSettingsText("review_budget:\n  max_files: 0\n")).toEqual({
      ok: false,
      error: '"review_budget.max_files" must be a positive integer',
    });
  });
});
