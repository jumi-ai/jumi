#!/usr/bin/env bun
/**
 * Prove the pinned `agy` honors the per-spawn MCP settings file production
 * writes: with `JUMI_SEARXNG_URL` set, `runAgy` registers the searxng server
 * in `$HOME/.gemini/config/mcp_config.json`; without it, no MCP entry is
 * added. `agy mcp list` against each seeded HOME records which case applies
 * against the installed binary, without spending a model turn.
 *
 * `list` only proves registration: upstream reports show an enabled stdio
 * server is not necessarily started in headless print mode. So the probe also
 * drives the registered command itself through a stdio MCP handshake
 * (`initialize` + `tools/list`), proving bare `command: "bun"` resolves under
 * the spawn `PATH` and the bundled server starts against the production
 * install (a missing SDK dep would fail here, not at the first model call).
 * Bare command names are the documented shape
 * (https://antigravity.google/docs/mcp/: `command` is an "executable path or
 * command name used to launch a local stdio MCP server process").
 *
 * Exit 0 when every case matches, 1 otherwise.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGY_MCP_CONFIG_DIR, AGY_MCP_CONFIG_FILE, ensureAgyMcpServer, pruneAgyMcpServer } from "./agy.ts";
import {
  SEARXNG_SERVER_FORGE_HOST_ENV,
  SEARXNG_SERVER_NAME,
  SEARXNG_SERVER_URL_ENV,
  SEARXNG_TOOL_NAME,
  searxngServerPath,
  searxngUrlFromEnv,
} from "./searxng.ts";

/** Example homelab host for manual probing only; production derives the deny host from config. */
const PROBE_DENY_DOMAIN = "kirmanak.stream";

const RUN_TIMEOUT_MS = 45_000;

export interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly observed: string;
}

async function mcpList(home: string, workdir: string): Promise<{ code: number; output: string; timedOut: boolean }> {
  const proc = Bun.spawn(["agy", "mcp", "list"], {
    cwd: workdir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", TMPDIR: workdir },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, RUN_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, output: `${stdout}\n${stderr}`, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function listsSearxng(output: string): boolean {
  return output.split("\n").some((line) => line.includes(SEARXNG_SERVER_NAME) && line.includes("enabled"));
}

/**
 * Drive the exact registered command (`bun` + the bundled server path) through
 * a stdio MCP handshake, under the same `PATH` the spawn gets. Asserts the
 * server answers `tools/list` with exactly the one tool production exposes.
 * The server stays up after answering, so the probe kills it once the answer
 * arrives; a 15 s cap fails closed instead of hanging the image job.
 */
async function handshakeSearxngServer(): Promise<CaseResult> {
  const name = "the registered command resolves and the server answers tools/list with exactly one tool";
  const frames = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "jumi-agy-mcp-probe", version: "0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const input = `${frames.map((message) => JSON.stringify(message)).join("\n")}\n`;
  const proc = Bun.spawn(["bun", searxngServerPath()], {
    stdin: new Response(input),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      [SEARXNG_SERVER_URL_ENV]: "http://127.0.0.1:9",
      [SEARXNG_SERVER_FORGE_HOST_ENV]: PROBE_DENY_DOMAIN,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    },
  });
  const deadline = Date.now() + 15_000;
  let buffer = "";
  try {
    const reader = proc.stdout.getReader();
    try {
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value, { stream: true });
        if (buffer.split("\n").some((line) => line.includes('"id":2'))) break;
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    proc.kill();
  }
  const tools: string[] = [];
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown; result?: { tools?: { name?: unknown }[] } };
      if (parsed.id === 2 && Array.isArray(parsed.result?.tools)) {
        for (const tool of parsed.result.tools) {
          if (tool && typeof tool.name === "string") tools.push(tool.name);
        }
      }
    } catch {
      // Non-JSON framing line; the id-2 check below reports the miss.
    }
  }
  const stderr = await new Response(proc.stderr).text().catch(() => "");
  await proc.exited.catch(() => undefined);
  if (tools.length === 1 && tools[0] === SEARXNG_TOOL_NAME) {
    return { name, ok: true, observed: `stdio handshake lists exactly one tool: ${tools[0]}` };
  }
  return {
    name,
    ok: false,
    observed: `tools=[${tools.join(",") || "<none>"}] stderr=${stderr.trim().slice(-200) || "<empty>"}`,
  };
}

async function main(): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-agy-mcp-probe-"));
  const results: CaseResult[] = [];
  try {
    const workdir = join(dir, "workspace");
    await Bun.$`mkdir -p ${workdir} && git init -q`.cwd(dir).quiet();
    // Configured: the production registration, then the binary reads it back.
    const configuredHome = join(dir, "home-configured");
    const configured = searxngUrlFromEnv({ JUMI_SEARXNG_URL: "http://127.0.0.1:9" });
    if (!configured) throw new Error("probe cannot parse its own stub URL");
    await ensureAgyMcpServer(configuredHome, configured, PROBE_DENY_DOMAIN);
    const listed = await mcpList(configuredHome, workdir);
    results.push({
      name: "configured: the pinned agy lists the spawn's searxng server as enabled",
      ok: !listed.timedOut && listed.code === 0 && listsSearxng(listed.output),
      observed: listed.timedOut
        ? "agy mcp list hung"
        : listed.code !== 0
          ? `exit ${listed.code}: ${listed.output.slice(-300)}`
          : listsSearxng(listed.output)
            ? "searxng enabled"
            : `no enabled searxng entry: ${listed.output.slice(-300)}`,
    });
    // The registration lives beside other servers, not instead of them.
    const raw = await Bun.file(join(configuredHome, AGY_MCP_CONFIG_DIR, AGY_MCP_CONFIG_FILE)).text();
    results.push({
      name: "configured: the settings file names the bundled server",
      ok: raw.includes(SEARXNG_SERVER_NAME) && raw.includes("searxng_server.ts"),
      observed: raw.includes(SEARXNG_SERVER_NAME) ? "mcp_config.json carries searxng" : raw.slice(0, 200),
    });
    // Registration is not startup: drive the registered command itself.
    results.push(await handshakeSearxngServer());
    // Unconfigured: pruning leaves no entry, and the binary agrees.
    const bareHome = join(dir, "home-bare");
    await pruneAgyMcpServer(bareHome);
    const bare = await mcpList(bareHome, workdir);
    results.push({
      name: "unconfigured: agy settings gain no MCP entry",
      ok: !bare.timedOut && bare.code === 0 && !bare.output.includes(SEARXNG_SERVER_NAME),
      observed: bare.timedOut
        ? "agy mcp list hung"
        : bare.code !== 0
          ? `exit ${bare.code}: ${bare.output.slice(-300)}`
          : bare.output.includes(SEARXNG_SERVER_NAME)
            ? "unexpected searxng entry"
            : "no searxng entry",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const { name, ok, observed } of results) console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${observed}`);
  const failures = results.filter((r) => !r.ok).length;
  if (failures > 0) {
    console.error(`agy mcp probe: ${failures}/${results.length} check(s) failed against the installed binary`);
    return 1;
  }
  console.log(`agy mcp probe: ${results.length}/${results.length} checks pass against the installed agy binary`);
  return 0;
}

if (import.meta.main) process.exit(await main());
