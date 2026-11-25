import { randomUUID } from "node:crypto";
import type { SqlClient } from "./sql_client.ts";

/**
 * Durable push-confirmation obligation (issue #895).
 *
 * Before pushing to a PR branch Jumi records one obligation per
 * `(owner, repo, pr_number)`: the intended head SHA, branch, and a due time
 * a few minutes out. A `synchronize` (or any PR read) showing that head
 * completes the obligation. When due without that, the drain re-reads the PR:
 * a matching head runs the normal "new head" path (CI wait, review)
 * idempotently; a mismatch retries with backoff within a small budget, then
 * exhausts to the board. API/network errors are retryable, never a mismatch.
 *
 * Reuses the automerge-reconcile obligation pattern: one row per PR,
 * cause-idempotent requests, monotonic generations, lease + generation fence.
 */

export const PUSH_CONFIRM_DELAY_MS = 3 * 60 * 1000;
const PUSH_CONFIRM_MAX_ATTEMPTS = 4;
const PUSH_CONFIRM_BACKOFFS_MS = [60_000, 120_000, 180_000] as const;
const PUSH_CONFIRM_MARKER_PREFIX = "push-confirm:";

export const PUSH_CONFIRM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_confirm (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  generation BIGINT NOT NULL,
  expected_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'exhausted')),
  retry_marker TEXT,
  next_attempt_at TIMESTAMPTZ,
  lease_token TEXT,
  leased_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner, repo, pr_number)
);

CREATE TABLE IF NOT EXISTS push_confirm_cause (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  cause_id TEXT NOT NULL,
  admitted_generation BIGINT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner, repo, pr_number, cause_id)
);

CREATE SEQUENCE IF NOT EXISTS push_confirm_generation_seq;
`;

export interface PushConfirmRequestResult {
  status: "created" | "bumped" | "revived" | "duplicate";
  generation: number;
}

export type PushConfirmSettleResult = "deleted" | "stale";

export interface PushConfirmClaimedRow {
  owner: string;
  repo: string;
  prNumber: number;
  generation: number;
  expectedSha: string;
  branch: string;
  retryMarker: string | null;
  nextAttemptAtMs: number | null;
}

export type PushConfirmCompleteResult = "deleted" | "rearmed" | "lost";
export type PushConfirmFailResult = "retry" | "exhausted" | "rearmed" | "lost";
export type PushConfirmBlockResult = "exhausted" | "rearmed" | "lost";

export type PushConfirmConfirmResult = "confirmed" | "mismatch" | "unknown";

export interface PushConfirmExhaustedRow {
  owner: string;
  repo: string;
  prNumber: number;
  generation: number;
  expectedSha: string;
  branch: string;
  retryMarker: string | null;
  lastError: string | null;
  updatedAtMs: number;
}

export interface PushConfirmStore {
  request(
    owner: string,
    repo: string,
    prNumber: number,
    expectedSha: string,
    branch: string,
    causeId: string,
    nowMs: number
  ): Promise<PushConfirmRequestResult>;
  /** Complete when a PR read shows the expected head. No lease needed. */
  confirm(owner: string, repo: string, prNumber: number, headSha: string): Promise<PushConfirmConfirmResult>;
  settle(owner: string, repo: string, prNumber: number, generation: number): Promise<PushConfirmSettleResult>;
  claimDue(token: string, leaseMs: number, limit: number, nowMs: number): Promise<PushConfirmClaimedRow[]>;
  renew(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    leaseMs: number,
    nowMs: number
  ): Promise<boolean>;
  complete(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    nowMs: number
  ): Promise<PushConfirmCompleteResult>;
  fail(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    error: string,
    nowMs: number
  ): Promise<PushConfirmFailResult>;
  block(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    diagnostic: string,
    nowMs: number
  ): Promise<PushConfirmBlockResult>;
  listExhausted(limit: number): Promise<PushConfirmExhaustedRow[]>;
  /** Dismiss an exhausted row from the board (operator acknowledged). */
  dismiss(owner: string, repo: string, prNumber: number): Promise<boolean>;
}

export function pushConfirmExhaustedMessage(expectedSha: string): string {
  return `forge did not register push ${expectedSha}`;
}

/** Best-effort completion of a push obligation from any PR read showing the head. */
export async function confirmPushFromPrRead(
  store: { pushConfirm?: Pick<PushConfirmStore, "confirm"> } | undefined,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  logger?: (message: string) => void
): Promise<void> {
  try {
    await store?.pushConfirm?.confirm(owner, repo, prNumber, headSha);
  } catch (err) {
    logger?.(
      `push confirm settle failed ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Extract the push-confirmation store from worker job opts (ledger tick). Local/dev has none. */
export function pushConfirmForJobOpts(opts: {
  ledger?: { pushConfirm?: PushConfirmStore } | undefined;
  reviewQueue?: { pushConfirm?: PushConfirmStore } | undefined;
}): PushConfirmStore | undefined {
  return opts.ledger?.pushConfirm ?? opts.reviewQueue?.pushConfirm;
}

export interface PushObligationLoop {
  runConfiguredGit: (args: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => Promise<string>;
  worktree: string;
  env: Record<string, string | undefined>;
}

/** Record the push obligation before pushing. Returns the generation, or undefined when skipped.
 *
 * The cause is a fresh UUID per push attempt (not the head SHA): re-pushing
 * the same HEAD after a confirm/settle delete or after a failed-push discard
 * must admit a new generation, otherwise the retry would run with no
 * confirmation. Dedupe across concurrent records for the same PR still holds
 * because the latest request bumps the single per-PR row; a late duplicate
 * for an older generation settles as stale via the generation fence. */
export async function recordPushObligationBeforePush(
  loop: PushObligationLoop,
  store: PushConfirmStore | undefined,
  owner: string,
  repo: string,
  prNumber: number,
  branch: string,
  log?: (message: string) => void
): Promise<number | undefined> {
  if (!store) return undefined;
  try {
    const head = (await loop.runConfiguredGit(["rev-parse", "HEAD"], { cwd: loop.worktree, env: loop.env })).trim();
    if (!head || /^0+$/.test(head)) return undefined;
    const causeId = randomUUID();
    const admitted = await store.request(owner, repo, prNumber, head, branch, causeId, Date.now());
    log?.(`push confirm recorded ${owner}/${repo}#${prNumber}@${head.slice(0, 12)} generation=${admitted.generation}`);
    return admitted.generation;
  } catch (err) {
    log?.(
      `push confirm record failed ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/** Drop the push obligation when the push itself failed. Best-effort. */
export async function discardPushObligationAfterFailedPush(
  store: PushConfirmStore | undefined,
  owner: string,
  repo: string,
  prNumber: number,
  generation: number | undefined
): Promise<void> {
  if (!store || generation === undefined) return;
  try {
    await store.settle(owner, repo, prNumber, generation);
  } catch {
    // Best-effort: a failed push leaves no obligation to confirm.
  }
}

function obligationKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

function causeKey(owner: string, repo: string, prNumber: number, causeId: string): string {
  return `${owner}/${repo}#${prNumber}\0${causeId}`;
}

function parsePushMarker(retryMarker: string | null): { count: number; firstFailAt: number } | undefined {
  if (!retryMarker?.startsWith(PUSH_CONFIRM_MARKER_PREFIX)) return undefined;
  const parts = retryMarker.slice(PUSH_CONFIRM_MARKER_PREFIX.length).split(":");
  const count = Number(parts[0]);
  const firstFailAt = Number(parts[1]);
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(firstFailAt)) return undefined;
  return { count, firstFailAt };
}

function encodePushMarker(count: number, firstFailAt: number): string {
  return `${PUSH_CONFIRM_MARKER_PREFIX}${count}:${firstFailAt}`;
}

function backoffForCount(count: number): number {
  const idx = Math.min(Math.max(count, 1), PUSH_CONFIRM_BACKOFFS_MS.length) - 1;
  return PUSH_CONFIRM_BACKOFFS_MS[idx] ?? 180_000;
}

interface MemoryObligation {
  owner: string;
  repo: string;
  prNumber: number;
  generation: number;
  expectedSha: string;
  branch: string;
  state: "pending" | "exhausted";
  retryMarker: string | null;
  nextAttemptAtMs: number;
  leaseToken: string | null;
  leasedUntilMs: number | null;
  lastError: string | null;
  updatedAtMs: number;
}

function leaseLive(leasedUntilMs: number | null, nowMs: number): boolean {
  return leasedUntilMs != null && leasedUntilMs > nowMs;
}

function holderMatches(row: MemoryObligation, token: string, generation: number, nowMs: number): boolean {
  return row.leaseToken === token && row.generation === generation && leaseLive(row.leasedUntilMs, nowMs);
}

function tokenMatches(row: MemoryObligation, token: string, nowMs: number): boolean {
  return row.leaseToken === token && leaseLive(row.leasedUntilMs, nowMs);
}

function causePrefix(owner: string, repo: string, prNumber: number): string {
  return `${obligationKey(owner, repo, prNumber)}\0`;
}

export class MemoryPushConfirmStore implements PushConfirmStore {
  private readonly obligations = new Map<string, MemoryObligation>();
  private readonly causes = new Map<string, { admittedGeneration: number; seenAtMs: number }>();
  private nextGeneration = 1;
  private chain = Promise.resolve();

  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async request(
    owner: string,
    repo: string,
    prNumber: number,
    expectedSha: string,
    branch: string,
    causeId: string,
    nowMs: number
  ): Promise<PushConfirmRequestResult> {
    return this.locked(() => {
      const seen = this.causes.get(causeKey(owner, repo, prNumber, causeId));
      if (seen) return { status: "duplicate", generation: seen.admittedGeneration };
      const generation = this.nextGeneration++;
      this.causes.set(causeKey(owner, repo, prNumber, causeId), { admittedGeneration: generation, seenAtMs: nowMs });
      const key = obligationKey(owner, repo, prNumber);
      const row = this.obligations.get(key);
      if (!row) {
        this.obligations.set(key, {
          owner,
          repo,
          prNumber,
          generation,
          expectedSha,
          branch,
          state: "pending",
          retryMarker: null,
          nextAttemptAtMs: nowMs + PUSH_CONFIRM_DELAY_MS,
          leaseToken: null,
          leasedUntilMs: null,
          lastError: null,
          updatedAtMs: nowMs,
        });
        return { status: "created", generation };
      }
      const superseded = row.generation;
      if (row.state === "exhausted") {
        row.generation = generation;
        row.expectedSha = expectedSha;
        row.branch = branch;
        row.state = "pending";
        row.retryMarker = null;
        row.nextAttemptAtMs = nowMs + PUSH_CONFIRM_DELAY_MS;
        row.leaseToken = null;
        row.leasedUntilMs = null;
        row.lastError = null;
        row.updatedAtMs = nowMs;
        this.deleteCausesForGeneration(owner, repo, prNumber, superseded);
        return { status: "revived", generation };
      }
      row.generation = generation;
      row.expectedSha = expectedSha;
      row.branch = branch;
      row.retryMarker = null;
      row.nextAttemptAtMs = nowMs + PUSH_CONFIRM_DELAY_MS;
      row.updatedAtMs = nowMs;
      this.deleteCausesForGeneration(owner, repo, prNumber, superseded);
      return { status: "bumped", generation };
    });
  }

  async confirm(owner: string, repo: string, prNumber: number, headSha: string): Promise<PushConfirmConfirmResult> {
    return this.locked(() => {
      const row = this.obligations.get(obligationKey(owner, repo, prNumber));
      if (!row || row.state !== "pending") return "unknown";
      if (row.expectedSha !== headSha) return "mismatch";
      const generation = row.generation;
      this.obligations.delete(obligationKey(owner, repo, prNumber));
      this.deleteCausesForGeneration(owner, repo, prNumber, generation);
      return "confirmed";
    });
  }

  async settle(owner: string, repo: string, prNumber: number, generation: number): Promise<PushConfirmSettleResult> {
    return this.locked(() => {
      const row = this.obligations.get(obligationKey(owner, repo, prNumber));
      if (!row || row.generation !== generation) return "stale";
      this.obligations.delete(obligationKey(owner, repo, prNumber));
      this.deleteCausesForGeneration(owner, repo, prNumber, generation);
      return "deleted";
    });
  }

  async claimDue(token: string, leaseMs: number, limit: number, nowMs: number): Promise<PushConfirmClaimedRow[]> {
    return this.locked(() => {
      const due = [...this.obligations.values()]
        .filter(
          (row) =>
            row.state === "pending" &&
            row.nextAttemptAtMs <= nowMs &&
            (row.leaseToken == null || !leaseLive(row.leasedUntilMs, nowMs))
        )
        .sort(
          (a, b) =>
            a.nextAttemptAtMs - b.nextAttemptAtMs ||
            (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) ||
            (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0) ||
            a.prNumber - b.prNumber
        )
        .slice(0, Math.max(0, limit));
      const claimed: PushConfirmClaimedRow[] = [];
      for (const row of due) {
        row.leaseToken = token;
        row.leasedUntilMs = nowMs + leaseMs;
        row.updatedAtMs = nowMs;
        claimed.push({
          owner: row.owner,
          repo: row.repo,
          prNumber: row.prNumber,
          generation: row.generation,
          expectedSha: row.expectedSha,
          branch: row.branch,
          retryMarker: row.retryMarker,
          nextAttemptAtMs: row.nextAttemptAtMs,
        });
      }
      return claimed;
    });
  }

  async renew(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    leaseMs: number,
    nowMs: number
  ): Promise<boolean> {
    return this.locked(() => {
      const row = this.obligations.get(obligationKey(owner, repo, prNumber));
      if (!row || !holderMatches(row, token, generation, nowMs)) return false;
      row.leasedUntilMs = nowMs + leaseMs;
      row.updatedAtMs = nowMs;
      return true;
    });
  }

  async complete(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    nowMs: number
  ): Promise<PushConfirmCompleteResult> {
    return this.locked(() => {
      const row = this.obligations.get(obligationKey(owner, repo, prNumber));
      if (!row || !tokenMatches(row, token, nowMs)) return "lost";
      if (row.generation !== generation) {
        row.leaseToken = null;
        row.leasedUntilMs = null;
        row.nextAttemptAtMs = nowMs;
        row.updatedAtMs = nowMs;
        return "rearmed";
      }
      this.obligations.delete(obligationKey(owner, repo, prNumber));
      this.deleteCausesForGeneration(owner, repo, prNumber, generation);
      return "deleted";
    });
  }

  private deleteCausesForGeneration(owner: string, repo: string, prNumber: number, generation: number): void {
    const prefix = causePrefix(owner, repo, prNumber);
    for (const [key, value] of this.causes) {
      if (key.startsWith(prefix) && value.admittedGeneration === generation) this.causes.delete(key);
    }
  }

  private failLocked(row: MemoryObligation, error: string, nowMs: number): PushConfirmFailResult {
    const prev = parsePushMarker(row.retryMarker);
    const count = (prev?.count ?? 0) + 1;
    const firstFailAt = prev?.firstFailAt ?? nowMs;
    if (count >= PUSH_CONFIRM_MAX_ATTEMPTS) {
      row.state = "exhausted";
      row.lastError = error;
      row.leaseToken = null;
      row.leasedUntilMs = null;
      row.updatedAtMs = nowMs;
      return "exhausted";
    }
    row.retryMarker = encodePushMarker(count, firstFailAt);
    row.nextAttemptAtMs = nowMs + backoffForCount(count);
    row.lastError = error;
    row.leaseToken = null;
    row.leasedUntilMs = null;
    row.updatedAtMs = nowMs;
    return "retry";
  }

  async fail(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    error: string,
    nowMs: number
  ): Promise<PushConfirmFailResult> {
    return this.locked(() => {
      const row = this.obligations.get(obligationKey(owner, repo, prNumber));
      if (!row || !tokenMatches(row, token, nowMs)) return "lost";
      if (row.generation !== generation) {
        row.leaseToken = null;
        row.leasedUntilMs = null;
        row.nextAttemptAtMs = nowMs;
        row.updatedAtMs = nowMs;
        return "rearmed";
      }
      return this.failLocked(row, error, nowMs);
    });
  }

  async block(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    diagnostic: string,
    nowMs: number
  ): Promise<PushConfirmBlockResult> {
    return this.locked(() => {
      const row = this.obligations.get(obligationKey(owner, repo, prNumber));
      if (!row || !tokenMatches(row, token, nowMs)) return "lost";
      if (row.generation !== generation) {
        row.leaseToken = null;
        row.leasedUntilMs = null;
        row.nextAttemptAtMs = nowMs;
        row.updatedAtMs = nowMs;
        return "rearmed";
      }
      row.state = "exhausted";
      row.lastError = diagnostic;
      row.leaseToken = null;
      row.leasedUntilMs = null;
      row.updatedAtMs = nowMs;
      return "exhausted";
    });
  }

  async listExhausted(limit: number): Promise<PushConfirmExhaustedRow[]> {
    const rows = [...this.obligations.values()]
      .filter((row) => row.state === "exhausted")
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
      .slice(0, Math.max(0, limit));
    return rows.map((row) => ({
      owner: row.owner,
      repo: row.repo,
      prNumber: row.prNumber,
      generation: row.generation,
      expectedSha: row.expectedSha,
      branch: row.branch,
      retryMarker: row.retryMarker,
      lastError: row.lastError,
      updatedAtMs: row.updatedAtMs,
    }));
  }

  async dismiss(owner: string, repo: string, prNumber: number): Promise<boolean> {
    return this.locked(() => {
      const key = obligationKey(owner, repo, prNumber);
      const row = this.obligations.get(key);
      if (!row || row.state !== "exhausted") return false;
      const generation = row.generation;
      this.obligations.delete(key);
      this.deleteCausesForGeneration(owner, repo, prNumber, generation);
      return true;
    });
  }
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return Number(value);
}

function strOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function epochOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pushLockKey(owner: string, repo: string, prNumber: number): string {
  return `push-confirm:${owner}/${repo}#${prNumber}`;
}

export class PgPushConfirmStore implements PushConfirmStore {
  constructor(private readonly sql: SqlClient) {}

  async migrate(): Promise<void> {
    await this.sql.unsafe(PUSH_CONFIRM_SCHEMA_SQL);
  }

  async request(
    owner: string,
    repo: string,
    prNumber: number,
    expectedSha: string,
    branch: string,
    causeId: string,
    nowMs: number
  ): Promise<PushConfirmRequestResult> {
    const nowIso = new Date(nowMs).toISOString();
    const dueIso = new Date(nowMs + PUSH_CONFIRM_DELAY_MS).toISOString();
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [pushLockKey(owner, repo, prNumber)]);
      const seen = asRows<{ admitted_generation: unknown }>(
        await tx.unsafe(
          `SELECT admitted_generation FROM push_confirm_cause
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND cause_id = $4`,
          [owner, repo, prNumber, causeId]
        )
      );
      if (seen[0] != null) return { status: "duplicate", generation: num(seen[0].admitted_generation) };
      const allocated = asRows<{ generation: unknown }>(
        await tx.unsafe(`SELECT nextval('push_confirm_generation_seq') AS generation`)
      );
      const generation = num(allocated[0]?.generation);
      await tx.unsafe(
        `INSERT INTO push_confirm_cause (owner, repo, pr_number, cause_id, admitted_generation, seen_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
         ON CONFLICT (owner, repo, pr_number, cause_id) DO NOTHING`,
        [owner, repo, prNumber, causeId, generation, nowIso]
      );
      const raced = asRows<{ admitted_generation: unknown }>(
        await tx.unsafe(
          `SELECT admitted_generation FROM push_confirm_cause
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND cause_id = $4`,
          [owner, repo, prNumber, causeId]
        )
      );
      if (raced[0] != null && num(raced[0].admitted_generation) !== generation) {
        return { status: "duplicate", generation: num(raced[0].admitted_generation) };
      }
      const existing = asRows<{ generation: unknown; state: unknown }>(
        await tx.unsafe(
          `SELECT generation, state FROM push_confirm WHERE owner = $1 AND repo = $2 AND pr_number = $3 FOR UPDATE`,
          [owner, repo, prNumber]
        )
      );
      const row = existing[0];
      if (!row) {
        await tx.unsafe(
          `INSERT INTO push_confirm
             (owner, repo, pr_number, generation, expected_sha, branch, state, retry_marker, next_attempt_at,
              lease_token, leased_until, last_error, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', NULL, $7::timestamptz, NULL, NULL, NULL, $8::timestamptz, $8::timestamptz)`,
          [owner, repo, prNumber, generation, expectedSha, branch, dueIso, nowIso]
        );
        return { status: "created", generation };
      }
      if (String(row.state) === "exhausted") {
        await tx.unsafe(
          `UPDATE push_confirm
           SET generation = $4, expected_sha = $5, branch = $6, state = 'pending', retry_marker = NULL,
               next_attempt_at = $7::timestamptz, lease_token = NULL, leased_until = NULL, last_error = NULL,
               updated_at = $8::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, generation, expectedSha, branch, dueIso, nowIso]
        );
        await tx.unsafe(
          `DELETE FROM push_confirm_cause WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND admitted_generation = $4`,
          [owner, repo, prNumber, num(row.generation)]
        );
        return { status: "revived", generation };
      }
      await tx.unsafe(
        `UPDATE push_confirm
         SET generation = $4, expected_sha = $5, branch = $6, retry_marker = NULL,
             next_attempt_at = $7::timestamptz, updated_at = $8::timestamptz
         WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
        [owner, repo, prNumber, generation, expectedSha, branch, dueIso, nowIso]
      );
      await tx.unsafe(
        `DELETE FROM push_confirm_cause WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND admitted_generation = $4`,
        [owner, repo, prNumber, num(row.generation)]
      );
      return { status: "bumped", generation };
    });
  }

  async confirm(owner: string, repo: string, prNumber: number, headSha: string): Promise<PushConfirmConfirmResult> {
    const deleted = asRows<{ expected_sha: unknown; generation: unknown }>(
      await this.sql.unsafe(
        `DELETE FROM push_confirm
         WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND state = 'pending' AND expected_sha = $4
         RETURNING expected_sha, generation`,
        [owner, repo, prNumber, headSha]
      )
    );
    if (deleted.length > 0) {
      const generation = num((deleted[0] as { generation: unknown }).generation);
      await this.sql.unsafe(
        `DELETE FROM push_confirm_cause WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND admitted_generation = $4`,
        [owner, repo, prNumber, generation]
      );
      return "confirmed";
    }
    const existing = asRows<{ one: unknown }>(
      await this.sql.unsafe(
        `SELECT 1 AS one FROM push_confirm WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND state = 'pending' LIMIT 1`,
        [owner, repo, prNumber]
      )
    );
    return existing.length > 0 ? "mismatch" : "unknown";
  }

  async settle(owner: string, repo: string, prNumber: number, generation: number): Promise<PushConfirmSettleResult> {
    const deleted = asRows<{ generation: unknown }>(
      await this.sql.unsafe(
        `DELETE FROM push_confirm WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND generation = $4 RETURNING generation`,
        [owner, repo, prNumber, generation]
      )
    );
    if (deleted.length === 0) return "stale";
    await this.sql.unsafe(
      `DELETE FROM push_confirm_cause WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND admitted_generation = $4`,
      [owner, repo, prNumber, generation]
    );
    return "deleted";
  }

  async claimDue(token: string, leaseMs: number, limit: number, nowMs: number): Promise<PushConfirmClaimedRow[]> {
    const nowIso = new Date(nowMs).toISOString();
    const untilIso = new Date(nowMs + leaseMs).toISOString();
    const rows = asRows<{
      owner: unknown;
      repo: unknown;
      pr_number: unknown;
      generation: unknown;
      expected_sha: unknown;
      branch: unknown;
      retry_marker: unknown;
      next_attempt_at: unknown;
    }>(
      await this.sql.unsafe(
        `UPDATE push_confirm
         SET lease_token = $1, leased_until = $2::timestamptz, updated_at = $3::timestamptz
         WHERE (owner, repo, pr_number) IN (
           SELECT owner, repo, pr_number FROM push_confirm
           WHERE state = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= $3::timestamptz)
             AND (lease_token IS NULL OR leased_until IS NULL OR leased_until <= $3::timestamptz)
           ORDER BY next_attempt_at NULLS FIRST, owner ASC, repo ASC, pr_number ASC
           LIMIT $4
           FOR UPDATE SKIP LOCKED
         )
         RETURNING owner, repo, pr_number, generation, expected_sha, branch, retry_marker, next_attempt_at`,
        [token, untilIso, nowIso, Math.max(0, limit)]
      )
    );
    return rows.map((row) => ({
      owner: String(row.owner),
      repo: String(row.repo),
      prNumber: num(row.pr_number),
      generation: num(row.generation),
      expectedSha: String(row.expected_sha),
      branch: String(row.branch),
      retryMarker: strOrNull(row.retry_marker),
      nextAttemptAtMs: epochOrNull(row.next_attempt_at),
    }));
  }

  async renew(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    leaseMs: number,
    nowMs: number
  ): Promise<boolean> {
    const nowIso = new Date(nowMs).toISOString();
    const untilIso = new Date(nowMs + leaseMs).toISOString();
    const rows = asRows<{ generation: unknown }>(
      await this.sql.unsafe(
        `UPDATE push_confirm
         SET leased_until = $5::timestamptz, updated_at = $6::timestamptz
         WHERE owner = $1 AND repo = $2 AND pr_number = $3
           AND lease_token = $4 AND generation = $7 AND leased_until > $6::timestamptz
         RETURNING generation`,
        [owner, repo, prNumber, token, untilIso, nowIso, generation]
      )
    );
    return rows.length > 0;
  }

  private async withPrLock<T>(
    owner: string,
    repo: string,
    prNumber: number,
    fn: (tx: SqlClient) => Promise<T>
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [pushLockKey(owner, repo, prNumber)]);
      return fn(tx);
    });
  }

  async complete(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    nowMs: number
  ): Promise<PushConfirmCompleteResult> {
    const nowIso = new Date(nowMs).toISOString();
    return this.withPrLock(owner, repo, prNumber, async (tx) => {
      const rows = asRows<{ generation: unknown; lease_token: unknown; leased_until: unknown }>(
        await tx.unsafe(
          `SELECT generation, lease_token, leased_until FROM push_confirm WHERE owner = $1 AND repo = $2 AND pr_number = $3 FOR UPDATE`,
          [owner, repo, prNumber]
        )
      );
      const row = rows[0];
      if (!row || strOrNull(row.lease_token) !== token) return "lost";
      const leasedUntil = epochOrNull(row.leased_until);
      if (leasedUntil == null || leasedUntil <= nowMs) return "lost";
      if (num(row.generation) !== generation) {
        await tx.unsafe(
          `UPDATE push_confirm SET lease_token = NULL, leased_until = NULL, next_attempt_at = $4::timestamptz, updated_at = $4::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, nowIso]
        );
        return "rearmed";
      }
      await tx.unsafe(`DELETE FROM push_confirm WHERE owner = $1 AND repo = $2 AND pr_number = $3`, [
        owner,
        repo,
        prNumber,
      ]);
      await tx.unsafe(
        `DELETE FROM push_confirm_cause WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND admitted_generation = $4`,
        [owner, repo, prNumber, generation]
      );
      return "deleted";
    });
  }

  private decideFail(
    retryMarker: string | null,
    error: string,
    nowMs: number
  ): { retry: boolean; marker: string; backoffMs: number } {
    const prev = parsePushMarker(retryMarker);
    const count = (prev?.count ?? 0) + 1;
    if (count >= PUSH_CONFIRM_MAX_ATTEMPTS) return { retry: false, marker: retryMarker ?? "", backoffMs: 0 };
    void error;
    return {
      retry: true,
      marker: encodePushMarker(count, prev?.firstFailAt ?? nowMs),
      backoffMs: backoffForCount(count),
    };
  }

  async fail(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    error: string,
    nowMs: number
  ): Promise<PushConfirmFailResult> {
    const nowIso = new Date(nowMs).toISOString();
    return this.withPrLock(owner, repo, prNumber, async (tx) => {
      const rows = asRows<{ generation: unknown; lease_token: unknown; leased_until: unknown; retry_marker: unknown }>(
        await tx.unsafe(
          `SELECT generation, lease_token, leased_until, retry_marker FROM push_confirm WHERE owner = $1 AND repo = $2 AND pr_number = $3 FOR UPDATE`,
          [owner, repo, prNumber]
        )
      );
      const row = rows[0];
      if (!row || strOrNull(row.lease_token) !== token) return "lost";
      const leasedUntil = epochOrNull(row.leased_until);
      if (leasedUntil == null || leasedUntil <= nowMs) return "lost";
      if (num(row.generation) !== generation) {
        await tx.unsafe(
          `UPDATE push_confirm SET lease_token = NULL, leased_until = NULL, next_attempt_at = $4::timestamptz, updated_at = $4::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, nowIso]
        );
        return "rearmed";
      }
      const decision = this.decideFail(strOrNull(row.retry_marker), error, nowMs);
      if (decision.retry) {
        const nextIso = new Date(nowMs + decision.backoffMs).toISOString();
        await tx.unsafe(
          `UPDATE push_confirm SET retry_marker = $4, next_attempt_at = $5::timestamptz, lease_token = NULL, leased_until = NULL, last_error = $6, updated_at = $7::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, decision.marker, nextIso, error, nowIso]
        );
        return "retry";
      }
      await tx.unsafe(
        `UPDATE push_confirm SET state = 'exhausted', last_error = $4, lease_token = NULL, leased_until = NULL, updated_at = $5::timestamptz
         WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
        [owner, repo, prNumber, error, nowIso]
      );
      return "exhausted";
    });
  }

  async block(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    diagnostic: string,
    nowMs: number
  ): Promise<PushConfirmBlockResult> {
    const nowIso = new Date(nowMs).toISOString();
    return this.withPrLock(owner, repo, prNumber, async (tx) => {
      const rows = asRows<{ generation: unknown; lease_token: unknown; leased_until: unknown }>(
        await tx.unsafe(
          `SELECT generation, lease_token, leased_until FROM push_confirm WHERE owner = $1 AND repo = $2 AND pr_number = $3 FOR UPDATE`,
          [owner, repo, prNumber]
        )
      );
      const row = rows[0];
      if (!row || strOrNull(row.lease_token) !== token) return "lost";
      const leasedUntil = epochOrNull(row.leased_until);
      if (leasedUntil == null || leasedUntil <= nowMs) return "lost";
      if (num(row.generation) !== generation) {
        await tx.unsafe(
          `UPDATE push_confirm SET lease_token = NULL, leased_until = NULL, next_attempt_at = $4::timestamptz, updated_at = $4::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, nowIso]
        );
        return "rearmed";
      }
      await tx.unsafe(
        `UPDATE push_confirm SET state = 'exhausted', last_error = $4, lease_token = NULL, leased_until = NULL, updated_at = $5::timestamptz
         WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
        [owner, repo, prNumber, diagnostic, nowIso]
      );
      return "exhausted";
    });
  }

  async listExhausted(limit: number): Promise<PushConfirmExhaustedRow[]> {
    const rows = asRows<{
      owner: unknown;
      repo: unknown;
      pr_number: unknown;
      generation: unknown;
      expected_sha: unknown;
      branch: unknown;
      retry_marker: unknown;
      last_error: unknown;
      updated_at: unknown;
    }>(
      await this.sql.unsafe(
        `SELECT owner, repo, pr_number, generation, expected_sha, branch, retry_marker, last_error, updated_at
         FROM push_confirm WHERE state = 'exhausted' ORDER BY updated_at ASC LIMIT $1`,
        [Math.max(0, limit)]
      )
    );
    return rows.map((row) => ({
      owner: String(row.owner),
      repo: String(row.repo),
      prNumber: num(row.pr_number),
      generation: num(row.generation),
      expectedSha: String(row.expected_sha),
      branch: String(row.branch),
      retryMarker: strOrNull(row.retry_marker),
      lastError: strOrNull(row.last_error),
      updatedAtMs: epochOrNull(row.updated_at) ?? Date.now(),
    }));
  }

  async dismiss(owner: string, repo: string, prNumber: number): Promise<boolean> {
    const deleted = asRows<{ pr_number: unknown; generation: unknown }>(
      await this.sql.unsafe(
        `DELETE FROM push_confirm WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND state = 'exhausted' RETURNING pr_number, generation`,
        [owner, repo, prNumber]
      )
    );
    if (deleted.length === 0) return false;
    const generation = num((deleted[0] as { generation: unknown }).generation);
    await this.sql.unsafe(
      `DELETE FROM push_confirm_cause WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND admitted_generation = $4`,
      [owner, repo, prNumber, generation]
    );
    return true;
  }
}
