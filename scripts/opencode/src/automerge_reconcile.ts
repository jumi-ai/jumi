import { decideInfraRetry } from "./infra.ts";
import { type SqlClient, wrapSqlError } from "./sql_client.ts";

/**
 * Durable automerge-reconcile obligation (issue #835).
 *
 * At most one "verify automerge cancellation for this PR" obligation per
 * `(owner, repo, pr_number)`. Requests carry a cause identity (the webhook
 * delivery); a repeated cause is idempotent even after the obligation row was
 * deleted. Generations come from one store-wide monotonic sequence and are
 * never reused, so a generation held by a stale caller can never equal a
 * newer row's even after deletion and re-creation.
 */

export const AUTOMERGE_RECONCILE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automerge_reconcile (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  generation BIGINT NOT NULL,
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

CREATE TABLE IF NOT EXISTS automerge_reconcile_cause (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  cause_id TEXT NOT NULL,
  admitted_generation BIGINT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner, repo, pr_number, cause_id)
);

CREATE SEQUENCE IF NOT EXISTS automerge_reconcile_generation_seq;
`;

export interface AutomergeReconcileRequestResult {
  status: "created" | "bumped" | "revived" | "duplicate";
  generation: number;
}

export type AutomergeReconcileSettleResult = "deleted" | "stale";

export interface AutomergeReconcileClaimedRow {
  owner: string;
  repo: string;
  prNumber: number;
  generation: number;
  retryMarker: string | null;
  nextAttemptAtMs: number | null;
}

export type AutomergeReconcileCompleteResult = "deleted" | "rearmed" | "lost";

export type AutomergeReconcileFailResult = "retry" | "exhausted" | "rearmed" | "lost";

export type AutomergeReconcileBlockResult = "exhausted" | "rearmed" | "lost";

export interface AutomergeReconcileExhaustedRow {
  owner: string;
  repo: string;
  prNumber: number;
  generation: number;
  retryMarker: string | null;
  lastError: string | null;
  updatedAtMs: number;
}

export interface AutomergeReconcileStore {
  request(
    owner: string,
    repo: string,
    prNumber: number,
    causeId: string,
    nowMs: number
  ): Promise<AutomergeReconcileRequestResult>;
  settle(owner: string, repo: string, prNumber: number, generation: number): Promise<AutomergeReconcileSettleResult>;
  claimDue(token: string, leaseMs: number, limit: number, nowMs: number): Promise<AutomergeReconcileClaimedRow[]>;
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
  ): Promise<AutomergeReconcileCompleteResult>;
  fail(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    error: string,
    nowMs: number
  ): Promise<AutomergeReconcileFailResult>;
  block(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    diagnostic: string,
    nowMs: number
  ): Promise<AutomergeReconcileBlockResult>;
  listExhausted(limit: number): Promise<AutomergeReconcileExhaustedRow[]>;
}

function obligationKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

function causeKey(owner: string, repo: string, prNumber: number, causeId: string): string {
  return `${owner}/${repo}#${prNumber}\0${causeId}`;
}

interface MemoryObligation {
  owner: string;
  repo: string;
  prNumber: number;
  generation: number;
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

export class MemoryAutomergeReconcileStore implements AutomergeReconcileStore {
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
    causeId: string,
    nowMs: number
  ): Promise<AutomergeReconcileRequestResult> {
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
          state: "pending",
          retryMarker: null,
          nextAttemptAtMs: nowMs,
          leaseToken: null,
          leasedUntilMs: null,
          lastError: null,
          updatedAtMs: nowMs,
        });
        return { status: "created", generation };
      }
      if (row.state === "exhausted") {
        row.generation = generation;
        row.state = "pending";
        row.retryMarker = null;
        row.nextAttemptAtMs = nowMs;
        row.leaseToken = null;
        row.leasedUntilMs = null;
        row.lastError = null;
        row.updatedAtMs = nowMs;
        return { status: "revived", generation };
      }
      row.generation = generation;
      row.updatedAtMs = nowMs;
      return { status: "bumped", generation };
    });
  }

  async settle(
    owner: string,
    repo: string,
    prNumber: number,
    generation: number
  ): Promise<AutomergeReconcileSettleResult> {
    return this.locked(() => {
      const row = this.obligations.get(obligationKey(owner, repo, prNumber));
      if (!row || row.generation !== generation) return "stale";
      this.obligations.delete(obligationKey(owner, repo, prNumber));
      return "deleted";
    });
  }

  async claimDue(
    token: string,
    leaseMs: number,
    limit: number,
    nowMs: number
  ): Promise<AutomergeReconcileClaimedRow[]> {
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
      const claimed: AutomergeReconcileClaimedRow[] = [];
      for (const row of due) {
        row.leaseToken = token;
        row.leasedUntilMs = nowMs + leaseMs;
        row.updatedAtMs = nowMs;
        claimed.push({
          owner: row.owner,
          repo: row.repo,
          prNumber: row.prNumber,
          generation: row.generation,
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
  ): Promise<AutomergeReconcileCompleteResult> {
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
      return "deleted";
    });
  }

  async fail(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    error: string,
    nowMs: number
  ): Promise<AutomergeReconcileFailResult> {
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
      const decision = decideInfraRetry(row.retryMarker, nowMs);
      if (decision.action === "requeue") {
        row.retryMarker = decision.marker;
        row.nextAttemptAtMs = nowMs + decision.backoffMs;
        row.leaseToken = null;
        row.leasedUntilMs = null;
        row.updatedAtMs = nowMs;
        return "retry";
      }
      row.state = "exhausted";
      row.lastError = error;
      row.leaseToken = null;
      row.leasedUntilMs = null;
      row.updatedAtMs = nowMs;
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
  ): Promise<AutomergeReconcileBlockResult> {
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

  async listExhausted(limit: number): Promise<AutomergeReconcileExhaustedRow[]> {
    const rows = [...this.obligations.values()]
      .filter((row) => row.state === "exhausted")
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
      .slice(0, Math.max(0, limit));
    return rows.map((row) => ({
      owner: row.owner,
      repo: row.repo,
      prNumber: row.prNumber,
      generation: row.generation,
      retryMarker: row.retryMarker,
      lastError: row.lastError,
      updatedAtMs: row.updatedAtMs,
    }));
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

function reconcileLockKey(owner: string, repo: string, prNumber: number): string {
  return `automerge-reconcile:${owner}/${repo}#${prNumber}`;
}

export class PgAutomergeReconcileStore implements AutomergeReconcileStore {
  constructor(private readonly sql: SqlClient) {}

  async migrate(): Promise<void> {
    try {
      await this.sql.unsafe(AUTOMERGE_RECONCILE_SCHEMA_SQL);
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async request(
    owner: string,
    repo: string,
    prNumber: number,
    causeId: string,
    nowMs: number
  ): Promise<AutomergeReconcileRequestResult> {
    const nowIso = new Date(nowMs).toISOString();
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [reconcileLockKey(owner, repo, prNumber)]);
      const seen = asRows<{ admitted_generation: unknown }>(
        await tx.unsafe(
          `SELECT admitted_generation FROM automerge_reconcile_cause
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND cause_id = $4`,
          [owner, repo, prNumber, causeId]
        )
      );
      if (seen[0] != null) return { status: "duplicate", generation: num(seen[0].admitted_generation) };
      const allocated = asRows<{ generation: unknown }>(
        await tx.unsafe(`SELECT nextval('automerge_reconcile_generation_seq') AS generation`)
      );
      const generation = num(allocated[0]?.generation);
      await tx.unsafe(
        `INSERT INTO automerge_reconcile_cause (owner, repo, pr_number, cause_id, admitted_generation, seen_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
         ON CONFLICT (owner, repo, pr_number, cause_id) DO NOTHING`,
        [owner, repo, prNumber, causeId, generation, nowIso]
      );
      const raced = asRows<{ admitted_generation: unknown }>(
        await tx.unsafe(
          `SELECT admitted_generation FROM automerge_reconcile_cause
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND cause_id = $4`,
          [owner, repo, prNumber, causeId]
        )
      );
      if (raced[0] != null && num(raced[0].admitted_generation) !== generation) {
        return { status: "duplicate", generation: num(raced[0].admitted_generation) };
      }
      const existing = asRows<{ generation: unknown; state: unknown }>(
        await tx.unsafe(
          `SELECT generation, state FROM automerge_reconcile
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 FOR UPDATE`,
          [owner, repo, prNumber]
        )
      );
      const row = existing[0];
      if (!row) {
        await tx.unsafe(
          `INSERT INTO automerge_reconcile
             (owner, repo, pr_number, generation, state, retry_marker, next_attempt_at,
              lease_token, leased_until, last_error, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'pending', NULL, $5::timestamptz, NULL, NULL, NULL, $5::timestamptz, $5::timestamptz)`,
          [owner, repo, prNumber, generation, nowIso]
        );
        return { status: "created", generation };
      }
      if (String(row.state) === "exhausted") {
        await tx.unsafe(
          `UPDATE automerge_reconcile
           SET generation = $4, state = 'pending', retry_marker = NULL, next_attempt_at = $5::timestamptz,
               lease_token = NULL, leased_until = NULL, last_error = NULL, updated_at = $5::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, generation, nowIso]
        );
        return { status: "revived", generation };
      }
      await tx.unsafe(
        `UPDATE automerge_reconcile SET generation = $4, updated_at = $5::timestamptz
         WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
        [owner, repo, prNumber, generation, nowIso]
      );
      return { status: "bumped", generation };
    });
  }

  async settle(
    owner: string,
    repo: string,
    prNumber: number,
    generation: number
  ): Promise<AutomergeReconcileSettleResult> {
    const deleted = asRows<{ generation: unknown }>(
      await this.sql.unsafe(
        `DELETE FROM automerge_reconcile WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND generation = $4
         RETURNING generation`,
        [owner, repo, prNumber, generation]
      )
    );
    return deleted.length > 0 ? "deleted" : "stale";
  }

  async claimDue(
    token: string,
    leaseMs: number,
    limit: number,
    nowMs: number
  ): Promise<AutomergeReconcileClaimedRow[]> {
    const nowIso = new Date(nowMs).toISOString();
    const untilIso = new Date(nowMs + leaseMs).toISOString();
    const rows = asRows<{
      owner: unknown;
      repo: unknown;
      pr_number: unknown;
      generation: unknown;
      retry_marker: unknown;
      next_attempt_at: unknown;
    }>(
      await this.sql.unsafe(
        `UPDATE automerge_reconcile
         SET lease_token = $1, leased_until = $2::timestamptz, updated_at = $3::timestamptz
         WHERE (owner, repo, pr_number) IN (
           SELECT owner, repo, pr_number FROM automerge_reconcile
           WHERE state = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= $3::timestamptz)
             AND (lease_token IS NULL OR leased_until IS NULL OR leased_until <= $3::timestamptz)
           ORDER BY next_attempt_at NULLS FIRST, owner ASC, repo ASC, pr_number ASC
           LIMIT $4
           FOR UPDATE SKIP LOCKED
         )
         RETURNING owner, repo, pr_number, generation, retry_marker, next_attempt_at`,
        [token, untilIso, nowIso, Math.max(0, limit)]
      )
    );
    return rows.map((row) => ({
      owner: String(row.owner),
      repo: String(row.repo),
      prNumber: num(row.pr_number),
      generation: num(row.generation),
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
        `UPDATE automerge_reconcile
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
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [reconcileLockKey(owner, repo, prNumber)]);
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
  ): Promise<AutomergeReconcileCompleteResult> {
    const nowIso = new Date(nowMs).toISOString();
    return this.withPrLock(owner, repo, prNumber, async (tx) => {
      const rows = asRows<{ generation: unknown; lease_token: unknown; leased_until: unknown }>(
        await tx.unsafe(
          `SELECT generation, lease_token, leased_until FROM automerge_reconcile
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 FOR UPDATE`,
          [owner, repo, prNumber]
        )
      );
      const row = rows[0];
      if (!row || strOrNull(row.lease_token) !== token) return "lost";
      const leasedUntil = epochOrNull(row.leased_until);
      if (leasedUntil == null || leasedUntil <= nowMs) return "lost";
      if (num(row.generation) !== generation) {
        await tx.unsafe(
          `UPDATE automerge_reconcile
           SET lease_token = NULL, leased_until = NULL, next_attempt_at = $4::timestamptz, updated_at = $4::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, nowIso]
        );
        return "rearmed";
      }
      await tx.unsafe(`DELETE FROM automerge_reconcile WHERE owner = $1 AND repo = $2 AND pr_number = $3`, [
        owner,
        repo,
        prNumber,
      ]);
      return "deleted";
    });
  }

  async fail(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    generation: number,
    error: string,
    nowMs: number
  ): Promise<AutomergeReconcileFailResult> {
    const nowIso = new Date(nowMs).toISOString();
    return this.withPrLock(owner, repo, prNumber, async (tx) => {
      const rows = asRows<{
        generation: unknown;
        lease_token: unknown;
        leased_until: unknown;
        retry_marker: unknown;
      }>(
        await tx.unsafe(
          `SELECT generation, lease_token, leased_until, retry_marker FROM automerge_reconcile
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 FOR UPDATE`,
          [owner, repo, prNumber]
        )
      );
      const row = rows[0];
      if (!row || strOrNull(row.lease_token) !== token) return "lost";
      const leasedUntil = epochOrNull(row.leased_until);
      if (leasedUntil == null || leasedUntil <= nowMs) return "lost";
      if (num(row.generation) !== generation) {
        await tx.unsafe(
          `UPDATE automerge_reconcile
           SET lease_token = NULL, leased_until = NULL, next_attempt_at = $4::timestamptz, updated_at = $4::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, nowIso]
        );
        return "rearmed";
      }
      const decision = decideInfraRetry(strOrNull(row.retry_marker), nowMs);
      if (decision.action === "requeue") {
        const nextIso = new Date(nowMs + decision.backoffMs).toISOString();
        await tx.unsafe(
          `UPDATE automerge_reconcile
           SET retry_marker = $4, next_attempt_at = $5::timestamptz,
               lease_token = NULL, leased_until = NULL, updated_at = $6::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, decision.marker, nextIso, nowIso]
        );
        return "retry";
      }
      await tx.unsafe(
        `UPDATE automerge_reconcile
         SET state = 'exhausted', last_error = $4, lease_token = NULL, leased_until = NULL, updated_at = $5::timestamptz
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
  ): Promise<AutomergeReconcileBlockResult> {
    const nowIso = new Date(nowMs).toISOString();
    return this.withPrLock(owner, repo, prNumber, async (tx) => {
      const rows = asRows<{ generation: unknown; lease_token: unknown; leased_until: unknown }>(
        await tx.unsafe(
          `SELECT generation, lease_token, leased_until FROM automerge_reconcile
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 FOR UPDATE`,
          [owner, repo, prNumber]
        )
      );
      const row = rows[0];
      if (!row || strOrNull(row.lease_token) !== token) return "lost";
      const leasedUntil = epochOrNull(row.leased_until);
      if (leasedUntil == null || leasedUntil <= nowMs) return "lost";
      if (num(row.generation) !== generation) {
        await tx.unsafe(
          `UPDATE automerge_reconcile
           SET lease_token = NULL, leased_until = NULL, next_attempt_at = $4::timestamptz, updated_at = $4::timestamptz
           WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [owner, repo, prNumber, nowIso]
        );
        return "rearmed";
      }
      await tx.unsafe(
        `UPDATE automerge_reconcile
         SET state = 'exhausted', last_error = $4, lease_token = NULL, leased_until = NULL, updated_at = $5::timestamptz
         WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
        [owner, repo, prNumber, diagnostic, nowIso]
      );
      return "exhausted";
    });
  }

  async listExhausted(limit: number): Promise<AutomergeReconcileExhaustedRow[]> {
    const rows = asRows<{
      owner: unknown;
      repo: unknown;
      pr_number: unknown;
      generation: unknown;
      retry_marker: unknown;
      last_error: unknown;
      updated_at: unknown;
    }>(
      await this.sql.unsafe(
        `SELECT owner, repo, pr_number, generation, retry_marker, last_error, updated_at
         FROM automerge_reconcile WHERE state = 'exhausted' ORDER BY updated_at ASC LIMIT $1`,
        [Math.max(0, limit)]
      )
    );
    return rows.map((row) => ({
      owner: String(row.owner),
      repo: String(row.repo),
      prNumber: num(row.pr_number),
      generation: num(row.generation),
      retryMarker: strOrNull(row.retry_marker),
      lastError: strOrNull(row.last_error),
      updatedAtMs: epochOrNull(row.updated_at) ?? Date.now(),
    }));
  }
}
