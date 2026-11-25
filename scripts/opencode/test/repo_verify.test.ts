import { describe, expect, test } from "bun:test";
import { loadRepoSettings } from "../src/repo_settings.ts";
import {
  buildRepoVerifyEnv,
  DEFAULT_VERIFY_ATTEMPTS,
  effectiveVerifyAttempts,
  effectiveVerifyTimeoutMs,
  formatVerifyNote,
  isVerifyEnabled,
  parseVerifyValue,
  type RepoVerifyRunScript,
  resolveVerifyAttemptsMax,
  resolveVerifyTimeoutMaxMs,
  runRepoVerifyOnce,
  runVerifyToPush,
  verifyForKind,
  verifyResumePrompt,
  verifyTaskNote,
} from "../src/repo_verify.ts";

async function validLoad(content: string) {
  const api = { getRepoFile: async () => ({ found: true, content }) };
  return loadRepoSettings(api, "owner", "repo", "main");
}

function okScript(output = "ok"): RepoVerifyRunScript {
  return async () => ({ status: "ok", exitCode: 0, output, durationMs: 1 });
}

describe("verify settings", () => {
  test("absent verify means today's behaviour", async () => {
    const load = await validLoad("automerge: true\n");
    expect(load.state).toBe("valid");
    if (load.state !== "valid") return;
    expect(verifyForKind(load, "implement")).toBeUndefined();
    expect(verifyForKind(load, "follow-up")).toBeUndefined();
  });

  test("reviews never run verify", async () => {
    const load = await validLoad("verify:\n  run: bun run lint\n");
    expect(load.state).toBe("valid");
    if (load.state !== "valid") return;
    expect(verifyForKind(load, "implement")?.run).toBe("bun run lint");
    expect(verifyForKind(load, "follow-up")?.run).toBe("bun run lint");
    expect(verifyForKind(load, "review")).toBeUndefined();
    expect(verifyForKind(load, "conflict")).toBeUndefined();
  });

  test("kinds narrows; unknown kinds invalidate", async () => {
    const load = await validLoad("verify:\n  run: make check\n  kinds: [implement]\n");
    expect(load.state).toBe("valid");
    if (load.state !== "valid") return;
    expect(verifyForKind(load, "implement")?.run).toBe("make check");
    expect(verifyForKind(load, "follow-up")).toBeUndefined();
    expect(parseVerifyValue({ run: "x", kinds: ["review"] })).toEqual({
      ok: false,
      error: `"verify.kinds" must be one of "implement", "followup"`,
    });
    expect(parseVerifyValue({ run: "x", kinds: [] })).toEqual({
      ok: false,
      error: `"verify.kinds" must not contain blank entries`,
    });
    expect(parseVerifyValue({})).toEqual({ ok: false, error: `"verify.run" must be a non-blank string` });
    expect(parseVerifyValue({ run: "x", timeout: 0 })).toEqual({
      ok: false,
      error: `"verify.timeout" must be an integer number of minutes >= 1`,
    });
    expect(parseVerifyValue({ run: "x", attempts: -1 })).toEqual({
      ok: false,
      error: `"verify.attempts" must be a non-negative integer`,
    });
    expect(parseVerifyValue({ run: "x", bogus: 1 })).toEqual({
      ok: false,
      error: `unknown key "verify.bogus"`,
    });
  });

  test("effective timeout and attempts apply deployment ceilings", () => {
    expect(effectiveVerifyTimeoutMs({ run: "x", kinds: ["implement"] }, 600_000)).toBe(600_000);
    expect(effectiveVerifyTimeoutMs({ run: "x", kinds: ["implement"], timeout: 60 }, 300_000)).toBe(300_000);
    expect(effectiveVerifyAttempts({ run: "x", kinds: ["implement"] }, 2)).toBe(DEFAULT_VERIFY_ATTEMPTS);
    expect(effectiveVerifyAttempts({ run: "x", kinds: ["implement"], attempts: 5 }, 2)).toBe(2);
    expect(effectiveVerifyAttempts({ run: "x", kinds: ["implement"], attempts: 0 }, 2)).toBe(0);
  });

  test("deployment kill switch and ceilings", () => {
    expect(isVerifyEnabled({})).toBe(true);
    expect(isVerifyEnabled({ JUMI_VERIFY_ENABLED: "off" })).toBe(false);
    expect(() => isVerifyEnabled({ JUMI_VERIFY_ENABLED: "maybe" })).toThrow("JUMI_VERIFY_ENABLED");
    expect(resolveVerifyTimeoutMaxMs({})).toBe(600_000);
    expect(resolveVerifyTimeoutMaxMs({ JUMI_VERIFY_TIMEOUT_MAX_MS: "banana" })).toBe(600_000);
    expect(resolveVerifyAttemptsMax({})).toBe(2);
    expect(resolveVerifyAttemptsMax({ JUMI_VERIFY_ATTEMPTS_MAX: "0" })).toBe(0);
    expect(resolveVerifyAttemptsMax({ JUMI_VERIFY_ATTEMPTS_MAX: "-1" })).toBe(2);
  });
});

describe("verify runner", () => {
  test("passed and job pushes without resuming", async () => {
    let calls = 0;
    const result = await runVerifyToPush({
      workdir: "/tmp/verify-pass",
      verify: { run: "bun run lint", kinds: ["implement"] },
      timeoutMs: 60_000,
      attempts: 2,
      runScript: async () => {
        calls++;
        return { status: "ok", exitCode: 0, output: "ok", durationMs: 1 };
      },
      resume: async () => {
        throw new Error("must not resume on pass");
      },
      recommit: async () => {
        throw new Error("must not recommit on pass");
      },
    });
    expect(result.status).toBe("passed");
    expect(calls).toBe(1);
    expect(result.note).toContain("Verify: passed");
    expect(result.note).toContain("bun run lint");
    expect(result.quotaSkip).toBeUndefined();
  });

  test("failed run resumes the same session and pushes fixed", async () => {
    let runs = 0;
    const resumes: string[] = [];
    let recommits = 0;
    const result = await runVerifyToPush({
      workdir: "/tmp/verify-fix",
      verify: { run: "bun run lint", kinds: ["implement"] },
      timeoutMs: 60_000,
      attempts: 2,
      runScript: async () => {
        runs++;
        if (runs === 1) return { status: "failed", exitCode: 1, output: "error: bad", durationMs: 1 };
        return { status: "ok", exitCode: 0, output: "ok", durationMs: 1 };
      },
      resume: async (prompt) => {
        resumes.push(prompt);
        expect(prompt).toContain("bun run lint");
        expect(prompt).toContain("error: bad");
        expect(prompt).toMatch(/without weakening/);
        return undefined;
      },
      recommit: async () => {
        recommits++;
      },
    });
    expect(result.status).toBe("passed");
    expect(runs).toBe(2);
    expect(resumes).toHaveLength(1);
    expect(recommits).toBe(1);
  });

  test("failed on every attempt pushes with the failure noted", async () => {
    let runs = 0;
    const result = await runVerifyToPush({
      workdir: "/tmp/verify-fail",
      verify: { run: "make check", kinds: ["followup"] },
      timeoutMs: 60_000,
      attempts: 1,
      runScript: async () => {
        runs++;
        return { status: "failed", exitCode: 2, output: "still bad", durationMs: 1 };
      },
      resume: async () => undefined,
      recommit: async () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(runs).toBe(2);
    expect(result.note).toContain("Verify: failed after 2 attempts");
  });

  test("timeout pushes without resuming", async () => {
    let runs = 0;
    let resumes = 0;
    const result = await runVerifyToPush({
      workdir: "/tmp/verify-timeout",
      verify: { run: "make check", kinds: ["implement"] },
      timeoutMs: 1,
      attempts: 2,
      runScript: async () => {
        runs++;
        return { status: "timeout", exitCode: null, output: "hung", durationMs: 1 };
      },
      resume: async () => {
        resumes++;
        return undefined;
      },
      recommit: async () => undefined,
    });
    expect(result.status).toBe("timeout");
    expect(runs).toBe(1);
    expect(resumes).toBe(0);
    expect(result.note).toContain("not run (timeout");
  });

  test("infrastructure error never resumes", async () => {
    for (const output of [
      { status: "failed" as const, exitCode: 127, output: "sh: command not found", durationMs: 1 },
      { status: "failed" as const, exitCode: 1, output: "foo: command not found", durationMs: 1 },
    ]) {
      const result = await runRepoVerifyOnce({
        workdir: "/tmp/verify-infra",
        verify: { run: "missing-tool", kinds: ["implement"] },
        timeoutMs: 60_000,
        attempts: 2,
        runScript: async () => output,
      });
      expect(result.status).toBe("infra");
      expect(result.note).toContain("not run (infrastructure error");
    }
    const pushed = await runVerifyToPush({
      workdir: "/tmp/verify-infra-push",
      verify: { run: "missing-tool", kinds: ["implement"] },
      timeoutMs: 60_000,
      attempts: 2,
      runScript: async () => ({ status: "failed", exitCode: 127, output: "not found", durationMs: 1 }),
      resume: async () => {
        throw new Error("must not resume on infra");
      },
      recommit: async () => undefined,
    });
    expect(pushed.status).toBe("infra");
  });

  test("verify env has no forge or provider credentials", async () => {
    const seen: Array<Record<string, string>> = [];
    const script: RepoVerifyRunScript = async (opts) => {
      seen.push(opts.env);
      return { status: "ok", exitCode: 0, output: "ok", durationMs: 1 };
    };
    const previous = {
      GITEA_BOT_TOKEN: process.env.GITEA_BOT_TOKEN,
      OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.GITEA_BOT_TOKEN = "forge-secret";
    process.env.OPENCODE_API_KEY = "provider-secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-secret";
    try {
      await runRepoVerifyOnce({
        workdir: "/tmp/verify-env",
        verify: { run: "env", kinds: ["implement"] },
        timeoutMs: 60_000,
        attempts: 2,
        runScript: script,
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(seen).toHaveLength(1);
    const env = seen[0]!;
    const keys = Object.keys(env);
    expect(keys.some((key) => /TOKEN|KEY|SECRET|AUTH/.test(key) && !key.startsWith("GIT_"))).toBe(false);
    const dumped = Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    expect(dumped).not.toContain("forge-secret");
    expect(dumped).not.toContain("provider-secret");
    expect(dumped).not.toContain("anthropic-secret");
    // The builder itself carries no secret values even without stubbing.
    const built = buildRepoVerifyEnv("/tmp/verify-env-direct");
    expect(Object.entries(built).some(([key]) => /TOKEN|KEY|SECRET/.test(key) && !key.startsWith("GIT_"))).toBe(false);
  });

  test("prompt names the command and resume carries the tail", () => {
    const note = verifyTaskNote({ run: "bun run lint", kinds: ["implement"] });
    expect(note).toContain("bun run lint");
    const prompt = verifyResumePrompt("bun run lint", "error tail", 1);
    expect(prompt).toContain("bun run lint");
    expect(prompt).toContain("error tail");
    expect(formatVerifyNote("passed", "bun run lint", 0)).toBe("Verify: passed (`bun run lint`)");
    expect(formatVerifyNote("failed", "bun run lint", 2)).toContain("failed after 2 attempts");
  });
});
