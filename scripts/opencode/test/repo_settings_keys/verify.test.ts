import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("verify setting", () => {
  test("a missing run command is invalid", () => {
    expect(parseRepoSettingsText("verify: {}\n")).toEqual({
      ok: false,
      error: '"verify.run" must be a non-blank string',
    });
  });
});
