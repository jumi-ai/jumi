import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("strict_branch_refresh setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText('strict_branch_refresh: "yes"\n')).toEqual({
      ok: false,
      error: '"strict_branch_refresh" must be a boolean',
    });
  });
});
