import { describe, expect, test } from "bun:test";
import { loadRepoSettings, parseRepoSettingsText, prTouchesRepoSettings } from "../src/repo_settings.ts";
import { invalidHeadSettingsFailure } from "../src/review.ts";

describe("parseRepoSettingsText", () => {
  test("automerge true parses on", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: { automerge: true, timeouts: {} },
    });
  });

  test("absent automerge means off", () => {
    expect(parseRepoSettingsText("{}\n")).toEqual({ ok: true, settings: { automerge: false, timeouts: {} } });
    expect(parseRepoSettingsText("# only a comment\n")).toEqual({
      ok: true,
      settings: { automerge: false, timeouts: {} },
    });
  });

  test("explicit false means off", () => {
    expect(parseRepoSettingsText("automerge: false\n")).toEqual({
      ok: true,
      settings: { automerge: false, timeouts: {} },
    });
  });

  test("unparsable text is invalid", () => {
    const parsed = parseRepoSettingsText("automerge: [unclosed\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
  });

  test("a non-mapping top level is invalid", () => {
    for (const text of ["[]\n", "- automerge\n", "just a string\n", "42\n"]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({ ok: false, error: "top-level value must be a mapping" });
    }
  });

  test("an empty file means off", () => {
    expect(parseRepoSettingsText("")).toEqual({ ok: true, settings: { automerge: false, timeouts: {} } });
    expect(parseRepoSettingsText("null\n")).toEqual({ ok: true, settings: { automerge: false, timeouts: {} } });
  });

  test("an unknown key is invalid", () => {
    expect(parseRepoSettingsText("automerge: true\nunknown: 1\n")).toEqual({
      ok: false,
      error: 'unknown key "unknown"',
    });
  });

  test("a wrong-type value is invalid", () => {
    for (const text of ["automerge: 1\n", "automerge: yes-please\n", "automerge: null\n", "automerge: []\n"]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({ ok: false, error: '"automerge" must be a boolean' });
    }
  });
});

describe("loadRepoSettings", () => {
  test("missing file is missing", async () => {
    expect(await loadRepoSettings({ getRepoFile: async () => ({ found: false }) }, "o", "r", "main")).toEqual({
      state: "missing",
    });
  });

  test("no file API is missing", async () => {
    expect(await loadRepoSettings({}, "o", "r", "main")).toEqual({ state: "missing" });
  });

  test("valid file loads the setting", async () => {
    expect(
      await loadRepoSettings(
        { getRepoFile: async () => ({ found: true, content: "automerge: true\n" }) },
        "o",
        "r",
        "main"
      )
    ).toEqual({ state: "valid", automerge: true, timeouts: {} });
  });

  test("invalid file carries the parser error", async () => {
    expect(
      await loadRepoSettings({ getRepoFile: async () => ({ found: true, content: "nope: 1\n" }) }, "o", "r", "main")
    ).toEqual({ state: "invalid", error: 'unknown key "nope"' });
  });

  test("non-404 failures throw", async () => {
    await expect(
      loadRepoSettings(
        {
          getRepoFile: async () => {
            throw new Error("GitHub API → 500");
          },
        },
        "o",
        "r",
        "main"
      )
    ).rejects.toThrow("500");
  });
});

describe("prTouchesRepoSettings", () => {
  test("matches only the root file", () => {
    expect(prTouchesRepoSettings([{ filename: ".jumi.yml" }])).toBe(true);
    expect(prTouchesRepoSettings([{ filename: "src/a.ts" }, { filename: ".jumi.yml" }])).toBe(true);
    expect(prTouchesRepoSettings([{ filename: "docs/.jumi.yml" }])).toBe(false);
    expect(prTouchesRepoSettings([{ filename: "src/a.ts" }])).toBe(false);
    expect(prTouchesRepoSettings([])).toBe(false);
  });
});

describe("parseRepoSettingsTimeouts", () => {
  test("timeouts parse in whole minutes per kind", () => {
    expect(
      parseRepoSettingsText("timeouts:\n  review: 10\n  implement: 120\n  followup: 60\n  conflict: 30\n")
    ).toEqual({
      ok: true,
      settings: { automerge: false, timeouts: { review: 10, implement: 120, followup: 60, conflict: 30 } },
    });
  });

  test("absent timeouts means no overrides", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: { automerge: true, timeouts: {} },
    });
  });

  test("empty timeouts mapping means no overrides", () => {
    expect(parseRepoSettingsText("timeouts: {}\n")).toEqual({
      ok: true,
      settings: { automerge: false, timeouts: {} },
    });
  });

  test("unknown timeout key is invalid", () => {
    expect(parseRepoSettingsText("timeouts:\n  bogus: 10\n")).toEqual({
      ok: false,
      error: 'unknown key "timeouts.bogus"',
    });
  });

  test("below-minimum timeout is invalid", () => {
    expect(parseRepoSettingsText("timeouts:\n  review: 0\n")).toEqual({
      ok: false,
      error: '"timeouts.review" must be an integer number of minutes >= 1',
    });
  });

  test("non-integer and non-numeric timeouts are invalid", () => {
    for (const text of [
      "timeouts:\n  review: 1.5\n",
      "timeouts:\n  review: ten\n",
      "timeouts:\n  review: null\n",
      "timeouts:\n  review: []\n",
    ]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({
        ok: false,
        error: '"timeouts.review" must be an integer number of minutes >= 1',
      });
    }
  });

  test("non-mapping timeouts is invalid", () => {
    expect(parseRepoSettingsText("timeouts: 10\n")).toEqual({
      ok: false,
      error: '"timeouts" must be a mapping',
    });
  });
});

describe("effectiveTimeoutMsForKind", () => {
  test("missing, invalid, or absent key runs with the deployment timeout", async () => {
    const { effectiveTimeoutMsForKind } = await import("../src/repo_settings.ts");
    expect(effectiveTimeoutMsForKind({ state: "missing" }, "review", 900_000, 900_000)).toBe(900_000);
    expect(effectiveTimeoutMsForKind({ state: "invalid", error: "bad" }, "review", 900_000, 1_800_000)).toBe(900_000);
    expect(
      effectiveTimeoutMsForKind({ state: "valid", automerge: false, timeouts: {} }, "review", 900_000, 900_000)
    ).toBe(900_000);
  });

  test("shorter value shortens, longer clamps to the deployer maximum", async () => {
    const { effectiveTimeoutMsForKind } = await import("../src/repo_settings.ts");
    expect(
      effectiveTimeoutMsForKind(
        { state: "valid", automerge: false, timeouts: { review: 5 } },
        "review",
        900_000,
        900_000
      )
    ).toBe(300_000);
    expect(
      effectiveTimeoutMsForKind(
        { state: "valid", automerge: false, timeouts: { review: 60 } },
        "review",
        900_000,
        1_800_000
      )
    ).toBe(1_800_000);
  });

  test("follow-up kind reads the followup key and lease follows the effective value", async () => {
    const { effectiveLeaseMs, effectiveTimeoutMsForKind } = await import("../src/repo_settings.ts");
    const effective = effectiveTimeoutMsForKind(
      { state: "valid", automerge: false, timeouts: { followup: 120 } },
      "follow-up",
      3_600_000,
      7_200_000
    );
    expect(effective).toBe(7_200_000);
    expect(effectiveLeaseMs(4_200_000, effective)).toBe(effective + 600_000);
    expect(effectiveLeaseMs(9_000_000, 300_000)).toBe(9_000_000);
  });
});

describe("invalidHeadSettingsFailure", () => {
  const log = () => undefined;

  test("unset deployer list reads nothing and never fails", async () => {
    let calls = 0;
    const failure = await invalidHeadSettingsFailure({
      api: {
        getRepoFile: async () => {
          calls++;
          return { found: true, content: "nope: 1\n" };
        },
      },
      owner: "o",
      repo: "r",
      headSha: "abc",
      automergeRepos: [],
      log,
    });
    expect(failure).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("unlisted repository reads nothing", async () => {
    let calls = 0;
    const failure = await invalidHeadSettingsFailure({
      api: {
        getRepoFile: async () => {
          calls++;
          return { found: true, content: "nope: 1\n" };
        },
      },
      owner: "o",
      repo: "r",
      headSha: "abc",
      automergeRepos: ["other/repo"],
      log,
    });
    expect(failure).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("invalid head file fails with the parser error", async () => {
    const failure = await invalidHeadSettingsFailure({
      api: { getRepoFile: async () => ({ found: true, content: "automerge: 1\n" }) },
      owner: "o",
      repo: "r",
      headSha: "abc",
      automergeRepos: ["o/r"],
      log,
    });
    expect(failure).toContain(".jumi.yml is invalid");
    expect(failure).toContain('"automerge" must be a boolean');
  });

  test("valid head file passes", async () => {
    const failure = await invalidHeadSettingsFailure({
      api: { getRepoFile: async () => ({ found: true, content: "automerge: true\n" }) },
      owner: "o",
      repo: "r",
      headSha: "abc",
      automergeRepos: ["o"],
      log,
    });
    expect(failure).toBeUndefined();
  });

  test("unreadable head file is fail-open", async () => {
    const failure = await invalidHeadSettingsFailure({
      api: {
        getRepoFile: async () => {
          throw new Error("GitHub API → 500");
        },
      },
      owner: "o",
      repo: "r",
      headSha: "abc",
      automergeRepos: ["o/r"],
      log,
    });
    expect(failure).toBeUndefined();
  });
});
