/**
 * Phoenix tracing for `type: codex` runs.
 *
 * The stock CLI OTEL exporter cannot attach the Jumi job id, and a
 * danger-full-access run's LLM spans would reprint the growing transcript.
 * Those spans are not ones Phoenix can look up next to this factory's other
 * runners. The parent parses the JSONL item stream into the same OpenInference
 * shape Claude jobs already use (job id, tool name and result, this turn's
 * output only, no raw prompt) and posts OTLP to the in-cluster Phoenix service.
 *
 * Nothing is installed onto HOME. No endpoint, a public Phoenix hostname, a
 * timeout, or a POST failure is skip — never a failed job.
 */

import { agentInstance } from "./agent_instance.ts";
import type { CodexTraceEvent } from "./codex_usage.ts";
import type { TraceContext } from "./engine.ts";
import { type OtlpSpan, SPAN_KIND_INTERNAL, STATUS_CODE_ERROR, STATUS_CODE_OK } from "./otlp.ts";
import { exportOtlpSpans } from "./phoenix.ts";

const ATTR_MAX = 8_000;

function clip(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > ATTR_MAX ? value.slice(0, ATTR_MAX) : value;
}

function jsonAttr(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return clip(value);
  try {
    const text = JSON.stringify(value);
    if (!text || text === "{}" || text === "[]") return undefined;
    return clip(text);
  } catch {
    return undefined;
  }
}

function msToNano(ms: number): bigint {
  const safe = Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : Date.now();
  return BigInt(safe) * 1_000_000n;
}

function randomId(bytes: number): Uint8Array {
  const id = new Uint8Array(bytes);
  crypto.getRandomValues(id);
  return id;
}

function sharedAttrs(trace: TraceContext | undefined, agent: string): Record<string, string> {
  const attrs: Record<string, string> = { agent_instance: agent };
  if (!trace) return attrs;
  attrs.kind = trace.kind;
  attrs.owner = trace.owner;
  attrs.repo = trace.repo;
  if (trace.sha) attrs.sha = trace.sha;
  if (trace.jobId) {
    attrs.job_id = trace.jobId;
    attrs["session.id"] = trace.jobId;
  }
  return attrs;
}

function toolName(item: NonNullable<CodexTraceEvent["item"]>): string {
  if (item.name) return item.name;
  if (item.type === "command_execution") return "shell";
  if (item.type === "file_change") return "apply_patch";
  return item.type || "tool";
}

function toolParams(item: NonNullable<CodexTraceEvent["item"]>): string | undefined {
  if (item.command) return clip(item.command);
  return jsonAttr(item.arguments);
}

function toolOutput(item: NonNullable<CodexTraceEvent["item"]>): string | undefined {
  if (item.aggregatedOutput) return clip(item.aggregatedOutput);
  return jsonAttr(item.output);
}

export function buildCodexSpans(
  events: readonly CodexTraceEvent[],
  trace: TraceContext | undefined,
  model: string
): OtlpSpan[] {
  if (events.length === 0) return [];
  const agent = agentInstance();
  const shared = sharedAttrs(trace, agent);
  const traceId = randomId(16);
  const rootId = randomId(8);
  const start = events[0]?.atMs ?? Date.now();
  const end = events[events.length - 1]?.atMs ?? start;
  const spans: OtlpSpan[] = [
    {
      traceId,
      spanId: rootId,
      name: "codex",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToNano(start),
      endTimeUnixNano: msToNano(end),
      attributes: { ...shared, "openinference.span.kind": "AGENT" },
      statusCode: STATUS_CODE_OK,
    },
  ];

  let turnStart = start;
  let turnModel = model;
  const turnText: string[] = [];
  let turnUsage: CodexTraceEvent["usage"];
  let turnError: string | undefined;

  const flushTurn = (atMs: number, failed?: string) => {
    const output = clip(turnText.join("\n"));
    const attrs: Record<string, string | number> = {
      ...shared,
      "openinference.span.kind": "LLM",
      "llm.model_name": turnModel || model || "unknown",
    };
    if (turnUsage) {
      // The buckets are disjoint: the prompt is every input one, the
      // completion includes reasoning.
      const prompt = turnUsage.input + turnUsage.cached_input + turnUsage.cache_write;
      const completion = turnUsage.output + turnUsage.reasoning;
      if (prompt) attrs["llm.token_count.prompt"] = prompt;
      if (completion) attrs["llm.token_count.completion"] = completion;
    }
    if (output) {
      attrs["output.value"] = output;
      attrs["output.mime_type"] = "text/plain";
    }
    spans.push({
      traceId,
      spanId: randomId(8),
      parentSpanId: rootId,
      name: turnModel || model || "llm",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToNano(turnStart),
      endTimeUnixNano: msToNano(atMs),
      attributes: attrs,
      statusCode: failed ? STATUS_CODE_ERROR : STATUS_CODE_OK,
      statusMessage: failed,
    });
    turnText.length = 0;
    turnUsage = undefined;
    turnError = undefined;
  };

  for (const event of events) {
    if (event.model) turnModel = event.model;
    if (event.type === "turn.started") {
      turnStart = event.atMs;
      turnText.length = 0;
      turnUsage = undefined;
      turnError = undefined;
      continue;
    }
    if (event.type === "turn.completed") {
      turnUsage = event.usage;
      flushTurn(event.atMs);
      continue;
    }
    // An `error` can precede the `turn.failed` of the same turn. Only the
    // latter ends the turn, so the former just supplies the status message.
    if (event.type === "error") {
      turnError = event.error ?? turnError;
      continue;
    }
    if (event.type === "turn.failed") {
      flushTurn(event.atMs, event.error ?? turnError ?? "turn failed");
      continue;
    }
    const item = event.item;
    if (!item || event.type !== "item.completed") continue;
    if (item.type === "agent_message") {
      if (item.text) turnText.push(item.text);
      continue;
    }
    if (item.type === "reasoning") continue;
    const name = toolName(item);
    const params = toolParams(item);
    const output = toolOutput(item);
    const attrs: Record<string, string | number> = {
      ...shared,
      "openinference.span.kind": "TOOL",
      "tool.name": name,
      "tool.status": item.status ?? "completed",
    };
    if (params) {
      attrs["tool.parameters"] = params;
      attrs["input.value"] = params;
      attrs["input.mime_type"] = "text/plain";
    }
    if (output) {
      attrs["output.value"] = output;
      attrs["output.mime_type"] = output.startsWith("{") || output.startsWith("[") ? "application/json" : "text/plain";
    }
    const failed = item.status === "failed" || item.status === "error";
    spans.push({
      traceId,
      spanId: randomId(8),
      parentSpanId: rootId,
      name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: msToNano(event.atMs),
      endTimeUnixNano: msToNano(event.atMs),
      attributes: attrs,
      statusCode: failed ? STATUS_CODE_ERROR : STATUS_CODE_OK,
    });
  }
  return spans;
}

export async function exportCodexTrace(
  events: readonly CodexTraceEvent[],
  trace: TraceContext | undefined,
  model: string
): Promise<void> {
  try {
    await exportOtlpSpans(buildCodexSpans(events, trace, model), trace);
  } catch {
    return;
  }
}
