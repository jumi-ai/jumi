import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_REVIEW_SETTING_SOURCES,
  CLAUDE_SETTING_SOURCES,
  claudeArgv,
  claudeReviewBasePrompt,
} from "../src/claude.ts";
import { codexArgv } from "../src/codex.ts";
import { buildEnv } from "../src/git.ts";
import { buildPROpenedPrompt } from "../src/prompt.ts";
import { stageBaseSkillsIntoWorkdir, writeCodexReviewHome } from "../src/review_base.ts";
import { makeFile, makePR, makeRepo } from "./fixtures.ts";

describe("review isolation", () => {
  test("claude workers keep project sources, reviews use user only", () => {
    const worker = claudeArgv({ model: "opus", workdir: "/work" });
    expect(worker[worker.indexOf("--setting-sources") + 1]).toBe(CLAUDE_SETTING_SOURCES);
    const review = claudeArgv({
      model: "opus",
      workdir: "/work",
      trace: { kind: "review", owner: "o", repo: "r" },
    });
    expect(review[review.indexOf("--setting-sources") + 1]).toBe(CLAUDE_REVIEW_SETTING_SOURCES);
    expect(CLAUDE_REVIEW_SETTING_SOURCES).toBe("user");
  });

  test("claude review carries the base plugin and base prompt, workers carry neither", () => {
    const worker = claudeArgv({ model: "opus", workdir: "/work" });
    expect(worker).not.toContain("--append-system-prompt");
    const review = claudeArgv(
      { model: "opus", workdir: "/work", trace: { kind: "review", owner: "o", repo: "r" } },
      "/tmp/image-skills",
      "/tmp/base-skills",
      "base instructions"
    );
    expect(review.filter((arg) => arg === "--plugin-dir")).toHaveLength(2);
    expect(review).toContain("/tmp/base-skills");
    expect(review[review.indexOf("--append-system-prompt") + 1]).toBe("base instructions");
  });

  test("claude review base prompt reads the staged base dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "base-prompt-"));
    try {
      await writeFile(join(dir, "AGENTS.md"), "base agents\n");
      const prompt = await claudeReviewBasePrompt(dir);
      expect(prompt).toContain("base agents");
      expect(prompt).toContain("base branch");
      expect(await claudeReviewBasePrompt(join(dir, "missing"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("codex workers bypass hook trust, reviews do not (fresh and resume)", () => {
    const worker = codexArgv({ model: "gpt-5.5", workdir: "/work" });
    expect(worker).toContain("--dangerously-bypass-hook-trust");
    const review = codexArgv({
      model: "gpt-5.5",
      workdir: "/work",
      trace: { kind: "review", owner: "o", repo: "r" },
    });
    expect(review).not.toContain("--dangerously-bypass-hook-trust");
    const workerResume = codexArgv({ model: "gpt-5.5", workdir: "/work", continueSession: true }, "thread-9");
    expect(workerResume).toContain("--dangerously-bypass-hook-trust");
    const reviewResume = codexArgv(
      { model: "gpt-5.5", workdir: "/work", continueSession: true, trace: { kind: "review", owner: "o", repo: "r" } },
      "thread-9"
    );
    expect(reviewResume).not.toContain("--dangerously-bypass-hook-trust");
  });

  test("opencode reviews disable project config, workers do not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oc-env-"));
    try {
      const dbPath = join(dir, "db");
      const worker = buildEnv({ model: "m", workdir: dir, sanitizeEnv: true }, dir, dbPath);
      expect(worker?.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
      const review = buildEnv(
        { model: "m", workdir: dir, sanitizeEnv: true, trace: { kind: "review", owner: "o", repo: "r" } },
        dir,
        dbPath
      );
      expect(review?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("review prompt carries the base instructions, never the head", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [makeFile()],
      baseInstructions: { text: "BASE-MARKER", truncated: false },
    });
    expect(prompt).toContain("BASE-MARKER");
    expect(prompt).toContain("<base_instructions");
    expect(prompt).not.toContain("HEAD-MARKER");
    const plain = buildPROpenedPrompt({ repo: makeRepo(), pr: makePR(), prFiles: [makeFile()] });
    expect(plain).not.toContain("<base_instructions");
  });

  test("codex review home marks the workdir untrusted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-home-"));
    try {
      const home = join(dir, "codex-home");
      await writeCodexReviewHome(home, "/work/dir");
      const text = await readFile(join(home, "config.toml"), "utf8");
      expect(text).toContain('trust_level = "untrusted"');
      expect(text).toContain('"/work/dir"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("workdir staging hides head skills and stages the base, then restores", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "work-"));
    const base = await mkdtemp(join(tmpdir(), "base-"));
    try {
      await mkdir(join(workdir, ".agents", "skills", "head-skill"), { recursive: true });
      await writeFile(join(workdir, ".agents", "skills", "head-skill", "SKILL.md"), "head\n");
      await mkdir(join(base, "skills", "base-skill"), { recursive: true });
      await writeFile(join(base, "skills", "base-skill", "SKILL.md"), "base\n");
      const staging = await stageBaseSkillsIntoWorkdir(workdir, base);
      await expect(readFile(join(workdir, ".agents", "skills", "head-skill", "SKILL.md"), "utf8")).rejects.toThrow();
      expect(await readFile(join(workdir, ".agents", "skills", "base-skill", "SKILL.md"), "utf8")).toBe("base\n");
      await staging.cleanup();
      expect(await readFile(join(workdir, ".agents", "skills", "head-skill", "SKILL.md"), "utf8")).toBe("head\n");
    } finally {
      await rm(workdir, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  });
});
