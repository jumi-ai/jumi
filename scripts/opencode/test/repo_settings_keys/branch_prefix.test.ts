import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("branch_prefix setting", () => {
  test("a blank value is invalid", () => {
    expect(parseRepoSettingsText('branch_prefix: ""\n')).toEqual({
      ok: false,
      error: '"branch_prefix" must be a non-blank string',
    });
  });
});
