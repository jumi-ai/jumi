import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("auto_rerun_flakes setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText('auto_rerun_flakes: "yes"\n')).toEqual({
      ok: false,
      error: '"auto_rerun_flakes" must be a boolean',
    });
  });
});
