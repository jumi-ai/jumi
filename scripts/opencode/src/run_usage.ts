/**
 * Durable per-run usage ledger.
 *
 * In-process Prometheus counters (`ai_tokens_total`, `jumi_jobs_completed_total`,
 * `jumi_job_duration_seconds_*`, `jumi_opencode_exits_total`) die with the pod
 * that recorded them, so a one-Job-per-ledger-row world cannot rely on them.
 * This module stores one row per runner spawn in Postgres (`jumi_run_usage`):
 * runner, model, token counts, exit class, start time, end time. One job row
 * can own many run rows because a job can hop runners.
 *
 * Recording happens at exactly one choke point: `withLedgerRunUsage` wraps the
 * base engine inside `withEngineChain`, so every `opencode` / `claude` / `agy` /
 * `codex` spawn is captured without touching the four harness files. Token
 * attribution comes from diffing the in-process counters around the spawn, so
 * the harness (`source`) and model labels always match what the spawn recorded.
 * The router renders the same metric names from these rows; engine/worker pods
 * must not export the same names or totals double (see README).
 *
 * A pod that dies outright writes no usage for the run it was in. Accepted and
 * documented in README: those tokens are lost, and the job is reclaimed.
 */

import { agentInstance } from "./agent_instance.ts";
import {
  classifyOpenCodeExit,
  DURATION_BUCKETS_SECONDS,
  JOB_RESULTS,
  OPENCODE_EXIT_CLASSES,
  type OpenCodeExitClass,
  RUN_KINDS,
} from "./control_metrics.ts";
import { type Engine, EngineFailedError, type EngineResult } from "./engine.ts";
import type { JobKind, ReviewJobState } from "./review_jobs.ts";
import {
  diffTokenMetrics,
  type ModelTokenUsage,
  normalizeOpenCodeModel,
  snapshotTokenMetrics,
  TOKEN_TYPES,
  type TokenType,
} from "./token_metrics.ts";

export const RUN_USAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jumi_run_usage (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NULL,
  job_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  runner TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_instance TEXT NOT NULL,
  tokens_input BIGINT NOT NULL DEFAULT 0,
  tokens_cache_read BIGINT NOT NULL DEFAULT 0,
  tokens_output BIGINT NOT NULL DEFAULT 0,
  tokens_cache_write BIGINT NOT NULL DEFAULT 0,
  tokens_reasoning BIGINT NOT NULL DEFAULT 0,
  sessions BIGINT NOT NULL DEFAULT 0,
  exit_class TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_seconds DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jumi_run_usage_job_key
  ON jumi_run_usage (job_key);

CREATE INDEX IF NOT EXISTS jumi_run_usage_kind_exit
  ON jumi_run_usage (kind, exit_class);

ALTER TABLE jumi_run_usage ADD COLUMN IF NOT EXISTS clone_seconds DOUBLE PRECISION NULL;
ALTER TABLE jumi_run_usage ADD COLUMN IF NOT EXISTS build_seconds DOUBLE PRECISION NULL;
`;

/** One per-(run, model) ledger row. Multi-model runs write one row per model. */
export interface NewRunUsageRow {
  jobId: number | null;
  jobKey: string;
  kind: JobKind;
  runner: string;
  model: string;
  agentInstance: string;
  tokensInput: number;
  tokensCacheRead: number;
  tokensOutput: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
  sessions: number;
  exitClass: OpenCodeExitClass;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  /** Full-clone seconds for one-shot jobs (no shared cache). Long-running leaves this undefined. */
  cloneSeconds?: number | null;
  /** Gradle build seconds when a build ran for the job. Null when no build ran. */
  buildSeconds?: number | null;
}

export interface RunUsageContext {
  jobId: number | null;
  jobKey: string;
  kind: JobKind;
  /** Full-clone seconds measured by the one-shot runner. Undefined on long-running. */
  cloneSeconds?: number | null;
  /** Gradle build seconds when a build ran. Undefined/null when no build ran. */
  buildSeconds?: number | null;
}

export interface RunUsageRecording {
  context: RunUsageContext;
  recordRunUsageRows(rows: NewRunUsageRow[]): Promise<void>;
}

let activeRecording: RunUsageRecording | undefined;

/**
 * Ambient recorder for the job currently leased by this process. Engine and
 * worker ticks set it for the duration of one tick (single-flight: both tick
 * loops await each job before leasing the next). Unset in tests and in
 * ledger-less local/dev mode, where recording is a no-op.
 */
export function setActiveRunUsageRecording(recording: RunUsageRecording | undefined): void {
  activeRecording = recording;
}

export function resetActiveRunUsageRecordingForTests(): void {
  activeRecording = undefined;
}

/**
 * One-shot jobs measure their full clone (and any Gradle build) before the
 * first engine spawn. The tick already installed its ambient recorder by then,
 * so patch its context in place: later spawns carry the cost in their ledger
 * rows. Long-running ticks never call this and keep undefined timings.
 */
export function patchActiveRunUsageTiming(timing: {
  cloneSeconds?: number | null;
  buildSeconds?: number | null;
}): void {
  if (!activeRecording) return;
  activeRecording.context = {
    ...activeRecording.context,
    ...(timing.cloneSeconds != null ? { cloneSeconds: timing.cloneSeconds } : {}),
    ...(timing.buildSeconds != null ? { buildSeconds: timing.buildSeconds } : {}),
  };
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function classifyThrown(err: unknown): OpenCodeExitClass {
  if (err instanceof EngineFailedError) {
    if (err.quota != null) return "quota";
    if (err.auth) return "auth";
    if (err.infra) return "infra";
    return "incomplete";
  }
  return "incomplete";
}

function fallbackModelFor(source: string, model: string | undefined): string {
  const raw = (model ?? "").trim() || "unknown";
  return source === "opencode" ? normalizeOpenCodeModel(raw) : raw;
}

function toRow(
  context: RunUsageContext,
  opts: { source: string; model: string; usage: ModelTokenUsage | undefined; sessions: number },
  exitClass: OpenCodeExitClass,
  startedAt: Date,
  endedAt: Date,
  durationSeconds: number
): NewRunUsageRow {
  const tokens: Record<TokenType, number> = {
    input: 0,
    cached_input: 0,
    output: 0,
    cache_write: 0,
    reasoning: 0,
  };
  const modelUsage = opts.usage?.get(opts.model);
  if (modelUsage) {
    for (const tokenType of TOKEN_TYPES) tokens[tokenType] = Math.max(0, Math.floor(modelUsage[tokenType] || 0));
  }
  return {
    jobId: context.jobId,
    jobKey: context.jobKey,
    kind: context.kind,
    runner: opts.source,
    model: opts.model,
    agentInstance: agentInstance(),
    tokensInput: tokens.input,
    tokensCacheRead: tokens.cached_input,
    tokensOutput: tokens.output,
    tokensCacheWrite: tokens.cache_write,
    tokensReasoning: tokens.reasoning,
    sessions: Math.max(0, Math.floor(opts.sessions)),
    exitClass,
    startedAt,
    endedAt,
    durationSeconds,
    ...(context.cloneSeconds != null ? { cloneSeconds: context.cloneSeconds } : {}),
    ...(context.buildSeconds != null ? { buildSeconds: context.buildSeconds } : {}),
  };
}

/**
 * Wrap the base engine so every spawn writes its ledger rows before the caller
 * observes the result. A failed write never fails the job: it is swallowed.
 * Lease-lost (aborted) runs still write their token/session cells with exit
 * class `incomplete` and the measured wall-clock duration: every harness
 * records usage before its abort check, so skipping them would systematically
 * undercount `ai_tokens_total`/`ai_sessions` versus the old exporter
 * (long-running engine, heartbeat loss, shutdown race). Only the pod-dies-
 * outright case loses tokens, and runs with no token/session delta write
 * nothing. Note: a deferred quota SIGTERM (a hop is coming) is recorded here
 * with its pre-hop class, while the in-process counter takes the hopped
 * `quota` class in the fallback. Counts and durations still match; only that
 * rare class label differs.
 */
export function withLedgerRunUsage(engine: Engine): Engine {
  return async (opts) => {
    const recording = activeRecording;
    if (!recording) return engine(opts);
    const source = (opts.type ?? "opencode").trim() || "opencode";
    const before = snapshotTokenMetrics();
    const startedAt = new Date();
    const startMs = Date.now();
    let result: EngineResult | undefined;
    let thrown: unknown;
    try {
      result = await engine(opts);
    } catch (err) {
      thrown = err;
    }
    try {
      const aborted = Boolean(opts.abortSignal?.aborted);
      const after = snapshotTokenMetrics();
      const deltas = diffTokenMetrics(before, after);
      const endedAt = new Date();
      const durationSeconds = Math.max(0, (Date.now() - startMs) / 1000);
      // Lease lost: tokens were already recorded in-process before the harness
      // abort check, so the ledger must keep them. Attribute the run as
      // `incomplete`; a run with no delta writes nothing.
      if (!(aborted && deltas.length === 0)) {
        const exitClass: OpenCodeExitClass = aborted
          ? "incomplete"
          : result
            ? classifyOpenCodeExit(result)
            : classifyThrown(thrown);
        const rows =
          deltas.length > 0
            ? deltas.map((delta) =>
                toRow(
                  recording.context,
                  { source: delta.source, model: delta.model, usage: mergeUsage(deltas), sessions: delta.sessions },
                  exitClass,
                  startedAt,
                  endedAt,
                  durationSeconds
                )
              )
            : [
                toRow(
                  recording.context,
                  { source, model: fallbackModelFor(source, opts.model), usage: undefined, sessions: 0 },
                  exitClass,
                  startedAt,
                  endedAt,
                  durationSeconds
                ),
              ];
        await recording.recordRunUsageRows(rows);
      }
    } catch {
      // Fail-open: a metric write must not fail the job.
    }
    if (thrown !== undefined) throw thrown;
    return result as EngineResult;
  };
}

function mergeUsage(deltas: Array<{ model: string; tokens: Record<TokenType, number> }>): ModelTokenUsage {
  const usage: ModelTokenUsage = new Map();
  for (const delta of deltas) usage.set(delta.model, delta.tokens);
  return usage;
}

export interface TokenTotalRow {
  agentInstance: string;
  source: string;
  model: string;
  tokenType: TokenType;
  value: number;
}

export interface SessionTotalRow {
  agentInstance: string;
  source: string;
  model: string;
  value: number;
}

export interface ExitCountRow {
  kind: string;
  exitClass: string;
  count: number;
}

export interface DurationRow {
  kind: string;
  exitClass: string;
  durationSeconds: number;
}

/** Ledger slice the router renderer needs. `ReviewJobStore` satisfies this. */
export interface RunUsageLedger {
  countByKindState(): Promise<Record<JobKind, Record<ReviewJobState, number>>>;
  getRunUsageTokenTotals(): Promise<TokenTotalRow[]>;
  getRunUsageSessionTotals(): Promise<SessionTotalRow[]>;
  getRunExitCounts(): Promise<ExitCountRow[]>;
  getRunDurations(): Promise<DurationRow[]>;
}

function tokenSeriesLabels(agent: string, source: string, model: string, tokenType?: TokenType): string {
  const parts = [
    `agent_instance="${escapeLabel(agent)}"`,
    `source="${escapeLabel(source)}"`,
    'profile="default"',
    `model="${escapeLabel(model)}"`,
  ];
  if (tokenType) parts.push(`token_type="${escapeLabel(tokenType)}"`);
  return parts.join(",");
}

/**
 * Router-side `/metrics` for everything the ledger owns. Same metric names as
 * the old in-process exports; label sets are preserved (`agent_instance` is
 * the value recorded at run time, so `jumi` and `jumi-worker` rows coexist;
 * `profile` is always `default`; the duration `result` label carries the exit
 * class, matching the historical in-process histogram naming).
 */
export async function renderLedgerMetrics(store: RunUsageLedger): Promise<string> {
  const [counts, tokenTotals, sessionTotals, exitCounts, durations] = await Promise.all([
    store.countByKindState(),
    store.getRunUsageTokenTotals(),
    store.getRunUsageSessionTotals(),
    store.getRunExitCounts(),
    store.getRunDurations(),
  ]);
  const lines: string[] = [
    "# HELP ai_tokens_total Cumulative AI tokens recorded in the ledger",
    "# TYPE ai_tokens_total counter",
  ];
  const sortedTokens = [...tokenTotals].sort((a, b) =>
    `${a.agentInstance}\0${a.source}\0${a.model}\0${a.tokenType}`.localeCompare(
      `${b.agentInstance}\0${b.source}\0${b.model}\0${b.tokenType}`
    )
  );
  for (const row of sortedTokens) {
    lines.push(
      `ai_tokens_total{${tokenSeriesLabels(row.agentInstance, row.source, row.model, row.tokenType)}} ${row.value}`
    );
  }

  lines.push("# HELP ai_tokens Ledger token totals by series");
  lines.push("# TYPE ai_tokens gauge");
  for (const row of sortedTokens) {
    lines.push(`ai_tokens{${tokenSeriesLabels(row.agentInstance, row.source, row.model, row.tokenType)}} ${row.value}`);
  }

  lines.push("# HELP ai_sessions Sessions recorded in the ledger");
  lines.push("# TYPE ai_sessions counter");
  const sortedSessions = [...sessionTotals].sort((a, b) =>
    `${a.agentInstance}\0${a.source}\0${a.model}`.localeCompare(`${b.agentInstance}\0${b.source}\0${b.model}`)
  );
  for (const row of sortedSessions) {
    lines.push(`ai_sessions{${tokenSeriesLabels(row.agentInstance, row.source, row.model)}} ${row.value}`);
  }

  lines.push("# HELP jumi_jobs_completed_total Jobs completed (terminal ledger rows)");
  lines.push("# TYPE jumi_jobs_completed_total counter");
  for (const kind of RUN_KINDS) {
    for (const result of JOB_RESULTS) {
      const value = counts[kind]?.[result as ReviewJobState] ?? 0;
      lines.push(`jumi_jobs_completed_total{kind="${kind}",result="${result}"} ${value}`);
    }
  }

  const exitByKey = new Map(exitCounts.map((row) => [`${row.kind}\0${row.exitClass}`, row.count]));
  const durationByKey = new Map<string, number[]>();
  for (const row of durations) {
    const key = `${row.kind}\0${row.exitClass}`;
    const list = durationByKey.get(key) ?? [];
    list.push(row.durationSeconds);
    durationByKey.set(key, list);
  }

  lines.push("# HELP jumi_job_duration_seconds Engine run duration in seconds (ledger)");
  lines.push("# TYPE jumi_job_duration_seconds histogram");
  for (const key of [...durationByKey.keys()].sort((a, b) => a.localeCompare(b))) {
    const [kind, exitClass] = key.split("\0") as [string, string];
    const values = durationByKey.get(key) ?? [];
    const labels = `kind="${escapeLabel(kind)}",result="${escapeLabel(exitClass)}"`;
    let cumulative = 0;
    const sorted = [...values].sort((a, b) => a - b);
    for (const le of DURATION_BUCKETS_SECONDS) {
      while (cumulative < sorted.length && (sorted[cumulative] as number) <= le) cumulative++;
      lines.push(`jumi_job_duration_seconds_bucket{${labels},le="${le}"} ${cumulative}`);
    }
    lines.push(`jumi_job_duration_seconds_bucket{${labels},le="+Inf"} ${values.length}`);
    const sum = values.reduce((total, value) => total + value, 0);
    lines.push(`jumi_job_duration_seconds_sum{${labels}} ${sum}`);
    lines.push(`jumi_job_duration_seconds_count{${labels}} ${values.length}`);
  }

  lines.push("# HELP jumi_opencode_exits_total Engine exits by kind and class (ledger)");
  lines.push("# TYPE jumi_opencode_exits_total counter");
  for (const kind of RUN_KINDS) {
    for (const exitClass of OPENCODE_EXIT_CLASSES) {
      const value = exitByKey.get(`${kind}\0${exitClass}`) ?? 0;
      lines.push(`jumi_opencode_exits_total{kind="${kind}",class="${exitClass}"} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
