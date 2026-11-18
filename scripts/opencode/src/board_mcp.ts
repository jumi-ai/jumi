/**
 * Read-only board MCP server for operator agents, plus an opt-in `kick`
 * tool behind a separate bearer.
 *
 * Served by the router on the board listener (`POST /mcp`, same port as the
 * operator board, never the webhook host). Stateless Streamable HTTP: one
 * `McpServer` plus one `WebStandardStreamableHTTPServerTransport` per
 * request, no SSE, no session. Auth happens at the HTTP layer in `board.ts`
 * (`BOARD_MCP_TOKEN` bearer for reads, `BOARD_MCP_KICK_TOKEN` bearer for the
 * kick tool); this module never reads edge identity headers and never sees
 * the bearer.
 *
 * Tools:
 * - `board`: the same `in_progress` / `needs_kick` / `sitting` groups as
 *   `GET /api/board`, for this factory only (no peer hop). Optional
 *   owner/repo filter. Kick payloads are returned as data; nothing performs
 *   them.
 * - `issue_history`: ledger rows where the number is the `prNumber` or the
 *   `issueNumber` (shared number space), newest first, capped at 50, plus the
 *   skip latch, the router sit, and matching kick-log entries.
 * - `runners`: current runner cooldowns (engine and worker roles) plus runner
 *   quota resets, so "why is nothing running?" has an answer.
 * - `kick` (only when the kick bearer authenticated this request): runs the
 *   same kick as `POST /api/board/kick` for this factory only (no peer hop).
 *   The kick-log actor is always `board-mcp`, never a caller argument.
 *
 * Every returned string passes through `redactGitSecrets` with the router's
 * known secrets. Long ledger strings (`error`, `resultReason`) are truncated
 * to 2 KiB with a visible marker. One log line per call; never the bearer.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { type BoardItem, buildBoardGroups } from "./board.ts";
import type { ReviewJobStore } from "./review_jobs.ts";
import { errorMessage } from "./util/error.ts";
import { redactGitSecrets } from "./workspace.ts";

/** Env: bearer for the read-only board MCP endpoint. Unset or empty disables `/mcp` (404). */
export const BOARD_MCP_TOKEN_ENV = "BOARD_MCP_TOKEN";

/** Env: bearer that additionally arms the `kick` tool on the board MCP endpoint. Unset or empty means no kick tool. */
export const BOARD_MCP_KICK_TOKEN_ENV = "BOARD_MCP_KICK_TOKEN";

/** MCP tool that performs the same kick as `POST /api/board/kick`, local factory only. */
export const BOARD_MCP_KICK_TOOL_NAME = "kick";

/** Kick-log actor for every MCP kick. Never taken from a tool argument. */
export const BOARD_MCP_KICK_ACTOR = "board-mcp";

/** Board listener path serving the Streamable HTTP endpoint. POST only. */
export const BOARD_MCP_PATH = "/mcp";

export const BOARD_MCP_SERVER_NAME = "jumi-board";

export const BOARD_MCP_TOOL_NAMES = ["board", "issue_history", "runners"] as const;

export type BoardMcpToolName = (typeof BOARD_MCP_TOOL_NAMES)[number];

/** Ledger strings longer than this are cut per field; the marker shows the cut. */
export const BOARD_MCP_TEXT_MAX_BYTES = 2 * 1024;

export const BOARD_MCP_TRUNCATION_MARKER = "…[truncated at 2 KiB]";

/** Newest `issue_history` rows returned at most. */
export const BOARD_MCP_HISTORY_LIMIT = 50;

export interface BoardMcpDeps {
  store: ReviewJobStore;
  /** Local factory name for board groups. Defaults to homelab gitea. */
  forge?: string;
  /** Router secrets redacted from every returned string (bot token, webhook secrets, peer/MCP tokens). */
  secrets?: Array<string | undefined>;
  logger?: (message: string) => void;
  /**
   * True when this request authenticated with the kick bearer. Only then is
   * the `kick` tool listed; a `kick` call without it is a tool error and
   * never a kick.
   */
  canKick?: boolean;
  /**
   * Runs one kick through the same body-level handlers as
   * `POST /api/board/kick` (same validation, refusals, kick-log entries and
   * idempotency replay) with the actor fixed to `board-mcp`. Local factory
   * only: never forwards over the peer hop. The returned `Response` carries
   * the same JSON the HTTP route returns.
   */
  runKick?: (body: unknown, idempotencyKey: string) => Promise<Response>;
}

/** Cut a ledger string at a byte boundary; short strings pass through untouched. */
export function truncateBoardMcpText(text: string, maxBytes: number = BOARD_MCP_TEXT_MAX_BYTES): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const byteLength = encoder.encode(ch).byteLength;
    if (used + byteLength > maxBytes) break;
    out += ch;
    used += byteLength;
  }
  return `${out}\n${BOARD_MCP_TRUNCATION_MARKER}`;
}

function redact(text: string, secrets: Array<string | undefined>): string {
  return redactGitSecrets(text, secrets);
}

function redactNullable(value: string | null | undefined, secrets: Array<string | undefined>): string | null {
  return value == null ? null : redact(value, secrets);
}

function redactBoardItem(item: BoardItem, secrets: Array<string | undefined>): BoardItem {
  return {
    ...item,
    reason: redact(item.reason, secrets),
    ...(item.message !== undefined ? { message: redact(item.message, secrets) } : {}),
    owner: redact(item.owner, secrets),
    repo: redact(item.repo, secrets),
    ...(item.commit !== undefined ? { commit: redact(item.commit, secrets) } : {}),
    ...(item.headSha !== undefined ? { headSha: redact(item.headSha, secrets) } : {}),
    ...(item.kick !== undefined
      ? { kick: { effect: redact(item.kick.effect, secrets), kick: redact(item.kick.kick, secrets) } }
      : {}),
  };
}

function mcpResult(text: string): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text }] };
}

function mcpError(text: string): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return { content: [{ type: "text", text }], isError: true };
}

export function createBoardMcpServer(deps: BoardMcpDeps): McpServer {
  const store = deps.store;
  const forge = (deps.forge ?? "gitea").trim() || "gitea";
  const secrets = deps.secrets ?? [];
  const logger = deps.logger ?? (() => undefined);
  const server = new McpServer({ name: BOARD_MCP_SERVER_NAME, version: "1.0.0" });

  server.registerTool(
    "board",
    {
      description:
        "Current operator-board queue for this factory only (no peer hop): in_progress, needs_kick, sitting. Optional owner/repo filter. Kick payloads are data only; nothing is performed.",
      inputSchema: {
        owner: z.string().optional().describe("Filter to this owner (exact match)"),
        repo: z.string().optional().describe("Filter to this repo (exact match)"),
      },
    },
    async (args: { owner?: string; repo?: string }) => {
      const started = Date.now();
      const coords = args.owner?.trim() && args.repo?.trim() ? `${args.owner.trim()}/${args.repo.trim()}#-` : "-/-#-";
      try {
        const owner = (args.owner ?? "").trim();
        const repo = (args.repo ?? "").trim();
        const groups = await buildBoardGroups(store, forge);
        const keep = (item: BoardItem): boolean =>
          (owner === "" || item.owner === owner) && (repo === "" || item.repo === repo);
        const in_progress = groups.in_progress.filter(keep).map((item) => redactBoardItem(item, secrets));
        const needs_kick = groups.needs_kick.filter(keep).map((item) => redactBoardItem(item, secrets));
        const sitting = groups.sitting.filter(keep).map((item) => redactBoardItem(item, secrets));
        const rows = in_progress.length + needs_kick.length + sitting.length;
        logger(`[board-mcp] tool=board ${coords} rows=${rows} ms=${Date.now() - started}`);
        return mcpResult(redact(JSON.stringify({ forge, in_progress, needs_kick, sitting }), secrets));
      } catch (err) {
        logger(`[board-mcp] tool=board ${coords} rows=0 ms=${Date.now() - started}`);
        return mcpError(redact(`board unavailable: ${errorMessage(err)}`, secrets));
      }
    }
  );

  server.registerTool(
    "issue_history",
    {
      description:
        "Ledger rows where the number is the prNumber or the issueNumber (shared number space), any kind and state, newest first (at most 50), plus the skip latch, the router sit, and matching kick-log entries. Payload and review markdown are omitted.",
      inputSchema: {
        owner: z.string().min(1).describe("Repository owner (exact match)"),
        repo: z.string().min(1).describe("Repository name (exact match)"),
        number: z.number().int().positive().describe("Issue or pull number (shared number space)"),
      },
    },
    async (args: { owner: string; repo: string; number: number }) => {
      const started = Date.now();
      const owner = args.owner.trim();
      const repo = args.repo.trim();
      const number = args.number;
      const coords = `${owner}/${repo}#${number}`;
      try {
        const rows = await store.listRowsForNumber(owner, repo, number, BOARD_MCP_HISTORY_LIMIT);
        const history = rows.map((row) => ({
          id: row.id,
          kind: redact(row.kind, secrets),
          state: redact(row.state, secrets),
          attempt: row.attempt,
          headSha: redact(row.headSha, secrets),
          issueNumber: row.issueNumber,
          prNumber: row.prNumber,
          resultReason: redactNullable(
            row.resultReason == null ? null : truncateBoardMcpText(row.resultReason),
            secrets
          ),
          resultRunner: redactNullable(row.resultRunner, secrets),
          error: redactNullable(row.error == null ? null : truncateBoardMcpText(row.error), secrets),
          leasedBy: redactNullable(row.leasedBy, secrets),
          cancelRequested: row.cancelRequested,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }));
        const latch = await store.readIssueSkipLatch(owner, repo, number);
        const sit = await store.sits.get(owner, repo, number);
        const kickLog = await store.listKickLog(500);
        const payload = {
          owner: redact(owner, secrets),
          repo: redact(repo, secrets),
          number,
          rows: history,
          skipLatch: { generation: latch.generation, skipReason: redactNullable(latch.skipReason, secrets) },
          sit: sit
            ? {
                owner: redact(sit.owner, secrets),
                repo: redact(sit.repo, secrets),
                number: sit.number,
                reason: redact(sit.reason, secrets),
                decidedAt: sit.decidedAt,
              }
            : null,
          kickLog: kickLog
            .filter((entry) => entry.owner === owner && entry.repo === repo && entry.number === number)
            .map((entry) => ({
              id: entry.id,
              actor: redact(entry.actor, secrets),
              owner: redact(entry.owner, secrets),
              repo: redact(entry.repo, secrets),
              number: entry.number,
              commit: redact(entry.commit, secrets),
              kick: redact(entry.kick, secrets),
              result: redact(entry.result, secrets),
              terminalJobId: entry.terminalJobId,
              newJobId: entry.newJobId,
              createdAt: entry.createdAt,
            })),
        };
        logger(`[board-mcp] tool=issue_history ${coords} rows=${history.length} ms=${Date.now() - started}`);
        return mcpResult(redact(JSON.stringify(payload), secrets));
      } catch (err) {
        logger(`[board-mcp] tool=issue_history ${coords} rows=0 ms=${Date.now() - started}`);
        return mcpError(redact(`issue_history unavailable: ${errorMessage(err)}`, secrets));
      }
    }
  );

  server.registerTool(
    "runners",
    {
      description:
        "Current runner cooldowns (engine and worker roles) and runner quota resets, so 'why is nothing running?' has an answer.",
    },
    async () => {
      const started = Date.now();
      try {
        const cooldowns: Array<{
          role: string;
          runner: string;
          untilMs: number;
          reason: string | null;
          source: string | null;
          fingerprint: string | null;
        }> = [];
        if (typeof store.listRunnerCooldowns === "function") {
          for (const role of ["engine", "worker"] as const) {
            const rows = await store.listRunnerCooldowns(role);
            for (const row of rows) {
              cooldowns.push({
                role,
                runner: redact(row.runner, secrets),
                untilMs: row.untilMs,
                reason: redactNullable(row.reason, secrets),
                source: redactNullable(row.source, secrets),
                fingerprint: redactNullable(row.fingerprint, secrets),
              });
            }
          }
          cooldowns.sort((a, b) => `${a.role}\0${a.runner}`.localeCompare(`${b.role}\0${b.runner}`));
        }
        const quotaResets = (await store.getRunnerQuotaResets())
          .map((row) => ({ runner: redact(row.runner, secrets), resetAtSeconds: row.resetAtSeconds }))
          .sort((a, b) => a.runner.localeCompare(b.runner));
        logger(
          `[board-mcp] tool=runners -/-#- rows=${cooldowns.length + quotaResets.length} ms=${Date.now() - started}`
        );
        return mcpResult(redact(JSON.stringify({ cooldowns, quotaResets }), secrets));
      } catch (err) {
        logger(`[board-mcp] tool=runners -/-#- rows=0 ms=${Date.now() - started}`);
        return mcpError(redact(`runners unavailable: ${errorMessage(err)}`, secrets));
      }
    }
  );

  if (deps.canKick === true) {
    const runKick = deps.runKick;
    server.registerTool(
      BOARD_MCP_KICK_TOOL_NAME,
      {
        description:
          "Perform the board kick for one row of this factory (same effect as POST /api/board/kick): sit-clear, same-commit requeue, reopen, implement, or stuck. Local factory only: a peer-forge argument is refused and nothing is forwarded. The kick-log actor is always board-mcp.",
        inputSchema: {
          owner: z.string().min(1).describe("Repository owner (exact match)"),
          repo: z.string().min(1).describe("Repository name (exact match)"),
          number: z.number().int().positive().describe("Issue or pull number (shared number space)"),
          kick: z
            .string()
            .min(1)
            .describe("Kick id from the board row (sit-clear, the requeue id, reopen, implement, stuck)"),
          commit: z.string().optional().describe("Commit SHA (required for requeue kicks, as on the HTTP route)"),
          idempotency_key: z
            .string()
            .optional()
            .describe("Optional idempotency key; a repeat replays the first outcome"),
          forge: z.string().optional().describe("Must be absent or this factory; a peer forge is refused"),
        },
      },
      async (args: {
        owner: string;
        repo: string;
        number: number;
        kick: string;
        commit?: string;
        idempotency_key?: string;
        forge?: string;
      }) => {
        const started = Date.now();
        const owner = args.owner.trim();
        const repo = args.repo.trim();
        const number = args.number;
        const kickId = args.kick.trim();
        const coords = `${owner}/${repo}#${number}`;
        const logLine = (code: string): string =>
          redact(
            `[board-mcp] tool=kick ${coords} kick=${JSON.stringify(kickId)} result=${code} ms=${Date.now() - started}`,
            secrets
          );
        try {
          if (typeof runKick !== "function") {
            logger(logLine("error"));
            return mcpError(redact("kick unavailable", secrets));
          }
          const body: Record<string, unknown> = { owner, repo, number, kick: kickId };
          if (typeof args.commit === "string" && args.commit.trim() !== "") body.commit = args.commit.trim();
          if (typeof args.idempotency_key === "string" && args.idempotency_key.trim() !== "") {
            body.idempotency_key = args.idempotency_key.trim();
          }
          if (typeof args.forge === "string" && args.forge.trim() !== "") body.forge = args.forge.trim();
          const response = await runKick(body, "");
          let payload: unknown = { error: "kick unavailable" };
          try {
            payload = await response.json();
          } catch {
            // Keep the fallback payload.
          }
          const rec = (payload ?? {}) as Record<string, unknown>;
          const code =
            typeof rec.code === "string" && rec.code.trim() !== "" ? rec.code : rec.ok === true ? "ok" : "error";
          logger(logLine(code));
          const text = redact(JSON.stringify(payload), secrets);
          if (response.status >= 200 && response.status < 300) return mcpResult(text);
          return mcpError(text);
        } catch (err) {
          logger(logLine("error"));
          return mcpError(redact(`kick unavailable: ${errorMessage(err)}`, secrets));
        }
      }
    );
  }

  return server;
}

/**
 * Serve one Streamable HTTP request on a throwaway stateless transport. Auth
 * already happened at the HTTP layer; the bearer never reaches this module.
 *
 * The transport must stay alive until the response body is fully consumed:
 * closing it before Bun streams the SSE body back would truncate every tool
 * result. Cleanup runs when the piped stream ends or is cancelled.
 */
export async function handleBoardMcp(request: Request, deps: BoardMcpDeps): Promise<Response> {
  const server = createBoardMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const cleanup = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  };
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (!response.body) {
      await cleanup();
      return response;
    }
    const source = response.body;
    let cleaned = false;
    const cleanupOnce = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      await cleanup();
    };
    const piped = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = source.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          reader.releaseLock();
          await cleanupOnce();
        }
      },
      async cancel() {
        await cleanupOnce();
      },
    });
    return new Response(piped, { status: response.status, headers: response.headers });
  } catch (err) {
    (deps.logger ?? (() => undefined))(`[board-mcp] unavailable: ${errorMessage(err)}`);
    await cleanup();
    return new Response(JSON.stringify({ error: "mcp unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}
