/**
 * Parent-owned per-spawn review MCP server.
 *
 * Listens on a loopback HTTP port (no socket file in the checkout). A random
 * bearer token is minted per spawn and given only to the harness through its
 * MCP config, written under the outside harness temp root (`/tmp/jumi-review-*`,
 * never the checkout and never the child environment).
 *
 * Part-2 (jumi#550): the agent is unsandboxed so it can read that config, but
 * every shell the model runs is Landlocked without the harness temp, without
 * HOME, and without /tmp, so pull code cannot read the token file to call
 * this server. The loopback stays reachable (no TCP handling in the wrapper),
 * but without the token every call is rejected. The verdict store still wins
 * over the `JUMI_REVIEW.md` fallback file, so a shell that writes the file
 * cannot change the posted status.
 *
 * The wire format is MCP-style JSON-RPC over HTTP (`POST /mcp`): `initialize`,
 * `tools/list`, and `tools/call`. Plain MCP SDK clients and the small
 * `probeReviewMcpServer` helper below both speak it.
 */

import { randomBytes } from "node:crypto";
import type { ReviewVerdictStore } from "./review_verdict_store.ts";

export const REVIEW_MCP_SERVER_NAME = "jumi-review";

export const REVIEW_MCP_TOOL_NAMES = [
  "add_finding",
  "update_finding",
  "remove_finding",
  "list_findings",
  "set_verdict",
  "previous_findings",
  "set_disposition",
] as const;

type ReviewMcpToolName = (typeof REVIEW_MCP_TOOL_NAMES)[number];

export function randomReviewMcpToken(): string {
  return randomBytes(32).toString("hex");
}

function reviewMcpAuthHeaders(token: string): Record<string, string> {
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
        "Record one review finding. Path must be a changed, non-excluded file; line must be in the diff hunks. Use needs_maintainer for maintainer-only questions (question severity only) instead of typing the marker by hand; use proof {location, command, excerpt} for bug/risk proof instead of typing Proof: by hand.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["bug", "risk", "question", "suggestion"] },
          title: { type: "string" },
          body: { type: "string" },
          needs_maintainer: { type: "boolean" },
          proof: {
            type: "object",
            properties: {
              location: { type: "string" },
              command: { type: "string" },
              excerpt: { type: "string" },
            },
          },
        },
        required: ["severity"],
      },
    },
    {
      name: "update_finding",
      description:
        "Update a recorded finding by id. needs_maintainer and proof follow the add_finding rules; omitting them preserves the previous value.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["bug", "risk", "question", "suggestion"] },
          title: { type: "string" },
          body: { type: "string" },
          needs_maintainer: { type: "boolean" },
          proof: {
            type: "object",
            properties: {
              location: { type: "string" },
              command: { type: "string" },
              excerpt: { type: "string" },
            },
          },
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
        "Record the review verdict. Success with an open bug/risk is rejected; failure needs a bug/risk finding or an explicit could-not-finish reason. Use incomplete (failure only) for could-not-finish without consulting the reason text. Last call wins.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["success", "failure"] },
          reason: { type: "string" },
          incomplete: { type: "string", enum: ["none", "could_not_finish", "head_moved", "dirty_tree", "no_artifact"] },
        },
        required: ["state"],
      },
    },
    {
      name: "previous_findings",
      description:
        "Previous review findings for this pull, if this is a later review. Keyed entries are {key, text, severity, location?, status}; unkeyed entries are plain strings. Keyed entries need a disposition via set_disposition before a complete set_verdict.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "set_disposition",
      description:
        "State a disposition for one eligible keyed prior: still_present materialises it under its key (returns its finding handle for update_finding), fixed/withdrawn record a note and add no finding. Re-calling replaces the earlier disposition. Unknown or ineligible keys are errors.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
          disposition: { type: "string", enum: ["still_present", "fixed", "withdrawn"] },
          note: { type: "string" },
          location: {
            type: "object",
            properties: { path: { type: "string" }, line: { type: "number" } },
            required: ["path", "line"],
          },
          body_only: { type: "boolean" },
        },
        required: ["key", "disposition"],
      },
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
        ...(args.needs_maintainer !== undefined ? { needs_maintainer: args.needs_maintainer } : {}),
        ...(args.proof !== undefined ? { proof: args.proof } : {}),
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
      const result = store.setVerdict({ state: args.state, reason: args.reason, incomplete: args.incomplete });
      return result.ok ? { ok: true, text: JSON.stringify({ recorded: true }) } : { ok: false, text: result.error };
    }
    case "previous_findings": {
      return { ok: true, text: JSON.stringify({ findings: store.listPreviousFindings() }) };
    }
    case "set_disposition": {
      const result = store.setDisposition(args as unknown);
      return result.ok
        ? { ok: true, text: JSON.stringify("id" in result && result.id ? { id: result.id } : { recorded: true }) }
        : { ok: false, text: result.error };
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
            serverInfo: { name: REVIEW_MCP_SERVER_NAME, version: "1.0.0" },
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
  return payload.result?.serverInfo?.name === REVIEW_MCP_SERVER_NAME;
}

// ── Runner MCP configs ─────────────────────────────────────────────────────
// Shared shapes for the parent-owned MCP servers. The review (`jumi-review`)
// and worker (`jumi-worker`) servers share the same wire shape; only the
// server name differs, so per-runner helpers take the name and the two
// servers delegate instead of copying the shape per runner.

/** OpenCode MCP entry merged into the per-spawn global `opencode.json`. */
export function openCodeMcpEntry(url: string, token: string): Record<string, unknown> {
  return { type: "remote", url, headers: { Authorization: `Bearer ${token}` } };
}

/** OpenCode MCP entry for the review server. */
export function openCodeReviewMcpEntry(url: string, token: string): Record<string, unknown> {
  return openCodeMcpEntry(url, token);
}

/** Claude `--mcp-config` file content for one server name. */
export function claudeMcpConfigFor(serverName: string, url: string, token: string): string {
  return `${JSON.stringify(
    { mcpServers: { [serverName]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2
  )}\n`;
}

/** Claude `--mcp-config` file content. `--strict-mcp-config` keeps the repo's `.mcp.json` from shadowing it. */
export function claudeReviewMcpConfig(url: string, token: string): string {
  return claudeMcpConfigFor(REVIEW_MCP_SERVER_NAME, url, token);
}

export function claudeMcpArgs(configPath: string): string[] {
  return ["--mcp-config", configPath, "--strict-mcp-config"];
}

/** Codex `config.toml` snippet registering one MCP server. Real TOML: parsed with `Bun.TOML.parse` in tests. */
export function codexMcpTomlEntry(serverName: string, url: string, token: string): string {
  return `\n[mcp_servers.${serverName}]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n`;
}

/** Agy `mcp_config.json` server value for one MCP server. */
export function agyMcpServerEntry(url: string, token: string): Record<string, unknown> {
  return { serverUrl: url, headers: { Authorization: `Bearer ${token}` } };
}
