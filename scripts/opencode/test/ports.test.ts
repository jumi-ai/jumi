import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GiteaAPI } from "../src/api.ts";
import type { Engine, EngineRunOptions } from "../src/engine.ts";
import { EngineFailedError, resolveEngine, throwIfEngineFailed } from "../src/engine.ts";
import type { Forge, Tracker } from "../src/forge.ts";
import {
  createForge,
  createGiteaForge,
  createGithubForge,
  FORGE_COMMITTER_EMAIL,
  FORGE_COMMITTER_NAME,
} from "../src/forge.ts";
import { openCodeEngine, runOpenCode } from "../src/git.ts";
import { workerMarker } from "../src/gitea_issues.ts";
import { GithubAPI } from "../src/github_api.ts";
import { implementIssue } from "../src/implement.ts";
import { forgeRefOf, trackerRefOf } from "../src/ports.ts";
import { reviewPullRequest } from "../src/review.ts";
import type { GitRunner } from "../src/workspace.ts";
import {
  emptyCiMethods,
  makeBranch,
  makeComment,
  makeFile,
  makeIssue,
  makeIssueJob,
  makePR,
  makeRepo,
} from "./fixtures.ts";

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function makeFakeForge(overrides: Partial<Tracker & Forge> = {}): (Tracker & Forge) & {
  comments: string[];
  reviews: unknown[];
  pulls: Array<{ title: string; body: string; head: string; base: string }>;
  statuses: Array<{ sha: string; state: string; context?: string; description?: string }>;
} {
  const comments: string[] = [];
  const reviews: unknown[] = [];
  const pulls: Array<{ title: string; body: string; head: string; base: string }> = [];
  const statuses: Array<{ sha: string; state: string; context?: string; description?: string }> = [];
  const defaults: Tracker & Forge = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => {
      pulls.push(pull);
      return makePR({
        number: 3,
        title: pull.title,
        body: pull.body,
        html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/3",
      });
    },
    closePullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "closed" }),
    reopenPullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "open" }),
    updatePullRequestBody: async (_owner, _repo, index, body) => makePR({ number: index, body }),
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => {
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
    createPullReview: async (_owner, _repo, _index, review) => {
      reviews.push(review);
      return { id: reviews.length };
    },
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    createCommitStatus: async (_owner, _repo, sha, status) => {
      statuses.push({ sha, state: status.state, context: status.context, description: status.description });
      return status;
    },
  };
  return { ...defaults, ...overrides, comments, reviews, pulls, statuses };
}

async function withDirs(run: (home: string, workdir: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "jumi-ports-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-ports-work-"));
  try {
    await run(home, workdir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("Engine, Tracker, and Forge ports", () => {
  test("OpenCode is the Engine impl and Gitea is Tracker+Forge impl #0", () => {
    expect(openCodeEngine).toBe(runOpenCode);
    const host = createGiteaForge("https://gitea.example.test", "token-1");
    expect(host).toBeInstanceOf(GiteaAPI);
    expect(createForge({ giteaUrl: "https://gitea.example.test", giteaToken: "token-1" })).toBeInstanceOf(GiteaAPI);
    expect(
      createForge({ forge: "gitea", giteaUrl: "https://gitea.example.test", giteaToken: "token-1" })
    ).toBeInstanceOf(GiteaAPI);
    expect(() => createForge({ forge: "github", giteaUrl: "https://github.com", giteaToken: "" })).toThrow(
      "GitHub credentials are missing"
    );
    const github: Tracker & Forge = createGithubForge({ token: "token-1" });
    expect(github).toBeInstanceOf(GithubAPI);
    expect(createForge({ forge: "github", giteaUrl: "https://github.com", giteaToken: "token-1" })).toBeInstanceOf(
      GithubAPI
    );
    expect(FORGE_COMMITTER_NAME).toBe("jumi");
    expect(FORGE_COMMITTER_EMAIL).toBe("jumi@kirmanak.stream");
  });

  test("Tracker and Forge are separate method bags", () => {
    const tracker: Tracker = {
      getIssue: async () => makeIssue(),
      listIssueComments: async () => [],
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
      updateIssueComment: async (_owner, _repo, _id, body) => makeComment({ body }),
      listIssueDependencies: async () => [],
      listIssueBlocks: async () => [],
      listRepoIssues: async () => [],
      createIssueDependency: async () => undefined,
    };
    const forge: Forge = {
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      getPR: async () => makePR(),
      getPRFiles: async () => [makeFile()],
      listOpenPulls: async () => [],
      createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
      closePullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "closed" }),
      reopenPullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "open" }),
      updatePullRequestBody: async (_owner, _repo, index, body) => makePR({ number: index, body }),
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
      updateIssueComment: async (_owner, _repo, _id, body) => makeComment({ body }),
      listIssueComments: async () => [],
      listPullReviewComments: async () => [],
      listPullReviews: async () => [],
      createPullReview: async () => ({ id: 1 }),
      submitPullReview: async () => ({ id: 1 }),
      resolvePullComment: async () => undefined,
      unresolvePullComment: async () => undefined,
      dismissPullReview: async () => ({ id: 1 }),
      ...emptyCiMethods(),
      createCommitStatus: async (_owner, _repo, _sha, status) => status,
    };
    expect(Object.keys(tracker).sort()).toEqual([
      "createIssueComment",
      "createIssueDependency",
      "findStickyIssueComment",
      "getIssue",
      "listIssueBlocks",
      "listIssueComments",
      "listIssueDependencies",
      "listRepoIssues",
      "updateIssueComment",
    ]);
    expect("getPR" in tracker).toBe(false);
    expect("getIssue" in forge).toBe(false);
    expect("createPullRequest" in forge).toBe(true);
    expect("createCommitStatus" in forge).toBe(true);
    expect(trackerRefOf(makeIssue({ number: 12 }))).toBe("12");
    expect(forgeRefOf(makePR({ number: 7 }))).toBe("7");
  });

  test("resolveEngine prefers engine over openCodeRunner", () => {
    const engine: Engine = async () => ({ status: "ok", stdout: "engine" });
    const openCodeRunner: Engine = async () => ({ status: "ok", stdout: "opencode" });
    const fallback: Engine = async () => ({ status: "ok", stdout: "fallback" });
    expect(resolveEngine({ engine, openCodeRunner }, fallback)).toBe(engine);
    expect(resolveEngine({ openCodeRunner }, fallback)).toBe(openCodeRunner);
    expect(resolveEngine({}, fallback)).toBe(fallback);
  });

  test("throwIfEngineFailed fail-closes timeout, exit, and stuck", () => {
    throwIfEngineFailed({ status: "ok" });
    expect(() => throwIfEngineFailed({ status: "timeout", message: "opencode timed out" })).toThrow(
      "opencode timed out"
    );
    expect(() => throwIfEngineFailed({ status: "exit", exitCode: 7, message: "opencode exited with code 7" })).toThrow(
      "opencode exited with code 7"
    );
    expect(() => throwIfEngineFailed({ status: "stuck" })).toThrow("engine stuck");
  });

  test("throwIfEngineFailed copies result.runner onto the error", () => {
    const runner = { type: "claude", model: "opus", effort: "high" };
    try {
      throwIfEngineFailed({ status: "exit", message: "boom", runner });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineFailedError);
      expect((err as EngineFailedError).runner).toEqual(runner);
    }
  });

  test("throwIfEngineFailed copies result.chainIndex onto the error", () => {
    try {
      throwIfEngineFailed({
        status: "stuck",
        message: "stuck",
        runner: { type: "opencode", model: "opencode/muse-spark" },
        chainIndex: 0,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineFailedError);
      expect((err as EngineFailedError).chainIndex).toBe(0);
    }
  });

  test("throwIfEngineFailed copies result.hopRefused onto the error", () => {
    try {
      throwIfEngineFailed({ status: "stuck", message: "stuck: usage limit exceeded", hopRefused: true });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineFailedError);
      expect((err as EngineFailedError).hopRefused).toBe(true);
    }
  });

  test("implement produces a PR via the parent with a fake engine and fake forge", async () => {
    await withDirs(async (home, workdir) => {
      const forge = makeFakeForge();
      const worktree = join(workdir, "kirmanak/demo/12");
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      let engineOpts: EngineRunOptions | undefined;
      const engine: Engine = async (opts) => {
        engineOpts = opts;
        const task = await readFile(join(worktree, "JUMI_TASK.md"), "utf8");
        expect(task).toContain("Fix the thing");
        await mkdir(worktree, { recursive: true });
        await writeFile(join(worktree, "JUMI_PR.md"), "Caches categories.");
        return { status: "ok" };
      };

      const result = await implementIssue({
        api: forge,
        engine,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        logger: () => undefined,
      });

      expect(result).toEqual({
        status: "pr",
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/3",
        prNumber: 3,
      });
      expect(forge.pulls).toEqual([
        {
          title: "Fix the thing",
          body: "<!-- jumi-pr-body:start -->\nCaches categories.\n\nFixes #12\n\n_Jumi · opencode · openai/gpt-5.5_\n<!-- jumi-pr-body:end -->",
          head: "jumi/issue-12-fix-the-thing",
          base: "main",
        },
      ]);
      expect(forge.comments.at(-1)).toContain("Opened https://gitea.kirmanak.stream/kirmanak/demo/pulls/3");
      expect(forge.comments.at(-1)).toContain(workerMarker("kirmanak", "demo", 12));
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--force"))).toBe(false);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(true);
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(true);
      expect(engineOpts?.sanitizeEnv).toBe(true);
      expect("prompt" in (engineOpts ?? {})).toBe(false);
      expect("configPath" in (engineOpts ?? {})).toBe(false);
      expect(engineOpts?.extraEnv?.GITEA_BOT_TOKEN).toBeUndefined();
      expect(engineOpts?.extraEnv?.GIT_AUTH_TOKEN).toBe("bot-token");
      expect(engineOpts?.extraEnv?.GIT_COMMITTER_EMAIL).toBe(FORGE_COMMITTER_EMAIL);
    });
  });

  test("review publishes pull-review writeup+trailer+status from the artifact, not engine stdout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-ports-review-"));
    try {
      const sha = "d90b7289701097dae3ffa3dc0ccdc348be552697";
      const forge = makeFakeForge({
        getPR: async () => makePR({ head: makeBranch({ sha }) }),
      });
      const gitRunner: GitRunner = async (args) => {
        if (args[0] === "rev-parse") return sha;
        if (args[0] === "status") return "?? JUMI_REVIEW.md";
        if (args[0] === "ls-files") return "";
        if (args[0] === "checkout") return "";
        throw new Error(`unexpected git ${args.join(" ")}`);
      };
      const engine: Engine = async (opts) => {
        expect("prompt" in opts).toBe(false);
        expect("configPath" in opts).toBe(false);
        const task = await readFile(join(workspace, "JUMI_TASK.md"), "utf8");
        expect(task).toContain("Write JUMI_REVIEW.md");
        await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
        return { status: "ok" };
      };

      const result = await reviewPullRequest({
        api: forge,
        engine,
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        expectedHeadSha: sha,
        model: "openai/gpt-5.5",
        workspace,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        gitRunner,
        logger: () => undefined,
      });

      expect(result.status).toBe("posted");
      expect(forge.comments).toHaveLength(0);
      expect(forge.reviews).toHaveLength(1);
      expect((forge.reviews[0] as { body: string }).body).toContain("<!-- jumi-review:kirmanak/demo#7 -->");
      expect((forge.reviews[0] as { body: string }).body).toContain("<!-- jumi-check: success -->");
      expect((forge.reviews[0] as { body: string }).body).not.toContain("I'll inspect");
      expect(lastNonEmptyLine((forge.reviews[0] as { body: string }).body)).toBe("<!-- jumi-check: success -->");
      expect(forge.statuses.map((status) => ({ state: status.state, context: status.context }))).toEqual([
        { state: "pending", context: "jumi/opencode-review" },
        { state: "success", context: "jumi/opencode-review" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("implement fail-closes on engine timeout and does not open a PR", async () => {
    await withDirs(async (home, workdir) => {
      const forge = makeFakeForge();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await expect(
        implementIssue({
          api: forge,
          engine: async () => ({ status: "timeout", message: "opencode exited with code 143" }),
          job: makeIssueJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          logger: () => undefined,
        })
      ).rejects.toThrow("opencode exited with code 143");
      expect(forge.pulls).toHaveLength(0);
      expect(forge.comments.at(-1)).toContain("Jumi failed: opencode exited with code 143");
    });
  });

  test("review fail-closes on engine exit and does not treat stdout as success", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-ports-review-exit-"));
    try {
      const sha = "d90b7289701097dae3ffa3dc0ccdc348be552697";
      const forge = makeFakeForge({
        getPR: async () => makePR({ head: makeBranch({ sha }) }),
      });
      await expect(
        reviewPullRequest({
          api: forge,
          engine: async () => ({
            status: "exit",
            exitCode: 7,
            stdout: "Looks good\n<!-- jumi-check: success -->",
            message: "opencode exited with code 7",
          }),
          owner: "kirmanak",
          repo: "demo",
          prNumber: 7,
          expectedHeadSha: sha,
          model: "openai/gpt-5.5",
          workspace,
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          workspacePreparer: async () => undefined,
          gitRunner: async () => {
            throw new Error("git should not run after engine exit");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("opencode exited with code 7");
      expect(forge.comments).toHaveLength(0);
      expect(forge.statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(forge.statuses.at(-1)?.description).toContain("opencode exited with code 7");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
