import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_DEATH_REASON, providerAuthDeathForRun } from "../src/auth.ts";
import { auditChildEnv } from "../src/child_env.ts";
import {
  applyClaudeCredentialRule,
  buildClaudeEnv,
  claudeApiKeyConfigError,
  claudeRedactSecrets,
  isClaudeApiKeyRunner,
  runClaude,
} from "../src/claude.ts";
import { RUNNER_AUTH_API_KEY } from "../src/claude_credentials.ts";
import { resetControlMetricsForTests } from "../src/control_metrics.ts";
import { EngineFailedError, type EngineRunOptions } from "../src/engine.ts";
import { withEngineChain } from "../src/fallback.ts";
import { provenanceRunnerKey } from "../src/provenance.ts";
import {
  type NewRunUsageRow,
  resetActiveRunUsageRecordingForTests,
  setActiveRunUsageRecording,
} from "../src/run_usage.ts";
import { formatRunnerStamp, parseRunnersCatalog, runnerNameForStamp, runnerStamp } from "../src/runners.ts";
import { recordClaudeUsage, resetTokenMetricsForTests } from "../src/token_metrics.ts";
import { redactGitSecrets } from "../src/workspace.ts";

const SAVED = { ...process.env };

function setParentEnv(patch: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetControlMetricsForTests();
  resetTokenMetricsForTests();
  resetActiveRunUsageRecordingForTests();
});

describe("catalog auth/authEnv", () => {
  test("an entry that declares nothing behaves exactly as today", () => {
    const catalog = parseRunnersCatalog({
      runners: { claude: { type: "claude", model: "claude-opus-5", effort: "high" } },
      chain: ["claude"],
    });
    expect(catalog.runners.claude).toEqual({ type: "claude", model: "claude-opus-5", effort: "high" });
  });

  test("a claude entry can declare api-key auth with a parent var name", () => {
    const catalog = parseRunnersCatalog({
      runners: {
        claude: { type: "claude", model: "claude-opus-5" },
        "claude-api": { type: "claude", model: "claude-opus-5", auth: "api-key", authEnv: "MY_KEY" },
      },
      chain: ["claude", "claude-api"],
    });
    expect(catalog.runners["claude-api"]).toEqual({
      type: "claude",
      model: "claude-opus-5",
      auth: "api-key",
      authEnv: "MY_KEY",
    });
    expect(catalog.runners.claude).toEqual({ type: "claude", model: "claude-opus-5" });
  });

  test("explicit subscription auth is accepted", () => {
    const catalog = parseRunnersCatalog({
      runners: { claude: { type: "claude", model: "m", auth: "subscription" } },
      chain: ["claude"],
    });
    expect(catalog.runners.claude).toEqual({ type: "claude", model: "m", auth: "subscription" });
  });

  test("unknown auth value fails process start", () => {
    expect(() =>
      parseRunnersCatalog({ runners: { c: { type: "claude", model: "m", auth: "oauth" } }, chain: ["c"] })
    ).toThrow("unknown auth");
  });

  test("wrong auth/authEnv types fail process start", () => {
    expect(() =>
      parseRunnersCatalog({ runners: { c: { type: "claude", model: "m", auth: 7 } }, chain: ["c"] })
    ).toThrow("invalid auth");
    expect(() =>
      parseRunnersCatalog({
        runners: { c: { type: "claude", model: "m", auth: "api-key", authEnv: 7 } },
        chain: ["c"],
      })
    ).toThrow("authEnv");
  });

  test("api-key auth without authEnv, with a bad name, or off claude fails", () => {
    expect(() =>
      parseRunnersCatalog({ runners: { c: { type: "claude", model: "m", auth: "api-key" } }, chain: ["c"] })
    ).toThrow("requires authEnv");
    expect(() =>
      parseRunnersCatalog({
        runners: { c: { type: "claude", model: "m", auth: "api-key", authEnv: "has space" } },
        chain: ["c"],
      })
    ).toThrow("invalid authEnv");
    for (const type of ["opencode", "codex", "agy"]) {
      expect(() =>
        parseRunnersCatalog({
          runners: {
            c: { type, model: "m", ...(type === "codex" ? { effort: "high" } : {}), auth: "api-key", authEnv: "K" },
          },
          chain: ["c"],
        })
      ).toThrow("only supported on type claude");
    }
    expect(() =>
      parseRunnersCatalog({
        runners: { c: { type: "claude", model: "m", auth: "subscription", authEnv: "K" } },
        chain: ["c"],
      })
    ).toThrow("without api-key auth");
    expect(() =>
      parseRunnersCatalog({ runners: { c: { type: "claude", model: "m", authEnv: "K" } }, chain: ["c"] })
    ).toThrow("authEnv without auth");
  });
});

describe("one credential per child", () => {
  const BOTH = {
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    MY_KEY: "api-key-value",
    ANTHROPIC_API_KEY: "direct-api-key",
    ANTHROPIC_AUTH_TOKEN: "auth-token-value",
  };

  function baseOpts(extra?: Partial<EngineRunOptions>): EngineRunOptions {
    return { model: "claude-opus-5", workdir: "/work/demo", home: "/data", sanitizeEnv: true, ...extra };
  }

  test("api-key child gets exactly ANTHROPIC_API_KEY from the named var", () => {
    setParentEnv(BOTH);
    const env = buildClaudeEnv(
      baseOpts({
        type: "claude",
        auth: "api-key",
        authEnv: "MY_KEY",
        runnerName: "claude-api",
        keyEnvNames: ["MY_KEY"],
        extraEnv: {
          JAVA_HOME: "/opt/java/openjdk",
          ANTHROPIC_API_KEY: "job-smuggled",
          ANTHROPIC_AUTH_TOKEN: "job-smuggled-token",
          MY_KEY: "should-not-leak",
        },
      }),
      "/work/demo/.jumi-tmp"
    );
    expect(env.ANTHROPIC_API_KEY).toBe("api-key-value");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.MY_KEY).toBeUndefined();
    expect(env.JAVA_HOME).toBe("/opt/java/openjdk");
  });

  test("subscription child gets no ANTHROPIC_* even when parent and extraEnv hold them", () => {
    setParentEnv(BOTH);
    const env = buildClaudeEnv(
      baseOpts({
        type: "claude",
        runnerName: "claude",
        keyEnvNames: ["MY_KEY"],
        extraEnv: {
          ANTHROPIC_API_KEY: "job-smuggled",
          ANTHROPIC_AUTH_TOKEN: "job-smuggled-token",
          MY_KEY: "should-not-leak",
        },
      }),
      "/work/demo/.jumi-tmp"
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.MY_KEY).toBeUndefined();
  });

  test("unsanitized spawns enforce the same rule on the inherited copy", () => {
    setParentEnv(BOTH);
    const api = buildClaudeEnv(
      baseOpts({
        type: "claude",
        sanitizeEnv: false,
        auth: "api-key",
        authEnv: "MY_KEY",
        runnerName: "claude-api",
        keyEnvNames: ["MY_KEY"],
      }),
      "/work/demo/.jumi-tmp"
    );
    expect(api.ANTHROPIC_API_KEY).toBe("api-key-value");
    expect(api.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(api.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(api.MY_KEY).toBeUndefined();

    const sub = buildClaudeEnv(
      baseOpts({ type: "claude", sanitizeEnv: false, runnerName: "claude", keyEnvNames: ["MY_KEY"] }),
      "/work/demo/.jumi-tmp"
    );
    expect(sub.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sub.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(sub.MY_KEY).toBeUndefined();
  });

  test("missing or empty key fails as auth with runner and var named, never the value", () => {
    setParentEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", MY_KEY: undefined, EMPTY_KEY: "   " });
    for (const authEnv of ["MY_KEY", "EMPTY_KEY"]) {
      let thrown: unknown;
      try {
        buildClaudeEnv(
          baseOpts({
            type: "claude",
            auth: "api-key",
            authEnv,
            runnerName: "claude-api",
            trace: { kind: "implement", owner: "o", repo: "r" },
          }),
          "/work/demo/.jumi-tmp"
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(EngineFailedError);
      const err = thrown as EngineFailedError;
      expect(err.auth).toBe(true);
      expect(err.message).toContain("claude runner claude-api has no usable credentials");
      expect(err.message).toContain(authEnv);
      expect(err.message).toContain(AUTH_DEATH_REASON);
      expect(err.message).not.toContain("api-key-value");
    }
  });

  test("applyClaudeCredentialRule refuses unsanitized api-key runs without a key", () => {
    setParentEnv({ MY_KEY: undefined });
    expect(() =>
      applyClaudeCredentialRule(
        { ...process.env } as Record<string, string>,
        { auth: "api-key", authEnv: "MY_KEY", model: "m", runnerName: "claude-api" },
        true,
        new Set(["MY_KEY"])
      )
    ).toThrow("has no usable credentials");
  });
});

describe("child env audit", () => {
  test("api-key child env audits clean only when expected", () => {
    const env = { HOME: "/data", ANTHROPIC_API_KEY: "api-key-value" };
    expect(auditChildEnv(env, { allowAnthropicApiKey: true }).unlistedCredentials).toEqual([]);
    expect(auditChildEnv(env, { allowAnthropicApiKey: true }).provider).toContain("ANTHROPIC_API_KEY");
    // Anywhere else it is an unexpected credential.
    expect(auditChildEnv(env).unlistedCredentials).toContain("ANTHROPIC_API_KEY");
    expect(
      auditChildEnv({ HOME: "/data", ANTHROPIC_AUTH_TOKEN: "t" }, { allowAnthropicApiKey: true }).unlistedCredentials
    ).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(auditChildEnv({ HOME: "/data", MY_KEY: "v" }).unlistedCredentials).toContain("MY_KEY");
  });
});

describe("credential-aware identity", () => {
  test("stamp carries auth but the public line stays type and model", () => {
    const stamp = runnerStamp({ type: "claude", model: "claude-opus-5", effort: "high", auth: "api-key" });
    expect(stamp).toEqual({ type: "claude", model: "claude-opus-5", effort: "high", auth: "api-key" });
    expect(formatRunnerStamp(stamp)).toBe("_Jumi · claude · claude-opus-5 (high)_");
    expect(runnerStamp({ type: "claude", model: "m" })).toEqual({ type: "claude", model: "m" });
  });

  test("provenance and retry matching distinguish the two entries", () => {
    const sub = { type: "claude", model: "m", effort: "high" };
    const api = { type: "claude", model: "m", effort: "high", auth: "api-key" };
    expect(provenanceRunnerKey(runnerStamp(sub))).not.toBe(provenanceRunnerKey(runnerStamp(api)));
    const chain = [
      { name: "claude", ...sub },
      { name: "claude-api", ...api },
    ] as const;
    expect(runnerNameForStamp(chain as never, { type: "claude", model: "m", effort: "high", auth: "api-key" })).toBe(
      "claude-api"
    );
    expect(runnerNameForStamp(chain as never, { type: "claude", model: "m", effort: "high" })).toBe("claude");
    expect(isClaudeApiKeyRunner({ auth: RUNNER_AUTH_API_KEY })).toBe(true);
    expect(isClaudeApiKeyRunner({})).toBe(false);
  });

  test("stamp resolution prefers credential in reversed chain order", () => {
    const sub = { type: "claude", model: "m", effort: "high" };
    const api = { type: "claude", model: "m", effort: "high", auth: "api-key" };
    const reversed = [
      { name: "claude-api", ...api },
      { name: "claude", ...sub },
    ] as const;
    expect(runnerNameForStamp(reversed as never, { type: "claude", model: "m", effort: "high" })).toBe("claude");
    expect(runnerNameForStamp(reversed as never, { type: "claude", model: "m", effort: "high", auth: "api-key" })).toBe(
      "claude-api"
    );
    expect(
      runnerNameForStamp(reversed as never, { type: "claude", model: "m", effort: "high", auth: "subscription" })
    ).toBe("claude");
  });
});

describe("redaction", () => {
  test("key value is redacted, names never appear as values", () => {
    setParentEnv({ MY_KEY: "api-key-value", ANTHROPIC_API_KEY: "direct-api-key" });
    const secrets = claudeRedactSecrets("api-key-value");
    expect(secrets).toContain("api-key-value");
    expect(secrets).toContain("direct-api-key");
    expect(redactGitSecrets("leaked api-key-value and direct-api-key here", secrets)).toBe("leaked *** and *** here");
  });

  test("config error names runner and var without the value", () => {
    const message = claudeApiKeyConfigError({ model: "m", runnerName: "claude-api", authEnv: "MY_KEY" });
    expect(message).toContain("claude-api");
    expect(message).toContain("MY_KEY");
    expect(message).toContain(AUTH_DEATH_REASON);
  });
});

async function withFakeClaude(script: string, run: (workdir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fake-claude-apikey-"));
  const workdir = await realpath(await mkdtemp(join(tmpdir(), "fake-claude-apikey-work-")));
  const originalPath = process.env.PATH;
  try {
    const bin = join(dir, "claude");
    await writeFile(bin, script);
    await chmod(bin, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    await run(workdir);
  } finally {
    process.env.PATH = originalPath ?? "";
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("runClaude with api-key runners", () => {
  test("child receives ANTHROPIC_API_KEY and not the subscription token", async () => {
    setParentEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", MY_KEY: "api-key-value" });
    await withFakeClaude(
      `#!/bin/sh
printf 'API=%s OAUTH=%s VAR=%s\\n' "$ANTHROPIC_API_KEY" "$CLAUDE_CODE_OAUTH_TOKEN" "$MY_KEY"
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "claude-opus-5",
          workdir,
          home: "/data",
          sanitizeEnv: true,
          type: "claude",
          auth: "api-key",
          authEnv: "MY_KEY",
          runnerName: "claude-api",
          keyEnvNames: ["MY_KEY"],
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("API=***");
        expect(result.stdout).toContain("OAUTH=");
        expect(result.stdout).toContain("VAR=");
        expect(result.stdout).not.toContain("api-key-value");
      }
    );
  });

  test("missing key fails as provider auth death so the job hops", async () => {
    setParentEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", MY_KEY: undefined });
    const logs: string[] = [];
    await withFakeClaude(`#!/bin/sh\nprintf 'must not run\\n'`, async (workdir) => {
      const error = await runClaude({
        prompt: "prompt",
        model: "claude-opus-5",
        workdir,
        sanitizeEnv: true,
        type: "claude",
        auth: "api-key",
        authEnv: "MY_KEY",
        runnerName: "claude-api",
        logger: (message) => logs.push(message),
      }).then(
        () => null,
        (err: unknown) => err
      );
      expect(error).toBeInstanceOf(EngineFailedError);
      expect((error as EngineFailedError).auth).toBe(true);
      expect(logs.join("\n")).toContain("claude-api");
      expect(logs.join("\n")).toContain("MY_KEY");
      expect(logs.join("\n")).not.toContain("api-key-value");
    });
  });

  test("an Anthropic 401 invalid-key rejection is provider auth death", async () => {
    setParentEnv({ MY_KEY: "api-key-value" });
    const seen: string[] = [];
    await withFakeClaude(
      `#!/bin/sh
printf '%s\\n' 'API Error: 401 Invalid authentication credentials' >&2
exit 1
`,
      async (workdir) => {
        const engine = async (opts: { model: string; workdir: string }) => {
          seen.push(opts.model);
          if (opts.model === "opus") {
            return runClaude({
              prompt: "prompt",
              model: "opus",
              workdir,
              sanitizeEnv: true,
              type: "claude",
              auth: "api-key",
              authEnv: "MY_KEY",
              runnerName: "claude-api",
            });
          }
          return { status: "ok" as const, stdout: "fallback ok" };
        };
        const result = await withEngineChain(engine as never, {
          chain: [
            { name: "claude-api", type: "claude", model: "opus", auth: "api-key", authEnv: "MY_KEY" },
            { name: "grok", type: "opencode", model: "grok" },
          ],
        })({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true } as never);
        expect(seen).toEqual(["opus", "grok"]);
        expect(result).toMatchObject({ status: "ok", stdout: "fallback ok" });
        expect(providerAuthDeathForRun({ type: "claude", model: "opus" })).toContain(AUTH_DEATH_REASON);
      }
    );
  });
});

describe("chain carries credential and entry name", () => {
  test("usage rows name the catalog entry so billing splits", async () => {
    const recorded: NewRunUsageRow[] = [];
    setActiveRunUsageRecording({
      context: { jobId: 1, jobKey: "k", kind: "review" },
      recordRunUsageRows: async (rows) => {
        recorded.push(...rows);
      },
    });
    const seen: EngineRunOptions[] = [];
    const stub = async (opts: EngineRunOptions) => {
      seen.push(opts);
      recordClaudeUsage(
        new Map([["claude-opus-5", { input: 1, cached_input: 0, output: 2, cache_write: 0, reasoning: 0 }]])
      );
      return { status: "ok" as const, exitCode: 0, durationMs: 1_000 };
    };
    const engine = withEngineChain(stub, {
      chain: [
        { name: "claude", type: "claude", model: "claude-opus-5", effort: "high" },
        {
          name: "claude-api",
          type: "claude",
          model: "claude-opus-5",
          effort: "high",
          auth: "api-key",
          authEnv: "MY_KEY",
        },
      ],
    });
    const result = await engine({ model: "claude-opus-5", workdir: "/work/x" });
    expect(result.status).toBe("ok");
    // First entry runs; usage row names the entry, not just the harness.
    expect(seen[0]?.runnerName).toBe("claude");
    expect(seen[0]?.auth).toBeUndefined();
    expect(recorded.map((row) => row.runner)).toEqual(["claude"]);
    expect(recorded[0]).toMatchObject({ model: "claude-opus-5", tokensInput: 1 });
    expect(result.runner).toEqual({ type: "claude", model: "claude-opus-5", effort: "high" });
  });

  test("second entry carries api-key credential through the chain", async () => {
    const seen: EngineRunOptions[] = [];
    const stub = async (opts: EngineRunOptions) => {
      seen.push(opts);
      if (seen.length === 1)
        throw new EngineFailedError("worker claude/claude-opus-5: provider auth death", false, { auth: true });
      return { status: "ok" as const, exitCode: 0 };
    };
    const engine = withEngineChain(stub, {
      chain: [
        { name: "claude", type: "claude", model: "claude-opus-5", effort: "high" },
        {
          name: "claude-api",
          type: "claude",
          model: "claude-opus-5",
          effort: "high",
          auth: "api-key",
          authEnv: "MY_KEY",
        },
      ],
    });
    const result = await engine({ model: "claude-opus-5", workdir: "/work/x" });
    expect(result.status).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ runnerName: "claude-api", auth: "api-key", authEnv: "MY_KEY" });
    expect(result.runner).toEqual({ type: "claude", model: "claude-opus-5", effort: "high", auth: "api-key" });
  });
});
