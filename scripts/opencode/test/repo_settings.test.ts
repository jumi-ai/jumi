import { describe, expect, test } from "bun:test";
import { loadRepoSettings, parseRepoSettingsText, prTouchesRepoSettings } from "../src/repo_settings.ts";
import { invalidHeadSettingsFailure } from "../src/review.ts";

describe("parseRepoSettingsText", () => {
  test("automerge true parses on", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: { automerge: true, takeoverAuthors: [], ignoreConflictsAuthors: [] },
    });
  });

  test("absent automerge means off", () => {
    expect(parseRepoSettingsText("{}\n")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: [], ignoreConflictsAuthors: [] },
    });
    expect(parseRepoSettingsText("# only a comment\n")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: [], ignoreConflictsAuthors: [] },
    });
  });

  test("explicit false means off", () => {
    expect(parseRepoSettingsText("automerge: false\n")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: [], ignoreConflictsAuthors: [] },
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
    expect(parseRepoSettingsText("")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: [], ignoreConflictsAuthors: [] },
    });
    expect(parseRepoSettingsText("null\n")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: [], ignoreConflictsAuthors: [] },
    });
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

  test("takeover authors parse as logins", () => {
    expect(parseRepoSettingsText("takeover_authors: [renovate, Dependabot]\n")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: ["renovate", "Dependabot"], ignoreConflictsAuthors: [] },
    });
    expect(parseRepoSettingsText("takeover_authors: []\n")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: [], ignoreConflictsAuthors: [] },
    });
  });

  test("ignore-conflicts authors parse as logins", () => {
    expect(parseRepoSettingsText('ignore_conflicts_authors: ["renovate[bot]"]\n')).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: [], ignoreConflictsAuthors: ["renovate[bot]"] },
    });
  });

  test("author aliases parse to the same setting", () => {
    expect(parseRepoSettingsText("takeover-authors: [a]\n")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: ["a"], ignoreConflictsAuthors: [] },
    });
    expect(parseRepoSettingsText("takeoverAuthors: [a]\n")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: ["a"], ignoreConflictsAuthors: [] },
    });
    expect(parseRepoSettingsText("ignore-conflicts-authors: [a]\n")).toEqual({
      ok: true,
      settings: { automerge: false, takeoverAuthors: [], ignoreConflictsAuthors: ["a"] },
    });
  });

  test("author lists must be lists of non-empty strings", () => {
    for (const text of [
      "takeover_authors: renovate\n",
      "takeover_authors: 1\n",
      "takeover_authors: [renovate, 1]\n",
      "ignore_conflicts_authors: nope\n",
      'ignore_conflicts_authors: ["", renovate]\n',
    ]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed.ok).toBe(false);
    }
    expect(parseRepoSettingsText("takeover_authors: []\n").ok).toBe(true);
    expect(parseRepoSettingsText("takeover_authors: [renovate, renovate]\n").ok).toBe(true);
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
    ).toEqual({ state: "valid", automerge: true, takeoverAuthors: [], ignoreConflictsAuthors: [] });
  });

  test("valid file loads author lists", async () => {
    expect(
      await loadRepoSettings(
        {
          getRepoFile: async () => ({
            found: true,
            content: 'takeover_authors: [renovate]\nignore_conflicts_authors: ["renovate[bot]"]\n',
          }),
        },
        "o",
        "r",
        "main"
      )
    ).toEqual({
      state: "valid",
      automerge: false,
      takeoverAuthors: ["renovate"],
      ignoreConflictsAuthors: ["renovate[bot]"],
    });
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
