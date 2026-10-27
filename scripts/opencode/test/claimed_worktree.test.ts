import { describe, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claimFilePath, readClaim, writeClaim } from "../src/claim.ts";
import {
  attachIssueWorktree,
  attachPrWorktree,
  beginClaimedWorktree,
  commitIfDirty,
  ensureBareCache,
  inspectMovedPrHead,
  inspectRemoteContainsDefault,
  isAbortError,
  isClaimedEarlyResult,
  openClaimedLoop,
  pushClaimedBranch,
  recheckAssignedAndOpen,
  removeTree,
  runClaimedLoop,
  stripSentinels,
  throwIfAborted,
  worktreePorcelain,
} from "../src/claimed_worktree.ts";
import { type Engine, EngineFailedError } from "../src/engine.ts";
import { hasJumiLabel } from "../src/github_webhook.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeIssue, makeIssueJob, makeUser, stripGitConfigArgs } from "./fixtures.ts";

const fallbackEngine: Engine = async () => ({ status: "ok" });

async function withDirs(run: (home: string, workdir: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "jumi-claimed-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-claimed-work-"));
  try {
    await run(home, workdir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("beginClaimedWorktree", () => {
  test("lays out worktree and bare paths and resolves engine", async () => {
    await withDirs(async (home, workdir) => {
      let used = "";
      const engine: Engine = async () => {
        used = "engine";
        return { status: "ok" };
      };
      const openCodeRunner: Engine = async () => {
        used = "openCode";
        return { status: "ok" };
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        engine,
        openCodeRunner,
        fallbackEngine,
        useClaim: false,
        now: () => new Date("2026-05-23T00:00:00Z"),
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      expect(claimed.owner).toBe("kirmanak");
      expect(claimed.repo).toBe("demo");
      expect(claimed.issueNumber).toBe(12);
      expect(claimed.worktree).toBe(join(workdir, "kirmanak", "demo", "12"));
      expect(claimed.barePath).toBe(join(workdir, "_cache", "kirmanak", "demo.git"));
      expect(claimed.claimPath).toBe(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claimed.claim.branch).toBe("");
      await claimed.engine({ model: "openai/gpt-5.5", workdir: claimed.worktree });
      expect(used).toBe("engine");
    });
  });

  test("prefers openCodeRunner over fallback when engine is unset", async () => {
    await withDirs(async (home, workdir) => {
      let used = "";
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        openCodeRunner: async () => {
          used = "openCode";
          return { status: "ok" };
        },
        fallbackEngine: async () => {
          used = "fallback";
          return { status: "ok" };
        },
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      await claimed.engine({ model: "openai/gpt-5.5", workdir: claimed.worktree });
      expect(used).toBe("openCode");
    });
  });

  test("skips when a live claim exists", async () => {
    await withDirs(async (home, workdir) => {
      const path = claimFilePath(home, "kirmanak", "demo", 12);
      await writeClaim(path, {
        pid: 42,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: new Date().toISOString(),
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
      });
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        pidAlive: () => true,
      });
      expect(claimed).toEqual({ status: "skipped", reason: "claim is live" });
    });
  });

  test("forgets a terminal claim before acquire when forgetTerminal is set", async () => {
    await withDirs(async (home, workdir) => {
      const path = claimFilePath(home, "kirmanak", "demo", 12);
      await writeClaim(path, {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
        terminal: true,
      });
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        forgetTerminal: true,
        branch: "jumi/issue-12-fix-the-thing",
        now: () => new Date("2026-05-23T01:00:00Z"),
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      expect(claimed.claim.branch).toBe("jumi/issue-12-fix-the-thing");
      expect(await readClaim(path)).toMatchObject({ pid: 0, terminal: false });
    });
  });

  test("does not forget a terminal claim when forgetTerminal is unset", async () => {
    await withDirs(async (home, workdir) => {
      const path = claimFilePath(home, "kirmanak", "demo", 12);
      await writeClaim(path, {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
        terminal: true,
      });
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
      });
      expect(claimed).toEqual({ status: "skipped", reason: "claim is live" });
      expect((await readClaim(path))?.terminal).toBe(true);
    });
  });

  test("throws on abort before acquire", async () => {
    await withDirs(async (home, workdir) => {
      const abort = new AbortController();
      abort.abort();
      await expect(
        beginClaimedWorktree({
          job: makeIssueJob(),
          home,
          workdir,
          fallbackEngine,
          abortSignal: abort.signal,
        })
      ).rejects.toThrow("cancelled");
      expect(await readClaim(claimFilePath(home, "kirmanak", "demo", 12))).toBeUndefined();
    });
  });

  test("rejects unsafe owner segments", async () => {
    await withDirs(async (home, workdir) => {
      await expect(
        beginClaimedWorktree({
          job: makeIssueJob({ owner: "../escape" }),
          home,
          workdir,
          fallbackEngine,
          useClaim: false,
        })
      ).rejects.toThrow("Invalid owner");
    });
  });
});

describe("recheckAssignedAndOpen", () => {
  test("cancels when the issue is not assigned to the bot", async () => {
    await withDirs(async (home, workdir) => {
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        now: () => new Date("2026-05-23T00:00:00Z"),
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const result = await recheckAssignedAndOpen(claimed, {
        api: { getIssue: async () => makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [] }) },
        botUsername: "jumi",
      });
      expect(result).toEqual({ status: "cancelled" });
      expect(await readClaim(claimed.claimPath)).toBeUndefined();
    });
  });

  test("cancels when the issue is closed", async () => {
    let forgot = false;
    const result = await recheckAssignedAndOpen(
      {
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        worktree: "/work",
        barePath: "/bare",
        claimPath: "/claim",
        claim: {
          pid: 0,
          startedAt: "",
          heartbeatAt: "",
          worktree: "/work",
          branch: "",
          issueUpdatedAt: "",
          headShaAtStart: "",
        },
        useClaim: true,
        sanitizeEnv: true,
        engine: fallbackEngine,
        git: async () => "",
        now: () => new Date(),
        forgetClaim: async () => {
          forgot = true;
        },
      },
      { api: { getIssue: async () => makeIssue({ state: "closed" }) }, botUsername: "jumi" }
    );
    expect(result).toEqual({ status: "cancelled" });
    expect(forgot).toBe(true);
  });

  test("skips when getIssue fails", async () => {
    let forgot = false;
    const result = await recheckAssignedAndOpen(
      {
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        worktree: "/work",
        barePath: "/bare",
        claimPath: "/claim",
        claim: {
          pid: 0,
          startedAt: "",
          heartbeatAt: "",
          worktree: "/work",
          branch: "",
          issueUpdatedAt: "",
          headShaAtStart: "",
        },
        useClaim: true,
        sanitizeEnv: true,
        engine: fallbackEngine,
        git: async () => "",
        now: () => new Date(),
        forgetClaim: async () => {
          forgot = true;
        },
      },
      {
        api: {
          getIssue: async () => {
            throw new Error("gitea 502");
          },
        },
        botUsername: "jumi",
      }
    );
    expect(result).toEqual({ status: "skipped", reason: "failed to load issue: gitea 502" });
    expect(forgot).toBe(true);
  });

  test("cancels GitHub pickup when the jumi label is missing", async () => {
    let forgot = false;
    const result = await recheckAssignedAndOpen(
      {
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        worktree: "/work",
        barePath: "/bare",
        claimPath: "/claim",
        claim: {
          pid: 0,
          startedAt: "",
          heartbeatAt: "",
          worktree: "/work",
          branch: "",
          issueUpdatedAt: "",
          headShaAtStart: "",
        },
        useClaim: true,
        sanitizeEnv: true,
        engine: fallbackEngine,
        git: async () => "",
        now: () => new Date(),
        forgetClaim: async () => {
          forgot = true;
        },
      },
      { api: { getIssue: async () => makeIssue({ labels: [] }) }, botUsername: "jumi", isPickedUp: hasJumiLabel }
    );
    expect(result).toEqual({ status: "cancelled" });
    expect(forgot).toBe(true);
  });

  test("returns undefined when GitHub issue is labeled jumi and open", async () => {
    const result = await recheckAssignedAndOpen(
      {
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        worktree: "/work",
        barePath: "/bare",
        claimPath: "/claim",
        claim: {
          pid: 0,
          startedAt: "",
          heartbeatAt: "",
          worktree: "/work",
          branch: "",
          issueUpdatedAt: "",
          headShaAtStart: "",
        },
        useClaim: true,
        sanitizeEnv: true,
        engine: fallbackEngine,
        git: async () => "",
        now: () => new Date(),
        forgetClaim: async () => {
          throw new Error("should not forget");
        },
      },
      {
        api: {
          getIssue: async () =>
            makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [], labels: [{ name: "jumi" }] }),
        },
        botUsername: "jumi",
        isPickedUp: hasJumiLabel,
      }
    );
    expect(result).toBeUndefined();
  });

  test("returns undefined when assigned and open", async () => {
    const result = await recheckAssignedAndOpen(
      {
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        worktree: "/work",
        barePath: "/bare",
        claimPath: "/claim",
        claim: {
          pid: 0,
          startedAt: "",
          heartbeatAt: "",
          worktree: "/work",
          branch: "",
          issueUpdatedAt: "",
          headShaAtStart: "",
        },
        useClaim: true,
        sanitizeEnv: true,
        engine: fallbackEngine,
        git: async () => "",
        now: () => new Date(),
        forgetClaim: async () => {
          throw new Error("should not forget");
        },
      },
      { api: { getIssue: async () => makeIssue() }, botUsername: "jumi" }
    );
    expect(result).toBeUndefined();
  });
});

describe("throwIfAborted", () => {
  test("throws AbortError when the signal is aborted", () => {
    const abort = new AbortController();
    abort.abort();
    expect(() => throwIfAborted(abort.signal)).toThrow("cancelled");
    try {
      throwIfAborted(abort.signal);
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
    }
  });
});

const loopAuth = {
  giteaUrl: "https://gitea.kirmanak.stream",
  giteaToken: "bot-token",
  botUsername: "jumi",
};

describe("openClaimedLoop heartbeat", () => {
  test("does not resurrect a terminal claim", async () => {
    await withDirs(async (home, workdir) => {
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        now: () => new Date("2026-05-23T00:00:00Z"),
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 20 });
      try {
        await loop.stampTerminalClaim({ getIssue: async () => makeIssue({ updated_at: "2026-05-23T01:00:00Z" }) });
        await new Promise((resolve) => setTimeout(resolve, 80));
        const claim = await readClaim(claimed.claimPath);
        expect(claim?.terminal).toBe(true);
        expect(claim?.pid).toBe(0);
        expect(claim?.issueUpdatedAt).toBe("2026-05-23T01:00:00Z");
      } finally {
        await loop.stopHeartbeat();
      }
    });
  });

  test("engine pid stamp is skipped after terminal", async () => {
    await withDirs(async (home, workdir) => {
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        now: () => new Date("2026-05-23T00:00:00Z"),
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      await loop.stampEnginePid(99);
      expect((await readClaim(claimed.claimPath))?.pid).toBe(99);
      await loop.stampTerminalClaim({ getIssue: async () => makeIssue() });
      await loop.engineOnPid()(100);
      const claim = await readClaim(claimed.claimPath);
      expect(claim?.terminal).toBe(true);
      expect(claim?.pid).toBe(0);
    });
  });

  test("stampHeadSha writes headShaAtStart", async () => {
    await withDirs(async (home, workdir) => {
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        now: () => new Date("2026-05-23T00:00:00Z"),
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      await loop.stampHeadSha("abc123");
      expect((await readClaim(claimed.claimPath))?.headShaAtStart).toBe("abc123");
    });
  });
});

describe("bare cache and attach", () => {
  test("clones missing cache then fetches heads", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        gitCalls.push(stripGitConfigArgs(args));
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      await ensureBareCache(loop, {
        cloneUrl: "https://gitea.kirmanak.stream/kirmanak/demo.git",
        giteaUrl: "https://gitea.kirmanak.stream",
        log: () => undefined,
      });
      expect(gitCalls.some((args) => args[0] === "clone" && args.includes("--bare"))).toBe(true);
      expect(gitCalls.some((args) => args.includes("+refs/heads/*:refs/remotes/origin/*"))).toBe(true);
      expect(gitCalls.some((args) => args.includes("+refs/heads/*:refs/heads/*"))).toBe(false);
    });
  });

  test("issue attach prefers origin issue branch over default", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") {
          const ref = gitArgs.at(-1);
          if (ref === "refs/remotes/origin/jumi/issue-12-fix-the-thing") return "abc123";
          throw new Error("missing");
        }
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      const headSha = await attachIssueWorktree(loop, {
        branch: "jumi/issue-12-fix-the-thing",
        defaultBranch: "main",
        log: () => undefined,
      });
      expect(headSha).toBe("abc123");
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "worktree" &&
            args[1] === "add" &&
            args.includes("-B") &&
            args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "add" && args.includes("origin/main"))).toBe(
        false
      );
    });
  });

  test("issue attach clears a leftover directory without .git before adding", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") throw new Error("missing");
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      await mkdir(join(claimed.worktree, ".jumi-tmp"), { recursive: true });
      await writeFile(join(claimed.worktree, ".jumi-tmp", "session.db"), "db");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      await attachIssueWorktree(loop, { branch: "jumi/issue-12-fix-the-thing", defaultBranch: "main", log: () => {} });
      await expect(access(join(claimed.worktree, ".jumi-tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      const pruneAt = gitCalls.findIndex((args) => args[0] === "worktree" && args[1] === "prune");
      const addAt = gitCalls.findIndex((args) => args[0] === "worktree" && args[1] === "add");
      expect(pruneAt).toBeGreaterThanOrEqual(0);
      expect(addAt).toBeGreaterThan(pruneAt);
    });
  });

  test("attach clears a .git file whose gitdir is gone instead of reusing it", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") return "";
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      const dangling = async () => {
        await mkdir(join(claimed.worktree, ".jumi-tmp"), { recursive: true });
        await writeFile(join(claimed.worktree, ".git"), `gitdir: ${join(workdir, "bare.git", "worktrees", "12")}\n`);
      };
      await dangling();
      await attachIssueWorktree(loop, { branch: "jumi/issue-12-fix-the-thing", defaultBranch: "main", log: () => {} });
      await expect(access(join(claimed.worktree, ".jumi-tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      await dangling();
      const attached = await attachPrWorktree(loop, {
        branch: "jumi/issue-12-fix-the-thing",
        defaultBranch: "main",
        log: () => {},
      });
      if (isClaimedEarlyResult(attached)) throw new Error("expected attach");
      await expect(access(join(claimed.worktree, ".jumi-tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(gitCalls.filter((args) => args[0] === "worktree" && args[1] === "add")).toHaveLength(2);
      expect(gitCalls.some((args) => args[0] === "reset")).toBe(false);
    });
  });

  test("attach reuses a .git file whose gitdir still exists", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") return "";
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const adminDir = join(workdir, "bare.git", "worktrees", "12");
      await mkdir(adminDir, { recursive: true });
      await mkdir(claimed.worktree, { recursive: true });
      await writeFile(join(claimed.worktree, ".git"), `gitdir: ${adminDir}\n`);
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      await attachIssueWorktree(loop, { branch: "jumi/issue-12-fix-the-thing", defaultBranch: "main", log: () => {} });
      expect(gitCalls.some((args) => args[0] === "worktree")).toBe(false);
    });
  });

  test("attach ignores .jumi-tmp in the common exclude before a child starts", async () => {
    await withDirs(async (home, workdir) => {
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "show-ref") return "";
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const adminDir = join(workdir, "bare.git", "worktrees", "12");
      await mkdir(adminDir, { recursive: true });
      await writeFile(join(adminDir, "commondir"), "../..\n");
      await mkdir(claimed.worktree, { recursive: true });
      await writeFile(join(claimed.worktree, ".git"), `gitdir: ${adminDir}\n`);
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      await attachIssueWorktree(loop, { branch: "jumi/issue-12-fix-the-thing", defaultBranch: "main", log: () => {} });
      await attachPrWorktree(loop, { branch: "jumi/issue-12-fix-the-thing", defaultBranch: "main", log: () => {} });
      const exclude = await readFile(join(workdir, "bare.git", "info", "exclude"), "utf8");
      expect(exclude.split("\n").filter((line) => line.trim() === ".jumi-tmp/")).toEqual([".jumi-tmp/"]);
      expect(exclude).toContain(".jumi-attachments/");
    });
  });

  test("attach never runs worktree add into a leftover that cannot be removed", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") return "";
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      await mkdir(join(claimed.worktree, ".jumi-tmp"), { recursive: true });
      await chmod(dirname(claimed.worktree), 0o555);
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      try {
        await loop.detachWorktree();
        await expect(removeTree(claimed.worktree)).rejects.toThrow(/EACCES|failed to remove/);
        await expect(
          attachIssueWorktree(loop, { branch: "jumi/issue-12-fix-the-thing", defaultBranch: "main", log: () => {} })
        ).rejects.toThrow(/leftover worktree .* could not be removed/);
        await expect(
          attachPrWorktree(loop, { branch: "jumi/issue-12-fix-the-thing", defaultBranch: "main", log: () => {} })
        ).rejects.toThrow(/leftover worktree .* could not be removed/);
      } finally {
        await chmod(dirname(claimed.worktree), 0o755);
      }
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
    });
  });

  test("PR attach resets hard to origin branch when the worktree exists", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") return "";
        if (gitArgs[0] === "rev-parse") return "headsha";
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      await mkdir(join(claimed.worktree, ".git"), { recursive: true });
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      const attached = await attachPrWorktree(loop, {
        branch: "jumi/issue-12-fix-the-thing",
        defaultBranch: "main",
        log: () => undefined,
      });
      if (isClaimedEarlyResult(attached)) throw new Error("expected attach");
      expect(attached.headSha).toBe("headsha");
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "reset" && args.includes("--hard") && args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
    });
  });
});

describe("sentinel strip, ship, abort, push-fail", () => {
  test("stripSentinels removes .jumi-tmp leftovers", async () => {
    await withDirs(async (_home, workdir) => {
      await mkdir(join(workdir, ".jumi-tmp"), { recursive: true });
      await writeFile(join(workdir, ".jumi-tmp", "session.db"), "db");
      await writeFile(join(workdir, "JUMI_TASK.md"), "task");
      await stripSentinels(workdir, ["JUMI_TASK.md"]);
      await expect(writeFile(join(workdir, ".jumi-tmp", "x"), "x")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("stripSentinels clears a read-only subtree under .jumi-tmp", async () => {
    await withDirs(async (_home, workdir) => {
      const cache = join(workdir, ".jumi-tmp", "mod", "cache");
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, "go.mod"), "module x");
      await chmod(cache, 0o555);
      await chmod(join(workdir, ".jumi-tmp", "mod"), 0o555);
      await stripSentinels(workdir, []);
      await expect(access(join(workdir, ".jumi-tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("stripSentinels does not throw when .jumi-tmp cannot be deleted", async () => {
    await withDirs(async (_home, workdir) => {
      await mkdir(join(workdir, ".jumi-tmp"), { recursive: true });
      await chmod(workdir, 0o555);
      try {
        await stripSentinels(workdir, ["JUMI_PR.md"]);
        await access(join(workdir, ".jumi-tmp"));
      } finally {
        await chmod(workdir, 0o755);
      }
    });
  });

  test("worktreePorcelain ignores .jumi-tmp and commitIfDirty never stages it", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "status") return '?? .jumi-tmp/\n?? ".jumi-tmp/odd name"\n M src/demo.ts\n';
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      const porcelain = await worktreePorcelain(loop);
      expect(porcelain).toBe("M src/demo.ts");
      await commitIfDirty(loop, porcelain, "Implement #12: Fix the thing");
      expect(gitCalls.find((args) => args[0] === "add")).toEqual([
        "add",
        "-A",
        "--",
        ".",
        ":(exclude).jumi-tmp",
        ":(exclude).jumi-attachments",
      ]);
    });
  });

  test("commitIfDirty and pushClaimedBranch never pass --force", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        gitCalls.push(stripGitConfigArgs(args));
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      expect(await worktreePorcelain(loop)).toBe("");
      await commitIfDirty(loop, " M src/demo.ts", "Implement #12: Fix the thing");
      await pushClaimedBranch(loop, "jumi/issue-12-fix-the-thing");
      expect(gitCalls.some((args) => args[0] === "add" && args.includes("-A"))).toBe(true);
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(true);
      expect(gitCalls.find((args) => args[0] === "push")).toEqual([
        "push",
        "-u",
        "origin",
        "jumi/issue-12-fix-the-thing",
      ]);
      expect(gitCalls.some((args) => args.includes("--force"))).toBe(false);
    });
  });

  test("runClaimedLoop returns cancelled and detaches on abort", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        gitCalls.push(stripGitConfigArgs(args));
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      const abort = new AbortController();
      abort.abort();
      const result = await runClaimedLoop(loop, abort.signal, async () => {
        throwIfAborted(abort.signal);
        return { status: "pr" as const, htmlUrl: "nope", prNumber: 1 };
      });
      expect(result).toEqual({ status: "cancelled" });
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(true);
    });
  });

  test("runClaimedLoop skips onFailure for infra but still detaches", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        gitCalls.push(stripGitConfigArgs(args));
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      let onFailure = false;
      await expect(
        runClaimedLoop(
          loop,
          undefined,
          async () => {
            throw new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
          },
          async () => {
            onFailure = true;
          }
        )
      ).rejects.toMatchObject({ infra: true });
      expect(onFailure).toBe(false);
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(true);
    });
  });

  test("runClaimedLoop rethrows the first error when onFailure itself fails", async () => {
    await withDirs(async (home, workdir) => {
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: async () => "",
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      await expect(
        runClaimedLoop(
          loop,
          undefined,
          async () => {
            throw new Error("first failure");
          },
          async () => {
            throw new Error("cleanup failure");
          }
        )
      ).rejects.toThrow("first failure");
    });
  });

  test("inspectMovedPrHead returns the new remote sha", async () => {
    await withDirs(async (home, workdir) => {
      let fetched = false;
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "fetch") fetched = true;
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/jumi/issue-12-fix-the-thing")) {
          return fetched ? "newsha" : "oldsha";
        }
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      expect(await inspectMovedPrHead(loop, "jumi/issue-12-fix-the-thing", "oldsha")).toBe("newsha");
    });
  });

  test("inspectRemoteContainsDefault resets hard and does not force-push", async () => {
    await withDirs(async (home, workdir) => {
      const gitCalls: string[][] = [];
      const git: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        return "";
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        gitRunner: git,
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const loop = openClaimedLoop(claimed, { ...loopAuth, heartbeatIntervalMs: 0 });
      expect(await inspectRemoteContainsDefault(loop, "jumi/issue-12-fix-the-thing", "main")).toBe(true);
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--force"))).toBe(false);
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "reset" && args.includes("--hard") && args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
    });
  });
});
