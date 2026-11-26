import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("review_exclude setting", () => {
  test("a blank entry is invalid", () => {
    expect(parseRepoSettingsText('review_exclude:\n  - ""\n')).toEqual({
      ok: false,
      error: '"review_exclude" must not contain blank entries',
    });
  });
});
