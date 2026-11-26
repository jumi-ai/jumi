import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("takeover_authors setting", () => {
  test("a blank entry is invalid", () => {
    expect(parseRepoSettingsText('takeover_authors:\n  - ""\n')).toEqual({
      ok: false,
      error: '"takeover_authors" must not contain blank entries',
    });
  });
});
