import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childScratchDir } from "../src/engine_scratch.ts";
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
import {
  ALLOW_UNSANDBOXED_REVIEWS_ENV,
  checkReviewSandbox,
  setReviewSandboxProbeForTests,
} from "../src/review_sandbox.ts";
import type { GitAuth, GitRunner } from "../src/workspace.ts";
import { withTempDirs, withWorkspace } from "./harness/temp.ts";

const AUTH: GitAuth = { giteaUrl: "https://forge.example.test", username: "jumi", token: "" };
const GIT_ENV: Record<string, string | undefined> = { PATH: "/usr/bin" };

const originalAllowSetup = process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV];

afterEach(() => {
  setReviewSandboxProbeForTests(undefined);
  if (originalAllowSetup === undefined) delete process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV];
  else process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV] = originalAllowSetup;
});

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

  test("failed setup that dirties the tree is restored and reported dirty", async () => {
    const load = await validLoad("setup:\n  run: echo hi\n");
    const { git, calls } = stubGit([" M src/a.ts\n", ""]);
    const result = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-test",
      kind: "review",
      load,
      auth: AUTH,
      owner: "owner",
      repo: "repo",
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript({ status: "failed", exitCode: 1, output: "boom", durationMs: 3 }),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.state).toBe("dirty");
    expect(commands(calls)).toEqual(["status", "reset", "clean", "status"]);
    expect(result.promptBlock).toContain('state="dirty"');
  });

  test("timed-out setup that dirties the tree is restored and reported dirty", async () => {
    const load = await validLoad("setup:\n  run: echo hi\n");
    const { git, calls } = stubGit([" M src/a.ts\n", ""]);
    const result = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-test",
      kind: "review",
      load,
      auth: AUTH,
      owner: "owner",
      repo: "repo",
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript({ status: "timeout", exitCode: null, output: "hung", durationMs: 5 }),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.state).toBe("dirty");
    expect(commands(calls)).toEqual(["status", "reset", "clean", "status"]);
  });

  test("failed setup with a failed restore is failed, not dirty", async () => {
    const load = await validLoad("setup:\n  run: echo hi\n");
    const { git } = stubGit([" M src/a.ts\n", " M src/a.ts\n"], ["reset"]);
    const result = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-test",
      kind: "review",
      load,
      auth: AUTH,
      owner: "owner",
      repo: "repo",
      git,
      gitEnv: GIT_ENV,
      runScript: stubScript({ status: "failed", exitCode: 1, output: "boom", durationMs: 3 }),
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

describe("review setup sandbox wrapping (unit)", () => {
  test("review invocation uses the wrapper argv and scratch env; a worker kind is identical to before", async () => {
    setReviewSandboxProbeForTests({ available: true, abi: 7 });
    await withWorkspace(async (workdir) => {
      const load = await validLoad("setup:\n  run: echo hi\n");
      const seen: { run?: string; env?: Record<string, string> }[] = [];
      const capture: RepoSetupRunScript = async (opts) => {
        seen.push({ run: opts.run, env: opts.env });
        return OK_SCRIPT;
      };
      const { git } = stubGit([""]);
      const fakeHome = await mkdtemp(join(tmpdir(), "setup-agent-home-"));
      try {
        const review = await runRepoSetupForJob({
          workdir,
          kind: "review",
          load,
          auth: AUTH,
          owner: "o",
          repo: "r",
          home: fakeHome,
          git,
          gitEnv: GIT_ENV,
          runScript: capture,
        });
        expect(review.ran).toBe(true);
        expect(seen).toHaveLength(1);
        const invoked = seen[0];
        expect(invoked?.run).toContain("review_sandbox.py");
        expect(invoked?.run).toContain("env -u OPENCODE_API_KEY");
        expect(invoked?.run).toContain("echo hi");
        const scratch = childScratchDir(workdir);
        expect(invoked?.env?.HOME).toBe(join(scratch, "sandbox-home"));
        expect(invoked?.env?.HOME).not.toBe(fakeHome);
        expect(invoked?.env?.TMPDIR).toBe(scratch);
        expect(invoked?.env?.XDG_CONFIG_HOME).toBe(join(scratch, "sandbox-home", ".config"));
        expect(invoked?.env?.GIT_AUTH_HOST).toBe("forge.example.test");
        expect(invoked?.env?.PATH).toContain("/usr");

        const seenWorker: { run?: string; env?: Record<string, string> }[] = [];
        const { git: wgit } = stubGit([""]);
        const worker = await runRepoSetupForJob({
          workdir,
          kind: "implement",
          load,
          auth: AUTH,
          owner: "o",
          repo: "r",
          home: fakeHome,
          git: wgit,
          gitEnv: GIT_ENV,
          runScript: async (opts) => {
            seenWorker.push({ run: opts.run, env: opts.env });
            return OK_SCRIPT;
          },
        });
        expect(worker.ran).toBe(true);
        expect(seenWorker).toHaveLength(1);
        expect(seenWorker[0]?.run).toBe("echo hi");
        expect(seenWorker[0]?.run).not.toContain("review_sandbox.py");
        expect(seenWorker[0]?.env?.HOME).toBe(fakeHome);
        expect(seenWorker[0]?.env?.XDG_CONFIG_HOME).toBeUndefined();
      } finally {
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

  test("sandbox-unavailable fails closed without a spawn; the escape switch runs unwrapped and logs", async () => {
    setReviewSandboxProbeForTests({ available: false, reason: "unit-test no Landlock" });
    const load = await validLoad("setup:\n  run: echo hi\n");
    let spawned = 0;
    const { git } = stubGit([""]);
    const logs: string[] = [];
    const refused = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-sandbox-unavailable",
      kind: "review",
      load,
      auth: AUTH,
      owner: "o",
      repo: "r",
      log: (message) => logs.push(message),
      git,
      gitEnv: GIT_ENV,
      runScript: async () => {
        spawned++;
        return OK_SCRIPT;
      },
    });
    expect(refused.ran).toBe(true);
    if (!refused.ran) return;
    expect(refused.state).toBe("failed");
    expect(refused.failureReason).toContain("Landlock sandbox unavailable");
    expect(refused.failureReason).toContain(ALLOW_UNSANDBOXED_REVIEWS_ENV);
    expect(spawned).toBe(0);

    process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV] = "1";
    const bypassLogs: string[] = [];
    const { git: bgit } = stubGit([""]);
    const bypassed = await runRepoSetupForJob({
      workdir: "/tmp/repo-setup-sandbox-bypass",
      kind: "review",
      load,
      auth: AUTH,
      owner: "o",
      repo: "r",
      log: (message) => bypassLogs.push(message),
      git: bgit,
      gitEnv: GIT_ENV,
      runScript: async (opts) => {
        spawned++;
        expect(opts.run).toBe("echo hi");
        return OK_SCRIPT;
      },
    });
    expect(bypassed.ran).toBe(true);
    if (!bypassed.ran) return;
    expect(bypassed.state).toBe("ok");
    expect(spawned).toBe(1);
    expect(bypassLogs.some((line) => line.includes("UNSANDBOXED"))).toBe(true);
  });

  test("sandbox-unavailable follows onFailure: continue hides the reason, fail surfaces it", async () => {
    setReviewSandboxProbeForTests({ available: false, reason: "unit-test no Landlock" });
    const api = (content: string) => ({ getRepoFile: async () => ({ found: true, content }) });
    const { git: cgit } = stubGit([""]);
    const continued = await runRepoSetupForKind({
      api: api("setup:\n  run: echo hi\n"),
      kind: "review",
      workdir: "/tmp/repo-setup-sandbox-continue",
      defaultBranch: "main",
      auth: AUTH,
      owner: "o",
      repo: "r",
      timeoutMaxMs: 600_000,
      git: cgit,
      gitEnv: GIT_ENV,
    });
    expect(continued.ran).toBe(true);
    expect(continued.promptBlock).toContain('state="failed"');
    expect(continued.failureReason).toBeUndefined();

    const { git: fgit } = stubGit([""]);
    const failed = await runRepoSetupForKind({
      api: api("setup:\n  run: echo hi\n  on_failure: fail\n"),
      kind: "review",
      workdir: "/tmp/repo-setup-sandbox-fail",
      defaultBranch: "main",
      auth: AUTH,
      owner: "o",
      repo: "r",
      timeoutMaxMs: 600_000,
      git: fgit,
      gitEnv: GIT_ENV,
    });
    expect(failed.ran).toBe(true);
    expect(failed.failureReason).toContain("Landlock sandbox unavailable");
  });
});

function realGitRunner(): GitRunner {
  return (async (args, opts: { cwd: string; env: Record<string, string | undefined> }) => {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: opts.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(String(proc.stderr ?? `git ${args[0]} failed`));
    return String(proc.stdout ?? "");
  }) as GitRunner;
}

async function initCleanRepo(dir: string): Promise<void> {
  const git = realGitRunner();
  const env = { PATH: process.env.PATH };
  Bun.spawnSync(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync(["git", "-C", dir, "config", "user.email", "test@test"], { stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync(["git", "-C", dir, "config", "user.name", "test"], { stdout: "ignore", stderr: "ignore" });
  await git(["add", "-A"], { cwd: dir, env });
  await git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-qm", "init"], {
    cwd: dir,
    env,
  }).catch(() => undefined);
}

describe("review setup sandbox red-team (real wrapper)", () => {
  test("canary under a fake agent HOME is unreadable; an outside write is denied; benign setup succeeds", async () => {
    const live = checkReviewSandbox();
    if (!live.available) {
      expect(live.reason ?? "").toMatch(/Landlock|executable/);
      return;
    }
    await withWorkspace(async (checkout) => {
      await initCleanRepo(checkout);
      const git = realGitRunner();
      const gitEnv = { PATH: process.env.PATH };
      await withTempDirs(["setup-fake-home-", "setup-outside-"], async (fakeHome, outside) => {
        const canary = join(fakeHome, "secret");
        await writeFile(canary, "parent-secret-value", { mode: 0o600 });
        const outsideFile = join(outside, "evil");

        const readLoad = await validLoad(`setup:\n  run: cat ${canary}\n`);
        const read = await runRepoSetupForJob({
          workdir: checkout,
          kind: "review",
          load: readLoad,
          auth: AUTH,
          owner: "o",
          repo: "r",
          home: fakeHome,
          git,
          gitEnv,
        });
        expect(read.ran).toBe(true);
        if (!read.ran) return;
        expect(read.state).toBe("failed");
        expect(read.tail).toMatch(/Permission denied/);
        expect(read.tail).not.toContain("parent-secret-value");

        const writeLoad = await validLoad(`setup:\n  run: echo evil > ${outsideFile}\n`);
        const wrote = await runRepoSetupForJob({
          workdir: checkout,
          kind: "review",
          load: writeLoad,
          auth: AUTH,
          owner: "o",
          repo: "r",
          home: fakeHome,
          git,
          gitEnv,
        });
        expect(wrote.ran).toBe(true);
        if (!wrote.ran) return;
        expect(wrote.state).toBe("failed");
        expect(existsSync(outsideFile)).toBe(false);

        const benignLoad = await validLoad(
          'setup:\n  run: |\n    echo hello > ./benign-tmp.txt\n    cat ./benign-tmp.txt\n    rm ./benign-tmp.txt\n    mkdir -p "$HOME/.cache"\n    echo data > "$HOME/.cache/x"\n    echo done\n'
        );
        const benign = await runRepoSetupForJob({
          workdir: checkout,
          kind: "review",
          load: benignLoad,
          auth: AUTH,
          owner: "o",
          repo: "r",
          home: fakeHome,
          git,
          gitEnv,
        });
        expect(benign.ran).toBe(true);
        if (!benign.ran) return;
        expect(benign.state).toBe("ok");
        const scratch = childScratchDir(checkout);
        expect(existsSync(join(scratch, "sandbox-home", ".cache", "x"))).toBe(true);
        expect(existsSync(join(checkout, "benign-tmp.txt"))).toBe(false);
        expect(existsSync(join(fakeHome, ".cache", "x"))).toBe(false);
      });
    });
  });

  test("adversarial fixture: committed script plus lifecycle hook both fail; outcome follows onFailure", async () => {
    const live = checkReviewSandbox();
    if (!live.available) {
      expect(live.reason ?? "").toMatch(/Landlock|executable/);
      return;
    }
    await withWorkspace(async (checkout) => {
      await withTempDirs(["setup-fake-home-", "setup-outside-"], async (fakeHome, outside) => {
        const canary = join(fakeHome, "secret");
        await writeFile(canary, "parent-secret-value", { mode: 0o600 });
        const outsideFile = join(outside, "evil");
        const evilSh = `cat ${canary}\necho evil > ${outsideFile}\n`;
        await writeFile(join(checkout, "evil.sh"), evilSh, { mode: 0o755 });
        await writeFile(
          join(checkout, "package.json"),
          `${JSON.stringify({ name: "evil-fixture", version: "0.0.0", scripts: { preinstall: `cat ${canary}` } }, null, 2)}\n`
        );
        await initCleanRepo(checkout);
        const git = realGitRunner();
        const gitEnv = { PATH: process.env.PATH };
        const run = `set +e\nsh ./evil.sh\nrc1=$?\nnpm install --package-lock=false --ignore-scripts=false --no-audit --no-fund\nrc2=$?\necho "script=$rc1 npm=$rc2"\nexit 1`;
        const api = (onFailure: string) => ({
          getRepoFile: async () => ({
            found: true,
            content: `setup:\n  run: |\n    ${run.split("\n").join("\n    ")}\n  on_failure: ${onFailure}\n`,
          }),
        });
        const continued = await runRepoSetupForKind({
          api: api("continue"),
          kind: "review",
          workdir: checkout,
          defaultBranch: "main",
          auth: AUTH,
          owner: "o",
          repo: "r",
          home: fakeHome,
          timeoutMaxMs: 600_000,
          git,
          gitEnv,
        });
        expect(continued.ran).toBe(true);
        expect(continued.promptBlock).toContain('state="failed"');
        expect(continued.promptBlock).toMatch(/Permission denied/);
        expect(continued.promptBlock).toContain("script=");
        expect(continued.promptBlock).not.toContain("parent-secret-value");
        expect(continued.failureReason).toBeUndefined();
        expect(existsSync(outsideFile)).toBe(false);

        const failed = await runRepoSetupForKind({
          api: api("fail"),
          kind: "review",
          workdir: checkout,
          defaultBranch: "main",
          auth: AUTH,
          owner: "o",
          repo: "r",
          home: fakeHome,
          timeoutMaxMs: 600_000,
          git,
          gitEnv,
        });
        expect(failed.ran).toBe(true);
        expect(failed.failureReason).toContain("exit code");
      });
    });
  });
});
