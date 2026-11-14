#!/usr/bin/env bun
/**
 * Prove the pinned `agy` honors the per-spawn MCP settings file production
 * writes: with `JUMI_SEARXNG_URL` set, `runAgy` registers the searxng server
 * in `$HOME/.gemini/config/mcp_config.json`; without it, no MCP entry is
 * added. `agy mcp list` against each seeded HOME records which case applies
 * against the installed binary, without spending a model turn.
 *
 * Exit 0 when every case matches, 1 otherwise.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGY_MCP_CONFIG_DIR, AGY_MCP_CONFIG_FILE, ensureAgyMcpServer, pruneAgyMcpServer } from "./agy.ts";
import { FORGE_DENY_DOMAIN } from "./forge_webfetch.ts";
import { SEARXNG_SERVER_NAME, searxngUrlFromEnv } from "./searxng.ts";

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
    await ensureAgyMcpServer(configuredHome, configured, FORGE_DENY_DOMAIN);
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
