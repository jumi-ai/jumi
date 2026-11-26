import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("timeouts setting", () => {
  test("a below-minimum timeout is invalid", () => {
    expect(parseRepoSettingsText("timeouts:\n  review: 0\n")).toEqual({
      ok: false,
      error: '"timeouts.review" must be an integer number of minutes >= 1',
    });
  });
});
