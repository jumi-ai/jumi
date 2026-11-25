import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("max_suggestions setting", () => {
  test("a negative value is invalid", () => {
    expect(parseRepoSettingsText("max_suggestions: -1\n")).toEqual({
      ok: false,
      error: '"max_suggestions" must be a non-negative integer',
    });
  });
});
