import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("allowed_runners setting", () => {
  test("an empty list is invalid", () => {
    expect(parseRepoSettingsText("allowed_runners: []\n")).toEqual({
      ok: false,
      error:
        '"allowed_runners" is empty, so no runner could work on the repository; use mode: off or mode: review-only',
    });
  });
});
