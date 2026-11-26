import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("ignore_conflicts_label setting", () => {
  test("a blank value is invalid", () => {
    expect(parseRepoSettingsText('ignore_conflicts_label: ""\n')).toEqual({
      ok: false,
      error: '"ignore_conflicts_label" must be a non-blank string',
    });
  });
});
