import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_APPROVAL, CODEX_SANDBOX, codexArgv, REVIEW_ARTIFACT, runCodex } from "../src/codex.ts";
import { buildCodexSpans } from "../src/codex_tracing.ts";
import { CodexStreamParser } from "../src/codex_usage.ts";
import { resetControlMetricsForTests } from "../src/control_metrics.ts";
import { registeredEngine, runRegisteredEngine } from "../src/engine_dispatch.ts";
import { codexThreadPath, withEngineChain } from "../src/fallback.ts";
import { setTraceFetchForTests, traceExportErrors } from "../src/phoenix.ts";
import { CODEX_DEFAULT_EFFORT, formatRunnerStamp, type NamedRunner, runnerStamp } from "../src/runners.ts";
import { renderTokenMetrics, resetTokenMetricsForTests } from "../src/token_metrics.ts";

const originalPath = process.env.PATH;
const originalPhoenix = process.env.PHOENIX_OTLP_ENDPOINT;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalCodexKey = process.env.CODEX_API_KEY;

afterEach(() => {
  resetControlMetricsForTests();
  resetTokenMetricsForTests();
  process.env.PATH = originalPath;
  if (originalPhoenix === undefined) delete process.env.PHOENIX_OTLP_ENDPOINT;
  else process.env.PHOENIX_OTLP_ENDPOINT = originalPhoenix;
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalCodexKey === undefined) delete process.env.CODEX_API_KEY;
  else process.env.CODEX_API_KEY = originalCodexKey;
});

interface FakeEnv {
  workdir: string;
  home: string;
  argsLog: string;
}

async function withFakeBins(bins: Record<string, string>, run: (env: FakeEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const workdir = await mkdtemp(join(tmpdir(), "fake-codex-work-"));
  const home = await mkdtemp(join(tmpdir(), "fake-codex-home-"));
  try {
    for (const [name, script] of Object.entries(bins)) {
      const bin = join(dir, name);
      await writeFile(bin, script);
      await chmod(bin, 0o755);
    }
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    await run({ workdir, home, argsLog: join(dir, "args.log") });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

function fakeBin(name: string, body: string): string {
  return `#!/bin/sh
printf '${name} %s\\n' "$*" >> "$ARGS_LOG"
${body}
`;
}

async function argLines(argsLog: string): Promise<string[]> {
  try {
    return (await readFile(argsLog, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function tokenLine(model: string, tokenType: string, value: number): string {
  return `ai_tokens_total{agent_instance="jumi",source="codex",profile="default",model="${model}",token_type="${tokenType}"} ${value}`;
}

function turn(usage: Record<string, number>, model?: string): string {
  return JSON.stringify({ type: "turn.completed", ...(model ? { model } : {}), usage });
}

const THREAD = JSON.stringify({ type: "thread.started", thread_id: "thread-9" });
const AGENT = JSON.stringify({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text: "done" },
});

describe("codexArgv", () => {
  test("spawns non-interactive exec with danger-full-access, not the TUI or full-auto", () => {
    const args = codexArgv({ model: "gpt-6-sol", workdir: "/work" });
    expect(args.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(args).toContain("--json");
    expect(args).toContain(CODEX_SANDBOX);
    expect(args).toContain(`sandbox_mode="${CODEX_SANDBOX}"`);
    expect(args).toContain(`approval_policy="${CODEX_APPROVAL}"`);
    // `--ask-for-approval` and `--disable` are not documented `codex exec`
    // flags, so the argv must carry that posture via `-c` overrides only.
    expect(args).not.toContain("--ask-for-approval");
    expect(args).not.toContain("--disable");
    expect(args).toContain("features.hooks=false");
    expect(args).toContain("features.multi_agent=false");
    expect(args).toContain("features.apps=false");
    expect(args).toContain(`model_reasoning_effort="${CODEX_DEFAULT_EFFORT}"`);
    expect(args).toContain('web_search="disabled"');
    expect(args).not.toContain("--full-auto");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--search");
    expect(args).not.toContain("resume");
    expect(args.at(-1)).toBe("-");
  });

  test("resumes only an explicit thread id, never --last", () => {
    const fresh = codexArgv({ model: "gpt-6-sol", workdir: "/w", continueSession: true });
    expect(fresh).not.toContain("resume");
    const resumed = codexArgv({ model: "gpt-6-sol", workdir: "/w", continueSession: true }, "thread-9");
    expect(resumed.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(resumed).toContain("resume");
    expect(resumed).toContain("thread-9");
    expect(resumed.indexOf("resume")).toBeLessThan(resumed.indexOf("thread-9"));
    expect(resumed).not.toContain("--last");
    expect(resumed).not.toContain("--all");
  });

  test("resume uses a minimal flag list exec resume accepts", () => {
    const resumed = codexArgv({ model: "gpt-6-sol", workdir: "/w", continueSession: true }, "thread-9");
    const resumeIdx = resumed.indexOf("resume");
    // `--color` is not global on `exec`, so it and the other globals must
    // appear before the `resume` subcommand, never after it.
    expect(resumed.indexOf("--json")).toBeLessThan(resumeIdx);
    expect(resumed.indexOf("--color")).toBeLessThan(resumeIdx);
    expect(resumed.slice(resumeIdx + 2)).not.toContain("--color");
    expect(resumed.slice(resumeIdx + 2)).not.toContain("--json");
    expect(resumed.indexOf("--skip-git-repo-check")).toBeLessThan(resumeIdx);
    expect(resumed.indexOf("--ignore-rules")).toBeLessThan(resumeIdx);
    expect(resumed.indexOf("--ignore-user-config")).toBeLessThan(resumeIdx);
    // `-c` is global so it travels after the thread id; every turn-1
    // hardening override is per-invocation config and must be repeated.
    expect(resumed).toContain(`sandbox_mode="${CODEX_SANDBOX}"`);
    expect(resumed).toContain(`approval_policy="${CODEX_APPROVAL}"`);
    expect(resumed).toContain("features.hooks=false");
    expect(resumed).toContain("features.multi_agent=false");
    expect(resumed).toContain("features.apps=false");
    expect(resumed).toContain("agents.enabled=false");
    expect(resumed).toContain('web_search="disabled"');
    expect(resumed).toContain("features.context_management.experimental_mode=false");
    expect(resumed).toContain("otel.log_user_prompt=false");
    expect(resumed).toContain('otel.trace_exporter="none"');
    expect(resumed.indexOf(`sandbox_mode="${CODEX_SANDBOX}"`)).toBeGreaterThan(resumeIdx);
    // `exec resume` has rejected `-s/--sandbox` on past releases, and neither
    // `--ask-for-approval` nor `--disable` is in its flag set either.
    expect(resumed).not.toContain("--sandbox");
    expect(resumed).not.toContain("-s");
    expect(resumed).not.toContain("--ask-for-approval");
    expect(resumed).not.toContain("--disable");
    // The session already carries the model.
    expect(resumed).not.toContain("--model");
    expect(resumed.at(-1)).toBe("-");
  });
});

describe("CodexStreamParser", () => {
  test("treats usage as the running thread total and ignores unparseable lines", () => {
    const parser = new CodexStreamParser();
    parser.push(
      new TextEncoder().encode(
        `${turn({ input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 }, "gpt-6-sol")}\nnot-json\n`
      )
    );
    parser.push(
      new TextEncoder().encode(
        `${turn({ input_tokens: 13, cached_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 8 }, "gpt-6-sol")}`
      )
    );
    parser.end();
    // `input_tokens` includes the cached ones, so `input` is 13 - 5.
    const total = { input: 8, cached_input: 5, output: 7, cache_write: 0, reasoning: 8 };
    expect(parser.usage("fallback")?.get("gpt-6-sol")).toEqual(total);
    expect(parser.threadTotal()).toEqual(total);
    expect(parser.text()).toBe("not-json");
  });

  test("a resumed thread records only growth past its saved total", () => {
    const line = turn({ input_tokens: 13, cached_input_tokens: 5, output_tokens: 7 }, "gpt-6-sol");
    const resumed = new CodexStreamParser({ input: 6, cached_input: 4, output: 2, cache_write: 0, reasoning: 0 });
    resumed.push(new TextEncoder().encode(line));
    resumed.end();
    expect(resumed.usage("fallback")?.get("gpt-6-sol")).toEqual({
      input: 2,
      cached_input: 1,
      output: 5,
      cache_write: 0,
      reasoning: 0,
    });
    // A total below the saved one means the thread did not restore it.
    const reset = new CodexStreamParser({ input: 60, cached_input: 4, output: 2, cache_write: 0, reasoning: 0 });
    reset.push(new TextEncoder().encode(line));
    reset.end();
    expect(reset.usage("fallback")?.get("gpt-6-sol")?.input).toBe(8);
  });
});

describe("buildCodexSpans", () => {
  test("a failed turn is one LLM span carrying the error text", () => {
    const parser = new CodexStreamParser();
    parser.push(
      new TextEncoder().encode(
        `${JSON.stringify({ type: "turn.started" })}\n${JSON.stringify({ type: "error", message: "stream died" })}\n${JSON.stringify({ type: "turn.failed", error: { message: "stream died" } })}\n`
      )
    );
    parser.end();
    const llm = buildCodexSpans(parser.traceEvents(), undefined, "gpt-6-sol").filter(
      (span) => span.attributes["openinference.span.kind"] === "LLM"
    );
    expect(llm).toHaveLength(1);
    expect(llm[0]?.statusMessage).toBe("stream died");
  });
});

describe("runCodex", () => {
  test("uses HOME on the auth sibling, scrubs forge secrets, and does not inject an API key", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    await withFakeBins(
      {
        codex: fakeBin(
          "codex",
          `printf 'HOME=%s XDG=%s SECRET=%s KEY=%s CODEX_HOME=%s\\n' "$HOME" "$XDG_CONFIG_HOME" "$GITEA_BOT_TOKEN" "$OPENAI_API_KEY" "$CODEX_HOME"
printf '%s\\n' '${THREAD}'
printf '%s\\n' '${turn({ input_tokens: 1, output_tokens: 1 })}'`
        ),
      },
      async ({ workdir, home, argsLog }) => {
        const result = await runCodex({
          type: "codex",
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: {
            GITEA_BOT_TOKEN: "forge-secret",
            OPENAI_API_KEY: "injected",
            XDG_CONFIG_HOME: "/tmp/opencode-xdg",
            CODEX_HOME: "/tmp/opencode-xdg",
            ARGS_LOG: argsLog,
          },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain(`HOME=${home}`);
        expect(result.stdout).toContain("SECRET=");
        expect(result.stdout).not.toContain("forge-secret");
        expect(result.stdout).not.toContain("injected");
        expect(result.stdout).not.toContain("opencode-xdg");
        const [line] = await argLines(argsLog);
        expect(line).toContain("--sandbox danger-full-access");
        expect(line).not.toContain("--full-auto");
      }
    );
  });

  test("accepts an API key already in the parent env and hides it from shell policy", async () => {
    process.env.OPENAI_API_KEY = "already-set";
    await withFakeBins(
      {
        codex: fakeBin(
          "codex",
          `printf 'KEY=%s\\n' "$OPENAI_API_KEY"
printf '%s\\n' '${turn({ output_tokens: 1 })}'`
        ),
      },
      async ({ workdir, home, argsLog }) => {
        const result = await runCodex({
          type: "codex",
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("KEY=[redacted]");
        expect(result.stdout).not.toContain("already-set");
        const [line] = await argLines(argsLog);
        expect(line).toContain("shell_environment_policy.ignore_default_excludes=false");
      }
    );
  });

  test("empty review is not success and does not hop", async () => {
    const claude = fakeBin("claude", `printf 'claude ran\\n'`);
    await withFakeBins(
      {
        codex: fakeBin("codex", `printf '%s\\n' '${AGENT}'`),
        claude,
      },
      async ({ workdir, home, argsLog }) => {
        const chain: NamedRunner[] = [
          { name: "codex", type: "codex", model: "gpt-6-sol", effort: "high" },
          { name: "claude", type: "claude", model: "claude-opus-5", effort: "high" },
        ];
        const engine = withEngineChain(registeredEngine, { chain });
        const result = await engine({
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "review", owner: "o", repo: "r" },
        });
        expect(result.status).toBe("exit");
        expect(result.exitCode).toBe(0);
        expect(result.message).toContain("no artifact");
        expect(result.auth).toBeFalsy();
        const lines = await argLines(argsLog);
        expect(lines.map((line) => line.split(" ")[0])).toEqual(["codex"]);
      }
    );
  });

  test("a review that writes the artifact is success", async () => {
    await withFakeBins({ codex: fakeBin("codex", `printf '%s\\n' '${AGENT}'`) }, async ({ workdir, home, argsLog }) => {
      await writeFile(join(workdir, REVIEW_ARTIFACT), "# findings\n");
      const result = await runCodex({
        type: "codex",
        prompt: "p",
        model: "gpt-6-sol",
        workdir,
        home,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
        trace: { kind: "review", owner: "o", repo: "r" },
      });
      expect(result.status).toBe("ok");
    });
  });

  test("implement clean tree is still success", async () => {
    await withFakeBins({ codex: fakeBin("codex", `printf '%s\\n' '${AGENT}'`) }, async ({ workdir, home, argsLog }) => {
      const result = await runCodex({
        type: "codex",
        prompt: "p",
        model: "gpt-6-sol",
        workdir,
        home,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
        trace: { kind: "implement", owner: "o", repo: "r" },
      });
      expect(result.status).toBe("ok");
    });
  });

  test("exit 0 wins over quota/auth-looking stderr, mirroring claude", async () => {
    await withFakeBins(
      {
        codex: fakeBin("codex", `printf '%s\\n' '${AGENT}'\nprintf '429 rate limit, retrying\\n' >&2`),
      },
      async ({ workdir, home, argsLog }) => {
        const result = await runCodex({
          type: "codex",
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "implement", owner: "o", repo: "r" },
        });
        expect(result.status).toBe("ok");
      }
    );
  });

  test("exit-0 review with no artifact and quota-looking stderr is incomplete, not a hop", async () => {
    await withFakeBins(
      {
        codex: fakeBin("codex", `printf '%s\\n' '${AGENT}'\nprintf '429 rate limit, retrying\\n' >&2`),
      },
      async ({ workdir, home, argsLog }) => {
        const result = await runCodex({
          type: "codex",
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "review", owner: "o", repo: "r" },
        });
        expect(result.status).toBe("exit");
        expect(result.exitCode).toBe(0);
        expect(result.message).toContain("no artifact");
        expect(result.auth).toBeFalsy();
      }
    );
  });

  test("token counters move with source=codex including a killed child", async () => {
    await withFakeBins(
      {
        codex: fakeBin(
          "codex",
          `printf '%s\\n' '${turn({ input_tokens: 11, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 4 }, "gpt-6-sol")}'
printf '%s\\n' '${turn({ input_tokens: 16, cached_input_tokens: 2, output_tokens: 9, reasoning_output_tokens: 5 }, "gpt-6-sol")}'
exec sleep 30`
        ),
      },
      async ({ workdir, home, argsLog }) => {
        const result = await runCodex({
          type: "codex",
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          timeoutMs: 400,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("timeout");
        const text = renderTokenMetrics();
        expect(text).toContain(tokenLine("gpt-6-sol", "input", 14));
        expect(text).toContain(tokenLine("gpt-6-sol", "cached_input", 2));
        expect(text).toContain(tokenLine("gpt-6-sol", "output", 9));
        expect(text).toContain(tokenLine("gpt-6-sol", "reasoning", 5));
        expect(text).toContain('source="codex"');
        expect(text).not.toContain('token_type="cost"');
      }
    );
  });

  test("unparseable output records nothing and does not fail", async () => {
    await withFakeBins({ codex: fakeBin("codex", `printf 'hello\\n'`) }, async ({ workdir, home, argsLog }) => {
      const result = await runCodex({
        type: "codex",
        prompt: "p",
        model: "gpt-6-sol",
        workdir,
        home,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("ok");
      expect(renderTokenMetrics()).not.toContain('source="codex"');
    });
  });

  test("same-runner extra turn resumes that thread and never --last", async () => {
    await withFakeBins(
      {
        codex: fakeBin(
          "codex",
          `printf '%s\\n' '${THREAD}'\nprintf '%s\\n' '${turn({ output_tokens: 1 }, "gpt-6-sol")}'`
        ),
      },
      async ({ workdir, home, argsLog }) => {
        const base = {
          type: "codex" as const,
          prompt: "p",
          model: "gpt-6-sol",
          effort: "high",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        };
        expect((await runCodex(base)).status).toBe("ok");
        expect((await runCodex({ ...base, continueSession: true })).status).toBe("ok");
        const lines = await argLines(argsLog);
        expect(lines[1]).toContain("resume thread-9");
        expect(lines[1]).not.toContain("--last");
        expect(await readFile(codexThreadPath(workdir), "utf8")).toContain("thread-9");
      }
    );
  });

  test("an extra turn does not re-add the resumed thread's earlier tokens", async () => {
    await withFakeBins(
      {
        codex: fakeBin(
          "codex",
          `printf '%s\\n' '${THREAD}'
case "$*" in
  *resume*) printf '%s\\n' '${turn({ input_tokens: 30, output_tokens: 7 }, "gpt-6-sol")}' ;;
  *) printf '%s\\n' '${turn({ input_tokens: 10, output_tokens: 3 }, "gpt-6-sol")}' ;;
esac`
        ),
      },
      async ({ workdir, home, argsLog }) => {
        const base = {
          type: "codex" as const,
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        };
        expect((await runCodex(base)).status).toBe("ok");
        expect((await runCodex({ ...base, continueSession: true })).status).toBe("ok");
        const text = renderTokenMetrics();
        expect(text).toContain(tokenLine("gpt-6-sol", "input", 30));
        expect(text).toContain(tokenLine("gpt-6-sol", "output", 7));
      }
    );
  });

  test("Phoenix export failure does not fail the job", async () => {
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
    setTraceFetchForTests(() => Promise.reject(new Error("phoenix down")));
    await withFakeBins(
      {
        codex: fakeBin(
          "codex",
          `printf '%s\\n' '${AGENT}'
printf '%s\\n' '${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: "ok", status: "completed" } })}'
printf '%s\\n' '${turn({ input_tokens: 8, output_tokens: 2 }, "gpt-6-sol")}'`
        ),
      },
      async ({ workdir, home, argsLog }) => {
        const result = await runCodex({
          type: "codex",
          prompt: "do the task",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "implement", owner: "o", repo: "r", jobId: "job-1" },
        });
        expect(result.status).toBe("ok");
        expect(traceExportErrors()).toBeGreaterThan(0);
      }
    );
  });
});

describe("codex dispatch and chain", () => {
  const codex: NamedRunner = { name: "codex", type: "codex", model: "gpt-6-sol", effort: "high" };
  const claude: NamedRunner = { name: "claude", type: "claude", model: "claude-opus-5", effort: "high" };
  const claudeBin = fakeBin("claude", `printf '%s\\n' '{"type":"result","result":"claude done"}'`);

  test("runRegisteredEngine dispatches type codex", async () => {
    await withFakeBins(
      { codex: fakeBin("codex", `printf '%s\\n' '${turn({ output_tokens: 1 })}'`) },
      async ({ workdir, home, argsLog }) => {
        const result = await runRegisteredEngine({
          type: "codex",
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("ok");
        expect((await argLines(argsLog))[0]?.startsWith("codex exec")).toBe(true);
      }
    );
  });

  test("unknown runner type still fails closed", async () => {
    await expect(
      runRegisteredEngine({
        type: "hermes" as "codex",
        prompt: "p",
        model: "m",
        workdir: "/tmp",
      })
    ).rejects.toThrow("Unknown runner type: hermes");
  });

  test("auth miss hops and extras do not resume across runners", async () => {
    await withFakeBins(
      {
        codex: fakeBin("codex", `printf '%s\\n' '${THREAD}'\nprintf 'Not logged in\\n' >&2\nexit 1`),
        claude: claudeBin,
      },
      async ({ workdir, home, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [codex, claude] });
        const base = {
          prompt: "p",
          model: codex.model,
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        };
        const first = await engine(base);
        expect(first.status).toBe("ok");
        expect(first.runner).toEqual(runnerStamp(claude));
        expect(formatRunnerStamp(first.runner!)).toBe("_Jumi · claude · claude-opus-5 (high)_");
        expect(formatRunnerStamp(first.runner!)).not.toContain("ChatGPT");
        const extra = await engine({ ...base, continueSession: true });
        expect(extra.status).toBe("ok");
        const lines = await argLines(argsLog);
        expect(lines.map((line) => line.split(" ")[0])).toEqual(["codex", "claude", "claude"]);
        expect(lines[0]).not.toContain("resume");
        expect(lines[2]).toContain("--continue");
        await expect(readFile(codexThreadPath(workdir), "utf8")).rejects.toThrow();
      }
    );
  });

  test("usage-limit hops", async () => {
    await withFakeBins(
      {
        codex: fakeBin("codex", `printf 'You have hit your usage limit\\n' >&2\nexit 1`),
        claude: claudeBin,
      },
      async ({ workdir, home, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [codex, claude] });
        const result = await engine({
          prompt: "p",
          model: codex.model,
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("ok");
        expect(result.runner).toEqual(runnerStamp(claude));
      }
    );
  });

  test("a stray 5xx-looking number on a failed run does not hop", async () => {
    await withFakeBins(
      {
        codex: fakeBin("codex", `printf 'wrote 512 bytes, failed at line 530\\n' >&2\nexit 1`),
        claude: claudeBin,
      },
      async ({ workdir, home, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [codex, claude] });
        const result = await engine({
          prompt: "p",
          model: codex.model,
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("exit");
        expect(result.runner?.type).toBe("codex");
        expect((await argLines(argsLog)).map((line) => line.split(" ")[0])).toEqual(["codex"]);
      }
    );
  });

  test("provider 5xx hops and timeout does not", async () => {
    await withFakeBins(
      {
        codex: fakeBin("codex", `printf '502 bad gateway\\n' >&2\nexit 1`),
        claude: claudeBin,
      },
      async ({ workdir, home, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [codex, claude] });
        const hopped = await engine({
          prompt: "p",
          model: codex.model,
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(hopped.runner).toEqual(runnerStamp(claude));
      }
    );

    await withFakeBins(
      {
        codex: fakeBin("codex", `exec sleep 30`),
        claude: claudeBin,
      },
      async ({ workdir, home, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [codex, claude] });
        const result = await engine({
          prompt: "p",
          model: codex.model,
          workdir,
          home,
          sanitizeEnv: true,
          timeoutMs: 300,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("timeout");
        expect(result.runner?.type).toBe("codex");
        const lines = await argLines(argsLog);
        expect(lines.map((line) => line.split(" ")[0])).toEqual(["codex"]);
      }
    );
  });
});

describe("codex catalog", () => {
  test("stamp uses runner type codex, model, and effort", () => {
    expect(formatRunnerStamp(runnerStamp({ type: "codex", model: "gpt-6-sol", effort: "high" }))).toBe(
      "_Jumi · codex · gpt-6-sol (high)_"
    );
    expect(formatRunnerStamp(runnerStamp({ type: "codex", model: "gpt-6-sol", effort: "high" }))).not.toContain(
      "ChatGPT"
    );
  });
});

describe("codex image flag probe", () => {
  const repoRoot = join(process.cwd(), "../..");

  test("every image verification path probes the codex exec/resume flags", async () => {
    // `codex --version` proves the binary exists, not that it accepts the
    // argv `codexArgv()` emits — the failure class this runner already hit
    // twice. Each verification path therefore greps the no-auth
    // `codex exec --help` / `codex exec resume --help` output for the flags
    // the fresh spawn and the resume extra turn depend on, so a CODEX_VERSION
    // bump that renames one fails the image job instead of every Codex run.
    // `opencode-checks.yml` matters most: it is the one that runs on
    // pull_request, so it is what gates the bump before the image is published.
    const paths = [
      ".gitea/scripts/build-reviewer-image.sh",
      ".gitea/scripts/build-worker-image.sh",
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
    ];
    for (const path of paths) {
      const text = await readFile(join(repoRoot, path), "utf8");
      expect(text).toContain("codex exec --help");
      expect(text).toContain("codex exec resume --help");
    }
    // Both pull_request image builds in that one file — reviewer and worker —
    // ship `codex`, so both have to prove the flags, not just the first.
    const checks = await readFile(join(repoRoot, ".github/workflows/opencode-checks.yml"), "utf8");
    expect(checks.split("codex exec --help").length - 1).toBe(2);
    expect(checks.split("codex exec resume --help").length - 1).toBe(2);
  });
});
