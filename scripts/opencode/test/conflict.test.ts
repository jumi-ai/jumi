import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, conflictStatePath, readClaim, stuckStatePath, writeClaim } from "../src/claim.ts";
import { CONFLICT_TIMEOUT_MS, implementConflict, readConflictState, writeConflictState } from "../src/conflict.ts";
import { attachmentsTrackedReason, engineScratchTrackedReason } from "../src/engine_scratch.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { QUOTA_MESSAGE, QUOTA_STUCK_TEXT } from "../src/quota.ts";
import { issueJobFromRecord, MemoryReviewJobStore } from "../src/review_jobs.ts";
import { standingPodRuntime } from "../src/runtime.ts";
import { writeStuckState } from "../src/stuck.ts";
import type { GitRunner } from "../src/workspace.ts";
import { emptyCiMethods, makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function jumiPr() {
  const repo = makeRepo();
  return makePR({
    number: 127,
    title: "Fix the thing",
    body: "Fixes #12",
    user: makeUser({ login: "jumi" }),
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    head: {
      label: "kirmanak:jumi/issue-12-fix-the-thing",
      ref: "jumi/issue-12-fix-the-thing",
      sha: "headsha",
      repo,
      repo_id: repo.id,
    },
    base: {
      label: "kirmanak:main",
      ref: "main",
      sha: "basesha",
      repo,
      repo_id: repo.id,
    },
  });
}

function makeApi(
  overrides: Partial<IssueApi> = {}
): IssueApi & { comments: string[]; pulls: unknown[]; commentIndexes: number[] } {
  const comments: string[] = [];
  const pulls: unknown[] = [];
  const commentIndexes: number[] = [];
  const defaults: IssueApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getIssue: async () => makeIssue(),
    getPR: async (_owner, _repo, index) => makePR({ number: index }),
    listOpenPulls: async () => [jumiPr()],
    createPullRequest: async (_owner, _repo, pull) => {
      pulls.push(pull);
      return makePR({ number: 3, title: pull.title, body: pull.body });
    },
    closePullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "closed" }),
    updatePullRequestBody: async (_owner, _repo, index, body) => makePR({ number: index, body }),
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, index, body) => {
      commentIndexes.push(index);
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    ...emptyCiMethods(),
  };
  return { ...defaults, ...overrides, comments, pulls, commentIndexes };
}

async function withDirs(run: (home: string, workdir: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "jumi-cf-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-cf-work-"));
  try {
    await run(home, workdir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

function conflictJob(overrides: Parameters<typeof makeIssueJob>[0] = {}) {
  return makeIssueJob({
    mode: "conflict",
    prNumber: 127,
    action: "push",
    trigger: { event: "push", sender: "alice" },
    ...overrides,
  });
}

function notAncestorGit(extra: GitRunner = async () => ""): GitRunner {
  return async (args, opts) => {
    const gitArgs = stripGitConfigArgs(args);
    if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
      throw new Error("git merge-base --is-ancestor failed with exit code 1");
    }
    if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
    if (gitArgs[0] === "rev-parse") return "headsha";
    return extra(args, opts);
  };
}

function conflictThenResolvedGit(extra: GitRunner = async () => ""): GitRunner {
  let openCodeRan = false;
  return notAncestorGit(async (args, opts) => {
    const gitArgs = stripGitConfigArgs(args);
    if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
    if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
    if (gitArgs[0] === "grep") return openCodeRan ? "" : "src/demo.ts";
    if (gitArgs[0] === "add" && gitArgs.includes("-A")) openCodeRan = true;
    return extra(args, opts);
  });
}

describe("implementConflict", () => {
  test("skips when no open jumi closing PR", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #12", user: makeUser({ login: "alice" }) })],
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          throw new Error("opencode should not run");
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "no open jumi closing PR" });
      expect(api.pulls).toHaveLength(0);
    });
  });

  test("checks out pr.head.ref, not a freshly slugged branch", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        return "";
      });
      await implementConflict({
        api,
        job: conflictJob({ title: "Completely Retitled Issue" }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          throw new Error("opencode should not run");
        },
        logger: () => undefined,
      });
      const slugged = "jumi/issue-12-completely-retitled-issue";
      expect(gitCalls.some((args) => args.includes(slugged))).toBe(false);
      expect(gitCalls.some((args) => args.includes("jumi/issue-12-fix-the-thing"))).toBe(true);
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "add" && args.includes("origin/main"))).toBe(
        false
      );
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "worktree" &&
            args[1] === "add" &&
            args.includes("-B") &&
            args.includes("jumi/issue-12-fix-the-thing") &&
            args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
    });
  });

  test("conflict job queued by a stuck kick runs merge-of-default on a green head", async () => {
    await withDirs(async (home, workdir) => {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(
        makeIssueJob({ delivery: "d-stuck", mode: "follow-up", prNumber: 127, headSha: "headsha" })
      );
      const leased = await store.lease("worker", 60_000, new Date(), ["follow-up"]);
      if (!leased) throw new Error("expected a follow-up lease");
      await store.saveResult(leased.id, "worker", { kind: "skip", reason: "stuck: cannot resolve conflicts" });
      await store.markPublished(leased.id, "worker", { state: "skipped", reason: "stuck: cannot resolve conflicts" });
      await store.setIssueSkipReason("kirmanak", "demo", 12, "stuck: cannot resolve conflicts");
      await store.sits.remember("kirmanak", "demo", 12, "implement-latch");

      const kicked = await store.stuckKick({
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        kick: "stuck",
        actor: "operator",
        idempotencyKey: "kick-conflict-1",
        delivery: "board-kick:test",
      });
      expect(kicked.status).toBe("ok");
      if (kicked.status !== "ok") throw new Error("expected ok");
      expect(kicked.job.kind).toBe("conflict");

      // Green, finding-free head: the conflict job merges default instead of
      // skipping with `no unhandled feedback`.
      const api = makeApi();
      let mergeBase = false;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("--is-ancestor")) mergeBase = true;
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
        if (gitArgs[0] === "rev-parse") return "headsha";
        return "";
      };
      const result = await implementConflict({
        api,
        job: issueJobFromRecord(kicked.job),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          throw new Error("opencode should not run on an up-to-date head");
        },
        logger: () => undefined,
      });
      expect(mergeBase).toBe(true);
      expect(result).not.toEqual({ status: "skipped", reason: "no unhandled feedback" });
      expect(result).toEqual({ status: "up-to-date" });
    });
  });

  test("already up to date → no sticky, round unchanged", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
        if (gitArgs[0] === "rev-parse") return "headsha";
        return "";
      };
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          throw new Error("opencode should not run");
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "up-to-date" });
      expect(api.comments).toEqual([]);
      expect(await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12))).toMatchObject({ round: 0 });
    });
  });

  test("clean merge → no commit, no push, no sticky, no OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      let openCode = 0;
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("MERGE_HEAD")) return "mergehead";
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "up-to-date" });
      expect(openCode).toBe(0);
      expect(api.pulls).toHaveLength(0);
      expect(api.comments).toEqual([]);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(false);
      expect(
        gitCalls.some((args) => args[0] === "merge" && args.includes("--no-ff") && args.includes("origin/main"))
      ).toBe(true);
      expect(gitCalls.some((args) => args[0] === "merge" && args.includes("--abort"))).toBe(true);
      expect(await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12))).toMatchObject({ round: 0 });
    });
  });

  test("git merge --no-ff --no-commit receives committer identity", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      let mergeEnv: Record<string, string | undefined> | undefined;
      const gitRunner: GitRunner = notAncestorGit(async (args, opts) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge" && gitArgs.includes("--no-ff") && gitArgs.includes("--no-commit")) {
          mergeEnv = opts.env;
          if (!opts.env.GIT_COMMITTER_NAME || !opts.env.GIT_COMMITTER_EMAIL) {
            throw new Error("fatal: unable to auto-detect email address (got 'jumi@jumi-worker. (none)')");
          }
        }
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          throw new Error("opencode should not run");
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("up-to-date");
      expect(mergeEnv?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(mergeEnv?.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(mergeEnv?.GIT_COMMITTER_NAME).toBe("jumi");
      expect(mergeEnv?.GIT_COMMITTER_EMAIL).toBe("jumi@kirmanak.stream");
      expect(mergeEnv?.GIT_AUTHOR_NAME).toBe("jumi");
      expect(mergeEnv?.GIT_AUTHOR_EMAIL).toBe("jumi@kirmanak.stream");
    });
  });

  test("Chart.lock conflict → regenerates via helm, does not leave <<<<<<<", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const helmCalls: string[][] = [];
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge") {
          await mkdir(join(workdir, "kirmanak", "demo", "12", "charts", "app"), { recursive: true });
          await writeFile(join(workdir, "kirmanak", "demo", "12", "charts", "app", "Chart.yaml"), "name: app\n");
          throw new Error("git merge failed with exit code 1:\nCONFLICT Chart.lock");
        }
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) {
          const lock = join(workdir, "kirmanak", "demo", "12", "charts", "app", "Chart.lock");
          try {
            await readFile(lock);
            return "";
          } catch {
            return "charts/app/Chart.lock";
          }
        }
        if (gitArgs[0] === "grep") return "";
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        helmRunner: async (args, opts) => {
          helmCalls.push(args);
          expect(opts.cwd).toContain("charts/app");
          await writeFile(join(opts.cwd, "Chart.lock"), "generated: true\n");
          return "";
        },
        openCodeRunner: async () => {
          throw new Error("opencode should not run");
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      expect(helmCalls).toEqual([["dependency", "update"]]);
      expect(api.comments.at(-1)).toContain("Pushed merge of main.");
    });
  });

  test.each([
    ["engine scratch", ".jumi-tmp", ".jumi-tmp/auth.json\0", engineScratchTrackedReason],
    ["attachments", ".jumi-attachments", ".jumi-attachments/note.txt\0", attachmentsTrackedReason],
  ] as const)("does not push when the tip tracks %s", async (_label, dir, listed, reasonFor) => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      let openCode = 0;
      const gitRunner = conflictThenResolvedGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "ls-tree") return gitArgs.includes(dir) ? listed : "";
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      const reason = reasonFor("jumi/issue-12-fix-the-thing");
      expect(openCode).toBe(1);
      expect(result).toEqual({ status: "skipped", reason });
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "ls-tree" && args.includes(dir))).toBe(true);
      expect(api.comments.at(-1)).toContain(reason);
    });
  });

  test.each([
    ["engine scratch", ".jumi-tmp", ".jumi-tmp/auth.json\0", engineScratchTrackedReason],
    ["attachments", ".jumi-attachments", ".jumi-attachments/note.txt\0", attachmentsTrackedReason],
  ] as const)("tip refusal for %s survives a throwing destroy", async (_label, dir, listed, reasonFor) => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const runtime = {
        ...standingPodRuntime,
        destroyRuntimeWorkspace: async () => {
          throw new Error("destroy boom");
        },
      };
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        runtime,
        gitRunner: conflictThenResolvedGit(async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          gitCalls.push(gitArgs);
          if (gitArgs[0] === "ls-tree") return gitArgs.includes(dir) ? listed : "";
          return "";
        }),
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      const reason = reasonFor("jumi/issue-12-fix-the-thing");
      expect(result).toEqual({ status: "skipped", reason });
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
      expect(api.comments.some((body) => body.includes("Jumi failed"))).toBe(false);
      expect(api.comments.at(-1)).toContain(reason);
      expect((await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12))).round).toBe(0);
    });
  });

  test("closes the existing closer and does not push when the issue is closed after OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      let gets = 0;
      const closed: number[] = [];
      const api = makeApi({
        getIssue: async () => {
          gets++;
          return gets >= 3 ? makeIssue({ state: "closed" }) : makeIssue();
        },
        closePullRequest: async (_owner, _repo, index) => {
          closed.push(index);
          return makePR({ number: index, state: "closed" });
        },
      });
      const gitCalls: string[][] = [];
      const gitRunner = conflictThenResolvedGit(async (args) => {
        gitCalls.push(stripGitConfigArgs(args));
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "issue is closed" });
      expect(closed).toEqual([127]);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
      expect(api.comments.at(-1)).toContain("Closing this PR because the issue was closed.");
      expect(api.commentIndexes.at(-1)).toBe(127);
    });
  });

  test("continue OpenCode uses a no-push follow-up prompt instead of implement", async () => {
    await withDirs(async (home, workdir) => {
      let gets = 0;
      const kinds: string[] = [];
      const api = makeApi({
        getIssue: async () => {
          gets++;
          if (gets >= 3) return makeIssue({ title: "Rewritten title", body: "Do this instead." });
          return makeIssue();
        },
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: conflictThenResolvedGit(),
        openCodeRunner: async (opts) => {
          kinds.push(opts.trace?.kind ?? "");
          expect("prompt" in opts).toBe(false);
          expect(opts.continueSession).toBe(kinds.length === 2 ? true : undefined);
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      expect(kinds).toEqual(["conflict", "follow-up"]);
    });
  });

  test("removes JUMI_PR.md before porcelain after continue", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      let gets = 0;
      let openCode = 0;
      let statusSawPrFile = false;
      const api = makeApi({
        getIssue: async () => {
          gets++;
          if (gets >= 3) return makeIssue({ title: "Rewritten title", body: "Do this instead." });
          return makeIssue();
        },
      });
      const gitRunner = conflictThenResolvedGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "status") {
          try {
            await access(join(worktree, "JUMI_PR.md"));
            statusSawPrFile = true;
            return "?? JUMI_PR.md";
          } catch {
            return " M src/demo.ts";
          }
        }
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          openCode++;
          await mkdir(worktree, { recursive: true });
          if (openCode === 2) await writeFile(join(worktree, "JUMI_PR.md"), "Should not land.");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      expect(openCode).toBe(2);
      expect(statusSawPrFile).toBe(false);
      await expect(access(join(worktree, "JUMI_PR.md"))).rejects.toThrow();
    });
  });

  test("stages before unmerged check so resolved markers are not stuck", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      let openCodeRan = false;
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return openCodeRan ? "" : "src/demo.ts";
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          openCodeRan = true;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      expect(openCodeRan).toBe(true);
      const addIndex = gitCalls.findIndex((args) => args[0] === "add" && args.includes("-A"));
      const postOpenCodeGrep = gitCalls.findIndex(
        (args, index) => index > addIndex && args[0] === "grep" && args.includes("^<<<<<<<")
      );
      expect(addIndex).toBeGreaterThanOrEqual(0);
      expect(postOpenCodeGrep).toBeGreaterThan(addIndex);
      expect(api.comments.at(-1)).toContain("Pushed merge of main.");
    });
  });

  test("remaining markers → writes JUMI_CONFLICT.md, runs conflict engine, timeout 3600000", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      let kind: string | undefined;
      let timeoutMs: number | undefined;
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge") {
          throw new Error("git merge failed with exit code 1");
        }
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return "src/demo.ts";
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          kind = opts.trace?.kind;
          timeoutMs = opts.timeoutMs;
          expect("prompt" in opts).toBe(false);
          const conflict = await readFile(join(workdir, "kirmanak/demo/12/JUMI_CONFLICT.md"), "utf8");
          expect(conflict).toContain("pulls/127");
          expect(conflict).toContain("jumi/issue-12-fix-the-thing");
          expect(conflict).toContain("src/demo.ts");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(kind).toBe("conflict");
      expect(timeoutMs).toBe(CONFLICT_TIMEOUT_MS);
      expect(timeoutMs).toBe(3_600_000);
      expect(result).toEqual({ status: "stuck" });
      expect(api.comments.at(-1)).toContain("stuck: cannot resolve conflicts");
    });
  });

  test("resolver quota stuck → quota diary carries the resolver's stamp", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: conflictThenResolvedGit(),
        openCodeRunner: async () => ({ status: "stuck", message: QUOTA_MESSAGE, quota: "hard" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "stuck" });
      expect(api.comments.at(-1)).toContain(QUOTA_STUCK_TEXT);
      expect(api.comments.at(-1)).toContain("_Jumi · opencode · openai/gpt-5.5_");
    });
  });

  test("configured timeoutMs is passed to OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      let timeoutMs: number | undefined;
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge") {
          throw new Error("git merge failed with exit code 1");
        }
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return "src/demo.ts";
        return "";
      });
      await implementConflict({
        api: makeApi(),
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        timeoutMs: 1_800_000,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          timeoutMs = opts.timeoutMs;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(timeoutMs).toBe(1_800_000);
    });
  });

  test.each([
    ["clean", ""],
    ["with a .jumi-tmp leftover", "?? .jumi-tmp/\n"],
  ])("child already committed merge (%s) → parent does not fail / does not poison SHA skip", async (_label, status) => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      let openCodeRan = false;
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          if (openCodeRan) return "";
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return openCodeRan ? "" : "src/demo.ts";
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("MERGE_HEAD")) {
          if (openCodeRan) throw new Error("fatal: Needed a single revision");
          return "mergehead";
        }
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
        if (gitArgs[0] === "rev-parse") return "headsha";
        if (gitArgs[0] === "status") return status;
        if (gitArgs[0] === "commit") throw new Error("nothing to commit, working tree clean");
        return "";
      };
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          openCodeRan = true;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({
        status: "pushed",
        prNumber: 127,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
      });
      expect(api.comments.some((body) => body.includes("Jumi failed"))).toBe(false);
      expect(api.comments.at(-1)).toContain("Pushed merge of main.");
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--force"))).toBe(false);
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(false);
      const state = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(state.lastHeadSha).toBe("headsha");
      expect(state.lastBaseSha).toBe("basesha");
      expect(state.round).toBe(1);
    });
  });

  test("child extraEnv has GIT_AUTH_TOKEN and not GITEA_BOT_TOKEN", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      let extraEnv: Record<string, string> | undefined;
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return extraEnv ? "" : "src/demo.ts";
        return "";
      });
      await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          extraEnv = opts.extraEnv;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(extraEnv?.GIT_AUTH_TOKEN).toBe("bot-token");
      expect(extraEnv?.GITEA_BOT_TOKEN).toBeUndefined();
      expect(extraEnv?.JAVA_HOME).toBe(process.env.JAVA_HOME || "/opt/java/openjdk");
      expect(extraEnv?.GRADLE_USER_HOME).toBe(join(process.env.WORKDIR || "/work", ".gradle"));
      expect(extraEnv?.GRADLE_OPTS).toBe("-Dorg.gradle.daemon=false");
      expect(extraEnv?.JAVA_TOOL_OPTIONS).toBe(`-Djava.io.tmpdir=${join(workdir, "kirmanak/demo/12/.jumi-tmp")}`);
    });
  });

  test("configured maxConflictRounds cap sticks (round 5 of 5 stuck, round 3 of 5 runs)", async () => {
    await withDirs(async (home, workdir) => {
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 5,
        lastHeadSha: "abc",
        lastBaseSha: "def",
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi();
      let openCode = 0;
      const stuck = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        maxConflictRounds: 5,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(stuck).toEqual({ status: "stuck" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: cannot resolve conflicts");
    });

    await withDirs(async (home, workdir) => {
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "oldhead",
        lastBaseSha: "oldbase",
        updatedAt: "2026-05-23T00:00:00Z",
      });
      let openCode = 0;
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return openCode > 0 ? "" : "src/demo.ts";
        return "";
      });
      const result = await implementConflict({
        api: makeApi(),
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        maxConflictRounds: 5,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).not.toBe("stuck");
      expect(openCode).toBe(1);
    });
  });

  test("max 3 OpenCode/conflict rounds → stuck sticky, no OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "abc",
        lastBaseSha: "def",
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi();
      let openCode = 0;
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "stuck" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: cannot resolve conflicts");
    });
  });

  test("same error 3× → stuck sticky, no OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const hash = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      await writeStuckState(stuckStatePath(home, "kirmanak", "demo", 12), {
        fingerprints: [
          { kind: "error", hash },
          { kind: "error", hash },
          { kind: "error", hash },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi();
      let openCode = 0;
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "stuck" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: repeated error");
    });
  });

  test("same {headSha, baseSha} after stuck → skip", async () => {
    await withDirs(async (home, workdir) => {
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "headsha",
        lastBaseSha: "basesha",
        updatedAt: "2026-05-23T00:00:00Z",
      });
      let openCode = 0;
      const result = await implementConflict({
        api: makeApi(),
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
          if (gitArgs[0] === "rev-parse") return "headsha";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "same head and base already attempted" });
      expect(openCode).toBe(0);
    });
  });

  test("push rejected + remote already contains default → reset to origin, no force-push", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = conflictThenResolvedGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "push") throw new Error("non-fast-forward");
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "remote already contains default" });
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--force"))).toBe(false);
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "reset" && args.includes("--hard") && args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
      expect(api.comments.some((body) => body.includes("Jumi failed"))).toBe(false);
    });
  });

  test("abort after push does not open a PR", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const abort = new AbortController();
      const gitRunner: GitRunner = conflictThenResolvedGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "push") abort.abort();
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        abortSignal: abort.signal,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "cancelled" });
      expect(api.pulls).toHaveLength(0);
    });
  });

  test("clone/fetch/push failure does not write lastHeadSha/lastBaseSha skip", async () => {
    const cases: Array<{ kind: "clone" | "fetch" | "push"; prepare?: (workdir: string) => Promise<void> }> = [
      { kind: "clone" },
      {
        kind: "fetch",
        prepare: async (workdir) => {
          await mkdir(join(workdir, "_cache", "kirmanak", "demo.git"), { recursive: true });
        },
      },
      { kind: "push" },
    ];
    for (const { kind, prepare } of cases) {
      await withDirs(async (home, workdir) => {
        await prepare?.(workdir);
        const api = makeApi();
        const gitRunner: GitRunner =
          kind === "push"
            ? conflictThenResolvedGit(async (args) => {
                const gitArgs = stripGitConfigArgs(args);
                if (gitArgs[0] === "push") throw new Error("non-fast-forward");
                if (gitArgs[0] === "merge-base") throw new Error("not ancestor");
                return "";
              })
            : async (args) => {
                const gitArgs = stripGitConfigArgs(args);
                if (kind === "clone" && gitArgs[0] === "clone") throw new Error("clone failed");
                if (kind === "fetch" && gitArgs[0] === "fetch") throw new Error("fetch failed");
                throw new Error(`unexpected git ${gitArgs.join(" ")}`);
              };
        await expect(
          implementConflict({
            api,
            job: conflictJob(),
            giteaUrl: "https://gitea.kirmanak.stream",
            giteaToken: "bot-token",
            botUsername: "jumi",
            model: "openai/gpt-5.5",
            home,
            workdir,
            heartbeatIntervalMs: 0,
            gitRunner,
            openCodeRunner: async () => ({ status: "ok" }),
            logger: () => undefined,
          })
        ).rejects.toThrow();
        expect(await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12))).toMatchObject({ round: 0 });
        expect(api.comments.at(-1)).toContain("Jumi failed:");
        expect(await readClaim(claimFilePath(home, "kirmanak", "demo", 12))).toBeUndefined();
      });
    }
  });

  test("mergeDefaultIntoWorktree throw records SHA/round", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return "src/demo.ts";
        return "";
      });
      await expect(
        implementConflict({
          api,
          job: conflictJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          openCodeRunner: async () => {
            throw new Error("opencode crashed");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("opencode crashed");
      const state = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(state.lastHeadSha).toBe("headsha");
      expect(state.lastBaseSha).toBe("basesha");
      expect(state.round).toBe(1);
      expect(api.comments.at(-1)).toContain("Jumi failed:");
      expect(api.comments.at(-1)).toContain("_Jumi · opencode · openai/gpt-5.5_");
      expect(await readClaim(claimFilePath(home, "kirmanak", "demo", 12))).toBeUndefined();
    });
  });

  test("helm regen failure does not send Chart.lock to OpenCode; stuck/fail instead", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      let openCode = 0;
      const gitRunner: GitRunner = notAncestorGit(async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge") {
          await mkdir(join(workdir, "kirmanak", "demo", "12", "charts", "app"), { recursive: true });
          await writeFile(join(workdir, "kirmanak", "demo", "12", "charts", "app", "Chart.yaml"), "name: app\n");
          throw new Error("git merge failed with exit code 1:\nCONFLICT Chart.lock");
        }
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "charts/app/Chart.lock";
        if (gitArgs[0] === "grep") return "charts/app/Chart.lock";
        return "";
      });
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        helmRunner: async () => {
          throw new Error("helm dependency update failed");
        },
        openCodeRunner: async () => {
          openCode++;
          throw new Error("opencode should not run");
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "stuck" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: cannot resolve conflicts");
      expect(api.comments.some((body) => body.includes("JUMI_CONFLICT") || body.includes("<<<<<<<"))).toBe(false);
    });
  });

  test("terminal first-run claim does not block conflict", async () => {
    await withDirs(async (home, workdir) => {
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
        terminal: true,
      });
      const api = makeApi();
      const result = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: notAncestorGit(),
        openCodeRunner: async () => {
          throw new Error("opencode should not run");
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("up-to-date");
      expect(await readClaim(claimFilePath(home, "kirmanak", "demo", 12))).toBeUndefined();
    });
  });
});
