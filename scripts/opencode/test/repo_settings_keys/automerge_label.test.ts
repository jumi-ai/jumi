import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("automerge_label setting", () => {
  test("a blank value is invalid", () => {
    expect(parseRepoSettingsText('automerge_label: ""\n')).toEqual({
      ok: false,
      error: '"automerge_label" must be a non-blank string',
    });
  });
});
