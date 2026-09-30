import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_OUTPUT_FORMAT,
  AGY_SEED_SETTINGS,
  AGY_SETTINGS_DIR,
  AGY_SKIP_PERMISSIONS,
  agyArgv,
  agyPrintTimeout,
  agyPromptArg,
  ensureAgyForgeDeny,
  mergeAgyForgeDeny,
  runAgy,
} from "../src/agy.ts";
import { AgyStreamParser } from "../src/agy_usage.ts";
import { providerAuthDeathMessage } from "../src/auth.ts";
import { resetControlMetricsForTests } from "../src/control_metrics.ts";
import { EngineFailedError } from "../src/engine.ts";
import { registeredEngine, runRegisteredEngine } from "../src/engine_dispatch.ts";
import { agyConversationPath, withEngineChain } from "../src/fallback.ts";
import { agyReadUrlDeny, FORGE_DENY_DOMAIN } from "../src/forge_webfetch.ts";
import { formatRunnerStamp, type NamedRunner, runnerStamp } from "../src/runners.ts";
import { renderTokenMetrics, resetTokenMetricsForTests } from "../src/token_metrics.ts";

const originalPath = process.env.PATH;

afterEach(() => {
  resetControlMetricsForTests();
  resetTokenMetricsForTests();
  process.env.PATH = originalPath;
});

interface FakeEnv {
  workdir: string;
  home: string;
  argsLog: string;
}

/** Fake binaries append one line of argv per call to `$ARGS_LOG`. */
async function withFakeBins(bins: Record<string, string>, run: (env: FakeEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fake-agy-"));
  const workdir = await mkdtemp(join(tmpdir(), "fake-agy-work-"));
  const home = await mkdtemp(join(tmpdir(), "fake-agy-home-"));
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
  return `ai_tokens_total{agent_instance="jumi",source="agy",profile="default",model="${model}",token_type="${tokenType}"} ${value}`;
}

const INIT_EVENT = JSON.stringify({ event: "init", conversation_id: "conv-123" });

function stepEvent(stepId: string, usage: Record<string, number>): string {
  return JSON.stringify({ event: "step_update", step_id: stepId, usage });
}

function resultEvent(fields: Record<string, unknown>): string {
  return JSON.stringify({ event: "result", conversation_id: "conv-123", ...fields });
}

const SUCCESS_RESULT = resultEvent({
  status: "SUCCESS",
  response: "wrote JUMI_PR.md",
  usage: {
    input_tokens: 12000,
    output_tokens: 300,
    thinking_tokens: 40,
    cache_read_tokens: 9000,
    total_tokens: 21340,
  },
});

describe("mergeAgyForgeDeny", () => {
  test("adds the apex rule and keeps an allow of the same host", () => {
    const next = mergeAgyForgeDeny(
      { account: "logged-in", permissions: { allow: ["read_url(github.com)"], deny: ["command(sudo)"] } },
      "github.com"
    );
    expect(next).toEqual({
      account: "logged-in",
      permissions: { allow: ["read_url(github.com)"], deny: ["command(sudo)", agyReadUrlDeny("github.com")] },
    });
  });

  test("refuses a host that would break the rule", () => {
    expect(() => mergeAgyForgeDeny({}, "github.com)")).toThrow(/refusing/);
  });

  test("refuses a deny list it cannot merge", async () => {
    const home = await mkdtemp(join(tmpdir(), "agy-deny-"));
    try {
      const dir = join(home, AGY_SETTINGS_DIR);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "settings.json"), JSON.stringify({ permissions: { deny: "read_url(*)" } }));
      await expect(ensureAgyForgeDeny(home, FORGE_DENY_DOMAIN)).rejects.toBeInstanceOf(EngineFailedError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("agyArgv", () => {
  test("print mode with stream-json, skip-permissions, model, effort, lease print-timeout", () => {
    const args = agyArgv({ model: "gemini-3-pro", effort: "high", workdir: "/work", timeoutMs: 600_000 }, "prompt");
    expect(args).toEqual([
      "agy",
      "-p",
      "prompt",
      "--output-format",
      AGY_OUTPUT_FORMAT,
      AGY_SKIP_PERMISSIONS,
      "--model",
      "gemini-3-pro",
      "--effort",
      "high",
      "--print-timeout",
      "570s",
    ]);
    expect(AGY_OUTPUT_FORMAT).toBe("stream-json");
  });

  test("resumes a known conversation by id only, never --continue", () => {
    expect(agyArgv({ model: "m", workdir: "/w" }, "p", "conv-1")).not.toContain("--conversation");
    expect(agyArgv({ model: "m", workdir: "/w" }, "p", "conv-1")).not.toContain("--continue");
    expect(agyArgv({ model: "m", workdir: "/w", continueSession: true }, "p")).not.toContain("--continue");
    expect(agyArgv({ model: "m", workdir: "/w", continueSession: true }, "p")).not.toContain("--conversation");
    expect(agyArgv({ model: "m", workdir: "/w", continueSession: true }, "p", "conv-1").slice(-2)).toEqual([
      "--conversation",
      "conv-1",
    ]);
    expect(agyArgv({ model: "m", workdir: "/w", continueSession: true }, "p", "conv-1")).not.toContain("--continue");
  });

  test("never lets the print prompt start with a slash command", () => {
    expect(agyPromptArg("/review now")).toBe("Task:\n/review now");
    expect(agyPromptArg("  /skill")).toStartWith("Task:");
    expect(agyPromptArg("Read JUMI_TASK.md")).toBe("Read JUMI_TASK.md");
  });

  test("print-timeout comes from the lease and is omitted without one", () => {
    expect(agyPrintTimeout(undefined)).toBeUndefined();
    expect(agyPrintTimeout(0)).toBeUndefined();
    expect(agyPrintTimeout(10_000)).toBe("10s");
    expect(agyPrintTimeout(3_600_000)).toBe("3570s");
  });
});

describe("AgyStreamParser", () => {
  function parse(lines: string[]): AgyStreamParser {
    const parser = new AgyStreamParser("fallback-model");
    parser.push(new TextEncoder().encode(`${lines.join("\n")}\n`));
    parser.end();
    return parser;
  }

  test("takes usage from the terminal result event", () => {
    const parser = parse([INIT_EVENT, stepEvent("s1", { input_tokens: 5, output_tokens: 1 }), SUCCESS_RESULT]);
    expect(parser.usage()).toEqual(
      new Map([["fallback-model", { input: 12000, cached_input: 9000, output: 300, cache_write: 0, reasoning: 40 }]])
    );
    expect(parser.result()).toEqual({
      status: "SUCCESS",
      response: "wrote JUMI_PR.md",
      error: undefined,
      deniedActions: [],
    });
    expect(parser.conversationId()).toBe("conv-123");
    expect(parser.text()).toBe("wrote JUMI_PR.md");
  });

  test("falls back to accumulated per-step usage when killed before result", () => {
    const parser = parse([
      INIT_EVENT,
      stepEvent("s1", { input_tokens: 10, output_tokens: 1 }),
      stepEvent("s1", { input_tokens: 10, output_tokens: 4, thinking_tokens: 2 }),
      JSON.stringify({ event: "step_update", step: { id: "s2", usage: { input_tokens: 5, cache_read_tokens: 7 } } }),
    ]);
    expect(parser.result()).toBeUndefined();
    expect(parser.usage()).toEqual(
      new Map([["fallback-model", { input: 15, cached_input: 7, output: 4, cache_write: 0, reasoning: 2 }]])
    );
  });

  test("missing usage and non-json lines are fail-open", () => {
    const parser = parse(["{not json", resultEvent({ status: "SUCCESS", response: "ok", usage: "nope" })]);
    expect(parser.usage()).toBeUndefined();
    expect(parser.text()).toBe("{not json\nok");
  });

  test("unwraps documented nested result and step_update payloads", () => {
    const parser = parse([
      JSON.stringify({
        event: "init",
        conversation_id: "c3b66b04-872b-4fbe-a3a4-058a026ef20a",
        init: { cwd: "/home/user/project", tools: ["run_command"], permission_mode: "always-proceed" },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "c3b66b04-872b-4fbe-a3a4-058a026ef20a",
          step_index: 3,
          state: "DONE",
          step_type: "agent_response",
          usage: {
            input_tokens: 10302,
            output_tokens: 582,
            thinking_tokens: 551,
            cache_read_tokens: 8113,
            total_tokens: 10884,
          },
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "c3b66b04-872b-4fbe-a3a4-058a026ef20a",
          status: "SUCCESS",
          response: "Git rebase destructively rewrites a branch's commit history.\n",
          usage: {
            input_tokens: 10418,
            output_tokens: 589,
            thinking_tokens: 551,
            cache_read_tokens: 8113,
            total_tokens: 11007,
          },
        },
      }),
    ]);
    expect(parser.conversationId()).toBe("c3b66b04-872b-4fbe-a3a4-058a026ef20a");
    expect(parser.result()).toEqual({
      status: "SUCCESS",
      response: "Git rebase destructively rewrites a branch's commit history.\n",
      error: undefined,
      deniedActions: [],
    });
    expect(parser.text()).toBe("Git rebase destructively rewrites a branch's commit history.\n");
    expect(parser.usage()).toEqual(
      new Map([["fallback-model", { input: 10418, cached_input: 8113, output: 589, cache_write: 0, reasoning: 551 }]])
    );
  });

  test("nested step_update usage is keyed by step_index when killed before result", () => {
    const parser = parse([
      JSON.stringify({
        event: "step_update",
        step_update: { step_index: 3, usage: { input_tokens: 10, output_tokens: 1 } },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: { step_index: 3, usage: { input_tokens: 10, output_tokens: 4, thinking_tokens: 2 } },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: { step_index: 4, usage: { input_tokens: 5, cache_read_tokens: 7 } },
      }),
    ]);
    expect(parser.result()).toBeUndefined();
    expect(parser.usage()).toEqual(
      new Map([["fallback-model", { input: 15, cached_input: 7, output: 4, cache_write: 0, reasoning: 2 }]])
    );
  });

  test("nested error and denied_actions fail closed", () => {
    const errorParser = parse([
      JSON.stringify({ event: "result", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED", response: "" } }),
    ]);
    expect(errorParser.result()).toEqual({
      status: "ERROR",
      response: "",
      error: "RESOURCE_EXHAUSTED",
      deniedActions: [],
    });
    const deniedParser = parse([
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "", denied_actions: ["RunCommand"] },
      }),
    ]);
    expect(deniedParser.result()).toEqual({
      status: "SUCCESS",
      response: "",
      error: undefined,
      deniedActions: ["RunCommand"],
    });
  });
});

describe("runAgy", () => {
  test("spawns agy in the worktree with HOME, scrubbed forge secrets, and seeded settings", async () => {
    await withFakeBins(
      {
        agy: fakeBin(
          "agy",
          `printf '%s\\n' "{\\"event\\":\\"result\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"HOME=$HOME SECRET=$GITEA_BOT_TOKEN CWD=$(pwd)\\"}"`
        ),
      },
      async ({ workdir, home, argsLog }) => {
        const result = await runAgy({
          prompt: "Read JUMI_TASK.md",
          model: "gemini-3-pro",
          effort: "high",
          workdir,
          home,
          sanitizeEnv: true,
          trace: { kind: "implement", owner: "kirmanak", repo: "jumi" },
          extraEnv: { ARGS_LOG: argsLog, GITEA_BOT_TOKEN: "should-not-pass" },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toBe(`HOME=${home} SECRET= CWD=${workdir}`);
        const [line] = await argLines(argsLog);
        expect(line).toContain(`agy -p Read JUMI_TASK.md --output-format stream-json ${AGY_SKIP_PERMISSIONS}`);
        expect(line).toContain("--model gemini-3-pro --effort high");
        const settings = JSON.parse(await readFile(join(home, AGY_SETTINGS_DIR, "settings.json"), "utf8"));
        expect(settings).toEqual({
          ...AGY_SEED_SETTINGS,
          permissions: { deny: [agyReadUrlDeny(FORGE_DENY_DOMAIN)] },
        });
      }
    );
  });

  test("preserves a logged-in settings file and still denies the forge host", async () => {
    await withFakeBins(
      { agy: fakeBin("agy", `printf '%s\\n' '${SUCCESS_RESULT}'`) },
      async ({ workdir, home, argsLog }) => {
        const dir = join(home, AGY_SETTINGS_DIR);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "settings.json"),
          JSON.stringify({
            account: "logged-in",
            permissions: { allow: [agyReadUrlDeny("github.com"), "read_url(*)"] },
          })
        );
        await runAgy({
          prompt: "p",
          model: "m",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog, GIT_AUTH_HOST: "github.com" },
        });
        const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
        expect(settings.account).toBe("logged-in");
        expect(settings.permissions.allow).toEqual([agyReadUrlDeny("github.com"), "read_url(*)"]);
        expect(settings.permissions.deny).toEqual([agyReadUrlDeny("github.com")]);
        expect(await argLines(argsLog)).toHaveLength(1);
      }
    );
  });

  test("does not spawn when the forge read_url deny cannot be installed", async () => {
    await withFakeBins(
      { agy: fakeBin("agy", `printf '%s\\n' '${SUCCESS_RESULT}'`) },
      async ({ workdir, home, argsLog }) => {
        const dir = join(home, AGY_SETTINGS_DIR);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "settings.json"), "{not json");
        await expect(
          runAgy({ prompt: "p", model: "m", workdir, home, sanitizeEnv: true, extraEnv: { ARGS_LOG: argsLog } })
        ).rejects.toBeInstanceOf(EngineFailedError);
        expect(await argLines(argsLog)).toEqual([]);
      }
    );
  });

  test("reviewer spawn execs agy", async () => {
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${SUCCESS_RESULT}'`) }, async ({ workdir, argsLog }) => {
      const result = await runAgy({
        prompt: "p",
        model: "m",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
        trace: { kind: "review", owner: "o", repo: "r" },
      });
      expect(result.status).toBe("ok");
      expect(await argLines(argsLog)).toHaveLength(1);
    });
  });

  test("reviewer spawn keeps checkout skills and stashes checkout hooks, then restores them", async () => {
    // What the child can see, one line per path: skills in every root stay,
    // hooks.json, plugins (which bundle hooks), and non-directory roots go.
    const probe = [
      ".agents/skills/checkout-skill/SKILL.md",
      "_agents/skills/underscore-skill/SKILL.md",
      ".agents/hooks.json",
      ".agents/plugins/p/hooks.json",
      "_agents/hooks.json",
      "_agent/hooks.json",
      ".agent",
    ]
      .map((path) => `if [ -e ${path} ]; then echo "yes ${path}"; else echo "no ${path}"; fi >> "$ARGS_LOG.seen"`)
      .join("\n");
    await withFakeBins(
      { agy: fakeBin("agy", `${probe}\nprintf '%s\\n' '${SUCCESS_RESULT}'`) },
      async ({ workdir, argsLog }) => {
        const skill = "---\nname: checkout-skill\ndescription: d\n---\nbody\n";
        await mkdir(join(workdir, ".agents", "skills", "checkout-skill"), { recursive: true });
        await writeFile(join(workdir, ".agents", "skills", "checkout-skill", "SKILL.md"), skill);
        await writeFile(join(workdir, ".agents", "hooks.json"), '{"hooks":[]}');
        await mkdir(join(workdir, ".agents", "plugins", "p"), { recursive: true });
        await writeFile(join(workdir, ".agents", "plugins", "p", "hooks.json"), '{"hooks":[]}');
        await mkdir(join(workdir, "_agents", "skills", "underscore-skill"), { recursive: true });
        await writeFile(join(workdir, "_agents", "skills", "underscore-skill", "SKILL.md"), skill);
        await writeFile(join(workdir, "_agents", "hooks.json"), '{"hooks":[]}');
        await mkdir(join(workdir, "_agent"), { recursive: true });
        await writeFile(join(workdir, "_agent", "hooks.json"), '{"hooks":[]}');
        await writeFile(join(workdir, ".agent"), "plugin");
        const result = await runAgy({
          prompt: "p",
          model: "m",
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "review", owner: "o", repo: "r" },
        });
        expect(result.status).toBe("ok");
        expect((await readFile(`${argsLog}.seen`, "utf8")).trim().split("\n")).toEqual([
          "yes .agents/skills/checkout-skill/SKILL.md",
          "yes _agents/skills/underscore-skill/SKILL.md",
          "no .agents/hooks.json",
          "no .agents/plugins/p/hooks.json",
          "no _agents/hooks.json",
          "no _agent/hooks.json",
          "no .agent",
        ]);
        expect(await readFile(join(workdir, ".agents", "hooks.json"), "utf8")).toBe('{"hooks":[]}');
        expect(await readFile(join(workdir, ".agents", "plugins", "p", "hooks.json"), "utf8")).toBe('{"hooks":[]}');
        expect(await readFile(join(workdir, ".agents", "skills", "checkout-skill", "SKILL.md"), "utf8")).toBe(skill);
        expect(await readFile(join(workdir, "_agents", "hooks.json"), "utf8")).toBe('{"hooks":[]}');
        expect(await readFile(join(workdir, "_agents", "skills", "underscore-skill", "SKILL.md"), "utf8")).toBe(skill);
        expect(await readFile(join(workdir, "_agent", "hooks.json"), "utf8")).toBe('{"hooks":[]}');
        expect(await readFile(join(workdir, ".agent"), "utf8")).toBe("plugin");
      }
    );
  });

  test("reviewer restore drops whatever the child wrote into the skills-only root", async () => {
    await withFakeBins(
      {
        agy: fakeBin(
          "agy",
          `echo '{"x":1}' > .agents/hooks.json\nmkdir -p .agents/skills/new && echo new > .agents/skills/new/SKILL.md\nprintf '%s\\n' '${SUCCESS_RESULT}'`
        ),
      },
      async ({ workdir, argsLog }) => {
        await mkdir(join(workdir, ".agents", "skills", "s"), { recursive: true });
        await writeFile(join(workdir, ".agents", "skills", "s", "SKILL.md"), "s");
        await writeFile(join(workdir, ".agents", "hooks.json"), '{"hooks":[]}');
        const result = await runAgy({
          prompt: "p",
          model: "m",
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "review", owner: "o", repo: "r" },
        });
        expect(result.status).toBe("ok");
        // The checkout's own hooks.json is back; the one the child wrote is gone.
        expect(await readFile(join(workdir, ".agents", "hooks.json"), "utf8")).toBe('{"hooks":[]}');
        expect(await readFile(join(workdir, ".agents", "skills", "s", "SKILL.md"), "utf8")).toBe("s");
      }
    );
  });

  test("implementer spawn leaves checkout .agents in cwd", async () => {
    const seen = 'if [ -e .agents ]; then echo yes >> "$ARGS_LOG.seen"; else echo no >> "$ARGS_LOG.seen"; fi';
    await withFakeBins(
      { agy: fakeBin("agy", `${seen}\nprintf '%s\\n' '${SUCCESS_RESULT}'`) },
      async ({ workdir, argsLog }) => {
        await mkdir(join(workdir, ".agents"), { recursive: true });
        await writeFile(join(workdir, ".agents", "hooks.json"), '{"hooks":[]}');
        const result = await runAgy({
          prompt: "p",
          model: "m",
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "implement", owner: "o", repo: "r" },
        });
        expect(result.status).toBe("ok");
        expect(await readFile(`${argsLog}.seen`, "utf8")).toBe("yes\n");
        expect(await readFile(join(workdir, ".agents", "hooks.json"), "utf8")).toBe('{"hooks":[]}');
      }
    );
  });

  test("reviewer restore happens after a failed spawn", async () => {
    const seen = 'if [ -e .agents ]; then echo yes >> "$ARGS_LOG.seen"; else echo no >> "$ARGS_LOG.seen"; fi';
    await withFakeBins(
      { agy: fakeBin("agy", `${seen}\nprintf 'Please sign in to continue\\n' >&2\nexit 1`) },
      async ({ workdir, argsLog }) => {
        await mkdir(join(workdir, ".agents"), { recursive: true });
        await writeFile(join(workdir, ".agents", "hooks.json"), '{"hooks":[]}');
        const result = await runAgy({
          prompt: "p",
          model: "m",
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "review", owner: "o", repo: "r" },
        });
        expect(result.auth).toBe(true);
        expect(await readFile(`${argsLog}.seen`, "utf8")).toBe("no\n");
        expect(await readFile(join(workdir, ".agents", "hooks.json"), "utf8")).toBe('{"hooks":[]}');
      }
    );
  });

  test("records nested stream-json result usage under source=agy", async () => {
    const nested = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-nested",
        status: "SUCCESS",
        response: "wrote JUMI_PR.md",
        usage: {
          input_tokens: 10418,
          output_tokens: 589,
          thinking_tokens: 551,
          cache_read_tokens: 8113,
          total_tokens: 11007,
        },
      },
    });
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${nested}'`) }, async ({ workdir, argsLog }) => {
      const result = await runAgy({
        prompt: "p",
        model: "gemini-3-pro",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("ok");
      expect(result.stdout).toBe("wrote JUMI_PR.md");
      const text = renderTokenMetrics();
      expect(text).toContain(tokenLine("gemini-3-pro", "input", 10418));
      expect(text).toContain(tokenLine("gemini-3-pro", "output", 589));
      expect((await readFile(agyConversationPath(workdir), "utf8")).trim()).toBe("conv-nested");
    });
  });

  test("records result usage under source=agy", async () => {
    await withFakeBins(
      { agy: fakeBin("agy", `printf '%s\\n' '${INIT_EVENT}'\nprintf '%s\\n' '${SUCCESS_RESULT}'`) },
      async ({ workdir, argsLog }) => {
        const result = await runAgy({
          prompt: "p",
          model: "gemini-3-pro",
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("ok");
        const text = renderTokenMetrics();
        expect(text).toContain(tokenLine("gemini-3-pro", "input", 12000));
        expect(text).toContain(tokenLine("gemini-3-pro", "cached_input", 9000));
        expect(text).toContain(tokenLine("gemini-3-pro", "output", 300));
        expect(text).toContain(tokenLine("gemini-3-pro", "reasoning", 40));
        expect(text).toContain(
          'ai_sessions{agent_instance="jumi",source="agy",profile="default",model="gemini-3-pro"} 1'
        );
        expect((await readFile(agyConversationPath(workdir), "utf8")).trim()).toBe("conv-123");
      }
    );
  });

  test("records per-step usage when the parent kills the child before result", async () => {
    await withFakeBins(
      {
        agy: fakeBin(
          "agy",
          `printf '%s\\n' '${stepEvent("s1", { input_tokens: 12000, output_tokens: 3 })}'
printf '%s\\n' '${stepEvent("s2", { input_tokens: 500, output_tokens: 7 })}'
exec sleep 30`
        ),
      },
      async ({ workdir, argsLog }) => {
        const result = await runAgy({
          prompt: "p",
          model: "gemini-3-pro",
          workdir,
          sanitizeEnv: true,
          timeoutMs: 500,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("timeout");
        const text = renderTokenMetrics();
        expect(text).toContain(tokenLine("gemini-3-pro", "input", 12500));
        expect(text).toContain(tokenLine("gemini-3-pro", "output", 10));
      }
    );
  });

  test("empty SUCCESS with denied actions fails closed", async () => {
    const denied = resultEvent({ status: "SUCCESS", response: "", denied_actions: ["RunCommand"] });
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${denied}'`) }, async ({ workdir, argsLog }) => {
      const result = await runAgy({
        prompt: "p",
        model: "m",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("exit");
      expect(result.exitCode).toBe(0);
      expect(result.auth).toBeFalsy();
      expect(result.message).toContain("denied actions: RunCommand");
    });
  });

  test("non-SUCCESS status on exit 0 is not a completed run", async () => {
    const failed = resultEvent({ status: "ERROR", error: "boom" });
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${failed}'`) }, async ({ workdir, argsLog }) => {
      const result = await runAgy({
        prompt: "p",
        model: "m",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("exit");
      expect(result.message).toContain("agy result status ERROR: boom");
    });
  });

  test("unauthed CLI is auth death", async () => {
    await withFakeBins(
      { agy: fakeBin("agy", `printf 'Please sign in to continue\\n' >&2\nexit 1`) },
      async ({ workdir, argsLog }) => {
        const result = await runAgy({
          prompt: "p",
          model: "m",
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("exit");
        expect(result.auth).toBe(true);
        expect(result.message).toBe(providerAuthDeathMessage());
      }
    );
  });

  test("result error authentication required is auth death", async () => {
    const failed = resultEvent({ status: "ERROR", error: "authentication required" });
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${failed}'\nexit 1`) }, async ({ workdir, argsLog }) => {
      const result = await runAgy({
        prompt: "p",
        model: "m",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("exit");
      expect(result.auth).toBe(true);
      expect(result.message).toBe(providerAuthDeathMessage());
    });
  });

  test("response text about authentication is not auth death", async () => {
    const failed = resultEvent({
      status: "ERROR",
      error: "tool failed",
      response: "authentication required to call the login API",
    });
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${failed}'\nexit 1`) }, async ({ workdir, argsLog }) => {
      const result = await runAgy({
        prompt: "p",
        model: "m",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("exit");
      expect(result.auth).toBeFalsy();
      expect(result.message).toContain("agy exited with code 1");
    });
  });
});

describe("agy dispatch and chain", () => {
  const agy: NamedRunner = { name: "agy", type: "agy", model: "gemini-3-pro", effort: "high" };
  const claude: NamedRunner = { name: "claude", type: "claude", model: "claude-opus-5", effort: "high" };
  const claudeBin = fakeBin("claude", `printf '%s\\n' '{"type":"result","result":"claude done"}'`);

  test("runRegisteredEngine dispatches type agy to the agy binary", async () => {
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${SUCCESS_RESULT}'`) }, async ({ workdir, argsLog }) => {
      const result = await runRegisteredEngine({
        type: "agy",
        prompt: "p",
        model: "gemini-3-pro",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("ok");
      expect(await argLines(argsLog)).toHaveLength(1);
    });
  });

  test("reviewer auth miss hops to the next runner", async () => {
    await withFakeBins(
      {
        agy: fakeBin("agy", `printf '%s\\n' '${INIT_EVENT}'\nprintf 'authentication required\\n' >&2\nexit 1`),
        claude: claudeBin,
      },
      async ({ workdir, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [agy, claude] });
        const result = await engine({
          prompt: "p",
          model: agy.model,
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "review", owner: "o", repo: "r" },
        });
        expect(result.status).toBe("ok");
        expect(result.runner).toEqual(runnerStamp(claude));
        const lines = await argLines(argsLog);
        expect(lines.map((line) => line.split(" ")[0])).toEqual(["agy", "claude"]);
      }
    );
  });

  test("auth miss hops to the next runner, and extras never --continue across runners", async () => {
    await withFakeBins(
      {
        agy: fakeBin("agy", `printf '%s\\n' '${INIT_EVENT}'\nprintf 'authentication required\\n' >&2\nexit 1`),
        claude: claudeBin,
      },
      async ({ workdir, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [agy, claude] });
        const base = { prompt: "p", model: agy.model, workdir, sanitizeEnv: true, extraEnv: { ARGS_LOG: argsLog } };
        const first = await engine(base);
        expect(first.status).toBe("ok");
        expect(first.runner).toEqual(runnerStamp(claude));
        const extra = await engine({ ...base, continueSession: true });
        expect(extra.status).toBe("ok");
        const lines = await argLines(argsLog);
        expect(lines.map((line) => line.split(" ")[0])).toEqual(["agy", "claude", "claude"]);
        expect(lines[1]).not.toContain("--continue");
        expect(lines[2]).toContain("--continue");
        expect(lines[2]).not.toContain("--conversation");
        await expect(readFile(agyConversationPath(workdir), "utf8")).rejects.toThrow();
      }
    );
  });

  test("RESOURCE_EXHAUSTED hops as provider unavailable", async () => {
    await withFakeBins(
      {
        agy: fakeBin(
          "agy",
          `printf '%s\\n' '${resultEvent({ status: "ERROR", error: "RESOURCE_EXHAUSTED" })}'\nexit 1`
        ),
        claude: claudeBin,
      },
      async ({ workdir, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [agy, claude] });
        const result = await engine({
          prompt: "p",
          model: agy.model,
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("ok");
        expect(result.runner).toEqual(runnerStamp(claude));
      }
    );
  });

  test("continueSession without a worktree conversation id is a fresh run, never --continue", async () => {
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${SUCCESS_RESULT}'`) }, async ({ workdir, argsLog }) => {
      await runAgy({
        prompt: "p",
        model: "m",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
        continueSession: true,
      });
      const [line] = await argLines(argsLog);
      expect(line).not.toContain("--continue");
      expect(line).not.toContain("--conversation");
    });
  });

  test("same-runner extras resume the agy conversation", async () => {
    await withFakeBins(
      {
        agy: fakeBin("agy", `printf '%s\\n' '${INIT_EVENT}'\nprintf '%s\\n' '${SUCCESS_RESULT}'`),
        claude: claudeBin,
      },
      async ({ workdir, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [agy, claude] });
        const base = { prompt: "p", model: agy.model, workdir, sanitizeEnv: true, extraEnv: { ARGS_LOG: argsLog } };
        const first = await engine(base);
        expect(first.runner).toEqual(runnerStamp(agy));
        expect(formatRunnerStamp(first.runner!)).toBe("_Jumi · agy · gemini-3-pro (high)_");
        await engine({ ...base, continueSession: true });
        const lines = await argLines(argsLog);
        expect(lines.map((line) => line.split(" ")[0])).toEqual(["agy", "agy"]);
        expect(lines[0]).not.toContain("--conversation");
        expect(lines[0]).not.toContain("--continue");
        expect(lines[1]).toContain("--conversation conv-123");
        expect(lines[1]).not.toContain("--continue");
      }
    );
  });
});
