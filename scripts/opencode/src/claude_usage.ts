/**
 * Parent-side parser for `claude -p --output-format stream-json --verbose`.
 *
 * Token usage comes from the final `result` event's `modelUsage` (top-level
 * `usage` undercounts and omits side models such as the Haiku classifier).
 * When the child is killed before `result` (timeout, 143), fall back to the
 * per-message `assistant` usage seen so far. Everything is fail-open: lines
 * that are not stream-json are kept as plain output text.
 */

import { type ModelTokenUsage, TOKEN_TYPES, type TokenType } from "./token_metrics.ts";
import { isRecord } from "./util/object.ts";

type JsonObject = Record<string, unknown>;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function emptyTokens(): Record<TokenType, number> {
  return Object.fromEntries(TOKEN_TYPES.map((tokenType) => [tokenType, 0])) as Record<TokenType, number>;
}

function addTokens(usage: ModelTokenUsage, model: string, tokens: Record<TokenType, number>): void {
  const current = usage.get(model) ?? emptyTokens();
  for (const tokenType of TOKEN_TYPES) current[tokenType] += tokens[tokenType];
  usage.set(model, current);
}

function modelLabel(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function parseClaudeModelUsage(modelUsage: unknown): ModelTokenUsage | undefined {
  if (!isRecord(modelUsage)) return undefined;
  const usage: ModelTokenUsage = new Map();
  for (const [key, value] of Object.entries(modelUsage)) {
    if (!isRecord(value)) continue;
    addTokens(usage, modelLabel(value.canonicalModel, modelLabel(key)), {
      input: count(value.inputTokens),
      cached_input: count(value.cacheReadInputTokens),
      output: count(value.outputTokens),
      cache_write: count(value.cacheCreationInputTokens),
      reasoning: count(value.thinkingTokens),
    });
  }
  return usage.size > 0 ? usage : undefined;
}

export class ClaudeStreamParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private readonly textParts: string[] = [];
  private resultUsage: ModelTokenUsage | undefined;
  private readonly assistantUsage = new Map<string, { model: string; tokens: Record<TokenType, number> }>();
  private anonymousMessages = 0;

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

  /** Human-readable stdout: the `result` text plus any non-stream-json lines. */
  text(): string {
    return this.textParts.join("\n");
  }

  usage(): ModelTokenUsage | undefined {
    if (this.resultUsage) return this.resultUsage;
    if (this.assistantUsage.size === 0) return undefined;
    const usage: ModelTokenUsage = new Map();
    for (const { model, tokens } of this.assistantUsage.values()) addTokens(usage, model, tokens);
    return usage;
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
    if (!isRecord(event) || typeof event.type !== "string") {
      this.textParts.push(line);
      return;
    }
    if (event.type === "result") {
      if (typeof event.result === "string" && event.result) this.textParts.push(event.result);
      this.resultUsage = parseClaudeModelUsage(event.modelUsage) ?? this.resultUsage;
      return;
    }
    if (event.type === "assistant" && isRecord(event.message)) this.recordAssistant(event.message);
  }

  private recordAssistant(message: JsonObject): void {
    const usage = message.usage;
    if (!isRecord(usage)) return;
    // stream-json repeats one message per content block with the same id and
    // usage; keep the latest copy rather than summing duplicates.
    const id = typeof message.id === "string" && message.id ? message.id : `anonymous-${this.anonymousMessages++}`;
    this.assistantUsage.set(id, {
      model: modelLabel(message.model),
      tokens: {
        input: count(usage.input_tokens),
        cached_input: count(usage.cache_read_input_tokens),
        output: count(usage.output_tokens),
        cache_write: count(usage.cache_creation_input_tokens),
        reasoning: 0,
      },
    });
  }
}
