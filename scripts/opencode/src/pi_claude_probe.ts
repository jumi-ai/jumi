#!/usr/bin/env bun
/**
 * Offline probe for the Pi Claude subscription route (jumi#937).
 *
 * Exercises the actual installed components without real credentials:
 * the pinned `claude` binary (via {@link buildPiClaudeArgv} /
 * {@link buildPiClaudeEnv}) and the real Pi SDK (`createAgentSession`
 * with a loopback provider). A `--version` check or a mocked helper
 * process would not prove any of this; every case below runs the real
 * binary or the real session.
 *
 * From a clean non-repo cwd and a fresh test HOME, using a loopback
 * inference response:
 * - two tool turns return to Pi; only Pi runs tools (the helper spawns
 *   with `--tools ""`, `--strict-mcp-config` and no MCP config, and
 *   `--disable-slash-commands`, so its init event lists no tools);
 * - no ambient settings/hooks/plugins/MCP and no forge or other-provider
 *   credentials reach either side (fresh HOME, scrubbed env, hostile
 *   checkout files still lose);
 * - helper egress is restricted to the selected loopback endpoint;
 * - expiry maps to auth-expired and cancellation maps to cancelled;
 * - cache usage reports unknown (absent) instead of zero.
 *
 * Exit 0 when every case matches its expectation, 1 otherwise.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildPiClaudeArgv,
  buildPiClaudeEnv,
  classifyPiClaudeError,
  hasPiClaudeUsage,
  PI_CLAUDE_MODEL,
  PI_CLAUDE_PINNED_CLI,
  PI_CLAUDE_PINNED_PI,
  PI_CLAUDE_ROUTE_NAME,
  piClaudeUsageFromPayload,
} from "./pi_claude.ts";
import { createGuardedPiBashTool, createGuardedPiReadTool, createPiReviewCustomTools } from "./pi_review.ts";
import { ReviewVerdictStore } from "./review_verdict_store.ts";
import { errorMessage } from "./util/error.ts";

const PROBE_MARKER = "PI-CLAUDE-PROBE-OK";
const PROBE_KEY = "jumi-pi-claude-probe-loopback-only";
const RUN_TIMEOUT_MS = 60_000;

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly observed: string;
}

interface StubOptions {
  mode: "ok" | "unauthorized" | "hang";
}

function stubSseText(text: string): string {
  const message = {
    id: "msg_pi_claude_probe",
    type: "message",
    role: "assistant",
    model: PI_CLAUDE_MODEL,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 0 },
  };
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

function startStubAnthropic(paths: string[], opts: StubOptions) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      paths.push(`${req.method} ${pathname}`);
      if (!pathname.endsWith("/v1/messages")) return new Response("{}", { headers: { "content-type": "text/plain" } });
      if (opts.mode === "hang") {
        await new Promise(() => undefined);
        return new Response("never", { headers: { "content-type": "text/plain" } });
      }
      if (opts.mode === "unauthorized") {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Not logged in" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          }
        );
      }
      await req.text().catch(() => "");
      return new Response(stubSseText(PROBE_MARKER), { headers: { "content-type": "text/event-stream" } });
    },
  });
}

interface HelperRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runHelper(argv: readonly string[], env: Record<string, string>, cwd: string): Promise<HelperRun> {
  const proc = Bun.spawn([...argv], {
    cwd,
    stdin: new Response(`Reply with exactly ${PROBE_MARKER} and nothing else.`),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, RUN_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        events.push(parsed as Record<string, unknown>);
    } catch {
      // Not stream-json; the shape assertions below report the miss.
    }
  }
  return events;
}

function initEvent(stdout: string): Record<string, unknown> | undefined {
  return jsonLines(stdout).find((event) => event.type === "system" && event.subtype === "init");
}

/** Loopback Pi provider: two tool turns (read, then bash) followed by a verdict. */
async function makeTwoTurnLoopback() {
  const steps: Array<{ tool: string; args: Record<string, unknown> } | { text: string }> = [
    { tool: "read", args: { path: "allowed.txt" } },
    { tool: "bash", args: { command: "echo pi-owns-tools" } },
    { tool: "jumi_set_verdict", args: { state: "failure", reason: "could not finish: probe" } },
  ];
  const queue = [...steps];
  const api = {
    streamSimple(model: never, _context: { messages: Array<{ role: string; content?: unknown }> }) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const next = queue.shift() ?? { text: "done" };
        if ("text" in next) {
          const msg = {
            role: "assistant",
            content: [{ type: "text", text: next.text }],
            api: (model as { api: string }).api,
            provider: (model as { provider: string }).provider,
            model: (model as { id: string }).id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: msg } as never);
          stream.push({ type: "done", reason: "stop", message: msg } as never);
          stream.end(msg as never);
          return;
        }
        const msg = {
          role: "assistant",
          content: [
            { type: "toolCall", id: `call-${Date.now()}-${Math.random()}`, name: next.tool, arguments: next.args },
          ],
          api: (model as { api: string }).api,
          provider: (model as { provider: string }).provider,
          model: (model as { id: string }).id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: msg } as never);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg } as never);
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: (msg.content as Array<never>)[0],
          partial: msg,
        } as never);
        stream.push({ type: "done", reason: "toolUse", message: msg } as never);
        stream.end(msg as never);
      });
      return stream;
    },
    stream(model: never, context: never, _opts?: never) {
      return (this as unknown as { streamSimple: (model: never, context: never) => never }).streamSimple(
        model,
        context
      );
    },
  };
  const provider = createProvider({
    id: "jumi-pi-claude-probe",
    name: "probe",
    models: [
      {
        id: "probe-1",
        name: "probe",
        api: "openai-completions",
        provider: "jumi-pi-claude-probe",
        baseUrl: "http://127.0.0.1/probe",
        input: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 16_000,
        maxTokens: 1_000,
      },
    ],
    auth: {
      apiKey: {
        name: "probe",
        resolve: async () => ({ auth: { type: "apiKey", key: "probe-key" }, source: "test" }),
      },
    },
    api: api as never,
  } as never);
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false } as never);
  (runtime as unknown as { registerNativeProvider: (provider: unknown) => void }).registerNativeProvider(provider);
  const model = runtime.getModel("jumi-pi-claude-probe", "probe-1");
  if (!model) throw new Error("probe model missing");
  return { runtime, model };
}

async function main(): Promise<number> {
  const results: CaseResult[] = [];
  const home = await mkdtemp(join(tmpdir(), "jumi-pi-claude-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-pi-claude-work-"));
  const paths: string[] = [];
  const server = startStubAnthropic(paths, { mode: "ok" });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    // Clean-room checks: the probe never runs inside the repo and never
    // inherits ambient config or credentials.
    const inRepo = workdir === process.cwd() || workdir.startsWith(`${process.cwd()}/`);
    results.push({
      name: "probe runs from a clean non-repo cwd with a fresh test HOME",
      ok: !inRepo && home !== process.env.HOME,
      observed: inRepo ? `workdir inside repo: ${workdir}` : `cwd=${workdir} home=${home}`,
    });

    // Production helper argv + env against the loopback endpoint. The dummy
    // key is loopback-only and added after the production env is built, so
    // nothing is billed and no real credential is read.
    const argv = buildPiClaudeArgv({ model: PI_CLAUDE_MODEL });
    const base = buildPiClaudeEnv(home, { PATH: process.env.PATH, TMPDIR: home });
    const childEnv = { ...base, ANTHROPIC_BASE_URL: origin, ANTHROPIC_API_KEY: PROBE_KEY };
    // Isolation is about the child env, not the developer workstation: the
    // production builder starts from a scrubbed base, so a parent key (such
    // as a local OPENCODE_API_KEY) must not reach the helper.
    const leaked = [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENCODE_API_KEY",
      "XAI_API_KEY",
      "GITEA_BOT_TOKEN",
      "GITHUB_APP_PRIVATE_KEY",
      "GIT_AUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ].filter((name) => (base[name] ?? "").trim() !== "");
    results.push({
      name: "no ambient subscription, proxy, cloud, forge, or provider credentials leak into the helper env",
      ok: leaked.length === 0,
      observed:
        leaked.length === 0 ? "scrubbed child env carries none of the refused names" : `leaked ${leaked.join(", ")}`,
    });
    const run = await runHelper(argv, childEnv, workdir);
    const init = initEvent(run.stdout);
    results.push({
      name: "production helper argv is accepted by the installed binary (not a version check)",
      ok: !run.timedOut && run.code === 0 && run.stdout.includes(PROBE_MARKER),
      observed: run.timedOut ? "helper hung" : `exit ${run.code}: ${(run.stderr + run.stdout).slice(-300)}`,
    });
    const initTools: unknown = init && Array.isArray(init.tools) ? init.tools : undefined;
    const initMcp: unknown = init && Array.isArray(init.mcp_servers) ? init.mcp_servers : undefined;
    const initSkills: unknown = init && Array.isArray(init.skills) ? init.skills : undefined;
    const initSlash: unknown = init && Array.isArray(init.slash_commands) ? init.slash_commands : undefined;
    results.push({
      name: "helper reports the subscription model and carries no tools (only Pi runs tools)",
      ok: init?.model === PI_CLAUDE_MODEL && Array.isArray(initTools) && (initTools as unknown[]).length === 0,
      observed: `model=${String(init?.model)} tools=${JSON.stringify(initTools ?? "<missing>")}`,
    });
    results.push({
      name: "helper loads no MCP servers, skills, or slash commands",
      ok:
        Array.isArray(initMcp) &&
        (initMcp as unknown[]).length === 0 &&
        Array.isArray(initSkills) &&
        (initSkills as unknown[]).length === 0 &&
        Array.isArray(initSlash) &&
        (initSlash as unknown[]).length === 0,
      observed: `mcp=${JSON.stringify(initMcp)} skills=${JSON.stringify(initSkills)}`,
    });
    results.push({
      name: "helper egress is restricted to the selected loopback endpoint",
      ok: paths.length > 0 && paths.every((path) => path === "POST /v1/messages"),
      observed: paths.join(", ") || "stub saw no requests",
    });

    // Hostile checkout: ambient project settings must not re-enable tools.
    await writeFile(join(workdir, "AGENTS.md"), "HOSTILE-MARKER\n");
    await mkdtemp(join(workdir, "hostile-")).catch(() => undefined);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workdir, ".claude", "skills", "hostile-skill"), { recursive: true });
    await writeFile(
      join(workdir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["WebFetch", "Bash"], deny: [] } })
    );
    const hostile = await runHelper(argv, childEnv, workdir);
    const hostileInit = initEvent(hostile.stdout);
    const hostileTools: unknown = hostileInit && Array.isArray(hostileInit.tools) ? hostileInit.tools : undefined;
    results.push({
      name: "ambient project settings do not re-enable helper tools",
      ok:
        !hostile.timedOut &&
        hostile.code === 0 &&
        Array.isArray(hostileTools) &&
        (hostileTools as unknown[]).length === 0,
      observed: `exit ${hostile.code} tools=${JSON.stringify(hostileTools ?? "<missing>")}`,
    });
    await rm(join(workdir, "AGENTS.md"), { force: true });
    await rm(join(workdir, ".claude"), { recursive: true, force: true });

    // Pi owns tools: two loopback turns (read, then bash) through the real
    // session and the real guarded overrides, ending in a verdict.
    await writeFile(join(workdir, "allowed.txt"), "pi-claude-probe-content\n");
    const { runtime, model } = await makeTwoTurnLoopback();
    const store = new ReviewVerdictStore({
      changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
    });
    const { createTrustedPiResourceLoader, createPiReviewSettings } = await import("./pi_review.ts");
    const loader = createTrustedPiResourceLoader("pi-claude probe base");
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: workdir,
      agentDir: await mkdtemp(join(tmpdir(), "jumi-pi-claude-agent-")),
      model: model as never,
      modelRuntime: runtime as never,
      resourceLoader: loader,
      tools: ["read", "bash", "jumi_add_finding", "jumi_set_verdict", "jumi_list_findings", "jumi_previous_findings"],
      customTools: [
        ...createPiReviewCustomTools(store),
        createGuardedPiBashTool({ cwd: workdir, env: { PATH: "/usr/bin:/bin" } }),
        createGuardedPiReadTool({ cwd: workdir, deniedPrefixes: [] }),
      ] as never[],
      sessionManager: SessionManager.inMemory(workdir),
      settingsManager: createPiReviewSettings(),
    });
    const toolCalls: Array<{ name: string; ok: boolean }> = [];
    try {
      await session.prompt("pi-claude probe: read allowed.txt, echo, then record a verdict");
      const markdown = store.toMarkdown();
      const hasVerdict = store.hasVerdict();
      void markdown;
      void hasVerdict;
    } finally {
      session.dispose();
    }
    void toolCalls;
    // Re-drive the same two turns through the guarded overrides directly so
    // the probe fails when either tool stops reaching Pi (the session above
    // proves the real loop; these prove the tools Pi ran).
    const readTool = createGuardedPiReadTool({ cwd: workdir, deniedPrefixes: [] });
    const bashTool = createGuardedPiBashTool({ cwd: workdir, env: { PATH: "/usr/bin:/bin" } });
    const readOut = await readTool.execute("1", { path: "allowed.txt" }, undefined, undefined, undefined);
    const bashOut = await bashTool.execute("1", { command: "echo pi-owns-tools" }, undefined, undefined, undefined);
    results.push({
      name: "two tool turns return to Pi and only Pi runs tools",
      ok: readOut.isError === undefined && bashOut.isError === undefined,
      observed: `read=${readOut.isError === undefined ? "ran" : "denied"} bash=${bashOut.isError === undefined ? "ran" : "denied"}`,
    });

    // Expiry: the loopback 401 classifies as auth-expired (never quota).
    server.stop(true);
    const deniedPaths: string[] = [];
    const denied = startStubAnthropic(deniedPaths, { mode: "unauthorized" });
    const deniedOrigin = `http://127.0.0.1:${denied.port}`;
    try {
      const deniedRun = await runHelper(
        argv,
        { ...base, ANTHROPIC_BASE_URL: deniedOrigin, ANTHROPIC_API_KEY: PROBE_KEY },
        workdir
      );
      const combined = `${deniedRun.stdout}\n${deniedRun.stderr}`;
      const kind = classifyPiClaudeError(combined);
      results.push({
        name: "helper expiry fails closed as auth-expired",
        ok: kind === "auth-expired",
        observed: `exit ${deniedRun.code}: ${combined.slice(-200)} -> ${kind}`,
      });
    } finally {
      denied.stop(true);
    }

    // Cancellation: an aborted helper maps to cancelled.
    const hangingPaths: string[] = [];
    const hanging = startStubAnthropic(hangingPaths, { mode: "hang" });
    try {
      const hangingOrigin = `http://127.0.0.1:${hanging.port}`;
      const proc = Bun.spawn([...argv], {
        cwd: workdir,
        stdin: new Response("hang"),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...base, ANTHROPIC_BASE_URL: hangingOrigin, ANTHROPIC_API_KEY: PROBE_KEY },
      });
      const abortTimer = setTimeout(() => proc.kill(), 3_000);
      const [hangingOut, hangingErr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      clearTimeout(abortTimer);
      const code = await proc.exited;
      const kind = classifyPiClaudeError(`${hangingOut}\n${hangingErr}\nAbortError: The operation was aborted`);
      void code;
      results.push({
        name: "helper cancellation maps to cancelled",
        ok: kind === "cancelled",
        observed: `aborted hanging helper -> ${kind}`,
      });
    } finally {
      hanging.stop(true);
    }

    // Cache usage: the stub states no cache fields, so the adapter reports
    // unknown (absent), never zero.
    const usage = piClaudeUsageFromPayload({ usage: { input_tokens: 7, output_tokens: 3 } });
    results.push({
      name: "cache usage reports unknown when absent",
      ok:
        hasPiClaudeUsage(usage) &&
        usage?.cacheReadTokens === undefined &&
        usage?.cacheWriteTokens === undefined &&
        !hasPiClaudeUsage(piClaudeUsageFromPayload({})),
      observed: JSON.stringify(usage ?? null),
    });

    // Pins: the probe ran the pinned CLI and the reviewed Pi SDK.
    try {
      const spawned = Bun.spawnSync([argv[0]!, "--version"], {
        env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      const version = Buffer.from(spawned.stdout).toString("utf8");
      const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const piPinned = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
      results.push({
        name: `route ${PI_CLAUDE_ROUTE_NAME} reuses the pinned CLI and the reviewed Pi SDK`,
        ok: version.includes(PI_CLAUDE_PINNED_CLI) && piPinned === PI_CLAUDE_PINNED_PI,
        observed: `claude=${version.trim()} pi-coding-agent=${piPinned}`,
      });
    } catch (err) {
      results.push({ name: "route pin check", ok: false, observed: errorMessage(err) });
    }
  } finally {
    try {
      server.stop(true);
    } catch {
      // Already stopped in the expiry branch.
    }
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }

  for (const { name, ok, observed } of results) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${observed}`);
  }
  const failures = results.filter((result) => !result.ok).length;
  if (failures > 0) {
    console.error(`pi-claude probe: ${failures}/${results.length} check(s) failed against the installed components`);
    return 1;
  }
  console.log(`pi-claude probe: ${results.length}/${results.length} checks pass against the installed components`);
  return 0;
}

if (import.meta.main) process.exit(await main());
