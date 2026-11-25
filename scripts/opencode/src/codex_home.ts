import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Job-scoped retained Codex homes (jumi#887).
 *
 * A `runCodex` spawn that owns its `CODEX_HOME` (review-only, or the worker
 * MCP home) used to create it fresh under a per-spawn temp root and delete
 * the whole root when the spawn ended. The thread id outlives the rollout in
 * `<workdir>/.jumi-tmp/codex-thread-id`, so a same-job resume (`codex exec
 * resume <id>`) ran against a new empty home and failed with "no rollout
 * found" — and a resumed run never hops, so the job failed.
 *
 * The retained home fixes the lifetime: one outside-harness directory per job
 * worktree (`codexJobDir`), holding `codex-review-home/` and
 * `codex-worker-home/`. Only Codex's own session state (rollouts, index,
 * sqlite) carries between spawns; `config.toml`, `hooks.json` and the
 * `auth.json` link are rebuilt before every spawn exactly as before. The job
 * owns the directory and removes it when the job ends (success, failure,
 * abort, hop); nothing carries over to another job, PR or worktree.
 *
 * Isolation: the job dir lives under `/tmp`, outside the checkout and outside
 * every path the sandboxed review shells allow (the shell policy omits
 * `/tmp`, and the hook denies the job dir for file tools). Review and worker
 * homes stay separate, and the per-spawn kind marker (`.jumi-tmp/
 * codex-home-kind`) keeps a resume from ever crossing kinds: a spawn resumes
 * only when the marker names its own kind and that kind's retained home holds
 * the thread's session state.
 */

export type CodexHomeKind = "review" | "worker";

/** Per-spawn marker in the worktree naming which home the last spawn owned. */
const CODEX_HOME_KIND_FILE = "codex-home-kind";

/**
 * Outside-harness directory keyed to the job's worktree. Deterministic per
 * absolute worktree path so every spawn of the same job finds the same
 * retained homes, and a second job in a new worktree starts empty.
 */
export function codexJobDir(workdir: string): string {
  const hash = createHash("sha256").update(resolve(workdir)).digest("hex").slice(0, 16);
  return join("/tmp", `jumi-codex-job-${hash}`);
}

/** Retained `CODEX_HOME` for one kind. Created on first use, never per-spawn. */
export function codexRetainedHome(workdir: string, kind: CodexHomeKind): string {
  return join(codexJobDir(workdir), `codex-${kind}-home`);
}

export function codexHomeKindPath(workdir: string): string {
  return join(workdir, ".jumi-tmp", CODEX_HOME_KIND_FILE);
}

export async function readCodexHomeKind(workdir: string): Promise<string | undefined> {
  try {
    return (await readFile(codexHomeKindPath(workdir), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function writeCodexHomeKind(workdir: string, kind: CodexHomeKind | "home"): Promise<void> {
  await mkdir(join(workdir, ".jumi-tmp"), { recursive: true }).catch(() => undefined);
  await writeFile(codexHomeKindPath(workdir), `${kind}\n`).catch(() => undefined);
}

export async function ensureCodexRetainedHome(workdir: string, kind: CodexHomeKind): Promise<string> {
  const dir = codexRetainedHome(workdir, kind);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Best-effort: a pre-existing dir keeps its old mode without this, and it
  // holds config.toml with the review/worker MCP bearer token.
  await chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

/**
 * Fresh per-spawn directory under the job dir. The spawn's prompt file lives
 * here; it is deleted when the spawn ends while the retained homes above
 * survive until job cleanup. Denying the job dir for file tools therefore
 * covers both the spawn files and the retained session state.
 */
export async function makeCodexSpawnRoot(
  workdir: string,
  kind: CodexHomeKind
): Promise<{ jobDir: string; spawnRoot: string }> {
  const jobDir = codexJobDir(workdir);
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  // Best-effort: the job dir holds config.toml with the review/worker MCP
  // bearer token, and a pre-existing dir keeps its old mode without this.
  await chmod(jobDir, 0o700).catch(() => undefined);
  const spawnRoot = await mkdtemp(join(jobDir, `codex-${kind}-spawn-`));
  return { jobDir, spawnRoot };
}

/** Remove the job's retained homes and any leftover spawn dirs. Best-effort. */
export async function cleanupCodexJobHomes(workdir: string): Promise<void> {
  await rm(codexJobDir(workdir), { recursive: true, force: true }).catch(() => undefined);
}

/** Remove the job's harness temp: the worktree `.jumi-tmp` and the retained
 * Codex homes outside the checkout. Call when the job ends (success,
 * failure, abort); never throws. */
export async function cleanupJobHarnessTemp(workdir: string): Promise<void> {
  await rm(join(workdir, ".jumi-tmp"), { recursive: true, force: true }).catch(() => undefined);
  await cleanupCodexJobHomes(workdir);
}

/**
 * Link the parent HOME's `auth.json` into a retained Codex home before a
 * spawn. The home is retained across spawns, so the previous spawn's link is
 * dropped first and the current credential is relinked (symlink when the
 * source is itself a link, file copy otherwise) — a resume never runs on a
 * stale target. Best-effort: API-key and local modes have no HOME auth file.
 */
export async function relinkCodexAuth(homeDir: string, retainedHome: string): Promise<void> {
  try {
    const authSrc = join(homeDir, ".codex", "auth.json");
    const authDst = join(retainedHome, "auth.json");
    await rm(authDst, { force: true }).catch(() => undefined);
    const target = await readlink(authSrc).catch(() => undefined);
    if (target) {
      await symlink(target, authDst).catch(() => undefined);
      return;
    }
    const raw = await readFile(authSrc, "utf8").catch(() => undefined);
    if (raw) await writeFile(authDst, raw, { mode: 0o600 }).catch(() => undefined);
  } catch {
    // Best-effort: API-key and local modes have no HOME auth file.
  }
}

/**
 * The thread id a spawn with `continueSession` may resume, or undefined for
 * a fresh spawn. A Jumi-owned home (`kind` set) resumes only when the
 * worktree marker names that same kind and its retained home holds the
 * thread's session state; otherwise no `exec resume` is emitted. Without a
 * Jumi-owned home the thread id passes through and `$HOME/.codex` resumes
 * as today.
 */
export async function resolveCodexResumeThreadId(
  workdir: string,
  kind: CodexHomeKind | undefined,
  requestedThreadId: string | undefined
): Promise<string | undefined> {
  if (!requestedThreadId || !kind) return requestedThreadId;
  if ((await readCodexHomeKind(workdir)) !== kind) return undefined;
  return (await hasCodexSessionState(workdir, kind, requestedThreadId)) ? requestedThreadId : undefined;
}

async function dirTreeContains(root: string, needle: string, seen: { count: number }): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (seen.count++ > 2000) return false;
    if (entry.includes(needle)) return true;
    const full = join(root, entry);
    try {
      if (!(await lstat(full)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (await dirTreeContains(full, needle, seen)) return true;
  }
  return false;
}

/**
 * True when the retained home for `kind` holds session state for `threadId`:
 * a rollout file naming the thread (plain or compressed), an archived
 * rollout, or an index line. Only this state carries between spawns; the
 * per-spawn `config.toml` / `hooks.json` / `auth.json` never count.
 */
export async function hasCodexSessionState(workdir: string, kind: CodexHomeKind, threadId: string): Promise<boolean> {
  const id = threadId.trim();
  if (!id) return false;
  const home = codexRetainedHome(workdir, kind);
  try {
    const index = await readFile(join(home, "session_index.jsonl"), "utf8");
    if (index.includes(id)) return true;
  } catch {
    // No index yet: fall through to the rollout tree.
  }
  const seen = { count: 0 };
  return (
    (await dirTreeContains(join(home, "sessions"), id, seen)) ||
    (await dirTreeContains(join(home, "archived_sessions"), id, seen))
  );
}
