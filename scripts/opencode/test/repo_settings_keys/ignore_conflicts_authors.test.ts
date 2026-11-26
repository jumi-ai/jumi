import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("ignore_conflicts_authors setting", () => {
  test("a non-list value is invalid", () => {
    expect(parseRepoSettingsText("ignore_conflicts_authors: 5\n")).toEqual({
      ok: false,
      error: '"ignore_conflicts_authors" must be a list of logins',
    });
  });
});
