/**
 * Parent-owned per-spawn review MCP server.
 *
 * Listens on a loopback HTTP port (no socket file in the checkout). A random
 * bearer token is minted per spawn and given only to the harness through its
 * MCP config, written under the spawn's temp root — never in the prompt and
 * never in the child environment.
 *
 * Known-open in the single-domain sandbox (see docs/review-sandbox.md): the
 * temp root lives under the RW checkout (`.jumi-tmp`), Landlock has no deny
 * rules, and the loopback server stays reachable from inside the domain, so
 * sandboxed pull code that reads the token file can call this server. The
 * per-tool sandbox follow-up (wrap each shell, not the whole agent) is what
 * would hide it. The server dies with the spawn (`close()`).
 *
 * The wire format is MCP-style JSON-RPC over HTTP (`POST /mcp`): `initialize`,
 * `tools/list`, and `tools/call`. Plain MCP SDK clients and the small
 * `probeReviewMcpServer` helper below both speak it.
 */

import { randomBytes } from "node:crypto";
import type { ReviewVerdictStore } from "./review_verdict_store.ts";

export const REVIEW_MCP_TOOL_NAMES = [
  "add_finding",
  "update_finding",
  "remove_finding",
  "list_findings",
  "set_verdict",
  "previous_findings",
] as const;

export type ReviewMcpToolName = (typeof REVIEW_MCP_TOOL_NAMES)[number];

export function randomReviewMcpToken(): string {
  return randomBytes(32).toString("hex");
}

export function reviewMcpAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function isAuthorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? req.headers.get("x-jumi-review-token") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : header.trim();
  if (!bearer || bearer.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < bearer.length; i++) diff |= bearer.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolSchemas(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: "add_finding",
      description:
        "Record one review finding. Path must be a changed, non-excluded file; line must be in the diff hunks.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["bug", "risk", "question", "suggestion"] },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["severity"],
      },
    },
    {
      name: "update_finding",
      description: "Update a recorded finding by id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["bug", "risk", "question", "suggestion"] },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "remove_finding",
      description: "Remove a recorded finding by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "list_findings",
      description: "List recorded findings so later rounds can re-check them.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "set_verdict",
      description:
        "Record the review verdict. Success with an open bug/risk is rejected; failure needs a bug/risk finding or an explicit could-not-finish reason. Last call wins.",
      inputSchema: {
        type: "object",
        properties: { state: { type: "string", enum: ["success", "failure"] }, reason: { type: "string" } },
        required: ["state"],
      },
    },
    {
      name: "previous_findings",
      description: "Previous review finding lines for this pull, if this is a later review.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

function callTool(
  store: ReviewVerdictStore,
  name: string,
  args: Record<string, unknown>
): { ok: boolean; text: string } {
  switch (name) {
    case "add_finding": {
      const result = store.addFinding({
        ...(args.path !== undefined ? { path: args.path as string } : {}),
        ...(args.line !== undefined ? { line: args.line as number } : {}),
        severity: args.severity as string,
        ...(args.title !== undefined ? { title: args.title as string } : {}),
        ...(args.body !== undefined ? { body: args.body as string } : {}),
      });
      return result.ok ? { ok: true, text: JSON.stringify({ id: result.id }) } : { ok: false, text: result.error };
    }
    case "update_finding": {
      const result = store.updateFinding({ ...(args as { id: unknown }) });
      return result.ok ? { ok: true, text: JSON.stringify({ updated: true }) } : { ok: false, text: result.error };
    }
    case "remove_finding": {
      const result = store.removeFinding({ ...(args as { id: unknown }) });
      return result.ok ? { ok: true, text: JSON.stringify({ removed: true }) } : { ok: false, text: result.error };
    }
    case "list_findings": {
      return { ok: true, text: JSON.stringify({ findings: store.listFindings() }) };
    }
    case "set_verdict": {
      const result = store.setVerdict({ state: args.state, reason: args.reason });
      return result.ok ? { ok: true, text: JSON.stringify({ recorded: true }) } : { ok: false, text: result.error };
    }
    case "previous_findings": {
      return { ok: true, text: JSON.stringify({ findings: store.listPreviousFindings() }) };
    }
    default:
      return { ok: false, text: `unknown tool: ${name}` };
  }
}

export interface StartedReviewMcpServer {
  url: string;
  token: string;
  close: () => void;
}

export async function startReviewMcpServer(opts: {
  store: ReviewVerdictStore;
  token?: string;
}): Promise<StartedReviewMcpServer> {
  const token = opts.token ?? randomReviewMcpToken();
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
        return rpcError(body?.id, -32000, "review spawn ended: verdict store is closed");
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
            serverInfo: { name: "jumi-review", version: "1.0.0" },
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
export async function probeReviewMcpServer(
  url: string,
  token: string,
  tool: string,
  args: Record<string, unknown> = {},
  id = 1
): Promise<{ ok: boolean; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...reviewMcpAuthHeaders(token) },
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

export async function probeReviewMcpInit(url: string, token: string): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...reviewMcpAuthHeaders(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (!res.ok) return false;
  const payload = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
  return payload.result?.serverInfo?.name === "jumi-review";
}

// ── Runner MCP configs ─────────────────────────────────────────────────────

/** OpenCode MCP entry merged into the per-spawn global `opencode.json`. */
export function openCodeReviewMcpEntry(url: string, token: string): Record<string, unknown> {
  return { type: "remote", url, headers: { Authorization: `Bearer ${token}` } };
}

/** Claude `--mcp-config` file content. `--strict-mcp-config` keeps the repo's `.mcp.json` from shadowing it. */
export function claudeReviewMcpConfig(url: string, token: string): string {
  return `${JSON.stringify(
    { mcpServers: { "jumi-review": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2
  )}\n`;
}

export function claudeMcpArgs(configPath: string): string[] {
  return ["--mcp-config", configPath, "--strict-mcp-config"];
}
