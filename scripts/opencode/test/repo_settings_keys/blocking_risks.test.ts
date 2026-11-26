import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("blocking_risks setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText('blocking_risks: "yes"\n')).toEqual({
      ok: false,
      error: '"blocking_risks" must be a boolean',
    });
  });
});
