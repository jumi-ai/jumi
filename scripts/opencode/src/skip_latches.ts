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

export interface SkipLatchStore {
  get(key: SkipLatchKey): Promise<IssueSkipLatchRecord>;
  put(key: SkipLatchKey, patch: Partial<IssueSkipLatchRecord>): Promise<void>;
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

export function skipLatchKey(owner: string, repo: string, issueNumber: number): SkipLatchKey {
  return { owner, repo, issueNumber };
}

export function latchMapKey(key: SkipLatchKey): string {
  return `${key.owner}/${key.repo}#${key.issueNumber}`;
}

export function emptySkipLatchRecord(): IssueSkipLatchRecord {
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

  async put(key: SkipLatchKey, patch: Partial<IssueSkipLatchRecord>): Promise<void> {
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

  async put(key: SkipLatchKey, patch: Partial<IssueSkipLatchRecord>): Promise<void> {
    const followup = jsonParam(patch.followup);
    const conflict = jsonParam(patch.conflict);
    const ci = jsonParam(patch.ci);
    const stuck = jsonParam(patch.stuck);
    const reviewStuck = jsonParam(patch.reviewStuck);
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
  }

  async delete(key: SkipLatchKey): Promise<void> {
    await this.sql.unsafe(`DELETE FROM issue_skip_latches WHERE owner = $1 AND repo = $2 AND issue_number = $3`, [
      key.owner,
      key.repo,
      key.issueNumber,
    ]);
  }
}

export async function createPgSkipLatchStore(databaseUrl: string, sql?: SqlClient): Promise<PgSkipLatchStore> {
  const store = new PgSkipLatchStore(sql ?? createBunSqlClient(databaseUrl));
  await store.migrate();
  return store;
}
