import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_DEATH_REASON, looksLikeProviderAuthDeath } from "../src/auth.ts";
import {
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_OUTPUT_FORMAT,
  CLAUDE_PERMISSION_MODE,
  CLAUDE_SETTING_SOURCES,
  claudeArgv,
  inspectClaudeUsageLimit,
  runClaude,
} from "../src/claude.ts";
import { setClaudeTracingPluginDirForTests } from "../src/claude_tracing.ts";
import { renderRunMetrics, resetControlMetricsForTests } from "../src/control_metrics.ts";
import { runRegisteredEngine } from "../src/engine_dispatch.ts";
import { withEngineChain } from "../src/fallback.ts";
import { claudeDisallowedTools, FORGE_DENY_DOMAIN } from "../src/forge_webfetch.ts";
import { QUOTA_MESSAGE } from "../src/quota.ts";
import { omitClaudeConfigWarning } from "../src/status_description.ts";
import { renderTokenMetrics, resetTokenMetricsForTests } from "../src/token_metrics.ts";

const originalPath = process.env.PATH;
const originalSecret = process.env.GITEA_BOT_TOKEN;
const originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalPhoenix = process.env.PHOENIX_OTLP_ENDPOINT;
const originalAgent = process.env.AGENT_INSTANCE;
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "../../../claude-plugins/claude-code-tracing");

afterEach(() => {
  resetControlMetricsForTests();
  resetTokenMetricsForTests();
  setClaudeTracingPluginDirForTests(undefined);
  if (originalPhoenix === undefined) delete process.env.PHOENIX_OTLP_ENDPOINT;
  else process.env.PHOENIX_OTLP_ENDPOINT = originalPhoenix;
  if (originalAgent === undefined) delete process.env.AGENT_INSTANCE;
  else process.env.AGENT_INSTANCE = originalAgent;
  process.env.PATH = originalPath;
  if (originalSecret === undefined) delete process.env.GITEA_BOT_TOKEN;
  else process.env.GITEA_BOT_TOKEN = originalSecret;
  if (originalOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

async function withFakeClaude(script: string, run: (workdir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fake-claude-"));
  const workdir = await realpath(await mkdtemp(join(tmpdir(), "fake-claude-work-")));
  try {
    const bin = join(dir, "claude");
    await writeFile(bin, script);
    await chmod(bin, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    await run(workdir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("inspectClaudeUsageLimit", () => {
  test("classifies Claude session and usage limits as resetting", () => {
    expect(inspectClaudeUsageLimit("You've hit your session limit · resets 12:50am (UTC)")).toBe("resetting");
    expect(inspectClaudeUsageLimit("You've hit your usage limit")).toBe("resetting");
    expect(inspectClaudeUsageLimit("You've hit your Opus limit")).toBe("resetting");
    expect(inspectClaudeUsageLimit("You've hit your Sonnet limit")).toBe("resetting");
    expect(inspectClaudeUsageLimit("You've hit your limit · resets 5pm")).toBe("resetting");
    expect(inspectClaudeUsageLimit("Claude AI usage limit reached")).toBe("resetting");
  });

  test("does not guess from generic rate-limit or bare usage-limit text", () => {
    expect(inspectClaudeUsageLimit("429 rate limit exceeded")).toBeUndefined();
    expect(inspectClaudeUsageLimit("You've hit your spend limit")).toBeUndefined();
    expect(inspectClaudeUsageLimit("Usage limit reached. It will reset in 1 hour")).toBeUndefined();
    expect(inspectClaudeUsageLimit("my-model usage limit reached")).toBeUndefined();
    expect(inspectClaudeUsageLimit("bad things")).toBeUndefined();
    expect(inspectClaudeUsageLimit("")).toBeUndefined();
    expect(inspectClaudeUsageLimit(null)).toBeUndefined();
  });
});

describe("claudeArgv", () => {
  test("uses -p, user and project setting-sources, allowlist, and never --bare", () => {
    const args = claudeArgv({ model: "opus", effort: "high", workdir: "/work" });
    expect(args).toEqual([
      "claude",
      "-p",
      "--setting-sources",
      CLAUDE_SETTING_SOURCES,
      "--permission-mode",
      CLAUDE_PERMISSION_MODE,
      "--allowedTools",
      CLAUDE_ALLOWED_TOOLS,
      "--disallowedTools",
      claudeDisallowedTools(FORGE_DENY_DOMAIN),
      "--output-format",
      CLAUDE_OUTPUT_FORMAT,
      "--verbose",
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
    expect(args).not.toContain("--bare");
    // Values, not just shape: these three are the ones the claude binary
    // validates, and a rejected value is a generic non-zero exit on every
    // spawn. `src/claude_flag_probe.ts` re-runs the same literals against the
    // installed binary in the image job.
    expect(CLAUDE_SETTING_SOURCES).toBe("user,project");
    expect(CLAUDE_ALLOWED_TOOLS.split(",")).toContain("Skill");
    expect(CLAUDE_OUTPUT_FORMAT).toBe("stream-json");
    expect(CLAUDE_PERMISSION_MODE).toBe("dontAsk");
  });

  test("denies WebFetch of the forge apex and its subdomains by host, not by prose", () => {
    // Claude matches `domain:` against the hostname, and `*.host` does not
    // cover the apex, so both rules are needed. Deny outranks --allowedTools,
    // which keeps WebFetch available for public docs.
    expect(claudeDisallowedTools(FORGE_DENY_DOMAIN).split(",")).toEqual([
      `WebFetch(domain:${FORGE_DENY_DOMAIN})`,
      `WebFetch(domain:*.${FORGE_DENY_DOMAIN})`,
    ]);
    expect(CLAUDE_ALLOWED_TOOLS.split(",")).toContain("WebFetch");
    expect(claudeArgv({ model: "opus", workdir: "/work" })).toContain("--disallowedTools");
  });

  test("denies the forge host this spawn authenticates against", () => {
    // GIT_AUTH_HOST comes from the configured forge, so a GitHub-factory child
    // denies github.com/api.github.com instead of only the Gitea default.
    const args = claudeArgv({
      model: "opus",
      workdir: "/work",
      extraEnv: { GIT_AUTH_HOST: "github.com", GIT_AUTH_TOKEN: "write-capable" },
    });
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(
      "WebFetch(domain:github.com),WebFetch(domain:*.github.com)"
    );

    // Claude matches `domain:` against hostname with no port, so a rule that
    // kept `:3000` would never fire. Dropping the port is load-bearing here.
    const ported = claudeArgv({
      model: "opus",
      workdir: "/work",
      extraEnv: { GIT_AUTH_HOST: "gitea.example.com:3000" },
    });
    expect(ported[ported.indexOf("--disallowedTools") + 1]).toBe(
      "WebFetch(domain:gitea.example.com),WebFetch(domain:*.gitea.example.com)"
    );

    // No GIT_AUTH_HOST (reviewer, env-less spawns): the default still applies.
    const fallback = claudeArgv({ model: "opus", workdir: "/work" });
    expect(fallback[fallback.indexOf("--disallowedTools") + 1]).toBe(claudeDisallowedTools(FORGE_DENY_DOMAIN));
  });

  test("names the image-local tracing plugin", () => {
    // The plugin is how a Claude run reaches Phoenix at all: it has no session
    // sqlite for the parent to export.
    setClaudeTracingPluginDirForTests(pluginDir);
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
    const traced = claudeArgv({ model: "opus", workdir: "/work" });
    expect(traced[traced.indexOf("--plugin-dir") + 1]).toBe(pluginDir);
    expect(traced).toContain(`--setting-sources`);
    expect(traced).not.toContain("--bare");

    // No Phoenix configured: the child runs untraced rather than failing.
    delete process.env.PHOENIX_OTLP_ENDPOINT;
    expect(claudeArgv({ model: "opus", workdir: "/work" })).not.toContain("--plugin-dir");
  });
});

describe("runClaude", () => {
  test("passes HOME and OAuth token, scrubs forge secrets, and does not use OpenCode XDG_CONFIG_HOME", async () => {
    process.env.GITEA_BOT_TOKEN = "secret-token";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    process.env.XDG_CONFIG_HOME = "/tmp/opencode-xdg";
    await withFakeClaude(
      `#!/bin/sh
printf 'HOME=%s OAUTH=%s XDG_CONFIG=%s SECRET=%s ARGS=%s CWD=%s\\n' "$HOME" "$CLAUDE_CODE_OAUTH_TOKEN" "$XDG_CONFIG_HOME" "$GITEA_BOT_TOKEN" "$*" "$(pwd)"
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "opus",
          effort: "high",
          workdir,
          home: "/data",
          sanitizeEnv: true,
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("HOME=/data");
        expect(result.stdout).toContain("OAUTH=oauth-token");
        expect(result.stdout).toContain("XDG_CONFIG=");
        expect(result.stdout).not.toContain("opencode-xdg");
        expect(result.stdout).not.toContain(`${workdir}/.jumi-tmp/xdg-config`);
        expect(result.stdout).toContain("SECRET=");
        expect(result.stdout).toContain(`-p --setting-sources ${CLAUDE_SETTING_SOURCES}`);
        expect(result.stdout).toContain(`--permission-mode ${CLAUDE_PERMISSION_MODE}`);
        expect(result.stdout).toContain(`--allowedTools ${CLAUDE_ALLOWED_TOOLS}`);
        expect(result.stdout).toContain(`--disallowedTools ${claudeDisallowedTools(FORGE_DENY_DOMAIN)}`);
        expect(result.stdout).toContain("--model opus --effort high");
        expect(result.stdout).not.toContain("--bare");
        expect(result.stdout).toContain(`CWD=${workdir}`);
      }
    );
  });

  test("scrubs extraEnv forge tokens", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'TOKEN=%s PEM=%s JAVA=%s\\n' "$GITEA_BOT_TOKEN" "$GITHUB_APP_PRIVATE_KEY" "$JAVA_HOME"
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "opus",
          workdir,
          sanitizeEnv: true,
          extraEnv: {
            JAVA_HOME: "/opt/java/openjdk",
            GITEA_BOT_TOKEN: "should-not-pass",
            GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----",
          },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("JAVA=/opt/java/openjdk");
        expect(result.stdout).toContain("TOKEN=");
        expect(result.stdout).toContain("PEM=");
        expect(result.stdout).not.toContain("BEGIN PRIVATE KEY");
      }
    );
  });

  test("the sanitized env still reaches Phoenix with the project and job id", async () => {
    // The scrub is what this has to survive: a spawn that reaches the model but
    // not Phoenix is an untraced job, which is the bug this exists to fix.
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006/v1/traces";
    process.env.AGENT_INSTANCE = "jumi-worker";
    setClaudeTracingPluginDirForTests(pluginDir);
    await withFakeClaude(
      `#!/bin/sh
printf 'PHX=%s PROJ=%s JOB=%s KIND=%s PROMPTS=%s TOKEN=%s\\n' "$PHOENIX_ENDPOINT" "$ARIZE_PROJECT_NAME" "$JUMI_JOB_ID" "$JUMI_TRACE_KIND" "$ARIZE_LOG_PROMPTS" "$GITEA_BOT_TOKEN"
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "opus",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "implement", owner: "kirmanak", repo: "jumi", jobId: "job-42" },
          extraEnv: { GITEA_BOT_TOKEN: "should-not-pass" },
        });
        expect(result.status).toBe("ok");
        // The OTLP path the OpenCode exporter stores is not the plugin's base URL.
        expect(result.stdout).toContain("PHX=http://phoenix.internal:6006 ");
        expect(result.stdout).toContain("PROJ=jumi-worker");
        expect(result.stdout).toContain("JOB=job-42");
        expect(result.stdout).toContain("KIND=implement");
        expect(result.stdout).toContain("PROMPTS=false");
        expect(result.stdout).toContain("TOKEN=");
        expect(result.stdout).not.toContain("should-not-pass");
      }
    );
  });

  test("classifies auth death from stdout", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'not logged in\\n'
exit 1
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.auth).toBe(true);
        expect(result.infra).toBe(false);
        expect(result.message).toContain(AUTH_DEATH_REASON);
        expect(result.message).toContain("worker");
        expect(result.message).toContain("claude/opus");
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="auth"} 1');
      }
    );
  });

  test("expired OAuth session after the config warning is auth death", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf '%s\\n' 'Claude configuration file not found at: /data/.claude.json' >&2
printf '%s\\n' 'Restoring configuration from backup' >&2
printf '%s\\n' 'Failed to authenticate: OAuth session expired and could not be refreshed' >&2
exit 1
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.auth).toBe(true);
        expect(result.infra).toBe(false);
        expect(result.message).toContain(AUTH_DEATH_REASON);
        expect(result.message).not.toContain("configuration file not found");
        expect(result.message).not.toContain("/data/.claude.json");
        expect(
          looksLikeProviderAuthDeath(
            "Claude configuration file not found at: /data/.claude.json\nRestoring configuration from backup\nFailed to authenticate: OAuth session expired and could not be refreshed"
          )
        ).toBe(true);
        const description = omitClaudeConfigWarning(
          `Jumi review failed: claude exited with code 1:\nClaude configuration file not found at: /data/.claude.json\nRestoring configuration from backup\nFailed to authenticate: OAuth session expired and could not be refreshed`
        );
        expect(description).toContain("Failed to authenticate: OAuth session expired");
        expect(description).not.toContain("configuration file not found");
      }
    );
  });

  test("config warning alone on a successful run is not auth", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf '%s\\n' 'Claude configuration file not found at: /data/.claude.json' >&2
printf '%s\\n' 'Restoring configuration from backup' >&2
printf 'ok\\n'
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true });
        expect(result.status).toBe("ok");
        expect(result.auth).toBeFalsy();
      }
    );
  });

  test("expired OAuth chain hops to the next runner", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf '%s\\n' 'Claude configuration file not found at: /data/.claude.json' >&2
printf '%s\\n' 'Restoring configuration from backup' >&2
printf '%s\\n' 'Failed to authenticate: OAuth session expired and could not be refreshed' >&2
exit 1
`,
      async (workdir) => {
        const seen: string[] = [];
        const engine = async (opts: { model: string; workdir: string }) => {
          seen.push(opts.model);
          if (opts.model === "opus") {
            return runClaude({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true });
          }
          return { status: "ok" as const, stdout: "fallback ok" };
        };
        const result = await withEngineChain(engine as never, {
          chain: [
            { name: "claude", type: "claude", model: "opus" },
            { name: "grok", type: "opencode", model: "grok" },
          ],
        })({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true } as never);
        expect(seen).toEqual(["opus", "grok"]);
        expect(result).toMatchObject({ status: "ok", stdout: "fallback ok" });
      }
    );
  });

  test("records ok runs on the existing exit and duration series", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'ok\\n'
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "opus",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "implement", owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("ok");
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="implement",class="ok"} 1');
        expect(text).toContain('jumi_job_duration_seconds_count{kind="implement",result="ok"} 1');
      }
    );
  });

  test("classifies session limit as resetting quota stuck, not a plain exit", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf '%s\\n' "You've hit your session limit · resets 12:50am (UTC)" >&2
exit 1
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "opus",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "implement", owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("stuck");
        expect(result.quota).toBe("resetting");
        expect(result.auth).toBeFalsy();
        expect(result.infra).toBe(false);
        expect(result.message).toBe(QUOTA_MESSAGE);
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="implement",class="quota"} 1');
        expect(text).toContain('jumi_job_duration_seconds_count{kind="implement",result="quota"} 1');
        expect(text).not.toContain('kind="implement",class="incomplete"} 1');
      }
    );
  });

  test("unknown non-zero stays exit and still records metrics", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'Usage limit reached. It will reset in 1 hour\\n' >&2
exit 1
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.quota).toBeUndefined();
        expect(result.message).toContain("claude exited with code 1");
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="incomplete"} 1');
        expect(text).not.toContain('kind="review",class="quota"} 1');
      }
    );
  });
});

const RESULT_EVENT = JSON.stringify({
  type: "result",
  subtype: "success",
  result: "review written",
  usage: { input_tokens: 2, output_tokens: 5 },
  modelUsage: {
    "claude-sonnet-5": {
      canonicalModel: "claude-sonnet-5",
      inputTokens: 2,
      outputTokens: 50,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 40,
      thinkingTokens: 7,
    },
    "claude-haiku-4-5-20251001": { inputTokens: 906, outputTokens: 12 },
  },
});

function assistantEvent(id: string, model: string, input: number, output: number): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      model,
      content: [{ type: "text", text: "working" }],
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 100 },
    },
  });
}

function tokenLine(model: string, tokenType: string, value: number): string {
  return `ai_tokens_total{agent_instance="jumi",source="claude",profile="default",model="${model}",token_type="${tokenType}"} ${value}`;
}

describe("runClaude token usage", () => {
  test("records every modelUsage model under source=claude and returns the result text", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","model":"claude-sonnet-5"}'
printf '%s\n' '${assistantEvent("msg_1", "claude-sonnet-5", 1, 3)}'
printf '%s\n' '${RESULT_EVENT}'
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "sonnet", workdir, sanitizeEnv: true });
        expect(result.status).toBe("ok");
        expect(result.stdout).toBe("review written");
        const text = renderTokenMetrics();
        expect(text).toContain(tokenLine("claude-sonnet-5", "input", 2));
        expect(text).toContain(tokenLine("claude-sonnet-5", "output", 50));
        expect(text).toContain(tokenLine("claude-sonnet-5", "cached_input", 300));
        expect(text).toContain(tokenLine("claude-sonnet-5", "cache_write", 40));
        expect(text).toContain(tokenLine("claude-sonnet-5", "reasoning", 7));
        expect(text).toContain(tokenLine("claude-haiku-4-5-20251001", "input", 906));
        expect(text).toContain(tokenLine("claude-haiku-4-5-20251001", "output", 12));
        expect(text).toContain(
          'ai_sessions{agent_instance="jumi",source="claude",profile="default",model="claude-sonnet-5"} 1'
        );
      }
    );
  });

  test("records usage on non-zero exit", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf '%s\n' '${RESULT_EVENT}'
exit 1
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "sonnet", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(renderTokenMetrics()).toContain(tokenLine("claude-haiku-4-5-20251001", "input", 906));
      }
    );
  });

  test("falls back to deduplicated assistant usage when killed before result", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf '%s\n' '${assistantEvent("msg_1", "claude-opus-5", 10, 1)}'
printf '%s\n' '${assistantEvent("msg_1", "claude-opus-5", 10, 4)}'
printf '%s\n' '${assistantEvent("msg_2", "claude-opus-5", 5, 6)}'
exec sleep 30
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true, timeoutMs: 500 });
        expect(result.status).toBe("timeout");
        const text = renderTokenMetrics();
        expect(text).toContain(tokenLine("claude-opus-5", "input", 15));
        expect(text).toContain(tokenLine("claude-opus-5", "output", 10));
        expect(text).toContain(tokenLine("claude-opus-5", "cached_input", 200));
      }
    );
  });

  test("missing or unparseable usage is fail-open", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf '%s\n' '{"type":"result","result":"done","modelUsage":"nope"}'
printf '%s\n' '{not json'
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true });
        expect(result.status).toBe("ok");
        expect(result.stdout).toBe("done\n{not json");
        expect(renderTokenMetrics()).not.toContain('source="claude"');
      }
    );
  });
});

describe("runRegisteredEngine", () => {
  test("dispatches type claude to the claude binary", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'dispatched %s\\n' "$*"
`,
      async (workdir) => {
        const result = await runRegisteredEngine({
          type: "claude",
          prompt: "prompt",
          model: "opus",
          workdir,
          sanitizeEnv: true,
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain(`-p --setting-sources ${CLAUDE_SETTING_SOURCES}`);
      }
    );
  });
});
