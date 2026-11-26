import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("commit_message setting", () => {
  test("a stray brace is invalid", () => {
    expect(parseRepoSettingsText('commit_message: "a { b"\n')).toEqual({
      ok: false,
      error: '"commit_message" contains a stray "{" or "}"',
    });
  });
});
