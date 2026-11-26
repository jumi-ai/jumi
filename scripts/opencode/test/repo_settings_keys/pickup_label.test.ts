import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("pickup_label setting", () => {
  test("a non-string value is invalid", () => {
    expect(parseRepoSettingsText("pickup_label: 7\n")).toEqual({
      ok: false,
      error: '"pickup_label" must be a non-blank string',
    });
  });
});
