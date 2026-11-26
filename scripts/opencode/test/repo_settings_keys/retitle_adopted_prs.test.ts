import { describe, expect, test } from "bun:test";
import { isRetitleAdoptedPrsEnabled, parseRepoSettingsText } from "../../src/repo_settings.ts";

describe("retitle_adopted_prs setting", () => {
  test("a non-boolean value is invalid", () => {
    expect(parseRepoSettingsText('retitle_adopted_prs: "yes"\n')).toEqual({
      ok: false,
      error: '"retitle_adopted_prs" must be a boolean',
    });
  });

  test("missing means on, invalid means off", () => {
    expect(parseRepoSettingsText("{}\n").ok).toBe(true);
    const missing = { state: "missing" } as const;
    expect(isRetitleAdoptedPrsEnabled(missing)).toBe(true);
    const invalid = { state: "invalid", error: "bad" } as const;
    expect(isRetitleAdoptedPrsEnabled(invalid)).toBe(false);
    const validOff = parseRepoSettingsText("retitle_adopted_prs: false\n");
    expect(validOff.ok).toBe(true);
    if (validOff.ok) expect(isRetitleAdoptedPrsEnabled({ state: "valid", ...validOff.settings })).toBe(false);
  });
});
