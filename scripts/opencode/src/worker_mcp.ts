/**
 * Parent-owned per-spawn worker MCP server.
 *
 * Mirrors `review_mcp.ts`: a loopback HTTP port (no socket file in the
 * checkout) with a random per-spawn bearer token. The harness writes the MCP
 * config under an outside harness temp root (`/tmp/jumi-worker-*`, never the
 * checkout and never the child environment) and the model reaches the tools
 * through MCP-style JSON-RPC over HTTP (`POST /mcp`): `initialize`,
 * `tools/list`, and `tools/call`.
 *
 * Today the only tool is `no_changes(reason)` for follow-up rounds that leave
 * the tree clean. The parent reads the small result store after the run and
 * posts `no follow-up changes: <reason>` (sanitized like verdict text); when
 * the model never calls the tool the parent fails open with the old bare
 * message plus `(no reason given)`.
 */

import { randomBytes } from "node:crypto";
import { agyMcpServerEntry, claudeMcpConfigFor, codexMcpTomlEntry, openCodeMcpEntry } from "./review_mcp.ts";
import { sanitizeCheckReason } from "./verdict.ts";

export const WORKER_MCP_SERVER_NAME = "jumi-worker";

export const WORKER_MCP_TOOL_NAMES = ["no_changes"] as const;

export type WorkerMcpToolName = (typeof WORKER_MCP_TOOL_NAMES)[number];

/** Longest accepted `no_changes` reason (chars, after trim). */
export const MAX_WORKER_NO_CHANGES_REASON_CHARS = 500;

export function randomWorkerMcpToken(): string {
  return randomBytes(32).toString("hex");
}

export function workerMcpAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function isAuthorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? req.headers.get("x-jumi-worker-token") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : header.trim();
  if (!bearer || bearer.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < bearer.length; i++) diff |= bearer.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** Count sentences: non-empty segments split on `.`/`!`/`?`, ignoring dots inside URLs. */
export function countReasonSentences(reason: string): number {
  // Strip `http(s)://...` tokens first so dots inside a link (e.g. an
  // external-fix URL the issue explicitly wants) never count as boundaries.
  // Keep trailing sentence punctuation attached to the URL (the greedy `\S+`
  // would otherwise swallow the `.` that ends the sentence).
  const withoutUrls = reason.replace(/https?:\/\/\S+/g, (match) => {
    const trail = match.match(/[.,!?;:]+$/)?.[0] ?? "";
    return trail ? ` ${trail}` : " ";
  });
  return withoutUrls
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

export function validateNoChangesReason(reason: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  if (typeof reason !== "string") return { ok: false, error: "reason is required (1-3 sentences)" };
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, error: "reason is required (1-3 sentences)" };
  if (trimmed.length > MAX_WORKER_NO_CHANGES_REASON_CHARS) {
    return { ok: false, error: `reason is too long (max ${MAX_WORKER_NO_CHANGES_REASON_CHARS} chars)` };
  }
  const sentences = countReasonSentences(trimmed);
  if (sentences < 1 || sentences > 3) {
    return { ok: false, error: "reason must be 1-3 sentences" };
  }
  return { ok: true, reason: trimmed };
}

/**
 * Small result store the parent reads after the run. One store lives for one
 * spawn and dies with it. Last `no_changes` call wins.
 */
export class WorkerResultStore {
  private reason?: string;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  setNoChanges(input: { reason?: unknown }): { ok: true } | { ok: false; error: string } {
    if (this.closed) return { ok: false, error: "worker spawn ended: result store is closed" };
    const validated = validateNoChangesReason(input.reason);
    if (!validated.ok) return validated;
    this.reason = validated.reason;
    return { ok: true };
  }

  getNoChangesReason(): string | undefined {
    return this.reason ? `${this.reason}` : undefined;
  }

  hasNoChanges(): boolean {
    return this.reason !== undefined;
  }
}

function toolSchemas(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: "no_changes",
      description:
        "Record why this follow-up round leaves the tree unchanged: what triggered the round (review finding / CI failure / comment) and why nothing changed. Required, 1-3 sentences.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  ];
}

function callTool(
  store: WorkerResultStore,
  name: string,
  args: Record<string, unknown>
): { ok: boolean; text: string } {
  if (name === "no_changes") {
    const result = store.setNoChanges({ reason: args.reason });
    return result.ok ? { ok: true, text: JSON.stringify({ recorded: true }) } : { ok: false, text: result.error };
  }
  return { ok: false, text: `unknown tool: ${name}` };
}

export interface StartedWorkerMcpServer {
  url: string;
  token: string;
  close: () => void;
}

export async function startWorkerMcpServer(opts: {
  store: WorkerResultStore;
  token?: string;
}): Promise<StartedWorkerMcpServer> {
  const token = opts.token ?? randomWorkerMcpToken();
  const store = opts.store;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return rpcError(null, -32700, "parse error");
      }
      if (!isAuthorized(req, token)) {
        return rpcError(body?.id, -32001, "wrong or missing bearer token");
      }
      if (store.isClosed) {
        return rpcError(body?.id, -32000, "worker spawn ended: result store is closed");
      }
      const method = body?.method;
      const params = body?.params ?? {};
      if (method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body?.id ?? null,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: WORKER_MCP_SERVER_NAME, version: "1.0.0" },
          },
        });
      }
      if (method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body?.id ?? null, result: { tools: toolSchemas() } });
      }
      if (method === "tools/call") {
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const out = callTool(store, name, args);
        return Response.json({
          jsonrpc: "2.0",
          id: body?.id ?? null,
          result: { content: [{ type: "text", text: out.text }], isError: out.ok ? undefined : true },
        });
      }
      if (method === "ping") {
        return Response.json({ jsonrpc: "2.0", id: body?.id ?? null, result: {} });
      }
      return rpcError(body?.id, -32601, `unknown method: ${String(method)}`);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, token, close: () => server.stop(true) };
}

/** Minimal JSON-RPC client for tests and per-runner probes. */
export async function probeWorkerMcpServer(
  url: string,
  token: string,
  tool: string,
  args: Record<string, unknown> = {},
  id = 1
): Promise<{ ok: boolean; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...workerMcpAuthHeaders(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const payload = (await res.json()) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (payload.error) return { ok: false, text: payload.error.message ?? "error" };
  const text = payload.result?.content?.[0]?.text ?? "";
  return { ok: !payload.result?.isError, text };
}

export async function probeWorkerMcpInit(url: string, token: string): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...workerMcpAuthHeaders(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (!res.ok) return false;
  const payload = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
  return payload.result?.serverInfo?.name === WORKER_MCP_SERVER_NAME;
}

/** Per-spawn harness temp root outside the checkout (holds worker MCP token configs). */
export async function makeWorkerHarnessTempRoot(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  // Fixed `/tmp` parent, never `os.tmpdir()`: the worker harness points
  // `TMPDIR` at `<checkout>/.jumi-tmp/scratch`, and `os.tmpdir()` follows
  // `TMPDIR` — using it would put the token configs back inside the checkout.
  return mkdtemp("/tmp/jumi-worker-");
}

// ── Runner MCP configs (shared shapes from `review_mcp.ts`) ────────────────

/** OpenCode MCP entry for the worker server. */
export function openCodeWorkerMcpEntry(url: string, token: string): Record<string, unknown> {
  return openCodeMcpEntry(url, token);
}

/** Claude `--mcp-config` file content for the worker server. */
export function claudeWorkerMcpConfig(url: string, token: string): string {
  return claudeMcpConfigFor(WORKER_MCP_SERVER_NAME, url, token);
}

/** Codex `config.toml` snippet for the worker server. Real TOML: parsed with `Bun.TOML.parse` in tests. */
export function codexWorkerMcpTomlEntry(url: string, token: string): string {
  return codexMcpTomlEntry(WORKER_MCP_SERVER_NAME, url, token);
}

/** Agy `mcp_config.json` server value for the worker server. */
export function agyWorkerMcpEntry(url: string, token: string): Record<string, unknown> {
  return agyMcpServerEntry(url, token);
}

/**
 * Sticky body for a clean-tree follow-up round. The reason rides the same
 * sanitiser as verdict text so `>` (and `-->`) can never break the trailer
 * shape. Fail-open: no recorded reason posts the old bare message with
 * `(no reason given)` and never fails the job.
 */
export function buildNoChangesSticky(reason: string | undefined | null): string {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) return "no follow-up changes (no reason given)";
  return `no follow-up changes: ${sanitizeCheckReason(trimmed)}`;
}
