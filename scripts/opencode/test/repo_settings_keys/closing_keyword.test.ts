import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("closing_keyword setting", () => {
  test("an unknown keyword is invalid", () => {
    expect(parseRepoSettingsText("closing_keyword: sometimes\n")).toEqual({
      ok: false,
      error: '"closing_keyword" must be one of "closes", "refs"',
    });
  });
});
