/**
 * Parent-side parser for `codex exec --json` (JSON Lines).
 *
 * `turn.completed` carries `usage`, which is the thread's running total, not
 * this turn's delta. Each completed turn records only the growth since the
 * previous total (the persisted one on a resumed thread), so a parent kill
 * still records tokens seen so far and an extra turn does not re-add earlier
 * ones. Lines that are not JSONL are kept as plain text. Missing or
 * unparseable usage is skip, never a throw.
 */

import { type ModelTokenUsage, TOKEN_TYPES, type TokenType } from "./token_metrics.ts";

type JsonObject = Record<string, unknown>;

export interface CodexItem {
  type: string;
  id?: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  status?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
}

export interface CodexTraceEvent {
  type: string;
  atMs: number;
  model?: string;
  threadId?: string;
  error?: string;
  item?: CodexItem;
  usage?: CodexTokens;
}

export type CodexTokens = Record<TokenType, number>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function emptyTokens(): CodexTokens {
  return Object.fromEntries(TOKEN_TYPES.map((tokenType) => [tokenType, 0])) as CodexTokens;
}

function addTokens(usage: ModelTokenUsage, model: string, tokens: CodexTokens): void {
  const current = usage.get(model) ?? emptyTokens();
  for (const tokenType of TOKEN_TYPES) current[tokenType] += tokens[tokenType];
  usage.set(model, current);
}

function modelLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Codex `input_tokens` includes the cached and cache-write ones, and
 * `output_tokens` includes the reasoning ones; the `input` and `output`
 * buckets do not.
 */
function usageFrom(value: unknown): CodexTokens | undefined {
  if (!isObject(value)) return undefined;
  const cached = count(value.cached_input_tokens);
  const cacheWrite = count(value.cache_write_input_tokens);
  const reasoning = count(value.reasoning_output_tokens);
  const tokens: CodexTokens = {
    input: Math.max(0, count(value.input_tokens) - cached - cacheWrite),
    cached_input: cached,
    output: Math.max(0, count(value.output_tokens) - reasoning),
    cache_write: cacheWrite,
    reasoning,
  };
  if (TOKEN_TYPES.every((tokenType) => tokens[tokenType] === 0)) return undefined;
  return tokens;
}

/** Growth from `previous` to `total`. A total that went backwards is a fresh count. */
function tokensSince(total: CodexTokens, previous: CodexTokens | undefined): CodexTokens {
  if (!previous || TOKEN_TYPES.some((tokenType) => total[tokenType] < previous[tokenType])) return { ...total };
  const delta = emptyTokens();
  for (const tokenType of TOKEN_TYPES) delta[tokenType] = total[tokenType] - previous[tokenType];
  return delta;
}

/** A persisted thread total, or undefined when it is not one. */
export function codexTokensFrom(value: unknown): CodexTokens | undefined {
  if (!isObject(value)) return undefined;
  const tokens = emptyTokens();
  for (const tokenType of TOKEN_TYPES) tokens[tokenType] = count(value[tokenType]);
  return tokens;
}

function itemFrom(value: unknown): CodexItem | undefined {
  if (!isObject(value) || typeof value.type !== "string") return undefined;
  const item: CodexItem = { type: value.type };
  if (typeof value.id === "string") item.id = value.id;
  if (typeof value.text === "string") item.text = value.text;
  if (typeof value.command === "string") item.command = value.command;
  if (typeof value.aggregated_output === "string") item.aggregatedOutput = value.aggregated_output;
  if (typeof value.status === "string") item.status = value.status;
  if (typeof value.name === "string") item.name = value.name;
  if (value.arguments !== undefined) item.arguments = value.arguments;
  if (value.output !== undefined) item.output = value.output;
  if (typeof value.result === "string" && item.aggregatedOutput === undefined) item.aggregatedOutput = value.result;
  return item;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isObject(value)) return undefined;
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  if (typeof value.error === "string" && value.error.trim()) return value.error.trim();
  return undefined;
}

export class CodexStreamParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private readonly textParts: string[] = [];
  private readonly errorParts: string[] = [];
  private readonly events: CodexTraceEvent[] = [];
  private readonly usageByModel: ModelTokenUsage = new Map();
  private sawUsage = false;
  private threadId: string | undefined;
  private seenModel: string | undefined;
  private lastTotal: CodexTokens | undefined;

  /** `resumedTotal` is the total the resumed thread had already reached. */
  constructor(resumedTotal?: CodexTokens) {
    this.lastTotal = resumedTotal;
  }

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      this.parseLine(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
  }

  end(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer) this.parseLine(this.buffer);
    this.buffer = "";
  }

  text(): string {
    return this.textParts.join("\n");
  }

  /** Error events only. Agent message text is not a hop signal. */
  errors(): string {
    return this.errorParts.join("\n");
  }

  threadIdValue(): string | undefined {
    return this.threadId;
  }

  modelSeen(): string | undefined {
    return this.seenModel;
  }

  /** Latest thread total seen in this run, for the next resume. */
  threadTotal(): CodexTokens | undefined {
    return this.sawUsage ? this.lastTotal : undefined;
  }

  traceEvents(): readonly CodexTraceEvent[] {
    return this.events;
  }

  usage(fallbackModel: string): ModelTokenUsage | undefined {
    if (!this.sawUsage || this.usageByModel.size === 0) return undefined;
    const model = this.seenModel || fallbackModel || "unknown";
    const out: ModelTokenUsage = new Map();
    for (const [key, tokens] of this.usageByModel) addTokens(out, key || model, tokens);
    return out.size > 0 ? out : undefined;
  }

  private parseLine(rawLine: string): void {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.textParts.push(line);
      return;
    }
    if (!isObject(event) || typeof event.type !== "string") {
      this.textParts.push(line);
      return;
    }
    const atMs = Date.now();
    const model = modelLabel(event.model);
    if (model) this.seenModel = model;
    const trace: CodexTraceEvent = { type: event.type, atMs, ...(model ? { model } : {}) };

    if (event.type === "thread.started") {
      const id = typeof event.thread_id === "string" ? event.thread_id.trim() : "";
      if (id) {
        this.threadId = id;
        trace.threadId = id;
      }
      this.events.push(trace);
      return;
    }

    if (event.type === "error" || event.type === "turn.failed") {
      const message = errorText(event.error) ?? errorText(event.message) ?? errorText(event);
      if (message) {
        this.errorParts.push(message);
        trace.error = message;
      }
      this.events.push(trace);
      return;
    }

    if (event.type === "item.completed" || event.type === "item.started") {
      const item = itemFrom(event.item);
      if (item) {
        trace.item = item;
        if (item.type === "agent_message" && item.text && event.type === "item.completed")
          this.textParts.push(item.text);
      }
      this.events.push(trace);
      return;
    }

    if (event.type === "turn.completed") {
      const total = usageFrom(event.usage);
      if (total) {
        const tokens = tokensSince(total, this.lastTotal);
        this.lastTotal = total;
        this.sawUsage = true;
        addTokens(this.usageByModel, model || this.seenModel || "", tokens);
        trace.usage = tokens;
      }
      this.events.push(trace);
      return;
    }

    this.events.push(trace);
  }
}
