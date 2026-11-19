/**
 * Parent-side parser for `agy -p --output-format stream-json`.
 *
 * Events are NDJSON objects keyed by `event` (`init`, `step_update`, `result`).
 * Live `agy --output-format stream-json` nests the payload under that name
 * (`event.result`, `event.step_update`); a flat shape is accepted as fallback.
 * Token usage comes from the terminal `result` event's cumulative `usage`.
 * When the child is killed before `result` (timeout, 143), fall back to the
 * per-step `usage` keyed by `step_index`. The `result` envelope also carries
 * `status`, `response`, `error`, and `denied_actions`, which the runner needs
 * to fail closed on an empty SUCCESS. Everything is fail-open: lines that are
 * not stream-json are kept as plain output text.
 */

import { type ModelTokenUsage, TOKEN_TYPES, type TokenType } from "./token_metrics.ts";
import { isRecord } from "./util/object.ts";

type JsonObject = Record<string, unknown>;

export interface AgyResultEnvelope {
  status?: string;
  response?: string;
  error?: string;
  deniedActions: string[];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function eventName(event: JsonObject): string | undefined {
  return nonEmptyString(event.event) ?? nonEmptyString(event.type);
}

function nestedPayload(event: JsonObject, key: string): JsonObject {
  const nested = event[key];
  return isRecord(nested) ? nested : event;
}

function pickString(payload: JsonObject, event: JsonObject, key: string): string | undefined {
  return nonEmptyString(payload[key]) ?? (payload === event ? undefined : nonEmptyString(event[key]));
}

function parseAgyUsage(usage: unknown): Record<TokenType, number> | undefined {
  if (!isRecord(usage)) return undefined;
  const tokens: Record<TokenType, number> = {
    input: count(usage.input_tokens),
    cached_input: count(usage.cache_read_tokens),
    output: count(usage.output_tokens),
    cache_write: 0,
    reasoning: count(usage.thinking_tokens),
  };
  return TOKEN_TYPES.some((tokenType) => tokens[tokenType] > 0) ? tokens : undefined;
}

function errorText(value: unknown): string | undefined {
  if (isRecord(value)) return nonEmptyString(value.message) ?? JSON.stringify(value);
  return nonEmptyString(value);
}

function deniedActions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    if (isRecord(entry)) return nonEmptyString(entry.tool) ?? nonEmptyString(entry.name) ?? JSON.stringify(entry);
    return String(entry);
  });
}

export class AgyStreamParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private readonly textParts: string[] = [];
  private resultUsage: Record<TokenType, number> | undefined;
  private resultModel: string | undefined;
  private readonly stepUsage = new Map<string, Record<TokenType, number>>();
  private anonymousSteps = 0;
  private envelope: AgyResultEnvelope | undefined;
  private conversation: string | undefined;

  constructor(private readonly model: string) {}

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

  /** Human-readable stdout: the `result` response/error plus any non-stream-json lines. */
  text(): string {
    return this.textParts.join("\n");
  }

  /** The terminal `result` envelope, or undefined when the child died before it. */
  result(): AgyResultEnvelope | undefined {
    return this.envelope;
  }

  conversationId(): string | undefined {
    return this.conversation;
  }

  usage(): ModelTokenUsage | undefined {
    const model = this.resultModel ?? this.model;
    if (this.resultUsage) return new Map([[model, this.resultUsage]]);
    if (this.stepUsage.size === 0) return undefined;
    const total = Object.fromEntries(TOKEN_TYPES.map((tokenType) => [tokenType, 0])) as Record<TokenType, number>;
    for (const tokens of this.stepUsage.values()) {
      for (const tokenType of TOKEN_TYPES) total[tokenType] += tokens[tokenType];
    }
    return new Map([[model, total]]);
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
    const name = isRecord(event) ? eventName(event) : undefined;
    if (!isRecord(event) || !name) {
      this.textParts.push(line);
      return;
    }
    this.conversation ??= nonEmptyString(event.conversation_id);
    if (name === "result") {
      this.recordResult(event);
      return;
    }
    if (name === "step_update") this.recordStep(event);
  }

  private recordResult(event: JsonObject): void {
    const payload = nestedPayload(event, "result");
    this.conversation ??= nonEmptyString(payload.conversation_id);
    const response =
      typeof payload.response === "string"
        ? payload.response
        : typeof event.response === "string"
          ? event.response
          : undefined;
    const error = errorText(payload.error) ?? (payload === event ? undefined : errorText(event.error));
    this.envelope = {
      status: pickString(payload, event, "status"),
      response,
      error,
      deniedActions: deniedActions(payload.denied_actions ?? event.denied_actions),
    };
    if (response?.trim()) this.textParts.push(response);
    if (error) this.textParts.push(error);
    this.resultModel = pickString(payload, event, "model") ?? this.resultModel;
    this.resultUsage = parseAgyUsage(payload.usage) ?? parseAgyUsage(event.usage) ?? this.resultUsage;
  }

  private recordStep(event: JsonObject): void {
    const payload = nestedPayload(event, "step_update");
    this.conversation ??= nonEmptyString(payload.conversation_id);
    const step = isRecord(payload.step) ? payload.step : isRecord(event.step) ? event.step : undefined;
    const tokens = parseAgyUsage(payload.usage) ?? parseAgyUsage(event.usage) ?? parseAgyUsage(step?.usage);
    if (!tokens) return;
    const index =
      typeof payload.step_index === "number"
        ? payload.step_index
        : typeof event.step_index === "number"
          ? event.step_index
          : undefined;
    const id =
      (index != null ? `index-${index}` : undefined) ??
      nonEmptyString(payload.step_id) ??
      nonEmptyString(event.step_id) ??
      nonEmptyString(step?.id) ??
      `anonymous-${this.anonymousSteps++}`;
    this.stepUsage.set(id, tokens);
  }
}
