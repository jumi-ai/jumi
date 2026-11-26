import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("suggestions_hold_merge setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText("suggestions_hold_merge: 1\n")).toEqual({
      ok: false,
      error: '"suggestions_hold_merge" must be a boolean',
    });
  });
});
