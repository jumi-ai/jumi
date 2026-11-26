import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("setup setting", () => {
  test("a missing run command is invalid", () => {
    expect(parseRepoSettingsText("setup: {}\n")).toEqual({
      ok: false,
      error: '"setup.run" must be a non-blank string',
    });
  });
});
