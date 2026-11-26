import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("blocking_question_authors setting", () => {
  test("a blank entry is invalid", () => {
    expect(parseRepoSettingsText('blocking_question_authors:\n  - ok\n  - ""\n')).toEqual({
      ok: false,
      error: '"blocking_question_authors" must not contain blank entries',
    });
  });
});
