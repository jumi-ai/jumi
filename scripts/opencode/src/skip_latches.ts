import { createBunSqlClient, type SqlClient, wrapSqlError } from "./sql_client.ts";

export interface SkipLatchKey {
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface IssueSkipLatchRecord {
  followup: unknown;
  conflict: unknown;
  ci: unknown;
  stuck: unknown;
  reviewStuck: unknown;
}

export interface SkipLatchFence {
  jobId: number;
  leasedBy: string;
  generation: number;
}

export class LatchFenceRejected extends Error {
  constructor(message = "skip latch fence rejected") {
    super(message);
    this.name = "LatchFenceRejected";
  }
}

export class LatchFenceUnsupported extends Error {
  constructor(message = "skip latch fence is not supported by this store") {
    super(message);
    this.name = "LatchFenceUnsupported";
  }
}

function isFenceGenerationValid(generation: unknown): generation is number {
  return typeof generation === "number" && Number.isInteger(generation) && generation >= 0;
}

function assertFenceValid(fence: SkipLatchFence): void {
  if (!Number.isInteger(fence.jobId) || fence.jobId <= 0) {
    throw new LatchFenceRejected(`invalid skip latch fence jobId ${JSON.stringify(fence.jobId)}`);
  }
  if (typeof fence.leasedBy !== "string" || fence.leasedBy.length === 0) {
    throw new LatchFenceRejected("invalid skip latch fence leasedBy");
  }
  if (!isFenceGenerationValid(fence.generation)) {
    throw new LatchFenceRejected(`invalid skip latch fence generation ${JSON.stringify(fence.generation)}`);
  }
}

export interface SkipLatchStore {
  get(key: SkipLatchKey): Promise<IssueSkipLatchRecord>;
  put(key: SkipLatchKey, patch: Partial<IssueSkipLatchRecord>, fence?: SkipLatchFence): Promise<void>;
  delete(key: SkipLatchKey): Promise<void>;
}

export const ISSUE_SKIP_LATCHES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS issue_skip_latches (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  followup JSONB NOT NULL DEFAULT '{}'::jsonb,
  conflict JSONB NOT NULL DEFAULT '{}'::jsonb,
  ci JSONB NOT NULL DEFAULT '{}'::jsonb,
  stuck JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_stuck JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner, repo, issue_number)
);

ALTER TABLE issue_skip_latches ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issue_skip_latches ADD COLUMN IF NOT EXISTS skip_reason TEXT;
ALTER TABLE issue_skip_latches ADD COLUMN IF NOT EXISTS followup JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE issue_skip_latches ADD COLUMN IF NOT EXISTS conflict JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE issue_skip_latches ADD COLUMN IF NOT EXISTS ci JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE issue_skip_latches ADD COLUMN IF NOT EXISTS stuck JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE issue_skip_latches ADD COLUMN IF NOT EXISTS review_stuck JSONB NOT NULL DEFAULT '{}'::jsonb;
`;

const memoryByHome = new Map<string, MemorySkipLatchStore>();

function skipLatchKey(owner: string, repo: string, issueNumber: number): SkipLatchKey {
  return { owner, repo, issueNumber };
}

function latchMapKey(key: SkipLatchKey): string {
  return `${key.owner}/${key.repo}#${key.issueNumber}`;
}

function emptySkipLatchRecord(): IssueSkipLatchRecord {
  return { followup: {}, conflict: {}, ci: {}, stuck: {}, reviewStuck: {} };
}

export function parseWorkerLatchPath(
  path: string
): (SkipLatchKey & { home: string; kind: "followup" | "conflict" | "ci" | "stuck" }) | undefined {
  const normalized = path.replaceAll("\\", "/");
  const match = /^(.*)\/worker\/jobs\/([^/]+)\/([^/]+)\/(\d+)\.(followup|conflict|ci|stuck)\.json$/.exec(normalized);
  if (!match) return undefined;
  return {
    home: match[1] ?? "",
    owner: match[2] ?? "",
    repo: match[3] ?? "",
    issueNumber: Number(match[4]),
    kind: match[5] as "followup" | "conflict" | "ci" | "stuck",
  };
}

export function memorySkipLatchesFor(home: string): MemorySkipLatchStore {
  const existing = memoryByHome.get(home);
  if (existing) return existing;
  const created = new MemorySkipLatchStore();
  memoryByHome.set(home, created);
  return created;
}

export function skipLatchesFor(opts: { home: string; skipLatches?: SkipLatchStore }): SkipLatchStore {
  return opts.skipLatches ?? memorySkipLatchesFor(opts.home);
}

export function skipLatchStoreFromPath(path: string): { store: SkipLatchStore; key: SkipLatchKey } | undefined {
  const parsed = parseWorkerLatchPath(path);
  if (!parsed) return undefined;
  return { store: memorySkipLatchesFor(parsed.home), key: parsed };
}

function cloneRecord(record: IssueSkipLatchRecord): IssueSkipLatchRecord {
  return {
    followup: structuredClone(record.followup),
    conflict: structuredClone(record.conflict),
    ci: structuredClone(record.ci),
    stuck: structuredClone(record.stuck),
    reviewStuck: structuredClone(record.reviewStuck),
  };
}

export class MemorySkipLatchStore implements SkipLatchStore {
  private readonly rows = new Map<string, IssueSkipLatchRecord>();

  async get(key: SkipLatchKey): Promise<IssueSkipLatchRecord> {
    const row = this.rows.get(latchMapKey(key));
    return row ? cloneRecord(row) : emptySkipLatchRecord();
  }

  async put(key: SkipLatchKey, patch: Partial<IssueSkipLatchRecord>, fence?: SkipLatchFence): Promise<void> {
    if (fence !== undefined) {
      // Standalone/home/path-backed memory stores have no ledger ownership
      // check, so a requested fence must fail loudly instead of writing
      // without it. Malformed fences reject before reaching that branch.
      assertFenceValid(fence);
      throw new LatchFenceUnsupported("fenced skip latch writes need a ledger-backed store");
    }
    const current = this.rows.get(latchMapKey(key)) ?? emptySkipLatchRecord();
    const next: IssueSkipLatchRecord = {
      followup: patch.followup !== undefined ? structuredClone(patch.followup) : current.followup,
      conflict: patch.conflict !== undefined ? structuredClone(patch.conflict) : current.conflict,
      ci: patch.ci !== undefined ? structuredClone(patch.ci) : current.ci,
      stuck: patch.stuck !== undefined ? structuredClone(patch.stuck) : current.stuck,
      reviewStuck: patch.reviewStuck !== undefined ? structuredClone(patch.reviewStuck) : current.reviewStuck,
    };
    this.rows.set(latchMapKey(key), next);
  }

  async delete(key: SkipLatchKey): Promise<void> {
    this.rows.delete(latchMapKey(key));
  }
}

export interface MemoryLedgerLatchOwner {
  findLedgerRow(jobId: number):
    | {
        state: string;
        leasedBy: string | null;
        owner: string;
        repo: string;
        issueNumber: number | null;
      }
    | undefined;
  readLatchGeneration(owner: string, repo: string, issueNumber: number): number;
}

/**
 * Ledger-backed memory latch adapter. The ownership/generation checks and the
 * cell write run synchronously with no `await` between them, so no other
 * synchronous section can interleave. Expiry (`leased_until`) is deliberately
 * not compared (matching heartbeat/settle; reclaim is the revoker) and
 * `cancel_requested` is not a rejection reason (cancel flows through
 * `markPublished`/generation bump).
 */
export class LedgerMemorySkipLatchStore extends MemorySkipLatchStore {
  constructor(private readonly ledger: MemoryLedgerLatchOwner) {
    super();
  }

  async put(key: SkipLatchKey, patch: Partial<IssueSkipLatchRecord>, fence?: SkipLatchFence): Promise<void> {
    if (fence === undefined) return super.put(key, patch);
    assertFenceValid(fence);
    const row = this.ledger.findLedgerRow(fence.jobId);
    if (row?.state !== "leased" || row?.leasedBy !== fence.leasedBy) {
      throw new LatchFenceRejected(`skip latch fence rejected for job ${fence.jobId}`);
    }
    if (row.owner !== key.owner || row.repo !== key.repo || row.issueNumber !== key.issueNumber) {
      throw new LatchFenceRejected(`skip latch fence rejected for job ${fence.jobId}`);
    }
    if (this.ledger.readLatchGeneration(key.owner, key.repo, key.issueNumber) !== fence.generation) {
      throw new LatchFenceRejected(`skip latch fence rejected for job ${fence.jobId}`);
    }
    return super.put(key, patch);
  }
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function asJson(value: unknown): unknown {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

function jsonParam(value: unknown | undefined): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value ?? {});
}

export class PgSkipLatchStore implements SkipLatchStore {
  constructor(private readonly sql: SqlClient) {}

  async migrate(): Promise<void> {
    try {
      await this.sql.unsafe(ISSUE_SKIP_LATCHES_SCHEMA_SQL);
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async get(key: SkipLatchKey): Promise<IssueSkipLatchRecord> {
    const rows = asRows<{ followup: unknown; conflict: unknown; ci: unknown; stuck: unknown; review_stuck: unknown }>(
      await this.sql.unsafe(
        `SELECT followup, conflict, ci, stuck, review_stuck FROM issue_skip_latches
         WHERE owner = $1 AND repo = $2 AND issue_number = $3`,
        [key.owner, key.repo, key.issueNumber]
      )
    );
    const row = rows[0];
    if (!row) return emptySkipLatchRecord();
    return {
      followup: asJson(row.followup),
      conflict: asJson(row.conflict),
      ci: asJson(row.ci),
      stuck: asJson(row.stuck),
      reviewStuck: asJson(row.review_stuck),
    };
  }

  async put(key: SkipLatchKey, patch: Partial<IssueSkipLatchRecord>, fence?: SkipLatchFence): Promise<void> {
    const followup = jsonParam(patch.followup);
    const conflict = jsonParam(patch.conflict);
    const ci = jsonParam(patch.ci);
    const stuck = jsonParam(patch.stuck);
    const reviewStuck = jsonParam(patch.reviewStuck);
    if (fence === undefined) {
      await this.sql.unsafe(
        `INSERT INTO issue_skip_latches (owner, repo, issue_number, followup, conflict, ci, stuck, review_stuck)
       VALUES (
         $1, $2, $3,
         COALESCE($4::jsonb, '{}'::jsonb),
         COALESCE($5::jsonb, '{}'::jsonb),
         COALESCE($6::jsonb, '{}'::jsonb),
         COALESCE($7::jsonb, '{}'::jsonb),
         COALESCE($8::jsonb, '{}'::jsonb)
       )
       ON CONFLICT (owner, repo, issue_number) DO UPDATE SET
         followup = COALESCE($4::jsonb, issue_skip_latches.followup),
         conflict = COALESCE($5::jsonb, issue_skip_latches.conflict),
         ci = COALESCE($6::jsonb, issue_skip_latches.ci),
         stuck = COALESCE($7::jsonb, issue_skip_latches.stuck),
         review_stuck = COALESCE($8::jsonb, issue_skip_latches.review_stuck),
         updated_at = NOW()`,
        [key.owner, key.repo, key.issueNumber, followup, conflict, ci, stuck, reviewStuck]
      );
      return;
    }
    // Malformed fences reject before any write, and the rejection below is
    // thrown outside the transaction: the shared SQL client wraps every error
    // raised inside `begin` as QueueUnavailableError, which would hide the
    // fence verdict from callers.
    assertFenceValid(fence);
    const landed = await this.sql.begin(async (tx) => {
      // Fenced latch write: the ledger row must still be leased by the exact
      // token and bound to this latch identity. `FOR SHARE` conflicts with
      // the `FOR UPDATE` row locks that reclaim/heartbeat/settle take, so a
      // reclaim in flight blocks this check until it commits, and this check
      // blocks a concurrent reclaim (which then skips the locked row via
      // `SKIP LOCKED`). Expiry (`leased_until`) is deliberately not compared,
      // matching heartbeat/settle; reclaim is the revoker. `cancel_requested`
      // is not a rejection reason: cancel flows through
      // `markPublished`/generation bump.
      const held = asRows<{ one: unknown }>(
        await tx.unsafe(
          `SELECT 1 AS one FROM review_jobs
           WHERE id = $1 AND leased_by = $2 AND state = 'leased'
             AND owner = $3 AND repo = $4 AND issue_number = $5
           FOR SHARE`,
          [fence.jobId, fence.leasedBy, key.owner, key.repo, key.issueNumber]
        )
      );
      if (held.length === 0) return false;
      // Update branch: applies only when the latch row's generation equals
      // the expected value. No unlocked EXISTS: the predicate is evaluated by
      // the database against the latest committed row under the ledger lock.
      const updated = asRows<{ generation: unknown }>(
        await tx.unsafe(
          `UPDATE issue_skip_latches SET
             followup = COALESCE($4::jsonb, issue_skip_latches.followup),
             conflict = COALESCE($5::jsonb, issue_skip_latches.conflict),
             ci = COALESCE($6::jsonb, issue_skip_latches.ci),
             stuck = COALESCE($7::jsonb, issue_skip_latches.stuck),
             review_stuck = COALESCE($8::jsonb, issue_skip_latches.review_stuck),
             updated_at = NOW()
           WHERE owner = $1 AND repo = $2 AND issue_number = $3 AND generation = $9
           RETURNING generation`,
          [key.owner, key.repo, key.issueNumber, followup, conflict, ci, stuck, reviewStuck, fence.generation]
        )
      );
      if (updated.length > 0) return true;
      // Insert branch: applies only when no latch row exists (absent = 0),
      // expressed as a conditional insert gated on expected generation 0 so
      // the check and the write stay in the same statement. A conflicting
      // concurrent insert yields zero rows and rejects.
      const inserted = asRows<{ generation: unknown }>(
        await tx.unsafe(
          `INSERT INTO issue_skip_latches (owner, repo, issue_number, followup, conflict, ci, stuck, review_stuck)
           SELECT $1, $2, $3,
             COALESCE($4::jsonb, '{}'::jsonb),
             COALESCE($5::jsonb, '{}'::jsonb),
             COALESCE($6::jsonb, '{}'::jsonb),
             COALESCE($7::jsonb, '{}'::jsonb),
             COALESCE($8::jsonb, '{}'::jsonb)
           WHERE $9 = 0
           ON CONFLICT (owner, repo, issue_number) DO NOTHING
           RETURNING generation`,
          [key.owner, key.repo, key.issueNumber, followup, conflict, ci, stuck, reviewStuck, fence.generation]
        )
      );
      return inserted.length > 0;
    });
    if (!landed) throw new LatchFenceRejected(`skip latch fence rejected for job ${fence.jobId}`);
  }

  async delete(key: SkipLatchKey): Promise<void> {
    await this.sql.unsafe(`DELETE FROM issue_skip_latches WHERE owner = $1 AND repo = $2 AND issue_number = $3`, [
      key.owner,
      key.repo,
      key.issueNumber,
    ]);
  }
}

async function createPgSkipLatchStore(databaseUrl: string, sql?: SqlClient): Promise<PgSkipLatchStore> {
  const store = new PgSkipLatchStore(sql ?? createBunSqlClient(databaseUrl));
  await store.migrate();
  return store;
}
