import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { DEFAULT_MAX_REVIEW_MD_BYTES } from "./review_md.ts";
import type { GitRunner } from "./workspace.ts";

/**
 * Repository instructions that reviews load from the base branch, never the
 * head. A pull that edits these files is reviewed under the base copy, the
 * same way `readReviewMdFromBase` already handles `REVIEW.md`.
 *
 * Workers keep loading the checkout as today; only `kind === "review"` uses
 * this helper.
 */
export const BASE_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export const BASE_SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;
/** Per-file cap, mirroring `MAX_REVIEW_MD_READ_BYTES` in `review_md.ts`. */
export const MAX_BASE_FILE_BYTES = 1_048_576;
/** Total budget for staged base instructions, mirroring the review-md budget. */
export const DEFAULT_MAX_BASE_BYTES = DEFAULT_MAX_REVIEW_MD_BYTES;

export interface ReviewBaseSource {
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Base commit the review diffs against (`pr.base.sha`). Must be a hex SHA. */
  baseRef: string;
}

export interface StagedReviewBase {
  /** Staged instruction files, relative to `dest` (e.g. `AGENTS.md`). */
  files: string[];
  /** Staged skill ids (directory names under either skill root). */
  skills: string[];
  /** True when any file was skipped for size. */
  truncated: boolean;
  /** Total staged bytes. */
  bytes: number;
}

function isHexRef(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

interface LsEntry {
  mode: string;
  kind: string;
  size: number;
  path: string;
}

function parseLsTreeLines(output: string): LsEntry[] {
  const entries: LsEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab);
    const path = line.slice(tab + 1);
    const match = /^(\d+) (\w+) [0-9a-f]+ +(\S+)$/.exec(meta.trim());
    if (!match) continue;
    const size = Number(match[3]);
    if (!Number.isInteger(size) || size < 0) continue;
    entries.push({ mode: match[1], kind: match[2], size, path });
  }
  return entries;
}

function insideDest(dest: string, rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("\0")) return false;
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  const full = join(dest, ...parts);
  return full === dest || full.startsWith(dest + sep);
}

/**
 * Read one base blob with `git show`. Returns undefined for missing,
 * non-regular (symlink, submodule, directory), oversize, or unreadable paths.
 * Uses only read-only git: the worktree, index, and porcelain stay untouched.
 */
async function readBaseBlob(
  source: ReviewBaseSource,
  path: string,
  maxFileBytes: number
): Promise<{ text: string; truncated: boolean; size: number } | undefined> {
  const listing = await source.git(["ls-tree", "-l", source.baseRef, "--", path], {
    cwd: source.cwd,
    env: source.env,
  });
  const entry = parseLsTreeLines(listing).find((item) => item.path === path);
  if (entry?.kind !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) return undefined;
  if (entry.size > maxFileBytes) return undefined;
  const raw = await source.git(["show", `${source.baseRef}:${path}`], { cwd: source.cwd, env: source.env });
  if (Buffer.byteLength(raw, "utf8") <= maxFileBytes) return { text: raw, truncated: false, size: entry.size };
  const cut = Buffer.from(raw, "utf8").subarray(0, maxFileBytes).toString("utf8").replace(/�$/, "");
  return { text: cut, truncated: true, size: entry.size };
}

/**
 * Stage the base branch's `AGENTS.md`, `CLAUDE.md`, and `.claude/skills` /
 * `.agents/skills` trees under `dest` (outside the tracked checkout, e.g.
 * under the spawn's `.jumi-tmp`). Returns what was staged; missing files
 * stage nothing, oversize files are skipped, symlinks and submodules are
 * never followed, and no path escapes `dest`.
 */
export async function stageBaseReviewInstructions(
  source: ReviewBaseSource,
  dest: string,
  opts?: { maxBytes?: number; maxFileBytes?: number }
): Promise<StagedReviewBase> {
  const empty: StagedReviewBase = { files: [], skills: [], truncated: false, bytes: 0 };
  if (!isHexRef(source.baseRef)) return empty;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BASE_BYTES;
  const maxFileBytes = opts?.maxFileBytes ?? MAX_BASE_FILE_BYTES;
  let budget = maxBytes;
  let truncated = false;
  const staged: StagedReviewBase = { files: [], skills: [], truncated: false, bytes: 0 };
  try {
    for (const name of BASE_INSTRUCTION_FILES) {
      let blob: { text: string; truncated: boolean; size: number } | undefined;
      try {
        blob = await readBaseBlob(source, name, maxFileBytes);
      } catch {
        continue;
      }
      if (!blob) continue;
      const bytes = Buffer.byteLength(blob.text, "utf8");
      if (bytes > budget) {
        truncated = true;
        continue;
      }
      if (!insideDest(dest, name)) continue;
      await mkdir(dirname(join(dest, name)), { recursive: true });
      await writeFile(join(dest, name), blob.text);
      staged.files.push(name);
      staged.bytes += bytes;
      budget -= bytes;
      if (blob.truncated) truncated = true;
    }
    let skillEntries: LsEntry[] = [];
    try {
      const listing = await source.git(["ls-tree", "-r", "-l", source.baseRef, "--", ...BASE_SKILL_ROOTS], {
        cwd: source.cwd,
        env: source.env,
      });
      skillEntries = parseLsTreeLines(listing);
    } catch {
      skillEntries = [];
    }
    const seen = new Set<string>();
    for (const entry of skillEntries) {
      if (entry.kind !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) continue;
      if (!BASE_SKILL_ROOTS.some((root) => entry.path === root || entry.path.startsWith(`${root}/`))) continue;
      if (entry.size > maxFileBytes) {
        truncated = true;
        continue;
      }
      // Only skill content: a `SKILL.md` or a file under a skill directory.
      // Flat `<root>/<name>.md` files are also skills (see skills docs).
      const root = BASE_SKILL_ROOTS.find((item) => entry.path.startsWith(`${item}/`));
      if (!root) continue;
      const rest = entry.path.slice(root.length + 1);
      const top = rest.split("/")[0];
      if (!top) continue;
      const key = `${root}:${entry.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let raw: string;
      try {
        raw = await source.git(["show", `${source.baseRef}:${entry.path}`], { cwd: source.cwd, env: source.env });
      } catch {
        continue;
      }
      const bytes = Buffer.byteLength(raw, "utf8");
      if (bytes > maxFileBytes || bytes > budget) {
        truncated = true;
        continue;
      }
      // Merge both roots into one skills dir keyed by skill path below the
      // root, so `.claude/skills/foo` and `.agents/skills/foo` collide
      // instead of shadowing by load order. Later roots win.
      const rel = join("skills", rest);
      if (!insideDest(dest, rel)) continue;
      await mkdir(dirname(join(dest, rel)), { recursive: true });
      await writeFile(join(dest, rel), raw);
      budget -= bytes;
      staged.bytes += bytes;
      const skillId = top.replace(/\.md$/, "");
      if (!staged.skills.includes(skillId)) staged.skills.push(skillId);
    }
  } catch {
    return { ...staged, truncated };
  }
  staged.truncated = truncated;
  return staged;
}

/** Read a staged base instruction file, or undefined when absent. */
export async function readStagedBaseFile(dest: string, name: string): Promise<string | undefined> {
  if (!insideDest(dest, name)) return undefined;
  const { readFile } = await import("node:fs/promises");
  try {
    const info = await lstat(join(dest, name));
    if (!info.isFile()) return undefined;
    return await readFile(join(dest, name), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Stage an already-staged base dir's `skills/` tree as a Claude plugin under
 * `dest`. Returns `dest` to pass as `--plugin-dir`, or undefined when the
 * base has no skills. Never throws.
 */
export async function stageBaseSkillsForClaude(dest: string, baseDir: string): Promise<string | undefined> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  try {
    const src = join(baseDir, "skills");
    const entries = await readdir(src);
    const skills = entries.filter((name) => name && name !== "." && name !== ".." && !name.startsWith("."));
    if (skills.length === 0) return undefined;
    let staged = 0;
    for (const name of skills) {
      const from = join(src, name);
      if (!insideDest(baseDir, join("skills", name))) continue;
      let info: { isDirectory(): boolean };
      try {
        info = await stat(from);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      try {
        if (!(await stat(join(from, "SKILL.md"))).isFile()) continue;
      } catch {
        continue;
      }
      await copyTree(from, join(dest, "skills", name));
      staged += 1;
    }
    if (staged === 0) return undefined;
    await mkdir(join(dest, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dest, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "base", description: "Base-branch review instructions" }, null, 2)}\n`
    );
    return dest;
  } catch {
    return undefined;
  }
}

async function copyTree(src: string, dest: string): Promise<void> {
  const { readdir, readFile, lstat, writeFile, mkdir } = await import("node:fs/promises");
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
 * Write a review-only Codex home that marks `workdir` untrusted. Project
 * `.codex` layers (config, hooks, rules, MCP servers) then never load; user
 * and system config still do. Proved against the pinned binary by
 * `src/codex_probe.ts` (review case): the head marker disappears while the
 * run still reaches the endpoint.
 */
export async function writeCodexReviewHome(dir: string, workdir: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const escaped = workdir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await writeFile(
    join(dir, "config.toml"),
    `# Review-only home: the pull head never configures its reviewer.\n[projects."${escaped}"]\ntrust_level = "untrusted"\n`
  );
}

export interface WorkdirSkillsStaging {
  cleanup: () => Promise<void>;
}

/**
 * Hide the head's `.agents/skills` and `.claude/skills` for a review spawn
 * and stage the base branch's skills (from `baseDir/skills`) into
 * `<workdir>/.agents/skills`. Cleanup removes what was staged and restores
 * the head dirs. Never throws.
 *
 * Files stay on disk under the backup outside the checkout's tracked tree
 * only for the duration of the spawn; the pre-run removal and post-run
 * restore keep the review's dirty-tree check clean.
 */
export async function stageBaseSkillsIntoWorkdir(
  workdir: string,
  baseDir: string,
  log: (message: string) => void = () => undefined
): Promise<WorkdirSkillsStaging> {
  const { lstat, mkdir, readdir, rename, rm } = await import("node:fs/promises");
  const noop: WorkdirSkillsStaging = { cleanup: async () => undefined };
  const roots = [join(workdir, ".agents", "skills"), join(workdir, ".claude", "skills")];
  const backups: Array<{ original: string; backup: string }> = [];
  const staged: string[] = [];
  // Always hide the head's skills for a review spawn, even when the base
  // has no skills to stage. Otherwise a head-only skill would still load.
  for (const root of roots) {
    let exists = false;
    try {
      exists = (await lstat(root)).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const backup = `${root}.jumi-base-backup-${process.pid}`;
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    try {
      await rename(root, backup);
      backups.push({ original: root, backup });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`[skills] head skills not hidden: ${reason}`);
    }
  }
  if (backups.length === 0) {
    // No head skills to hide: still stage the base when present, otherwise noop.
    let skills: string[];
    try {
      skills = await readdir(join(baseDir, "skills"));
    } catch {
      return noop;
    }
    if (skills.length === 0) return noop;
  }
  let skills: string[];
  try {
    skills = await readdir(join(baseDir, "skills"));
  } catch {
    skills = [];
  }
  try {
    const dest = join(workdir, ".agents", "skills");
    for (const name of skills) {
      if (!name || name === "." || name === ".." || name.startsWith(".")) continue;
      const from = join(baseDir, "skills", name);
      let isDir = false;
      try {
        isDir = (await lstat(from)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      try {
        await mkdir(dest, { recursive: true });
        await copyTree(from, join(dest, name));
        staged.push(join(dest, name));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log(`[skills] base skill ${name} not staged: ${reason}`);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[skills] base skills not staged: ${reason}`);
  }
  const cleanup = async (): Promise<void> => {
    for (const path of staged) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    try {
      const dest = join(workdir, ".agents", "skills");
      const remaining = await readdir(dest).catch(() => null);
      if (remaining && remaining.length === 0) await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      const agentsDir = join(workdir, ".agents");
      const agentsRemaining = await readdir(agentsDir).catch(() => null);
      if (agentsRemaining && agentsRemaining.length === 0)
        await rm(agentsDir, { recursive: true, force: true }).catch(() => undefined);
    } catch {
      // Best-effort.
    }
    for (const { original, backup } of backups) {
      try {
        await rm(original, { recursive: true, force: true }).catch(() => undefined);
        await rename(backup, original);
      } catch {
        // Best-effort.
      }
    }
  };
  return { cleanup };
}
