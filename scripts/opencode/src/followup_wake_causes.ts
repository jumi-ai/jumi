import { createHash } from "node:crypto";
import type { SqlClient } from "./sql_client.ts";
import { wrapSqlError } from "./sql_client.ts";

/**
 * Durable follow-up wake-cause ledger (issue #836).
 *
 * A follow-up job key (`follow-up:<owner>/<repo>#<closer>:<head>`) can be
 * leased or queued while a distinct cause arrives. The ordinary enqueue
 * dedupes on the key and records nothing, so the distinct cause would be
 * lost. This sub-store records every *accepted distinct cause* per job key
 * and preserves its identity across completion: a cause moves
 * `pending` -> `promoted` (with a reference to the ordinary `review_jobs`
 * row it became) or `pending` -> `parked` (with a reason). Nothing is ever
 * taken destructively: there is no deletion, pruning, retention TTL, or
 * numeric cap. A future retention policy is separate scope.
 *
 * Identity (`resolveFollowUpWakeCauseId` owns it): an explicit stable
 * source-cause identity when supplied, else `"delivery:" + delivery` for a
 * non-empty genuine producer delivery, else
 * `"payload-sha256:" + sha256(canonical JSON of the normalized payload
 * INCLUDING its generation)` with object keys sorted recursively. An
 * identical internal payload within a generation is a replay; a newly
 * authorized generation is a distinct cause. The exact payload is stored
 * unchanged; the digest is identity only.
 *
 * Webhook admission must not feed a freshly randomized fallback UUID as the
 * delivery: `webhookWakeDeliveryFallback` supplies a raw-body digest
 * namespaced by event family when the original header is absent.
 */

export const FOLLOW_UP_WAKE_CAUSES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS follow_up_wake_causes (
  id BIGSERIAL PRIMARY KEY,
  job_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  pr_number INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT NOT NULL DEFAULT '',
  cause_id TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'promoted', 'parked')),
  park_reason TEXT,
  promoted_job_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  UNIQUE (job_key, cause_id)
);

CREATE INDEX IF NOT EXISTS follow_up_wake_causes_job_state
  ON follow_up_wake_causes (job_key, state, id);

CREATE INDEX IF NOT EXISTS follow_up_wake_causes_issue
  ON follow_up_wake_causes (owner, repo, issue_number, state, id);
`;

export type FollowUpWakeCauseState = "pending" | "promoted" | "parked";

export interface FollowUpWakeCause {
  id: number;
  jobKey: string;
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  causeId: string;
  delivery: string;
  /** Exact payload stored unchanged (deep-equal round-trip; JSONB may reorder keys). */
  payload: unknown;
  state: FollowUpWakeCauseState;
  parkReason: string | null;
  promotedJobId: number | null;
  createdAtMs: number;
  settledAtMs: number | null;
}

export interface FollowUpWakeCauseInput {
  jobKey: string;
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber?: number;
  headSha?: string;
  /** Stable source-cause identity when the producer supplies one. */
  causeId?: string;
  /** Genuine producer delivery; may be empty. Never a randomized fallback UUID. */
  delivery?: string;
  /** Exact IssueJobPayload stored unchanged (trigger, mergeOnly, generation, ...). */
  payload: unknown;
}

export type FollowUpWakeRecordOutcome = "recorded" | "duplicate";

export interface FollowUpWakeCauseStore {
  /** Insert or dedupe on `(job_key, cause_id)` in any state. Throws when the row cannot persist. */
  record(input: FollowUpWakeCauseInput): Promise<FollowUpWakeRecordOutcome>;
  /** Any state, or undefined when unknown. */
  get(jobKey: string, causeId: string): Promise<FollowUpWakeCause | undefined>;
  /**
   * Oldest pending cause for the key, row-locked when a caller transaction
   * is supplied (ordered by `id`). Compose with `markPromoted` in the
   * caller's open `sql.begin` transaction (memory: the store lock).
   */
  peekOldestPending(jobKey: string, tx?: SqlClient): Promise<FollowUpWakeCause | undefined>;
  /** Pending -> promoted. Returns false when the row is no longer pending. */
  markPromoted(id: number, jobId: number, tx?: SqlClient): Promise<boolean>;
  /**
   * Park pending causes for one job key. With `generation`, only stale
   * causes park (payload generation strictly below it); equal-or-newer
   * causes stay pending. Returns the parked count.
   */
  parkPendingForKey(jobKey: string, reason: string, opts?: { generation?: number; tx?: SqlClient }): Promise<number>;
  /** Park pending causes for one issue. Same generation filter as `parkPendingForKey`. */
  parkPendingForIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    reason: string,
    opts?: { generation?: number; tx?: SqlClient }
  ): Promise<number>;
  countPending(jobKey: string): Promise<number>;
  list(jobKey: string, state?: FollowUpWakeCauseState): Promise<FollowUpWakeCause[]>;
}

/** Recursively sort object keys so digests ignore key order. Arrays keep order. */
export function canonicalizeWakeCauseValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeWakeCauseValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeWakeCauseValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalWakeCauseJson(value: unknown): string {
  return JSON.stringify(canonicalizeWakeCauseValue(value));
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function payloadGenerationOf(payload: unknown): number {
  if (payload && typeof payload === "object") {
    const generation = (payload as { generation?: unknown }).generation;
    if (typeof generation === "number" && Number.isFinite(generation)) return Math.trunc(generation);
  }
  return 0;
}

function normalizedPayloadForDigest(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const rec = payload as Record<string, unknown>;
    if (typeof rec["generation"] === "number" && Number.isFinite(rec["generation"])) return payload;
    return { ...rec, generation: 0 };
  }
  return payload;
}

/** Digest identity for internal producers lacking delivery (generation included). */
export function payloadDigestForWakeCause(payload: unknown): string {
  return sha256Hex(canonicalWakeCauseJson(normalizedPayloadForDigest(payload)));
}

/**
 * The single owner of wake-cause identity. Explicit stable identity wins,
 * else a non-empty genuine delivery, else a payload digest that includes
 * the generation. Never generates a random fallback: callers without an
 * identity must pass the payload (or a `webhookWakeDeliveryFallback`
 * delivery) so the cause is stable across redelivery.
 */
export function resolveFollowUpWakeCauseId(input: {
  causeId?: string | null;
  delivery?: string | null;
  payload?: unknown;
}): string {
  const explicit = typeof input.causeId === "string" ? input.causeId.trim() : "";
  if (explicit) return explicit;
  const delivery = typeof input.delivery === "string" ? input.delivery.trim() : "";
  if (delivery) return `delivery:${delivery}`;
  if (input.payload !== undefined) return `payload-sha256:${payloadDigestForWakeCause(input.payload)}`;
  throw new Error("cannot derive wake cause identity without causeId, delivery, or payload");
}

/**
 * Webhook delivery fallback when the forge header is absent: a raw-body
 * digest namespaced by event family. Stable across redelivery, distinct
 * across families and bodies. Pass the result as `delivery` so identity
 * construction never sees a randomized UUID.
 */
export function webhookWakeDeliveryFallback(eventFamily: string, rawBody: string | Uint8Array): string {
  const family =
    eventFamily
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "webhook";
  const bytes = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
  return `${family}-sha256:${sha256Hex(bytes)}`;
}

function cloneCause(cause: FollowUpWakeCause): FollowUpWakeCause {
  return { ...cause, payload: structuredClone(cause.payload) };
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
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

function parseStoredPayload(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value ?? null;
}

interface WakeCauseRow {
  id: unknown;
  job_key: unknown;
  owner: unknown;
  repo: unknown;
  issue_number: unknown;
  pr_number: unknown;
  head_sha: unknown;
  cause_id: unknown;
  delivery: unknown;
  payload: unknown;
  state: unknown;
  park_reason: unknown;
  promoted_job_id: unknown;
  created_at: unknown;
  settled_at: unknown;
}

function mapWakeCause(row: WakeCauseRow): FollowUpWakeCause {
  const state = str(row.state);
  return {
    id: num(row.id),
    jobKey: str(row.job_key),
    owner: str(row.owner),
    repo: str(row.repo),
    issueNumber: num(row.issue_number),
    prNumber: num(row.pr_number),
    headSha: str(row.head_sha),
    causeId: str(row.cause_id),
    delivery: str(row.delivery),
    payload: parseStoredPayload(row.payload),
    state: state === "promoted" || state === "parked" ? state : "pending",
    parkReason: strOrNull(row.park_reason),
    promotedJobId: numOrNull(row.promoted_job_id),
    createdAtMs: epochMs(row.created_at, Date.now()),
    settledAtMs: row.settled_at == null ? null : epochMs(row.settled_at, Date.now()),
  };
}

const WAKE_CAUSE_COLUMNS = `id, job_key, owner, repo, issue_number, pr_number, head_sha, cause_id,
  delivery, payload, state, park_reason, promoted_job_id, created_at, settled_at`;

export class MemoryFollowUpWakeCauseStore implements FollowUpWakeCauseStore {
  private readonly causes = new Map<string, FollowUpWakeCause>();
  private nextId = 1;
  private chain = Promise.resolve();

  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private static mapKey(jobKey: string, causeId: string): string {
    return `${jobKey}\u001f${causeId}`;
  }

  async record(input: FollowUpWakeCauseInput): Promise<FollowUpWakeRecordOutcome> {
    return this.locked(() => {
      const causeId = resolveFollowUpWakeCauseId({
        causeId: input.causeId,
        delivery: input.delivery,
        payload: input.payload,
      });
      const key = MemoryFollowUpWakeCauseStore.mapKey(input.jobKey, causeId);
      if (this.causes.has(key)) return "duplicate" as const;
      const now = Date.now();
      this.causes.set(key, {
        id: this.nextId++,
        jobKey: input.jobKey,
        owner: input.owner,
        repo: input.repo,
        issueNumber: input.issueNumber,
        prNumber: input.prNumber ?? 0,
        headSha: input.headSha ?? "",
        causeId,
        delivery: typeof input.delivery === "string" ? input.delivery : "",
        payload: structuredClone(input.payload),
        state: "pending",
        parkReason: null,
        promotedJobId: null,
        createdAtMs: now,
        settledAtMs: null,
      });
      return "recorded" as const;
    });
  }

  async get(jobKey: string, causeId: string): Promise<FollowUpWakeCause | undefined> {
    const cause = this.causes.get(MemoryFollowUpWakeCauseStore.mapKey(jobKey, causeId));
    return cause ? cloneCause(cause) : undefined;
  }

  async peekOldestPending(jobKey: string, _tx?: SqlClient): Promise<FollowUpWakeCause | undefined> {
    return this.locked(() => {
      let oldest: FollowUpWakeCause | undefined;
      for (const cause of this.causes.values()) {
        if (cause.jobKey !== jobKey || cause.state !== "pending") continue;
        if (!oldest || cause.id < oldest.id) oldest = cause;
      }
      return oldest ? cloneCause(oldest) : undefined;
    });
  }

  async markPromoted(id: number, jobId: number, _tx?: SqlClient): Promise<boolean> {
    return this.locked(() => {
      for (const cause of this.causes.values()) {
        if (cause.id !== id) continue;
        if (cause.state !== "pending") return false;
        cause.state = "promoted";
        cause.promotedJobId = jobId;
        cause.settledAtMs = Date.now();
        return true;
      }
      return false;
    });
  }

  async parkPendingForKey(
    jobKey: string,
    reason: string,
    opts?: { generation?: number; tx?: SqlClient }
  ): Promise<number> {
    void opts?.tx;
    return this.locked(() => {
      const now = Date.now();
      const floor = opts?.generation;
      let parked = 0;
      for (const cause of this.causes.values()) {
        if (cause.jobKey !== jobKey || cause.state !== "pending") continue;
        if (floor != null && payloadGenerationOf(cause.payload) >= floor) continue;
        cause.state = "parked";
        cause.parkReason = reason;
        cause.settledAtMs = now;
        parked++;
      }
      return parked;
    });
  }

  async parkPendingForIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    reason: string,
    opts?: { generation?: number; tx?: SqlClient }
  ): Promise<number> {
    void opts?.tx;
    return this.locked(() => {
      const now = Date.now();
      const floor = opts?.generation;
      let parked = 0;
      for (const cause of this.causes.values()) {
        if (cause.owner !== owner || cause.repo !== repo || cause.issueNumber !== issueNumber) continue;
        if (cause.state !== "pending") continue;
        if (floor != null && payloadGenerationOf(cause.payload) >= floor) continue;
        cause.state = "parked";
        cause.parkReason = reason;
        cause.settledAtMs = now;
        parked++;
      }
      return parked;
    });
  }

  async countPending(jobKey: string): Promise<number> {
    let count = 0;
    for (const cause of this.causes.values()) {
      if (cause.jobKey === jobKey && cause.state === "pending") count++;
    }
    return count;
  }

  async list(jobKey: string, state?: FollowUpWakeCauseState): Promise<FollowUpWakeCause[]> {
    const out: FollowUpWakeCause[] = [];
    for (const cause of this.causes.values()) {
      if (cause.jobKey !== jobKey) continue;
      if (state && cause.state !== state) continue;
      out.push(cloneCause(cause));
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

export class PgFollowUpWakeCauseStore implements FollowUpWakeCauseStore {
  constructor(private readonly sql: SqlClient) {}

  async migrate(): Promise<void> {
    try {
      await this.sql.unsafe(FOLLOW_UP_WAKE_CAUSES_SCHEMA_SQL);
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async record(input: FollowUpWakeCauseInput): Promise<FollowUpWakeRecordOutcome> {
    const causeId = resolveFollowUpWakeCauseId({
      causeId: input.causeId,
      delivery: input.delivery,
      payload: input.payload,
    });
    try {
      const rows = asRows<{ id: unknown }>(
        await this.sql.unsafe(
          `INSERT INTO follow_up_wake_causes (
            job_key, owner, repo, issue_number, pr_number, head_sha, cause_id, delivery, payload
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          ON CONFLICT (job_key, cause_id) DO NOTHING
          RETURNING id`,
          [
            input.jobKey,
            input.owner,
            input.repo,
            input.issueNumber,
            input.prNumber ?? 0,
            input.headSha ?? "",
            causeId,
            typeof input.delivery === "string" ? input.delivery : "",
            JSON.stringify(input.payload),
          ]
        )
      );
      return rows.length > 0 ? "recorded" : "duplicate";
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async get(jobKey: string, causeId: string): Promise<FollowUpWakeCause | undefined> {
    try {
      const rows = asRows<WakeCauseRow>(
        await this.sql.unsafe(
          `SELECT ${WAKE_CAUSE_COLUMNS} FROM follow_up_wake_causes WHERE job_key = $1 AND cause_id = $2`,
          [jobKey, causeId]
        )
      );
      const row = rows[0];
      return row ? mapWakeCause(row) : undefined;
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async peekOldestPending(jobKey: string, tx?: SqlClient): Promise<FollowUpWakeCause | undefined> {
    const query = `SELECT ${WAKE_CAUSE_COLUMNS} FROM follow_up_wake_causes
      WHERE job_key = $1 AND state = 'pending'
      ORDER BY id ASC LIMIT 1 FOR UPDATE`;
    try {
      if (tx) {
        const rows = asRows<WakeCauseRow>(await tx.unsafe(query, [jobKey]));
        const row = rows[0];
        return row ? mapWakeCause(row) : undefined;
      }
      return this.sql.begin(async (inner) => {
        const rows = asRows<WakeCauseRow>(await inner.unsafe(query, [jobKey]));
        const row = rows[0];
        return row ? mapWakeCause(row) : undefined;
      });
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async markPromoted(id: number, jobId: number, tx?: SqlClient): Promise<boolean> {
    const client = tx ?? this.sql;
    try {
      const rows = asRows<{ id: unknown }>(
        await client.unsafe(
          `UPDATE follow_up_wake_causes
            SET state = 'promoted', promoted_job_id = $2, settled_at = NOW()
            WHERE id = $1 AND state = 'pending'
            RETURNING id`,
          [id, jobId]
        )
      );
      return rows.length > 0;
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async parkPendingForKey(
    jobKey: string,
    reason: string,
    opts?: { generation?: number; tx?: SqlClient }
  ): Promise<number> {
    const client = opts?.tx ?? this.sql;
    try {
      if (opts?.generation == null) {
        const rows = asRows<{ id: unknown }>(
          await client.unsafe(
            `UPDATE follow_up_wake_causes
              SET state = 'parked', park_reason = $2, settled_at = NOW()
              WHERE job_key = $1 AND state = 'pending'
              RETURNING id`,
            [jobKey, reason]
          )
        );
        return rows.length;
      }
      const rows = asRows<{ id: unknown }>(
        await client.unsafe(
          `UPDATE follow_up_wake_causes
            SET state = 'parked', park_reason = $2, settled_at = NOW()
            WHERE job_key = $1 AND state = 'pending'
              AND CASE WHEN payload->>'generation' ~ '^-?\\d+$'
                THEN (payload->>'generation')::integer ELSE 0 END < $3
            RETURNING id`,
          [jobKey, reason, Math.trunc(opts.generation)]
        )
      );
      return rows.length;
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async parkPendingForIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    reason: string,
    opts?: { generation?: number; tx?: SqlClient }
  ): Promise<number> {
    const client = opts?.tx ?? this.sql;
    try {
      if (opts?.generation == null) {
        const rows = asRows<{ id: unknown }>(
          await client.unsafe(
            `UPDATE follow_up_wake_causes
              SET state = 'parked', park_reason = $2, settled_at = NOW()
              WHERE owner = $1 AND repo = $2 AND issue_number = $3 AND state = 'pending'
              RETURNING id`,
            [owner, repo, issueNumber, reason]
          )
        );
        return rows.length;
      }
      const rows = asRows<{ id: unknown }>(
        await client.unsafe(
          `UPDATE follow_up_wake_causes
            SET state = 'parked', park_reason = $2, settled_at = NOW()
            WHERE owner = $1 AND repo = $2 AND issue_number = $3 AND state = 'pending'
              AND CASE WHEN payload->>'generation' ~ '^-?\\d+$'
                THEN (payload->>'generation')::integer ELSE 0 END < $4
            RETURNING id`,
          [owner, repo, issueNumber, reason, Math.trunc(opts.generation)]
        )
      );
      return rows.length;
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async countPending(jobKey: string): Promise<number> {
    try {
      const rows = asRows<{ n: unknown }>(
        await this.sql.unsafe(
          `SELECT COUNT(*)::int AS n FROM follow_up_wake_causes WHERE job_key = $1 AND state = 'pending'`,
          [jobKey]
        )
      );
      return num(rows[0]?.n);
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async list(jobKey: string, state?: FollowUpWakeCauseState): Promise<FollowUpWakeCause[]> {
    try {
      const rows =
        state == null
          ? asRows<WakeCauseRow>(
              await this.sql.unsafe(
                `SELECT ${WAKE_CAUSE_COLUMNS} FROM follow_up_wake_causes WHERE job_key = $1 ORDER BY id ASC`,
                [jobKey]
              )
            )
          : asRows<WakeCauseRow>(
              await this.sql.unsafe(
                `SELECT ${WAKE_CAUSE_COLUMNS} FROM follow_up_wake_causes
                  WHERE job_key = $1 AND state = $2 ORDER BY id ASC`,
                [jobKey, state]
              )
            );
      return rows.map(mapWakeCause);
    } catch (err) {
      wrapSqlError(err);
    }
  }
}
