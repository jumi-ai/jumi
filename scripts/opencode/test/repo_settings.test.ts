import { describe, expect, test } from "bun:test";
import {
  compileReviewExcludePatterns,
  effectiveBlockingQuestionAuthors,
  isReviewExcluded,
  loadEffectiveBlockingQuestionAuthors,
  loadRepoMode,
  loadRepoSettings,
  parseRepoSettingsText,
  partitionReviewExcludedFiles,
  prTouchesRepoSettings,
  repoMode,
  resolveRepoMode,
} from "../src/repo_settings.ts";
import {
  formatReviewExcludedNote,
  invalidHeadSettingsFailure,
  loadReviewExcludeMatchers,
  publishReviewResult,
  type ReviewApi,
} from "../src/review.ts";
import { emptyCiMethods, makeComment, makeFile, makePR, makeRepo } from "./fixtures.ts";

describe("parseRepoSettingsText", () => {
  test("automerge true parses on", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: {
        automerge: true,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("absent automerge means off", () => {
    expect(parseRepoSettingsText("{}\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
    expect(parseRepoSettingsText("# only a comment\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("explicit false means off", () => {
    expect(parseRepoSettingsText("automerge: false\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
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
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
    expect(parseRepoSettingsText("null\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
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

  test("review_exclude parses a list of globs", () => {
    expect(parseRepoSettingsText('review_exclude:\n  - "**/generated/**"\n  - "pnpm-lock.yaml"\n')).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: ["**/generated/**", "pnpm-lock.yaml"],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("absent review_exclude means nothing is left out", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: {
        automerge: true,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("review_exclude combines with automerge", () => {
    expect(parseRepoSettingsText('automerge: true\nreview_exclude:\n  - "docs/**"\n')).toEqual({
      ok: true,
      settings: {
        automerge: true,
        timeouts: {},
        reviewExclude: ["docs/**"],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("a wrong-type review_exclude is invalid", () => {
    for (const text of [
      "review_exclude: true\n",
      "review_exclude: 1\n",
      "review_exclude: null\n",
      "review_exclude: lockfile\n",
    ]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({ ok: false, error: '"review_exclude" must be a list of glob strings' });
    }
  });

  test("a blank or non-string review_exclude entry is invalid", () => {
    for (const text of [
      "review_exclude:\n  - 1\n",
      'review_exclude:\n  - ""\n',
      'review_exclude:\n  - "  "\n',
      'review_exclude:\n  - "docs/**"\n  - 1\n',
    ]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({ ok: false, error: '"review_exclude" must not contain blank entries' });
    }
  });

  test("takeover authors parse as logins", () => {
    expect(parseRepoSettingsText("takeover_authors: [renovate, Dependabot]\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: ["renovate", "Dependabot"],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
    expect(parseRepoSettingsText("takeover_authors: []\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("ignore-conflicts authors parse as logins", () => {
    expect(parseRepoSettingsText('ignore_conflicts_authors: ["renovate[bot]"]\n')).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: ["renovate[bot]"],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("former author alias spellings are invalid with a suggestion", () => {
    for (const [text, canonical] of [
      ["takeover-authors: [a]\n", "takeover_authors"],
      ["takeoverAuthors: [a]\n", "takeover_authors"],
      ["ignore-conflicts-authors: [a]\n", "ignore_conflicts_authors"],
      ["ignoreConflictsAuthors: [a]\n", "ignore_conflicts_authors"],
    ] as const) {
      const key = text.split(":")[0] as string;
      expect(parseRepoSettingsText(text)).toEqual({
        ok: false,
        error: `unknown key "${key}" (did you mean "${canonical}"?)`,
      });
    }
  });

  test("near-miss spellings of other keys suggest the canonical key", () => {
    expect(parseRepoSettingsText("review-exclude: [a]\n")).toEqual({
      ok: false,
      error: 'unknown key "review-exclude" (did you mean "review_exclude"?)',
    });
    expect(parseRepoSettingsText("maxFollowupRounds: 1\n")).toEqual({
      ok: false,
      error: 'unknown key "maxFollowupRounds" (did you mean "max_followup_rounds"?)',
    });
    expect(parseRepoSettingsText("totally-unknown: 1\n")).toEqual({
      ok: false,
      error: 'unknown key "totally-unknown"',
    });
  });

  test("author lists must be lists of non-empty strings", () => {
    for (const text of ["takeover_authors: renovate\n", "takeover_authors: 1\n", "ignore_conflicts_authors: nope\n"]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed.ok).toBe(false);
    }
    for (const text of [
      "takeover_authors: [renovate, 1]\n",
      'takeover_authors: ["", renovate]\n',
      'takeover_authors: ["  "]\n',
      'ignore_conflicts_authors: ["", renovate]\n',
      'ignore_conflicts_authors: [renovate, "  "]\n',
    ]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed.ok).toBe(false);
    }
    expect(parseRepoSettingsText("takeover_authors: []\n").ok).toBe(true);
  });

  test("duplicate authors are deduplicated, not an error", () => {
    expect(parseRepoSettingsText("takeover_authors: [renovate, renovate]\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: ["renovate"],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
    expect(parseRepoSettingsText("ignore_conflicts_authors: [a, a, b]\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: ["a", "b"],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("blocking_question_authors parses a login list", () => {
    expect(parseRepoSettingsText("blocking_question_authors:\n  - renovate-bot\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: ["renovate-bot"],
        mode: "full",
      },
    });
    expect(parseRepoSettingsText("automerge: true\nblocking_question_authors:\n  - Alice\n  - renovate-bot\n")).toEqual(
      {
        ok: true,
        settings: {
          automerge: true,
          timeouts: {},
          reviewExclude: [],
          followupOnSuggestions: true,
          takeoverAuthors: [],
          ignoreConflictsAuthors: [],
          blockingQuestionAuthors: ["Alice", "renovate-bot"],
          mode: "full",
        },
      }
    );
  });

  test("absent blocking_question_authors means none", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: {
        automerge: true,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("a wrong-type blocking list is invalid", () => {
    for (const text of [
      "blocking_question_authors: renovate-bot\n",
      "blocking_question_authors: 1\n",
      "blocking_question_authors: null\n",
    ]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({ ok: false, error: '"blocking_question_authors" must be a list of logins' });
    }
  });

  test("a blank or non-string blocking entry is invalid", () => {
    for (const text of [
      "blocking_question_authors:\n  - renovate-bot\n  - 1\n",
      'blocking_question_authors:\n  - ""\n',
      'blocking_question_authors:\n  - "  "\n',
    ]) {
      const parsed = parseRepoSettingsText(text);
      expect(parsed).toEqual({ ok: false, error: '"blocking_question_authors" must not contain blank entries' });
    }
  });

  test("mode parses the three repository modes", () => {
    expect(parseRepoSettingsText("mode: full\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
    expect(parseRepoSettingsText("mode: review-only\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "review-only",
      },
    });
    expect(parseRepoSettingsText("mode: off\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "off",
      },
    });
  });

  test("absent mode means full", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: {
        automerge: true,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("a wrong-type mode is invalid", () => {
    for (const text of ["mode: 1\n", "mode: null\n", "mode: []\n", "mode: Full\n", "mode: disabled\n", "mode:\n"]) {
      expect(parseRepoSettingsText(text)).toEqual({
        ok: false,
        error: '"mode" must be one of "full", "review-only", "off"',
      });
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
    ).toEqual({
      state: "valid",
      automerge: true,
      timeouts: {},
      reviewExclude: [],
      followupOnSuggestions: true,
      takeoverAuthors: [],
      ignoreConflictsAuthors: [],
      blockingQuestionAuthors: [],
      mode: "full",
    });
  });

  test("valid file loads review_exclude", async () => {
    expect(
      await loadRepoSettings(
        { getRepoFile: async () => ({ found: true, content: 'review_exclude:\n  - "**/generated/**"\n' }) },
        "o",
        "r",
        "main"
      )
    ).toEqual({
      state: "valid",
      automerge: false,
      timeouts: {},
      reviewExclude: ["**/generated/**"],
      followupOnSuggestions: true,
      takeoverAuthors: [],
      ignoreConflictsAuthors: [],
      blockingQuestionAuthors: [],
      mode: "full",
    });
  });

  test("valid file loads the mode", async () => {
    expect(
      await loadRepoSettings({ getRepoFile: async () => ({ found: true, content: "mode: off\n" }) }, "o", "r", "main")
    ).toEqual({
      state: "valid",
      automerge: false,
      timeouts: {},
      reviewExclude: [],
      followupOnSuggestions: true,
      takeoverAuthors: [],
      ignoreConflictsAuthors: [],
      blockingQuestionAuthors: [],
      mode: "off",
    });
  });

  test("valid file loads author lists", async () => {
    expect(
      await loadRepoSettings(
        {
          getRepoFile: async () => ({
            found: true,
            content:
              'takeover_authors: [renovate]\nignore_conflicts_authors: ["renovate[bot]"]\nblocking_question_authors: [alice]\n',
          }),
        },
        "o",
        "r",
        "main"
      )
    ).toEqual({
      state: "valid",
      automerge: false,
      timeouts: {},
      reviewExclude: [],
      followupOnSuggestions: true,
      takeoverAuthors: ["renovate"],
      ignoreConflictsAuthors: ["renovate[bot]"],
      blockingQuestionAuthors: ["alice"],
      mode: "full",
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

describe("effectiveBlockingQuestionAuthors", () => {
  test("merges deployer and repo lists without removing deployer logins", () => {
    expect(
      effectiveBlockingQuestionAuthors(["deployer-bot"], {
        state: "valid",
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: ["repo-bot", "DEPLOYER-bot"],
        mode: "full",
      })
    ).toEqual(["deployer-bot", "repo-bot"]);
  });

  test("missing or invalid files contribute nothing", () => {
    expect(effectiveBlockingQuestionAuthors(["deployer-bot"], { state: "missing" })).toEqual(["deployer-bot"]);
    expect(effectiveBlockingQuestionAuthors(["deployer-bot"], { state: "invalid", error: "bad" })).toEqual([
      "deployer-bot",
    ]);
    expect(effectiveBlockingQuestionAuthors([], { state: "missing" })).toEqual([]);
  });
});

describe("repoMode", () => {
  test("missing or invalid files fall back to full", () => {
    expect(repoMode({ state: "missing" })).toBe("full");
    expect(repoMode({ state: "invalid", error: "bad" })).toBe("full");
  });

  test("valid files return their mode", async () => {
    expect(
      repoMode({
        state: "valid",
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      })
    ).toBe("full");
    expect(
      repoMode({
        state: "valid",
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "review-only",
      })
    ).toBe("review-only");
    expect(
      repoMode({
        state: "valid",
        automerge: true,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "off",
      })
    ).toBe("off");
  });
});

describe("loadRepoMode", () => {
  test("review-only and off load from the default branch", async () => {
    const api = { getRepoFile: async () => ({ found: true, content: "mode: review-only\n" }) };
    expect(await loadRepoMode(api, "o", "r", "main")).toBe("review-only");
    const off = { getRepoFile: async () => ({ found: true, content: "mode: off\n" }) };
    expect(await loadRepoMode(off, "o", "r", "main")).toBe("off");
  });

  test("missing, invalid, unreadable, or blank branches fall back to full", async () => {
    expect(await loadRepoMode({ getRepoFile: async () => ({ found: false }) }, "o", "r", "main")).toBe("full");
    expect(
      await loadRepoMode({ getRepoFile: async () => ({ found: true, content: "nope: 1\n" }) }, "o", "r", "main")
    ).toBe("full");
    expect(
      await loadRepoMode(
        {
          getRepoFile: async () => {
            throw new Error("GitHub API → 500");
          },
        },
        "o",
        "r",
        "main"
      )
    ).toBe("full");
    expect(
      await loadRepoMode({ getRepoFile: async () => ({ found: true, content: "mode: off\n" }) }, "o", "r", "  ")
    ).toBe("full");
  });
});

describe("resolveRepoMode", () => {
  test("resolves the default branch before reading", async () => {
    const api = {
      getRepo: async () => ({ default_branch: "main" }),
      getRepoFile: async () => ({ found: true, content: "mode: off\n" }),
    };
    expect(await resolveRepoMode(api, "o", "r")).toBe("off");
  });

  test("falls back to full without a branch or on errors", async () => {
    expect(await resolveRepoMode({}, "o", "r")).toBe("full");
    expect(await resolveRepoMode({ getRepo: async () => ({ default_branch: "  " }) }, "o", "r")).toBe("full");
    expect(
      await resolveRepoMode(
        {
          getRepo: async () => {
            throw new Error("boom");
          },
        },
        "o",
        "r"
      )
    ).toBe("full");
  });
});

describe("loadEffectiveBlockingQuestionAuthors", () => {
  test("repo file adds authors the deployer did not list", async () => {
    const api = {
      getRepoFile: async () => ({ found: true, content: "blocking_question_authors:\n  - repo-bot\n" }),
    };
    expect(await loadEffectiveBlockingQuestionAuthors(api, "o", "r", "main", [])).toEqual(["repo-bot"]);
    expect(await loadEffectiveBlockingQuestionAuthors(api, "o", "r", "main", ["deployer-bot"])).toEqual([
      "deployer-bot",
      "repo-bot",
    ]);
  });

  test("missing file falls back to the deployer list", async () => {
    const api = { getRepoFile: async () => ({ found: false }) };
    expect(await loadEffectiveBlockingQuestionAuthors(api, "o", "r", "main", ["deployer-bot"])).toEqual([
      "deployer-bot",
    ]);
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
      settings: {
        automerge: false,
        timeouts: { review: 10, implement: 120, followup: 60, conflict: 30 },
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("absent timeouts means no overrides", () => {
    expect(parseRepoSettingsText("automerge: true\n")).toEqual({
      ok: true,
      settings: {
        automerge: true,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("empty timeouts mapping means no overrides", () => {
    expect(parseRepoSettingsText("timeouts: {}\n")).toEqual({
      ok: true,
      settings: {
        automerge: false,
        timeouts: {},
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
    });
  });

  test("unknown timeout key is invalid", () => {
    expect(parseRepoSettingsText("timeouts:\n  bogus: 10\n")).toEqual({
      ok: false,
      error: 'unknown key "timeouts.bogus"',
    });
  });

  test("near-miss timeout key suggests the canonical key", () => {
    expect(parseRepoSettingsText("timeouts:\n  Review: 10\n")).toEqual({
      ok: false,
      error: 'unknown key "timeouts.Review" (did you mean "timeouts.review"?)',
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
      effectiveTimeoutMsForKind(
        {
          state: "valid",
          automerge: false,
          timeouts: {},
          reviewExclude: [],
          followupOnSuggestions: true,
          takeoverAuthors: [],
          ignoreConflictsAuthors: [],
          blockingQuestionAuthors: [],
          mode: "full",
        },
        "review",
        900_000,
        900_000
      )
    ).toBe(900_000);
  });

  test("shorter value shortens, longer clamps to the deployer maximum", async () => {
    const { effectiveTimeoutMsForKind } = await import("../src/repo_settings.ts");
    expect(
      effectiveTimeoutMsForKind(
        {
          state: "valid",
          automerge: false,
          timeouts: { review: 5 },
          reviewExclude: [],
          followupOnSuggestions: true,
          takeoverAuthors: [],
          ignoreConflictsAuthors: [],
          blockingQuestionAuthors: [],
          mode: "full",
        },
        "review",
        900_000,
        900_000
      )
    ).toBe(300_000);
    expect(
      effectiveTimeoutMsForKind(
        {
          state: "valid",
          automerge: false,
          timeouts: { review: 60 },
          reviewExclude: [],
          followupOnSuggestions: true,
          takeoverAuthors: [],
          ignoreConflictsAuthors: [],
          blockingQuestionAuthors: [],
          mode: "full",
        },
        "review",
        900_000,
        1_800_000
      )
    ).toBe(1_800_000);
  });

  test("follow-up kind reads the followup key and lease follows the effective value", async () => {
    const { effectiveLeaseMs, effectiveTimeoutMsForKind } = await import("../src/repo_settings.ts");
    const effective = effectiveTimeoutMsForKind(
      {
        state: "valid",
        automerge: false,
        timeouts: { followup: 120 },
        reviewExclude: [],
        followupOnSuggestions: true,
        takeoverAuthors: [],
        ignoreConflictsAuthors: [],
        blockingQuestionAuthors: [],
        mode: "full",
      },
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
  const settingsFile = { filename: ".jumi.yml", status: "modified" as const, additions: 1, deletions: 0, changes: 1 };
  const otherFile = { filename: "README.md", status: "modified" as const, additions: 1, deletions: 0, changes: 1 };
  const requiredBranch = { enableStatusCheck: true, requiredContexts: ["jumi/opencode-review"] };

  test("invalid head file fails outside the automerge list", async () => {
    const failure = await invalidHeadSettingsFailure({
      api: {
        getPRFiles: async () => [settingsFile],
        getRepoFile: async () => ({ found: true, content: "automerge: 1\n" }),
      },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      automergeRepos: [],
      log,
    });
    expect(failure).toContain(".jumi.yml is invalid");
    expect(failure).toContain('"automerge" must be a boolean');
  });

  test("pull that does not touch the settings file reads no head file", async () => {
    let calls = 0;
    const failure = await invalidHeadSettingsFailure({
      api: {
        getPRFiles: async () => [otherFile],
        getRepoFile: async () => {
          calls++;
          return { found: true, content: "nope: 1\n" };
        },
      },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      log,
    });
    expect(failure).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("pre-fetched changed files skip the pull file list", async () => {
    let fileCalls = 0;
    let headCalls = 0;
    const failure = await invalidHeadSettingsFailure({
      api: {
        getPRFiles: async () => {
          fileCalls++;
          return [settingsFile];
        },
        getRepoFile: async () => {
          headCalls++;
          return { found: true, content: "automerge: true\n" };
        },
      },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      changedFiles: [otherFile],
      log,
    });
    expect(failure).toBeUndefined();
    expect(fileCalls).toBe(0);
    expect(headCalls).toBe(0);
  });

  test("invalid review_exclude in the head file fails", async () => {
    const failure = await invalidHeadSettingsFailure({
      api: { getRepoFile: async () => ({ found: true, content: "review_exclude: 1\n" }) },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      changedFiles: [settingsFile],
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
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      changedFiles: [settingsFile],
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
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      changedFiles: [settingsFile],
      log,
    });
    expect(failure).toBeUndefined();
  });

  test("unreadable pull files are fail-open", async () => {
    let headCalls = 0;
    const failure = await invalidHeadSettingsFailure({
      api: {
        getPRFiles: async () => {
          throw new Error("GitHub API → 500");
        },
        getRepoFile: async () => {
          headCalls++;
          return { found: true, content: "nope: 1\n" };
        },
      },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      log,
    });
    expect(failure).toBeUndefined();
    expect(headCalls).toBe(0);
  });

  test("head mode off fails where the base requires the review check", async () => {
    const failure = await invalidHeadSettingsFailure({
      api: {
        getRepoFile: async () => ({ found: true, content: "mode: off\n" }),
        getBranch: async () => requiredBranch,
      },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      changedFiles: [settingsFile],
      log,
    });
    expect(failure).toContain(".jumi.yml sets mode: off");
    expect(failure).toContain("`jumi/opencode-review` is required on main");
    expect(failure).toContain("unable to merge");
  });

  test("head mode off passes where the base does not require the check", async () => {
    for (const branch of [
      { enableStatusCheck: false, requiredContexts: ["jumi/opencode-review"] },
      { enableStatusCheck: true, requiredContexts: ["other-check"] },
      { enableStatusCheck: true, requiredContexts: [] },
    ]) {
      const failure = await invalidHeadSettingsFailure({
        api: {
          getRepoFile: async () => ({ found: true, content: "mode: off\n" }),
          getBranch: async () => branch,
        },
        owner: "o",
        repo: "r",
        prNumber: 7,
        headSha: "abc",
        baseBranch: "main",
        changedFiles: [settingsFile],
        log,
      });
      expect(failure).toBeUndefined();
    }
  });

  test("head mode off is fail-open when the branch is unreadable", async () => {
    const failure = await invalidHeadSettingsFailure({
      api: {
        getRepoFile: async () => ({ found: true, content: "mode: off\n" }),
        getBranch: async () => {
          throw new Error("GitHub API → 500");
        },
      },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      changedFiles: [settingsFile],
      log,
    });
    expect(failure).toBeUndefined();
  });

  test("head mode review-only passes with the check required", async () => {
    const failure = await invalidHeadSettingsFailure({
      api: {
        getRepoFile: async () => ({ found: true, content: "mode: review-only\n" }),
        getBranch: async () => requiredBranch,
      },
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "abc",
      baseBranch: "main",
      changedFiles: [settingsFile],
      log,
    });
    expect(failure).toBeUndefined();
  });
});

describe("publishReviewResult head settings file listing", () => {
  function publishApi(calls: { prFiles: number; refs: string[] }): ReviewApi {
    return {
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      getPR: async () => makePR(),
      getPRFiles: async () => {
        calls.prFiles++;
        return [makeFile({ filename: "README.md" })];
      },
      getRepoFile: async (_owner, _repo, _path, ref) => {
        calls.refs.push(ref);
        return { found: true, content: "automerge: true\n" };
      },
      getIssue: async () => {
        throw new Error("not used");
      },
      listIssueComments: async () => [],
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_owner, _repo, _index, body) => makeComment({ id: 1, body }),
      updateIssueComment: async (_owner, _repo, commentId, body) => makeComment({ id: commentId, body }),
      listPullReviewComments: async () => [],
      listPullReviews: async () => [],
      createPullReview: async () => ({ id: 1 }),
      submitPullReview: async () => ({ id: 1 }),
      resolvePullComment: async () => undefined,
      unresolvePullComment: async () => undefined,
      dismissPullReview: async () => ({ id: 1 }),
      createCommitStatus: async (_owner, _repo, _sha, status) => status,
      ...emptyCiMethods(),
      listCommitStatuses: async () => [],
    };
  }

  const publishOpts = {
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    expectedHeadSha: "headsha",
    botUsername: "jumi",
    logger: () => undefined,
  };

  test("reuses pre-fetched changedFiles instead of listing PR files", async () => {
    const calls = { prFiles: 0, refs: [] as string[] };
    const result = await publishReviewResult({
      ...publishOpts,
      api: publishApi(calls),
      changedFiles: [{ filename: "README.md" }],
    });
    expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
    expect(calls.prFiles).toBe(0);
    expect(calls.refs).not.toContain("headsha");
  });

  test("lists PR files itself when changedFiles is unset (reclaim path)", async () => {
    const calls = { prFiles: 0, refs: [] as string[] };
    const result = await publishReviewResult({
      ...publishOpts,
      api: publishApi(calls),
    });
    expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
    expect(calls.prFiles).toBe(1);
    expect(calls.refs).not.toContain("headsha");
  });
});
