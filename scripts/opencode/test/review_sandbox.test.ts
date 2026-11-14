import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgy } from "../src/agy.ts";
import { runClaude } from "../src/claude.ts";
import { runCodex } from "../src/codex.ts";
import { EngineFailedError } from "../src/engine.ts";
import { runOpenCode } from "../src/git.ts";
import {
  ALLOW_UNSANDBOXED_REVIEWS_ENV,
  allowUnsandboxedReviews,
  checkReviewSandbox,
  findOnPath,
  findReviewEnvViolations,
  REVIEW_SANDBOX_MIN_ABI,
  REVIEW_SANDBOX_WRAPPER_ENV,
  resolveAgentBin,
  resolveReviewSpawnSandbox,
  resolveWorktreeGitDirSync,
  reviewSandboxArgv,
  reviewSandboxRules,
  reviewSandboxWrapperPath,
  setReviewSandboxProbeForTests,
} from "../src/review_sandbox.ts";

const originalWrapper = process.env[REVIEW_SANDBOX_WRAPPER_ENV];
const originalAllow = process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV];

afterEach(() => {
  setReviewSandboxProbeForTests(undefined);
  if (originalWrapper === undefined) delete process.env[REVIEW_SANDBOX_WRAPPER_ENV];
  else process.env[REVIEW_SANDBOX_WRAPPER_ENV] = originalWrapper;
  if (originalAllow === undefined) delete process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV];
  else process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV] = originalAllow;
});

function reviewOpts(workdir: string, home?: string) {
  return { trace: { kind: "review" as const, owner: "o", repo: "r" }, sanitizeEnv: true, workdir, home, model: "m" };
}

describe("reviewSandboxRules", () => {
  test("read-write covers checkout, scratch, home, and an external gitdir; system stays read-only", () => {
    const rules = reviewSandboxRules({
      workdir: "/work/repo",
      scratchDir: "/work/repo/.jumi-tmp/scratch",
      homeDir: "/data",
      gitDir: "/work/_cache/repo.git/worktrees/1",
    });
    expect(rules.readWrite).toEqual([
      "/work/repo",
      "/work/repo/.jumi-tmp/scratch",
      "/data",
      "/work/_cache/repo.git/worktrees/1",
    ]);
    expect(rules.readOnly).toContain("/usr");
    expect(rules.readOnly).toContain("/etc");
    expect(rules.devices).toEqual(["/dev"]);
  });

  test("duplicate and missing entries collapse, scratch defaults under the checkout", () => {
    const rules = reviewSandboxRules({ workdir: "/work/repo", homeDir: undefined });
    expect(rules.readWrite).toEqual(["/work/repo", "/work/repo/.jumi-tmp/scratch"]);
  });
});

describe("resolveWorktreeGitDirSync", () => {
  test("resolves the commondir behind a .git file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-gitdir-"));
    try {
      const gitdir = join(dir, "wt");
      const common = join(dir, "common");
      await writeFile(join(dir, ".git"), `gitdir: ./wt\n`);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(gitdir), { recursive: true });
      await writeFile(join(gitdir, "commondir"), "../common\n");
      await mkdir(common, { recursive: true });
      expect(resolveWorktreeGitDirSync(dir)).toBe(common);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined for a normal .git directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-gitdir-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, ".git"), { recursive: true });
      expect(resolveWorktreeGitDirSync(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("findReviewEnvViolations", () => {
  test("a clean review child env passes, including its own provider keys and proxy config", () => {
    expect(
      findReviewEnvViolations({
        HOME: "/data",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: "/work/repo/.jumi-tmp/scratch",
        OPENCODE_API_KEY: "child-key",
        OPENCODE_MODEL: "openai/gpt-5.5",
        OPENCODE_DB: "/work/repo/.jumi-tmp/opencode-session.db",
        CLAUDE_CODE_OAUTH_TOKEN: "setup",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "url.http://127.0.0.1:1/.insteadOf",
        GIT_CONFIG_VALUE_0: "https://gitea.example/",
      })
    ).toEqual([]);
  });

  test("harness, forge, git-credential, and MCP-token shapes fail closed by name", () => {
    expect(
      findReviewEnvViolations({
        PATH: "x",
        JUMI_REVIEW_MCP_TOKEN: "secret",
        JUMI_TASK_PRESENT: "1",
        GIT_AUTH_TOKEN: "token",
        GITEA_BOT_TOKEN: "token",
        GITHUB_TOKEN: "token",
        BOARD_PEER_TOKEN: "token",
        REVIEW_MCP_KEY: "secret",
      })
    ).toEqual([
      "BOARD_PEER_TOKEN",
      "GITEA_BOT_TOKEN",
      "GITHUB_TOKEN",
      "GIT_AUTH_TOKEN",
      "JUMI_REVIEW_MCP_TOKEN",
      "JUMI_TASK_PRESENT",
      "REVIEW_MCP_KEY",
    ]);
  });
});

describe("reviewSandboxArgv", () => {
  test("policy flags come first, then `--`, then the untouched agent argv", () => {
    const rules = reviewSandboxRules({ workdir: "/work/repo", homeDir: "/data" });
    // A name no PATH entry provides stays bare, so the assertions below do
    // not depend on which binaries this machine has installed.
    const agent = ["jumi-no-such-agent-binary", "run", "-m", "m"];
    const argv = reviewSandboxArgv(rules, agent, "/w/review_sandbox.py");
    expect(argv[0]).toBe("/w/review_sandbox.py");
    expect(argv).toContain("--ro");
    expect(argv).toContain("--dev");
    expect(argv).toContain("--rw");
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1)).toEqual(agent);
    expect(argv.slice(0, sep)).not.toContain(agent[0]);
  });
});

describe("resolveAgentBin", () => {
  test("absolute paths pass through untouched", () => {
    expect(resolveAgentBin(["/bin/sh", "-c", "x"])).toEqual(["/bin/sh", "-c", "x"]);
  });

  test("a bare name missing from PATH stays bare and fails loudly later", () => {
    expect(resolveAgentBin(["jumi-no-such-agent-binary", "run"])).toEqual(["jumi-no-such-agent-binary", "run"]);
  });

  test("a bare name on PATH resolves to the exact file the parent found", () => {
    expect(resolveAgentBin(["sh", "-c", "x"])[0]).toMatch(/\/sh$/);
  });

  test("PATH order wins: the first executable entry is the one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-which-"));
    try {
      await writeFile(join(dir, "jumi-which-probe"), "#!/bin/sh\necho fake\n");
      await chmod(join(dir, "jumi-which-probe"), 0o755);
      expect(findOnPath("jumi-which-probe", `${dir}:/usr/bin:/bin`)).toBe(join(dir, "jumi-which-probe"));
      expect(findOnPath("jumi-which-probe", "/usr/bin:/bin")).toBeUndefined();
      expect(resolveAgentBin(["jumi-which-probe"], { PATH: `${dir}:/usr/bin` })[0]).toBe(join(dir, "jumi-which-probe"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveReviewSpawnSandbox", () => {
  test("non-review and unsanitized spawns pass through untouched", () => {
    const agent = ["opencode", "run"];
    expect(
      resolveReviewSpawnSandbox(
        { trace: { kind: "implement", owner: "o", repo: "r" }, sanitizeEnv: true, workdir: "/w", model: "m" },
        agent,
        { PATH: "x" }
      ).argv
    ).toEqual(agent);
    expect(
      resolveReviewSpawnSandbox({ sanitizeEnv: false, workdir: "/w", model: "m" }, agent, { PATH: "x" }).argv
    ).toEqual(agent);
  });

  test("forbidden child env fails the spawn closed", () => {
    expect(() =>
      resolveReviewSpawnSandbox(reviewOpts("/w"), ["claude", "-p"], {
        PATH: "x",
        JUMI_REVIEW_MCP_TOKEN: "secret",
      })
    ).toThrow(/review spawn refused: child env carries forbidden keys: JUMI_REVIEW_MCP_TOKEN/);
  });

  test("the deployer bypass runs unwrapped and logs loudly", () => {
    const logs: string[] = [];
    const agent = ["codex", "exec"];
    const decided = resolveReviewSpawnSandbox(reviewOpts("/w"), agent, { PATH: "x" }, (message) => logs.push(message), {
      [ALLOW_UNSANDBOXED_REVIEWS_ENV]: "1",
    });
    expect(decided).toEqual({ argv: agent, sandboxed: false });
    expect(logs.some((line) => line.includes("UNSANDBOXED"))).toBe(true);
  });

  test("a missing wrapper fails the review spawn closed with the remediation", () => {
    setReviewSandboxProbeForTests(undefined);
    expect(() =>
      resolveReviewSpawnSandbox(reviewOpts("/w"), ["agy", "-p"], { PATH: "x" }, () => undefined, {
        [REVIEW_SANDBOX_WRAPPER_ENV]: "/nonexistent/review_sandbox.py",
      })
    ).toThrow(/review spawn refused: Landlock sandbox unavailable.*JUMI_ALLOW_UNSANDBOXED_REVIEWS/s);
  });

  test("an available sandbox wraps every runner argv the same way", () => {
    setReviewSandboxProbeForTests({ available: true, abi: 7 });
    for (const agent of [
      ["opencode", "run", "-m", "m"],
      ["claude", "-p"],
      ["codex", "exec"],
      ["agy", "-p"],
    ]) {
      const decided = resolveReviewSpawnSandbox(reviewOpts("/w", "/data"), agent, { PATH: "x" });
      expect(decided.sandboxed).toBe(true);
      expect(decided.argv[0]).toBe(reviewSandboxWrapperPath());
      const sep = decided.argv.indexOf("--");
      expect(sep).toBeGreaterThan(0);
      expect(decided.argv.slice(sep + 1)).toEqual(resolveAgentBin(agent));
    }
  });

  test("allowUnsandboxedReviews is opt-in only", () => {
    expect(allowUnsandboxedReviews({})).toBe(false);
    expect(allowUnsandboxedReviews({ [ALLOW_UNSANDBOXED_REVIEWS_ENV]: "0" })).toBe(false);
    expect(allowUnsandboxedReviews({ [ALLOW_UNSANDBOXED_REVIEWS_ENV]: "yes" })).toBe(false);
    expect(allowUnsandboxedReviews({ [ALLOW_UNSANDBOXED_REVIEWS_ENV]: "1" })).toBe(true);
  });
});

describe("review sandbox red-team (real wrapper)", () => {
  test("pull code cannot reach the harness or secrets, but tests still run", async () => {
    const live = checkReviewSandbox();
    if (!live.available) {
      expect(live.reason ?? "").toMatch(/Landlock|executable/);
      return;
    }
    const checkout = await mkdtemp(join(tmpdir(), "sandbox-red-"));
    try {
      const scratch = join(checkout, ".jumi-tmp", "scratch");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(scratch, { recursive: true });
      const secret = join(tmpdir(), `sandbox-secret-${process.pid}`);
      await writeFile(secret, "parent-secret-value", { mode: 0o600 });
      try {
        const rules = reviewSandboxRules({ workdir: checkout, scratchDir: scratch });
        const run = (script: string, envExtra: Record<string, string> = {}) => {
          const proc = Bun.spawnSync(reviewSandboxArgv(rules, ["sh", "-c", script]), {
            cwd: checkout,
            stdout: "pipe",
            stderr: "pipe",
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: scratch, ...envExtra },
          });
          return { exitCode: proc.exitCode, out: String(proc.stdout ?? ""), err: String(proc.stderr ?? "") };
        };
        // The model credential file and the harness environ: both denied.
        const readSecret = run(`cat ${secret} 2>&1; echo rc=$?`);
        expect(readSecret.out).toMatch(/Permission denied/);
        const readEnviron = run(`head -c 16 /proc/${process.pid}/environ 2>&1; echo rc=$?`);
        expect(readEnviron.out).toMatch(/Permission denied/);
        // Signalling the harness: denied by the scope rules.
        const signal = run(`kill -0 ${process.pid} 2>&1; echo rc=$?`);
        expect(signal.out).toMatch(/Operation not permitted/);
        // The review artifact inside the checkout stays writable (closes with #530, not here).
        const artifact = run(`echo '# findings' > JUMI_REVIEW.md && cat JUMI_REVIEW.md`);
        expect(artifact.exitCode).toBe(0);
        expect(artifact.out.trim()).toBe("# findings");
        // A benign test run and scratch writes still work.
        const benign = run(`echo ok > ${scratch}/out && node -e 'console.log("ran")'`);
        expect(benign.exitCode).toBe(0);
        expect(benign.out.trim()).toBe("ran");
        // Env the harness puts in: only the child's own provider key. The
        // gate (`findReviewEnvViolations`, unit-tested above) is what stops
        // harness-namespace keys from ever reaching this env.
        const leaked = run(`printenv | sort`, { OPENCODE_API_KEY: "child-key" });
        expect(leaked.out).toContain("OPENCODE_API_KEY=child-key");
        expect(leaked.out).not.toContain("JUMI_");
        expect(leaked.out).not.toContain("MCP");
      } finally {
        await rm(secret, { force: true });
      }
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });
});

describe("review engine sandbox wiring", () => {
  test("every engine refuses a review spawn when Landlock is unavailable", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "sandbox-wire-"));
    const home = await mkdtemp(join(tmpdir(), "sandbox-wire-home-"));
    try {
      const refuse = { available: false as const, reason: "unit-test probe says no Landlock" };
      setReviewSandboxProbeForTests(refuse);
      const opts = { prompt: "p", model: "m", workdir, home, sanitizeEnv: true as const };
      const review = { kind: "review" as const, owner: "o", repo: "r" };
      for (const run of [
        () => runOpenCode({ ...opts, trace: review }),
        () => runClaude({ ...opts, trace: review }),
        () => runCodex({ ...opts, trace: review }),
        () => runAgy({ ...opts, trace: review }),
      ]) {
        let caught: unknown;
        try {
          await run();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(EngineFailedError);
        expect((caught as EngineFailedError).message).toContain("review spawn refused");
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("every engine spawns through the wrapper when the sandbox is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-wire-bins-"));
    const workdir = await mkdtemp(join(tmpdir(), "sandbox-wire-work-"));
    const home = await mkdtemp(join(tmpdir(), "sandbox-wire-home-"));
    const seen = join(dir, "seen.log");
    const stub = `#!/bin/sh
if [ "$1" = "--check" ]; then echo "landlock-abi=7"; exit 0; fi
printf 'WRAPPED %s\\n' "$*" >> "${seen}"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$1" = "--" ] && shift
printf 'AGENT %s\\n' "$*" >> "${seen}"
bin="$1"; shift
case "$bin" in
  *opencode) printf 'ok\\n';;
  *claude) printf 'ok\\n';;
  *codex) printf '{"type":"thread.started","thread_id":"t"}\\n{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"done"}}\\n';;
  *agy) printf '{"event":"result","status":"SUCCESS","response":"done"}\\n';;
esac
`;
    try {
      await writeFile(join(dir, "jumi-sandbox-stub"), stub);
      await chmod(join(dir, "jumi-sandbox-stub"), 0o755);
      process.env[REVIEW_SANDBOX_WRAPPER_ENV] = join(dir, "jumi-sandbox-stub");
      const opts = { prompt: "p", model: "m", workdir, home, sanitizeEnv: true as const };
      const review = { kind: "review" as const, owner: "o", repo: "r" };
      // Codex refuses an empty review (no artifact); seed one so the wrapped path is what is graded.
      await writeFile(join(workdir, "JUMI_REVIEW.md"), "# findings\n");
      await expect(runOpenCode({ ...opts, trace: review })).resolves.toMatchObject({ status: "ok" });
      await expect(runClaude({ ...opts, trace: review })).resolves.toMatchObject({ status: "ok" });
      await expect(runCodex({ ...opts, type: "codex", trace: review })).resolves.toMatchObject({ status: "ok" });
      await expect(runAgy({ ...opts, trace: review })).resolves.toMatchObject({ status: "ok" });
      const lines = (await readFile(seen, "utf8")).trim().split("\n");
      expect(lines.filter((line) => line.startsWith("WRAPPED")).length).toBe(4);
      expect(lines.filter((line) => line.startsWith("AGENT")).length).toBe(4);
      // The parent resolves the agent binary to an absolute path before
      // wrapping, so match on the basename after `AGENT `.
      const basenames = lines
        .filter((line) => line.startsWith("AGENT "))
        .map((line) => line.split(" ")[1]?.split("/").pop());
      for (const name of ["opencode", "claude", "codex", "agy"]) {
        expect(basenames).toContain(name);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("sandbox startup check", () => {
  test(`--check reports ABI ${REVIEW_SANDBOX_MIN_ABI}+ on a Landlock kernel`, () => {
    const live = checkReviewSandbox();
    if (!live.available) {
      expect(live.reason ?? "").toMatch(/Landlock|executable/);
      return;
    }
    expect(live.abi ?? 0).toBeGreaterThanOrEqual(REVIEW_SANDBOX_MIN_ABI);
  });
});
