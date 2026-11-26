import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("review_carry setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText('review_carry: "yes"\n')).toEqual({
      ok: false,
      error: '"review_carry" must be a boolean',
    });
  });
});
