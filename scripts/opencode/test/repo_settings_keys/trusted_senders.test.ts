import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("trusted_senders setting", () => {
  test("an empty list is invalid", () => {
    expect(parseRepoSettingsText("trusted_senders: []\n")).toEqual({
      ok: false,
      error:
        '"trusted_senders" is empty, so no sender could work on the repository; use mode: off or mode: review-only',
    });
  });
});
