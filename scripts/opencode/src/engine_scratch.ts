import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const ENGINE_TEMP_DIR = ".jumi-tmp";
export const ATTACHMENTS_DIR = ".jumi-attachments";

const ENGINE_SCRATCH_EXCLUDE = `${ENGINE_TEMP_DIR}/`;
const ATTACHMENTS_SCRATCH_EXCLUDE = `${ATTACHMENTS_DIR}/`;

export function engineScratchTrackedReason(ref: string): string {
  return `refusing to open a pull request: ${ref} tracks ${ENGINE_TEMP_DIR}, which holds provider auth and session transcripts`;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err != null && "code" in err && (err as { code?: string }).code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function excludeListsScratch(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === ENGINE_TEMP_DIR ||
      trimmed === ENGINE_SCRATCH_EXCLUDE ||
      trimmed === `/${ENGINE_TEMP_DIR}` ||
      trimmed === `/${ENGINE_SCRATCH_EXCLUDE}`
    );
  });
}

function excludeListsAttachments(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === ATTACHMENTS_DIR ||
      trimmed === ATTACHMENTS_SCRATCH_EXCLUDE ||
      trimmed === `/${ATTACHMENTS_DIR}` ||
      trimmed === `/${ATTACHMENTS_SCRATCH_EXCLUDE}`
    );
  });
}

export async function engineScratchExcludePath(worktree: string): Promise<string | undefined> {
  const dotGit = join(worktree, ".git");
  const info = await lstat(dotGit).catch(() => undefined);
  if (!info) return undefined;
  if (info.isDirectory()) return join(dotGit, "info", "exclude");
  if (!info.isFile()) return undefined;
  const text = await readFile(dotGit, "utf8").catch(() => "");
  const gitdirRel = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  if (!gitdirRel) return undefined;
  const gitdir = resolve(worktree, gitdirRel);
  if (!(await pathExists(gitdir))) return undefined;
  let common = gitdir;
  const commondir = (await readFile(join(gitdir, "commondir"), "utf8").catch(() => "")).trim();
  if (commondir) common = resolve(gitdir, commondir);
  return join(common, "info", "exclude");
}

export async function ensureEngineScratchIgnored(worktree: string): Promise<boolean> {
  const excludePath = await engineScratchExcludePath(worktree);
  if (!excludePath) return false;
  await mkdir(dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  let next = existing;
  let changed = false;
  if (!excludeListsScratch(next)) {
    const prefix = next.length === 0 || next.endsWith("\n") ? next : `${next}\n`;
    next = `${prefix}${ENGINE_SCRATCH_EXCLUDE}\n`;
    changed = true;
  }
  // Parent-staged issue attachments are inputs, never commits: keep the
  // ignored directory out of `git status` noise the same way as the engine
  // temp dir.
  if (!excludeListsAttachments(next)) {
    const prefix = next.length === 0 || next.endsWith("\n") ? next : `${next}\n`;
    next = `${prefix}${ATTACHMENTS_SCRATCH_EXCLUDE}\n`;
    changed = true;
  }
  if (!changed) return true;
  await writeFile(excludePath, next);
  return true;
}

function scratchStatusPath(line: string): string {
  let path = line.length >= 4 ? line.slice(3) : line;
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) path = path.slice(1, -1);
  if (path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

function isScratchStatusLine(line: string): boolean {
  const path = scratchStatusPath(line);
  return path === ENGINE_TEMP_DIR || path.startsWith(`${ENGINE_TEMP_DIR}/`);
}

export function engineScratchShowsIgnored(ignoredPorcelain: string): boolean {
  return ignoredPorcelain.split(/\r?\n/).some((line) => line.startsWith("!!") && isScratchStatusLine(line));
}

export function engineScratchUntrackedNotIgnored(ignoredPorcelain: string): boolean {
  let untracked = false;
  let ignored = false;
  for (const line of ignoredPorcelain.split(/\r?\n/)) {
    if (!line.trim() || !isScratchStatusLine(line)) continue;
    if (line.startsWith("??")) untracked = true;
    if (line.startsWith("!!")) ignored = true;
  }
  return untracked && !ignored;
}

export function assertEngineScratchIgnored(ignoredPorcelain: string): void {
  if (engineScratchUntrackedNotIgnored(ignoredPorcelain)) {
    throw new Error(`${ENGINE_TEMP_DIR} is untracked, not ignored`);
  }
  if (!engineScratchShowsIgnored(ignoredPorcelain)) {
    throw new Error(`${ENGINE_TEMP_DIR} is not ignored`);
  }
}

export async function tipTracksEngineScratch(
  git: (args: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => Promise<string>,
  opts: { cwd: string; env: Record<string, string | undefined> }
): Promise<boolean> {
  const listed = await git(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ENGINE_TEMP_DIR], opts);
  return listed.split("\0").some((path) => path === ENGINE_TEMP_DIR || path.startsWith(`${ENGINE_TEMP_DIR}/`));
}

export function attachmentsTrackedReason(ref: string): string {
  return `refusing to open a pull request: ${ref} tracks ${ATTACHMENTS_DIR}, which holds parent-staged issue inputs`;
}

export async function tipTracksAttachments(
  git: (args: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => Promise<string>,
  opts: { cwd: string; env: Record<string, string | undefined> }
): Promise<boolean> {
  const listed = await git(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ATTACHMENTS_DIR], opts);
  return listed.split("\0").some((path) => path === ATTACHMENTS_DIR || path.startsWith(`${ATTACHMENTS_DIR}/`));
}
