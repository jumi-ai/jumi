import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SETUP_TIMEOUT_MS,
  loadRepoSettings,
  type RepoSettingsLoad,
  resolveSetupTimeoutMaxMs,
} from "../src/repo_settings.ts";
import {
  type RepoSetupRunScript,
  runRepoSetupForJob,
  runRepoSetupForKind,
  type SetupScriptResult,
} from "../src/repo_setup.ts";
import type { GitAuth, GitRunner } from "../src/workspace.ts";

const AUTH: GitAuth = { giteaUrl: "https://forge.example.test", username: "jumi", token: "" };
const GIT_ENV: Record<string, string | undefined> = { PATH: "/usr/bin" };

async function validLoad(content: string): Promise<RepoSettingsLoad> {
  const api = { getRepoFile: async () => ({ found: true, content }) };
  return loadRepoSettings(api, "owner", "repo", "main");
}

function stubScript(result: SetupScriptResult, seen?: { timeoutMs?: number }): RepoSetupRunScript {
  return async (opts) => {
    if (seen) seen.timeoutMs = opts.timeoutMs;
    return result;
  };
}

const OK_SCRIPT: SetupScriptResult = { status: "ok", exitCode: 0, output: "setup output", durationMs: 7 };

/** Queued `status --porcelain` answers; `reset`/`clean` throw when listed in `failOn`. */
function stubGit(statusAnswers: (string | Error)[], failOn: string[] = []): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  let statusCall = 0;
  const git: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === "status") {
      const next = statusAnswers[statusCall++] ?? "";
      if (next instanceof Error) throw next;
      return next;
    }
    if (failOn.includes(args[0] ?? "")) throw new Error(`git ${args[0]} failed: locked worktree`);
    return "";
  };
  return { git, calls };
}

function commands(calls: string[][]): string[] {
  return calls.map((args) => args[0] ?? "");
}

describe("runRepoSetupForJob clean-tree check", () => {
  test("dirty tree is restored and reported dirty", async () => {
    const load = await validLoad("setup:\n  run: echo hi\n");
    const { git, calls } = stubGit([" M src/a.ts\n", ""]);
    const logs: string[] = [];
    const result = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-test",
      kind: "review",
      load,
      auth: AUTH,
      owner: "owner",
      repo: "repo",
      log: (message) => logs.push(message),
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript(OK_SCRIPT),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.state).toBe("dirty");
    expect(commands(calls)).toEqual(["status", "reset", "clean", "status"]);
    expect(result.failureReason).toBeDefined();
    expect(result.promptBlock).toContain('state="dirty"');
  });

  test("failed restore is failed, not dirty, so continue never starts on a dirty tree", async () => {
    const load = await validLoad("setup:\n  run: echo hi\n");
    const { git, calls } = stubGit([" M src/a.ts\n", " M src/a.ts\n"], ["reset"]);
    const result = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-test",
      kind: "review",
      load,
      auth: AUTH,
      owner: "owner",
      repo: "repo",
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript(OK_SCRIPT),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.state).toBe("failed");
    expect(result.failureReason).toContain("cannot restore worktree");
    expect(commands(calls)).toEqual(["status", "reset", "status"]);
    // A re-check that still shows a dirty tree is the same failure.
    expect(result.promptBlock).toContain('state="failed"');
  });

  test("still-dirty re-check after a clean-looking restore is failed", async () => {
    const load = await validLoad("setup:\n  run: echo hi\n");
    const { git } = stubGit([" M src/a.ts\n", " M src/a.ts\n"]);
    const result = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-test",
      kind: "review",
      load,
      auth: AUTH,
      owner: "owner",
      repo: "repo",
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript(OK_SCRIPT),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.state).toBe("failed");
    expect(result.failureReason).toContain("still dirty");
  });

  test("status error attempts a restore and is ok when the re-check is clean", async () => {
    const load = await validLoad("setup:\n  run: echo hi\n");
    const { git, calls } = stubGit([new Error("cannot lock index"), ""]);
    const result = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-test",
      kind: "review",
      load,
      auth: AUTH,
      owner: "owner",
      repo: "repo",
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript(OK_SCRIPT),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.state).toBe("ok");
    expect(commands(calls)).toEqual(["status", "reset", "clean", "status"]);
  });

  test("status error with a failed re-check is failed", async () => {
    const load = await validLoad("setup:\n  run: echo hi\n");
    const { git } = stubGit([new Error("cannot lock index"), new Error("still locked")]);
    const result = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-test",
      kind: "review",
      load,
      auth: AUTH,
      owner: "owner",
      repo: "repo",
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript(OK_SCRIPT),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.state).toBe("failed");
    expect(result.failureReason).toContain("cannot restore worktree");
  });

  test("git errors in the restore reason are redacted before reaching the forge", async () => {
    const load = await validLoad("setup:\n  run: echo hi\n  on_failure: fail\n");
    const rawToken = `ghp_${"a".repeat(24)}`;
    const { git } = stubGit([" M src/a.ts\n"], ["reset"]);
    // Swap in a token-shaped git error after stubbing: the restore path must scrub it.
    const leakingGit: GitRunner = async (args) => {
      if (args[0] === "reset") throw new Error(`fatal: unable to access 'https://x:${rawToken}@forge/': boom`);
      return git(args, { cwd: "", env: {} });
    };
    const result = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-test",
      kind: "review",
      load,
      auth: AUTH,
      owner: "owner",
      repo: "repo",
      git: leakingGit,
      gitEnv: GIT_ENV,
      runScript: stubScript(OK_SCRIPT),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.state).toBe("failed");
    expect(result.failureReason).not.toContain(rawToken);
    expect(result.failureReason).toContain("cannot restore worktree");
  });
});

describe("runRepoSetupForKind", () => {
  const api = (content: string) => ({
    getRepoFile: async () => ({ found: true, content }),
  });

  test("continue policy returns the prompt block without a failure reason", async () => {
    const { git } = stubGit([""]);
    const setup = await runRepoSetupForKind({
      api: api("setup:\n  run: echo hi\n"),
      kind: "review",
      workdir: "/tmp/repo-setup-test",
      defaultBranch: "main",
      auth: AUTH,
      owner: "o",
      repo: "r",
      timeoutMaxMs: 600_000,
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript({ status: "failed", exitCode: 3, output: "boom", durationMs: 1 }),
    });
    expect(setup.ran).toBe(true);
    expect(setup.promptBlock).toContain('state="failed"');
    expect(setup.failureReason).toBeUndefined();
  });

  test("fail policy returns the failure reason", async () => {
    const { git } = stubGit([""]);
    const setup = await runRepoSetupForKind({
      api: api("setup:\n  run: echo hi\n  on_failure: fail\n"),
      kind: "review",
      workdir: "/tmp/repo-setup-test",
      defaultBranch: "main",
      auth: AUTH,
      owner: "o",
      repo: "r",
      timeoutMaxMs: 600_000,
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript({ status: "failed", exitCode: 3, output: "boom", durationMs: 1 }),
    });
    expect(setup.ran).toBe(true);
    expect(setup.failureReason).toContain("exit code 3");
  });

  test("narrowed-out kind never spawns", async () => {
    let spawned = 0;
    const { git } = stubGit([""]);
    const logs: string[] = [];
    const setup = await runRepoSetupForKind({
      api: api("setup:\n  run: echo hi\n  kinds: [review]\n"),
      kind: "implement",
      workdir: "/tmp/repo-setup-test",
      defaultBranch: "main",
      auth: AUTH,
      owner: "o",
      repo: "r",
      timeoutMaxMs: 600_000,
      log: (message) => logs.push(message),
      git,
      gitEnv: GIT_ENV,
      runScript: async (opts) => {
        spawned++;
        return stubScript(OK_SCRIPT)(opts);
      },
    });
    expect(setup).toEqual({ ran: false });
    expect(spawned).toBe(0);
  });

  test("threaded timeoutMaxMs caps the script timeout", async () => {
    const { git } = stubGit([""]);
    const seen: { timeoutMs?: number } = {};
    await runRepoSetupForKind({
      api: api("setup:\n  run: echo hi\n  timeout: 60\n"),
      kind: "review",
      workdir: "/tmp/repo-setup-test",
      defaultBranch: "main",
      auth: AUTH,
      owner: "o",
      repo: "r",
      timeoutMaxMs: 60_000,
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript(OK_SCRIPT, seen),
    });
    expect(seen.timeoutMs).toBe(60_000);
  });
});

describe("resolveSetupTimeoutMaxMs", () => {
  test("invalid value degrades to the default with a log line instead of throwing", () => {
    const logs: string[] = [];
    expect(resolveSetupTimeoutMaxMs({ SETUP_TIMEOUT_MAX_MS: "banana" }, (message) => logs.push(message))).toBe(
      DEFAULT_SETUP_TIMEOUT_MS
    );
    expect(logs.join("\n")).toContain("SETUP_TIMEOUT_MAX_MS");
    expect(resolveSetupTimeoutMaxMs({}, undefined)).toBe(DEFAULT_SETUP_TIMEOUT_MS);
  });

  test("job without a threaded maximum falls back to the direct-env read", async () => {
    const previous = process.env.SETUP_TIMEOUT_MAX_MS;
    process.env.SETUP_TIMEOUT_MAX_MS = "0";
    try {
      const logs: string[] = [];
      expect(resolveSetupTimeoutMaxMs(process.env, (message) => logs.push(message))).toBe(DEFAULT_SETUP_TIMEOUT_MS);
      expect(logs.length).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.SETUP_TIMEOUT_MAX_MS;
      else process.env.SETUP_TIMEOUT_MAX_MS = previous;
    }
  });
});
