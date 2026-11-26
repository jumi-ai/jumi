import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("followup_on_suggestions setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText('followup_on_suggestions: "yes"\n')).toEqual({
      ok: false,
      error: '"followup_on_suggestions" must be a boolean',
    });
  });
});
