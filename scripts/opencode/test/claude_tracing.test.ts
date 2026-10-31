import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_TRACING_PLUGIN_DIR,
  claudeTracingEnv,
  claudeTracingPluginDir,
  phoenixPluginEndpoint,
  setClaudeTracingPluginDirForTests,
} from "../src/claude_tracing.ts";
import { PUBLIC_PHOENIX_HOST } from "../src/phoenix.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginDir = join(repoRoot, "claude-plugins/claude-code-tracing");
const hooks = join(pluginDir, "hooks");

// The hook cases below are the only tests in the suite that fork real
// processes — one hook run is a bash script that spawns jq several times and
// python3 once — which makes them its slowest, and their cost is process-spawn
// latency rather than anything this repo controls. Bun's 5s default left barely
// a 1.5x margin on a fast machine, so on a shared CI runner it reports as a
// tracing failure rather than a slow box. File-scoped (proven: a sibling file
// still times out at 5s), generous enough to absorb a slow runner, short enough
// that a hook which genuinely hangs still fails the job.
setDefaultTimeout(30_000);

const originalEndpoint = process.env.PHOENIX_OTLP_ENDPOINT;
const originalAgent = process.env.AGENT_INSTANCE;

afterEach(() => {
  setClaudeTracingPluginDirForTests(undefined);
  if (originalEndpoint === undefined) delete process.env.PHOENIX_OTLP_ENDPOINT;
  else process.env.PHOENIX_OTLP_ENDPOINT = originalEndpoint;
  if (originalAgent === undefined) delete process.env.AGENT_INSTANCE;
  else process.env.AGENT_INSTANCE = originalAgent;
});

describe("phoenixPluginEndpoint", () => {
  test("strips the OpenCode exporter's OTLP path instead of copying it blindly", () => {
    // The stored value serves an exporter that POSTs OTLP to <base>/v1/traces.
    // The plugin builds <base>/v1/projects/<name>/spans, so a verbatim copy
    // would reach /v1/traces/v1/projects/... and nothing would land.
    expect(phoenixPluginEndpoint("http://phoenix.phoenix.svc:6006/v1/traces")).toBe("http://phoenix.phoenix.svc:6006");
    expect(phoenixPluginEndpoint("http://phoenix.phoenix.svc:6006/v1/traces/")).toBe("http://phoenix.phoenix.svc:6006");
    expect(phoenixPluginEndpoint("http://phoenix.phoenix.svc:6006/")).toBe("http://phoenix.phoenix.svc:6006");
    expect(phoenixPluginEndpoint("  http://phoenix.phoenix.svc:6006  ")).toBe("http://phoenix.phoenix.svc:6006");
    expect(phoenixPluginEndpoint("http://phoenix.phoenix.svc:6006/ingest")).toBe(
      "http://phoenix.phoenix.svc:6006/ingest"
    );
  });

  test("refuses the public hostname, junk, and non-HTTP schemes", () => {
    expect(phoenixPluginEndpoint(`https://${PUBLIC_PHOENIX_HOST}`)).toBeUndefined();
    expect(phoenixPluginEndpoint(`https://${PUBLIC_PHOENIX_HOST}/v1/traces`)).toBeUndefined();
    expect(phoenixPluginEndpoint("grpc://phoenix.phoenix.svc:4317")).toBeUndefined();
    expect(phoenixPluginEndpoint("phoenix.phoenix.svc:6006")).toBeUndefined();
    expect(phoenixPluginEndpoint("   ")).toBeUndefined();
    expect(phoenixPluginEndpoint(undefined)).toBeUndefined();
  });
});

describe("claudeTracingEnv", () => {
  test("is empty without an endpoint, so the child runs untraced instead of failing", () => {
    delete process.env.PHOENIX_OTLP_ENDPOINT;
    setClaudeTracingPluginDirForTests(pluginDir);
    expect(claudeTracingEnv({ kind: "review", owner: "o", repo: "r" })).toEqual({});
    expect(claudeTracingPluginDir()).toBeUndefined();
  });

  test("is empty when the plugin is not in the image", () => {
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.phoenix.svc:6006";
    setClaudeTracingPluginDirForTests("/no/such/plugin");
    expect(claudeTracingEnv({ kind: "review", owner: "o", repo: "r" })).toEqual({});
    expect(claudeTracingPluginDir()).toBeUndefined();
  });

  test("names the factory source as the project and carries the job id", () => {
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.phoenix.svc:6006/v1/traces";
    process.env.AGENT_INSTANCE = "jumi-worker";
    setClaudeTracingPluginDirForTests(pluginDir);
    expect(
      claudeTracingEnv({ kind: "implement", owner: "kirmanak", repo: "jumi", sha: "abc", jobId: "job-7" })
    ).toEqual({
      PHOENIX_ENDPOINT: "http://phoenix.phoenix.svc:6006",
      ARIZE_PROJECT_NAME: "jumi-worker",
      ARIZE_TRACE_ENABLED: "true",
      ARIZE_LOG_PROMPTS: "false",
      ARIZE_HTTP_TIMEOUT: "2",
      JUMI_AGENT_INSTANCE: "jumi-worker",
      JUMI_TRACE_KIND: "implement",
      JUMI_OWNER: "kirmanak",
      JUMI_REPO: "jumi",
      JUMI_SHA: "abc",
      JUMI_JOB_ID: "job-7",
    });

    // Engine keeps the default source, not a `claude-code` harness dump.
    delete process.env.AGENT_INSTANCE;
    expect(claudeTracingEnv({ kind: "review", owner: "kirmanak", repo: "jumi" }).ARIZE_PROJECT_NAME).toBe("jumi");
  });

  test("points at the vendored image path by default", () => {
    expect(CLAUDE_TRACING_PLUGIN_DIR).toBe("/app/claude-plugins/claude-code-tracing");
  });
});

describe("plugin manifest", () => {
  // Claude Code loads the hooks from the manifest's inline `hooks` block, so a
  // re-sync that renames or drops a hook script leaves `--plugin-dir` pointing
  // at a plugin whose events resolve to nothing — tracing stops with no error
  // anywhere. Fail here instead.
  test("every hook the manifest wires up exists, and the dir is the one the parent passes", async () => {
    const manifestPath = join(pluginDir, ".claude-plugin/plugin.json");
    const manifest = (await Bun.file(manifestPath).json()) as {
      name: string;
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };

    // `--plugin-dir` names the directory holding `.claude-plugin/plugin.json`.
    setClaudeTracingPluginDirForTests(pluginDir);
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.phoenix.svc:6006";
    expect(claudeTracingPluginDir()).toBe(pluginDir);
    expect(CLAUDE_TRACING_PLUGIN_DIR.endsWith(`/${manifest.name}`)).toBe(true);

    const wired = new Set<string>();
    for (const [event, matchers] of Object.entries(manifest.hooks)) {
      expect(matchers.length).toBeGreaterThan(0);
      for (const entry of matchers.flatMap((m) => m.hooks)) {
        expect(entry.type).toBe("command");
        const script = entry.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([A-Za-z0-9_]+\.sh)/)?.[1];
        expect(script, `${event} must run a hooks/*.sh under CLAUDE_PLUGIN_ROOT`).toBeDefined();
        expect(existsSync(join(hooks, script as string))).toBe(true);
        wired.add(script as string);
      }
    }
    expect(wired.size).toBeGreaterThan(0);

    // And nothing ships as a hook without being wired to an event.
    const onDisk = (await readdir(hooks)).filter((f) => f.endsWith(".sh") && f !== "common.sh");
    expect(new Set(onDisk)).toEqual(wired);

    // bin/, agents/, skills/, .mcp.json, monitors/, settings.json would all
    // reach every traced child. A re-sync that adds any of those
    // must fail here instead of shipping.
    expect(new Set(await readdir(pluginDir))).toEqual(new Set([".claude-plugin", "hooks", "LICENSE", "UPSTREAM.md"]));
  });
});

interface Captured {
  url: string;
  body: { data: Array<{ name: string; span_kind: string; attributes: Record<string, unknown> }> };
}

/** Run the vendored hooks against a fake Phoenix and collect what they POST. */
async function withPluginRun(
  run: (ctx: {
    env: Record<string, string>;
    state: string;
    hook: (name: string, input: unknown) => Promise<number>;
  }) => Promise<void>
): Promise<Captured[]> {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      // The hooks only POST; another local process probing a fresh port is not a span.
      if (req.method !== "POST") return new Response(null, { status: 404 });
      captured.push({ url: new URL(req.url).pathname, body: await req.json() });
      return Response.json({ total_received: 1, total_queued: 1 }, { status: 202 });
    },
  });
  const state = await mkdtemp(join(tmpdir(), "arize-state-"));
  try {
    process.env.PHOENIX_OTLP_ENDPOINT = `http://127.0.0.1:${server.port}/v1/traces`;
    process.env.AGENT_INSTANCE = "jumi-worker";
    setClaudeTracingPluginDirForTests(pluginDir);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: state,
      ...claudeTracingEnv({ kind: "implement", owner: "kirmanak", repo: "jumi", sha: "deadbeef", jobId: "job-42" }),
    };
    const hook = async (name: string, input: unknown): Promise<number> => {
      const proc = Bun.spawn(["bash", join(hooks, name)], {
        env,
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
      });
      return await proc.exited;
    };
    await run({ env, state, hook });
  } finally {
    server.stop(true);
    await rm(state, { recursive: true, force: true });
  }
  return captured;
}

const hasShellTools =
  Bun.which("bash") !== null &&
  Bun.which("jq") !== null &&
  (Bun.which("python3") !== null || Bun.which("curl") !== null);

describe.if(hasShellTools)("vendored claude-code-tracing hooks", () => {
  test("post OpenInference spans that carry the Jumi job id and no prompt text", async () => {
    const transcript = join(await mkdtemp(join(tmpdir(), "arize-transcript-")), "transcript.jsonl");
    // A turn before this one, so the span must not reprint it.
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-5", content: [{ type: "text", text: "EARLIER TURN" }], usage: {} },
      })}\n`
    );

    const spans = await withPluginRun(async ({ hook }) => {
      const session = { session_id: "claude-session-1", cwd: "/work", transcript_path: transcript };
      expect(await hook("session_start.sh", session)).toBe(0);
      expect(await hook("user_prompt_submit.sh", { ...session, prompt: "SECRET TASK PROSE" })).toBe(0);
      expect(await hook("pre_tool_use.sh", { ...session, tool_use_id: "t1" })).toBe(0);
      expect(
        await hook("post_tool_use.sh", {
          ...session,
          tool_use_id: "t1",
          tool_name: "Bash",
          tool_input: { command: "bun test" },
          tool_response: "2 pass",
        })
      ).toBe(0);
      await appendFile(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-5",
            content: [{ type: "text", text: "done" }],
            usage: { input_tokens: 11, output_tokens: 3 },
          },
        })}\n`
      );
      expect(await hook("stop.sh", session)).toBe(0);
      expect(await hook("session_end.sh", session)).toBe(0);
    });

    // Project name is the factory source, not the plugin's `claude-code` default.
    expect(new Set(spans.map((s) => s.url))).toEqual(new Set(["/v1/projects/jumi-worker/spans"]));

    const byName = new Map(spans.map((s) => [s.body.data[0]?.name ?? "", s.body.data[0]]));
    const tool = byName.get("Bash");
    const turn = byName.get("Turn 1");
    expect(tool).toBeDefined();
    expect(turn).toBeDefined();

    // The kind travels as the span kind, not upstream's hardcoded CHAIN.
    expect(tool?.span_kind).toBe("TOOL");
    expect(turn?.span_kind).toBe("LLM");

    // Job identity on every span, under the keys the OpenCode exporter writes.
    for (const span of [tool, turn]) {
      expect(span?.attributes.job_id).toBe("job-42");
      expect(span?.attributes["session.id"]).toBe("job-42");
      expect(span?.attributes.kind).toBe("implement");
      expect(span?.attributes.owner).toBe("kirmanak");
      expect(span?.attributes.repo).toBe("jumi");
      expect(span?.attributes.sha).toBe("deadbeef");
      expect(span?.attributes.agent_instance).toBe("jumi-worker");
    }

    // Tool names, arguments and results ride along; prompt prose does not.
    expect(tool?.attributes["tool.name"]).toBe("Bash");
    expect(tool?.attributes["tool.command"]).toBe("bun test");
    expect(tool?.attributes["output.value"]).toBe("2 pass");
    expect(turn?.attributes["input.value"]).toBeUndefined();
    expect(turn?.attributes["llm.model_name"]).toBe("claude-opus-5");
    expect(turn?.attributes["llm.token_count.prompt"]).toBe(11);
    expect(turn?.attributes["output.value"]).toBe("done");
    expect(JSON.stringify(spans)).not.toContain("SECRET TASK PROSE");
    // Only this turn's transcript lines; the conversation is not reprinted.
    expect(JSON.stringify(spans)).not.toContain("EARLIER TURN");
  });

  // A value larger than the 64 KiB pipe buffer is the regression these guard:
  // truncating with `head -c` under `set -o pipefail` SIGPIPEs the writer, the
  // assignment reports 141, and `set -e` kills the hook before it ever sends a
  // span. Truncation only runs on big values, so the big values were the ones
  // that silently dropped. Keep these if the hooks are re-synced with upstream.
  const HUGE = "x".repeat(80_000);

  test("a tool payload past the pipe buffer still posts its TOOL span", async () => {
    const spans = await withPluginRun(async ({ hook }) => {
      const session = { session_id: "claude-session-big-tool", cwd: "/work" };
      expect(await hook("session_start.sh", session)).toBe(0);
      expect(await hook("user_prompt_submit.sh", session)).toBe(0);
      expect(
        await hook("post_tool_use.sh", {
          ...session,
          tool_use_id: "t1",
          tool_name: "Write",
          tool_input: { file_path: "/work/big.txt", content: HUGE },
          tool_response: HUGE,
        })
      ).toBe(0);
      // An unbounded Bash command feeds the `tool_description` truncation too.
      expect(
        await hook("post_tool_use.sh", {
          ...session,
          tool_use_id: "t2",
          tool_name: "Bash",
          tool_input: { command: `echo ${HUGE}` },
          tool_response: "ok",
        })
      ).toBe(0);
    });

    const byName = new Map(spans.map((s) => [s.body.data[0]?.name ?? "", s.body.data[0]]));
    const write = byName.get("Write");
    const bash = byName.get("Bash");
    expect(write).toBeDefined();
    expect(bash).toBeDefined();
    expect(write?.attributes["tool.truncated"]).toBe("true");
    expect(String(write?.attributes["input.value"]).length).toBe(5000);
    expect(String(write?.attributes["output.value"]).length).toBe(5000);
    expect(String(bash?.attributes["tool.description"]).length).toBe(200);
    // The structured attribute restates `input.value`; it is capped, not unbounded.
    expect(String(bash?.attributes["tool.command"]).length).toBe(5000);
  });

  test("a transcript turn past the pipe buffer still posts its Turn span", async () => {
    const transcript = join(await mkdtemp(join(tmpdir(), "arize-transcript-big-")), "transcript.jsonl");
    await writeFile(transcript, "");

    const spans = await withPluginRun(async ({ hook }) => {
      const session = { session_id: "claude-session-big-turn", cwd: "/work", transcript_path: transcript };
      expect(await hook("session_start.sh", session)).toBe(0);
      expect(await hook("user_prompt_submit.sh", session)).toBe(0);
      await appendFile(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-5",
            content: [{ type: "text", text: HUGE }],
            usage: { input_tokens: 11, output_tokens: 3 },
          },
        })}\n`
      );
      expect(await hook("stop.sh", session)).toBe(0);
    });

    const turn = spans.map((s) => s.body.data[0]).find((s) => s?.name === "Turn 1");
    // Not the fail-safe span: the Turn must carry this run's model and tokens.
    expect(turn).toBeDefined();
    expect(turn?.attributes["llm.model_name"]).toBe("claude-opus-5");
    expect(turn?.attributes["llm.token_count.total"]).toBe(14);
    expect(String(turn?.attributes["output.value"]).length).toBe(5000);
  });

  test("a many-line transcript still posts one Turn span with summed tokens", async () => {
    const transcript = join(await mkdtemp(join(tmpdir(), "arize-transcript-lines-")), "transcript.jsonl");
    await writeFile(transcript, "");
    const n = 40;
    const lines = Array.from({ length: n }, (_, i) =>
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-5",
          content: [{ type: "text", text: `line-${i}` }],
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
          },
        },
      })
    ).join("\n");

    const spans = await withPluginRun(async ({ hook }) => {
      const session = { session_id: "claude-session-many-lines", cwd: "/work", transcript_path: transcript };
      expect(await hook("session_start.sh", session)).toBe(0);
      expect(await hook("user_prompt_submit.sh", session)).toBe(0);
      await appendFile(transcript, `${lines}\n`);
      expect(await hook("stop.sh", session)).toBe(0);
    });

    const turn = spans.map((s) => s.body.data[0]).find((s) => s?.name === "Turn 1");
    expect(turn).toBeDefined();
    expect(turn?.attributes["llm.model_name"]).toBe("claude-opus-5");
    expect(turn?.attributes["llm.token_count.prompt"]).toBe(n * (2 + 3 + 4));
    expect(turn?.attributes["llm.token_count.completion"]).toBe(n);
    expect(turn?.attributes["output.value"]).toBe(Array.from({ length: n }, (_, i) => `line-${i}`).join("\n"));
  });

  test("a tool call outside a turn does not POST a span", async () => {
    const spans = await withPluginRun(async ({ hook }) => {
      const session = { session_id: "claude-session-no-turn", cwd: "/work" };
      expect(await hook("session_start.sh", session)).toBe(0);
      expect(
        await hook("post_tool_use.sh", {
          ...session,
          tool_use_id: "t1",
          tool_name: "Bash",
          tool_input: { command: "true" },
          tool_response: "ok",
        })
      ).toBe(0);
    });
    expect(spans).toEqual([]);
  });

  test("a black-holing Phoenix is given up on after a few POSTs", async () => {
    let posts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        // Same as withPluginRun: only the hooks' POSTs count toward the breaker.
        if (req.method !== "POST") return new Response(null, { status: 404 });
        posts += 1;
        // Accept and never reply: the failure mode that costs ARIZE_HTTP_TIMEOUT
        // per tool, not the refused 127.0.0.1:9 path that returns in microseconds.
        await Bun.sleep(60_000);
        return new Response("ok");
      },
    });
    const state = await mkdtemp(join(tmpdir(), "arize-state-hang-"));
    const started = Date.now();
    try {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: state,
        PHOENIX_ENDPOINT: `http://127.0.0.1:${server.port}`,
        ARIZE_PROJECT_NAME: "jumi",
        ARIZE_TRACE_ENABLED: "true",
        ARIZE_LOG_PROMPTS: "false",
        ARIZE_HTTP_TIMEOUT: "1",
        JUMI_JOB_ID: "job-42",
      };
      const session = { session_id: "claude-session-hang", cwd: "/work" };
      const hook = async (name: string, input: unknown): Promise<number> => {
        const proc = Bun.spawn(["bash", join(hooks, name)], {
          env,
          stdin: new TextEncoder().encode(JSON.stringify(input)),
          stdout: "pipe",
          stderr: "pipe",
        });
        const code = await proc.exited;
        expect(await new Response(proc.stdout).text()).toBe("");
        expect(await new Response(proc.stderr).text()).toBe("");
        return code;
      };
      expect(await hook("session_start.sh", session)).toBe(0);
      expect(await hook("user_prompt_submit.sh", session)).toBe(0);
      for (let i = 0; i < 5; i++) {
        expect(
          await hook("post_tool_use.sh", {
            ...session,
            tool_use_id: `t${i}`,
            tool_name: "Bash",
            tool_input: { command: "true" },
            tool_response: "ok",
          })
        ).toBe(0);
      }
      // Three failed POSTs, then skip. Without the breaker this is 5×timeout
      // (or 10s × tools in production) and eats the job timeout.
      expect(posts).toBe(3);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      server.stop(true);
      await rm(state, { recursive: true, force: true });
    }
  }, 25_000);

  test("an unreachable Phoenix leaves the hooks exiting clean", async () => {
    const state = await mkdtemp(join(tmpdir(), "arize-state-"));
    try {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: state,
        // Reserved-discard port: the connect fails fast and locally.
        PHOENIX_ENDPOINT: "http://127.0.0.1:9",
        ARIZE_PROJECT_NAME: "jumi",
        ARIZE_TRACE_ENABLED: "true",
        ARIZE_LOG_PROMPTS: "false",
        ARIZE_HTTP_TIMEOUT: "2",
        JUMI_JOB_ID: "job-42",
      };
      const input = { session_id: "claude-session-2", cwd: "/work" };
      for (const name of ["session_start.sh", "user_prompt_submit.sh", "stop.sh", "session_end.sh"]) {
        const proc = Bun.spawn(["bash", join(hooks, name)], {
          env,
          stdin: new TextEncoder().encode(JSON.stringify(input)),
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await proc.exited).toBe(0);
        // Claude Code adds a UserPromptSubmit hook's stdout to the context, and
        // the parent classifies the child's stderr. The plugin stays off both.
        expect(await new Response(proc.stdout).text()).toBe("");
        expect(await new Response(proc.stderr).text()).toBe("");
      }
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
});
