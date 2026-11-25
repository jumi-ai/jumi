import type { Pull } from "./ports.ts";
import type { SqlClient } from "./sql_client.ts";
import { wrapSqlError } from "./sql_client.ts";

/**
 * Single-slot strict-refresh queue (issue #769).
 *
 * Exactly one Jumi-initiated strict refresh may be active per repository and
 * target branch. The slot is held across the refreshed head's CI, Jumi
 * review, and GitHub merge outcome: completing the branch push or seeing
 * green checks alone does not release it, and waiting holds no worker or
 * reviewer execution slot (the slot is a ledger row, not a lease).
 *
 * Release happens on the existing event-driven reconciliation path (target
 * pushes and PR activity): merge/close, loss of eligibility (including human
 * auto-merge cancellation), a known blocker (conflict or blocked
 * mergeability), or a bounded timeout. A terminal or timed-out candidate is
 * not immediately reselected on unchanged evidence (same PR, head, and
 * base); a later relevant change (new head, new base) makes it eligible
 * again. Duplicate or out-of-order events never start a second refresh for
 * the same target and never clear another target's slot.
 */

export const STRICT_REFRESH_SLOT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const STRICT_REFRESH_MAX_LAPS = 3;

const STRICT_REFRESH_SLOT_TABLE = "strict_refresh_slots";

export const STRICT_REFRESH_SLOTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strict_refresh_slots (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  pr_number INTEGER,
  head_sha TEXT,
  base_sha TEXT,
  admitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  last_terminal_pr INTEGER,
  last_terminal_head TEXT,
  last_terminal_base TEXT,
  last_terminal_reason TEXT,
  last_terminal_at TIMESTAMPTZ,
  laps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, repo, base_branch)
);
`;

export interface StrictRefreshSlot {
  owner: string;
  repo: string;
  baseBranch: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  admittedAtMs: number;
  updatedAtMs: number;
  laps?: number;
}

export interface StrictRefreshTerminal {
  prNumber: number;
  headSha: string;
  baseSha: string;
  reason: string;
  atMs: number;
}

export interface StrictRefreshSlotStore {
  getSlot(owner: string, repo: string, baseBranch: string): Promise<StrictRefreshSlot | undefined>;
  getTerminal(owner: string, repo: string, baseBranch: string): Promise<StrictRefreshTerminal | undefined>;
  /** Insert the slot when none is held. Returns false when another admission won the race. */
  tryAdmit(slot: StrictRefreshSlot): Promise<boolean>;
  /** Refresh the held slot's observed head/base without releasing it. No-op when empty or held by another PR. */
  touch(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string,
    baseSha: string,
    nowMs?: number
  ): Promise<void>;
  /**
   * Release the held slot. When `terminal` is set, remember its evidence so
   * the same candidate is not immediately reselected on unchanged evidence.
   * Releasing an empty slot still records the terminal (timeout bookkeeping).
   */
  /**
   * Release the held slot. When `terminal` is set, remember its evidence so
   * the same candidate is not immediately reselected on unchanged evidence.
   * Releasing an empty slot still records the terminal (timeout bookkeeping).
   */
  release(
    owner: string,
    repo: string,
    baseBranch: string,
    opts?: { terminal?: Omit<StrictRefreshTerminal, "atMs">; nowMs?: number }
  ): Promise<void>;
  /**
   * Release the held slot only when it still names `prNumber` with head
   * `headSha` (case-insensitive). A late result for an older admission never
   * frees a newer holder. Fenced like `tryAdmit`/`touch` under `withSlotLock`
   * (memory: the same serialized chain). Returns true when released.
   */
  releaseIfHolder(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string,
    opts?: { terminal?: Omit<StrictRefreshTerminal, "atMs">; nowMs?: number }
  ): Promise<boolean>;
  /** Every currently held slot, oldest first. Powers the engine-tick expiry. */
  listHeldSlots(): Promise<StrictRefreshSlot[]>;
}

function slotKey(owner: string, repo: string, baseBranch: string): string {
  return `${owner}/${repo}#${baseBranch}`;
}

function slotLockKey(owner: string, repo: string, baseBranch: string): string {
  return `strict-slot:${owner}/${repo}#${baseBranch}`;
}

/**
 * A known blocker that must not hold the queue ahead of an otherwise-ready
 * PR: GitHub reports a merge conflict (`dirty`, or an explicit
 * `mergeable === false`) or a terminally blocked head (`blocked`, which
 * covers failing required checks and blocking reviews under branch
 * protection). Absent, `unknown`, `behind`, `clean`, `unstable`, `draft`,
 * and `has_hooks` are not blockers by themselves: `behind` is the refresh
 * signal, and the rest leave freshness unestablished.
 */
export function isStrictRefreshBlocked(pr: Pull): boolean {
  if (!pr || typeof pr !== "object") return false;
  if (pr.mergeable === false) return true;
  const state = typeof pr.mergeableState === "string" ? pr.mergeableState.toLowerCase() : "";
  return state === "dirty" || state === "blocked";
}

/** Oldest eligible first; PR number breaks ties (stable for same-millisecond creates). */
export function compareStrictRefreshOrder(a: Pull, b: Pull): number {
  const aMs = Date.parse(a?.created_at ?? "");
  const bMs = Date.parse(b?.created_at ?? "");
  const aFinite = Number.isFinite(aMs);
  const bFinite = Number.isFinite(bMs);
  if (aFinite && bFinite && aMs !== bMs) return aMs - bMs;
  if (aFinite && !bFinite) return -1;
  if (!aFinite && bFinite) return 1;
  return (a?.number ?? 0) - (b?.number ?? 0);
}

/** True when the candidate carries the same evidence as a terminal record. */
export function isStrictRefreshTerminalEvidence(
  prNumber: number,
  headSha: string,
  baseSha: string,
  terminal: StrictRefreshTerminal | undefined | null
): boolean {
  if (!terminal) return false;
  return (
    terminal.prNumber === prNumber &&
    (terminal.headSha ?? "").toLowerCase() === (headSha ?? "").toLowerCase() &&
    (terminal.baseSha ?? "").toLowerCase() === (baseSha ?? "").toLowerCase()
  );
}

/**
 * Shared strict-slot lookup for the webhook paths. The GitHub PR reconcile
 * and push paths read `worker.strictSlots ?? worker.review.strictSlots ??
 * review.strictSlots`; the Gitea router path reads the same chain plus the
 * review queue fallback. One helper keeps the next wiring change from having
 * to touch every webhook path.
 */
export function strictSlotsFor(deps: unknown): StrictRefreshSlotStore | undefined {
  if (!deps || typeof deps !== "object") return undefined;
  const holder = deps as {
    strictSlots?: StrictRefreshSlotStore;
    worker?: { strictSlots?: StrictRefreshSlotStore; review?: { strictSlots?: StrictRefreshSlotStore } };
    review?: { strictSlots?: StrictRefreshSlotStore };
    queue?: { strictSlots?: StrictRefreshSlotStore };
  };
  if (holder.strictSlots) return holder.strictSlots;
  if (holder.worker?.strictSlots) return holder.worker.strictSlots;
  const workerReview = holder.worker?.review?.strictSlots;
  if (workerReview) return workerReview;
  if (holder.review?.strictSlots) return holder.review.strictSlots;
  if (holder.queue?.strictSlots) return holder.queue.strictSlots;
  return undefined;
}

function epochMs(value: unknown, fallback: number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export class MemoryStrictRefreshSlotStore implements StrictRefreshSlotStore {
  private readonly slots = new Map<string, StrictRefreshSlot>();
  private readonly terminals = new Map<string, StrictRefreshTerminal>();
  private chain = Promise.resolve();

  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async getSlot(owner: string, repo: string, baseBranch: string): Promise<StrictRefreshSlot | undefined> {
    const slot = this.slots.get(slotKey(owner, repo, baseBranch));
    return slot ? { ...slot, laps: slot.laps ?? 0 } : undefined;
  }

  async getTerminal(owner: string, repo: string, baseBranch: string): Promise<StrictRefreshTerminal | undefined> {
    const terminal = this.terminals.get(slotKey(owner, repo, baseBranch));
    return terminal ? { ...terminal } : undefined;
  }

  async tryAdmit(slot: StrictRefreshSlot): Promise<boolean> {
    return this.locked(() => {
      const key = slotKey(slot.owner, slot.repo, slot.baseBranch);
      if (this.slots.has(key)) return false;
      this.slots.set(key, { ...slot, laps: slot.laps ?? 0 });
      return true;
    });
  }

  async touch(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string,
    baseSha: string,
    nowMs?: number
  ): Promise<void> {
    await this.locked(() => {
      const key = slotKey(owner, repo, baseBranch);
      const slot = this.slots.get(key);
      if (!slot || slot.prNumber !== prNumber) return;
      if (baseSha !== slot.baseSha) {
        slot.laps = (slot.laps ?? 0) + 1;
      }
      slot.headSha = headSha;
      slot.baseSha = baseSha;
      slot.updatedAtMs = nowMs ?? Date.now();
    });
  }

  async release(
    owner: string,
    repo: string,
    baseBranch: string,
    opts?: { terminal?: Omit<StrictRefreshTerminal, "atMs">; nowMs?: number }
  ): Promise<void> {
    await this.locked(() => {
      const key = slotKey(owner, repo, baseBranch);
      this.slots.delete(key);
      if (opts?.terminal) {
        this.terminals.set(key, { ...opts.terminal, atMs: opts.nowMs ?? Date.now() });
      }
    });
  }

  async releaseIfHolder(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string,
    opts?: { terminal?: Omit<StrictRefreshTerminal, "atMs">; nowMs?: number }
  ): Promise<boolean> {
    return this.locked(() => {
      const key = slotKey(owner, repo, baseBranch);
      const slot = this.slots.get(key);
      if (!slot || slot.prNumber !== prNumber) return false;
      if ((slot.headSha ?? "").toLowerCase() !== (headSha ?? "").toLowerCase()) return false;
      this.slots.delete(key);
      if (opts?.terminal) {
        this.terminals.set(key, { ...opts.terminal, atMs: opts.nowMs ?? Date.now() });
      }
      return true;
    });
  }

  async listHeldSlots(): Promise<StrictRefreshSlot[]> {
    const held = [...this.slots.values()].map((slot) => ({ ...slot, laps: slot.laps ?? 0 }));
    held.sort((a, b) => a.admittedAtMs - b.admittedAtMs);
    return held;
  }
}

export class PgStrictRefreshSlotStore implements StrictRefreshSlotStore {
  constructor(private readonly sql: SqlClient) {}

  async migrate(): Promise<void> {
    try {
      await this.sql.unsafe(STRICT_REFRESH_SLOTS_SCHEMA_SQL);
      await this.sql.unsafe(
        `ALTER TABLE ${STRICT_REFRESH_SLOT_TABLE} ADD COLUMN IF NOT EXISTS laps INTEGER NOT NULL DEFAULT 0`
      );
    } catch (err) {
      wrapSqlError(err);
    }
  }

  private async withSlotLock<T>(
    owner: string,
    repo: string,
    baseBranch: string,
    fn: (tx: SqlClient) => Promise<T>
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [slotLockKey(owner, repo, baseBranch)]);
      return fn(tx);
    });
  }

  async getSlot(owner: string, repo: string, baseBranch: string): Promise<StrictRefreshSlot | undefined> {
    try {
      const rows = asRows<{
        pr_number: unknown;
        head_sha: unknown;
        base_sha: unknown;
        admitted_at: unknown;
        updated_at: unknown;
        laps: unknown;
      }>(
        await this.sql.unsafe(
          `SELECT pr_number, head_sha, base_sha, admitted_at, updated_at, laps FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
          [owner, repo, baseBranch]
        )
      );
      const row = rows[0];
      if (!row || row.pr_number == null) return undefined;
      const now = Date.now();
      return {
        owner,
        repo,
        baseBranch,
        prNumber: Number(row.pr_number),
        headSha: String(row.head_sha ?? ""),
        baseSha: String(row.base_sha ?? ""),
        admittedAtMs: epochMs(row.admitted_at, now),
        updatedAtMs: epochMs(row.updated_at, now),
        laps: Number(row.laps ?? 0),
      };
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async getTerminal(owner: string, repo: string, baseBranch: string): Promise<StrictRefreshTerminal | undefined> {
    try {
      const rows = asRows<{
        last_terminal_pr: unknown;
        last_terminal_head: unknown;
        last_terminal_base: unknown;
        last_terminal_reason: unknown;
        last_terminal_at: unknown;
      }>(
        await this.sql.unsafe(
          `SELECT last_terminal_pr, last_terminal_head, last_terminal_base, last_terminal_reason, last_terminal_at FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
          [owner, repo, baseBranch]
        )
      );
      const row = rows[0];
      if (!row || row.last_terminal_pr == null) return undefined;
      return {
        prNumber: Number(row.last_terminal_pr),
        headSha: String(row.last_terminal_head ?? ""),
        baseSha: String(row.last_terminal_base ?? ""),
        reason: String(row.last_terminal_reason ?? "terminal"),
        atMs: epochMs(row.last_terminal_at, Date.now()),
      };
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async tryAdmit(slot: StrictRefreshSlot): Promise<boolean> {
    try {
      return await this.withSlotLock(slot.owner, slot.repo, slot.baseBranch, async (tx) => {
        const existing = asRows<{ pr_number: unknown }>(
          await tx.unsafe(
            `SELECT pr_number FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [slot.owner, slot.repo, slot.baseBranch]
          )
        );
        if (existing[0]?.pr_number != null) return false;
        await tx.unsafe(
          `INSERT INTO ${STRICT_REFRESH_SLOT_TABLE} (owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9)
           ON CONFLICT (owner, repo, base_branch)
           DO UPDATE SET pr_number = EXCLUDED.pr_number, head_sha = EXCLUDED.head_sha, base_sha = EXCLUDED.base_sha,
             admitted_at = EXCLUDED.admitted_at, updated_at = EXCLUDED.updated_at, laps = EXCLUDED.laps
           WHERE ${STRICT_REFRESH_SLOT_TABLE}.pr_number IS NULL`,
          [
            slot.owner,
            slot.repo,
            slot.baseBranch,
            slot.prNumber,
            slot.headSha,
            slot.baseSha,
            new Date(slot.admittedAtMs).toISOString(),
            new Date(slot.updatedAtMs).toISOString(),
            slot.laps ?? 0,
          ]
        );
        const held = asRows<{ pr_number: unknown; head_sha: unknown }>(
          await tx.unsafe(
            `SELECT pr_number, head_sha FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [slot.owner, slot.repo, slot.baseBranch]
          )
        );
        const row = held[0];
        return (
          row?.pr_number != null &&
          Number(row.pr_number) === slot.prNumber &&
          String(row.head_sha ?? "") === slot.headSha
        );
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async touch(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string,
    baseSha: string,
    nowMs?: number
  ): Promise<void> {
    try {
      await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        await tx.unsafe(
          `UPDATE ${STRICT_REFRESH_SLOT_TABLE}
           SET head_sha = $5, base_sha = $6, updated_at = $7::timestamptz,
             laps = CASE WHEN base_sha IS DISTINCT FROM $6 THEN COALESCE(laps, 0) + 1 ELSE COALESCE(laps, 0) END
           WHERE owner = $1 AND repo = $2 AND base_branch = $3 AND pr_number = $4`,
          [owner, repo, baseBranch, prNumber, headSha, baseSha, new Date(nowMs ?? Date.now()).toISOString()]
        );
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async release(
    owner: string,
    repo: string,
    baseBranch: string,
    opts?: { terminal?: Omit<StrictRefreshTerminal, "atMs">; nowMs?: number }
  ): Promise<void> {
    try {
      await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        const nowIso = new Date(opts?.nowMs ?? Date.now()).toISOString();
        if (opts?.terminal) {
          await tx.unsafe(
            `INSERT INTO ${STRICT_REFRESH_SLOT_TABLE} (owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps,
               last_terminal_pr, last_terminal_head, last_terminal_base, last_terminal_reason, last_terminal_at)
             VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, $4::timestamptz, 0, $5, $6, $7, $8, $4::timestamptz)
             ON CONFLICT (owner, repo, base_branch)
             DO UPDATE SET pr_number = NULL, head_sha = NULL, base_sha = NULL, admitted_at = NULL,
               updated_at = EXCLUDED.updated_at, laps = 0,
               last_terminal_pr = EXCLUDED.last_terminal_pr, last_terminal_head = EXCLUDED.last_terminal_head,
               last_terminal_base = EXCLUDED.last_terminal_base, last_terminal_reason = EXCLUDED.last_terminal_reason,
               last_terminal_at = EXCLUDED.last_terminal_at`,
            [
              owner,
              repo,
              baseBranch,
              nowIso,
              opts.terminal.prNumber,
              opts.terminal.headSha,
              opts.terminal.baseSha,
              opts.terminal.reason,
            ]
          );
        } else {
          await tx.unsafe(
            `UPDATE ${STRICT_REFRESH_SLOT_TABLE}
             SET pr_number = NULL, head_sha = NULL, base_sha = NULL, admitted_at = NULL, updated_at = $4::timestamptz, laps = 0
             WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [owner, repo, baseBranch, nowIso]
          );
        }
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async releaseIfHolder(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string,
    opts?: { terminal?: Omit<StrictRefreshTerminal, "atMs">; nowMs?: number }
  ): Promise<boolean> {
    try {
      return await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        const rows = asRows<{ pr_number: unknown; head_sha: unknown }>(
          await tx.unsafe(
            `SELECT pr_number, head_sha FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [owner, repo, baseBranch]
          )
        );
        const row = rows[0];
        if (row?.pr_number == null || Number(row.pr_number) !== prNumber) return false;
        if (String(row.head_sha ?? "").toLowerCase() !== (headSha ?? "").toLowerCase()) return false;
        const nowIso = new Date(opts?.nowMs ?? Date.now()).toISOString();
        if (opts?.terminal) {
          await tx.unsafe(
            `INSERT INTO ${STRICT_REFRESH_SLOT_TABLE} (owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps,
               last_terminal_pr, last_terminal_head, last_terminal_base, last_terminal_reason, last_terminal_at)
              VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, $4::timestamptz, 0, $5, $6, $7, $8, $4::timestamptz)
              ON CONFLICT (owner, repo, base_branch)
              DO UPDATE SET pr_number = NULL, head_sha = NULL, base_sha = NULL, admitted_at = NULL,
                updated_at = EXCLUDED.updated_at, laps = 0,
                last_terminal_pr = EXCLUDED.last_terminal_pr, last_terminal_head = EXCLUDED.last_terminal_head,
                last_terminal_base = EXCLUDED.last_terminal_base, last_terminal_reason = EXCLUDED.last_terminal_reason,
                last_terminal_at = EXCLUDED.last_terminal_at`,
            [
              owner,
              repo,
              baseBranch,
              nowIso,
              opts.terminal.prNumber,
              opts.terminal.headSha,
              opts.terminal.baseSha,
              opts.terminal.reason,
            ]
          );
        } else {
          await tx.unsafe(
            `UPDATE ${STRICT_REFRESH_SLOT_TABLE}
              SET pr_number = NULL, head_sha = NULL, base_sha = NULL, admitted_at = NULL, updated_at = $4::timestamptz, laps = 0
              WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [owner, repo, baseBranch, nowIso]
          );
        }
        return true;
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async listHeldSlots(): Promise<StrictRefreshSlot[]> {
    try {
      const rows = asRows<{
        owner: unknown;
        repo: unknown;
        base_branch: unknown;
        pr_number: unknown;
        head_sha: unknown;
        base_sha: unknown;
        admitted_at: unknown;
        updated_at: unknown;
        laps: unknown;
      }>(
        await this.sql.unsafe(
          `SELECT owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE pr_number IS NOT NULL ORDER BY admitted_at ASC NULLS LAST`
        )
      );
      const now = Date.now();
      return rows.flatMap((row) => {
        if (row.pr_number == null) return [];
        return [
          {
            owner: String(row.owner ?? ""),
            repo: String(row.repo ?? ""),
            baseBranch: String(row.base_branch ?? ""),
            prNumber: Number(row.pr_number),
            headSha: String(row.head_sha ?? ""),
            baseSha: String(row.base_sha ?? ""),
            admittedAtMs: epochMs(row.admitted_at, now),
            updatedAtMs: epochMs(row.updated_at, now),
            laps: Number(row.laps ?? 0),
          },
        ];
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }
}
