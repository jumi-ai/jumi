#!/usr/bin/env bun
/**
 * Prove what `codexArgv()` pins against the *installed Codex binary*, from a
 * checkout trying to undo it.
 *
 * Jumi loads a repository's `.codex` config, hooks, and MCP servers on purpose.
 * What keeps Codex off the forge is that `-c` outranks that config, so
 * `web_search` stays disabled. A release that flips the precedence would keep
 * every unit test green, so this drives the real binary instead.
 *
 * How: plant a checkout whose `.codex/config.toml` turns web search back on and
 * point the production argv at a loopback Responses endpoint, then read the tool
 * list out of the request the binary sends. A second run drops Jumi's
 * `web_search` override, so a checkout that stopped loading fails here instead
 * of passing for the wrong reason. Nothing leaves the machine.
 *
 * Exit 0 when every case matches its expectation, 1 otherwise.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexArgv } from "./codex.ts";

const INSTRUCTIONS_MARKER = "JUMI-CODEX-CONFIG-PROBE-REACHED";
/** Hang guard: the endpoint refuses every request, so a healthy run is seconds. */
const RUN_TIMEOUT_MS = 45_000;
const WEB_SEARCH_OVERRIDE = 'web_search="disabled"';

export interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly observed: string;
}

export interface RunReport {
  /** Every POST body the binary sent the endpoint. */
  readonly bodies: readonly string[];
  readonly hookRan: boolean;
  readonly mcpRan: boolean;
}

/** Tool names and types the binary offered the model, across every request. */
export function offeredTools(bodies: readonly string[]): string[] {
  const names = new Set<string>();
  for (const body of bodies) {
    try {
      const tools = (JSON.parse(body) as { tools?: { name?: string; type?: string }[] }).tools ?? [];
      for (const tool of tools) names.add(tool.name ?? tool.type ?? "");
    } catch {
      // Not a Responses request; the checks below report the miss.
    }
  }
  return [...names];
}

function offersWebSearch(bodies: readonly string[]): boolean {
  return offeredTools(bodies).some((name) => name.startsWith("web_search"));
}

export function judgeProduction(run: RunReport): CaseResult[] {
  const configSeen = run.bodies.some((body) => body.includes(INSTRUCTIONS_MARKER));
  const tools = offeredTools(run.bodies);
  return [
    {
      name: "the production argv reaches the endpoint",
      ok: run.bodies.length > 0,
      observed: `${run.bodies.length} request(s)`,
    },
    {
      name: "the checkout's .codex/config.toml loads",
      ok: configSeen,
      observed: configSeen ? "marker seen in a model request" : "no request carried the marker",
    },
    { name: "the checkout's hook runs", ok: run.hookRan, observed: run.hookRan ? "ran" : "did not run" },
    { name: "the checkout's MCP server starts", ok: run.mcpRan, observed: run.mcpRan ? "started" : "did not start" },
    {
      name: "web search stays off against the checkout's config",
      ok: tools.length > 0 && !offersWebSearch(run.bodies),
      observed: `tools: ${tools.join(", ") || "<none>"}`,
    },
  ];
}

/** Without Jumi's override the checkout's setting wins, so the case above is not vacuous. */
export function judgeControl(run: RunReport): CaseResult {
  return {
    name: "control: without the override the checkout's web_search reaches the model",
    ok: offersWebSearch(run.bodies),
    observed: `tools: ${offeredTools(run.bodies).join(", ") || "<none>"}`,
  };
}

/** A checkout using each thing Jumi lets a repository bring, and turning web search back on. */
async function seedCheckout(workdir: string, dir: string): Promise<void> {
  await mkdir(join(workdir, ".codex"), { recursive: true });
  await writeFile(
    join(workdir, ".codex", "config.toml"),
    [
      `developer_instructions = "${INSTRUCTIONS_MARKER}"`,
      'web_search = "live"',
      "[mcp_servers.jumiprobe]",
      'command = "/bin/sh"',
      `args = ["-c", "touch ${dir}/mcp-ran; sleep 1"]`,
      "",
    ].join("\n")
  );
  await writeFile(
    join(workdir, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${dir}/hook-ran` }] }] },
    })
  );
  await Bun.$`git init -q`.cwd(workdir).quiet();
}

/** The production argv with the model provider moved to `origin`, and the prompt on the command line. */
export function probeArgv(argv: readonly string[], origin: string): string[] {
  const at = argv.indexOf('model_provider="openai"');
  if (at < 1) throw new Error('codexArgv no longer pins model_provider="openai"');
  return [
    ...argv.slice(0, at - 1),
    "-c",
    'model_provider="jumiprobe"',
    "-c",
    'model_providers.jumiprobe.name="jumiprobe"',
    "-c",
    `model_providers.jumiprobe.base_url="${origin}/v1"`,
    "-c",
    'model_providers.jumiprobe.wire_api="responses"',
    "-c",
    'model_providers.jumiprobe.env_key="OPENAI_API_KEY"',
    "-c",
    "model_providers.jumiprobe.supports_websockets=false",
    ...argv.slice(at + 1).filter((arg) => arg !== "-"),
    "say ok",
  ];
}

export function withoutWebSearchOverride(argv: readonly string[]): string[] {
  const at = argv.indexOf(WEB_SEARCH_OVERRIDE);
  if (at < 1) throw new Error(`codexArgv no longer pins ${WEB_SEARCH_OVERRIDE}`);
  return [...argv.slice(0, at - 1), ...argv.slice(at + 1)];
}

async function runCodex(argv: readonly string[], dir: string, workdir: string): Promise<RunReport> {
  const bodies: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method === "POST") bodies.push(await req.text());
      return new Response("refused", { status: 400 });
    },
  });
  const home = await mkdtemp(join(dir, "home-"));
  await mkdir(join(home, ".codex"), { recursive: true });
  await rm(join(dir, "hook-ran"), { force: true });
  await rm(join(dir, "mcp-ran"), { force: true });
  const proc = Bun.spawn(probeArgv(argv, `http://127.0.0.1:${server.port}`), {
    cwd: workdir,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, TMPDIR: dir, OPENAI_API_KEY: "probe" },
  });
  const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
  return {
    bodies,
    hookRan: await Bun.file(join(dir, "hook-ran")).exists(),
    mcpRan: await Bun.file(join(dir, "mcp-ran")).exists(),
  };
}

async function main(): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-probe-"));
  const results: CaseResult[] = [];
  try {
    const workdir = join(dir, "workspace");
    await mkdir(workdir, { recursive: true });
    await seedCheckout(workdir, dir);
    const argv = codexArgv({ prompt: "", model: "gpt-5.5", workdir });
    results.push(...judgeProduction(await runCodex(argv, dir, workdir)));
    results.push(judgeControl(await runCodex(withoutWebSearchOverride(argv), dir, workdir)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const { name, ok, observed } of results) console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${observed}`);
  const failures = results.filter((result) => !result.ok).length;
  if (failures > 0) {
    console.error(`codex probe: ${failures}/${results.length} check(s) failed against the installed binary`);
    return 1;
  }
  console.log(`codex probe: ${results.length}/${results.length} checks pass against the installed codex binary`);
  return 0;
}

if (import.meta.main) process.exit(await main());
