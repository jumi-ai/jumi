import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { agentInstance } from "./agent_instance.ts";
import type { TraceContext } from "./engine.ts";
import {
  encodeTracesRequest,
  type OtlpResource,
  type OtlpSpan,
  type OtlpValue,
  SPAN_KIND_INTERNAL,
  STATUS_CODE_ERROR,
  STATUS_CODE_OK,
} from "./otlp.ts";

export const PHOENIX_OTLP_TIMEOUT_MS = 15_000;
export const PHOENIX_OTLP_MAX_BYTES = 4 * 1024 * 1024;
export const PHOENIX_ATTR_CEILING_CHARS = 64 * 1024;
export const PUBLIC_PHOENIX_HOST = "phoenix.kirmanak.stream";
const KIND_ATTR = "openinference.span.kind";
const PROTECTED_ATTRS = new Set([
  KIND_ATTR,
  "openinference.project.name",
  "kind",
  "owner",
  "repo",
  "sha",
  "job_id",
  "session.id",
  "agent_instance",
  "tool.name",
  "tool.status",
  "llm.model_name",
  "llm.provider",
  "llm.token_count.prompt",
  "llm.token_count.completion",
  "service.name",
  "input.mime_type",
  "output.mime_type",
]);

export type { TraceContext, TraceKind } from "./engine.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let errors = 0;
let fetchImpl: FetchLike = globalThis.fetch;
let timeoutMs = PHOENIX_OTLP_TIMEOUT_MS;
let maxOtlpBytes = PHOENIX_OTLP_MAX_BYTES;
let attrCeilingChars = PHOENIX_ATTR_CEILING_CHARS;

export function resetTraceExportForTests(): void {
  errors = 0;
  fetchImpl = globalThis.fetch;
  timeoutMs = PHOENIX_OTLP_TIMEOUT_MS;
  maxOtlpBytes = PHOENIX_OTLP_MAX_BYTES;
  attrCeilingChars = PHOENIX_ATTR_CEILING_CHARS;
}

export function setTraceFetchForTests(fn: FetchLike | undefined): void {
  fetchImpl = fn ?? globalThis.fetch;
}

export function setTraceTimeoutForTests(ms: number): void {
  timeoutMs = ms;
}

export function setTraceLimitsForTests(opts?: { maxBytes?: number; attrCeiling?: number }): void {
  maxOtlpBytes = opts?.maxBytes ?? PHOENIX_OTLP_MAX_BYTES;
  attrCeilingChars = opts?.attrCeiling ?? PHOENIX_ATTR_CEILING_CHARS;
}

export function traceExportErrors(): number {
  return errors;
}

function phoenixEndpoint(): string {
  return process.env.PHOENIX_OTLP_ENDPOINT?.trim() || "";
}

function noteError(): void {
  errors += 1;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function parseObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function field(obj: Record<string, unknown> | undefined, ...path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    const rec = asRecord(current);
    if (!rec) return undefined;
    current = rec[key];
  }
  return current;
}

function jsonAttr(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value || undefined;
  try {
    const text = JSON.stringify(value);
    if (!text || text === "{}" || text === "[]") return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function payloadString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return jsonAttr(value);
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

function tableNames(db: Database): Set<string> {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tracesUrl(endpoint: string): URL | undefined {
  try {
    const trimmed = endpoint.replace(/\/+$/, "");
    const url = new URL(trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.hostname === PUBLIC_PHOENIX_HOST) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function filterAttrs(trace: TraceContext | undefined, agent: string): Record<string, OtlpValue> {
  const attrs: Record<string, OtlpValue> = { agent_instance: agent };
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

function spanTimes(
  startMs: number | undefined,
  endMs: number | undefined,
  fallbackStart: number,
  fallbackEnd: number
): { start: bigint; end: bigint } {
  const start = startMs && startMs > 0 ? startMs : fallbackStart;
  let end = endMs && endMs > 0 ? endMs : fallbackEnd;
  if (end < start) end = start;
  return { start: msToNano(start), end: msToNano(end) };
}

interface SessionRow {
  id: string;
  time_created: number | null;
  time_updated: number | null;
}

interface RawMessageRow {
  id: string;
  session_id: string;
  time_created: number | null;
  time_updated: number | null;
  data: unknown;
}

interface RawPartRow {
  id: string;
  message_id: string;
  time_created: number | null;
  time_updated: number | null;
  data: unknown;
}

interface ParsedPart {
  id: string;
  messageId: string;
  timeCreated: number | null;
  timeUpdated: number | null;
  type: string | undefined;
  tool: string | undefined;
  status: string | undefined;
  startMs: number | undefined;
  endMs: number | undefined;
  input: unknown;
  output: string | undefined;
  error: string | undefined;
  text: string | undefined;
  file: Record<string, unknown> | undefined;
}

interface ParsedMessage {
  id: string;
  timeCreated: number | null;
  timeUpdated: number | null;
  role: string;
  model: string | undefined;
  provider: string | undefined;
  tokensInput: number | undefined;
  tokensOutput: number | undefined;
  msgCreated: number | undefined;
  msgCompleted: number | undefined;
  error: string | undefined;
  parts: ParsedPart[];
}

function readTrace(
  db: Database
): { sessions: SessionRow[]; messages: RawMessageRow[]; parts: RawPartRow[] } | undefined {
  const tables = tableNames(db);
  if (!tables.has("session") || !tables.has("message") || !tables.has("part")) return undefined;
  const sessions = db
    .query("SELECT id, time_created, time_updated FROM session ORDER BY time_created, id")
    .all() as SessionRow[];
  const messages = db
    .query("SELECT id, session_id, time_created, time_updated, data FROM message ORDER BY time_created, id")
    .all() as RawMessageRow[];
  const parts = db
    .query("SELECT id, message_id, time_created, time_updated, data FROM part ORDER BY time_created, id")
    .all() as RawPartRow[];
  return { sessions, messages, parts };
}

function parsePart(row: RawPartRow): ParsedPart {
  const data = parseObject(row.data);
  const state = asRecord(field(data, "state"));
  const time = asRecord(field(state, "time"));
  const file =
    data && data.type === "file"
      ? {
          type: "file",
          mime: data.mime,
          filename: data.filename,
          url: data.url,
          path: field(data, "source", "path"),
        }
      : undefined;
  return {
    id: row.id,
    messageId: row.message_id,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
    type: asString(data?.type),
    tool: asString(data?.tool),
    status: asString(state?.status),
    startMs: asNumber(time?.start),
    endMs: asNumber(time?.end),
    input: state?.input,
    output: payloadString(state?.output),
    error: payloadString(state?.error),
    text: asString(data?.text),
    file,
  };
}

function parseMessage(row: RawMessageRow, parts: ParsedPart[]): ParsedMessage {
  const data = parseObject(row.data);
  const errObj = asRecord(data?.error);
  return {
    id: row.id,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
    role: asString(data?.role) ?? "",
    model: asString(data?.modelID) ?? asString(field(data, "model", "id")) ?? asString(field(data, "model", "modelID")),
    provider: asString(data?.providerID) ?? asString(field(data, "model", "providerID")),
    tokensInput: asNumber(field(data, "tokens", "input")),
    tokensOutput: asNumber(field(data, "tokens", "output")),
    msgCreated: asNumber(field(data, "time", "created")),
    msgCompleted: asNumber(field(data, "time", "completed")),
    error: payloadString(errObj?.message) ?? payloadString(data?.error),
    parts,
  };
}

function toolName(part: ParsedPart): string {
  const tool = part.tool ?? "tool";
  if (tool === "skill") {
    const skill = asString(field(asRecord(part.input), "name"));
    if (skill) return `skill:${skill}`;
  }
  return tool;
}

function initialUserPrompt(messages: ParsedMessage[]): string | undefined {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const texts: string[] = [];
    for (const part of msg.parts) {
      if (part.type === "text" && part.text) texts.push(part.text);
    }
    if (texts.length) return texts.join("\n");
  }
  return undefined;
}

function llmOutputValue(msg: ParsedMessage): string | undefined {
  const texts: string[] = [];
  for (const part of msg.parts) {
    if ((part.type === "text" || part.type === "reasoning") && part.text) texts.push(part.text);
  }
  if (texts.length) return texts.join("\n");
  const calls = msg.parts
    .filter((part) => part.type === "tool")
    .map((part) => ({ tool: part.tool, input: part.input }));
  if (calls.length) return jsonAttr(calls);
  return msg.error;
}

function setIo(
  attrs: Record<string, OtlpValue>,
  input: string | undefined,
  output: string | undefined,
  jsonInput: boolean
): void {
  if (input) {
    attrs["input.value"] = input;
    attrs["input.mime_type"] = jsonInput ? "application/json" : "text/plain";
  }
  if (output) {
    attrs["output.value"] = output;
    attrs["output.mime_type"] = output.startsWith("{") || output.startsWith("[") ? "application/json" : "text/plain";
  }
}

type ShrinkSlot = { kind: "attr"; span: OtlpSpan; key: string } | { kind: "status"; span: OtlpSpan };

function shrinkSlots(spans: OtlpSpan[]): ShrinkSlot[] {
  const slots: ShrinkSlot[] = [];
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) {
      if (PROTECTED_ATTRS.has(key)) continue;
      if (typeof span.attributes[key] === "string") slots.push({ kind: "attr", span, key });
    }
    if (span.statusMessage) slots.push({ kind: "status", span });
  }
  return slots;
}

function slotText(slot: ShrinkSlot): string {
  if (slot.kind === "status") return slot.span.statusMessage ?? "";
  const value = slot.span.attributes[slot.key];
  return typeof value === "string" ? value : "";
}

function writeSlot(slot: ShrinkSlot, text: string): void {
  if (slot.kind === "status") {
    slot.span.statusMessage = text || undefined;
    return;
  }
  if (!text) delete slot.span.attributes[slot.key];
  else slot.span.attributes[slot.key] = text;
}

function encodeWithinLimit(resource: OtlpResource, spans: OtlpSpan[], scopeName?: string): Uint8Array | undefined {
  let body = encodeTracesRequest(resource, spans, scopeName);
  if (body.byteLength <= maxOtlpBytes) return body;

  for (const slot of shrinkSlots(spans)) {
    const text = slotText(slot);
    if (text.length > attrCeilingChars) writeSlot(slot, text.slice(0, attrCeilingChars));
  }
  body = encodeTracesRequest(resource, spans, scopeName);
  if (body.byteLength <= maxOtlpBytes) return body;

  while (true) {
    body = encodeTracesRequest(resource, spans, scopeName);
    if (body.byteLength <= maxOtlpBytes) return body;
    const overflow = body.byteLength - maxOtlpBytes;
    let best: ShrinkSlot | undefined;
    let bestLen = 0;
    for (const slot of shrinkSlots(spans)) {
      const len = slotText(slot).length;
      if (len > bestLen) {
        best = slot;
        bestLen = len;
      }
    }
    if (!best || bestLen <= 0) return undefined;
    const cut = Math.max(1, overflow, Math.ceil(bestLen / 2));
    writeSlot(best, slotText(best).slice(0, Math.max(0, bestLen - cut)));
  }
}

function buildSpans(
  trace: TraceContext | undefined,
  rows: { sessions: SessionRow[]; messages: RawMessageRow[]; parts: RawPartRow[] }
): OtlpSpan[] {
  const shared = filterAttrs(trace, agentInstance());
  const now = Date.now();
  const sessionStart = asNumber(rows.sessions[0]?.time_created) ?? now;
  const sessionEnd =
    asNumber(rows.sessions[rows.sessions.length - 1]?.time_updated) ??
    asNumber(rows.sessions[rows.sessions.length - 1]?.time_created) ??
    now;
  const rootTimes = spanTimes(sessionStart, sessionEnd, sessionStart, sessionEnd);
  const traceId = randomId(16);
  const rootId = randomId(8);
  const rootName = trace ? `jumi ${trace.kind}` : "jumi opencode";

  const partsByMessage = new Map<string, ParsedPart[]>();
  const parsedParts: ParsedPart[] = [];
  for (const row of rows.parts) {
    const part = parsePart(row);
    parsedParts.push(part);
    const list = partsByMessage.get(part.messageId);
    if (list) list.push(part);
    else partsByMessage.set(part.messageId, [part]);
  }
  const messages = rows.messages.map((row) => parseMessage(row, partsByMessage.get(row.id) ?? []));

  const rootAttrs: Record<string, OtlpValue> = { ...shared, [KIND_ATTR]: "AGENT" };
  setIo(rootAttrs, initialUserPrompt(messages), undefined, false);
  const spans: OtlpSpan[] = [
    {
      traceId,
      spanId: rootId,
      name: rootName,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: rootTimes.start,
      endTimeUnixNano: rootTimes.end,
      attributes: rootAttrs,
      statusCode: STATUS_CODE_OK,
    },
  ];

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (!message.model && !message.provider) continue;
    const start = message.msgCreated ?? asNumber(message.timeCreated) ?? sessionStart;
    const end = message.msgCompleted ?? asNumber(message.timeUpdated) ?? start;
    const times = spanTimes(start, end, sessionStart, sessionEnd);
    const attrs: Record<string, OtlpValue> = { ...shared, [KIND_ATTR]: "LLM" };
    if (message.model) attrs["llm.model_name"] = message.model;
    if (message.provider) attrs["llm.provider"] = message.provider;
    if (message.tokensInput != null) attrs["llm.token_count.prompt"] = Math.trunc(message.tokensInput);
    if (message.tokensOutput != null) attrs["llm.token_count.completion"] = Math.trunc(message.tokensOutput);
    setIo(attrs, undefined, llmOutputValue(message), true);
    const err = message.error;
    spans.push({
      traceId,
      spanId: randomId(8),
      parentSpanId: rootId,
      name: message.model ?? "llm",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: times.start,
      endTimeUnixNano: times.end,
      attributes: attrs,
      statusCode: err ? STATUS_CODE_ERROR : STATUS_CODE_OK,
      statusMessage: err,
    });
  }

  for (const part of parsedParts) {
    if (part.type !== "tool") continue;
    const name = toolName(part);
    const status = part.status ?? "unknown";
    const start = part.startMs ?? asNumber(part.timeCreated) ?? sessionStart;
    const end = part.endMs ?? asNumber(part.timeUpdated) ?? start;
    const times = spanTimes(start, end, sessionStart, sessionEnd);
    const attrs: Record<string, OtlpValue> = {
      ...shared,
      [KIND_ATTR]: "TOOL",
      "tool.name": name,
      "tool.status": status,
    };
    if (part.startMs != null && part.endMs != null)
      attrs["tool.duration_ms"] = Math.max(0, Math.trunc(part.endMs - part.startMs));
    const params = jsonAttr(part.input);
    if (params) attrs["tool.parameters"] = params;
    const output = part.output ?? part.error;
    setIo(attrs, params, output, true);
    const err = part.error;
    const failed = status === "error" || Boolean(err);
    spans.push({
      traceId,
      spanId: randomId(8),
      parentSpanId: rootId,
      name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: times.start,
      endTimeUnixNano: times.end,
      attributes: attrs,
      statusCode: failed ? STATUS_CODE_ERROR : STATUS_CODE_OK,
      statusMessage: err,
    });
  }

  return spans;
}

function buildTraceBody(dbPath: string, trace?: TraceContext): { body?: Uint8Array; tooLarge?: boolean } {
  if (!existsSync(dbPath)) return {};
  const db = new Database(dbPath);
  try {
    const rows = readTrace(db);
    if (!rows) return {};
    const agent = agentInstance();
    const spans = buildSpans(trace, rows);
    const body = encodeWithinLimit(
      {
        attributes: {
          "service.name": agent,
          "openinference.project.name": agent,
          ...filterAttrs(trace, agent),
        },
      },
      spans
    );
    if (!body) return { tooLarge: true };
    return { body };
  } finally {
    db.close();
  }
}

export function buildOpenCodeTraceRequest(dbPath: string, trace?: TraceContext): Uint8Array | undefined {
  return buildTraceBody(dbPath, trace).body;
}

async function postTraces(body: Uint8Array): Promise<void> {
  const endpoint = phoenixEndpoint();
  if (!endpoint) return;
  const url = tracesUrl(endpoint);
  if (!url) {
    noteError();
    return;
  }
  const agent = agentInstance();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        "phoenix-project": agent,
      },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      signal: ac.signal,
    });
    if (!response.ok) noteError();
  } catch {
    noteError();
  } finally {
    clearTimeout(timer);
  }
}

export async function exportOpenCodeTrace(opts: { dbPath: string; trace?: TraceContext }): Promise<void> {
  const endpoint = phoenixEndpoint();
  if (!endpoint) return;
  if (!tracesUrl(endpoint)) {
    noteError();
    return;
  }
  let result: { body?: Uint8Array; tooLarge?: boolean };
  try {
    result = buildTraceBody(opts.dbPath, opts.trace);
  } catch {
    noteError();
    return;
  }
  if (result.tooLarge) {
    noteError();
    return;
  }
  if (!result.body) return;
  await postTraces(result.body);
}

/**
 * Parent-built OTLP spans for a runner that leaves no session sqlite.
 * Fail-open: no endpoint, a public Phoenix hostname, a body still over the cap
 * after its attributes are shrunk, or a POST that throws or returns non-2xx
 * records an error and never throws.
 */
export async function exportOtlpSpans(spans: OtlpSpan[], trace?: TraceContext): Promise<void> {
  if (spans.length === 0) return;
  try {
    const agent = agentInstance();
    const body = encodeWithinLimit(
      {
        attributes: {
          "service.name": agent,
          "openinference.project.name": agent,
          ...filterAttrs(trace, agent),
        },
      },
      spans,
      "jumi-codex"
    );
    if (!body) {
      noteError();
      return;
    }
    await postTraces(body);
  } catch {
    noteError();
  }
}
