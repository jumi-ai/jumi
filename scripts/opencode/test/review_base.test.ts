import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stageBaseReviewInstructions,
  stageBaseSkillsForClaude,
  stageBaseSkillsIntoWorkdir,
} from "../src/review_base.ts";
import type { GitRunner } from "../src/workspace.ts";

const BASE = "a".repeat(40);

function stubGit(files: Record<string, string>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === "ls-tree") {
      const paths = args.filter((arg) => !arg.startsWith("-") && arg !== "ls-tree" && arg !== BASE);
      // `ls-tree -r -l <base> -- roots...` lists every file under those roots.
      const names = Object.keys(files).filter((name) =>
        paths.some((want) => name === want || name.startsWith(`${want}/`))
      );
      return names
        .map((name) => `100644 blob ${"b".repeat(40)} ${Buffer.byteLength(files[name] ?? "", "utf8")}\t${name}`)
        .join("\n");
    }
    if (args[0] === "show") {
      const refPath = args[1] ?? "";
      const path = refPath.slice(BASE.length + 1);
      const content = files[path];
      if (content === undefined) throw new Error(`no such blob ${path}`);
      return content;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { git, calls };
}

describe("stageBaseReviewInstructions", () => {
  test("stages base AGENTS.md and skills, ignoring head-only content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "base-"));
    try {
      const { git } = stubGit({
        "AGENTS.md": "BASE-MARKER\n",
        ".claude/skills/base-skill/SKILL.md": "base skill\n",
      });
      const staged = await stageBaseReviewInstructions({ git, cwd: ".", env: {}, baseRef: BASE }, join(dir, "base"));
      expect(staged.files).toEqual(["AGENTS.md"]);
      expect(staged.skills).toEqual(["base-skill"]);
      expect(staged.truncated).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stages nothing when the base has no instruction files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "base-"));
    try {
      const { git, calls } = stubGit({});
      const staged = await stageBaseReviewInstructions({ git, cwd: ".", env: {}, baseRef: BASE }, join(dir, "base"));
      expect(staged.files).toEqual([]);
      expect(staged.skills).toEqual([]);
      expect(calls.map((args) => args[0])).toEqual(["ls-tree", "ls-tree", "ls-tree"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips oversize files and reports truncation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "base-"));
    try {
      const { git } = stubGit({ "AGENTS.md": "x".repeat(100) });
      const staged = await stageBaseReviewInstructions({ git, cwd: ".", env: {}, baseRef: BASE }, join(dir, "base"), {
        maxBytes: 10,
      });
      expect(staged.files).toEqual([]);
      expect(staged.truncated).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a non-SHA base ref without calling git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "base-"));
    try {
      const { git, calls } = stubGit({ "AGENTS.md": "base\n" });
      const staged = await stageBaseReviewInstructions(
        { git, cwd: ".", env: {}, baseRef: "not-a-sha" },
        join(dir, "base")
      );
      expect(staged.files).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never follows a base symlink outside the staging dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "base-"));
    try {
      const git: GitRunner = async (args) => {
        if (args[0] === "ls-tree" && !args.includes("-r")) return `120000 blob ${"b".repeat(40)} 9\tAGENTS.md`;
        if (args[0] === "ls-tree") return "";
        throw new Error(`unexpected git ${args.join(" ")}`);
      };
      const staged = await stageBaseReviewInstructions({ git, cwd: ".", env: {}, baseRef: BASE }, join(dir, "base"));
      expect(staged.files).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stages skills from all three roots, including flat files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "base-"));
    try {
      const { git } = stubGit({
        ".claude/skills/claude-skill/SKILL.md": "claude skill\n",
        ".agents/skills/dir-skill/SKILL.md": "dir skill\n",
        ".opencode/skills/opencode-skill/SKILL.md": "opencode skill\n",
        ".claude/skills/flat-skill.md": "# flat skill\n",
      });
      const staged = await stageBaseReviewInstructions({ git, cwd: ".", env: {}, baseRef: BASE }, join(dir, "base"));
      expect(staged.skills.sort()).toEqual(["claude-skill", "dir-skill", "flat-skill", "opencode-skill"]);
      expect(await readFile(join(dir, "base", "skills", "opencode-skill", "SKILL.md"), "utf8")).toBe(
        "opencode skill\n"
      );
      expect(await readFile(join(dir, "base", "skills", "flat-skill.md"), "utf8")).toBe("# flat skill\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("staged skill shape", () => {
  test("claude plugin keeps skill dirs and flat files, skipping non-skill dirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "base-"));
    try {
      const { git } = stubGit({
        ".agents/skills/good/SKILL.md": "good\n",
        ".agents/skills/flat.md": "flat\n",
        ".agents/skills/notaskill/notes.txt": "notes\n",
      });
      const base = join(dir, "base");
      await stageBaseReviewInstructions({ git, cwd: ".", env: {}, baseRef: BASE }, base);
      const dest = join(dir, "plugin");
      expect(await stageBaseSkillsForClaude(dest, base)).toBe(dest);
      expect(await readFile(join(dest, "skills", "good", "SKILL.md"), "utf8")).toBe("good\n");
      expect(await readFile(join(dest, "skills", "flat.md"), "utf8")).toBe("flat\n");
      await expect(readFile(join(dest, "skills", "notaskill", "notes.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("workdir staging carries flat files and restores the hidden .opencode root", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "work-"));
    const base = await mkdtemp(join(tmpdir(), "base-"));
    try {
      await mkdir(join(workdir, ".opencode", "skills", "head-skill"), { recursive: true });
      await writeFile(join(workdir, ".opencode", "skills", "head-skill", "SKILL.md"), "head\n");
      await mkdir(join(base, "skills", "base-skill"), { recursive: true });
      await writeFile(join(base, "skills", "base-skill", "SKILL.md"), "base\n");
      await writeFile(join(base, "skills", "flat.md"), "flat\n");
      const staging = await stageBaseSkillsIntoWorkdir(workdir, base);
      await expect(readFile(join(workdir, ".opencode", "skills", "head-skill", "SKILL.md"), "utf8")).rejects.toThrow();
      expect(await readFile(join(workdir, ".agents", "skills", "base-skill", "SKILL.md"), "utf8")).toBe("base\n");
      expect(await readFile(join(workdir, ".agents", "skills", "flat.md"), "utf8")).toBe("flat\n");
      await staging.cleanup();
      expect(await readFile(join(workdir, ".opencode", "skills", "head-skill", "SKILL.md"), "utf8")).toBe("head\n");
      await expect(readFile(join(workdir, ".agents", "skills", "base-skill", "SKILL.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(workdir, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  });

  test("an empty base dir stages nothing without touching the CWD", async () => {
    const dir = await mkdtemp(join(tmpdir(), "base-"));
    try {
      expect(await stageBaseSkillsForClaude(join(dir, "plugin"), "")).toBeUndefined();
      const staging = await stageBaseSkillsIntoWorkdir(dir, "");
      await staging.cleanup();
      await expect(readFile(join("skills", "probe.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
