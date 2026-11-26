import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("maintainer_questions_hold_merge setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText("maintainer_questions_hold_merge: 1\n")).toEqual({
      ok: false,
      error: '"maintainer_questions_hold_merge" must be a boolean',
    });
  });
});
