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
  const sessionTable = tables.has("session_v2") ? "session_v2" : tables.has("session") ? "session" : null;
  if (!sessionTable) {
    console.warn("OpenCode trace export: unrecognized schema (no session or session_v2 table)");
    return undefined;
  }
  let sessions: SessionRow[];
  try {
    sessions = db
      .query(`SELECT id, time_created, time_updated FROM ${sessionTable} ORDER BY time_created, id`)
      .all() as SessionRow[];
  } catch {
    console.warn("OpenCode trace export: unrecognized schema (session table shape)");
    return undefined;
  }

  if (tables.has("message") && tables.has("part")) {
    try {
      const messages = db
        .query("SELECT id, session_id, time_created, time_updated, data FROM message ORDER BY time_created, id")
        .all() as RawMessageRow[];
      const parts = db
        .query("SELECT id, message_id, time_created, time_updated, data FROM part ORDER BY time_created, id")
        .all() as RawPartRow[];
      return { sessions, messages, parts };
    } catch {
      console.warn("OpenCode trace export: unrecognized schema (message/part table shape)");
      return undefined;
    }
  }

  if (tables.has("session_message")) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = db.query("SELECT * FROM session_message").all() as Array<Record<string, unknown>>;
    } catch {
      console.warn("OpenCode trace export: unrecognized schema (session_message table shape)");
      return undefined;
    }
    rows.sort((a, b) => {
      const seqA = asNumber(a.seq);
      const seqB = asNumber(b.seq);
      if (seqA != null && seqB != null) return seqA - seqB;
      const tcA = asNumber(a.time_created);
      const tcB = asNumber(b.time_created);
      if (tcA != null && tcB != null) return tcA - tcB;
      return 0;
    });

    const messages: RawMessageRow[] = [];
    const parts: RawPartRow[] = [];
    let currentMessageId: string | undefined;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const data = parseObject(row.data);
      const rowType = asString(row.type);
      const dataRole = asString(data?.role);
      const dataType = asString(data?.type);

      const isPart =
        rowType === "part" ||
        rowType === "tool" ||
        rowType === "text" ||
        rowType === "reasoning" ||
        rowType === "file" ||
        rowType === "shell" ||
        rowType === "bash" ||
        dataType === "tool" ||
        dataType === "text" ||
        dataType === "reasoning" ||
        dataType === "file" ||
        data?.tool != null;

      if (!isPart && (rowType === "message" || dataRole != null || rowType === "user" || rowType === "assistant")) {
        const id = asString(row.id) ?? asString(data?.id) ?? `msg-${row.seq ?? i + 1}`;
        const sessionId =
          asString(row.session_id) ??
          asString(data?.sessionID) ??
          asString(data?.sessionId) ??
          sessions[0]?.id ??
          "ses1";
        const timeCreated =
          asNumber(row.time_created) ?? asNumber(field(data, "time", "created")) ?? sessions[0]?.time_created ?? null;
        const timeUpdated = asNumber(row.time_updated) ?? asNumber(field(data, "time", "completed")) ?? timeCreated;

        messages.push({
          id,
          session_id: sessionId,
          time_created: timeCreated,
          time_updated: timeUpdated,
          data: row.data,
        });
        currentMessageId = id;

        if (Array.isArray(data?.parts)) {
          for (let pIdx = 0; pIdx < data.parts.length; pIdx++) {
            const p = data.parts[pIdx];
            if (!p || typeof p !== "object") continue;
            parts.push({
              id: asString(p.id) ?? `part-${id}-${pIdx + 1}`,
              message_id: id,
              time_created: asNumber(field(p, "state", "time", "start")) ?? timeCreated,
              time_updated: asNumber(field(p, "state", "time", "end")) ?? timeUpdated,
              data: typeof p === "string" ? p : JSON.stringify(p),
            });
          }
        }
      } else {
        const id = asString(row.id) ?? asString(data?.id) ?? `part-${row.seq ?? i + 1}`;
        const messageId =
          asString(row.message_id) ??
          asString(data?.messageID) ??
          asString(data?.message_id) ??
          currentMessageId ??
          messages[messages.length - 1]?.id ??
          "msg1";
        const timeCreated =
          asNumber(row.time_created) ??
          asNumber(field(data, "state", "time", "start")) ??
          asNumber(field(data, "time", "start")) ??
          null;
        const timeUpdated =
          asNumber(row.time_updated) ??
          asNumber(field(data, "state", "time", "end")) ??
          asNumber(field(data, "time", "end")) ??
          timeCreated;

        parts.push({
          id,
          message_id: messageId,
          time_created: timeCreated,
          time_updated: timeUpdated,
          data: row.data,
        });
      }
    }
    return { sessions, messages, parts };
  }

  console.warn("OpenCode trace export: unrecognized schema (no message/part or session_message table)");
  return undefined;
}

function parsePart(row: RawPartRow): ParsedPart {
  const data = parseObject(row.data);
  const state = asRecord(field(data, "state"));
  const time = asRecord(field(state, "time")) ?? asRecord(field(data, "time"));
  const tool = asString(data?.tool) ?? asString(data?.name);
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
    type: asString(data?.type) ?? (tool ? "tool" : undefined),
    tool,
    status: asString(state?.status) ?? asString(data?.status),
    startMs: asNumber(time?.start),
    endMs: asNumber(time?.end),
    input: state?.input ?? data?.input,
    output: payloadString(state?.output) ?? payloadString(data?.output),
    error: payloadString(state?.error) ?? payloadString(data?.error),
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

export function buildOpenCodeSpansFromEvents(events: unknown[] | string, trace?: TraceContext): OtlpSpan[] {
  let list: unknown[];
  if (typeof events === "string") {
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
    return [];
  }

  const now = Date.now();
  let startMs = now;
  let endMs = now;
  let userPrompt: string | undefined;
  let assistantModel: string | undefined;
  let assistantProvider: string | undefined;
  let tokensInput: number | undefined;
  let tokensOutput: number | undefined;
  let assistantError: string | undefined;
  const assistantTexts: string[] = [];
  const toolParts: ParsedPart[] = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    const ev = item as Record<string, unknown>;
    const part = (ev.part && typeof ev.part === "object" ? ev.part : ev) as Record<string, unknown>;
    const time = asNumber(ev.time) ?? asNumber(part.time) ?? asNumber(field(part, "state", "time", "start"));
    if (time != null && time > 0) {
      if (startMs === now || time < startMs) startMs = time;
      if (time > endMs) endMs = time;
    }

    if (ev.type === "step_start") {
      if (typeof ev.model === "string") assistantModel = ev.model;
      if (typeof part.model === "string") assistantModel = part.model;
      if (typeof ev.provider === "string") assistantProvider = ev.provider;
    } else if (ev.type === "text" || part.type === "text") {
      const text = asString(part.text) ?? asString(ev.text);
      if (text) assistantTexts.push(text);
    } else if (ev.type === "tool_use" || ev.type === "tool" || part.type === "tool") {
      const state = asRecord(field(part, "state"));
      const toolTime = asRecord(field(state, "time")) ?? asRecord(field(part, "time"));
      const tool = asString(part.tool) ?? asString(part.name) ?? asString(ev.tool) ?? asString(ev.name);
      toolParts.push({
        id: asString(ev.id) ?? asString(part.id) ?? `tool-${i}`,
        messageId: "msg-assistant",
        timeCreated: time ?? null,
        timeUpdated: asNumber(toolTime?.end) ?? time ?? null,
        type: "tool",
        tool,
        status: asString(state?.status) ?? asString(part.status) ?? "completed",
        startMs: asNumber(toolTime?.start) ?? time,
        endMs: asNumber(toolTime?.end) ?? time,
        input: state?.input ?? part.input ?? ev.input,
        output: payloadString(state?.output) ?? payloadString(part.output) ?? payloadString(ev.output),
        error: payloadString(state?.error) ?? payloadString(part.error) ?? payloadString(ev.error),
        text: undefined,
        file: undefined,
      });
    } else if (ev.type === "step_finish") {
      const tokens = (part.tokens ?? ev.tokens) as Record<string, unknown> | undefined;
      if (tokens) {
        tokensInput = asNumber(tokens.input);
        tokensOutput = asNumber(tokens.output);
      }
      if (part.error || ev.error) {
        assistantError = payloadString(part.error) ?? payloadString(ev.error);
      }
    } else if (ev.role === "user" || ev.type === "user") {
      userPrompt = asString(ev.text) ?? asString(ev.content);
    }
  }

  const sessions: SessionRow[] = [{ id: "ses1", time_created: startMs, time_updated: endMs }];
  const messages: RawMessageRow[] = [];
  if (userPrompt) {
    messages.push({
      id: "msg-user",
      session_id: "ses1",
      time_created: startMs,
      time_updated: startMs,
      data: JSON.stringify({ role: "user", time: { created: startMs } }),
    });
  }
  messages.push({
    id: "msg-assistant",
    session_id: "ses1",
    time_created: startMs,
    time_updated: endMs,
    data: JSON.stringify({
      role: "assistant",
      modelID: assistantModel,
      providerID: assistantProvider,
      tokens: { input: tokensInput ?? 0, output: tokensOutput ?? 0 },
      time: { created: startMs, completed: endMs },
      error: assistantError ? { message: assistantError } : undefined,
    }),
  });

  const parts: RawPartRow[] = [];
  if (userPrompt) {
    parts.push({
      id: "part-user",
      message_id: "msg-user",
      time_created: startMs,
      time_updated: startMs,
      data: JSON.stringify({ type: "text", text: userPrompt }),
    });
  }
  for (const text of assistantTexts) {
    parts.push({
      id: `part-text-${parts.length + 1}`,
      message_id: "msg-assistant",
      time_created: startMs,
      time_updated: startMs,
      data: JSON.stringify({ type: "text", text }),
    });
  }
  for (const toolPart of toolParts) {
    parts.push({
      id: toolPart.id,
      message_id: "msg-assistant",
      time_created: toolPart.timeCreated,
      time_updated: toolPart.timeUpdated,
      data: JSON.stringify({
        type: "tool",
        tool: toolPart.tool,
        state: {
          status: toolPart.status,
          input: toolPart.input,
          output: toolPart.output,
          error: toolPart.error,
          time: { start: toolPart.startMs, end: toolPart.endMs },
        },
      }),
    });
  }

  return buildSpans(trace, { sessions, messages, parts });
}

export function buildOpenCodeTraceRequest(source: string | unknown[], trace?: TraceContext): Uint8Array | undefined {
  if (typeof source === "string") {
    return buildTraceBody(source, trace).body;
  }
  if (Array.isArray(source)) {
    const agent = agentInstance();
    const spans = buildOpenCodeSpansFromEvents(source, trace);
    return encodeWithinLimit(
      {
        attributes: {
          "service.name": agent,
          "openinference.project.name": agent,
          ...filterAttrs(trace, agent),
        },
      },
      spans
    );
  }
  return undefined;
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

export async function exportOpenCodeTrace(opts: {
  dbPath?: string;
  events?: unknown[];
  trace?: TraceContext;
}): Promise<void> {
  const endpoint = phoenixEndpoint();
  if (!endpoint) return;
  if (!tracesUrl(endpoint)) {
    noteError();
    return;
  }
  let result: { body?: Uint8Array; tooLarge?: boolean };
  try {
    if (opts.events) {
      const spans = buildOpenCodeSpansFromEvents(opts.events, opts.trace);
      const agent = agentInstance();
      const body = encodeWithinLimit(
        {
          attributes: {
            "service.name": agent,
            "openinference.project.name": agent,
            ...filterAttrs(opts.trace, agent),
          },
        },
        spans
      );
      if (!body) result = { tooLarge: true };
      else result = { body };
    } else if (opts.dbPath) {
      result = buildTraceBody(opts.dbPath, opts.trace);
    } else {
      return;
    }
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
