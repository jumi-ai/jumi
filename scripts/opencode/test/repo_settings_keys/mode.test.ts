import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("mode setting", () => {
  test("an unknown mode is invalid", () => {
    expect(parseRepoSettingsText("mode: sometimes\n")).toEqual({
      ok: false,
      error: '"mode" must be one of "full", "review-only", "off"',
    });
  });
});
