import type { GitRunner } from "./workspace.ts";

/**
 * Every root file Jumi writes into the worktree or injects for a child run.
 * These are parent/child coordination artifacts: they must never be committed
 * or pushed. One shared list so a new sentinel cannot be missed in one path
 * again (implement, follow-up, conflict all strip this list).
 */
export const JUMI_SENTINEL_FILES: readonly string[] = [
  "JUMI_TASK.md",
  "JUMI_QUEUE.md",
  "JUMI_FEEDBACK.md",
  "JUMI_CONFLICT.md",
  "JUMI_CI.md",
  "JUMI_PR.md",
  "JUMI_HANDOFF.md",
  "JUMI_ATTACHMENTS.md",
];

export function sentinelTrackedReason(ref: string, files: readonly string[]): string {
  const names = [...files].sort().join(", ");
  return (
    `refusing to open a pull request: ${ref} tracks ${names}, ` +
    `which holds parent-injected task state and must not be committed`
  );
}

function splitNulPaths(listed: string): string[] {
  return listed
    .split("\0")
    .map((path) => path.trim())
    .filter(Boolean);
}

/**
 * Files from {@link JUMI_SENTINEL_FILES} that the branch tip tracks but the
 * merge base with the default branch does not: i.e. the branch *adds* them.
 * Files that already exist on the default branch do not count.
 */
export async function tipAddedSentinels(
  git: GitRunner,
  opts: { cwd: string; env: Record<string, string | undefined>; defaultBranch: string }
): Promise<string[]> {
  // Fail closed: a lookup error on the merge base or the tip must abort the
  // push path (like tipTracksEngineScratch / tipTracksAttachments), never
  // read as "the branch adds nothing".
  const base = (
    await git(["merge-base", `origin/${opts.defaultBranch}`, "HEAD"], { cwd: opts.cwd, env: opts.env })
  ).trim();
  if (!base) return [];
  const tipListed = await git(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...JUMI_SENTINEL_FILES], {
    cwd: opts.cwd,
    env: opts.env,
  });
  const tip = new Set(splitNulPaths(tipListed));
  if (tip.size === 0) return [];
  let baseListed = "";
  try {
    baseListed = await git(["ls-tree", "-r", "-z", "--name-only", base, "--", ...JUMI_SENTINEL_FILES], {
      cwd: opts.cwd,
      env: opts.env,
    });
  } catch {
    // Safe direction: an unreadable base counts tip files as added.
    baseListed = "";
  }
  const onBase = new Set(splitNulPaths(baseListed));
  return [...tip].filter((path) => !onBase.has(path)).sort();
}
