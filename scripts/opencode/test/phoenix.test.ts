import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenCodeTraceRequest,
  exportOpenCodeTrace,
  PHOENIX_OTLP_TIMEOUT_MS,
  PUBLIC_PHOENIX_HOST,
  resetTraceExportForTests,
  setTraceFetchForTests,
  setTraceLimitsForTests,
  setTraceTimeoutForTests,
  traceExportErrors,
} from "../src/phoenix.ts";
import { renderTokenMetrics } from "../src/token_metrics.ts";

const originalEndpoint = process.env.PHOENIX_OTLP_ENDPOINT;
const originalAgent = process.env.AGENT_INSTANCE;

afterEach(() => {
  resetTraceExportForTests();
  if (originalEndpoint === undefined) delete process.env.PHOENIX_OTLP_ENDPOINT;
  else process.env.PHOENIX_OTLP_ENDPOINT = originalEndpoint;
  if (originalAgent === undefined) delete process.env.AGENT_INSTANCE;
  else process.env.AGENT_INSTANCE = originalAgent;
});

interface PbField {
  id: number;
  wire: number;
  bytes?: Uint8Array;
  varint?: bigint;
}

function decodeVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, next: i };
}

function decodeFields(buf: Uint8Array): PbField[] {
  const fields: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    const tag = decodeVarint(buf, i);
    i = tag.next;
    const id = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const v = decodeVarint(buf, i);
      fields.push({ id, wire, varint: v.value });
      i = v.next;
    } else if (wire === 1) {
      i += 8;
      fields.push({ id, wire });
    } else if (wire === 2) {
      const len = decodeVarint(buf, i);
      i = len.next;
      const n = Number(len.value);
      fields.push({ id, wire, bytes: buf.subarray(i, i + n) });
      i += n;
    } else {
      break;
    }
  }
  return fields;
}

function utf8(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function anyValue(fields: PbField[]): string | number | boolean | undefined {
  const str = fields.find((f) => f.id === 1);
  if (str?.bytes) return utf8(str.bytes);
  const bool = fields.find((f) => f.id === 2);
  if (bool?.varint != null) return bool.varint !== 0n;
  const int = fields.find((f) => f.id === 3);
  if (int?.varint != null) return Number(int.varint);
  return undefined;
}

function keyValues(fields: PbField[], fieldId: number): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of fields.filter((f) => f.id === fieldId && f.bytes)) {
    const kv = decodeFields(field.bytes!);
    const key = utf8(kv.find((f) => f.id === 1)?.bytes);
    const valueMsg = kv.find((f) => f.id === 2)?.bytes;
    if (!key || !valueMsg) continue;
    const value = anyValue(decodeFields(valueMsg));
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function decodeSpans(buf: Uint8Array): Array<{ name: string; attrs: Record<string, string | number | boolean> }> {
  const request = decodeFields(buf);
  const resourceSpans = request.find((f) => f.id === 1)?.bytes;
  if (!resourceSpans) return [];
  const rs = decodeFields(resourceSpans);
  const scopeSpans = rs.find((f) => f.id === 2)?.bytes;
  if (!scopeSpans) return [];
  const ss = decodeFields(scopeSpans);
  return ss
    .filter((f) => f.id === 2 && f.bytes)
    .map((f) => {
      const span = decodeFields(f.bytes!);
      return {
        name: utf8(span.find((s) => s.id === 5)?.bytes),
        attrs: keyValues(span, 9),
      };
    });
}

function decodeResourceAttrs(buf: Uint8Array): Record<string, string | number | boolean> {
  const request = decodeFields(buf);
  const resourceSpans = request.find((f) => f.id === 1)?.bytes;
  if (!resourceSpans) return {};
  const resource = decodeFields(resourceSpans).find((f) => f.id === 1)?.bytes;
  if (!resource) return {};
  return keyValues(decodeFields(resource), 1);
}

/** Writes the session_v2/session_message rows OpenCode leaves behind. */
function writeTraceDb(
  path: string,
  opts: {
    tools?: Array<{
      tool: string;
      status: string;
      command?: string;
      path?: string;
      name?: string;
      output?: string;
      error?: string;
      start?: number;
      end?: number;
      extraInput?: Record<string, unknown>;
    }>;
    assistant?: { modelID?: string; providerID?: string; input?: number; output?: number; error?: string };
    userText?: string;
    assistantText?: string;
    extraRows?: Array<{ id: string; type: string; data: string }>;
    extraAssistants?: Array<{
      id: string;
      text?: string;
      modelID?: string;
      providerID?: string;
      input?: number;
      output?: number;
      timeCreated?: number;
      timeUpdated?: number;
    }>;
  } = {}
): void {
  const db = new Database(path);
  db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER)");
  db.run(
    "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)"
  );
  db.run("INSERT INTO session_v2 VALUES (?, ?, ?)", ["ses1", 1_000, 5_000]);
  let seq = 0;
  const insert = (id: string, type: string, created: number, updated: number, data: string) => {
    seq += 1;
    db.run("INSERT INTO session_message VALUES (?, 'ses1', ?, ?, ?, ?, ?)", [id, type, seq, created, updated, data]);
  };

  if (opts.userText) {
    insert("msg-user", "user", 900, 900, JSON.stringify({ time: { created: 900 }, text: opts.userText, files: [] }));
  }
  const assistant = opts.assistant ?? { modelID: "grok-4.6", providerID: "xai", input: 10, output: 3 };
  const content: unknown[] = opts.assistantText ? [{ type: "text", text: opts.assistantText }] : [];
  (opts.tools ?? []).forEach((tool, index) => {
    content.push({
      type: "tool",
      id: `call${index + 1}`,
      name: tool.tool,
      state: {
        status: tool.status,
        input: {
          ...(tool.command ? { command: tool.command } : {}),
          ...(tool.path ? { filePath: tool.path } : {}),
          ...(tool.name ? { name: tool.name } : {}),
          ...tool.extraInput,
        },
        content: tool.output ? [{ type: "text", text: tool.output }] : [],
        ...(tool.error ? { error: { type: "tool.execution", message: tool.error } } : {}),
      },
      time: { created: tool.start ?? 1_100, ran: tool.start ?? 1_100, completed: tool.end ?? 1_200 },
    });
  });
  insert(
    "msg1",
    "assistant",
    1_000,
    2_000,
    JSON.stringify({
      time: { created: 1_000, completed: 2_000 },
      model: { id: assistant.modelID, providerID: assistant.providerID },
      content,
      tokens: { input: assistant.input ?? 0, output: assistant.output ?? 0 },
      ...(assistant.error ? { error: { type: "provider", message: assistant.error } } : {}),
    })
  );
  for (const extra of opts.extraAssistants ?? []) {
    const created = extra.timeCreated ?? 3_000;
    const completed = extra.timeUpdated ?? 4_000;
    insert(
      extra.id,
      "assistant",
      created,
      completed,
      JSON.stringify({
        time: { created, completed },
        model: { id: extra.modelID ?? "grok-4.6", providerID: extra.providerID ?? "xai" },
        content: extra.text ? [{ type: "text", text: extra.text }] : [],
        tokens: { input: extra.input ?? 20, output: extra.output ?? 4 },
      })
    );
  }
  for (const extra of opts.extraRows ?? []) insert(extra.id, extra.type, 1_300, 1_300, extra.data);
  db.close();
}

describe("buildOpenCodeTraceRequest", () => {
  test("builds an AGENT root with full TOOL and LLM payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeTraceDb(dbPath, {
        userText: "review this PR please",
        assistantText: "looks fine after grep",
        tools: [
          {
            tool: "bash",
            status: "completed",
            command: "ls -la /work",
            output: "HUGE_STDOUT_BODY_MUST_APPEAR",
            start: 1_100,
            end: 1_250,
          },
          {
            tool: "read",
            status: "completed",
            path: "src/git.ts",
            output: "FILE_BODY_MUST_APPEAR",
          },
          {
            tool: "skill",
            status: "error",
            name: "gitops-apply-review",
            error: "denied",
          },
          {
            tool: "mystery",
            status: "completed",
            extraInput: { blob: "do-not-guess-this-body" },
            output: "secret-output",
          },
          {
            tool: "webfetch",
            status: "completed",
            extraInput: { url: "https://example.com/opencode" },
            output: "fetched-body",
          },
        ],
      });
      const body = buildOpenCodeTraceRequest(dbPath, {
        kind: "review",
        owner: "personal",
        repo: "jumi",
        sha: "abc123",
        jobId: "42",
      });
      expect(body).toBeDefined();
      const text = new TextDecoder().decode(body);
      expect(text).toContain("HUGE_STDOUT_BODY_MUST_APPEAR");
      expect(text).toContain("FILE_BODY_MUST_APPEAR");
      expect(text).toContain("do-not-guess-this-body");
      expect(text).toContain("secret-output");
      expect(text).toContain("https://example.com/opencode");
      expect(text).toContain("review this PR please");
      expect(text).toContain("looks fine after grep");
      const resource = decodeResourceAttrs(body!);
      expect(resource["openinference.project.name"]).toBe("jumi");
      expect(resource.kind).toBe("review");
      expect(resource.owner).toBe("personal");
      expect(resource.repo).toBe("jumi");
      expect(resource.sha).toBe("abc123");
      expect(resource.job_id).toBe("42");
      expect(resource["session.id"]).toBe("42");
      expect(resource.agent_instance).toBe("jumi");
      const spans = decodeSpans(body!);
      expect(spans[0]?.name).toBe("jumi review");
      expect(spans[0]?.attrs["openinference.span.kind"]).toBe("AGENT");
      expect(spans[0]?.attrs["input.value"]).toBe("review this PR please");
      expect(spans[0]?.attrs["input.mime_type"]).toBe("text/plain");
      expect(spans[0]?.attrs.job_id).toBe("42");
      expect(spans[0]?.attrs["session.id"]).toBe("42");
      const llm = spans.find((s) => s.attrs["openinference.span.kind"] === "LLM");
      expect(llm?.attrs["llm.model_name"]).toBe("grok-4.6");
      expect(llm?.attrs["llm.provider"]).toBe("xai");
      expect(llm?.attrs["llm.token_count.prompt"]).toBe(10);
      expect(llm?.attrs["input.value"]).toBeUndefined();
      expect(llm?.attrs["llm.input_messages"]).toBeUndefined();
      expect(llm?.attrs["output.value"]).toBe("looks fine after grep");
      const bash = spans.find((s) => s.name === "bash");
      expect(bash?.attrs["openinference.span.kind"]).toBe("TOOL");
      expect(bash?.attrs["tool.status"]).toBe("completed");
      expect(bash?.attrs["tool.duration_ms"]).toBe(150);
      expect(String(bash?.attrs["tool.parameters"])).toContain("ls -la /work");
      expect(bash?.attrs["output.value"]).toBe("HUGE_STDOUT_BODY_MUST_APPEAR");
      const skill = spans.find((s) => s.name === "skill:gitops-apply-review");
      expect(skill?.attrs["tool.status"]).toBe("error");
      expect(skill?.attrs["output.value"]).toBe("denied");
      const mystery = spans.find((s) => s.name === "mystery");
      expect(mystery?.attrs["tool.status"]).toBe("completed");
      expect(String(mystery?.attrs["tool.parameters"])).toContain("do-not-guess-this-body");
      expect(mystery?.attrs["output.value"]).toBe("secret-output");
      const fetch = spans.find((s) => s.name === "webfetch");
      expect(String(fetch?.attrs["input.value"])).toContain("https://example.com/opencode");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps long commands and skips missing tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      writeTraceDb(dbPath, {
        tools: [{ tool: "bash", status: "completed", command: "x".repeat(400) }],
      });
      const body = buildOpenCodeTraceRequest(dbPath, { kind: "implement", owner: "a", repo: "b" });
      const bash = decodeSpans(body!).find((s) => s.name === "bash");
      const params = JSON.parse(String(bash?.attrs["tool.parameters"])) as { command: string };
      expect(params.command.length).toBe(400);
      expect(bash?.attrs.job_id).toBeUndefined();
      expect(bash?.attrs["session.id"]).toBeUndefined();

      const sessionOnly = join(dir, "session-only.db");
      const db = new Database(sessionOnly);
      db.run("CREATE TABLE session (id TEXT)");
      db.close();
      expect(buildOpenCodeTraceRequest(sessionOnly)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exports every tool span and keeps unreadable rows off the job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeTraceDb(dbPath, {
        tools: Array.from({ length: 300 }, (_, i) => ({
          tool: "bash",
          status: "completed",
          command: `echo ${i}`,
        })),
        extraRows: [{ id: "msg-bad", type: "assistant", data: "not-json{{{{" }],
      });
      const body = buildOpenCodeTraceRequest(dbPath, { kind: "review", owner: "a", repo: "b" });
      const spans = decodeSpans(body!);
      expect(spans.filter((s) => s.attrs["openinference.span.kind"] === "TOOL")).toHaveLength(300);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shrinks largest string attributes to fit the encoded cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      setTraceLimitsForTests({ maxBytes: 2_500, attrCeiling: 400 });
      writeTraceDb(dbPath, {
        tools: [
          { tool: "bash", status: "completed", command: "pwd", output: "B".repeat(2_000) },
          { tool: "read", status: "completed", path: "src/git.ts", output: "R".repeat(800) },
        ],
      });
      const body = buildOpenCodeTraceRequest(dbPath, {
        kind: "review",
        owner: "personal",
        repo: "jumi",
        sha: "abc123",
        jobId: "42",
      });
      expect(body).toBeDefined();
      expect(body!.byteLength).toBeLessThanOrEqual(2_500);
      const spans = decodeSpans(body!);
      const bash = spans.find((s) => s.name === "bash");
      const read = spans.find((s) => s.name === "read");
      const llm = spans.find((s) => s.attrs["openinference.span.kind"] === "LLM");
      expect(bash?.attrs["tool.status"]).toBe("completed");
      expect(read?.attrs["tool.name"]).toBe("read");
      expect(llm?.attrs["llm.token_count.prompt"]).toBe(10);
      expect(spans[0]?.attrs.job_id).toBe("42");
      expect(spans[0]?.attrs["session.id"]).toBe("42");
      expect(String(bash?.attrs["output.value"] ?? "").length).toBeLessThan(2_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("puts the initial user prompt on AGENT once and omits LLM conversation reprints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeTraceDb(dbPath, {
        userText: "review this PR please",
        assistantText: "first turn output",
        extraAssistants: [{ id: "msg2", text: "second turn output", input: 40, output: 5 }],
      });
      const body = buildOpenCodeTraceRequest(dbPath, { kind: "review", owner: "personal", repo: "jumi" });
      const spans = decodeSpans(body!);
      const agent = spans.find((s) => s.attrs["openinference.span.kind"] === "AGENT");
      const llms = spans.filter((s) => s.attrs["openinference.span.kind"] === "LLM");
      expect(agent?.attrs["input.value"]).toBe("review this PR please");
      expect(llms).toHaveLength(2);
      expect(llms.map((s) => s.attrs["output.value"])).toEqual(["first turn output", "second turn output"]);
      for (const llm of llms) {
        expect(llm.attrs["input.value"]).toBeUndefined();
        expect(llm.attrs["llm.input_messages"]).toBeUndefined();
        expect(llm.attrs["llm.model_name"]).toBe("grok-4.6");
        expect(llm.attrs["llm.provider"]).toBe("xai");
        expect(String(llm.attrs["output.value"])).not.toContain("review this PR please");
      }
      const encoded = new TextDecoder().decode(body);
      expect(encoded.split("review this PR please")).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads the session_message rows OpenCode actually writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-v2-real-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      // Shapes copied from a session DB written by opencode 2.2.4: no `role`,
      // the row `type` is the role, and the content is inline.
      const db = new Database(dbPath);
      db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER)");
      db.run(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.run("INSERT INTO session_v2 VALUES ('ses1', 1000, 5000)");
      const row = (id: string, type: string, seq: number, data: unknown) =>
        db.run("INSERT INTO session_message VALUES (?, 'ses1', ?, ?, 1000, 2000, ?)", [
          id,
          type,
          seq,
          JSON.stringify(data),
        ]);
      row("msg_user", "user", 4, { time: { created: 1000 }, text: "REAL_USER_PROMPT", files: [] });
      row("msg_a1", "assistant", 5, {
        time: { created: 1100, completed: 1900 },
        agent: "build",
        model: { id: "gpt-5.5", providerID: "openai", variant: "default" },
        content: [
          { type: "reasoning", text: "REAL_REASONING" },
          {
            type: "tool",
            id: "call_1",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "pwd" },
              content: [{ type: "text", text: "REAL_TOOL_OUTPUT" }],
              metadata: { exit: 0 },
            },
            time: { created: 1200, ran: 1300, completed: 1500 },
          },
          {
            type: "tool",
            id: "call_2",
            name: "webfetch",
            state: { status: "error", input: {}, error: { type: "tool.execution", message: "REAL_TOOL_ERROR" } },
            time: { created: 1600 },
          },
        ],
        finish: "tool-calls",
        tokens: { input: 111, output: 22, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      row("msg_a2", "assistant", 13, {
        time: { created: 2000, completed: 2100 },
        model: { id: "gpt-5.5", providerID: "openai" },
        content: [{ type: "text", text: "REAL_ASSISTANT_TEXT" }],
        tokens: { input: 5, output: 1 },
      });
      row("msg_idle", "idle", 18, { time: { created: 2200 }, outcome: "succeeded" });
      db.close();

      const body = buildOpenCodeTraceRequest(dbPath, { kind: "review", owner: "o", repo: "r" });
      const text = new TextDecoder().decode(body);
      expect(text).toContain("REAL_USER_PROMPT");
      expect(text).toContain("REAL_TOOL_OUTPUT");
      expect(text).toContain("REAL_TOOL_ERROR");
      expect(text).toContain("REAL_ASSISTANT_TEXT");
      expect(text).toContain("REAL_REASONING");
      expect(text).toContain("gpt-5.5");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unrecognized schema fails soft and returns undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-unknown-"));
    try {
      const noSession = join(dir, "no-session.db");
      const db1 = new Database(noSession);
      db1.run("CREATE TABLE random_table (id TEXT)");
      db1.close();
      expect(buildOpenCodeTraceRequest(noSession)).toBeUndefined();

      const sessionV2NoMessages = join(dir, "session-v2-only.db");
      const db2 = new Database(sessionV2NoMessages);
      db2.run("CREATE TABLE session_v2 (id TEXT, time_created INTEGER, time_updated INTEGER)");
      db2.run("INSERT INTO session_v2 VALUES ('s1', 1, 2)");
      db2.close();
      expect(buildOpenCodeTraceRequest(sessionV2NoMessages)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exportOpenCodeTrace", () => {
  test("uses a 15s OTLP timeout", () => {
    expect(PHOENIX_OTLP_TIMEOUT_MS).toBe(15_000);
  });

  test("skips when endpoint is unset", async () => {
    delete process.env.PHOENIX_OTLP_ENDPOINT;
    let called = false;
    setTraceFetchForTests(async () => {
      called = true;
      return new Response(null, { status: 200 });
    });
    await exportOpenCodeTrace({ dbPath: "/no/such.db" });
    expect(called).toBe(false);
    expect(traceExportErrors()).toBe(0);
  });

  test("rejects the public Phoenix hostname", async () => {
    process.env.PHOENIX_OTLP_ENDPOINT = `https://${PUBLIC_PHOENIX_HOST}`;
    let called = false;
    setTraceFetchForTests(async () => {
      called = true;
      return new Response(null, { status: 200 });
    });
    await exportOpenCodeTrace({ dbPath: "/no/such.db" });
    expect(called).toBe(false);
    expect(traceExportErrors()).toBe(1);
  });

  test("POSTs OTLP protobuf and records HTTP failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeTraceDb(dbPath, { tools: [{ tool: "bash", status: "completed", command: "pwd" }] });
      process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
      process.env.AGENT_INSTANCE = "jumi-worker";
      const posts: Array<{ url: string; type: string | null; project: string | null; body: Uint8Array }> = [];
      setTraceFetchForTests(async (url, init) => {
        const headers = new Headers(init?.headers);
        posts.push({
          url,
          type: headers.get("content-type"),
          project: headers.get("phoenix-project"),
          body: new Uint8Array(init?.body as Uint8Array),
        });
        return new Response(null, { status: 200 });
      });
      await exportOpenCodeTrace({
        dbPath,
        trace: { kind: "follow-up", owner: "personal", repo: "jumi", sha: "def", jobId: "9" },
      });
      expect(posts).toHaveLength(1);
      expect(posts[0].url).toBe("http://phoenix.internal:6006/v1/traces");
      expect(posts[0].type).toBe("application/x-protobuf");
      expect(posts[0].project).toBe("jumi-worker");
      const resource = decodeResourceAttrs(posts[0].body);
      expect(resource["openinference.project.name"]).toBe("jumi-worker");
      expect(resource.kind).toBe("follow-up");
      expect(resource.job_id).toBe("9");
      expect(resource["session.id"]).toBe("9");
      expect(traceExportErrors()).toBe(0);

      setTraceFetchForTests(async () => new Response("no", { status: 503 }));
      await exportOpenCodeTrace({ dbPath });
      expect(traceExportErrors()).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unreadable database increments errors without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      await writeFile(dbPath, "not sqlite");
      process.env.PHOENIX_OTLP_ENDPOINT = "http://127.0.0.1:9";
      await expect(exportOpenCodeTrace({ dbPath })).resolves.toBeUndefined();
      expect(traceExportErrors()).toBe(1);
      expect(renderTokenMetrics()).toContain('ai_trace_exporter_errors{agent_instance="jumi"} 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("over-cap after shrinking increments errors without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeTraceDb(dbPath, { tools: [{ tool: "bash", status: "completed", command: "pwd" }] });
      process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
      setTraceLimitsForTests({ maxBytes: 80 });
      let called = false;
      setTraceFetchForTests(async () => {
        called = true;
        return new Response(null, { status: 200 });
      });
      await expect(exportOpenCodeTrace({ dbPath })).resolves.toBeUndefined();
      expect(called).toBe(false);
      expect(traceExportErrors()).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("timeout increments errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeTraceDb(dbPath);
      process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
      setTraceTimeoutForTests(20);
      setTraceFetchForTests(
        (_url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      );
      await exportOpenCodeTrace({ dbPath });
      expect(traceExportErrors()).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
