import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("max_conflict_rounds setting", () => {
  test("a non-integer value is invalid", () => {
    expect(parseRepoSettingsText("max_conflict_rounds: 1.5\n")).toEqual({
      ok: false,
      error: '"max_conflict_rounds" must be a non-negative integer',
    });
  });
});
