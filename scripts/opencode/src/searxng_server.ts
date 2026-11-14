#!/usr/bin/env bun
/**
 * Bundled SearXNG search MCP server (stdio).
 *
 * One server, one tool (`search`): the same web search for every runner, with
 * no native-search fallback anywhere. The only configuration is the base URL
 * and the forge host, passed per spawn by the runner's MCP registration; this
 * process reads nothing else from the parent environment.
 *
 * Run by Bun from the installed image: `bun <path>`. No Node, no network
 * fetch at job time beyond the deployer's own instance.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  formatSearxngResult,
  normalizeMaxResults,
  querySearxng,
  SEARXNG_SERVER_FORGE_HOST_ENV,
  SEARXNG_SERVER_NAME,
  SEARXNG_SERVER_URL_ENV,
  SEARXNG_TOOL_NAME,
  SearxngError,
} from "./searxng.ts";

const server = new McpServer({ name: SEARXNG_SERVER_NAME, version: "1.0.0" });

server.registerTool(
  SEARXNG_TOOL_NAME,
  {
    description:
      "Search the web through the deployer's SearXNG instance. Returns title, URL and a capped snippet per result. Results on the forge host are dropped.",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      max_results: z.number().int().optional().describe("Maximum results to return (default 8, max 20)"),
    },
  },
  async ({ query, max_results }: { query: string; max_results?: number }) => {
    const baseUrl = process.env[SEARXNG_SERVER_URL_ENV]?.trim();
    const forgeHost = process.env[SEARXNG_SERVER_FORGE_HOST_ENV]?.trim() ?? "";
    if (!baseUrl) {
      return {
        content: [{ type: "text" as const, text: `SearXNG search failed: ${SEARXNG_SERVER_URL_ENV} is not set` }],
        isError: true,
      };
    }
    let max: number;
    try {
      max = normalizeMaxResults(max_results);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `SearXNG search failed: ${message}` }], isError: true };
    }
    try {
      const results = await querySearxng(baseUrl, query, max, forgeHost);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No results." }] };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: results.map((result, index) => formatSearxngResult(result, index)).join("\n"),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof SearxngError || err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
