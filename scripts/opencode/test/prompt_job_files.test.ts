import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKED_BY_REJECTED_PROMPT,
  CONFLICT_PROMPT,
  FOLLOWUP_PROMPT,
  formatInjectedFilesLine,
  IMPLEMENT_PROMPT,
  IMPLEMENT_YIELD_PROMPT,
  listInjectedFiles,
  resolveOpenCodePrompt,
  WORKER_INJECTED_FILES,
} from "../src/git.ts";
import { buildPROpenedPrompt } from "../src/prompt.ts";
import { JUMI_SENTINEL_FILES } from "../src/sentinels.ts";
import { makePR, makeRepo } from "./fixtures.ts";

function reviewerPrompt(): string {
  return buildPROpenedPrompt({ repo: makeRepo(), pr: makePR(), prFiles: [] });
}

describe("reviewer no re-run", () => {
  test("reviewer prompt tells the agent not to re-run suites covered by a green check and to run only targeted checks", () => {
    const prompt = reviewerPrompt();
    expect(prompt).toContain("do not re-run that suite locally");
    expect(prompt).toContain("run only targeted checks");
    expect(prompt).toContain("render one changed chart");
    expect(prompt).toContain("run the one changed test");
    expect(prompt).toContain("lint one changed file");
    expect(prompt).toContain("workflow files");
  });

  test("reviewer prompt does not treat required=false or failed checks as coverage", () => {
    const prompt = reviewerPrompt();
    expect(prompt).toContain('required="false"');
    expect(prompt).toContain("not coverage");
    expect(prompt).toContain("non-success");
  });

  test("review-proof skill tells the agent not to re-run suites covered by a green check", async () => {
    const skill = readFileSync(join(process.cwd(), "../../review-skills/review-proof/SKILL.md"), "utf8");
    expect(skill).toContain("do not re-run that suite locally");
    expect(skill).toContain("run only targeted checks");
    expect(skill).toContain("not coverage");
  });
});

describe("no polling loops", () => {
  test("reviewer and worker prompts forbid sleep/until-grep polling loops and name foreground-with-timeout or background-notify", () => {
    const reviewer = reviewerPrompt();
    for (const prompt of [reviewer, IMPLEMENT_PROMPT, FOLLOWUP_PROMPT, CONFLICT_PROMPT]) {
      expect(prompt).toContain("sleep");
      expect(prompt).toContain("until");
      expect(prompt).toContain("grep");
      expect(prompt).toContain("pgrep");
      expect(prompt).toContain("foreground");
      expect(prompt).toContain("timeout");
      expect(prompt).toContain("background");
      expect(prompt).toContain("completion notification");
    }
  });
});

async function withWorktreeFiles(files: readonly string[], run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-injected-"));
  try {
    for (const name of files) await writeFile(join(dir, name), `${name}\n`);
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function injectedLine(prompt: string): string {
  const match = /Injected files for this job: ([^\n]*)\. No others exist\./.exec(prompt);
  expect(match).not.toBeNull();
  return match![1]!.trim();
}

describe("worker injected files", () => {
  test("injected list matches the sentinel set", () => {
    expect([...WORKER_INJECTED_FILES].sort() as string[]).toEqual([...JUMI_SENTINEL_FILES].sort() as string[]);
  });

  test("worker prompt lists exactly the JUMI_*.md files present", async () => {
    const cases: Array<{ files: string[]; kind?: "implement" | "follow-up" | "conflict" }> = [
      { files: ["JUMI_TASK.md"], kind: "implement" },
      { files: ["JUMI_TASK.md", "JUMI_QUEUE.md"], kind: "implement" },
      { files: ["JUMI_TASK.md", "JUMI_FEEDBACK.md"], kind: "follow-up" },
      { files: ["JUMI_TASK.md", "JUMI_FEEDBACK.md", "JUMI_CI.md"], kind: "follow-up" },
      { files: ["JUMI_TASK.md", "JUMI_FEEDBACK.md", "JUMI_CI.md", "JUMI_PR.md"], kind: "follow-up" },
      { files: ["JUMI_TASK.md", "JUMI_FEEDBACK.md", "JUMI_PR.md"], kind: "follow-up" },
      { files: ["JUMI_TASK.md", "JUMI_CONFLICT.md"], kind: "conflict" },
      { files: ["JUMI_TASK.md", "JUMI_CONFLICT.md", "JUMI_CI.md"], kind: "conflict" },
      {
        files: ["JUMI_TASK.md", "JUMI_CONFLICT.md", "JUMI_CI.md", "JUMI_HANDOFF.md", "JUMI_ATTACHMENTS.md"],
        kind: "conflict",
      },
      {
        files: ["JUMI_TASK.md", "JUMI_FEEDBACK.md", "JUMI_HANDOFF.md", "JUMI_ATTACHMENTS.md"],
        kind: "follow-up",
      },
      { files: ["JUMI_TASK.md", "JUMI_QUEUE.md", "JUMI_HANDOFF.md"], kind: "implement" },
    ];
    for (const { files, kind } of cases) {
      await withWorktreeFiles(files, async (dir) => {
        const prompt = await resolveOpenCodePrompt({
          model: "m",
          workdir: dir,
          ...(kind ? { trace: { kind, owner: "o", repo: "r" } } : {}),
        });
        expect(injectedLine(prompt)).toBe(files.join(", "));
        expect(prompt).toContain(formatInjectedFilesLine(files));
        // The exact present set is listed, in sentinel order.
        expect(await listInjectedFiles(dir)).toEqual(files);
      });
    }
  });

  test("worker prompt never names an absent file", async () => {
    // No Read instruction may name a file that is not injected. Conditional
    // "If/When ... present/exists" and output "write ..." sentences are the
    // only other places a JUMI_*.md name may appear.
    await withWorktreeFiles(["JUMI_TASK.md"], async (dir) => {
      const prompt = await resolveOpenCodePrompt({
        model: "m",
        workdir: dir,
        trace: { kind: "implement", owner: "o", repo: "r" },
      });
      const present = new Set(["JUMI_TASK.md"]);
      for (const match of prompt.matchAll(/Read (JUMI_[A-Z]+\.md)/g)) {
        expect(present.has(match[1]!)).toBe(true);
      }
      expect(prompt).not.toContain("The only Jumi files to read are");
      // Absent read-targets are not instructed.
      expect(prompt).not.toContain("Read JUMI_QUEUE.md");
      expect(prompt).not.toContain("Read JUMI_FEEDBACK.md");
      expect(prompt).not.toContain("Read JUMI_CONFLICT.md");
      expect(prompt).not.toContain("Read JUMI_CI.md");
    });
    await withWorktreeFiles(["JUMI_TASK.md", "JUMI_FEEDBACK.md"], async (dir) => {
      const prompt = await resolveOpenCodePrompt({
        model: "m",
        workdir: dir,
        trace: { kind: "follow-up", owner: "o", repo: "r" },
      });
      expect(injectedLine(prompt)).toBe("JUMI_TASK.md, JUMI_FEEDBACK.md");
      expect(prompt).not.toContain("Read JUMI_QUEUE.md");
      expect(prompt).not.toContain("Read JUMI_CONFLICT.md");
    });
  });

  test("all four harness prompt paths (claude, codex, agy, opencode) get the same file list for one worktree", async () => {
    // All four engines resolve through the shared resolver in git.ts.
    for (const name of ["claude.ts", "codex.ts", "agy.ts", "git.ts"]) {
      const source = readFileSync(join(process.cwd(), "src", name), "utf8");
      expect(source).toContain("resolveOpenCodePrompt");
    }
    await withWorktreeFiles(["JUMI_TASK.md", "JUMI_FEEDBACK.md", "JUMI_CI.md"], async (dir) => {
      const bases = [
        IMPLEMENT_PROMPT,
        IMPLEMENT_YIELD_PROMPT,
        FOLLOWUP_PROMPT,
        CONFLICT_PROMPT,
        BLOCKED_BY_REJECTED_PROMPT,
      ];
      const lines = new Set<string>();
      for (const base of bases) {
        const prompt = await resolveOpenCodePrompt({ model: "m", workdir: dir, prompt: base });
        lines.add(injectedLine(prompt));
      }
      expect(lines.size).toBe(1);
      expect([...lines][0]).toBe("JUMI_TASK.md, JUMI_FEEDBACK.md, JUMI_CI.md");
      const viaKind = await resolveOpenCodePrompt({
        model: "m",
        workdir: dir,
        trace: { kind: "follow-up", owner: "o", repo: "r" },
      });
      expect(injectedLine(viaKind)).toBe("JUMI_TASK.md, JUMI_FEEDBACK.md, JUMI_CI.md");
    });
  });
});
