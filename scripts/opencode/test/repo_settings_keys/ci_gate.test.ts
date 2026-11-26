import { describe, expect, test } from "bun:test";
import { parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("ci_gate setting", () => {
  test("an unknown wait mode is invalid", () => {
    expect(parseRepoSettingsText("ci_gate:\n  wait: sometimes\n")).toEqual({
      ok: false,
      error: '"ci_gate.wait" must be one of "all", "required", "none"',
    });
  });
});
