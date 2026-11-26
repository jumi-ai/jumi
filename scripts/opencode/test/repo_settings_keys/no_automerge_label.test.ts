import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("no_automerge_label setting", () => {
  test("a non-string value is invalid", () => {
    expect(parseRepoSettingsText("no_automerge_label: 42\n")).toEqual({
      ok: false,
      error: '"no_automerge_label" must be a non-blank string',
    });
  });
});
