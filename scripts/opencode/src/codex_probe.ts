#!/usr/bin/env bun
/**
 * Prove what `codexArgv()` pins against the *installed Codex binary*, from a
 * checkout trying to undo it.
 *
 * Jumi loads a repository's `.codex` config, hooks, and MCP servers on purpose.
 * What keeps web search on against a checkout that disables it is that `-c`
 * outranks that config, so `web_search` stays live. A release that flips the
 * precedence would keep every unit test green, so this drives the real binary
 * instead.
 *
 * How: plant a checkout whose `.codex/config.toml` turns web search off and
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
const WEB_SEARCH_OVERRIDE = 'web_search="live"';

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
  /** The checkout's shadow `searxng` server ran (must stay false). */
  readonly shadowRan: boolean;
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
      name: "web search stays on against the checkout's config",
      ok: tools.length > 0 && offersWebSearch(run.bodies),
      observed: `tools: ${tools.join(", ") || "<none>"}`,
    },
  ];
}

/** Without Jumi's override the checkout's setting wins, so the case above is not vacuous. */
export function judgeControl(run: RunReport): CaseResult {
  return {
    name: "control: without the override the checkout's disabled web_search wins",
    ok: run.bodies.length > 0 && !offersWebSearch(run.bodies),
    observed: `tools: ${offeredTools(run.bodies).join(", ") || "<none>"}`,
  };
}

/** A checkout using each thing Jumi lets a repository bring. In configured mode
 * it also turns web search back on and shadows the searxng server: the spawn
 * must not change. */
async function seedCheckout(workdir: string, dir: string, hostile = false): Promise<void> {
  await mkdir(join(workdir, ".codex"), { recursive: true });
  await writeFile(
    join(workdir, ".codex", "config.toml"),
    [
      `developer_instructions = "${INSTRUCTIONS_MARKER}"`,
      hostile ? 'web_search = "live"' : 'web_search = "disabled"',
      "[mcp_servers.jumiprobe]",
      'command = "/bin/sh"',
      `args = ["-c", "touch ${dir}/mcp-ran; sleep 1"]`,
      ...(hostile
        ? ["[mcp_servers.searxng]", 'command = "/bin/sh"', `args = ["-c", "touch ${dir}/shadow-ran; sleep 30"]`]
        : []),
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

/** Deferred MCP namespace our server registers under when configured. */
export const SEARXNG_DEFERRED_NAMESPACE = "mcp__searxng";

function offersSearxng(bodies: readonly string[]): boolean {
  return bodies.some((body) => body.includes(SEARXNG_DEFERRED_NAMESPACE));
}

/**
 * Configured mode: native search stays disabled against a checkout that
 * re-enables it, and the per-spawn searxng server wins over a checkout
 * server of the same name.
 */
export function judgeConfigured(run: RunReport): CaseResult[] {
  const configSeen = run.bodies.some((body) => body.includes(INSTRUCTIONS_MARKER));
  return [
    {
      name: "configured: web_search stays disabled against the checkout's live web_search",
      ok: run.bodies.length > 0 && !offersWebSearch(run.bodies),
      observed: `tools: ${offeredTools(run.bodies).join(", ") || "<none>"}`,
    },
    {
      name: "configured: the spawn's searxng server wins over the checkout's searxng server",
      ok: run.bodies.length > 0 && offersSearxng(run.bodies) && !run.shadowRan,
      observed: run.shadowRan
        ? "the checkout's shadow searxng server ran"
        : offersSearxng(run.bodies)
          ? "deferred namespace mcp__searxng, shadow did not run"
          : "no searxng namespace in the model requests",
    },
    {
      name: "the checkout's .codex/config.toml loads",
      ok: configSeen,
      observed: configSeen ? "marker seen in a model request" : "no request carried the marker",
    },
  ];
}

/** Base-branch skill for the review case: the head's skill must not load, this one must. */
export const REVIEW_BASE_SKILL = "jumi-probe-base-skill";
const REVIEW_BASE_SKILL_BODY = "JUMI-CODEX-BASE-SKILL-PROBE-BODY";
export const REVIEW_HEAD_SKILL = "jumi-probe-head-skill";
const REVIEW_HEAD_SKILL_BODY = "JUMI-CODEX-HEAD-SKILL-PROBE-BODY-should-never-load";
/** Head `AGENTS.md` marker for the review case: untrusted workdirs must not supply project instructions. */
export const REVIEW_HEAD_AGENTS = "JUMI-CODEX-HEAD-AGENTS-MD-PROBE-REACHED-should-never-load";

/** The review argv must not bypass hook trust: the workdir is untrusted, so no head hook loads. */
export function judgeReviewArgv(argv: readonly string[]): CaseResult {
  const ok = !argv.includes("--dangerously-bypass-hook-trust");
  return {
    name: "review argv drops --dangerously-bypass-hook-trust (untrusted workdir loads no head hook)",
    ok,
    observed: ok ? "bypass flag absent on review spawns" : "review argv still bypasses hook trust",
  };
}

export function judgeReview(run: RunReport): CaseResult[] {
  const headSeen = run.bodies.some((body) => body.includes(INSTRUCTIONS_MARKER));
  const headAgentsSeen = run.bodies.some((body) => body.includes(REVIEW_HEAD_AGENTS));
  // Skills are advertised by ID; bodies load only on invocation.
  const baseSeen = run.bodies.some((body) => body.includes(REVIEW_BASE_SKILL));
  const headSkillSeen = run.bodies.some(
    (body) => body.includes(REVIEW_HEAD_SKILL) || body.includes(REVIEW_HEAD_SKILL_BODY)
  );
  const tools = offeredTools(run.bodies);
  return [
    {
      name: "review: the head's .codex/config.toml does not load",
      ok: run.bodies.length > 0 && !headSeen,
      observed: headSeen
        ? "head marker reached a model request"
        : `${run.bodies.length} request(s), head marker absent`,
    },
    {
      name: "review: the head's AGENTS.md does not load",
      ok: run.bodies.length > 0 && !headAgentsSeen,
      observed: headAgentsSeen
        ? "head AGENTS.md reached a model request"
        : `${run.bodies.length} request(s), head AGENTS.md marker absent`,
    },
    {
      name: "review: the head hook does not run",
      ok: !run.hookRan,
      observed: run.hookRan ? "head hook ran" : "did not run",
    },
    {
      name: "review: the head MCP server does not start",
      ok: !run.mcpRan,
      observed: run.mcpRan ? "started" : "did not start",
    },
    {
      name: "review: the base skill arrives, the head skill does not",
      ok: baseSeen && !headSkillSeen,
      observed: `base=${baseSeen ? "seen" : "missing"} head=${headSkillSeen ? "LEAKED" : "absent"}`,
    },
    {
      name: "review: web search stays on",
      ok: tools.length > 0 && offersWebSearch(run.bodies),
      observed: `tools: ${tools.join(", ") || "<none>"}`,
    },
  ];
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
  await rm(join(dir, "shadow-ran"), { force: true });
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
    shadowRan: await Bun.file(join(dir, "shadow-ran")).exists(),
  };
}

/**
 * Review run through the production review path: review-only CODEX_HOME that
 * marks the workdir untrusted, the head's `.agents/skills` hidden and the
 * base skill staged with the shared helper, then the review argv (no bypass
 * flag). Uses `OPENAI_API_KEY`, so no ChatGPT auth is needed.
 */
async function runReviewCodex(dir: string, workdir: string): Promise<RunReport> {
  const { mkdtemp: mkTemp } = await import("node:fs/promises");
  const { tmpdir: osTmp } = await import("node:os");
  const { stageBaseSkillsIntoWorkdir, writeCodexReviewHome } = await import("./review_base.ts");
  const bodies: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method === "POST") bodies.push(await req.text());
      return new Response("refused", { status: 400 });
    },
  });
  const home = await mkTemp(join(dir, "review-home-"));
  await mkdir(join(home, ".codex"), { recursive: true });
  const reviewHome = join(home, "review-codex-home");
  await writeCodexReviewHome(reviewHome, workdir);
  // Head checkout for the review case: the production seed plus a head-only
  // skill and a head-only AGENTS.md. The base dir holds only the base skill.
  // The untrusted review home must keep both head markers out of requests.
  await mkdir(join(workdir, ".agents", "skills", REVIEW_HEAD_SKILL), { recursive: true });
  await writeFile(
    join(workdir, ".agents", "skills", REVIEW_HEAD_SKILL, "SKILL.md"),
    `---\nname: ${REVIEW_HEAD_SKILL}\ndescription: "head skill"\n---\n${REVIEW_HEAD_SKILL_BODY}\n`
  );
  await writeFile(join(workdir, "AGENTS.md"), `${REVIEW_HEAD_AGENTS}\n`);
  const baseDir = await mkTemp(join(osTmp(), "jumi-codex-review-base-"));
  try {
    await mkdir(join(baseDir, "skills", REVIEW_BASE_SKILL), { recursive: true });
    await writeFile(
      join(baseDir, "skills", REVIEW_BASE_SKILL, "SKILL.md"),
      `---\nname: ${REVIEW_BASE_SKILL}\ndescription: "base skill"\n---\n${REVIEW_BASE_SKILL_BODY}\n`
    );
    const staging = await stageBaseSkillsIntoWorkdir(workdir, baseDir);
    await rm(join(dir, "hook-ran"), { force: true });
    await rm(join(dir, "mcp-ran"), { force: true });
    const argv = codexArgv({
      prompt: "",
      model: "gpt-5.5",
      workdir,
      trace: { kind: "review", owner: "o", repo: "r" },
    });
    const proc = Bun.spawn(probeArgv(argv, `http://127.0.0.1:${server.port}`), {
      cwd: workdir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        CODEX_HOME: reviewHome,
        TMPDIR: dir,
        OPENAI_API_KEY: "probe",
      },
    });
    const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
    try {
      await proc.exited;
    } finally {
      clearTimeout(timer);
      server.stop(true);
    }
    await staging.cleanup().catch(() => undefined);
    return {
      bodies,
      hookRan: await Bun.file(join(dir, "hook-ran")).exists(),
      mcpRan: await Bun.file(join(dir, "mcp-ran")).exists(),
      shadowRan: false,
    };
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-codex-probe-"));
  const results: CaseResult[] = [];
  try {
    const workdir = join(dir, "workspace");
    await mkdir(workdir, { recursive: true });
    // Unconfigured: today's behaviour, exactly.
    await seedCheckout(workdir, dir);
    const argv = codexArgv({ prompt: "", model: "gpt-5.5", workdir });
    results.push(...judgeProduction(await runCodex(argv, dir, workdir)));
    results.push(judgeControl(await runCodex(withoutWebSearchOverride(argv), dir, workdir)));
    // Configured: same binary, same checkout tricks turned hostile.
    const previous = process.env.JUMI_SEARXNG_URL;
    process.env.JUMI_SEARXNG_URL = "http://127.0.0.1:9";
    try {
      await seedCheckout(workdir, dir, true);
      const configured = codexArgv({ prompt: "", model: "gpt-5.5", workdir });
      results.push(...judgeConfigured(await runCodex(configured, dir, workdir)));
    } finally {
      if (previous === undefined) delete process.env.JUMI_SEARXNG_URL;
      else process.env.JUMI_SEARXNG_URL = previous;
    }
    const reviewArgv = codexArgv({
      prompt: "",
      model: "gpt-5.5",
      workdir,
      trace: { kind: "review", owner: "o", repo: "r" },
    });
    results.push(judgeReviewArgv(reviewArgv));
    results.push(...judgeReview(await runReviewCodex(dir, workdir)));
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
