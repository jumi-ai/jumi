import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run with one fresh temp dir per prefix; all dirs are removed even when `run` throws. */
export async function withTempDirs<T>(prefixes: string[], run: (...dirs: string[]) => Promise<T> | T): Promise<T> {
  const dirs = await Promise.all(prefixes.map((prefix) => mkdtemp(join(tmpdir(), prefix))));
  try {
    return await run(...dirs);
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

/** Home + workdir pair used by the worker-path tests. Prefixes are normalized: no test asserts them. */
export async function withDirs<T>(run: (home: string, workdir: string) => Promise<T> | T): Promise<T> {
  return withTempDirs(["jumi-home-", "jumi-work-"], (home, workdir) => run(home!, workdir!));
}

/** Single workspace dir used by the review-path tests. */
export async function withWorkspace<T>(run: (workspace: string) => Promise<T> | T): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), "jumi-workspace-"));
  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Create a throwaway empty dir with a matching cleanup callback. */
async function tempDir(prefix = "jumi-temp-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

/** Create a throwaway git repo (initialized, no commits) with a matching cleanup callback. */
async function tempGitRepo(prefix = "jumi-git-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await tempDir(prefix);
  const proc = Bun.spawn(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return { dir, cleanup };
}
