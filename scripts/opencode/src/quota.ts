/** Quota abort: Free/Go usage-limit retry classification. Live abort polls
 * the per-run isolated OpenCode log file (see git.ts); the DB check below is
 * the post-hoc classifier only.
 *
 * Why the log file: pinned OpenCode 1.15.5 keeps retry status in memory
 * (SessionStatus) and never writes a per-attempt row to the session DB while
 * sleeping on a multi-hour retry-after, and `opencode run` without
 * `--print-logs` emits only the `> build · <model>` banner to stderr (0 bytes
 * on both streams with `--format json`). The fully-formed quota error only
 * reaches OpenCode's own log file (`llm` service `stream error`, ~170ms after
 * stream start) before the child sleeps. Tailing that file needs no
 * `--print-logs`, no transcript dump to Loki, and no Phoenix. */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const QUOTA_STUCK_TEXT = "stuck: usage limit exceeded";

export const QUOTA_MESSAGE = "opencode stuck: usage limit exceeded";

/** Interval for the live log-file poll (see git.ts). Independent of the RSS sampler. */
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

/** Narrow live pattern for stream/log scans. Drops the parent's own
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

/** Retry context required around a live match. The quota failure is logged by
 * the `llm` service as `message="stream error"` with the provider error
 * inline; permission-evaluation lines that merely echo a tool command
 * containing a quota string never contain this marker. */
const LOG_RETRY_RE = /stream error/i;

export function isQuotaText(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_ERROR_RE.test(text);
}

export function isQuotaError(err: unknown): boolean {
  if (!err) return false;
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

export function parseRetryAfterMs(text: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!text) return undefined;
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
 * True when a single log line carries a quota failure in retry context:
 * a `stream error` line containing a Free/Go quota string. Line-scoped so a
 * permission line echoing `FreeUsageLimitError` from a tool command (no
 * `stream error` marker) never matches, and the parent's own `stuck:` dialect
 * (absent from `QUOTA_LIVE_RE`) never matches.
 */
export function isQuotaLogLine(line: string | null | undefined): boolean {
  if (!line) return false;
  if (!LOG_RETRY_RE.test(line)) return false;
  return QUOTA_LIVE_RE.test(line);
}

/**
 * Scan free-form log text for a quota retry line. Splits into lines so the
 * retry marker and the quota string must share one log line. Never throws;
 * tests only the regex, never logs the transcript.
 */
export function inspectQuotaInLogText(text: string | null | undefined): QuotaHit | undefined {
  if (!text) return undefined;
  const capped = text.length > 10_000_000 ? text.slice(0, 10_000_000) : text;
  for (const line of capped.split(/\r?\n/)) {
    if (isQuotaLogLine(line)) return quotaHitFromText(line);
  }
  return undefined;
}

export function hasQuotaInLogText(text: string | null | undefined): boolean {
  return inspectQuotaInLogText(text) != null;
}

const MAX_LOG_FILES = 20;
const MAX_LOG_BYTES_PER_FILE = 10_000_000;

/**
 * Best-effort live/post-hoc scan of the per-run isolated OpenCode log dir
 * (`<xdg-data>/opencode/log`, fresh per run so any hit belongs to this
 * child). Handles both layouts: the single `opencode.log` (1.18.x) and the
 * timestamped `*.log` rotation (1.15.5, keeps last 10). Returns false when the
 * dir is missing, empty, or unreadable. Never throws; never logs content.
 */
export function inspectQuotaInLogDir(logDir: string | null | undefined): QuotaHit | undefined {
  if (!logDir) return undefined;
  let entries: string[];
  try {
    if (!existsSync(logDir)) return undefined;
    entries = readdirSync(logDir);
  } catch {
    return undefined;
  }
  let checked = 0;
  for (const entry of entries) {
    if (checked >= MAX_LOG_FILES) break;
    if (entry.startsWith(".")) continue;
    const abs = join(logDir, entry);
    let size = 0;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
      if (size <= 0) continue;
    } catch {
      continue;
    }
    checked += 1;
    try {
      const capped = Math.min(size, MAX_LOG_BYTES_PER_FILE);
      const buf = readFileSync(abs);
      const text = buf.length > capped ? buf.subarray(0, capped).toString("utf8") : buf.toString("utf8");
      const head = inspectQuotaInLogText(text);
      if (head) return head;
      if (buf.length > capped) {
        const tail = buf.subarray(buf.length - Math.min(buf.length, 1_000_000)).toString("utf8");
        const late = inspectQuotaInLogText(tail);
        if (late) return late;
      }
    } catch {}
  }
  return undefined;
}

export function hasQuotaInLogDir(logDir: string | null | undefined): boolean {
  return inspectQuotaInLogDir(logDir) != null;
}

function tableNames(db: Database): Set<string> {
  try {
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

function inspectTableQuota(db: Database, table: string): QuotaHit | undefined {
  const scope =
    table === "part"
      ? `data LIKE '%"type"%retry%'`
      : table === "message"
        ? `data LIKE '%"error"%'`
        : `(data LIKE '%"type"%retry%' OR data LIKE '%"error"%')`;
  const where = QUOTA_PATTERNS.map(() => `data LIKE ?`).join(" OR ");
  const params = QUOTA_PATTERNS.map((pattern) => `%${pattern}%`);
  try {
    const rows = db
      .query(`SELECT data AS data FROM "${table}" WHERE ${scope} AND (${where}) LIMIT 10`)
      .all(...params) as Array<{ data: unknown }>;
    for (const row of rows) {
      if (typeof row?.data !== "string") continue;
      if (!rowIsQuotaData(row.data, table)) continue;
      return quotaHitFromText(row.data);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify a candidate row really is a retry/error record before matching
 * quota strings. `part` requires `type === "retry"` (both the live
 * SessionStatus shape and the persisted RetryPart shape); `message` /
 * `session_message` require an `error` field. Only error-related fields are
 * tested so quoted task text elsewhere in the row cannot match.
 */
function rowIsQuotaData(data: string, table: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const rec = parsed as Record<string, unknown>;
  if (table === "part") {
    if (rec.type !== "retry") return false;
    // Retry shape varies by layer (SessionStatus: message/action vs
    // persisted RetryPart: error). Check the error-carrying fields only.
    const candidates: unknown[] = [rec.message, rec.error, rec.action];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && isQuotaText(candidate)) return true;
      if (candidate && typeof candidate === "object" && isQuotaText(JSON.stringify(candidate))) return true;
    }
    return false;
  }
  // message / session_message: assistant error records only. A user message
  // carrying the task/feedback text has no `error` field and never matches,
  // even when it quotes `FreeUsageLimitError`.
  if (rec.type === "retry") {
    const candidates: unknown[] = [rec.message, rec.error, (rec as Record<string, unknown>).action];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && isQuotaText(candidate)) return true;
      if (candidate && typeof candidate === "object" && isQuotaText(JSON.stringify(candidate))) return true;
    }
    return false;
  }
  if ("error" in rec) {
    const err = rec.error;
    if (typeof err === "string" && isQuotaText(err)) return true;
    if (err && typeof err === "object") return isQuotaText(JSON.stringify(err));
  }
  if ("state" in rec && rec.state && typeof rec.state === "object") {
    const stateErr = (rec.state as Record<string, unknown>).error;
    if (typeof stateErr === "string" && isQuotaText(stateErr)) return true;
    if (stateErr && typeof stateErr === "object" && isQuotaText(JSON.stringify(stateErr))) return true;
  }
  return false;
}

function inspectQuotaInOpenDb(db: Database): QuotaHit | undefined {
  const tables = tableNames(db);
  for (const table of ["message", "part", "session_message"] as const) {
    if (!tables.has(table)) continue;
    const hit = inspectTableQuota(db, table);
    if (hit) return hit;
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

/**
 * Best-effort post-hoc quota classifier against the per-run OpenCode session
 * DB the parent already knows about (`OPENCODE_DB` under
 * `.jumi-tmp/opencode-session.db`). The live abort signal is the per-run
 * isolated log file (`hasQuotaInLogDir`); the pinned OpenCode never persists
 * a per-attempt retry row while it sleeps on a multi-hour retry-after, so
 * this must not be polled as the abort trigger.
 *
 * Returns undefined when the DB is missing, not yet initialized, locked, or
 * contains no quota/retry record. Never throws.
 */
export function inspectQuotaRetryInDb(dbPath: string | null | undefined): QuotaHit | undefined {
  if (!dbPath) return undefined;
  if (!existsSync(dbPath)) return undefined;
  return withQuotaDb(dbPath, inspectQuotaInOpenDb);
}

export function hasQuotaRetryInDb(dbPath: string | null | undefined): boolean {
  return inspectQuotaRetryInDb(dbPath) != null;
}

/**
 * Scan OpenCode JSON events (both V1 and V2) for quota retry records.
 */
export function inspectQuotaInEvents(events: unknown[] | string | null | undefined): QuotaHit | undefined {
  if (!events) return undefined;
  let list: unknown[];
  if (typeof events === "string") {
    const hit = inspectQuotaInLogText(events);
    if (hit) return hit;
    list = [];
    for (const line of events.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        list.push(JSON.parse(trimmed));
      } catch {
        // ignore
      }
    }
  } else if (Array.isArray(events)) {
    list = events;
  } else {
    return undefined;
  }

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const ev = item as Record<string, unknown>;
    const part = (ev.part && typeof ev.part === "object" ? ev.part : ev) as Record<string, unknown>;
    const candidates: unknown[] = [
      ev.error,
      ev.message,
      part.error,
      part.message,
      (part.state as Record<string, unknown> | undefined)?.error,
      (ev.state as Record<string, unknown> | undefined)?.error,
      (part.action as Record<string, unknown> | undefined)?.reason,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && isQuotaText(c)) return quotaHitFromText(c);
      if (c && typeof c === "object" && isQuotaText(JSON.stringify(c))) return quotaHitFromText(JSON.stringify(c));
    }
  }
  return undefined;
}

export function hasQuotaInEvents(events: unknown[] | string | null | undefined): boolean {
  return inspectQuotaInEvents(events) != null;
}

export function inspectQuotaHit(
  logDir: string | null | undefined,
  dbPath?: string | null,
  events?: unknown[] | string | null
): QuotaHit | undefined {
  return (
    inspectQuotaInLogDir(logDir) ?? (events ? inspectQuotaInEvents(events) : undefined) ?? inspectQuotaRetryInDb(dbPath)
  );
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
