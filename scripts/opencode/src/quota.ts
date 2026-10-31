/** Quota abort: Free/Go usage-limit retry classification. The live abort polls
 * the per-run OpenCode session DB for a sleeping retry (see git.ts); the
 * persisted-error check below is the post-hoc classifier only. `opencode run`
 * without `--print-logs` emits only the `> build · <model>` banner to stderr,
 * so the DB needs no transcript dump to Loki and no Phoenix. */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export const QUOTA_STUCK_TEXT = "stuck: usage limit exceeded";

export const QUOTA_MESSAGE = "opencode stuck: usage limit exceeded";

/** Interval for the live session DB poll (see git.ts). Independent of the RSS sampler. */
export const QUOTA_POLL_INTERVAL_MS = 5_000;

// Free/Go usage-limit class only. Bare "usage limit reached" is intentionally
// absent: other providers emit similar text with a seconds-scale retry-after
// that OpenCode rides out and then succeeds.
const QUOTA_PATTERNS = [
  "FreeUsageLimitError",
  "GoUsageLimitError",
  "Free usage exceeded",
  "Free limit reached",
  "Go limit reached",
  "free_tier_limit",
  "account_rate_limit",
  "Rate limit exceeded. Please try again later.",
  "Insufficient balance",
] as const;

export const QUOTA_ERROR_RE =
  /FreeUsageLimitError|GoUsageLimitError|Free usage exceeded|Free limit reached|Go limit reached|free_tier_limit|account_rate_limit|Rate limit exceeded\. Please try again later\.|Insufficient balance|stuck:\s*usage limit exceeded/i;

/** Narrow live pattern for the retry poll. Drops the parent's own
 * `stuck:` dialect (which OpenCode never emits) so tool traces or echoed file
 * content containing that literal cannot kill a healthy run. Kept in
 * `QUOTA_ERROR_RE`/`isQuotaText` for thrown errors and stuck comments. */
export const QUOTA_LIVE_RE =
  /FreeUsageLimitError|GoUsageLimitError|Free usage exceeded|Free limit reached|Go limit reached|free_tier_limit|account_rate_limit|Rate limit exceeded\. Please try again later\.|Insufficient balance/i;

export type QuotaClass = "resetting" | "hard";

const HARD_QUOTA_RE = /GoUsageLimitError|Go limit reached|Insufficient balance/i;
const RESETTING_QUOTA_RE =
  /FreeUsageLimitError|Free usage exceeded|Free limit reached|free_tier_limit|account_rate_limit|Rate limit exceeded\. Please try again later\./i;

export const QUOTA_WAIT_PREFIX = "quota-wait:";
export const QUOTA_WAIT_DEFAULT_MS = 60 * 60 * 1000;
export const QUOTA_WAIT_MIN_MS = 60 * 60 * 1000;
export const QUOTA_WAIT_MAX_MS = 24 * 60 * 60 * 1000;
export const QUOTA_WAIT_BUDGET_MS = 30 * 60 * 60 * 1000;
export const QUOTA_WAIT_MAX_ATTEMPTS = 48;

export interface QuotaHit {
  kind: QuotaClass;
  retryAfterMs?: number;
  text: string;
}

export function isQuotaText(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_ERROR_RE.test(text);
}

export function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  // Engine failures carry captured stderr in the message. Quota for those
  // comes from the engine's own field or the authored prefix, not a regex
  // over that stderr. Forge and plain errors keep the text match.
  if (err instanceof Error && err.name === "EngineFailedError") {
    return engineFailureQuotaClass(err as Error & { quota?: QuotaClass }) != null;
  }
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return isQuotaText(text);
}

export function isQuotaLiveText(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_LIVE_RE.test(text);
}

export function isHardQuotaText(text: string | null | undefined): boolean {
  if (!text) return false;
  return HARD_QUOTA_RE.test(text);
}

export function isResettingQuotaText(text: string | null | undefined): boolean {
  if (!text) return false;
  if (HARD_QUOTA_RE.test(text)) return false;
  return RESETTING_QUOTA_RE.test(text);
}

export function classifyQuotaText(text: string | null | undefined): QuotaClass | undefined {
  if (!text || !isQuotaText(text)) return undefined;
  if (HARD_QUOTA_RE.test(text)) return "hard";
  if (RESETTING_QUOTA_RE.test(text)) return "resetting";
  return "hard";
}

/**
 * Quota class of an `EngineFailedError`. The engine's `quota` field wins.
 * Otherwise only a message equal to, or starting with, `QUOTA_MESSAGE`
 * counts. Stderr that `engineExitMessage` appends is not a quota signal.
 */
export function engineFailureQuotaClass(err: { quota?: QuotaClass; message?: string | null }): QuotaClass | undefined {
  if (err.quota === "resetting" || err.quota === "hard") return err.quota;
  const message = err.message ?? "";
  if (message === QUOTA_MESSAGE || message.startsWith(QUOTA_MESSAGE)) {
    return classifyQuotaText(QUOTA_MESSAGE) ?? "hard";
  }
  return undefined;
}

/** Class for a result message, or for an engine failure when `engineFailure` is set. */
export function quotaClassOf(input: {
  quota?: QuotaClass;
  message?: string | null;
  engineFailure?: boolean;
}): QuotaClass | undefined {
  if (input.engineFailure) return engineFailureQuotaClass(input);
  if (input.quota === "resetting" || input.quota === "hard") return input.quota;
  if (isResettingQuotaText(input.message)) return "resetting";
  if (isQuotaText(input.message)) return "hard";
  return undefined;
}

export function parseRetryAfterMs(text: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!text) return undefined;
  const millis = /retryAfterMs["'\s:=]+(\d+)/.exec(text);
  if (millis) return Number(millis[1]) || undefined;
  const header = /retry[-_\s]*after["'\s:=]+(\d+(?:\.\d+)?)/i.exec(text);
  if (header) {
    const n = Number(header[1]);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    if (n > 1e12) return undefined;
    if (n > 1e10) return Math.max(0, n - nowMs);
    if (n >= 1_000_000) return n;
    return n * 1000;
  }
  const httpDate = /retry[-_\s]*after["'\s:=]+([A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} [\d:]{8} GMT)/i.exec(text);
  if (httpDate) {
    const at = Date.parse(httpDate[1]);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  const iso = /retry[-_\s]*after["'\s:=]+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(text);
  if (iso) {
    const at = Date.parse(iso[1]);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  const human = /retry in (\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m|hours?|h)\b/i.exec(text);
  if (human) {
    const n = Number(human[1]);
    if (!Number.isFinite(n) || n < 0) return undefined;
    const unit = human[2].toLowerCase();
    if (unit.startsWith("ms") || unit.startsWith("millisecond")) return n;
    if (unit.startsWith("s")) return n * 1000;
    if (unit.startsWith("m")) return n * 60_000;
    return n * 3_600_000;
  }
  return undefined;
}

export function clampQuotaWaitMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return QUOTA_WAIT_DEFAULT_MS;
  return Math.min(QUOTA_WAIT_MAX_MS, Math.max(QUOTA_WAIT_MIN_MS, ms));
}

function quotaHitFromText(text: string): QuotaHit {
  const retryAfterMs = parseRetryAfterMs(text);
  return {
    kind: classifyQuotaText(text) ?? "hard",
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
    text,
  };
}

/**
 * Assistant rows only, and only their `error` field: a row that quotes
 * `FreeUsageLimitError` in task text or tool output never matches.
 */
function rowHasQuotaError(data: string): boolean {
  let error: unknown;
  try {
    error = (JSON.parse(data) as { error?: unknown }).error;
  } catch {
    return false;
  }
  if (typeof error === "string") return isQuotaText(error);
  return Boolean(error) && typeof error === "object" && isQuotaText(JSON.stringify(error));
}

function inspectQuotaInOpenDb(db: Database): QuotaHit | undefined {
  const where = QUOTA_PATTERNS.map(() => `data LIKE ?`).join(" OR ");
  const params = QUOTA_PATTERNS.map((pattern) => `%${pattern}%`);
  const rows = db
    .query(
      `SELECT data FROM session_message WHERE type = 'assistant' AND data LIKE '%"error"%' AND (${where}) LIMIT 10`
    )
    .all(...params) as Array<{ data: unknown }>;
  for (const row of rows) {
    if (typeof row?.data === "string" && rowHasQuotaError(row.data)) return quotaHitFromText(row.data);
  }
  return undefined;
}

function withQuotaDb(dbPath: string, read: (db: Database) => QuotaHit | undefined): QuotaHit | undefined {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    // Fall through to read-write.
  }
  try {
    const db = new Database(dbPath);
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function rowRetryError(data: string): unknown {
  try {
    return (JSON.parse(data) as { retry?: { error?: unknown } }).retry?.error;
  } catch {
    return undefined;
  }
}

/**
 * The live signal: a sleeping assistant row carries
 * `retry: { attempt, at, error }` until the attempt runs. OpenCode clears it on
 * a kill it outlives, but a kill of the whole process tree (OOM) leaves it, in a
 * DB the next `--continue` run reuses, and that run only cleans its own session.
 * So a row counts only if it was written at or after `sinceMs`, this child's
 * start. Unlike a persisted `error`, this field then cannot be left over from an
 * earlier run, so only it may abort a child.
 *
 * Any session can be the one sleeping, a subagent's included, and `seq` restarts
 * in each, so this reads every session's own newest assistant row.
 *
 * Returns undefined when the DB is missing, not yet initialized, or locked.
 * Never throws.
 */
export function inspectQuotaSleepInDb(dbPath: string | null | undefined, sinceMs: number): QuotaHit | undefined {
  if (!dbPath || !existsSync(dbPath)) return undefined;
  return withQuotaDb(dbPath, (db) => {
    const rows = db
      .query(
        `SELECT data FROM (
           SELECT data, time_updated, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS newest
           FROM session_message WHERE type = 'assistant'
         ) WHERE newest = 1 AND time_updated >= ?`
      )
      .all(sinceMs) as Array<{ data: unknown }>;
    for (const row of rows) {
      if (typeof row.data !== "string") continue;
      const error = rowRetryError(row.data);
      if (error === undefined) continue;
      const text = JSON.stringify(error);
      if (isQuotaLiveText(text)) return quotaHitFromText(text);
    }
    return undefined;
  });
}

/**
 * Best-effort post-hoc quota classifier against the per-run OpenCode session
 * DB the parent already knows about (`OPENCODE_DB` under
 * `.jumi-tmp/opencode-session.db`). It reads persisted errors, which a resumed
 * session can carry over from an earlier run, so it must not be polled as the
 * abort trigger: that is {@link inspectQuotaSleepInDb}.
 *
 * Returns undefined when the DB is missing, not yet initialized, locked, or
 * contains no quota/retry record. Never throws.
 */
export function inspectQuotaRetryInDb(dbPath: string | null | undefined): QuotaHit | undefined {
  if (!dbPath) return undefined;
  if (!existsSync(dbPath)) return undefined;
  return withQuotaDb(dbPath, inspectQuotaInOpenDb);
}

/** Columns the two quota reads above depend on. */
const QUOTA_DB_COLUMNS = ["session_id", "type", "seq", "time_updated", "data"];

let schemaErrors = 0;

export function quotaSchemaErrors(): number {
  return schemaErrors;
}

export function resetQuotaSchemaErrorsForTests(): void {
  schemaErrors = 0;
}

/**
 * The quota reads swallow every SQLite error, because a poll can land on a DB
 * that is locked or not created yet. That also makes an OpenCode schema change
 * look like "no quota hit", and the child then sleeps until the job times out.
 * So once a run is over, when neither excuse applies, name what is missing.
 * Counted in `ai_quota_db_schema_errors`. Never throws.
 */
export function checkQuotaDbSchema(dbPath: string | null | undefined): string | undefined {
  if (!dbPath || !existsSync(dbPath)) return undefined;
  let problem: string | undefined;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      const columns = db.query("SELECT name FROM pragma_table_info('session_message')").all() as Array<{
        name: string;
      }>;
      if (tables.length > 0 && columns.length === 0) problem = "no session_message table";
      const missing = QUOTA_DB_COLUMNS.find((name) => !columns.some((column) => column.name === name));
      if (columns.length > 0 && missing) problem = `session_message has no ${missing} column`;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
  if (problem) schemaErrors += 1;
  return problem;
}

export function hasQuotaRetryInDb(dbPath: string | null | undefined): boolean {
  return inspectQuotaRetryInDb(dbPath) != null;
}

export function isQuotaWaitMarker(error: string | null | undefined): boolean {
  return Boolean(error?.startsWith(QUOTA_WAIT_PREFIX));
}

export function parseQuotaWaitMarker(
  error: string | null | undefined
): { count: number; firstHitAt: number } | undefined {
  if (!isQuotaWaitMarker(error) || !error) return undefined;
  const parts = error.slice(QUOTA_WAIT_PREFIX.length).split(":");
  const count = Number(parts[0]);
  const firstHitAt = Number(parts[1]);
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(firstHitAt)) return undefined;
  return { count, firstHitAt };
}

export function encodeQuotaWaitMarker(count: number, firstHitAt: number): string {
  return `${QUOTA_WAIT_PREFIX}${count}:${firstHitAt}`;
}

export function quotaWaitJitterMs(delayMs: number, random: () => number = Math.random): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  const n = random();
  if (!Number.isFinite(n)) return 0;
  return Math.floor(delayMs * 0.1 * Math.min(1, Math.max(0, n)));
}

export type QuotaWaitDecision =
  | {
      action: "requeue";
      count: number;
      firstHitAt: number;
      backoffMs: number;
      marker: string;
      budgetRemainingMs: number;
    }
  | { action: "exhaust"; reason: string };

export function decideQuotaRetry(
  prevError: string | null | undefined,
  nowMs: number,
  retryAfterMs?: number,
  random: () => number = Math.random
): QuotaWaitDecision {
  const prev = parseQuotaWaitMarker(prevError);
  const count = (prev?.count ?? 0) + 1;
  const firstHitAt = prev?.firstHitAt ?? nowMs;
  const elapsed = nowMs - firstHitAt;
  if (count >= QUOTA_WAIT_MAX_ATTEMPTS || elapsed >= QUOTA_WAIT_BUDGET_MS) {
    return { action: "exhaust", reason: QUOTA_STUCK_TEXT };
  }
  const delay =
    clampQuotaWaitMs(retryAfterMs ?? QUOTA_WAIT_DEFAULT_MS) + quotaWaitJitterMs(QUOTA_WAIT_DEFAULT_MS, random);
  return {
    action: "requeue",
    count,
    firstHitAt,
    backoffMs: delay,
    marker: encodeQuotaWaitMarker(count, firstHitAt),
    budgetRemainingMs: Math.max(0, QUOTA_WAIT_BUDGET_MS - elapsed),
  };
}

export class QuotaWaitError extends Error {
  readonly backoffMs: number;
  readonly marker: string;
  readonly count: number;
  readonly firstHitAt: number;
  readonly budgetRemainingMs: number;

  constructor(decision: Extract<QuotaWaitDecision, { action: "requeue" }>) {
    super("quota wait");
    this.name = "QuotaWaitError";
    this.backoffMs = decision.backoffMs;
    this.marker = decision.marker;
    this.count = decision.count;
    this.firstHitAt = decision.firstHitAt;
    this.budgetRemainingMs = decision.budgetRemainingMs;
  }
}

export function isQuotaWaitError(err: unknown): err is QuotaWaitError {
  return err instanceof QuotaWaitError;
}

export class QuotaCooldown {
  private until = 0;
  private loggedUntil = 0;

  canLease(now = Date.now()): boolean {
    return now >= this.until;
  }

  recordWaitUntil(untilMs: number): void {
    if (!Number.isFinite(untilMs)) return;
    this.until = Math.max(this.until, untilMs);
  }

  takeLog(now = Date.now()): boolean {
    if (now >= this.until) return false;
    if (this.loggedUntil === this.until) return false;
    this.loggedUntil = this.until;
    return true;
  }

  reset(): void {
    this.until = 0;
    this.loggedUntil = 0;
  }
}

export const workerQuotaCooldown = new QuotaCooldown();
