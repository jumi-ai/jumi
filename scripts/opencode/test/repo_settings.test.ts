import { describe, expect, test } from "bun:test";
import {
  compileReviewExcludePatterns,
  isReviewExcluded,
  loadRepoSettings,
  parseRepoSettingsText,
  partitionReviewExcludedFiles,
  prTouchesRepoSettings,
} from "../src/repo_settings.ts";
import { formatReviewExcludedNote, invalidHeadSettingsFailure, loadReviewExcludeMatchers } from "../src/review.ts";

describe("parseRepoSettingsText", () => {
  test("automerge true parses on", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: { automerge: true, reviewExclude: [] },
    });
  });

  test("absent automerge means off", () => {
    expect(parseRepoSettingsText("{}\n")).toEqual({ ok: true, settings: { automerge: false, reviewExclude: [] } });
    expect(parseRepoSettingsText("# only a comment\n")).toEqual({
      ok: true,
      settings: { automerge: false, reviewExclude: [] },
    });
  });

  test("explicit false means off", () => {
    expect(parseRepoSettingsText("automerge: false\n")).toEqual({
      ok: true,
      settings: { automerge: false, reviewExclude: [] },
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
    expect(parseRepoSettingsText("")).toEqual({ ok: true, settings: { automerge: false, reviewExclude: [] } });
    expect(parseRepoSettingsText("null\n")).toEqual({ ok: true, settings: { automerge: false, reviewExclude: [] } });
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

  test("review_exclude parses a list of globs", () => {
    expect(parseRepoSettingsText('review_exclude:\n  - "**/generated/**"\n  - "pnpm-lock.yaml"\n')).toEqual({
      ok: true,
      settings: { automerge: false, reviewExclude: ["**/generated/**", "pnpm-lock.yaml"] },
    });
  });

  test("absent review_exclude means nothing is left out", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: { automerge: true, reviewExclude: [] },
    });
  });

  test("review_exclude combines with automerge", () => {
    expect(parseRepoSettingsText('automerge: true\nreview_exclude:\n  - "docs/**"\n')).toEqual({
      ok: true,
      settings: { automerge: true, reviewExclude: ["docs/**"] },
    });
  });

  test("a wrong-type review_exclude is invalid", () => {
    for (const text of [
      "review_exclude: true\n",
      "review_exclude: 1\n",
      "review_exclude: null\n",
      "review_exclude: lockfile\n",
      "review_exclude:\n  - 1\n",
      'review_exclude:\n  - ""\n',
      'review_exclude:\n  - "  "\n',
    ]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({ ok: false, error: '"review_exclude" must be a list of glob strings' });
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
    ).toEqual({ state: "valid", automerge: true, reviewExclude: [] });
  });

  test("valid file loads review_exclude", async () => {
    expect(
      await loadRepoSettings(
        { getRepoFile: async () => ({ found: true, content: 'review_exclude:\n  - "**/generated/**"\n' }) },
        "o",
        "r",
        "main"
      )
    ).toEqual({ state: "valid", automerge: false, reviewExclude: ["**/generated/**"] });
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

describe("review_exclude matching", () => {
  test("matches with the gitignore-style dialect", () => {
    const compiled = compileReviewExcludePatterns(["**/generated/**", "pnpm-lock.yaml", "docs/"]);
    expect(isReviewExcluded("src/generated/foo.ts", compiled)).toBe(true);
    expect(isReviewExcluded("generated/foo.ts", compiled)).toBe(true);
    expect(isReviewExcluded("pnpm-lock.yaml", compiled)).toBe(true);
    expect(isReviewExcluded("a/b/pnpm-lock.yaml", compiled)).toBe(true);
    expect(isReviewExcluded("docs/guide.md", compiled)).toBe(true);
    expect(isReviewExcluded("src/app.ts", compiled)).toBe(false);
  });

  test("the settings file itself can never be left out", () => {
    const compiled = compileReviewExcludePatterns(["**", ".jumi.yml", "*.yml"]);
    expect(isReviewExcluded(".jumi.yml", compiled)).toBe(false);
    expect(isReviewExcluded("src/app.ts", compiled)).toBe(true);
  });

  test("an invalid glob never matches instead of failing", () => {
    const compiled = compileReviewExcludePatterns(["[z-a].ts", "**/generated/**"]);
    expect(isReviewExcluded("src/generated/foo.ts", compiled)).toBe(true);
    expect(isReviewExcluded("src/app.ts", compiled)).toBe(false);
  });

  test("partition keeps the settings file included", () => {
    const compiled = compileReviewExcludePatterns(["**"]);
    const { included, excluded } = partitionReviewExcludedFiles(
      [{ filename: ".jumi.yml" }, { filename: "src/app.ts" }],
      compiled
    );
    expect(included.map((file) => file.filename)).toEqual([".jumi.yml"]);
    expect(excluded.map((file) => file.filename)).toEqual(["src/app.ts"]);
  });
});

describe("loadReviewExcludeMatchers", () => {
  const log = () => undefined;

  test("missing file means no exclusions", async () => {
    const matchers = await loadReviewExcludeMatchers({
      api: { getRepoFile: async () => ({ found: false }) },
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      log,
    });
    expect(matchers).toEqual([]);
  });

  test("reads the default branch ref", async () => {
    let ref = "";
    const matchers = await loadReviewExcludeMatchers({
      api: {
        getRepoFile: async (_o: string, _r: string, _p: string, r: string) => {
          ref = r;
          return { found: true, content: 'review_exclude:\n  - "**/generated/**"\n' };
        },
      },
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      log,
    });
    expect(ref).toBe("main");
    expect(matchers).toHaveLength(1);
  });

  test("invalid file means no exclusions", async () => {
    const matchers = await loadReviewExcludeMatchers({
      api: { getRepoFile: async () => ({ found: true, content: "review_exclude: 1\n" }) },
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      log,
    });
    expect(matchers).toEqual([]);
  });

  test("unreadable file is fail-open", async () => {
    const matchers = await loadReviewExcludeMatchers({
      api: {
        getRepoFile: async () => {
          throw new Error("GitHub API → 500");
        },
      },
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      log,
    });
    expect(matchers).toEqual([]);
  });
});

describe("formatReviewExcludedNote", () => {
  test("empty means no note", () => {
    expect(formatReviewExcludedNote([])).toBe("");
  });

  test("names a single file", () => {
    const note = formatReviewExcludedNote(["pnpm-lock.yaml"]);
    expect(note).toContain("`pnpm-lock.yaml`");
    expect(note).toContain("`review_exclude`");
    expect(note).toContain("can merge without review");
  });

  test("all-excluded says nothing was read", () => {
    const note = formatReviewExcludedNote(["a.ts", "b.ts"], { allExcluded: true });
    expect(note).toContain("No patches were read");
    expect(note).toContain("`a.ts`");
    expect(note).toContain("`b.ts`");
  });

  test("long lists name the count", () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    const note = formatReviewExcludedNote(files);
    expect(note).not.toContain("`f11.ts`");
    expect(note).toContain("and 2 more");
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

  test("invalid review_exclude in the head file fails", async () => {
    const failure = await invalidHeadSettingsFailure({
      api: { getRepoFile: async () => ({ found: true, content: "review_exclude: 1\n" }) },
      owner: "o",
      repo: "r",
      headSha: "abc",
      automergeRepos: ["o/r"],
      log,
    });
    expect(failure).toContain(".jumi.yml is invalid");
    expect(failure).toContain('"review_exclude" must be a list of glob strings');
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
