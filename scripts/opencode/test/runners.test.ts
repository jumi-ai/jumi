import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_HOMELAB_CONSTRAINT,
  AntigravityRefusedError,
  appendRunnerStamp,
  CLAUDE_EFFORT_LEVELS,
  CODEX_DEFAULT_EFFORT,
  CODEX_EFFORT_LEVELS,
  formatRunnerStamp,
  parseRunnersCatalog,
  parseRunnersFile,
  RUNNERS_FILE_ENV,
  refuseAntigravityUnlessGithub,
  runnerStamp,
  synthesizeRunners,
} from "../src/runners.ts";

describe("parseRunnersCatalog", () => {
  test("unknown type fails closed", () => {
    expect(() =>
      parseRunnersCatalog({
        runners: { x: { type: "hermes", model: "claude-opus" } },
        chain: ["x"],
      })
    ).toThrow("Unknown runner type: hermes");
  });

  test("registers type claude with model and optional effort", () => {
    expect(
      parseRunnersCatalog({
        runners: {
          spark: { type: "claude", model: "opus", effort: "high" },
          grok: { type: "opencode", model: "opencode/grok-4.6" },
        },
        chain: ["spark", "grok"],
      })
    ).toEqual({
      runners: {
        spark: { type: "claude", model: "opus", effort: "high" },
        grok: { type: "opencode", model: "opencode/grok-4.6" },
      },
      chain: ["spark", "grok"],
    });
  });

  test("rejects a claude effort the binary does not know", () => {
    // An unknown `--effort` does not fail the spawn — claude warns and runs at
    // the default — so a typo here would silently downgrade every run of that
    // runner, and the image probe only sees this repo's argv, never the
    // operator's file. `CLAUDE_EFFORT_LEVELS` is the set `claude_flag_probe.ts`
    // proves against the installed binary.
    expect(() =>
      parseRunnersCatalog({ runners: { spark: { type: "claude", model: "opus", effort: "hihg" } }, chain: ["spark"] })
    ).toThrow("effort hihg is not one of low, medium, high, xhigh, max");
    for (const effort of CLAUDE_EFFORT_LEVELS) {
      expect(
        parseRunnersCatalog({ runners: { spark: { type: "claude", model: "opus", effort } }, chain: ["spark"] }).runners
          .spark
      ).toEqual({ type: "claude", model: "opus", effort });
    }
  });

  test("leaves agy effort alone, whose levels are its own", () => {
    // `usesEffort` covers both, but the sets differ, so the claude check must
    // not reach agy runners.
    expect(
      parseRunnersCatalog({ runners: { a: { type: "agy", model: "m", effort: "unbounded" } }, chain: ["a"] }).runners.a
    ).toEqual({ type: "agy", model: "m", effort: "unbounded" });
  });

  test("registers type codex with model and effort, and refuses ultra", () => {
    expect(
      parseRunnersCatalog({
        runners: { cx: { type: "codex", model: "gpt-6-sol" } },
        chain: ["cx"],
      }).runners.cx
    ).toEqual({ type: "codex", model: "gpt-6-sol", effort: CODEX_DEFAULT_EFFORT });
    expect(
      parseRunnersCatalog({
        runners: { cx: { type: "codex", model: "gpt-6-sol", effort: "high" } },
        chain: ["cx"],
      }).runners.cx
    ).toEqual({ type: "codex", model: "gpt-6-sol", effort: "high" });
    for (const effort of CODEX_EFFORT_LEVELS) {
      expect(
        parseRunnersCatalog({ runners: { cx: { type: "codex", model: "m", effort } }, chain: ["cx"] }).runners.cx
      ).toEqual({ type: "codex", model: "m", effort });
    }
    expect(() =>
      parseRunnersCatalog({ runners: { cx: { type: "codex", model: "m", effort: "ultra" } }, chain: ["cx"] })
    ).toThrow("effort ultra is not one of low, medium, high, xhigh, max");
    expect(formatRunnerStamp(runnerStamp({ type: "codex", model: "gpt-6-sol", effort: "high" }))).toBe(
      "_Jumi · codex · gpt-6-sol (high)_"
    );
  });

  test("registers type agy with model and optional effort", () => {
    expect(
      parseRunnersCatalog({
        runners: {
          agy: { type: "agy", model: "gemini-3-pro", effort: "high", variant: "ignored" },
          grok: { type: "opencode", model: "opencode/grok-4.6" },
        },
        chain: ["agy", "grok"],
      })
    ).toEqual({
      runners: {
        agy: { type: "agy", model: "gemini-3-pro", effort: "high" },
        grok: { type: "opencode", model: "opencode/grok-4.6" },
      },
      chain: ["agy", "grok"],
    });
    expect(() => parseRunnersCatalog({ runners: { a: { type: "agy", model: "m", effort: 3 } }, chain: ["a"] })).toThrow(
      "invalid effort"
    );
    expect(formatRunnerStamp(runnerStamp({ type: "agy", model: "gemini-3-pro", effort: "high" }))).toBe(
      "_Jumi · agy · gemini-3-pro (high)_"
    );
  });

  test("empty chain, missing runner, and duplicate chain fail closed", () => {
    expect(() => parseRunnersCatalog({ runners: { a: { type: "opencode", model: "a/b" } }, chain: [] })).toThrow(
      "chain must not be empty"
    );
    expect(() =>
      parseRunnersCatalog({ runners: { a: { type: "opencode", model: "a/b" } }, chain: ["missing"] })
    ).toThrow("unknown runner missing");
    expect(() =>
      parseRunnersCatalog({
        runners: { a: { type: "opencode", model: "a/b" } },
        chain: ["a", "a"],
      })
    ).toThrow("duplicate runner in chain");
  });

  test("missing model fails closed", () => {
    expect(() => parseRunnersCatalog({ runners: { a: { type: "opencode" } }, chain: ["a"] })).toThrow("missing model");
  });
});

describe("parseRunnersFile", () => {
  test("invalid JSON fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-runners-parse-"));
    const file = join(dir, "runners.json");
    writeFileSync(file, "{");
    expect(() => parseRunnersFile(file)).toThrow(RUNNERS_FILE_ENV);
  });
});

describe("synthesizeRunners", () => {
  test("omits fallback when unset and never selects agy", () => {
    const catalog = synthesizeRunners({ model: "openai/gpt-5.5" });
    expect(catalog).toEqual({
      runners: { primary: { type: "opencode", model: "openai/gpt-5.5" } },
      chain: ["primary"],
    });
    expect(Object.values(catalog.runners).some((runner) => runner.type === "agy")).toBe(false);
    expect(Object.values(catalog.runners).some((runner) => runner.type === "codex")).toBe(false);
    expect(() => refuseAntigravityUnlessGithub(catalog, "gitea")).not.toThrow();
  });
});

describe("refuseAntigravityUnlessGithub", () => {
  const named = parseRunnersCatalog({
    runners: {
      spare: { type: "agy", model: "gemini-3-pro" },
      grok: { type: "opencode", model: "opencode/grok-4.6" },
    },
    chain: ["grok"],
  });

  test("homelab refuses a runners file that names agy, even off the chain", () => {
    expect(() => refuseAntigravityUnlessGithub(named, "gitea")).toThrow(AntigravityRefusedError);
    try {
      refuseAntigravityUnlessGithub(named, "gitea");
    } catch (err) {
      expect(err).toBeInstanceOf(AntigravityRefusedError);
      expect((err as AntigravityRefusedError).name).toBe("AntigravityRefusedError");
      expect((err as AntigravityRefusedError).constraint).toBe(ANTIGRAVITY_HOMELAB_CONSTRAINT);
      expect((err as Error).message).toContain("JUMI_RUNNERS_FILE names type agy (spare)");
    }
  });

  test("GitHub factory may name agy", () => {
    expect(() => refuseAntigravityUnlessGithub(named, "github")).not.toThrow();
  });
});

describe("runner stamp", () => {
  test("formats harness, model, and variant or effort", () => {
    expect(formatRunnerStamp(runnerStamp({ type: "opencode", model: "xai/grok-4.6", variant: "high" }))).toBe(
      "_Jumi · opencode · xai/grok-4.6 (high)_"
    );
    expect(formatRunnerStamp(runnerStamp({ type: "claude", model: "claude-opus-5", effort: "high" }))).toBe(
      "_Jumi · claude · claude-opus-5 (high)_"
    );
  });

  test("defaults to opencode and omits an empty level", () => {
    expect(formatRunnerStamp(runnerStamp({ model: "openai/gpt-5.5" }))).toBe("_Jumi · opencode · openai/gpt-5.5_");
    expect(runnerStamp({ type: "claude", model: "opus", variant: "xhigh" })).toEqual({ type: "claude", model: "opus" });
  });

  test("appends one visible line and leaves the body alone without a runner", () => {
    const runner = runnerStamp({ type: "opencode", model: "m", variant: "v" });
    expect(appendRunnerStamp("Opened x\n", runner)).toBe("Opened x\n\n_Jumi · opencode · m (v)_");
    expect(appendRunnerStamp("", runner)).toBe("_Jumi · opencode · m (v)_");
    expect(appendRunnerStamp("no changes", undefined)).toBe("no changes");
    expect(appendRunnerStamp("body", "_Jumi · claude · opus_")).toBe("body\n\n_Jumi · claude · opus_");
  });
});
