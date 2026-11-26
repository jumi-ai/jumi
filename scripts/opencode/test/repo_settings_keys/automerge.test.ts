import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("automerge setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText('automerge: "yes"\n')).toEqual({
      ok: false,
      error: '"automerge" must be a boolean',
    });
  });
});
