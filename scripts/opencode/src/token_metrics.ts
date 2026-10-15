/** Process-local OpenCode, Claude, agy, and Codex token counters for Prometheus /metrics. */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { agentInstance } from "./agent_instance.ts";
import { resetTraceExportForTests, traceExportErrors } from "./phoenix.ts";

export const TOKEN_TYPES = ["input", "cached_input", "output", "cache_write", "reasoning"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
/** Harness that produced the tokens; exported as the existing `source` label. */
export type TokenSource = "opencode" | "claude" | "agy" | "codex";
/** Per-model token totals for one harness run. */
export type ModelTokenUsage = Map<string, Record<TokenType, number>>;

type TokenKey = string;
type SessionKey = string;

const counters = new Map<TokenKey, number>();
const sessions = new Map<SessionKey, number>();
let lastSuccessSeconds = 0;
let errors = 0;

const COLUMN_BY_TYPE: Record<TokenType, string> = {
  input: "tokens_input",
  cached_input: "tokens_cache_read",
  output: "tokens_output",
  cache_write: "tokens_cache_write",
  reasoning: "tokens_reasoning",
};

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export function normalizeOpenCodeModel(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const text = String(raw).trim();
  if (!text) return "unknown";
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const modelId = data.id ?? data.modelID ?? data.model;
      const provider = data.providerID ?? data.provider;
      if (typeof modelId === "string" && typeof provider === "string" && modelId && provider) {
        return `${provider}/${modelId}`;
      }
      if (typeof modelId === "string" && modelId) return modelId;
    } catch {
      // Fall through to the raw string.
    }
  }
  return text;
}

function tokenKey(source: TokenSource, model: string, tokenType: TokenType): TokenKey {
  return `${source}\0${model}\0${tokenType}`;
}

function sessionKey(source: TokenSource, model: string): SessionKey {
  return `${source}\0${model}`;
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

export function resetTokenMetricsForTests(): void {
  counters.clear();
  sessions.clear();
  lastSuccessSeconds = 0;
  errors = 0;
  resetTraceExportForTests();
}

export function recordOpenCodeDb(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    // Read-write: OpenCode uses WAL. After proc.kill()/143 the -wal may be
    // uncheckpointed; SQLITE_OPEN_READONLY cannot recreate -shm and drops tokens.
    // The child is already dead and the workspace is deleted next.
    const db = new Database(path);
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((row) => row.name));
      const sessionTable = tableNames.has("session_v2") ? "session_v2" : tableNames.has("session") ? "session" : null;
      if (!sessionTable) return false;
      const rows = db
        .query(
          `SELECT
            model,
            COALESCE(SUM(tokens_input), 0) AS tokens_input,
            COALESCE(SUM(tokens_output), 0) AS tokens_output,
            COALESCE(SUM(tokens_cache_read), 0) AS tokens_cache_read,
            COALESCE(SUM(tokens_cache_write), 0) AS tokens_cache_write,
            COALESCE(SUM(tokens_reasoning), 0) AS tokens_reasoning,
            COUNT(*) AS session_count
          FROM ${sessionTable}
          GROUP BY model`
        )
        .all() as Array<{
        model: string | null;
        tokens_input: number;
        tokens_output: number;
        tokens_cache_read: number;
        tokens_cache_write: number;
        tokens_reasoning: number;
        session_count: number;
      }>;
      let tokensExist = false;
      for (const row of rows) {
        const model = normalizeOpenCodeModel(row.model);
        add(sessions, sessionKey("opencode", model), Number(row.session_count) || 0);
        for (const tokenType of TOKEN_TYPES) {
          const value = Number(row[COLUMN_BY_TYPE[tokenType] as keyof typeof row]) || 0;
          if (value > 0) tokensExist = true;
          add(counters, tokenKey("opencode", model, tokenType), value);
        }
      }
      lastSuccessSeconds = Math.floor(Date.now() / 1000);
      return tokensExist;
    } finally {
      db.close();
    }
  } catch {
    errors += 1;
    return false;
  }
}

/** Record token usage for OpenCode parsed from parent-held events or usage structures. */
export function recordOpenCodeUsage(usage: ModelTokenUsage | undefined): void {
  recordCliUsage("opencode", usage);
  if (usage && usage.size > 0) {
    lastSuccessSeconds = Math.floor(Date.now() / 1000);
  }
}

/**
 * Parse OpenCode JSON events (both V1 with `tokens.total` and V2 without `tokens.total`).
 * Extracts token usage per model.
 */
export function parseOpenCodeEvents(events: unknown[] | string, defaultModel = "unknown"): ModelTokenUsage | undefined {
  let list: unknown[];
  if (typeof events === "string") {
    list = [];
    for (const line of events.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        list.push(JSON.parse(trimmed));
      } catch {
        // ignore non-JSON line
      }
    }
  } else if (Array.isArray(events)) {
    list = events;
  } else {
    return undefined;
  }

  const usage: ModelTokenUsage = new Map();
  let currentModel = defaultModel;

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const ev = item as Record<string, unknown>;
    if (typeof ev.model === "string" && ev.model.trim()) {
      currentModel = ev.model.trim();
    }
    const part = (ev.part && typeof ev.part === "object" ? ev.part : ev) as Record<string, unknown>;
    if (typeof part.model === "string" && part.model.trim()) {
      currentModel = part.model.trim();
    }
    if (ev.type === "step_finish" || part.tokens != null || ev.tokens != null) {
      const tokensObj = (part.tokens ?? ev.tokens) as Record<string, unknown> | undefined;
      if (tokensObj && typeof tokensObj === "object") {
        const cache = (tokensObj.cache && typeof tokensObj.cache === "object" ? tokensObj.cache : {}) as Record<
          string,
          unknown
        >;
        const model = normalizeOpenCodeModel(currentModel);
        const tokens: Record<TokenType, number> = {
          input: Number(tokensObj.input) || 0,
          cached_input: Number(cache.read ?? tokensObj.cached_input ?? tokensObj.cache_read) || 0,
          output: Number(tokensObj.output) || 0,
          cache_write: Number(cache.write ?? tokensObj.cache_write ?? tokensObj.cache_creation) || 0,
          reasoning: Number(tokensObj.reasoning) || 0,
        };
        const current = usage.get(model) ?? {
          input: 0,
          cached_input: 0,
          output: 0,
          cache_write: 0,
          reasoning: 0,
        };
        for (const t of TOKEN_TYPES) current[t] += tokens[t];
        usage.set(model, current);
      }
    }
  }

  return usage.size > 0 ? usage : undefined;
}

export function recordOpenCodeEvents(events: unknown[] | string, defaultModel?: string): boolean {
  const usage = parseOpenCodeEvents(events, defaultModel);
  if (!usage) return false;
  recordOpenCodeUsage(usage);
  return true;
}

/**
 * Record one Claude child run's parent-held usage (from stream-json stdout).
 * Fail-open: missing usage records nothing and never throws.
 */
export function recordClaudeUsage(usage: ModelTokenUsage | undefined): void {
  recordCliUsage("claude", usage);
}

/** Same as `recordClaudeUsage` for an `agy -p --output-format stream-json` child. */
export function recordAgyUsage(usage: ModelTokenUsage | undefined): void {
  recordCliUsage("agy", usage);
}

/** Same as `recordClaudeUsage` for a `codex exec --json` child. Missing usage records nothing. */
export function recordCodexUsage(usage: ModelTokenUsage | undefined): void {
  recordCliUsage("codex", usage);
}

function recordCliUsage(source: TokenSource, usage: ModelTokenUsage | undefined): void {
  if (!usage) return;
  for (const [model, tokens] of usage) {
    add(sessions, sessionKey(source, model), 1);
    for (const tokenType of TOKEN_TYPES) add(counters, tokenKey(source, model, tokenType), tokens[tokenType]);
  }
}

function seriesLabels(source: TokenSource, model: string, tokenType?: TokenType): string {
  const parts = [
    `agent_instance="${escapeLabel(agentInstance())}"`,
    `source="${source}"`,
    'profile="default"',
    `model="${escapeLabel(model)}"`,
  ];
  if (tokenType) parts.push(`token_type="${escapeLabel(tokenType)}"`);
  return parts.join(",");
}

export function renderTokenMetrics(): string {
  const agent = escapeLabel(agentInstance());
  const lines: string[] = [
    "# HELP ai_token_exporter_up 1 if the process can serve token series",
    "# TYPE ai_token_exporter_up gauge",
    `ai_token_exporter_up{agent_instance="${agent}"} 1`,
    "# HELP ai_token_exporter_last_success_seconds Unix time of last successful OpenCode DB read",
    "# TYPE ai_token_exporter_last_success_seconds gauge",
    `ai_token_exporter_last_success_seconds{agent_instance="${agent}"} ${lastSuccessSeconds}`,
    "# HELP ai_token_exporter_errors OpenCode DB read failures in this process",
    "# TYPE ai_token_exporter_errors counter",
    `ai_token_exporter_errors{agent_instance="${agent}"} ${errors}`,
    "# HELP ai_trace_exporter_errors Phoenix OTLP export failures in this process",
    "# TYPE ai_trace_exporter_errors counter",
    `ai_trace_exporter_errors{agent_instance="${agent}"} ${traceExportErrors()}`,
    "# HELP ai_tokens_total Cumulative AI tokens observed by this process",
    "# TYPE ai_tokens_total counter",
  ];

  const tokenEntries = [...counters.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of tokenEntries) {
    const [source, model, tokenType] = key.split("\0") as [TokenSource, string, TokenType];
    lines.push(`ai_tokens_total{${seriesLabels(source, model, tokenType)}} ${value}`);
  }

  lines.push("# HELP ai_tokens Current in-process token totals (reset on process restart)");
  lines.push("# TYPE ai_tokens gauge");
  // Same in-process totals as ai_tokens_total, exported as a gauge.
  for (const [key, value] of tokenEntries) {
    const [source, model, tokenType] = key.split("\0") as [TokenSource, string, TokenType];
    lines.push(`ai_tokens{${seriesLabels(source, model, tokenType)}} ${value}`);
  }

  lines.push("# HELP ai_sessions Sessions recorded by this process");
  lines.push("# TYPE ai_sessions counter");
  for (const [key, value] of [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [source, model] = key.split("\0") as [TokenSource, string];
    lines.push(`ai_sessions{${seriesLabels(source, model)}} ${value}`);
  }

  return `${lines.join("\n")}\n`;
}
