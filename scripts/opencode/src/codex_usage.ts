/**
 * Parent-side parser for `codex exec --json` (JSON Lines).
 *
 * `turn.completed` carries `usage`, which is the thread's running total, not
 * this turn's delta. Each completed turn records only the growth since the
 * previous total (the persisted one on a resumed thread), so a parent kill
 * still records tokens seen so far and an extra turn does not re-add earlier
 * ones. Lines that are not JSONL are kept as plain text. Missing or
 * unparseable usage is skip, never a throw.
 *
 * Memory is bounded by a fixed byte budget per category:
 * - result text (`text()`: agent messages + non-JSON lines): CODEX_TEXT_MAX_BYTES,
 *   tail-kept so the final verdict survives; overflow drops the oldest parts.
 * - error text (`errors()`): CODEX_ERROR_MAX_BYTES, head-kept so the first
 *   hop signal survives; overflow drops the tail.
 * - trace-only data (`traceEvents()` item payloads): CODEX_ITEM_MAX_BYTES per
 *   string field (matching the `codex_tracing` span clip, so storing more is
 *   waste) and CODEX_TRACE_MAX_BYTES / CODEX_TRACE_MAX_EVENTS total; overflow
 *   drops the oldest events. Usage totals, thread id, and error text are
 *   tracked separately and never dropped with trace events.
 * - when `collectTrace` is false (trace export off), no trace events or item
 *   payloads are retained at all; result data still is.
 * Truncated text, error, and item fields carry a visible marker; inputs under
 * the caps are unchanged.
 */

import { type ModelTokenUsage, TOKEN_TYPES, type TokenType } from "./token_metrics.ts";
import { isRecord } from "./util/object.ts";

interface CodexItem {
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

/** Fixed retention budgets. See the header comment for what each covers. */
export const CODEX_TEXT_MAX_BYTES = 128_000;
export const CODEX_ERROR_MAX_BYTES = 64_000;
export const CODEX_TRACE_MAX_EVENTS = 500;
export const CODEX_TRACE_MAX_BYTES = 256_000;
export const CODEX_ITEM_MAX_BYTES = 8_000;

export interface CodexParserOptions {
  /** When false, trace events and item payloads are not retained at all. Defaults to true. */
  collectTrace?: boolean;
  maxTextBytes?: number;
  maxErrorBytes?: number;
  maxTraceEvents?: number;
  maxTraceBytes?: number;
  maxItemBytes?: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function truncateHeadText(value: string, maxBytes: number): string {
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const marker = `\n\n[truncated at ${maxBytes} bytes]`;
  const keep = Math.max(0, maxBytes - textEncoder.encode(marker).byteLength);
  const head = textDecoder.decode(bytes.slice(0, keep));
  return `${head}${marker}`;
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
  if (!isRecord(value)) return undefined;
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
  if (!isRecord(value)) return undefined;
  const tokens = emptyTokens();
  for (const tokenType of TOKEN_TYPES) tokens[tokenType] = count(value[tokenType]);
  return tokens;
}

function itemFrom(value: unknown, maxItemBytes = CODEX_ITEM_MAX_BYTES): CodexItem | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const item: CodexItem = { type: value.type };
  if (typeof value.id === "string") item.id = value.id;
  if (typeof value.text === "string") item.text = truncateHeadText(value.text, maxItemBytes);
  if (typeof value.command === "string") item.command = truncateHeadText(value.command, maxItemBytes);
  if (typeof value.aggregated_output === "string")
    item.aggregatedOutput = truncateHeadText(value.aggregated_output, maxItemBytes);
  if (typeof value.status === "string") item.status = value.status;
  if (typeof value.name === "string") item.name = value.name;
  if (value.arguments !== undefined) item.arguments = capJsonValue(value.arguments, maxItemBytes);
  if (value.output !== undefined) item.output = capJsonValue(value.output, maxItemBytes);
  if (typeof value.result === "string" && item.aggregatedOutput === undefined)
    item.aggregatedOutput = truncateHeadText(value.result, maxItemBytes);
  return item;
}

function capJsonValue(value: unknown, maxItemBytes: number): unknown {
  if (typeof value === "string") return truncateHeadText(value, maxItemBytes);
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    return value;
  }
  if (!text || textEncoder.encode(text).byteLength <= maxItemBytes) return value;
  return truncateHeadText(text, maxItemBytes);
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  if (typeof value.error === "string" && value.error.trim()) return value.error.trim();
  return undefined;
}

function itemPayloadBytes(item: CodexItem | undefined): number {
  if (!item) return 0;
  let size = 0;
  if (item.text) size += byteLength(item.text);
  if (item.command) size += byteLength(item.command);
  if (item.aggregatedOutput) size += byteLength(item.aggregatedOutput);
  for (const extra of [item.arguments, item.output]) {
    if (extra === undefined) continue;
    if (typeof extra === "string") size += byteLength(extra);
    else {
      try {
        const text = JSON.stringify(extra) ?? "";
        size += byteLength(text);
      } catch {
        size += 256;
      }
    }
  }
  return size;
}

function traceEventBytes(event: CodexTraceEvent): number {
  let size = byteLength(event.type) + 16;
  if (event.model) size += byteLength(event.model);
  if (event.threadId) size += byteLength(event.threadId);
  if (event.error) size += byteLength(event.error);
  size += itemPayloadBytes(event.item);
  if (event.usage) size += 64;
  return size;
}

function isParserOptions(value: unknown): value is CodexParserOptions {
  if (!isRecord(value)) return false;
  return (
    "collectTrace" in value ||
    "maxTextBytes" in value ||
    "maxErrorBytes" in value ||
    "maxTraceEvents" in value ||
    "maxTraceBytes" in value ||
    "maxItemBytes" in value
  );
}

export class CodexStreamParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private readonly textParts: string[] = [];
  private textBytes = 0;
  private textTruncated = false;
  private readonly errorParts: string[] = [];
  private errorBytes = 0;
  private errorTruncated = false;
  private readonly events: CodexTraceEvent[] = [];
  private traceBytes = 0;
  private readonly usageByModel: ModelTokenUsage = new Map();
  private sawUsage = false;
  private threadId: string | undefined;
  private seenModel: string | undefined;
  private lastTotal: CodexTokens | undefined;
  private readonly collectTrace: boolean;
  private readonly maxTextBytes: number;
  private readonly maxErrorBytes: number;
  private readonly maxTraceEvents: number;
  private readonly maxTraceBytes: number;
  private readonly maxItemBytes: number;

  /**
   * `resumedTotal` is the total the resumed thread had already reached.
   * Pass `{ collectTrace: false }` (as the second argument, or the first when
   * there is no resumed total) to retain no trace events or item payloads.
   */
  constructor(resumedTotal?: CodexTokens | CodexParserOptions, options?: CodexParserOptions) {
    const opts = isParserOptions(resumedTotal) ? resumedTotal : (options ?? {});
    const resumed = isParserOptions(resumedTotal) ? undefined : resumedTotal;
    this.lastTotal = resumed;
    this.collectTrace = opts.collectTrace ?? true;
    this.maxTextBytes = opts.maxTextBytes ?? CODEX_TEXT_MAX_BYTES;
    this.maxErrorBytes = opts.maxErrorBytes ?? CODEX_ERROR_MAX_BYTES;
    this.maxTraceEvents = opts.maxTraceEvents ?? CODEX_TRACE_MAX_EVENTS;
    this.maxTraceBytes = opts.maxTraceBytes ?? CODEX_TRACE_MAX_BYTES;
    this.maxItemBytes = opts.maxItemBytes ?? CODEX_ITEM_MAX_BYTES;
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
    const joined = this.textParts.join("\n");
    if (!this.textTruncated) return joined;
    return `[codex output truncated at ${this.maxTextBytes} bytes; kept last]\n\n${joined}`;
  }

  /** Error events only. Agent message text is not a hop signal. Head-kept so the first signal survives. */
  errors(): string {
    const joined = this.errorParts.join("\n");
    if (!this.errorTruncated) return joined;
    return `${joined}\n\n[codex errors truncated at ${this.maxErrorBytes} bytes]`;
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

  /** Approximate retained bytes across text, errors, and trace events. */
  retainedBytes(): number {
    return (
      this.textBytes +
      Math.max(0, this.textParts.length - 1) +
      this.errorBytes +
      Math.max(0, this.errorParts.length - 1) +
      this.traceBytes
    );
  }

  usage(fallbackModel: string): ModelTokenUsage | undefined {
    if (!this.sawUsage || this.usageByModel.size === 0) return undefined;
    const model = this.seenModel || fallbackModel || "unknown";
    const out: ModelTokenUsage = new Map();
    for (const [key, tokens] of this.usageByModel) addTokens(out, key || model, tokens);
    return out.size > 0 ? out : undefined;
  }

  private pushText(part: string): void {
    this.textParts.push(part);
    this.textBytes += byteLength(part);
    while (this.textParts.length > 1 && this.textBytes + this.textParts.length - 1 > this.maxTextBytes) {
      const removed = this.textParts.shift();
      if (removed !== undefined) this.textBytes -= byteLength(removed);
      this.textTruncated = true;
    }
    if (this.textParts.length === 1 && this.textBytes > this.maxTextBytes) {
      const only = this.textParts[0] ?? "";
      const encoded = textEncoder.encode(only);
      const kept = textDecoder.decode(encoded.slice(encoded.byteLength - this.maxTextBytes));
      this.textParts[0] = kept;
      this.textBytes = byteLength(kept);
      this.textTruncated = true;
    }
  }

  private pushError(part: string): void {
    const partBytes = byteLength(part);
    const separator = this.errorParts.length > 0 ? 1 : 0;
    if (this.errorBytes + separator + partBytes <= this.maxErrorBytes) {
      this.errorParts.push(part);
      this.errorBytes += partBytes;
      return;
    }
    this.errorTruncated = true;
    if (this.errorParts.length === 0) {
      const encoded = textEncoder.encode(part);
      const kept = textDecoder.decode(encoded.slice(0, this.maxErrorBytes));
      this.errorParts.push(kept);
      this.errorBytes = byteLength(kept);
      return;
    }
    const remaining = this.maxErrorBytes - this.errorBytes - separator;
    if (remaining > 0) {
      const encoded = textEncoder.encode(part);
      const kept = textDecoder.decode(encoded.slice(0, remaining));
      this.errorParts.push(kept);
      this.errorBytes += byteLength(kept);
    }
  }

  private pushTrace(trace: CodexTraceEvent): void {
    if (!this.collectTrace) return;
    if (trace.error && byteLength(trace.error) > this.maxItemBytes) {
      trace.error = truncateHeadText(trace.error, this.maxItemBytes);
    }
    const size = traceEventBytes(trace);
    this.events.push(trace);
    this.traceBytes += size;
    while (
      this.events.length > 1 &&
      (this.events.length > this.maxTraceEvents || this.traceBytes > this.maxTraceBytes)
    ) {
      const removed = this.events.shift();
      if (removed) this.traceBytes -= traceEventBytes(removed);
    }
  }

  private parseLine(rawLine: string): void {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.pushText(line);
      return;
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      this.pushText(line);
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
      this.pushTrace(trace);
      return;
    }

    if (event.type === "error" || event.type === "turn.failed") {
      const message = errorText(event.error) ?? errorText(event.message) ?? errorText(event);
      if (message) {
        this.pushError(message);
        trace.error = message;
      }
      this.pushTrace(trace);
      return;
    }

    if (event.type === "item.completed" || event.type === "item.started") {
      const item = itemFrom(event.item, this.maxItemBytes);
      if (item) {
        if (event.type === "item.completed" && item.type === "agent_message") {
          const raw = isRecord(event.item) && typeof event.item.text === "string" ? event.item.text : undefined;
          if (raw) this.pushText(raw);
        }
        if (this.collectTrace) trace.item = item;
      }
      this.pushTrace(trace);
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
      this.pushTrace(trace);
      return;
    }

    this.pushTrace(trace);
  }
}
