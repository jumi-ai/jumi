import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("automerge_method setting", () => {
  test("an unknown method is invalid", () => {
    expect(parseRepoSettingsText("automerge_method: ff\n")).toEqual({
      ok: false,
      error: '"automerge_method" must be one of "merge", "squash", "rebase", "rebase-merge", "fast-forward-only"',
    });
  });
});
