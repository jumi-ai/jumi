import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("review_drafts setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText('review_drafts: "yes"\n')).toEqual({
      ok: false,
      error: '"review_drafts" must be a boolean',
    });
  });
});
