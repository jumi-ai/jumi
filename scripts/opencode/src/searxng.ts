import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forgeDenyHost } from "./forge_webfetch.ts";
import { AGY_RUNNER_TYPE, CLAUDE_RUNNER_TYPE, CODEX_RUNNER_TYPE, OPENCODE_RUNNER_TYPE } from "./runner_types.ts";

/**
 * One deployer setting for web search on every runner.
 *
 * `JUMI_SEARXNG_URL` is the base URL of a SearXNG instance, queried through
 * its JSON API (`GET /search?q=<query>&format=json`). Unset or blank means
 * "not configured" and every runner keeps today's behaviour. A value that is
 * not an `http(s)` URL is rejected at startup with a message naming the
 * variable. It is deployer-only: it names network infrastructure, so there is
 * no `.jumi.yml` key and a repository cannot point agents at an endpoint of
 * its choice. No authentication in this change.
 */
export const SEARXNG_URL_ENV = "JUMI_SEARXNG_URL";

/** MCP server name every runner registers (Claude sees `mcp__searxng__search`). */
export const SEARXNG_SERVER_NAME = "searxng";
/** The only tool the bundled MCP server exposes. */
export const SEARXNG_TOOL_NAME = "search";
/** Claude-side tool name (`mcp__<server>__<tool>`). */
export const SEARXNG_CLAUDE_TOOL = "mcp__searxng__search";
/** OpenCode-side tool name (`<server>_<tool>`). */
export const SEARXNG_OPENCODE_TOOL = "searxng_search";

/**
 * The only environment the bundled MCP server reads. The server process gets
 * the base URL and the forge host, nothing else from the parent environment:
 * every runner passes exactly these two through its own MCP registration.
 */
export const SEARXNG_SERVER_URL_ENV = "SEARXNG_URL";
export const SEARXNG_SERVER_FORGE_HOST_ENV = "SEARXNG_FORGE_HOST";

/** A search that takes longer than this returns a tool error, never hangs. */
export const SEARXNG_TIMEOUT_MS = 15_000;
export const SEARXNG_DEFAULT_RESULTS = 8;
export const SEARXNG_MAX_RESULTS = 20;
export const SEARXNG_SNIPPET_MAX_CHARS = 500;

/** Base URL validation failure. The message always names the variable. */
export function parseSearxngUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ${SEARXNG_URL_ENV}: not an http(s) URL: ${trimmed}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid ${SEARXNG_URL_ENV}: not an http(s) URL: ${trimmed}`);
  }
  return trimmed.replace(/\/+$/, "");
}

/** Deploy-time setting for this process, or undefined when not configured. */
export function searxngUrlFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return parseSearxngUrl(env[SEARXNG_URL_ENV]);
}

/** Absolute path of the bundled stdio MCP server, in the repo and the image. */
export function searxngServerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "searxng_server.ts");
}

export interface SearxngResult {
  title: string;
  url: string;
  snippet: string;
}

export class SearxngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearxngError";
  }
}

/** Clamp `max_results`: default 8, hard max 20. Rejects non-numbers. */
export function normalizeMaxResults(value: unknown): number {
  if (value === undefined || value === null) return SEARXNG_DEFAULT_RESULTS;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new SearxngError("max_results must be a number");
  }
  return Math.min(SEARXNG_MAX_RESULTS, Math.max(1, Math.floor(n)));
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Forge host plus its subdomains: the same scope the fetch denies refuse. */
export function isForgeSearchResult(url: string, forgeHost: string): boolean {
  const host = hostnameOf(url);
  const forge = forgeHost.trim().toLowerCase().replace(/:\d+$/, "");
  if (!host || !forge) return false;
  return host === forge || host.endsWith(`.${forge}`);
}

function capSnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SEARXNG_SNIPPET_MAX_CHARS) return flat;
  return `${flat.slice(0, SEARXNG_SNIPPET_MAX_CHARS)}…`;
}

/**
 * Query the instance and return title/URL/snippet per result, nothing else.
 * Results on the forge host are dropped. Every failure mode — unreachable
 * instance, non-200 reply, timeout, unexpected shape — throws a `SearxngError`
 * that says so. Never falls back to a native search tool: there is no other
 * code path here.
 */
export async function querySearxng(
  baseUrl: string,
  query: string,
  maxResults: number,
  forgeHost: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SEARXNG_TIMEOUT_MS
): Promise<SearxngResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new SearxngError("query must not be empty");
  const target = `${baseUrl}/search?q=${encodeURIComponent(trimmed)}&format=json`;
  let response: Response;
  try {
    response = await fetchImpl(target, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new SearxngError(`SearXNG search failed: timed out querying ${baseUrl}`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new SearxngError(`SearXNG search failed: cannot reach ${baseUrl} (${reason})`);
  }
  if (!response.ok) {
    const hint = response.status === 403 ? " (the instance may not have json in its search.formats)" : "";
    throw new SearxngError(`SearXNG search failed: ${baseUrl} answered ${response.status}${hint}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SearxngError(`SearXNG search failed: unexpected reply from ${baseUrl}`);
  }
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new SearxngError(`SearXNG search failed: unexpected reply from ${baseUrl}`);
  }
  const out: SearxngResult[] = [];
  for (const entry of results) {
    if (out.length >= maxResults) break;
    if (!entry || typeof entry !== "object") continue;
    const { title, url, content } = entry as Record<string, unknown>;
    if (typeof url !== "string" || !url) continue;
    if (isForgeSearchResult(url, forgeHost)) continue;
    out.push({
      title: typeof title === "string" ? title : "",
      url,
      snippet: typeof content === "string" ? capSnippet(content) : "",
    });
  }
  return out;
}

/** Render one search result line for the tool response. */
export function formatSearxngResult(result: SearxngResult, index: number): string {
  const head = `${index + 1}. ${result.title || result.url}`.trim();
  const link = `   URL: ${result.url}`;
  return result.snippet ? `${head}\n${link}\n   ${result.snippet}` : `${head}\n${link}`;
}

// ── Per-runner MCP registration ─────────────────────────────────────────────

/** Forge host for this spawn, from the same env the fetch denies derive from. */
export function searxngForgeHost(extraEnv?: Record<string, string>): string {
  return forgeDenyHost(extraEnv);
}

/** Claude `--mcp-config` JSON: our server beside no other Jumi entry. */
export function claudeSearxngMcpConfig(baseUrl: string, forgeHost: string): string {
  return JSON.stringify({
    mcpServers: {
      [SEARXNG_SERVER_NAME]: {
        command: "bun",
        args: [searxngServerPath()],
        env: { [SEARXNG_SERVER_URL_ENV]: baseUrl, [SEARXNG_SERVER_FORGE_HOST_ENV]: forgeHost },
        alwaysLoad: true,
      },
    },
  });
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function tomlString(value: string): string {
  if (hasControlChars(value)) {
    throw new Error(`Invalid ${SEARXNG_URL_ENV}: value carries control characters`);
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Codex per-spawn `-c mcp_servers.searxng.*` overrides. `-c` outranks the
 * checkout's `.codex` config, so a repository cannot replace or shadow the
 * server. Values are TOML, matching the existing hardening args.
 */
export function codexSearxngArgs(baseUrl: string, forgeHost: string): string[] {
  const prefix = `mcp_servers.${SEARXNG_SERVER_NAME}`;
  return [
    "-c",
    `${prefix}.command="bun"`,
    "-c",
    `${prefix}.args=[${tomlString(searxngServerPath())}]`,
    "-c",
    `${prefix}.env={ ${SEARXNG_SERVER_URL_ENV} = ${tomlString(baseUrl)}, ${SEARXNG_SERVER_FORGE_HOST_ENV} = ${tomlString(forgeHost)} }`,
  ];
}

/** OpenCode inline-config `mcp.servers.searxng` object. */
export function openCodeSearxngServer(baseUrl: string, forgeHost: string): Record<string, unknown> {
  return {
    type: "local",
    command: ["bun", searxngServerPath()],
    // Code Mode groups MCP tools behind one wrapper; `false` exposes
    // `searxng_search` directly so the prompt and permission name one tool.
    codemode: false,
    environment: { [SEARXNG_SERVER_URL_ENV]: baseUrl, [SEARXNG_SERVER_FORGE_HOST_ENV]: forgeHost },
  };
}

// ── Runner web capabilities for prompt text ─────────────────────────────────

export type WebSearchBackend = "native" | "searxng" | null;

export interface RunnerWebCapabilities {
  search: WebSearchBackend;
  fetch: boolean;
}

/**
 * What web tools a runner really has, with and without the variable.
 * Codex has search but no fetch tool; Claude and agy have fetch but no
 * native search; OpenCode has both natively.
 */
export function webCapabilitiesForRunner(
  runnerType: string | undefined,
  searxngConfigured: boolean
): RunnerWebCapabilities {
  if (runnerType === CLAUDE_RUNNER_TYPE) {
    return { search: searxngConfigured ? "searxng" : null, fetch: true };
  }
  if (runnerType === CODEX_RUNNER_TYPE) {
    return { search: searxngConfigured ? "searxng" : "native", fetch: false };
  }
  if (runnerType === AGY_RUNNER_TYPE) {
    return { search: searxngConfigured ? "searxng" : null, fetch: true };
  }
  return { search: searxngConfigured ? "searxng" : "native", fetch: true };
}

/** Exact tool name the prompt may tell this runner to call for search. */
export function searchToolLabel(runnerType: string | undefined, cap: RunnerWebCapabilities): string | null {
  if (cap.search === null) return null;
  if (cap.search === "native") {
    if (runnerType === CODEX_RUNNER_TYPE) return "web search";
    return "`websearch`";
  }
  if (runnerType === CLAUDE_RUNNER_TYPE) return "`mcp__searxng__search`";
  if (runnerType === OPENCODE_RUNNER_TYPE) return "`searxng_search`";
  if (runnerType === AGY_RUNNER_TYPE) return "the `searxng` search tool (through `call_mcp_tool`)";
  return "the `searxng` search tool";
}

/** Exact tool name the prompt may tell this runner to call for fetch. */
export function fetchToolLabel(runnerType: string | undefined): string {
  if (runnerType === CLAUDE_RUNNER_TYPE) return "`WebFetch`";
  if (runnerType === AGY_RUNNER_TYPE) return "`read_url_content`";
  return "`webfetch`";
}

/**
 * The one shared evidence rule, worded from the runner's real tools. The
 * reviewer preamble, the blocking-question guidance and the worker scope all
 * embed this, so the three agree with each other for the same runner.
 */
export function webEvidenceGuidance(runnerType: string | undefined, cap: RunnerWebCapabilities): string {
  const search = searchToolLabel(runnerType, cap);
  const fetch = fetchToolLabel(runnerType);
  if (search && cap.fetch) {
    return (
      `Use ${search} to find a URL, then fetch that exact URL with ${fetch}; ` +
      `do not construct file or release URLs from memory.`
    );
  }
  if (search) {
    return (
      `There is no fetch tool: use ${search} and cite the exact result URLs as the evidence; ` +
      `do not construct file or release URLs from memory.`
    );
  }
  if (cap.fetch) {
    return (
      `There is no web search tool: fetch exact URLs with ${fetch}; ` +
      `do not construct file or release URLs from memory.`
    );
  }
  return (
    `There is no web search or fetch tool: use only the checkout and the injected context; ` +
    `do not construct file or release URLs from memory.`
  );
}
