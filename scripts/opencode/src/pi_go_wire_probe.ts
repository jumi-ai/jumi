#!/usr/bin/env bun
/**
 * Pi Go wire probe (jumi#986).
 *
 * Proves that what Pi sends over HTTP to the Go route carries Jumi's tools,
 * and that a tool call coming back on the wire is parsed into a Jumi tool
 * call. The offline probe's scripted provider ignores the context it
 * receives (`src/pi_offline_legacy_probe.ts`), and the Go loopback test only
 * covers headers/path/model/usage with a text answer
 * (`test/pi_opencode_go.test.ts`). A dropped registration, a schema lost in
 * serialization, a stripped description, or a wire call that never maps back
 * would pass every one of those and break every Pi review or worker attempt.
 *
 * How: build the real production inference session
 * (`createPiGoSessionDeps`: the real `opencode-go` provider wrapped in
 * Jumi's Go transport `withPiGoTransport`, fresh static key) and run the
 * production harnesses (`runPiReviewAttempt`, `runPiWorkerAttempt`) against
 * an intercepted HTTP endpoint that speaks the Go wire format (OpenAI
 * Responses SSE, the API the `muse-spark-1.3-contributor` model entry
 * uses). No vendor, no credentials, no real model: the interceptor answers
 * only `opencode.ai` requests with canned SSE and delegates everything else
 * to the real fetch, so the run works with `--network none`.
 *
 * It proves, at the wire boundary, for the reviewer and each worker intent
 * (`implement`, `follow-up`, `conflict`):
 *   1. Declared: every request carries each expected `jumi_*` tool with its
 *      name, non-empty description, and schema constraints (types, required
 *      fields) as JSON-schema parameters, plus the trusted instructions and
 *      the task prompt. The expected sets are declared here, never derived
 *      from the registration, so dropping a tool from one intent's
 *      registration fails the probe. Only the guarded built-ins
 *      (`read`, `bash`, `edit`, `write`) may appear alongside.
 *   2. Round trip: a wire-format call for `jumi_add_finding` then
 *      `jumi_set_verdict` (review) and `jumi_set_pr_body` (each worker
 *      intent) is parsed, executed, and lands in the parent's store; the
 *      verdict resolves under the `required` contract.
 *   3. Rejected: a malformed call (invalid severity) stores nothing and its
 *      error text appears in the next HTTP request to the model.
 *   4. Next turn: tools and instructions are still present in the request
 *      after a tool result (every request is checked, not just the first).
 *
 * Exit 0 when every case matches, 1 otherwise.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPiGoSessionId, PI_GO_SESSION_HEADER } from "./pi_opencode_go.ts";
import { runPiReviewAttempt } from "./pi_review.ts";
import { createPiGoSessionDeps } from "./pi_runtime.ts";
import { type PiWorkerIntent, runPiWorkerAttempt } from "./pi_worker.ts";
import { ReviewVerdictStore } from "./review_verdict_store.ts";
import { WorkerResultStore } from "./worker_mcp.ts";

// --- Declared expectations (independent of the registration they check) ---

/** The only model this transport serves; hardcoded so a model swap fails. */
export const GO_WIRE_MODEL = "muse-spark-1.3-contributor" as const;

/** Actual-agent identity the wire must carry; hardcoded, not derived. */
export const GO_WIRE_USER_AGENT = "jumi/1.0" as const;

/** Attribution name the wire must carry; hardcoded, not derived. */
export const GO_WIRE_CLIENT = "jumi" as const;

/**
 * Expected reviewer `jumi_*` tools. Declared here, never imported from
 * `src/pi_review.ts`: comparing the registration with itself cannot catch
 * an omitted tool.
 */
export const REVIEW_EXPECTED_JUMI_TOOLS = [
  "jumi_add_finding",
  "jumi_update_finding",
  "jumi_remove_finding",
  "jumi_set_verdict",
  "jumi_list_findings",
  "jumi_previous_findings",
  "jumi_set_disposition",
] as const;

/**
 * Expected worker `jumi_*` tools per intent. Declared here, never imported
 * from `src/pi_worker.ts`, for the same reason.
 */
export const WORKER_EXPECTED_JUMI_TOOLS: Record<string, readonly string[]> = {
  implement: ["jumi_skip", "jumi_blocked_on", "jumi_set_pr_body", "jumi_set_handoff"],
  "follow-up": ["jumi_no_changes", "jumi_set_pr_body", "jumi_set_handoff", "jumi_finding_response"],
  conflict: ["jumi_set_pr_body", "jumi_set_handoff"],
};

/** Guarded built-ins that may appear alongside the `jumi_*` tools. */
export const EXPECTED_BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

export interface WireToolContract {
  /** Fields the wire schema must require. */
  required: string[];
  /** Property names the wire schema must declare, with their JSON-schema types. */
  propTypes: Record<string, string>;
}

/**
 * Per-tool wire schema contracts. Only the load-bearing constraints are
 * pinned (required fields and property types), so a description reword keeps
 * passing while a stripped schema or a renamed field fails.
 */
export const WIRE_TOOL_CONTRACTS: Record<string, WireToolContract> = {
  jumi_add_finding: { required: ["severity"], propTypes: { severity: "string" } },
  jumi_update_finding: { required: ["id"], propTypes: { id: "string" } },
  jumi_remove_finding: { required: ["id"], propTypes: { id: "string" } },
  jumi_set_verdict: { required: ["state"], propTypes: { state: "string" } },
  jumi_list_findings: { required: [], propTypes: {} },
  jumi_previous_findings: { required: [], propTypes: {} },
  jumi_set_disposition: { required: ["key", "disposition"], propTypes: { key: "string", disposition: "string" } },
  jumi_skip: { required: ["reason"], propTypes: { reason: "string" } },
  jumi_blocked_on: { required: ["ref", "reason"], propTypes: { ref: "string", reason: "string" } },
  jumi_set_pr_body: { required: ["markdown"], propTypes: { markdown: "string" } },
  jumi_set_handoff: { required: ["notes"], propTypes: { notes: "string" } },
  jumi_no_changes: { required: ["reason"], propTypes: { reason: "string" } },
  jumi_finding_response: { required: ["finding", "status"], propTypes: { finding: "string", status: "string" } },
};

/**
 * Check one request's top-level `tools` array against the declared expected
 * `jumi_*` set. Returns `null` when the wire matches, else the mismatch.
 * Pure (no I/O) so the unit gate can drive the negative controls: a dropped
 * tool, a renamed tool, or a stripped schema/description fails here.
 */
export function checkWireTools(tools: unknown, expectedJumi: readonly string[]): string | null {
  if (!Array.isArray(tools)) return `wire tools is not an array: ${typeof tools}`;
  const byName = new Map<string, { description?: unknown; parameters?: unknown }>();
  for (const entry of tools) {
    if (!entry || typeof entry !== "object") return `wire tool entry is not an object: ${JSON.stringify(entry)}`;
    const record = entry as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof record.name !== "string" || !record.name) return "wire tool entry has no name";
    if (byName.has(record.name)) return `wire tool duplicated: ${record.name}`;
    byName.set(record.name, { description: record.description, parameters: record.parameters });
  }
  const wireJumi = [...byName.keys()].filter((name) => name.startsWith("jumi_")).sort();
  const want = [...expectedJumi].sort();
  if (JSON.stringify(wireJumi) !== JSON.stringify(want)) {
    return `wire jumi_* set ${JSON.stringify(wireJumi)} != expected ${JSON.stringify(want)}`;
  }
  for (const name of want) {
    const tool = byName.get(name)!;
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      return `wire tool ${name} lost its description`;
    }
    const params = tool.parameters as { type?: unknown; required?: unknown; properties?: unknown } | undefined;
    if (!params || typeof params !== "object" || params.type !== "object") {
      return `wire tool ${name} lost its object schema`;
    }
    const contract = WIRE_TOOL_CONTRACTS[name];
    if (!contract) return `probe has no schema contract for expected tool ${name}`;
    const required = Array.isArray(params.required) ? (params.required as unknown[]) : [];
    // An empty required contract accepts a missing `required` array (the
    // empty-object schema serializes without one); a non-empty contract
    // must name every required field.
    for (const field of contract.required) {
      if (!required.includes(field)) return `wire tool ${name} no longer requires ${field}`;
    }
    const properties =
      params.properties && typeof params.properties === "object"
        ? (params.properties as Record<string, { type?: unknown }>)
        : undefined;
    if (contract.required.length > 0 && !properties) return `wire tool ${name} lost its properties`;
    for (const [prop, type] of Object.entries(contract.propTypes)) {
      if (properties?.[prop]?.type !== type) return `wire tool ${name}.${prop} is not ${type} on the wire`;
    }
  }
  for (const name of byName.keys()) {
    if (name.startsWith("jumi_")) continue;
    if (!(EXPECTED_BUILTIN_TOOLS as readonly string[]).includes(name)) {
      return `unexpected non-jumi tool on the wire: ${name}`;
    }
  }
  return null;
}

// --- Canned Go wire endpoint (OpenAI Responses SSE) ---

type WireTurn = { kind: "tool"; name: string; args: Record<string, unknown> } | { kind: "text"; text: string };

export interface CapturedWireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function sseBody(events: unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n`).join("\n")}\n`;
}

function toolTurnBody(callId: string, itemId: string, name: string, args: Record<string, unknown>): string {
  const argStr = JSON.stringify(args);
  const item = { type: "function_call", id: itemId, call_id: callId, name, arguments: "" };
  const done = { ...item, arguments: argStr };
  const output = [{ ...item, arguments: argStr }];
  return sseBody([
    { type: "response.created", response: { id: `resp_${callId}` } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: argStr },
    { type: "response.output_item.done", output_index: 0, item: done },
    {
      type: "response.completed",
      response: {
        id: `resp_${callId}`,
        status: "completed",
        output,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

function textTurnBody(tag: string, text: string): string {
  const item = { type: "message", id: `msg_${tag}`, role: "assistant", content: [] };
  const done = {
    type: "message",
    id: `msg_${tag}`,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return sseBody([
    { type: "response.created", response: { id: `resp_${tag}` } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: done },
    {
      type: "response.completed",
      response: {
        id: `resp_${tag}`,
        status: "completed",
        output: [done],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

/**
 * Intercept `opencode.ai` traffic with a scripted Go-wire endpoint. Every
 * other request delegates to the previous fetch, so loopback helpers keep
 * working under `--network none`. Returns the captured requests and a
 * restore function; the caller must restore even on failure.
 */
function installGoWireInterceptor(turns: WireTurn[]): { captured: CapturedWireRequest[]; restore: () => void } {
  const queue = [...turns];
  const captured: CapturedWireRequest[] = [];
  let n = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url = "";
    try {
      url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    } catch {
      return previous(input as string, init);
    }
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return previous(input, init);
    }
    if (host !== "opencode.ai") return previous(input, init);
    const headers: Record<string, string> = {};
    const rawHeaders = (init as { headers?: unknown } | undefined)?.headers;
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (rawHeaders && typeof rawHeaders === "object") Object.assign(headers, rawHeaders);
    const body = String((init as { body?: unknown } | undefined)?.body ?? "");
    captured.push({ method: String((init as { method?: unknown } | undefined)?.method ?? "GET"), url, headers, body });
    n += 1;
    const next: WireTurn = queue.shift() ?? { kind: "text", text: "done" };
    const payload =
      next.kind === "tool"
        ? toolTurnBody(`call_${n}`, `fc_${n}`, next.name, next.args)
        : textTurnBody(`t${n}`, next.text);
    return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { captured, restore: () => (globalThis.fetch = previous) };
}

function headerOf(req: CapturedWireRequest, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
}

/**
 * Check one captured HTTP request: POST to the Go Responses path, stable
 * opaque session header, actual-agent identity, the exact model, the
 * declared tools with their schemas, and the trusted instructions plus the
 * task prompt. Returns `null` when the request matches, else the mismatch.
 */
function checkWireRequest(
  req: CapturedWireRequest,
  opts: { expectedJumi: readonly string[]; baseMarker: string; promptMarker: string }
): string | null {
  if (req.method !== "POST") return `wire request is ${req.method}, want POST`;
  if (!req.url.includes("/responses")) return `wire request misses the Responses path: ${req.url}`;
  const userAgent = headerOf(req, "user-agent") ?? headerOf(req, "User-Agent");
  if (userAgent !== GO_WIRE_USER_AGENT) return `wire User-Agent is ${userAgent ?? "<missing>"}`;
  if (headerOf(req, "x-opencode-client") !== GO_WIRE_CLIENT) return "wire client attribution is missing";
  let parsed: { model?: unknown; tools?: unknown };
  try {
    parsed = JSON.parse(req.body) as { model?: unknown; tools?: unknown };
  } catch {
    return "wire request body is not JSON";
  }
  if (parsed.model !== GO_WIRE_MODEL) return `wire model is ${String(parsed.model)}`;
  const toolsError = checkWireTools(parsed.tools, opts.expectedJumi);
  if (toolsError) return toolsError;
  if (!req.body.includes(opts.baseMarker)) return "wire request lost the trusted instructions";
  if (!req.body.includes(opts.promptMarker)) return "wire request lost the task prompt";
  return null;
}

/** Assert every captured request and the stability of the session header. */
function checkWireConversation(
  captured: CapturedWireRequest[],
  opts: { expectedJumi: readonly string[]; baseMarker: string; promptMarker: string; turns: number }
): string | null {
  if (captured.length !== opts.turns + 1) {
    return `wire saw ${captured.length} requests, want ${opts.turns + 1} (one per scripted turn plus the final text)`;
  }
  for (const [index, req] of captured.entries()) {
    const mismatch = checkWireRequest(req, opts);
    if (mismatch) return `request ${index + 1}: ${mismatch}`;
  }
  const sessions = captured.map((req) => headerOf(req, PI_GO_SESSION_HEADER) ?? "");
  if (sessions.some((id) => !id)) return "a wire request misses the Go session header";
  if (!sessions.every((id) => id === sessions[0])) return "the Go session header changed mid-conversation";
  if (!sessions.every((id) => isPiGoSessionId(id))) {
    return `the Go session header is not an opaque conversation id: ${sessions[0]}`;
  }
  return null;
}

/** Tool-result outputs carried by one captured request (unescaped). */
function wireOutputs(req: CapturedWireRequest): string[] {
  try {
    const parsed = JSON.parse(req.body) as { input?: Array<{ type?: unknown; output?: unknown }> };
    if (!Array.isArray(parsed.input)) return [];
    return parsed.input
      .filter((item) => item?.type === "function_call_output")
      .map((item) => (typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null)));
  } catch {
    return [];
  }
}
interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly observed: string;
}

function gitSync(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(proc.stderr)}`);
}

async function seedWorkerFixture(dir: string): Promise<void> {
  gitSync(["init"], dir);
  gitSync(["config", "user.email", "probe@example.com"], dir);
  gitSync(["config", "user.name", "probe"], dir);
  await writeFile(join(dir, "app.txt"), "broken\n");
  await writeFile(join(dir, "check.sh"), "#!/bin/sh\ngrep -q fixed app.txt\n");
  gitSync(["add", "-A"], dir);
  gitSync(["commit", "-m", "init"], dir);
}

const ATTEMPT_TIMEOUT_MS = 60_000;

function toolResultText(toolCalls: Array<{ name: string; text: string }>, name: string): string | undefined {
  return toolCalls.find((call) => call.name === name)?.text;
}

async function reviewOkCase(): Promise<CaseResult> {
  const name = "reviewer wire carries declared tools and resolves a verdict";
  const workdir = await mkdtemp(join(tmpdir(), "jumi-go-wire-review-"));
  const { captured, restore } = installGoWireInterceptor([
    {
      kind: "tool",
      name: "jumi_add_finding",
      args: { path: "src/a.ts", line: 1, severity: "suggestion", title: "wire t", body: "wire b" },
    },
    { kind: "tool", name: "jumi_set_verdict", args: { state: "success" } },
  ]);
  try {
    await writeFile(join(workdir, "src-a.ts"), "hello\n");
    const deps = await createPiGoSessionDeps({ env: { OPENCODE_API_KEY: "probe-loopback-key" } });
    const store = new ReviewVerdictStore({
      changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
    });
    const baseMarker = "GO-WIRE-PROBE-BASE-REVIEW";
    const promptMarker = "GO-WIRE-PROBE-PROMPT-REVIEW-OK";
    const result = await runPiReviewAttempt({
      workdir,
      prompt: `review the change (${promptMarker})`,
      baseInstructions: baseMarker,
      store,
      modelRuntime: deps.modelRuntime,
      model: deps.model,
      allowedFetchHosts: deps.allowedFetchHosts,
      timeoutMs: ATTEMPT_TIMEOUT_MS,
    });
    if (result.status !== "complete")
      return { name, ok: false, observed: `status=${result.status} reason=${result.reason}` };
    const wireError = checkWireConversation(captured, {
      expectedJumi: REVIEW_EXPECTED_JUMI_TOOLS,
      baseMarker,
      promptMarker,
      turns: 2,
    });
    if (wireError) return { name, ok: false, observed: wireError };
    if (!store.hasVerdict() || store.toRecord().state !== "success") {
      return { name, ok: false, observed: "verdict did not resolve to success" };
    }
    if (store.listFindings().length !== 1) return { name, ok: false, observed: "finding did not land in the store" };
    const findingText = toolResultText(result.toolCalls, "jumi_add_finding") ?? "";
    if (!findingText || !wireOutputs(captured[1]!).includes(findingText)) {
      return { name, ok: false, observed: "the finding tool result is missing from the next request" };
    }
    return { name, ok: true, observed: `requests=${captured.length} findings=1 verdict=success` };
  } catch (err) {
    return { name, ok: false, observed: err instanceof Error ? err.message : String(err) };
  } finally {
    restore();
    await rm(workdir, { recursive: true, force: true });
  }
}

async function reviewBadInputCase(): Promise<CaseResult> {
  const name = "reviewer wire rejects a malformed tool call without storing";
  const workdir = await mkdtemp(join(tmpdir(), "jumi-go-wire-bad-"));
  const { captured, restore } = installGoWireInterceptor([
    {
      kind: "tool",
      name: "jumi_add_finding",
      args: { path: "src/a.ts", line: 1, severity: "bogus", title: "wire t", body: "wire b" },
    },
  ]);
  try {
    const deps = await createPiGoSessionDeps({ env: { OPENCODE_API_KEY: "probe-loopback-key" } });
    const store = new ReviewVerdictStore({
      changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
    });
    const baseMarker = "GO-WIRE-PROBE-BASE-BAD";
    const promptMarker = "GO-WIRE-PROBE-PROMPT-BAD";
    const result = await runPiReviewAttempt({
      workdir,
      prompt: `review the change (${promptMarker})`,
      baseInstructions: baseMarker,
      store,
      modelRuntime: deps.modelRuntime,
      model: deps.model,
      allowedFetchHosts: deps.allowedFetchHosts,
      timeoutMs: ATTEMPT_TIMEOUT_MS,
    });
    if (store.listFindings().length !== 0 || store.hasVerdict()) {
      return { name, ok: false, observed: "the malformed call stored a finding or verdict" };
    }
    if (result.status !== "incomplete")
      return { name, ok: false, observed: `status=${result.status}, want incomplete` };
    const wireError = checkWireConversation(captured, {
      expectedJumi: REVIEW_EXPECTED_JUMI_TOOLS,
      baseMarker,
      promptMarker,
      turns: 1,
    });
    if (wireError) return { name, ok: false, observed: wireError };
    if (!wireOutputs(captured[1]!).some((output) => output.includes("bad severity"))) {
      return { name, ok: false, observed: "the tool error text is missing from the next request" };
    }
    return { name, ok: true, observed: `requests=${captured.length} stored=0 error-on-wire=yes` };
  } catch (err) {
    return { name, ok: false, observed: err instanceof Error ? err.message : String(err) };
  } finally {
    restore();
    await rm(workdir, { recursive: true, force: true });
  }
}

async function workerCase(intent: PiWorkerIntent, name: string): Promise<CaseResult> {
  const workdir = await mkdtemp(join(tmpdir(), `jumi-go-wire-${intent}-`));
  const expectedJumi = WORKER_EXPECTED_JUMI_TOOLS[intent];
  if (!expectedJumi) return { name, ok: false, observed: `probe declares no tools for intent ${intent}` };
  const prMarker = `GO-WIRE-PROBE-PRBODY-${intent}`;
  const handoffMarker = `GO-WIRE-PROBE-HANDOFF-${intent}`;
  const turns: WireTurn[] =
    intent === "implement" || intent === "conflict"
      ? [
          { kind: "tool", name: "edit", args: { path: "app.txt", edits: [{ oldText: "broken", newText: "fixed" }] } },
          { kind: "tool", name: "jumi_set_pr_body", args: { markdown: prMarker } },
          { kind: "tool", name: "jumi_set_handoff", args: { notes: handoffMarker } },
        ]
      : [
          { kind: "tool", name: "jumi_set_pr_body", args: { markdown: prMarker } },
          { kind: "tool", name: "jumi_set_handoff", args: { notes: handoffMarker } },
          { kind: "tool", name: "jumi_no_changes", args: { reason: `GO-WIRE-PROBE-NO-CHANGES-${intent}` } },
        ];
  const { captured, restore } = installGoWireInterceptor(turns);
  try {
    await seedWorkerFixture(workdir);
    const deps = await createPiGoSessionDeps({ env: { OPENCODE_API_KEY: "probe-loopback-key" } });
    const store = new WorkerResultStore();
    const baseMarker = `GO-WIRE-PROBE-BASE-${intent}`;
    const promptMarker = `GO-WIRE-PROBE-PROMPT-${intent}`;
    const result = await runPiWorkerAttempt({
      workdir,
      intent,
      prompt: `do the ${intent} work (${promptMarker})`,
      baseInstructions: baseMarker,
      store,
      modelRuntime: deps.modelRuntime,
      model: deps.model,
      allowedFetchHosts: deps.allowedFetchHosts,
      timeoutMs: ATTEMPT_TIMEOUT_MS,
    });
    if (result.status !== "complete") {
      return { name, ok: false, observed: `status=${result.status} reason=${result.reason}` };
    }
    const wireError = checkWireConversation(captured, {
      expectedJumi,
      baseMarker,
      promptMarker,
      turns: turns.length,
    });
    if (wireError) return { name, ok: false, observed: wireError };
    if ((store.getPrBody() ?? "").includes(prMarker) === false) {
      return { name, ok: false, observed: "the pr body did not land in the store" };
    }
    if ((store.getHandoff() ?? "").includes(handoffMarker) === false) {
      return { name, ok: false, observed: "the handoff did not land in the store" };
    }
    if (intent === "implement" || intent === "conflict") {
      if (!result.dirty || !result.diff.includes("fixed")) {
        return { name, ok: false, observed: "the edit did not land in the parent-observed diff" };
      }
    } else if (result.dirty || !store.getNoChangesReason()) {
      return { name, ok: false, observed: "follow-up did not settle as no-changes on a clean tree" };
    }
    const prBodyText = toolResultText(result.toolCalls, "jumi_set_pr_body") ?? "";
    const nextIndex = turns.findIndex((turn) => turn.kind === "tool" && turn.name === "jumi_set_pr_body") + 1;
    if (!prBodyText || !wireOutputs(captured[nextIndex]!).includes(prBodyText)) {
      return { name, ok: false, observed: "the pr-body tool result is missing from the next request" };
    }
    return { name, ok: true, observed: `requests=${captured.length} dirty=${result.dirty}` };
  } catch (err) {
    return { name, ok: false, observed: err instanceof Error ? err.message : String(err) };
  } finally {
    restore();
    await rm(workdir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const results: CaseResult[] = [];
  results.push(await reviewOkCase());
  results.push(await reviewBadInputCase());
  results.push(await workerCase("implement", "implement wire carries declared tools and lands the diff"));
  results.push(await workerCase("follow-up", "follow-up wire carries declared tools and settles no-changes"));
  results.push(await workerCase("conflict", "conflict wire carries declared tools and lands the diff"));
  for (const { name, ok, observed } of results) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${observed}`);
  }
  const failures = results.filter((result) => !result.ok).length;
  if (failures > 0) {
    console.error(`pi-go-wire probe: ${failures}/${results.length} check(s) failed against the Go wire format`);
    return 1;
  }
  console.log(`pi-go-wire probe: ${results.length}/${results.length} checks pass against the Go wire format`);
  return 0;
}

if (import.meta.main) process.exit(await main());
