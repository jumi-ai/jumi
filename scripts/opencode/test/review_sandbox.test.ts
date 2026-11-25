import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgy } from "../src/agy.ts";
import { runClaude } from "../src/claude.ts";
import { claudeTracingEnv, setClaudeTracingPluginDirForTests } from "../src/claude_tracing.ts";
import { runCodex } from "../src/codex.ts";
import { EngineFailedError } from "../src/engine.ts";
import { runOpenCode } from "../src/git.ts";
import {
  ALLOW_UNSANDBOXED_REVIEWS_ENV,
  agyReviewHookScriptCode,
  agyReviewHooksJson,
  allowUnsandboxedReviews,
  assertOpenCodeReviewPluginReady,
  assertReviewRunnerSandboxable,
  checkReviewSandbox,
  claudeReviewHookScriptCode,
  claudeReviewHooksJson,
  codexReviewHooksJson,
  findOnPath,
  findReviewEnvViolations,
  makeReviewHarnessTempRoot,
  OPENCODE_REVIEW_FILE_TOOLS,
  openCodeReviewShellPluginCode,
  REVIEW_PLUGIN_STARTUP_WATCH_INTERVAL_MS,
  REVIEW_SANDBOX_MIN_ABI,
  REVIEW_SANDBOX_WRAPPER_ENV,
  REVIEW_SHELL_PLUGIN_FAILED_NAME,
  REVIEW_SHELL_PLUGIN_READY_NAME,
  resolveAgentBin,
  resolveReviewSpawnSandbox,
  resolveWorktreeGitDirsSync,
  reviewSandboxArgv,
  reviewSandboxRules,
  reviewSandboxWrapperPath,
  reviewShellDeniedReadPrefixes,
  reviewShellDenyPredicateSnippet,
  reviewShellPluginFailedPath,
  reviewShellSandboxRules,
  sandboxedShellEnv,
  setReviewSandboxProbeForTests,
  wrapShellCommand,
  writeAgyReviewShellHook,
  writeClaudeReviewShellPlugin,
  writeCodexReviewShellHooks,
  writeOpenCodeReviewShellPlugin,
} from "../src/review_sandbox.ts";
import { withTempDirs, withWorkspace } from "./harness/temp.ts";

const originalWrapper = process.env[REVIEW_SANDBOX_WRAPPER_ENV];
const originalAllow = process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV];
const originalEndpoint = process.env.PHOENIX_OTLP_ENDPOINT;
const originalAgent = process.env.AGENT_INSTANCE;

afterEach(() => {
  setReviewSandboxProbeForTests(undefined);
  setClaudeTracingPluginDirForTests(undefined);
  if (originalWrapper === undefined) delete process.env[REVIEW_SANDBOX_WRAPPER_ENV];
  else process.env[REVIEW_SANDBOX_WRAPPER_ENV] = originalWrapper;
  if (originalAllow === undefined) delete process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV];
  else process.env[ALLOW_UNSANDBOXED_REVIEWS_ENV] = originalAllow;
  if (originalEndpoint === undefined) delete process.env.PHOENIX_OTLP_ENDPOINT;
  else process.env.PHOENIX_OTLP_ENDPOINT = originalEndpoint;
  if (originalAgent === undefined) delete process.env.AGENT_INSTANCE;
  else process.env.AGENT_INSTANCE = originalAgent;
});

function reviewOpts(workdir: string, home?: string) {
  return { trace: { kind: "review" as const, owner: "o", repo: "r" }, sanitizeEnv: true, workdir, home, model: "m" };
}

describe("reviewSandboxRules", () => {
  test("read-write covers checkout, scratch, home, and external gitdirs; system stays read-only", () => {
    const rules = reviewSandboxRules({
      workdir: "/work/repo",
      scratchDir: "/work/repo/.jumi-tmp/scratch",
      homeDir: "/data",
      gitDirs: ["/work/_cache/repo.git/worktrees/1", "/work/_cache/repo.git"],
    });
    expect(rules.readWrite).toEqual([
      "/work/repo",
      "/work/repo/.jumi-tmp/scratch",
      "/data",
      "/work/_cache/repo.git/worktrees/1",
      "/work/_cache/repo.git",
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

describe("resolveWorktreeGitDirsSync", () => {
  test("resolves both the worktree gitdir and the commondir behind a .git file", async () => {
    await withWorkspace(async (dir) => {
      const gitdir = join(dir, "wt");
      const common = join(dir, "common");
      await writeFile(join(dir, ".git"), `gitdir: ./wt\n`);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(gitdir), { recursive: true });
      await writeFile(join(gitdir, "commondir"), "../common\n");
      await mkdir(common, { recursive: true });
      expect(resolveWorktreeGitDirsSync(dir)).toEqual([gitdir, common]);
    });
  });

  test("resolves just the gitdir when there is no commondir", async () => {
    await withWorkspace(async (dir) => {
      const gitdir = join(dir, "wt");
      await writeFile(join(dir, ".git"), `gitdir: ./wt\n`);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(gitdir), { recursive: true });
      expect(resolveWorktreeGitDirsSync(dir)).toEqual([gitdir]);
    });
  });

  test("returns [] for a normal .git directory", async () => {
    await withWorkspace(async (dir) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, ".git"), { recursive: true });
      expect(resolveWorktreeGitDirsSync(dir)).toEqual([]);
    });
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
        GIT_AUTH_HOST: "gitea.example",
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
        BOARD_MCP_TOKEN: "token",
        BOARD_MCP_KICK_TOKEN: "token",
        REVIEW_MCP_KEY: "secret",
      })
    ).toEqual([
      "BOARD_MCP_KICK_TOKEN",
      "BOARD_MCP_TOKEN",
      "BOARD_PEER_TOKEN",
      "GITEA_BOT_TOKEN",
      "GITHUB_TOKEN",
      "GIT_AUTH_TOKEN",
      "JUMI_REVIEW_MCP_TOKEN",
      "JUMI_TASK_PRESENT",
      "REVIEW_MCP_KEY",
    ]);
  });

  test("Phoenix tracing labels pass the gate: a review Claude spawn stays runnable", () => {
    // Regression for the review refusal where `buildClaudeEnv` merges
    // `claudeTracingEnv` (six JUMI_* labels) and `resolveReviewSpawnSandbox`
    // then threw on the `JUMI_*` prefix. The labels are owner/repo/sha/job
    // identity the model already knows, never secrets; anything else under
    // JUMI_* still fails closed (covered above).
    expect(
      findReviewEnvViolations({
        PATH: "x",
        JUMI_TRACE_KIND: "review",
        JUMI_OWNER: "o",
        JUMI_REPO: "r",
        JUMI_SHA: "abc",
        JUMI_JOB_ID: "job-7",
        JUMI_AGENT_INSTANCE: "jumi-worker",
      })
    ).toEqual([]);
  });

  test("the real review Claude tracing env passes the gate", () => {
    // Review + Phoenix + Claude: `buildClaudeEnv` merges `claudeTracingEnv`
    // into the child env and `resolveReviewSpawnSandbox` gates it. Pin the
    // two together so a new JUMI_* tracing key fails here instead of refusing
    // every traced review Claude spawn at runtime.
    const pluginDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "claude-plugins",
      "claude-code-tracing"
    );
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.phoenix.svc:6006/v1/traces";
    process.env.AGENT_INSTANCE = "jumi-worker";
    setClaudeTracingPluginDirForTests(pluginDir);
    const tracing = claudeTracingEnv({ kind: "review", owner: "o", repo: "r", sha: "abc", jobId: "job-7" });
    expect(Object.keys(tracing).length).toBeGreaterThan(0);
    expect(findReviewEnvViolations(tracing)).toEqual([]);
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
    await withWorkspace(async (dir) => {
      await writeFile(join(dir, "jumi-which-probe"), "#!/bin/sh\necho fake\n");
      await chmod(join(dir, "jumi-which-probe"), 0o755);
      expect(findOnPath("jumi-which-probe", `${dir}:/usr/bin:/bin`)).toBe(join(dir, "jumi-which-probe"));
      expect(findOnPath("jumi-which-probe", "/usr/bin:/bin")).toBeUndefined();
      expect(resolveAgentBin(["jumi-which-probe"], { PATH: `${dir}:/usr/bin` })[0]).toBe(join(dir, "jumi-which-probe"));
    });
  });
});

describe("resolveReviewSpawnSandbox", () => {
  test("non-review spawns pass through untouched, review spawns without sanitizeEnv refuse", () => {
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
    expect(() =>
      resolveReviewSpawnSandbox(
        { trace: { kind: "review", owner: "o", repo: "r" }, sanitizeEnv: false, workdir: "/w", model: "m" },
        agent,
        { PATH: "x" }
      )
    ).toThrow(/review spawn refused: sanitizeEnv is required for review spawns/);
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

  test("an available sandbox leaves the agent unsandboxed: shells are wrapped via hooks", () => {
    setReviewSandboxProbeForTests({ available: true, abi: 7 });
    for (const agent of [
      ["opencode", "run", "-m", "m"],
      ["claude", "-p"],
      ["codex", "exec"],
      ["agy", "-p"],
    ]) {
      const decided = resolveReviewSpawnSandbox(reviewOpts("/w", "/data"), agent, { PATH: "x" });
      // Part-2 (jumi#550): the agent keeps its HOME login and MCP token, so
      // its argv is never wrapped. Per-shell Landlock comes from Jumi-owned
      // hooks built from `reviewShellSandboxRules` + `wrapShellCommand`.
      expect(decided.sandboxed).toBe(false);
      expect(decided.argv).toEqual(agent);
    }
  });

  test("shell rules hide the harness temp and HOME: RW checkout+scratch, RO without /tmp", () => {
    const rules = reviewShellSandboxRules({ workdir: "/work/repo", scratchDir: "/work/repo/.jumi-tmp/scratch" });
    expect(rules.readWrite).toEqual(["/work/repo", "/work/repo/.jumi-tmp/scratch"]);
    expect(rules.readOnly).not.toContain("/tmp");
    expect(rules.readOnly).toContain("/usr");
    // The harness temp root (/tmp/jumi-review-*) is never in the shell
    // allow-list, and HOME is never granted to shells.
    expect(rules.readWrite.join("\n")).not.toContain("jumi-review-");
    expect(rules.readWrite.join("\n")).not.toContain("/data");
  });

  test("wrapShellCommand scrubs provider keys and points HOME at scratch", () => {
    const rules = reviewShellSandboxRules({ workdir: "/work/repo", scratchDir: "/work/repo/.jumi-tmp/scratch" });
    const wrapped = wrapShellCommand("bun test", rules, {
      wrapperPath: "/w/review_sandbox.py",
      scratchDir: "/work/repo/.jumi-tmp/scratch",
    });
    expect(wrapped).toContain("-u OPENCODE_API_KEY");
    expect(wrapped).toContain("-u CLAUDE_CODE_OAUTH_TOKEN");
    expect(wrapped).toContain("HOME=/work/repo/.jumi-tmp/scratch/sandbox-home");
    expect(wrapped).toContain("/w/review_sandbox.py");
    expect(wrapped).toContain("sh -c");
    expect(wrapped).not.toContain("sh -e -c");
    const wrappedErrexit = wrapShellCommand("bun test", rules, {
      wrapperPath: "/w/review_sandbox.py",
      scratchDir: "/work/repo/.jumi-tmp/scratch",
      errexit: true,
    });
    expect(wrappedErrexit).toContain("sh -e -c");
  });

  test("per-runner hooks are Jumi-owned code that wrap shells and deny credential reads", async () => {
    await withWorkspace(async (workdir) => {
      const scratch = join(workdir, ".jumi-tmp", "scratch");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(scratch, { recursive: true });
      const harnessTemp = await makeReviewHarnessTempRoot();
      try {
        const input = {
          workdir,
          scratchDir: scratch,
          harnessTempDir: harnessTemp,
          homeDir: "/data",
          wrapperPath: "/w/review_sandbox.py",
        };
        // OpenCode V2 plugin: file reads denied in execute.before, every
        // shell wrapped exactly once in create.before (a rewrite in both
        // would double-wrap and fail where the wrapper sits outside the
        // shell allow-list).
        const plugin = openCodeReviewShellPluginCode(input);
        expect(plugin).toContain("Plugin.define");
        expect(plugin).toContain('ctx.tool.hook("execute.before"');
        expect(plugin).toContain('ctx.shell.hook("create.before"');
        expect(plugin).not.toContain("toolInput.command");
        // Symlink resolution lives in the shipped plugin: the deny predicate
        // must see through `docs/x -> /tmp` links the pull can commit.
        expect(plugin).toContain("realpathSync");
        // Setup writes a ready marker after both registrations so the image
        // probe can prove the load (a dropped hook fails instead of passing).
        expect(plugin).toContain(REVIEW_SHELL_PLUGIN_READY_NAME);
        expect(plugin).toContain("jumi-review-shell-sandbox");
        expect(plugin).toContain("/w/review_sandbox.py");
        expect(plugin).toContain(harnessTemp);
        // File tools cover reads, writes, search, and listing: an
        // unsandboxed agent must not reach credentials through `list /tmp`
        // or an edit/write path either.
        expect(OPENCODE_REVIEW_FILE_TOOLS).toEqual(["read", "edit", "write", "grep", "glob", "list"]);
        expect(plugin).toContain('"list"');
        expect(plugin).toContain('"edit"');
        expect(plugin).toContain('"write"');
        // Claude/Codex hooks rewrite Bash via updatedInput.
        const claudeDir = await writeClaudeReviewShellPlugin(harnessTemp, input);
        const claudeHook = await readFile(join(claudeDir, "hooks", "sandbox-bash.py"), "utf8");
        expect(claudeHook).toContain("updatedInput");
        expect(claudeHook).toContain("/w/review_sandbox.py");
        // File-search tools are denied too: the agent is unsandboxed, so the
        // token must not be reachable through Grep/Glob.
        expect(claudeHook).toContain("Grep");
        expect(claudeHook).toContain("Glob");
        expect(claudeReviewHooksJson(join(claudeDir, "hooks", "sandbox-bash.py"))).toContain("PreToolUse");
        expect(claudeReviewHooksJson(join(claudeDir, "hooks", "sandbox-bash.py"))).toContain("Grep");
        expect(codexReviewHooksJson(join(claudeDir, "hooks", "sandbox-bash.py"))).toContain("PreToolUse");
        // Agy hook handles the run_command envelope with overwrite.
        const agyHookPath = await writeAgyReviewShellHook(harnessTemp, input);
        const agyHook = await readFile(agyHookPath, "utf8");
        expect(agyHook).toContain("overwrite");
        expect(agyHook).toContain("/w/review_sandbox.py");
        // Agy file/dir tools are denied too: view_file would otherwise read
        // the global mcp_config.json holding the Bearer token.
        expect(agyHook).toContain("view_file");
        expect(agyReviewHooksJson(agyHookPath)).toContain("run_command");
        expect(agyReviewHooksJson(agyHookPath)).toContain("view_file");
        // OpenCode plugin is a directory with index.js at its root (V2 skips
        // single-file paths), outside the checkout.
        const pluginPath = await writeOpenCodeReviewShellPlugin(harnessTemp, input);
        expect(pluginPath.startsWith(harnessTemp)).toBe(true);
        expect(pluginPath.startsWith(workdir)).toBe(false);
        const { existsSync: existsSyncPlugin } = await import("node:fs");
        expect(existsSyncPlugin(join(pluginPath, "index.js"))).toBe(true);
        // Codex hooks live under its review-only CODEX_HOME (also outside).
        const reviewHome = join(harnessTemp, "codex-home");
        const { hooksPath } = await writeCodexReviewShellHooks(reviewHome, input);
        expect(hooksPath.startsWith(harnessTemp)).toBe(true);
        // Unknown runners refuse instead of running unsandboxed.
        expect(() => assertReviewRunnerSandboxable("no-such-runner")).toThrow(
          /review spawn refused.*cannot be sandboxed/
        );
      } finally {
        await rm(harnessTemp, { recursive: true, force: true });
      }
    });
  });

  test("hook deny predicates block ancestors, exact paths, and relative traversal", async () => {
    await withWorkspace(async (workdir) => {
      const scratch = join(workdir, ".jumi-tmp", "scratch");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(scratch, { recursive: true });
      const harnessTemp = await makeReviewHarnessTempRoot();
      try {
        const input = {
          workdir,
          scratchDir: scratch,
          harnessTempDir: harnessTemp,
          homeDir: "/data",
          wrapperPath: "/w/review_sandbox.py",
        };
        const denied = reviewShellDeniedReadPrefixes(input);
        const tokenFile = join(harnessTemp, "review-mcp.json");
        await writeFile(tokenFile, `{"token": "t"}`, { mode: 0o600 });
        // Relative traversal from the checkout into the outside harness temp.
        const traversal = relative(workdir, tokenFile);
        expect(traversal.startsWith("..")).toBe(true);
        const sibling = `${harnessTemp}-evil`;
        // Symlink bypass (jumi#550 review): the pull controls the checkout and
        // can commit `docs/x -> /tmp` to reveal the random suffix, then read
        // through it. A link to a sibling inside the checkout must stay allowed.
        const docsDir = join(workdir, "docs");
        await mkdir(docsDir, { recursive: true });
        const linkToParent = join(docsDir, "x");
        await symlink(dirname(harnessTemp), linkToParent);
        const linkToToken = join(docsDir, "t");
        await symlink(tokenFile, linkToToken);
        const linkViaParent = join(linkToParent, `${harnessTemp.split("/").pop()}/review-mcp.json`);
        const siblingDir = join(workdir, "sibling");
        await mkdir(siblingDir, { recursive: true });
        await writeFile(join(siblingDir, "ok.txt"), "ok\n");
        const linkOk = join(docsDir, "ok");
        await symlink(siblingDir, linkOk);

        // The JS predicate in the shipped OpenCode plugin, graded live.
        const jsSnippet = reviewShellDenyPredicateSnippet("javascript", workdir, denied);
        const jsPredicate = new Function(
          "realpathSync",
          `${jsSnippet}\nreturn { token: isDenied(${JSON.stringify(
            tokenFile
          )}), ancestor: isDenied("/tmp"), root: isDenied("/"), traversal: isDenied(${JSON.stringify(
            traversal
          )}), checkout: isDenied(${JSON.stringify(workdir)}), sibling: isDenied(${JSON.stringify(
            sibling
          )}), empty: isDenied(""), linkDir: isDenied(${JSON.stringify(
            linkToParent
          )}), linkVia: isDenied(${JSON.stringify(linkViaParent)}), linkFile: isDenied(${JSON.stringify(
            linkToToken
          )}), linkOk: isDenied(${JSON.stringify(linkOk)}) };`
        ) as (realpath: typeof realpathSync) => Record<string, boolean>;
        expect(jsPredicate(realpathSync)).toEqual({
          token: true,
          ancestor: true,
          root: true,
          traversal: true,
          checkout: false,
          sibling: false,
          empty: false,
          linkDir: true,
          linkVia: true,
          linkFile: true,
          linkOk: false,
        });

        // The Python predicates in the shipped hook scripts, graded live
        // through both envelopes (Claude exit-2 deny, Agy decision deny).
        const runPythonHook = (script: string, event: unknown) => {
          const eventPath = join(scratch, `deny-event-${Math.random().toString(36).slice(2)}.json`);
          return (async () => {
            await writeFile(eventPath, JSON.stringify(event));
            try {
              return Bun.spawnSync(["python3", script], {
                stdin: Bun.file(eventPath),
                stdout: "pipe",
                stderr: "pipe",
              });
            } finally {
              await rm(eventPath, { force: true });
            }
          })();
        };
        const claudeHook = join(scratch, "deny-claude-hook.py");
        await writeFile(claudeHook, claudeReviewHookScriptCode(input), { mode: 0o700 });
        const claudeEvent = (tool: string, path: string) => ({
          tool_name: tool,
          tool_input: { path },
        });
        expect((await runPythonHook(claudeHook, claudeEvent("Grep", tokenFile))).exitCode).toBe(2);
        expect((await runPythonHook(claudeHook, claudeEvent("Grep", "/tmp"))).exitCode).toBe(2);
        expect((await runPythonHook(claudeHook, claudeEvent("Glob", "/"))).exitCode).toBe(2);
        expect((await runPythonHook(claudeHook, claudeEvent("Read", traversal))).exitCode).toBe(2);
        expect((await runPythonHook(claudeHook, claudeEvent("Grep", workdir))).exitCode).toBe(0);
        expect((await runPythonHook(claudeHook, claudeEvent("Grep", sibling))).exitCode).toBe(0);
        // Symlink bypass: a link inside the checkout pointing at the denied
        // temp root or the token file must deny through read and Glob, while a
        // link to a sibling inside the checkout stays allowed.
        expect((await runPythonHook(claudeHook, claudeEvent("Read", linkToToken))).exitCode).toBe(2);
        expect((await runPythonHook(claudeHook, claudeEvent("Glob", linkToParent))).exitCode).toBe(2);
        expect((await runPythonHook(claudeHook, claudeEvent("Read", linkViaParent))).exitCode).toBe(2);
        expect((await runPythonHook(claudeHook, claudeEvent("Glob", linkOk))).exitCode).toBe(0);

        const agyHook = join(scratch, "deny-agy-hook.py");
        await writeFile(agyHook, agyReviewHookScriptCode(input), { mode: 0o700 });
        const agyEvent = (name: string, args: Record<string, string>) => ({ toolCall: { name, args } });
        const denyOutcome = async (name: string, args: Record<string, string>) => {
          const proc = await runPythonHook(agyHook, agyEvent(name, args));
          expect(proc.exitCode).toBe(0);
          return String(proc.stdout ?? "");
        };
        expect(await denyOutcome("view_file", { FilePath: tokenFile })).toContain('"decision": "deny"');
        expect(await denyOutcome("list_dir", { directory: "/tmp" })).toContain('"decision": "deny"');
        expect(await denyOutcome("grep_search", { directory: traversal })).toContain('"decision": "deny"');
        expect(await denyOutcome("view_file", { FilePath: workdir })).not.toContain('"decision": "deny"');
        expect(await denyOutcome("view_file", { FilePath: linkToToken })).toContain('"decision": "deny"');
        expect(await denyOutcome("list_dir", { directory: linkToParent })).toContain('"decision": "deny"');
        expect(await denyOutcome("view_file", { FilePath: linkOk })).not.toContain('"decision": "deny"');
      } finally {
        await rm(harnessTemp, { recursive: true, force: true });
      }
    });
  });

  test("allowUnsandboxedReviews is opt-in only", () => {
    expect(allowUnsandboxedReviews({})).toBe(false);
    expect(allowUnsandboxedReviews({ [ALLOW_UNSANDBOXED_REVIEWS_ENV]: "0" })).toBe(false);
    expect(allowUnsandboxedReviews({ [ALLOW_UNSANDBOXED_REVIEWS_ENV]: "yes" })).toBe(false);
    expect(allowUnsandboxedReviews({ [ALLOW_UNSANDBOXED_REVIEWS_ENV]: "1" })).toBe(true);
  });

  test("startup-failed watch defaults to 100 ms", () => {
    expect(REVIEW_PLUGIN_STARTUP_WATCH_INTERVAL_MS).toBe(100);
  });
});

describe("review plugin first-init guard (jumi#831)", () => {
  test("generated plugin contains the fail-closed bootstrap", async () => {
    await withWorkspace(async (workdir) => {
      const scratch = join(workdir, ".jumi-tmp", "scratch");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(scratch, { recursive: true });
      const harnessTemp = await makeReviewHarnessTempRoot();
      try {
        const plugin = openCodeReviewShellPluginCode({
          workdir,
          scratchDir: scratch,
          harnessTempDir: harnessTemp,
          homeDir: "/data",
          wrapperPath: "/w/review_sandbox.py",
        });
        // Bootstrap: dynamic API import inside a non-throwing setup covering
        // import, hook installation, and the ready-marker write.
        expect(plugin).toContain('await import("@opencode/plugin")');
        expect(plugin).toContain(REVIEW_SHELL_PLUGIN_FAILED_NAME);
        expect(plugin).toContain(reviewShellPluginFailedPath(harnessTemp));
        expect(plugin).toContain("new Promise(() => {})");
        expect(plugin).toContain("failClosed");
        // No static plugin-API import that could throw before setup runs.
        expect(plugin).not.toContain('from "@opencode/plugin"');
        expect(plugin).not.toContain("Plugin.define(");
        // Plain V2 definition shape (id + setup) without the helper.
        expect(plugin).toContain('id: "jumi-review-shell-sandbox"');
        expect(plugin).toContain("async setup(ctx)");
        // Healthy setup retains today's wrapping behavior.
        expect(plugin).toContain('ctx.tool.hook("execute.before"');
        expect(plugin).toContain('ctx.shell.hook("create.before"');
        expect(plugin).toContain(REVIEW_SHELL_PLUGIN_READY_NAME);
        // The generated file parses, so the pre-spawn transpile check passes it.
        expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(plugin)).not.toThrow();
      } finally {
        await rm(harnessTemp, { recursive: true, force: true });
      }
    });
  });

  test("preflight passes a healthy plugin and refuses missing, unregistered, and invalid plugins", async () => {
    await withWorkspace(async (workdir) => {
      const scratch = join(workdir, ".jumi-tmp", "scratch");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(scratch, { recursive: true });
      const harnessTemp = await makeReviewHarnessTempRoot();
      try {
        const input = {
          workdir,
          scratchDir: scratch,
          harnessTempDir: harnessTemp,
          homeDir: "/data",
          wrapperPath: "/w/review_sandbox.py",
        };
        const pluginDir = await writeOpenCodeReviewShellPlugin(harnessTemp, input);
        const globalPath = join(harnessTemp, "xdg-config", "opencode", "opencode.json");
        await writeFile(globalPath, JSON.stringify({ plugins: [pluginDir] }));
        await expect(assertOpenCodeReviewPluginReady(pluginDir, globalPath)).resolves.toBeUndefined();
        // Missing plugin file refuses.
        await rm(join(pluginDir, "index.js"), { force: true });
        await expect(assertOpenCodeReviewPluginReady(pluginDir, globalPath)).rejects.toThrow(
          /review spawn refused.*review shell plugin missing/
        );
        await writeOpenCodeReviewShellPlugin(harnessTemp, input);
        // Config not referencing the plugin directory refuses.
        await writeFile(globalPath, JSON.stringify({ plugins: [] }));
        await expect(assertOpenCodeReviewPluginReady(pluginDir, globalPath)).rejects.toThrow(
          /review spawn refused.*not registered/
        );
        await writeFile(globalPath, JSON.stringify({ plugins: [pluginDir] }));
        // Syntactically invalid plugin refuses.
        await writeFile(join(pluginDir, "index.js"), "this is not valid javascript {{{ probe\n");
        await expect(assertOpenCodeReviewPluginReady(pluginDir, globalPath)).rejects.toThrow(
          /review spawn refused.*invalid syntax/
        );
      } finally {
        await rm(harnessTemp, { recursive: true, force: true });
      }
    });
  });

  test("hook-install failure writes the startup-failed marker and never settles", async () => {
    await withWorkspace(async (workdir) => {
      const scratch = join(workdir, ".jumi-tmp", "scratch");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(scratch, { recursive: true });
      const harnessTemp = await makeReviewHarnessTempRoot();
      try {
        const input = {
          workdir,
          scratchDir: scratch,
          harnessTempDir: harnessTemp,
          homeDir: "/data",
          wrapperPath: "/w/review_sandbox.py",
        };
        // Stub plugin-API module with a valid define so setup reaches hook
        // installation; the mock ctx then throws there.
        const stubPath = join(harnessTemp, "stub-plugin-api.mjs");
        await writeFile(stubPath, `export const Plugin = { define(x) { return x; } };\n`);
        const source = openCodeReviewShellPluginCode(input).replaceAll(
          '"@opencode/plugin"',
          JSON.stringify(`file://${stubPath}`)
        );
        const pluginPath = join(harnessTemp, "hook-fail-index.mjs");
        await writeFile(pluginPath, source);
        const mod = await import(`file://${pluginPath}`);
        const throwingCtx = {
          tool: { hook: async () => Promise.reject(new Error("hook install boom")) },
          shell: { hook: async () => undefined },
        };
        let settled: string | undefined;
        void (mod.default.setup(throwingCtx) as Promise<unknown>).then(
          () => (settled = "resolved"),
          () => (settled = "rejected")
        );
        await Bun.sleep(250);
        const { existsSync } = await import("node:fs");
        expect(existsSync(reviewShellPluginFailedPath(harnessTemp))).toBe(true);
        expect(settled).toBeUndefined();
      } finally {
        await rm(harnessTemp, { recursive: true, force: true });
      }
    });
  });

  test("plugin-API import failure writes the marker and never settles", async () => {
    await withWorkspace(async (workdir) => {
      const scratch = join(workdir, ".jumi-tmp", "scratch");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(scratch, { recursive: true });
      const harnessTemp = await makeReviewHarnessTempRoot();
      try {
        const input = {
          workdir,
          scratchDir: scratch,
          harnessTempDir: harnessTemp,
          homeDir: "/data",
          wrapperPath: "/w/review_sandbox.py",
        };
        const stubPath = join(harnessTemp, "stub-plugin-api-throw.mjs");
        await writeFile(stubPath, `throw new Error("stub plugin API import boom");\n`);
        const source = openCodeReviewShellPluginCode(input).replaceAll(
          '"@opencode/plugin"',
          JSON.stringify(`file://${stubPath}`)
        );
        const pluginPath = join(harnessTemp, "import-fail-index.mjs");
        await writeFile(pluginPath, source);
        const mod = await import(`file://${pluginPath}`);
        const ctx = { tool: { hook: async () => undefined }, shell: { hook: async () => undefined } };
        let settled: string | undefined;
        void (mod.default.setup(ctx) as Promise<unknown>).then(
          () => (settled = "resolved"),
          () => (settled = "rejected")
        );
        await Bun.sleep(250);
        const { existsSync } = await import("node:fs");
        expect(existsSync(reviewShellPluginFailedPath(harnessTemp))).toBe(true);
        expect(settled).toBeUndefined();
      } finally {
        await rm(harnessTemp, { recursive: true, force: true });
      }
    });
  });

  test("marker-write failure still never settles, and markers are per-spawn", async () => {
    await withWorkspace(async (workdir) => {
      const scratch = join(workdir, ".jumi-tmp", "scratch");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(scratch, { recursive: true });
      const first = await makeReviewHarnessTempRoot();
      const second = await makeReviewHarnessTempRoot();
      try {
        // Fresh per-spawn identity: distinct paths, neither present up front.
        expect(reviewShellPluginFailedPath(first)).not.toBe(reviewShellPluginFailedPath(second));
        const { existsSync } = await import("node:fs");
        expect(existsSync(reviewShellPluginFailedPath(first))).toBe(false);
        expect(existsSync(reviewShellPluginFailedPath(second))).toBe(false);
        const input = {
          workdir,
          scratchDir: scratch,
          harnessTempDir: first,
          homeDir: "/data",
          wrapperPath: "/w/review_sandbox.py",
        };
        // Make the marker unwritable (a directory at the marker path) so the
        // bootstrap's marker write itself throws; setup must still pend.
        await mkdir(reviewShellPluginFailedPath(first), { recursive: true });
        const stubPath = join(first, "stub-plugin-api.mjs");
        await writeFile(stubPath, `export const Plugin = { define(x) { return x; } };\n`);
        const source = openCodeReviewShellPluginCode(input).replaceAll(
          '"@opencode/plugin"',
          JSON.stringify(`file://${stubPath}`)
        );
        const pluginPath = join(first, "marker-fail-index.mjs");
        await writeFile(pluginPath, source);
        const mod = await import(`file://${pluginPath}`);
        const throwingCtx = {
          tool: { hook: async () => Promise.reject(new Error("hook install boom")) },
          shell: { hook: async () => undefined },
        };
        let settled: string | undefined;
        void (mod.default.setup(throwingCtx) as Promise<unknown>).then(
          () => (settled = "resolved"),
          () => (settled = "rejected")
        );
        await Bun.sleep(250);
        expect(settled).toBeUndefined();
        // The sibling spawn's marker is untouched.
        expect(existsSync(reviewShellPluginFailedPath(second))).toBe(false);
      } finally {
        await rm(first, { recursive: true, force: true });
        await rm(second, { recursive: true, force: true });
      }
    });
  });
});

describe("review sandbox red-team (real wrapper)", () => {
  test("pull code cannot reach the harness or secrets, but tests still run", async () => {
    const live = checkReviewSandbox();
    if (!live.available) {
      expect(live.reason ?? "").toMatch(/Landlock|executable/);
      return;
    }
    await withWorkspace(async (checkout) => {
      const scratch = join(checkout, ".jumi-tmp", "scratch");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(scratch, { recursive: true });
      Bun.spawnSync(["git", "init", "-q", checkout], { stdout: "pipe", stderr: "pipe" });
      // Harness temp lives outside the checkout (/tmp/jumi-review-*): the
      // shell policy omits /tmp, so it stays unreachable even though /tmp
      // itself is world-readable. HOME is never granted to shells.
      const harnessTemp = await makeReviewHarnessTempRoot();
      const tokenFile = join(harnessTemp, "review-mcp.json");
      await writeFile(tokenFile, `{"token": "parent-secret-token"}`, { mode: 0o600 });
      const secretDir = await mkdtemp(join(homedir(), "sandbox-secret-"));
      const secret = join(secretDir, "secret");
      await writeFile(secret, "parent-secret-value", { mode: 0o600 });
      try {
        const rules = reviewShellSandboxRules({ workdir: checkout, scratchDir: scratch });
        // Shells see no /tmp and no HOME: the outside temp and the agent
        // credential file are both denied by absence from the allow-list.
        expect(rules.readOnly).not.toContain("/tmp");
        expect(rules.readWrite.join("\n")).not.toContain(harnessTemp);
        const run = (script: string, envExtra: Record<string, string> = {}) => {
          const proc = Bun.spawnSync(reviewSandboxArgv(rules, ["sh", "-c", script]), {
            cwd: checkout,
            stdout: "pipe",
            stderr: "pipe",
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: scratch, ...envExtra },
          });
          return { exitCode: proc.exitCode, out: String(proc.stdout ?? ""), err: String(proc.stderr ?? "") };
        };
        // The harness MCP token outside the checkout: denied.
        const tokenRead = run(`cat ${tokenFile} 2>&1; echo rc=$?`);
        expect(tokenRead.out).toMatch(/Permission denied/);
        // The model credential file and the harness environ: both denied.
        const readSecret = run(`cat ${secret} 2>&1; echo rc=$?`);
        expect(readSecret.out).toMatch(/Permission denied/);
        const readEnviron = run(`head -c 16 /proc/${process.pid}/environ 2>&1; echo rc=$?`);
        expect(readEnviron.out).toMatch(/Permission denied/);
        // Signalling the harness: denied by the scope rules.
        const signal = run(`kill -0 ${process.pid} 2>&1; echo rc=$?`);
        expect(signal.out).toMatch(/Operation not permitted/);
        // Writing into the harness's /proc fd: denied (non-zero exit; the
        // exact message varies by shell, so grade the failure, not the text).
        const fdWrite = run(`echo evil > /proc/${process.pid}/fd/1 2>&1; echo rc=$?`);
        expect(fdWrite.out).toMatch(/rc=(1|2)/);
        // The checkout itself stays RW (diffs must be readable, tests must
        // run); the verdict is protected by the MCP store winning over the
        // file (see review.ts), not by denying this write. A shell *can*
        // write JUMI_REVIEW.md, but without the token it cannot change the
        // store, so the posted status does not change.
        const artifact = run(`echo '# findings' > JUMI_REVIEW.md && cat JUMI_REVIEW.md`);
        expect(artifact.exitCode).toBe(0);
        expect(artifact.out.trim()).toBe("# findings");
        await rm(join(checkout, "JUMI_REVIEW.md"), { force: true });
        // Shell env scrubbing: the hook prefix removes provider keys so a
        // `printenv` in pull code learns nothing. The prefix is what the
        // hooks embed; grade the string here and the FS denial above.
        const wrapped = wrapShellCommand("printenv | sort", rules, {
          wrapperPath: reviewSandboxWrapperPath(),
          scratchDir: scratch,
        });
        expect(wrapped).toContain("env -u OPENCODE_API_KEY");
        expect(wrapped).toContain(`HOME=${sandboxedShellEnv(scratch).HOME}`);
        // A benign test run, scratch writes, and git still work.
        const benign = run(`echo ok > ${scratch}/out && node -e 'console.log("ran")'`);
        expect(benign.exitCode).toBe(0);
        expect(benign.out.trim()).toBe("ran");
        const gitOk = run(`git rev-parse --show-toplevel && git status --porcelain`);
        // Initialized below: the checkout is a git repo for this case.
        expect(gitOk.exitCode).toBe(0);
        // Shallow clone of a local repo into scratch still works (stands in
        // for the public-repo clone: no network in unit tests).
        const src = join(checkout, "clone-src");
        await mkdir(src, { recursive: true });
        Bun.spawnSync(["git", "init", "-q", src], { stdout: "pipe", stderr: "pipe" });
        await writeFile(join(src, "file.txt"), "hi\n");
        Bun.spawnSync(["git", "-C", src, "add", "file.txt"], { stdout: "pipe", stderr: "pipe" });
        Bun.spawnSync(["git", "-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const clone = run(`git clone --depth 1 file://${src} ${scratch}/cloned 2>&1; echo rc=$?`);
        expect(clone.out).toMatch(/rc=0/);
      } finally {
        await rm(harnessTemp, { recursive: true, force: true }).catch(() => undefined);
        await rm(secretDir, { recursive: true, force: true });
      }
    });
  });
});

describe("review engine sandbox wiring", () => {
  test("every engine refuses a review spawn when Landlock is unavailable", async () => {
    await withTempDirs(["jumi-tmp-", "jumi-tmp-"], async (workdir, home) => {
      const refuse = { available: false as const, reason: "unit-test probe says no Landlock" };
      setReviewSandboxProbeForTests(refuse);
      // Reviewer spawns always carry the forge host (repo_setup sets
      // GIT_AUTH_HOST); without it agy's pre-gate forge-deny setup refuses
      // first, which would grade the deny setup instead of the sandbox gate.
      const opts = {
        prompt: "p",
        model: "m",
        workdir,
        home,
        sanitizeEnv: true as const,
        extraEnv: { GIT_AUTH_HOST: "forge.example" },
      };
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
    });
  });

  test("every engine sets up per-shell hooks and leaves the agent unsandboxed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-wire-bins-"));
    const workdir = await mkdtemp(join(tmpdir(), "sandbox-wire-work-"));
    const home = await mkdtemp(join(tmpdir(), "sandbox-wire-home-"));
    // Fake agent binaries (Jumi-owned PATH dir, never the checkout): each
    // prints what its runner parses as success. The agent itself is never
    // wrapped; the per-shell hooks are what the test grades.
    const fakeBinDir = join(dir, "bin");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(fakeBinDir, { recursive: true });
    const fake = {
      opencode: `#!/bin/sh\nprintf 'ok\\n'`,
      claude: `#!/bin/sh\nprintf 'ok\\n'`,
      codex: `#!/bin/sh\nprintf '{"type":"thread.started","thread_id":"t"}\\n{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"done"}}\\n'`,
      agy: `#!/bin/sh\nprintf '{"event":"result","status":"SUCCESS","response":"done"}\\n'`,
    };
    for (const [name, body] of Object.entries(fake)) {
      await writeFile(join(fakeBinDir, name), `${body}\n`);
      await chmod(join(fakeBinDir, name), 0o755);
    }
    // Fake wrapper for the --check probe only; the agent argv never uses it.
    const seen = join(dir, "seen.log");
    const stub = `#!/bin/sh
if [ "$1" = "--check" ]; then echo "landlock-abi=7"; exit 0; fi
printf 'WRAPPED %s\\n' "$*" >> "${seen}"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$1" = "--" ] && shift
printf 'AGENT %s\\n' "$*" >> "${seen}"
exec "$@"
`;
    const originalPath = process.env.PATH;
    try {
      await writeFile(join(dir, "jumi-sandbox-stub"), stub);
      await chmod(join(dir, "jumi-sandbox-stub"), 0o755);
      process.env[REVIEW_SANDBOX_WRAPPER_ENV] = join(dir, "jumi-sandbox-stub");
      process.env.PATH = `${fakeBinDir}:${originalPath ?? "/usr/bin:/bin"}`;
      // Same forge-host seeding as the refusal test: reviewer spawns always
      // carry GIT_AUTH_HOST, and agy's forge-deny setup needs it before the
      // sandbox gate is reached.
      const opts = {
        prompt: "p",
        model: "m",
        workdir,
        home,
        sanitizeEnv: true as const,
        extraEnv: { GIT_AUTH_HOST: "forge.example" },
      };
      const review = { kind: "review" as const, owner: "o", repo: "r" };
      // Codex refuses an empty review (no artifact); seed one so the hook path is what is graded.
      await writeFile(join(workdir, "JUMI_REVIEW.md"), "# findings\n");
      await expect(runOpenCode({ ...opts, trace: review })).resolves.toMatchObject({ status: "ok" });
      await expect(runClaude({ ...opts, trace: review })).resolves.toMatchObject({ status: "ok" });
      await expect(runCodex({ ...opts, type: "codex", trace: review })).resolves.toMatchObject({ status: "ok" });
      await expect(runAgy({ ...opts, trace: review })).resolves.toMatchObject({ status: "ok" });
      // The agent was never wrapped: the stub saw no WRAPPED lines. The
      // per-shell hooks are Jumi-owned files outside the checkout (the
      // harness temp root is /tmp/jumi-review-*, never workdir/.jumi-tmp).
      let wrapped = 0;
      try {
        const lines = (await readFile(seen, "utf8")).trim().split("\n").filter(Boolean);
        wrapped = lines.filter((line) => line.startsWith("WRAPPED")).length;
      } catch {
        wrapped = 0;
      }
      expect(wrapped).toBe(0);
      // Scratch sandbox HOME was created for the shells.
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(workdir, ".jumi-tmp", "scratch", "sandbox-home"))).toBe(true);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
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
