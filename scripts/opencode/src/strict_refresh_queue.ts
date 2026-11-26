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

export type StrictRefreshPhase = "held" | "retry" | "admit-next" | "needs-kick";

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
  pending_job JSONB,
  generation BIGINT NOT NULL DEFAULT 1,
  phase TEXT NOT NULL DEFAULT 'held',
  due_at TIMESTAMPTZ,
  retry_marker TEXT,
  last_error TEXT,
  PRIMARY KEY (owner, repo, base_branch)
);

CREATE SEQUENCE IF NOT EXISTS strict_refresh_generation_seq;
`;

/** Durable enqueue intent for the holder: stable job fields (no delivery). */
export interface StrictRefreshPendingJob {
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  htmlUrl: string;
  issueUpdatedAt: string;
  defaultBranch: string;
  cloneUrl: string;
}

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
  pendingJob?: StrictRefreshPendingJob | null;
  /** Monotonic admission generation. Every transition is fenced by it. */
  generation?: number;
  phase?: StrictRefreshPhase;
  dueAtMs?: number | null;
  retryMarker?: string | null;
  lastError?: string | null;
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
  tryAdmit(slot: StrictRefreshSlot, pendingJob?: StrictRefreshPendingJob | null): Promise<boolean>;
  /** Refresh the held slot's observed head/base without releasing it. No-op when empty or held by another PR. */
  touch(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string,
    baseSha: string,
    nowMs?: number,
    pendingJob?: StrictRefreshPendingJob | null
  ): Promise<void>;
  /** Clear the durable enqueue intent once its job is queued. Only clears the matching holder. */
  clearPending(owner: string, repo: string, baseBranch: string, prNumber: number, headSha: string): Promise<void>;
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
   * When `expectedGeneration` is set, the release additionally requires the
   * stored generation to match, so a stale result for an older admission of
   * the same PR/head never clobbers a newer admission.
   */
  releaseIfHolder(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string,
    opts?: { terminal?: Omit<StrictRefreshTerminal, "atMs">; nowMs?: number; expectedGeneration?: number }
  ): Promise<boolean>;
  /**
   * Atomically record `terminal` for the old holder (when set) and admit
   * `next` with its enqueue intent. Single statement: no free-slot window
   * between release and admit. Returns false when the holder changed.
   * When `expectedGeneration` is set, the handoff additionally requires the
   * stored generation to match.
   */
  handoff(
    owner: string,
    repo: string,
    baseBranch: string,
    opts: {
      expectedPrNumber?: number;
      expectedGeneration?: number;
      expectedHeadSha?: string;
      terminal?: Omit<StrictRefreshTerminal, "atMs"> | undefined;
      next: StrictRefreshSlot;
      pendingJob?: StrictRefreshPendingJob | null;
      nowMs?: number;
    }
  ): Promise<boolean>;
  /** Every currently held slot, oldest first. Powers the engine-tick expiry. */
  listHeldSlots(): Promise<StrictRefreshSlot[]>;
  /** Record a retryable failure with backoff. Fenced by generation. */
  setRetry(
    owner: string,
    repo: string,
    baseBranch: string,
    expectedGeneration: number,
    retryMarker: string,
    dueAtMs: number,
    lastError: string,
    nowMs?: number,
    pendingJob?: StrictRefreshPendingJob | null
  ): Promise<boolean>;
  /** Exhaust the retry budget into a visible board row. Fenced by generation. */
  markNeedsKick(
    owner: string,
    repo: string,
    baseBranch: string,
    expectedGeneration: number,
    lastError: string,
    nowMs?: number
  ): Promise<boolean>;
  /** Release the holder into an admit-next obligation. Fenced by generation. */
  releaseToAdmitNext(
    owner: string,
    repo: string,
    baseBranch: string,
    expectedGeneration: number,
    nowMs?: number
  ): Promise<boolean>;
  /** Slots whose retry budget is exhausted and need an operator kick. */
  listNeedsKick(): Promise<StrictRefreshSlot[]>;
  /** Branches with an admit-next obligation due. */
  listAdmitNextDue(nowMs: number): Promise<Array<{ owner: string; repo: string; baseBranch: string }>>;
  /**
   * Consume a due admit-next obligation after one bounded drain attempt,
   * whether or not a candidate was ready. A later push or stop re-creates
   * it. Returns true when an obligation was cleared.
   */
  consumeAdmitNext(owner: string, repo: string, baseBranch: string): Promise<boolean>;
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
  terminal: Pick<StrictRefreshTerminal, "prNumber" | "headSha" | "baseSha"> | undefined | null
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

function parsePendingJob(value: unknown): StrictRefreshPendingJob | null {
  if (!value) return null;
  try {
    const raw = typeof value === "string" ? JSON.parse(value) : value;
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.prNumber !== "number" || typeof rec.headSha !== "string") return null;
    return raw as StrictRefreshPendingJob;
  } catch {
    return null;
  }
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
  private readonly admitNext = new Map<string, { owner: string; repo: string; baseBranch: string; dueAtMs: number }>();
  private chain = Promise.resolve();
  private nextGeneration = 1;

  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private withDefaults(slot: StrictRefreshSlot): StrictRefreshSlot {
    return {
      ...slot,
      laps: slot.laps ?? 0,
      generation: slot.generation ?? 0,
      phase: slot.phase ?? "held",
    };
  }

  async getSlot(owner: string, repo: string, baseBranch: string): Promise<StrictRefreshSlot | undefined> {
    const slot = this.slots.get(slotKey(owner, repo, baseBranch));
    return slot ? { ...this.withDefaults(slot) } : undefined;
  }

  async getTerminal(owner: string, repo: string, baseBranch: string): Promise<StrictRefreshTerminal | undefined> {
    const terminal = this.terminals.get(slotKey(owner, repo, baseBranch));
    return terminal ? { ...terminal } : undefined;
  }

  async tryAdmit(slot: StrictRefreshSlot, pendingJob?: StrictRefreshPendingJob | null): Promise<boolean> {
    return this.locked(() => {
      const key = slotKey(slot.owner, slot.repo, slot.baseBranch);
      if (this.slots.has(key)) return false;
      const generation = slot.generation ?? this.nextGeneration++;
      this.slots.set(key, {
        ...this.withDefaults({ ...slot, generation, phase: slot.phase ?? "held" }),
        ...(pendingJob ? { pendingJob } : slot.pendingJob ? { pendingJob: slot.pendingJob } : {}),
      });
      this.admitNext.delete(key);
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
    nowMs?: number,
    pendingJob?: StrictRefreshPendingJob | null
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
      if (pendingJob !== undefined) {
        if (pendingJob) slot.pendingJob = pendingJob;
        else delete slot.pendingJob;
      }
    });
  }

  async clearPending(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string
  ): Promise<void> {
    await this.locked(() => {
      const key = slotKey(owner, repo, baseBranch);
      const slot = this.slots.get(key);
      if (!slot || slot.prNumber !== prNumber) return;
      if ((slot.headSha ?? "").toLowerCase() !== (headSha ?? "").toLowerCase()) return;
      delete slot.pendingJob;
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
    opts?: { terminal?: Omit<StrictRefreshTerminal, "atMs">; nowMs?: number; expectedGeneration?: number }
  ): Promise<boolean> {
    return this.locked(() => {
      const key = slotKey(owner, repo, baseBranch);
      const slot = this.slots.get(key);
      if (!slot || slot.prNumber !== prNumber) return false;
      if ((slot.headSha ?? "").toLowerCase() !== (headSha ?? "").toLowerCase()) return false;
      if (opts?.expectedGeneration !== undefined && (slot.generation ?? 0) !== opts.expectedGeneration) return false;
      this.slots.delete(key);
      if (opts?.terminal) {
        this.terminals.set(key, { ...opts.terminal, atMs: opts.nowMs ?? Date.now() });
      }
      return true;
    });
  }

  async listHeldSlots(): Promise<StrictRefreshSlot[]> {
    const held = [...this.slots.values()].map((slot) => ({ ...this.withDefaults(slot) }));
    held.sort((a, b) => a.admittedAtMs - b.admittedAtMs);
    return held;
  }

  async handoff(
    owner: string,
    repo: string,
    baseBranch: string,
    opts: {
      expectedPrNumber?: number;
      expectedGeneration?: number;
      expectedHeadSha?: string;
      terminal?: Omit<StrictRefreshTerminal, "atMs"> | undefined;
      next: StrictRefreshSlot;
      pendingJob?: StrictRefreshPendingJob | null;
      nowMs?: number;
    }
  ): Promise<boolean> {
    return this.locked(() => {
      const key = slotKey(owner, repo, baseBranch);
      const held = this.slots.get(key);
      if (opts.expectedPrNumber !== undefined) {
        if (!held || held.prNumber !== opts.expectedPrNumber) return false;
      }
      if (opts.expectedGeneration !== undefined) {
        if (!held || (held.generation ?? 0) !== opts.expectedGeneration) return false;
      }
      if (opts.expectedHeadSha !== undefined) {
        if (!held || (held.headSha ?? "").toLowerCase() !== opts.expectedHeadSha.toLowerCase()) return false;
      }
      const now = opts.nowMs ?? Date.now();
      if (opts.terminal) this.terminals.set(key, { ...opts.terminal, atMs: now });
      const generation = opts.next.generation ?? ((held?.generation ?? 0) + 1 || this.nextGeneration++);
      this.slots.set(key, {
        ...this.withDefaults({ ...opts.next, generation, phase: opts.next.phase ?? "held" }),
        ...(opts.pendingJob
          ? { pendingJob: opts.pendingJob }
          : opts.next.pendingJob
            ? { pendingJob: opts.next.pendingJob }
            : {}),
      });
      this.admitNext.delete(key);
      return true;
    });
  }

  async setRetry(
    owner: string,
    repo: string,
    baseBranch: string,
    expectedGeneration: number,
    retryMarker: string,
    dueAtMs: number,
    lastError: string,
    nowMs?: number,
    pendingJob?: StrictRefreshPendingJob | null
  ): Promise<boolean> {
    return this.locked(() => {
      const key = slotKey(owner, repo, baseBranch);
      const slot = this.slots.get(key);
      if (!slot || (slot.generation ?? 0) !== expectedGeneration) return false;
      slot.retryMarker = retryMarker;
      slot.dueAtMs = dueAtMs;
      slot.lastError = lastError;
      slot.phase = "retry";
      slot.updatedAtMs = nowMs ?? Date.now();
      if (pendingJob) slot.pendingJob = pendingJob;
      return true;
    });
  }

  async markNeedsKick(
    owner: string,
    repo: string,
    baseBranch: string,
    expectedGeneration: number,
    lastError: string,
    nowMs?: number
  ): Promise<boolean> {
    return this.locked(() => {
      const key = slotKey(owner, repo, baseBranch);
      const slot = this.slots.get(key);
      if (!slot || (slot.generation ?? 0) !== expectedGeneration) return false;
      slot.phase = "needs-kick";
      slot.lastError = lastError;
      slot.retryMarker = slot.retryMarker ?? null;
      slot.dueAtMs = null;
      slot.updatedAtMs = nowMs ?? Date.now();
      return true;
    });
  }

  async releaseToAdmitNext(
    owner: string,
    repo: string,
    baseBranch: string,
    expectedGeneration: number,
    nowMs?: number
  ): Promise<boolean> {
    return this.locked(() => {
      const key = slotKey(owner, repo, baseBranch);
      const slot = this.slots.get(key);
      if (slot && (slot.generation ?? 0) !== expectedGeneration) return false;
      if (slot) this.slots.delete(key);
      this.admitNext.set(key, { owner, repo, baseBranch, dueAtMs: nowMs ?? Date.now() });
      return true;
    });
  }

  async listNeedsKick(): Promise<StrictRefreshSlot[]> {
    return this.locked(() =>
      [...this.slots.values()].filter((s) => s.phase === "needs-kick").map((s) => ({ ...this.withDefaults(s) }))
    );
  }

  async listAdmitNextDue(nowMs: number): Promise<Array<{ owner: string; repo: string; baseBranch: string }>> {
    return this.locked(() => [...this.admitNext.values()].filter((r) => r.dueAtMs <= nowMs).map((r) => ({ ...r })));
  }

  async consumeAdmitNext(owner: string, repo: string, baseBranch: string): Promise<boolean> {
    return this.locked(() => this.admitNext.delete(slotKey(owner, repo, baseBranch)));
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
      await this.sql.unsafe(`ALTER TABLE ${STRICT_REFRESH_SLOT_TABLE} ADD COLUMN IF NOT EXISTS pending_job JSONB`);
      await this.sql.unsafe(
        `ALTER TABLE ${STRICT_REFRESH_SLOT_TABLE} ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1`
      );
      await this.sql.unsafe(
        `ALTER TABLE ${STRICT_REFRESH_SLOT_TABLE} ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'held'`
      );
      await this.sql.unsafe(`ALTER TABLE ${STRICT_REFRESH_SLOT_TABLE} ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`);
      await this.sql.unsafe(`ALTER TABLE ${STRICT_REFRESH_SLOT_TABLE} ADD COLUMN IF NOT EXISTS retry_marker TEXT`);
      await this.sql.unsafe(`ALTER TABLE ${STRICT_REFRESH_SLOT_TABLE} ADD COLUMN IF NOT EXISTS last_error TEXT`);
      await this.sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS strict_refresh_generation_seq`);
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
        pending_job: unknown;
        generation: unknown;
        phase: unknown;
        due_at: unknown;
        retry_marker: unknown;
        last_error: unknown;
      }>(
        await this.sql.unsafe(
          `SELECT pr_number, head_sha, base_sha, admitted_at, updated_at, laps, pending_job, generation, phase, due_at, retry_marker, last_error FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
          [owner, repo, baseBranch]
        )
      );
      const row = rows[0];
      if (!row || row.pr_number == null) return undefined;
      const now = Date.now();
      const pending = parsePendingJob(row.pending_job);
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
        ...(pending ? { pendingJob: pending } : {}),
        generation: Number(row.generation ?? 1),
        phase: (String(row.phase ?? "held") as StrictRefreshSlot["phase"]) ?? "held",
        dueAtMs: row.due_at == null ? null : epochMs(row.due_at, now),
        retryMarker: row.retry_marker == null ? null : String(row.retry_marker),
        lastError: row.last_error == null ? null : String(row.last_error),
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

  async tryAdmit(slot: StrictRefreshSlot, pendingJob?: StrictRefreshPendingJob | null): Promise<boolean> {
    try {
      return await this.withSlotLock(slot.owner, slot.repo, slot.baseBranch, async (tx) => {
        const existing = asRows<{ pr_number: unknown }>(
          await tx.unsafe(
            `SELECT pr_number FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [slot.owner, slot.repo, slot.baseBranch]
          )
        );
        if (existing[0]?.pr_number != null) return false;
        const pendingJson = (pendingJob ?? slot.pendingJob) ? JSON.stringify(pendingJob ?? slot.pendingJob) : null;
        const genRows = asRows<{ generation: unknown }>(
          await tx.unsafe(`SELECT nextval('strict_refresh_generation_seq') AS generation`)
        );
        const generation = slot.generation ?? Number(genRows[0]?.generation ?? 1);
        await tx.unsafe(
          `INSERT INTO ${STRICT_REFRESH_SLOT_TABLE} (owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps, pending_job, generation, phase, due_at, retry_marker, last_error)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10::jsonb, $11, $12, NULL, NULL, NULL)
           ON CONFLICT (owner, repo, base_branch)
           DO UPDATE SET pr_number = EXCLUDED.pr_number, head_sha = EXCLUDED.head_sha, base_sha = EXCLUDED.base_sha,
             admitted_at = EXCLUDED.admitted_at, updated_at = EXCLUDED.updated_at, laps = EXCLUDED.laps,
             pending_job = EXCLUDED.pending_job, generation = EXCLUDED.generation, phase = EXCLUDED.phase,
             due_at = NULL, retry_marker = NULL, last_error = NULL
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
            pendingJson,
            generation,
            slot.phase ?? "held",
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
    nowMs?: number,
    pendingJob?: StrictRefreshPendingJob | null
  ): Promise<void> {
    try {
      await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        const pendingJson = pendingJob === undefined ? null : pendingJob ? JSON.stringify(pendingJob) : null;
        await tx.unsafe(
          `UPDATE ${STRICT_REFRESH_SLOT_TABLE}
           SET head_sha = $5, base_sha = $6, updated_at = $7::timestamptz,
             laps = CASE WHEN base_sha IS DISTINCT FROM $6 THEN COALESCE(laps, 0) + 1 ELSE COALESCE(laps, 0) END
             ${pendingJob === undefined ? "" : ", pending_job = $8::jsonb"}
           WHERE owner = $1 AND repo = $2 AND base_branch = $3 AND pr_number = $4`,
          pendingJob === undefined
            ? [owner, repo, baseBranch, prNumber, headSha, baseSha, new Date(nowMs ?? Date.now()).toISOString()]
            : [
                owner,
                repo,
                baseBranch,
                prNumber,
                headSha,
                baseSha,
                new Date(nowMs ?? Date.now()).toISOString(),
                pendingJson,
              ]
        );
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async clearPending(
    owner: string,
    repo: string,
    baseBranch: string,
    prNumber: number,
    headSha: string
  ): Promise<void> {
    try {
      await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        await tx.unsafe(
          `UPDATE ${STRICT_REFRESH_SLOT_TABLE} SET pending_job = NULL
           WHERE owner = $1 AND repo = $2 AND base_branch = $3 AND pr_number = $4 AND LOWER(head_sha) = LOWER($5)`,
          [owner, repo, baseBranch, prNumber, headSha]
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
            `INSERT INTO ${STRICT_REFRESH_SLOT_TABLE} (owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps, pending_job,
               last_terminal_pr, last_terminal_head, last_terminal_base, last_terminal_reason, last_terminal_at)
             VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, $4::timestamptz, 0, NULL, $5, $6, $7, $8, $4::timestamptz)
             ON CONFLICT (owner, repo, base_branch)
             DO UPDATE SET pr_number = NULL, head_sha = NULL, base_sha = NULL, admitted_at = NULL,
               updated_at = EXCLUDED.updated_at, laps = 0, pending_job = NULL,
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
             SET pr_number = NULL, head_sha = NULL, base_sha = NULL, admitted_at = NULL, updated_at = $4::timestamptz, laps = 0, pending_job = NULL
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
    opts?: { terminal?: Omit<StrictRefreshTerminal, "atMs">; nowMs?: number; expectedGeneration?: number }
  ): Promise<boolean> {
    try {
      return await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        const rows = asRows<{ pr_number: unknown; head_sha: unknown; generation: unknown }>(
          await tx.unsafe(
            `SELECT pr_number, head_sha, generation FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [owner, repo, baseBranch]
          )
        );
        const row = rows[0];
        if (row?.pr_number == null || Number(row.pr_number) !== prNumber) return false;
        if (String(row.head_sha ?? "").toLowerCase() !== (headSha ?? "").toLowerCase()) return false;
        if (opts?.expectedGeneration !== undefined && Number(row.generation ?? 1) !== opts.expectedGeneration)
          return false;
        const nowIso = new Date(opts?.nowMs ?? Date.now()).toISOString();
        if (opts?.terminal) {
          await tx.unsafe(
            `INSERT INTO ${STRICT_REFRESH_SLOT_TABLE} (owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps, pending_job,
               last_terminal_pr, last_terminal_head, last_terminal_base, last_terminal_reason, last_terminal_at)
              VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, $4::timestamptz, 0, NULL, $5, $6, $7, $8, $4::timestamptz)
              ON CONFLICT (owner, repo, base_branch)
              DO UPDATE SET pr_number = NULL, head_sha = NULL, base_sha = NULL, admitted_at = NULL,
                updated_at = EXCLUDED.updated_at, laps = 0, pending_job = NULL,
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
              SET pr_number = NULL, head_sha = NULL, base_sha = NULL, admitted_at = NULL, updated_at = $4::timestamptz, laps = 0, pending_job = NULL
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

  async handoff(
    owner: string,
    repo: string,
    baseBranch: string,
    opts: {
      expectedPrNumber?: number;
      expectedGeneration?: number;
      expectedHeadSha?: string;
      terminal?: Omit<StrictRefreshTerminal, "atMs"> | undefined;
      next: StrictRefreshSlot;
      pendingJob?: StrictRefreshPendingJob | null;
      nowMs?: number;
    }
  ): Promise<boolean> {
    try {
      return await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        if (
          opts.expectedPrNumber !== undefined ||
          opts.expectedGeneration !== undefined ||
          opts.expectedHeadSha !== undefined
        ) {
          const cur = asRows<{ pr_number: unknown; generation: unknown; head_sha: unknown }>(
            await tx.unsafe(
              `SELECT pr_number, generation, head_sha FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
              [owner, repo, baseBranch]
            )
          );
          if (opts.expectedPrNumber !== undefined) {
            if (cur[0]?.pr_number == null || Number(cur[0].pr_number) !== opts.expectedPrNumber) return false;
          }
          if (opts.expectedGeneration !== undefined) {
            if (cur[0]?.pr_number == null || Number(cur[0]?.generation ?? 1) !== opts.expectedGeneration) return false;
          }
          if (opts.expectedHeadSha !== undefined) {
            if (String(cur[0]?.head_sha ?? "").toLowerCase() !== opts.expectedHeadSha.toLowerCase()) return false;
          }
        } else {
          const cur = asRows<{ pr_number: unknown }>(
            await tx.unsafe(
              `SELECT pr_number FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
              [owner, repo, baseBranch]
            )
          );
          void cur;
        }
        const nowIso = new Date(opts.nowMs ?? Date.now()).toISOString();
        const pendingJson =
          (opts.pendingJob ?? opts.next.pendingJob) ? JSON.stringify(opts.pendingJob ?? opts.next.pendingJob) : null;
        const term = opts.terminal;
        const genRows = asRows<{ generation: unknown }>(
          await tx.unsafe(`SELECT nextval('strict_refresh_generation_seq') AS generation`)
        );
        const nextGen = opts.next.generation ?? Number(genRows[0]?.generation ?? 1);
        await tx.unsafe(
          `INSERT INTO ${STRICT_REFRESH_SLOT_TABLE} (owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps, pending_job, generation, phase, due_at, retry_marker, last_error,
             last_terminal_pr, last_terminal_head, last_terminal_base, last_terminal_reason, last_terminal_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10::jsonb, $11, $12, NULL, NULL, NULL,
             $13, $14, $15, $16, ${term ? "$8::timestamptz" : "NULL"})
           ON CONFLICT (owner, repo, base_branch)
           DO UPDATE SET pr_number = EXCLUDED.pr_number, head_sha = EXCLUDED.head_sha, base_sha = EXCLUDED.base_sha,
             admitted_at = EXCLUDED.admitted_at, updated_at = EXCLUDED.updated_at, laps = EXCLUDED.laps,
             pending_job = EXCLUDED.pending_job, generation = EXCLUDED.generation, phase = EXCLUDED.phase,
             due_at = NULL, retry_marker = NULL, last_error = NULL
             ${term ? ", last_terminal_pr = EXCLUDED.last_terminal_pr, last_terminal_head = EXCLUDED.last_terminal_head, last_terminal_base = EXCLUDED.last_terminal_base, last_terminal_reason = EXCLUDED.last_terminal_reason, last_terminal_at = EXCLUDED.last_terminal_at" : ""}`,
          term
            ? [
                owner,
                repo,
                baseBranch,
                opts.next.prNumber,
                opts.next.headSha,
                opts.next.baseSha,
                new Date(opts.next.admittedAtMs).toISOString(),
                nowIso,
                opts.next.laps ?? 0,
                pendingJson,
                nextGen,
                opts.next.phase ?? "held",
                term.prNumber,
                term.headSha,
                term.baseSha,
                term.reason,
              ]
            : [
                owner,
                repo,
                baseBranch,
                opts.next.prNumber,
                opts.next.headSha,
                opts.next.baseSha,
                new Date(opts.next.admittedAtMs).toISOString(),
                nowIso,
                opts.next.laps ?? 0,
                pendingJson,
                nextGen,
                opts.next.phase ?? "held",
                null,
                null,
                null,
                null,
              ]
        );
        const held = asRows<{ pr_number: unknown; head_sha: unknown }>(
          await tx.unsafe(
            `SELECT pr_number, head_sha FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [owner, repo, baseBranch]
          )
        );
        const row = held[0];
        return (
          row?.pr_number != null &&
          Number(row.pr_number) === opts.next.prNumber &&
          String(row.head_sha ?? "") === opts.next.headSha
        );
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
        pending_job: unknown;
        generation: unknown;
        phase: unknown;
        due_at: unknown;
        retry_marker: unknown;
        last_error: unknown;
      }>(
        await this.sql.unsafe(
          `SELECT owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps, pending_job, generation, phase, due_at, retry_marker, last_error FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE pr_number IS NOT NULL ORDER BY admitted_at ASC NULLS LAST`
        )
      );
      const now = Date.now();
      return rows.flatMap((row) => {
        if (row.pr_number == null) return [];
        const pending = parsePendingJob(row.pending_job);
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
            ...(pending ? { pendingJob: pending } : {}),
            generation: Number(row.generation ?? 1),
            phase: (String(row.phase ?? "held") as StrictRefreshSlot["phase"]) ?? "held",
            dueAtMs: row.due_at == null ? null : epochMs(row.due_at, now),
            retryMarker: row.retry_marker == null ? null : String(row.retry_marker),
            lastError: row.last_error == null ? null : String(row.last_error),
          },
        ];
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async setRetry(
    owner: string,
    repo: string,
    baseBranch: string,
    expectedGeneration: number,
    retryMarker: string,
    dueAtMs: number,
    lastError: string,
    nowMs?: number,
    pendingJob?: StrictRefreshPendingJob | null
  ): Promise<boolean> {
    try {
      return await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        const rows = asRows<{ generation: unknown; pr_number: unknown }>(
          await tx.unsafe(
            `SELECT generation, pr_number FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [owner, repo, baseBranch]
          )
        );
        const row = rows[0];
        if (row?.pr_number == null || Number(row.generation ?? 1) !== expectedGeneration) return false;
        const pendingJson = pendingJob ? JSON.stringify(pendingJob) : null;
        if (pendingJob) {
          await tx.unsafe(
            `UPDATE ${STRICT_REFRESH_SLOT_TABLE} SET retry_marker = $4, due_at = $5::timestamptz, last_error = $6, phase = 'retry', updated_at = $7::timestamptz, pending_job = $8::jsonb WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [
              owner,
              repo,
              baseBranch,
              retryMarker,
              new Date(dueAtMs).toISOString(),
              lastError,
              new Date(nowMs ?? Date.now()).toISOString(),
              pendingJson,
            ]
          );
        } else {
          await tx.unsafe(
            `UPDATE ${STRICT_REFRESH_SLOT_TABLE} SET retry_marker = $4, due_at = $5::timestamptz, last_error = $6, phase = 'retry', updated_at = $7::timestamptz WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [
              owner,
              repo,
              baseBranch,
              retryMarker,
              new Date(dueAtMs).toISOString(),
              lastError,
              new Date(nowMs ?? Date.now()).toISOString(),
            ]
          );
        }
        return true;
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async markNeedsKick(
    owner: string,
    repo: string,
    baseBranch: string,
    expectedGeneration: number,
    lastError: string,
    nowMs?: number
  ): Promise<boolean> {
    try {
      return await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        const rows = asRows<{ generation: unknown; pr_number: unknown }>(
          await tx.unsafe(
            `SELECT generation, pr_number FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [owner, repo, baseBranch]
          )
        );
        const row = rows[0];
        if (row?.pr_number == null || Number(row.generation ?? 1) !== expectedGeneration) return false;
        await tx.unsafe(
          `UPDATE ${STRICT_REFRESH_SLOT_TABLE} SET phase = 'needs-kick', last_error = $4, due_at = NULL, updated_at = $5::timestamptz WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
          [owner, repo, baseBranch, lastError, new Date(nowMs ?? Date.now()).toISOString()]
        );
        return true;
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async releaseToAdmitNext(
    owner: string,
    repo: string,
    baseBranch: string,
    expectedGeneration: number,
    nowMs?: number
  ): Promise<boolean> {
    try {
      return await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        const rows = asRows<{ generation: unknown; pr_number: unknown }>(
          await tx.unsafe(
            `SELECT generation, pr_number FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [owner, repo, baseBranch]
          )
        );
        const row = rows[0];
        if (row?.pr_number != null && Number(row.generation ?? 1) !== expectedGeneration) return false;
        const nowIso = new Date(nowMs ?? Date.now()).toISOString();
        await tx.unsafe(
          `UPDATE ${STRICT_REFRESH_SLOT_TABLE} SET pr_number = NULL, head_sha = NULL, base_sha = NULL, admitted_at = NULL, updated_at = $4::timestamptz, laps = 0, pending_job = NULL, phase = 'admit-next', due_at = $4::timestamptz, retry_marker = NULL, last_error = NULL WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
          [owner, repo, baseBranch, nowIso]
        );
        const created = asRows<{ one: unknown }>(
          await tx.unsafe(
            `SELECT 1 AS one FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3`,
            [owner, repo, baseBranch]
          )
        );
        if (created.length === 0) {
          await tx.unsafe(
            `INSERT INTO ${STRICT_REFRESH_SLOT_TABLE} (owner, repo, base_branch, phase, due_at, updated_at, generation) VALUES ($1, $2, $3, 'admit-next', $4::timestamptz, $4::timestamptz, $5)`,
            [owner, repo, baseBranch, nowIso, expectedGeneration]
          );
        }
        return true;
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async listNeedsKick(): Promise<StrictRefreshSlot[]> {
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
        pending_job: unknown;
        generation: unknown;
        phase: unknown;
        due_at: unknown;
        retry_marker: unknown;
        last_error: unknown;
      }>(
        await this.sql.unsafe(
          `SELECT owner, repo, base_branch, pr_number, head_sha, base_sha, admitted_at, updated_at, laps, pending_job, generation, phase, due_at, retry_marker, last_error FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE pr_number IS NOT NULL AND phase = 'needs-kick' ORDER BY updated_at ASC`
        )
      );
      const now = Date.now();
      return rows.flatMap((row) => {
        if (row.pr_number == null) return [];
        const pending = parsePendingJob(row.pending_job);
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
            ...(pending ? { pendingJob: pending } : {}),
            generation: Number(row.generation ?? 1),
            phase: "needs-kick" as const,
            dueAtMs: row.due_at == null ? null : epochMs(row.due_at, now),
            retryMarker: row.retry_marker == null ? null : String(row.retry_marker),
            lastError: row.last_error == null ? null : String(row.last_error),
          },
        ];
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async listAdmitNextDue(nowMs: number): Promise<Array<{ owner: string; repo: string; baseBranch: string }>> {
    try {
      const rows = asRows<{ owner: unknown; repo: unknown; base_branch: unknown }>(
        await this.sql.unsafe(
          `SELECT owner, repo, base_branch FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE phase = 'admit-next' AND (due_at IS NULL OR due_at <= $1::timestamptz)`,
          [new Date(nowMs).toISOString()]
        )
      );
      return rows.map((row) => ({
        owner: String(row.owner),
        repo: String(row.repo),
        baseBranch: String(row.base_branch),
      }));
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async consumeAdmitNext(owner: string, repo: string, baseBranch: string): Promise<boolean> {
    try {
      return await this.withSlotLock(owner, repo, baseBranch, async (tx) => {
        const deleted = asRows<{ one: unknown }>(
          await tx.unsafe(
            `DELETE FROM ${STRICT_REFRESH_SLOT_TABLE} WHERE owner = $1 AND repo = $2 AND base_branch = $3 AND phase = 'admit-next' RETURNING 1 AS one`,
            [owner, repo, baseBranch]
          )
        );
        return deleted.length > 0;
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }
}
