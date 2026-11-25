import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("pr_title setting", () => {
  test("an unknown placeholder is invalid", () => {
    expect(parseRepoSettingsText('pr_title: "{bogus}"\n')).toEqual({
      ok: false,
      error: '"pr_title" contains unknown placeholder "{bogus}"',
    });
  });
});
