import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("worker_review_rules setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText('worker_review_rules: "yes"\n')).toEqual({
      ok: false,
      error: '"worker_review_rules" must be a boolean',
    });
  });
});
