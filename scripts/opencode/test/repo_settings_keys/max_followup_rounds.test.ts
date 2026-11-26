import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("max_followup_rounds setting", () => {
  test("a negative value is invalid", () => {
    expect(parseRepoSettingsText("max_followup_rounds: -1\n")).toEqual({
      ok: false,
      error: '"max_followup_rounds" must be a non-negative integer',
    });
  });
});
