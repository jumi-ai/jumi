import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeForge } from "./provenance.ts";
import { type SqlClient, wrapSqlError } from "./sql_client.ts";

/** Repo-root artifact the worker child writes for the next round. Never committed. */
export const HANDOFF_FILE = "JUMI_HANDOFF.md";
/** Parent caps the stored note at 16 KiB. The child prompt asks for only a few KiB. */
export const HANDOFF_MAX_BYTES = 16 * 1024;

export interface HandoffKey {
  forge: string;
  owner: string;
  repo: string;
  issueNumber: number;
}

export function handoffKey(forge: string, owner: string, repo: string, issueNumber: number): HandoffKey {
  return { forge: normalizeForge(forge), owner, repo, issueNumber };
}

export function handoffMapKey(key: Pick<HandoffKey, "forge" | "owner" | "repo" | "issueNumber">): string {
  return `${normalizeForge(key.forge)}/${key.owner}/${key.repo}#${key.issueNumber}`;
}

/** Byte-cap the stored note. NUL-stripped and trimmed like other parent-owned prose. */
export function capHandoffNote(text: string, maxBytes: number = HANDOFF_MAX_BYTES): string {
  const out = text.replaceAll("\0", "");
  // Keep the head: key files and commands first, trailing detail is droppable.
  const bytes = new TextEncoder().encode(out);
  if (bytes.byteLength <= maxBytes) return out.trim() ? out.trim() : out;
  let sliced = out;
  // Binary-search a prefix that fits, then cut at a newline when close.
  let lo = 0;
  let hi = out.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (new TextEncoder().encode(out.slice(0, mid)).byteLength <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  sliced = out.slice(0, lo);
  const newline = sliced.lastIndexOf("\n");
  if (newline > maxBytes / 2) sliced = sliced.slice(0, newline);
  return sliced.trimEnd();
}

export function isValidHandoffText(text: string | null | undefined): boolean {
  if (text == null) return false;
  return text.replaceAll("\0", "").trim().length > 0;
}

/** Raw child artifact, or null when missing/empty/directory/symlink. Never throws. */
export async function readHandoffFromWorktree(worktree: string): Promise<string | null> {
  try {
    const info = await lstat(join(worktree, HANDOFF_FILE));
    if (!info.isFile()) return null;
    const text = await readFile(join(worktree, HANDOFF_FILE), "utf8");
    return isValidHandoffText(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Inject the stored previous-round note for the next child run. Missing note
 * removes a stale file so a hop never reads another issue's notes. Never throws.
 */
export async function writeHandoffToWorktree(worktree: string, note: string | null | undefined): Promise<void> {
  const path = join(worktree, HANDOFF_FILE);
  try {
    if (!isValidHandoffText(note)) {
      await rm(path, { force: true }).catch(() => undefined);
      return;
    }
    await writeFile(path, note as string);
  } catch {
    // Best-effort injection: a missing worktree fails the job elsewhere.
  }
}

export interface HandoffStore {
  get(key: HandoffKey): Promise<string | null>;
  put(key: HandoffKey, note: string): Promise<void>;
  delete(key: HandoffKey): Promise<void>;
  /** Forge-agnostic cleanup for close/kill-switch paths that lack a forge. */
  deleteForIssue(owner: string, repo: string, issueNumber: number): Promise<void>;
}

export const ISSUE_HANDOFFS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS issue_handoffs (
  forge TEXT NOT NULL DEFAULT 'gitea',
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (forge, owner, repo, issue_number)
);
`;

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export class MemoryHandoffStore implements HandoffStore {
  private readonly rows = new Map<string, string>();

  async get(key: HandoffKey): Promise<string | null> {
    return this.rows.get(handoffMapKey(key)) ?? null;
  }

  async put(key: HandoffKey, note: string): Promise<void> {
    if (!isValidHandoffText(note)) {
      this.rows.delete(handoffMapKey(key));
      return;
    }
    this.rows.set(handoffMapKey(key), capHandoffNote(note));
  }

  async delete(key: HandoffKey): Promise<void> {
    this.rows.delete(handoffMapKey(key));
  }

  async deleteForIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
    for (const forge of ["gitea", "github"]) {
      this.rows.delete(handoffMapKey({ forge, owner, repo, issueNumber }));
    }
    // Defensive: drop any non-normalized forge prefix that shares the suffix.
    const suffix = `/${owner}/${repo}#${issueNumber}`;
    for (const mapKey of [...this.rows.keys()]) {
      if (mapKey.endsWith(suffix)) this.rows.delete(mapKey);
    }
  }
}

export class PgHandoffStore implements HandoffStore {
  constructor(private readonly sql: SqlClient) {}

  async migrate(): Promise<void> {
    try {
      await this.sql.unsafe(ISSUE_HANDOFFS_SCHEMA_SQL);
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async get(key: HandoffKey): Promise<string | null> {
    const rows = asRows<{ note: unknown }>(
      await this.sql.unsafe(
        `SELECT note FROM issue_handoffs WHERE forge = $1 AND owner = $2 AND repo = $3 AND issue_number = $4`,
        [normalizeForge(key.forge), key.owner, key.repo, key.issueNumber]
      )
    );
    const note = rows[0]?.note;
    if (typeof note !== "string" || !note) return null;
    return note;
  }

  async put(key: HandoffKey, note: string): Promise<void> {
    if (!isValidHandoffText(note)) {
      await this.delete(key);
      return;
    }
    const capped = capHandoffNote(note);
    await this.sql.unsafe(
      `INSERT INTO issue_handoffs (forge, owner, repo, issue_number, note, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (forge, owner, repo, issue_number)
       DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()`,
      [normalizeForge(key.forge), key.owner, key.repo, key.issueNumber, capped]
    );
  }

  async delete(key: HandoffKey): Promise<void> {
    await this.sql.unsafe(
      `DELETE FROM issue_handoffs WHERE forge = $1 AND owner = $2 AND repo = $3 AND issue_number = $4`,
      [normalizeForge(key.forge), key.owner, key.repo, key.issueNumber]
    );
  }

  async deleteForIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
    await this.sql.unsafe(`DELETE FROM issue_handoffs WHERE owner = $1 AND repo = $2 AND issue_number = $3`, [
      owner,
      repo,
      issueNumber,
    ]);
  }
}

const memoryHandoffsByHome = new Map<string, MemoryHandoffStore>();

export function memoryHandoffsFor(home: string): MemoryHandoffStore {
  const existing = memoryHandoffsByHome.get(home);
  if (existing) return existing;
  const created = new MemoryHandoffStore();
  memoryHandoffsByHome.set(home, created);
  return created;
}

/** Local/dev fallback mirrors skipLatchesFor: ledger store wins, else per-HOME memory. */
export function handoffsFor(opts: { home: string; handoffs?: HandoffStore }): HandoffStore {
  return opts.handoffs ?? memoryHandoffsFor(opts.home);
}

/** Forge comes from the ledger provenance job; local runs without one default to gitea. */
export function handoffKeyForJob(
  job: { owner: string; repo: string; issueNumber: number },
  forge?: string
): HandoffKey {
  return handoffKey(forge ?? "gitea", job.owner, job.repo, job.issueNumber);
}

/** Next round's injection: stored note or stale-file removal. Never throws. */
export async function injectStoredHandoff(
  worktree: string,
  store: HandoffStore,
  key: HandoffKey,
  log?: (message: string) => void
): Promise<string | null> {
  try {
    const note = await store.get(key);
    await writeHandoffToWorktree(worktree, note);
    return note;
  } catch (err) {
    log?.(`handoff inject unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Round's store: capped replace with the final file. Never throws. */
export async function saveWorktreeHandoff(
  worktree: string,
  store: HandoffStore,
  key: HandoffKey,
  log?: (message: string) => void
): Promise<string | null> {
  try {
    const raw = await readHandoffFromWorktree(worktree);
    if (!isValidHandoffText(raw)) return null;
    await store.put(key, capHandoffNote(raw as string));
    return capHandoffNote(raw as string);
  } catch (err) {
    log?.(`handoff store unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
