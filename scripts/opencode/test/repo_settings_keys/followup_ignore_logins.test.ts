import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("followup_ignore_logins setting", () => {
  test("a non-list value is invalid", () => {
    expect(parseRepoSettingsText('followup_ignore_logins: "bot"\n')).toEqual({
      ok: false,
      error: '"followup_ignore_logins" must be a list of logins',
    });
  });
});
