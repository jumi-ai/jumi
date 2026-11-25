import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("conflict_regenerate setting", () => {
  test("a non-list value is invalid", () => {
    expect(parseRepoSettingsText('conflict_regenerate: "x"\n')).toEqual({
      ok: false,
      error: '"conflict_regenerate" must be a list of mappings',
    });
  });
});
