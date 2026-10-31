import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEngineScratchIgnored,
  ENGINE_TEMP_DIR,
  engineScratchUntrackedNotIgnored,
  ensureEngineScratchIgnored,
} from "../src/engine_scratch.ts";
import { resetOpenCodeVersionForTests, runOpenCode, setOpenCodeMajorForTests } from "../src/git.ts";
import { type GitAuth, workerOpenCodeChildEnv } from "../src/workspace.ts";

const originalPath = process.env.PATH;
const originalHome = process.env.HOME;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetOpenCodeVersionForTests();
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "jumi-scratch-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "README.md"), "hi\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "init"]);
}

async function linkedWorktree(root: string, name: string): Promise<string> {
  const seed = join(root, "seed");
  await seedRepo(seed);
  const bare = join(root, "bare.git");
  git(root, ["clone", "--bare", seed, bare]);
  const worktree = join(root, name);
  git(root, ["--git-dir", bare, "worktree", "add", worktree, "main"]);
  return worktree;
}

async function writeScratch(dir: string) {
  await mkdir(join(dir, ENGINE_TEMP_DIR), { recursive: true });
  await writeFile(join(dir, ENGINE_TEMP_DIR, "auth.json"), '{"token":"secret"}\n');
}

function cachedNames(dir: string): string[] {
  return git(dir, ["diff", "--cached", "--name-only"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("engine scratch ignore", () => {
  test("a check that only sees the directory as untracked, and not ignored, fails", () => {
    const untracked = '?? .jumi-tmp/\n?? ".jumi-tmp/odd name"\n';
    expect(engineScratchUntrackedNotIgnored(untracked)).toBe(true);
    expect(() => assertEngineScratchIgnored(untracked)).toThrow(/untracked, not ignored/);
    expect(() => assertEngineScratchIgnored("!! .jumi-tmp/\n")).not.toThrow();
  });

  test("git add of a linked worktree stages nothing from the scratch dir once it is ignored", async () => {
    await withRoot(async (root) => {
      const worktree = await linkedWorktree(root, "wt");
      expect(await ensureEngineScratchIgnored(worktree)).toBe(true);
      await writeScratch(worktree);
      await writeFile(join(worktree, "src.txt"), "change\n");
      git(worktree, ["add", "-A"]);
      git(worktree, ["add", "."]);
      git(worktree, ["add", "--all"]);
      const staged = cachedNames(worktree);
      expect(staged).toEqual(["src.txt"]);
      expect(staged.some((path) => path === ENGINE_TEMP_DIR || path.startsWith(`${ENGINE_TEMP_DIR}/`))).toBe(false);
      git(worktree, ["commit", "-qm", "child"]);
      const tree = git(worktree, ["ls-tree", "-r", "--name-only", "HEAD"]);
      expect(tree).not.toContain(ENGINE_TEMP_DIR);
      const ignored = git(worktree, ["status", "--porcelain", "--ignored", "--", ENGINE_TEMP_DIR]);
      expect(ignored).toContain("!! .jumi-tmp/");
      expect(() => assertEngineScratchIgnored(ignored)).not.toThrow();
    });
  });

  test("without the exclude, add stages the scratch dir and the untracked check fails", async () => {
    await withRoot(async (root) => {
      const worktree = await linkedWorktree(root, "wt");
      await writeScratch(worktree);
      const status = git(worktree, ["status", "--porcelain", "--ignored", "--", ENGINE_TEMP_DIR]);
      expect(status).toContain("?? .jumi-tmp/");
      expect(() => assertEngineScratchIgnored(status)).toThrow(/untracked, not ignored/);
      git(worktree, ["add", "-A"]);
      expect(cachedNames(worktree).some((path) => path.startsWith(`${ENGINE_TEMP_DIR}/`))).toBe(true);
    });
  });

  test.each([
    [
      "gitea",
      {
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
      } satisfies GitAuth,
    ],
    [
      "github",
      {
        giteaUrl: "https://github.com",
        username: "x-access-token",
        token: "ghs_test",
        embedTokenInUrl: true,
        authorName: "kirmanak-jumi[bot]",
        authorEmail: "198765+kirmanak-jumi[bot]@users.noreply.github.com",
      } satisfies GitAuth,
    ],
  ])("after a spawn, adding everything stages nothing from the scratch dir (%s)", async (_forge, auth) => {
    await withRoot(async (root) => {
      const worktree = await linkedWorktree(root, "wt");
      const home = await mkdtemp(join(tmpdir(), "jumi-scratch-home-"));
      const binDir = await mkdtemp(join(tmpdir(), "jumi-scratch-bin-"));
      try {
        const script = `#!/bin/sh
set -eu
cd ${worktree}
mkdir -p .jumi-tmp
printf '%s\\n' secret > .jumi-tmp/auth.json
printf '%s\\n' change >> README.md
git add -A
git add .
git add --all
export GIT_AUTHOR_NAME=child GIT_AUTHOR_EMAIL=child@example.com
export GIT_COMMITTER_NAME=child GIT_COMMITTER_EMAIL=child@example.com
git commit -qm child
echo CACHED_START
git diff --cached --name-only
echo CACHED_END
echo TREE_START
git ls-tree -r --name-only HEAD
echo TREE_END
echo IGNORED_START
git status --porcelain --ignored -- .jumi-tmp
echo IGNORED_END
`;
        await writeFile(join(binDir, "opencode"), script);
        await chmod(join(binDir, "opencode"), 0o755);
        process.env.PATH = `${binDir}:${originalPath ?? ""}`;
        process.env.HOME = home;
        setOpenCodeMajorForTests(1);
        const result = await runOpenCode({
          prompt: "implement",
          model: "openai/gpt-5.5",
          workdir: worktree,
          home,
          sanitizeEnv: true,
          extraEnv: workerOpenCodeChildEnv(auth, worktree),
          // Production worker spawns always carry the claimed repo, and the
          // git credential proxy refuses to start without it.
          trace: { kind: "implement", owner: "acme", repo: "demo" },
        });
        expect(result.status).toBe("ok");
        const stdout = result.stdout ?? "";
        const tree = stdout.split("TREE_START")[1]?.split("TREE_END")[0] ?? "";
        const ignored = stdout.split("IGNORED_START")[1]?.split("IGNORED_END")[0] ?? "";
        expect(tree).not.toContain(ENGINE_TEMP_DIR);
        expect(tree).toContain("README.md");
        expect(ignored).toContain("!! .jumi-tmp/");
        expect(() => assertEngineScratchIgnored(ignored)).not.toThrow();
        const exclude = await readFile(join(root, "bare.git", "info", "exclude"), "utf8");
        expect(exclude).toContain(".jumi-tmp/");
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(binDir, { recursive: true, force: true });
      }
    });
  });
});
