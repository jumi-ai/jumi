import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { TraceKind } from "./engine.ts";

/** Shared pack in the image. Reviewer and worker skills stay separate files. */
export const IMAGE_SKILLS_ROOT = "/app/review-skills";
export const REVIEW_PROOF_SKILL = "review-proof";
export const WORKER_PROOF_SKILL = "worker-proof";

/** Claude plugin name for staged image skills, seen as `shared:<name>`. */
export const IMAGE_SKILLS_PLUGIN = "shared";

/** Workdir root Agy and Codex both scan for repo skills. */
export const WORKDIR_AGENT_SKILLS = join(".agents", "skills");

/** Which image skills a spawn may see. Review gets the reviewer skill only; workers get the worker skill only. */
export function imageSkillNamesForKind(kind: TraceKind | undefined): string[] {
  if (kind === "review") return [REVIEW_PROOF_SKILL];
  if (kind === "implement" || kind === "follow-up" || kind === "conflict") return [WORKER_PROOF_SKILL];
  return [];
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src)) {
    const from = join(src, entry);
    const info = await lstat(from);
    const to = join(dest, entry);
    if (info.isDirectory()) {
      await copyTree(from, to);
    } else if (info.isFile()) {
      await writeFile(to, await readFile(from));
    }
  }
}

/**
 * Stage the image skills for `kind` as a Claude plugin under `dest`.
 * Returns `dest` to pass as `--plugin-dir`, or undefined when there is nothing
 * to stage. Never throws: a missing pack stages nothing, it does not refuse.
 */
export async function stageImageSkillsForClaude(
  dest: string,
  kind: TraceKind | undefined,
  imageRoot: string = IMAGE_SKILLS_ROOT,
  log: (message: string) => void = () => undefined
): Promise<string | undefined> {
  const names = imageSkillNamesForKind(kind);
  if (names.length === 0) return undefined;
  try {
    const root = await realpath(imageRoot);
    let staged = 0;
    for (const name of names) {
      const src = join(root, name);
      try {
        const real = await realpath(src);
        if (!inside(root, real) || !(await stat(join(real, "SKILL.md"))).isFile()) continue;
      } catch {
        continue;
      }
      await copyTree(src, join(dest, "skills", name));
      staged += 1;
    }
    if (staged === 0) return undefined;
    await mkdir(join(dest, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dest, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: IMAGE_SKILLS_PLUGIN, description: "Shared image skills" }, null, 2)}\n`
    );
    return dest;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[claude] image skills not staged: ${reason}`);
    return undefined;
  }
}

export interface StagedWorkdirSkills {
  /** Directories this call created under the workdir. */
  staged: string[];
  /** Original checkout dirs moved aside, to restore on cleanup. */
  backups: Array<{ name: string; backup: string }>;
  /** Remove staged dirs and restore backups. Never throws. */
  cleanup: () => Promise<void>;
}

/**
 * Stage the image skills for `kind` into `<workdir>/.agents/skills/` for Agy
 * and Codex, which both scan that repo-local root. Workers get the worker
 * skill only; reviews get the reviewer skill only. Cleanup removes what was
 * staged and restores any checkout skill of the same name. Never throws.
 */
export async function stageWorkdirImageSkills(
  workdir: string,
  kind: TraceKind | undefined,
  imageRoot: string = IMAGE_SKILLS_ROOT,
  log: (message: string) => void = () => undefined
): Promise<StagedWorkdirSkills> {
  const noop: StagedWorkdirSkills = { staged: [], backups: [], cleanup: async () => undefined };
  const names = imageSkillNamesForKind(kind);
  if (names.length === 0) return noop;
  const staged: string[] = [];
  const backups: Array<{ name: string; backup: string }> = [];
  try {
    const root = await realpath(imageRoot);
    const skillsDir = join(workdir, WORKDIR_AGENT_SKILLS);
    for (const name of names) {
      const src = join(root, name);
      try {
        const real = await realpath(src);
        if (!inside(root, real)) continue;
        if (!(await stat(real)).isDirectory()) continue;
      } catch {
        continue;
      }
      const dest = join(skillsDir, name);
      // A checkout skill of the same name stays the checkout's: move it aside
      // so the image copy is what the model sees, then put it back.
      try {
        if ((await lstat(dest)).isDirectory()) {
          const backup = join(skillsDir, `.jumi-backup-${name}-${process.pid}`);
          await rm(backup, { recursive: true, force: true }).catch(() => undefined);
          await rename(dest, backup);
          backups.push({ name, backup });
        } else {
          await rm(dest, { force: true }).catch(() => undefined);
        }
      } catch {
        // Missing dest is the common case.
      }
      try {
        await mkdir(skillsDir, { recursive: true });
        await copyTree(src, dest);
        staged.push(dest);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log(`[skills] image skill ${name} not staged: ${reason}`);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[skills] image skills not staged: ${reason}`);
  }
  const cleanup = async (): Promise<void> => {
    for (const dest of staged) {
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    }
    // Remove a `.agents/skills` dir left empty by the removals above.
    try {
      const skillsDir = join(workdir, WORKDIR_AGENT_SKILLS);
      const remaining = await readdir(skillsDir).catch(() => null);
      if (remaining && remaining.length === 0)
        await rm(skillsDir, { recursive: true, force: true }).catch(() => undefined);
      const agentsDir = join(workdir, ".agents");
      const agentsRemaining = await readdir(agentsDir).catch(() => null);
      if (agentsRemaining && agentsRemaining.length === 0)
        await rm(agentsDir, { recursive: true, force: true }).catch(() => undefined);
    } catch {
      // Best-effort.
    }
    for (const { name, backup } of backups) {
      try {
        await rename(backup, join(workdir, WORKDIR_AGENT_SKILLS, name));
      } catch {
        // Best-effort.
      }
    }
  };
  return { staged, backups, cleanup };
}
