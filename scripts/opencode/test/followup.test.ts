import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCiState } from "../src/ci.ts";
import {
  ciStatePath,
  claimFilePath,
  conflictStatePath,
  followUpStatePath,
  readClaim,
  stuckStatePath,
} from "../src/claim.ts";
import { readConflictState, writeConflictState } from "../src/conflict.ts";
import { EngineFailedError } from "../src/engine.ts";
import {
  buildFeedbackMarkdown,
  CI_PENDING_RETRY_MS,
  collectFollowUpItems,
  FEEDBACK_MAX_BYTES,
  FOLLOWUP_TIMEOUT_MS,
  type FollowUpItems,
  implementFollowUp,
  needsFollowUp,
  parsePrHeadChangedReason,
  pickLatestJumiFinding,
  pickLatestJumiReview,
  readFollowUpState,
  writeFollowUpState,
} from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { PR_BODY_FENCE_END, PR_BODY_FENCE_START } from "../src/implement.ts";
import { fingerprintFollowUpText, writeStuckState } from "../src/stuck.ts";
import type { GiteaPullReview } from "../src/types.ts";
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
  });
}

function jumiReviewSticky(opts: { id?: number; sha?: string; finding?: string; createdAt?: string } = {}) {
  const sha = opts.sha ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return makeComment({
    id: opts.id ?? 38022,
    body: [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi review",
      "",
      `Reviewed commit: \`${sha}\``,
      "",
      opts.finding ?? "🟡 risk: guard the null deref in `connectToServer`",
      "<!-- jumi-check: failure -->",
    ].join("\n"),
    user: makeUser({ login: "jumi" }),
    created_at: opts.createdAt ?? "2026-09-11T00:00:00Z",
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
    listIssueComments: async () => [
      makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
    ],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    ...emptyCiMethods(),
  };
  return { ...defaults, ...overrides, comments, pulls, commentIndexes };
}

async function withDirs(run: (home: string, workdir: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "jumi-fu-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-fu-work-"));
  try {
    await run(home, workdir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

function followUpJob(overrides: Parameters<typeof makeIssueJob>[0] = {}) {
  return makeIssueJob({
    mode: "follow-up",
    prNumber: 127,
    trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
    ...overrides,
  });
}

function makeReview(overrides: Partial<GiteaPullReview> = {}): GiteaPullReview {
  return {
    id: 9,
    body: "please change this",
    user: makeUser({ login: "alice" }),
    state: "REQUEST_CHANGES",
    ...overrides,
  };
}

describe("implementFollowUp", () => {
  test("skips when no open jumi closing PR", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #12", user: makeUser({ login: "alice" }) })],
      });
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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

  test("continues on the current head and keeps the original review-failure sticky", async () => {
    await withDirs(async (home, workdir) => {
      const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const pr = jumiPr();
      const api = makeApi({
        listOpenPulls: async () => [pr],
        listIssueComments: async () => [
          makeComment({
            id: 38022,
            body: [
              "<!-- jumi-review:kirmanak/demo#127 -->",
              "### Jumi review",
              "",
              `Reviewed commit: \`${oldSha}\``,
              "",
              "please fix the tests",
              "<!-- jumi-check: failure -->",
            ].join("\n"),
            user: makeUser({ login: "jumi" }),
          }),
        ],
      });
      let feedback = "";
      const result = await implementFollowUp({
        api,
        job: followUpJob({
          headSha: oldSha,
          trigger: { event: "review-failure", sender: "jumi" },
        }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return " M src/demo.ts";
          return "";
        },
        openCodeRunner: async () => {
          feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      expect(feedback).toContain("please fix the tests");
      expect(feedback).toContain(oldSha);
    });
  });

  describe("PR body refresh", () => {
    const fenced = (text: string) => `${PR_BODY_FENCE_START}\n${text}\n${PR_BODY_FENCE_END}`;
    const posted = `Human note above.\n\n${fenced("Old writeup.\n\nFixes #12\n\n_Jumi · opencode · openai/gpt-5.5_")}\n\nHuman note below.`;

    async function runFollowUp(opts: {
      body: string;
      porcelain?: string;
      writePr?: (current: string | null) => string | null;
      updateBody?: IssueApi["updatePullRequestBody"];
    }) {
      const patches: string[] = [];
      let seeded: string | null = null;
      let statusSawPrFile = false;
      let result: Awaited<ReturnType<typeof implementFollowUp>> | undefined;
      await withDirs(async (home, workdir) => {
        const worktree = join(workdir, "kirmanak/demo/12");
        const pr = { ...jumiPr(), body: opts.body };
        const api = makeApi({
          listOpenPulls: async () => [pr],
          getPR: async () => pr,
          updatePullRequestBody:
            opts.updateBody ??
            (async (_owner, _repo, index, body) => {
              patches.push(body);
              return makePR({ number: index, body });
            }),
        });
        result = await implementFollowUp({
          api,
          job: followUpJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner: async (args) => {
            const gitArgs = stripGitConfigArgs(args);
            if (gitArgs[0] === "rev-parse") return "abc123";
            if (gitArgs[0] === "status") {
              if (await Bun.file(join(worktree, "JUMI_PR.md")).exists()) statusSawPrFile = true;
              return opts.porcelain ?? " M src/demo.ts";
            }
            return "";
          },
          openCodeRunner: async () => {
            const path = join(worktree, "JUMI_PR.md");
            seeded = (await Bun.file(path).exists()) ? await readFile(path, "utf8") : null;
            const next = opts.writePr?.(seeded);
            if (next != null) await writeFile(path, next);
            else if (opts.writePr) await rm(path, { force: true });
            return { status: "ok" };
          },
          logger: () => undefined,
        });
      });
      return { result, patches, seeded: seeded as string | null, statusSawPrFile };
    }

    test("seeds the posted region and replaces only the fence after a push", async () => {
      const run = await runFollowUp({ body: posted, writePr: () => "New writeup with lifecycle." });
      expect(run.result?.status).toBe("pushed");
      expect(run.seeded).toBe("Old writeup.\n\nFixes #12\n");
      expect(run.statusSawPrFile).toBe(false);
      expect(run.patches).toEqual([
        `Human note above.\n\n${fenced("New writeup with lifecycle.\n\nFixes #12\n\n_Jumi · opencode · openai/gpt-5.5_")}\n\nHuman note below.`,
      ]);
    });

    test("does not touch an unfenced body", async () => {
      const run = await runFollowUp({ body: "Fixes #12", writePr: () => "Should not land." });
      expect(run.result?.status).toBe("pushed");
      expect(run.seeded).toBeNull();
      expect(run.statusSawPrFile).toBe(false);
      expect(run.patches).toEqual([]);
    });

    test("leaves the posted body when JUMI_PR.md is removed or empty", async () => {
      expect((await runFollowUp({ body: posted, writePr: () => null })).patches).toEqual([]);
      expect((await runFollowUp({ body: posted, writePr: () => "  \n" })).patches).toEqual([]);
    });

    test("does not refresh when the follow-up has no changes", async () => {
      const run = await runFollowUp({ body: posted, porcelain: "", writePr: () => "New writeup." });
      expect(run.result?.status).toBe("no-changes");
      expect(run.patches).toEqual([]);
    });

    test("a failed body PATCH does not fail the pushed fix", async () => {
      const run = await runFollowUp({
        body: posted,
        writePr: () => "New writeup.",
        updateBody: async () => {
          throw new Error("gitea 500");
        },
      });
      expect(run.result?.status).toBe("pushed");
    });
  });

  test("rejected push because the remote moved skips without burning a follow-up round", async () => {
    await withDirs(async (home, workdir) => {
      let committed = false;
      let fetched = false;
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob({ headSha: "oldsha" }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "commit") committed = true;
          if (gitArgs[0] === "fetch") fetched = true;
          if (gitArgs[0] === "push") throw new Error("non-fast-forward");
          if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/jumi/issue-12-fix-the-thing")) {
            return fetched ? "newsha" : "oldsha";
          }
          if (gitArgs[0] === "rev-parse") return committed ? "localsha" : "oldsha";
          if (gitArgs[0] === "status") return " M src/demo.ts";
          return "";
        },
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "PR head changed from oldsha to newsha" });
      expect(parsePrHeadChangedReason("PR head changed from oldsha to newsha")).toEqual({
        from: "oldsha",
        to: "newsha",
      });
      expect(await readFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12))).toMatchObject({ round: 0 });
    });
  });

  test("failed push when the remote did not move rethrows instead of skipping", async () => {
    await withDirs(async (home, workdir) => {
      let committed = false;
      await expect(
        implementFollowUp({
          api: makeApi(),
          job: followUpJob({ headSha: "oldsha" }),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner: async (args) => {
            const gitArgs = stripGitConfigArgs(args);
            if (gitArgs[0] === "commit") committed = true;
            if (gitArgs[0] === "push") throw new Error("authentication failed");
            if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/jumi/issue-12-fix-the-thing")) return "oldsha";
            if (gitArgs[0] === "rev-parse") return committed ? "localsha" : "oldsha";
            if (gitArgs[0] === "status") return " M src/demo.ts";
            return "";
          },
          openCodeRunner: async () => ({ status: "ok" }),
          logger: () => undefined,
        })
      ).rejects.toThrow("authentication failed");
    });
  });

  test("follows up on an assigned foreign PR head ref", async () => {
    await withDirs(async (home, workdir) => {
      const repo = makeRepo();
      const foreign = makePR({
        number: 50,
        title: "chore(deps)",
        body: "",
        user: makeUser({ login: "renovate" }),
        html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
        head: {
          label: "kirmanak:renovate/all-digest",
          ref: "renovate/all-digest",
          sha: "headsha",
          repo,
          repo_id: repo.id,
        },
      });
      const api = makeApi({
        getIssue: async () =>
          makeIssue({
            number: 50,
            title: "chore(deps)",
            body: "",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
            user: makeUser({ login: "renovate" }),
            pull_request: { merged_at: null },
          }),
        listOpenPulls: async () => [foreign],
      });
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementFollowUp({
        api,
        job: followUpJob({
          issueNumber: 50,
          prNumber: 50,
          title: "chore(deps)",
          body: "",
          htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
        }),
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
      expect(gitCalls.some((args) => args.includes("renovate/all-digest"))).toBe(true);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(true);
      expect(api.pulls).toHaveLength(0);
    });
  });

  test("checks out pr.head.ref, not a freshly slugged branch from a retitled issue", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementFollowUp({
        api,
        job: followUpJob({ title: "Completely Retitled Issue" }),
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
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "worktree" &&
            args[1] === "add" &&
            !args.includes("-B") &&
            args.includes("jumi/issue-12-fix-the-thing")
        )
      ).toBe(false);
    });
  });

  test("checks out origin PR branch even when a stale local ref exists", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") return "";
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "worktree" &&
            args[1] === "add" &&
            !args.includes("-B") &&
            args.includes("jumi/issue-12-fix-the-thing")
        )
      ).toBe(false);
    });
  });

  test("existing worktree resets hard to origin PR branch", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      await mkdir(join(workdir, "kirmanak", "demo", "12", ".git"), { recursive: true });
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") return "";
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "checkout" && args.includes("jumi/issue-12-fix-the-thing"))).toBe(
        true
      );
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "reset" && args.includes("--hard") && args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
    });
  });

  test("writes JUMI_FEEDBACK.md and runs the follow-up engine", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      let kind: string | undefined;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      await implementFollowUp({
        api,
        job: followUpJob(),
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
          expect("prompt" in opts).toBe(false);
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("please fix the tests");
          expect(feedback).toContain("pulls/127");
          expect(feedback).toContain("jumi/issue-12-fix-the-thing");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(kind).toBe("follow-up");
    });
  });

  test("writes webhook review content into JUMI_FEEDBACK.md without a review id", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listPullReviews: async () => [],
      });
      await implementFollowUp({
        api,
        job: followUpJob({
          trigger: {
            event: "pull_request_comment",
            sender: "alice",
            body: "please rename",
          },
        }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("please rename");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
    });
  });

  test("pushes to existing branch and does not call createPullRequest", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(result).toEqual({
        status: "pushed",
        prNumber: 127,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
      });
      expect(api.pulls).toHaveLength(0);
      expect(gitCalls.find((args) => args[0] === "push")).toEqual([
        "push",
        "-u",
        "origin",
        "jumi/issue-12-fix-the-thing",
      ]);
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--force"))).toBe(false);
      expect(api.comments.at(-1)).toContain("Pushed follow-up to");
      expect(api.commentIndexes.at(-1)).toBe(127);
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
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--force"))).toBe(false);
      expect(api.comments.at(-1)).toContain("Closing this PR because the issue was closed.");
      expect(api.commentIndexes.at(-1)).toBe(127);
    });
  });

  test("clean tree → no-changes, no PR", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(result).toEqual({ status: "no-changes" });
      expect(api.pulls).toHaveLength(0);
      expect(api.comments.at(-1)).toContain("no follow-up changes");
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
      expect(
        gitCalls.some((args) => args[0] === "rev-list" && args.includes("origin/jumi/issue-12-fix-the-thing..HEAD"))
      ).toBe(true);
    });
  });

  test("child extraEnv has GIT_AUTH_TOKEN and not GITEA_BOT_TOKEN", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      let extraEnv: Record<string, string> | undefined;
      await implementFollowUp({
        api,
        job: followUpJob(),
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

  test("abort after push does not open a PR", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const abort = new AbortController();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "push") abort.abort();
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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

  test("configured maxFollowupRounds cap sticks (round 5 of 5 stuck, round 3 of 5 runs)", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 5,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi();
      let openCode = 0;
      const stuck = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        maxFollowupRounds: 5,
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
      expect(stuck).toEqual({ status: "skipped", reason: "stuck: too many follow-up rounds" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: too many follow-up rounds");
    });

    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      let openCode = 0;
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        maxFollowupRounds: 5,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).not.toBe("skipped");
      expect(openCode).toBe(1);
    });
  });

  test("max 3 rounds → stuck, no OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi();
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "stuck: too many follow-up rounds" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: too many follow-up rounds");
    });
  });

  test("leftover HOME follow-up files are unset, not a second source of truth", async () => {
    await withDirs(async (home, workdir) => {
      const path = followUpStatePath(home, "kirmanak", "demo", 12);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({
          prNumber: 127,
          round: 3,
          lastHeadSha: "abc",
          handledCommentIds: [],
          handledReviewIds: [],
          handledReviewFindings: [],
          updatedAt: "2026-05-23T00:00:00Z",
        })}\n`
      );
      let openCode = 0;
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return " M src/demo.ts";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).not.toBe("skipped");
      expect(openCode).toBe(1);
    });
  });

  test("same finding 4× → stuck sticky, no OpenCode, assignment stays", async () => {
    await withDirs(async (home, workdir) => {
      const hash = fingerprintFollowUpText("please fix the tests")!;
      await writeStuckState(stuckStatePath(home, "kirmanak", "demo", 12), {
        fingerprints: [
          { kind: "action", hash },
          { kind: "action", hash },
          { kind: "action", hash },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi();
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "stuck: repeated action" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: repeated action");
      expect(await api.getIssue("kirmanak", "demo", 12)).toEqual(makeIssue());
    });
  });

  test("review then CI then same review is not ping-pong", async () => {
    await withDirs(async (home, workdir) => {
      const a = fingerprintFollowUpText("please fix the tests")!;
      await writeStuckState(stuckStatePath(home, "kirmanak", "demo", 12), {
        fingerprints: [
          { kind: "action", hash: a },
          { kind: "ci", hash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      let openCode = 0;
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
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
      expect(result.status).not.toBe("skipped");
      expect(openCode).toBe(1);
    });
  });

  test("findings-only review body with inlines is not stuck on the empty writeup hash", async () => {
    await withDirs(async (home, workdir) => {
      const writeup = [
        "<!-- jumi-review:kirmanak/demo#127 -->",
        "### Jumi review",
        "",
        "Reviewed commit: `headsha`",
        "",
        "<!-- jumi-check: failure -->",
      ].join("\n");
      const inlineBody =
        "🟡 risk: stuck fingerprint ignores the inlines that now carry the findings.\n\n<!-- jumi-review:kirmanak/demo#127 -->";
      const lastReview = makeComment({ id: 88, body: writeup, user: makeUser({ login: "jumi" }) });
      const bodyOnly = buildFeedbackMarkdown({
        pr: jumiPr(),
        trigger: { event: "review-failure", sender: "jumi" },
        comments: [],
        inlines: [],
        reviews: [],
        lastReview,
      });
      const emptyHash = fingerprintFollowUpText(bodyOnly.markdown)!;
      await writeStuckState(stuckStatePath(home, "kirmanak", "demo", 12), {
        fingerprints: [
          { kind: "action", hash: emptyHash },
          { kind: "action", hash: emptyHash },
          { kind: "action", hash: emptyHash },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api: makeApi({
          listIssueComments: async () => [],
          listPullReviews: async () => [
            makeReview({
              id: 88,
              body: writeup,
              state: "REQUEST_CHANGES",
              commit_id: "headsha",
              user: makeUser({ login: "jumi" }),
            }),
          ],
          listPullReviewComments: async () => [
            makeComment({
              id: 11,
              body: inlineBody,
              user: makeUser({ login: "jumi" }),
            }),
          ],
        }),
        job: followUpJob({ trigger: { event: "review-failure", sender: "jumi" } }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).not.toBe("skipped");
      expect(openCode).toBe(1);
    });
  });

  test("same unresolved inline finding 4× → stuck sticky, no OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const writeup = [
        "<!-- jumi-review:kirmanak/demo#127 -->",
        "### Jumi review",
        "",
        "Reviewed commit: `headsha`",
        "",
        "<!-- jumi-check: failure -->",
      ].join("\n");
      const inlineBody =
        "🟡 risk: stuck fingerprint ignores the inlines that now carry the findings.\n\n<!-- jumi-review:kirmanak/demo#127 -->";
      const lastReview = makeComment({ id: 88, body: writeup, user: makeUser({ login: "jumi" }) });
      const withInlines = buildFeedbackMarkdown({
        pr: jumiPr(),
        trigger: { event: "review-failure", sender: "jumi" },
        comments: [],
        inlines: [],
        reviews: [],
        lastReview,
        currentInlines: [
          makeComment({
            id: 11,
            body: inlineBody,
            user: makeUser({ login: "jumi" }),
          }),
        ],
      });
      const hash = fingerprintFollowUpText(withInlines.markdown)!;
      await writeStuckState(stuckStatePath(home, "kirmanak", "demo", 12), {
        fingerprints: [
          { kind: "action", hash },
          { kind: "action", hash },
          { kind: "action", hash },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi({
        listIssueComments: async () => [],
        listPullReviews: async () => [
          makeReview({
            id: 88,
            body: writeup,
            state: "REQUEST_CHANGES",
            commit_id: "headsha",
            user: makeUser({ login: "jumi" }),
          }),
        ],
        listPullReviewComments: async () => [
          makeComment({
            id: 11,
            body: inlineBody,
            user: makeUser({ login: "jumi" }),
          }),
        ],
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: { event: "review-failure", sender: "jumi" } }),
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
      expect(result).toEqual({ status: "skipped", reason: "stuck: repeated action" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: repeated action");
    });
  });

  test("A→B→A ping-pong → stuck sticky, no OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const a = fingerprintFollowUpText("please fix the tests")!;
      const b = fingerprintFollowUpText("please rename the helper")!;
      await writeStuckState(stuckStatePath(home, "kirmanak", "demo", 12), {
        fingerprints: [
          { kind: "action", hash: a },
          { kind: "action", hash: b },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi();
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "stuck: ping-pong" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: ping-pong");
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
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "stuck: repeated error" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: repeated error");
    });
  });

  test("empty feedback does not count as a repeating finding", async () => {
    await withDirs(async (home, workdir) => {
      await writeStuckState(stuckStatePath(home, "kirmanak", "demo", 12), {
        fingerprints: [
          { kind: "action", hash: "aaa" },
          { kind: "action", hash: "aaa" },
          { kind: "action", hash: "aaa" },
        ],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      let openCode = 0;
      const result = await implementFollowUp({
        api: makeApi({
          listIssueComments: async () => [],
          listPullReviews: async () => [],
          listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
          listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha" }],
          getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
        }),
        job: followUpJob({ trigger: { event: "workflow_job", sender: "gitea" } }),
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
      expect(result.status).not.toBe("skipped");
      expect(openCode).toBe(1);
    });
  });

  test("exhausted review rounds still run CI-only follow-up", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi({
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
        listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha" }],
        getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: { event: "workflow_job", sender: "alice" } }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          const ci = await readFile(join(workdir, "kirmanak/demo/12/JUMI_CI.md"), "utf8");
          expect(ci).toContain("platforms;android-37");
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).not.toContain("please fix the tests");
          expect(feedback).toContain("Address JUMI_CI.md");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("no-changes");
      expect(openCode).toBe(1);
      expect(api.comments.some((body) => body.includes("Jumi is addressing CI failure."))).toBe(true);
      expect(api.comments.some((body) => body.includes("stuck: too many follow-up rounds"))).toBe(false);
      const followState = await readFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12));
      expect(followState.round).toBe(3);
      expect(followState.handledCommentIds).not.toContain(55);
    });
  });

  test("already-handled comment id → skip OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "abc",
        handledCommentIds: [55],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "comment already handled" });
      expect(openCode).toBe(0);
    });
  });

  test("review webhook without id skips OpenCode after no-changes", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const shared = {
        api,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        logger: () => undefined,
      };
      expect(
        await implementFollowUp({
          ...shared,
          job: followUpJob(),
          gitRunner,
          openCodeRunner: async () => ({ status: "ok" }),
        })
      ).toEqual({ status: "no-changes" });

      let openCode = 0;
      const result = await implementFollowUp({
        ...shared,
        job: followUpJob({
          trigger: { event: "pull_request_comment", sender: "alice", body: "please change this" },
        }),
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "no unhandled feedback" });
      expect(openCode).toBe(0);
    });
  });

  test("first-time review webhook with unhandled COMMENT review runs OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listPullReviews: async () => [
          makeReview({
            id: 42,
            body: "please rename",
            state: "COMMENT",
            type: "pull_request_review_comment",
          }),
        ],
      });
      let openCode = 0;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob({
          trigger: { event: "pull_request_comment", sender: "alice", body: "please rename" },
        }),
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
      expect(openCode).toBe(1);
      expect(result.status).not.toBe("skipped");
    });
  });

  test("timeout passed to OpenCode is 3600000 by default", async () => {
    await withDirs(async (home, workdir) => {
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      let timeoutMs: number | undefined;
      await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          timeoutMs = opts.timeoutMs;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(timeoutMs).toBe(FOLLOWUP_TIMEOUT_MS);
      expect(timeoutMs).toBe(3_600_000);
    });
  });

  test("configured timeoutMs is passed to OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      let timeoutMs: number | undefined;
      await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
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

  test("does not persist a terminal claim after OpenCode failure", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
      await expect(
        implementFollowUp({
          api,
          job: followUpJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          openCodeRunner: async () => {
            throw new Error("opencode exploded");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("opencode exploded");
      expect(await readClaim(claimFilePath(home, "kirmanak", "demo", 12))).toBeUndefined();
      expect(api.comments.at(-1)).toContain("Jumi failed");
      const state = await readFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12));
      expect(state.round).toBe(1);
      expect(state.handledCommentIds).not.toContain(55);
    });
  });

  test("calls merge-default before feedback OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const events: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base") events.push("merge-base");
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          events.push(opts.trace?.kind === "follow-up" ? "feedback" : "other");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(events.indexOf("merge-base")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("feedback")).toBeGreaterThan(events.indexOf("merge-base"));
    });
  });

  test("merge stuck → no feedback OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const kinds: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return "src/demo.ts";
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          kinds.push(opts.trace?.kind ?? "");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(kinds).toEqual(["conflict"]);
      expect(result).toEqual({ status: "skipped", reason: "stuck: cannot resolve conflicts" });
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(1);
      expect(conflict.lastHeadSha).toBe("abc123");
      expect(conflict.lastBaseSha).toBe("abc123");
    });
  });

  test("follow-up same-SHA after stuck skips merge/OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "headsha",
        lastBaseSha: "basesha",
        updatedAt: "2026-05-23T00:00:00Z",
      });
      let openCode = 0;
      let mergeCalled = false;
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "merge") mergeCalled = true;
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
      expect(mergeCalled).toBe(false);
    });
  });

  test("follow-up prefix OpenCode throw persists conflict state", async () => {
    await withDirs(async (home, workdir) => {
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return "src/demo.ts";
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
        if (gitArgs[0] === "rev-parse") return "headsha";
        return "";
      };
      await expect(
        implementFollowUp({
          api: makeApi(),
          job: followUpJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          openCodeRunner: async (opts) => {
            if (opts.trace?.kind === "conflict") throw new Error("opencode crashed");
            throw new Error("feedback should not run");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("opencode crashed");
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(1);
      expect(conflict.lastHeadSha).toBe("headsha");
      expect(conflict.lastBaseSha).toBe("basesha");
      const followup = await readFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12));
      expect(followup.round).toBe(1);
    });
  });

  test("follow-up honors configured maxConflictRounds, not only 3", async () => {
    await withDirs(async (home, workdir) => {
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "abc",
        lastBaseSha: "def",
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      let openCode = 0;
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
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
      expect(result.status).not.toBe("skipped");
      expect(openCode).toBe(1);
    });
  });

  test("follow-up honors MAX_CONFLICT_ROUNDS / shared conflict state", async () => {
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
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "stuck: cannot resolve conflicts" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: cannot resolve conflicts");
    });
  });

  test("follow-up records conflict SHAs after push on merged, immediately on stuck", async () => {
    await withDirs(async (home, workdir) => {
      let conflictDone = false;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return conflictDone ? "" : "src/demo.ts";
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("MERGE_HEAD")) return "mergehead";
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "M src/demo.ts";
        if (gitArgs[0] === "rev-list") return "1";
        return "";
      };
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          if (opts.trace?.kind === "conflict") conflictDone = true;
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(1);
      expect(conflict.lastHeadSha).toBe("abc123");
      expect(conflict.lastBaseSha).toBe("abc123");
    });
  });

  test("follow-up does not record merged conflict SHAs if later step throws", async () => {
    await withDirs(async (home, workdir) => {
      let conflictDone = false;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return conflictDone ? "" : "src/demo.ts";
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("MERGE_HEAD")) return "mergehead";
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "M src/demo.ts";
        return "";
      };
      await expect(
        implementFollowUp({
          api: makeApi(),
          job: followUpJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          openCodeRunner: async (opts) => {
            if (opts.trace?.kind === "conflict") {
              conflictDone = true;
              return { status: "ok" };
            }
            throw new Error("feedback exploded");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("feedback exploded");
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(0);
      expect(conflict.lastHeadSha).toBe("");
      expect(conflict.lastBaseSha).toBe("");
    });
  });

  test("follow-up that resolved conflicts then throws is not stamped with the resolver", async () => {
    await withDirs(async (home, workdir) => {
      let conflictDone = false;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return conflictDone ? "" : "src/demo.ts";
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("MERGE_HEAD")) return "mergehead";
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "M src/demo.ts";
        return "";
      };
      const api = makeApi();
      const resolverStamp = "_Jumi · claude · claude-opus-5 (high)_";
      await expect(
        implementFollowUp({
          api,
          job: followUpJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          openCodeRunner: async (opts) => {
            if (opts.trace?.kind === "conflict") {
              conflictDone = true;
              return { status: "ok", runner: { type: "claude", model: "claude-opus-5", effort: "high" } };
            }
            throw new EngineFailedError("host: provider auth death", false, { auth: true });
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("provider auth death");
      const addressing = api.comments.find((body) => body.includes("Jumi is addressing review comments."));
      expect(addressing).toBeDefined();
      expect(addressing).not.toContain(resolverStamp);
      expect(addressing).not.toContain("_Jumi ·");
      const failed = api.comments.find((body) => body.includes("Jumi failed"));
      expect(failed).toContain("Jumi failed");
      expect(failed).not.toContain(resolverStamp);
      expect(failed).toContain("_Jumi · opencode · openai/gpt-5.5_");
    });
  });

  test("follow-up up-to-date merge does not increment conflict round", async () => {
    await withDirs(async (home, workdir) => {
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
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
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(0);
    });
  });

  test("retries the same commentId after OpenCode failure", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const shared = {
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        logger: () => undefined,
      };
      await expect(
        implementFollowUp({
          ...shared,
          openCodeRunner: async () => {
            throw new Error("opencode exploded");
          },
        })
      ).rejects.toThrow("opencode exploded");
      let openCode = 0;
      const result = await implementFollowUp({
        ...shared,
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
      });
      expect(result.status).not.toBe("skipped");
      expect(openCode).toBe(1);
    });
  });

  test("no-changes persists jumi-review finding as id+sha, not comment id", async () => {
    await withDirs(async (home, workdir) => {
      const sha = "a62c750c0ffee000000000000000000000000000";
      const pr = jumiPr();
      pr.head.sha = sha;
      const api = makeApi({
        listOpenPulls: async () => [pr],
        listIssueComments: async () => [
          makeComment({
            id: 38022,
            body: [
              "<!-- jumi-review:kirmanak/demo#127 -->",
              "### Jumi review",
              "",
              `Reviewed commit: \`${sha}\``,
              "",
              "1 blocking",
              "<!-- jumi-check: failure; 1 blocking, 1 risk -->",
            ].join("\n"),
            user: makeUser({ login: "jumi" }),
          }),
        ],
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return sha;
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: undefined }),
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
      expect(result).toEqual({ status: "no-changes" });
      const state = await readFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12));
      expect(state.handledCommentIds).not.toContain(38022);
      expect(state.handledReviewFindings).toEqual([{ id: 38022, sha }]);
    });
  });

  test("CI-only red check writes JUMI_CI.md and runs OpenCode without review comments", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
        listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha" }],
        getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
      });
      let kind: string | undefined;
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: { event: "workflow_job", sender: "alice" } }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async (opts) => {
          kind = opts.trace?.kind;
          const ci = await readFile(join(workdir, "kirmanak/demo/12/JUMI_CI.md"), "utf8");
          expect(ci).toContain("platforms;android-37");
          expect(ci).toContain("Do not call tea");
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).not.toContain("please fix the tests");
          expect(feedback).toContain("Address JUMI_CI.md");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(kind).toBe("follow-up");
      expect(result.status).toBe("no-changes");
      expect(api.comments.some((body) => body.includes("Jumi is addressing CI failure."))).toBe(true);
      const followState = await readFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12));
      expect(followState.round).toBe(0);
    });
  });

  test("GitHub Actions check-run failure with only jumi/opencode-review status runs OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listCommitStatuses: async () => [{ id: 1, context: "jumi/opencode-review", state: "success" }],
        listCheckRuns: async () => [
          {
            id: 4,
            context: "checks",
            status: "failure",
            description: "Process completed with exit code 1.",
            target_url: "https://github.com/kirmanak/jumi/actions/runs/9/job/4",
            jobId: 4,
          },
          { id: 5, context: "image", status: "success" },
        ],
        getActionJobLogs: async () => "##[error]lint/typecheck/tests, exit 1\n",
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: { event: "workflow_job", sender: "alice" } }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          const ci = await readFile(join(workdir, "kirmanak/demo/12/JUMI_CI.md"), "utf8");
          expect(ci).toContain("lint/typecheck/tests, exit 1");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).not.toBe("skipped");
      expect(openCode).toBe(1);
    });
  });

  test("CI-only wake injects the last jumi review into JUMI_FEEDBACK.md", async () => {
    await withDirs(async (home, workdir) => {
      const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const sticky = jumiReviewSticky({ sha });
      const pr = jumiPr();
      pr.head.sha = sha;
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: sha,
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [{ id: sticky.id, sha }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi({
        listOpenPulls: async () => [pr],
        listIssueComments: async () => [sticky],
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
        listActionJobs: async () => [{ id: 9, name: "build", head_sha: sha }],
        getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: { event: "workflow_job", sender: "gitea" } }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return sha;
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("## Last review");
          expect(feedback).toContain("🟡 risk: guard the null deref in `connectToServer`");
          expect(feedback).toContain("Event: workflow_job");
          const ci = await readFile(join(workdir, "kirmanak/demo/12/JUMI_CI.md"), "utf8");
          expect(ci).toContain("platforms;android-37");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("no-changes");
      expect(openCode).toBe(1);
      expect(api.comments.some((body) => body.includes("Jumi is addressing CI failure."))).toBe(true);
      const followState = await readFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12));
      expect(followState.round).toBe(1);
    });
  });

  test("leftover simplifications wake follow-up without a writer comment", async () => {
    await withDirs(async (home, workdir) => {
      const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const sticky = makeComment({
        id: 38022,
        body: [
          "<!-- jumi-review:kirmanak/demo#127 -->",
          "### Jumi review",
          "",
          `Reviewed commit: \`${sha}\``,
          "",
          "💡 simpler: drop the helper.",
          "<!-- jumi-check: success; 1 suggestion -->",
        ].join("\n"),
        user: makeUser({ login: "jumi" }),
      });
      const pr = jumiPr();
      pr.head.sha = sha;
      const api = makeApi({
        listOpenPulls: async () => [pr],
        listIssueComments: async () => [sticky],
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob({
          headSha: sha,
          trigger: { event: "review-suggestions", sender: "jumi" },
        }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return sha;
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("## Last review");
          expect(feedback).toContain("drop the helper");
          expect(feedback).toContain("Event: review-suggestions");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("no-changes");
      expect(openCode).toBe(1);
    });
  });

  test("writer comment injects the current-head success review", async () => {
    await withDirs(async (home, workdir) => {
      const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const sticky = makeComment({
        id: 38022,
        body: [
          "<!-- jumi-review:kirmanak/demo#127 -->",
          "### Jumi review",
          "",
          `Reviewed commit: \`${sha}\``,
          "",
          "❓ q: is the timeout intentional?",
          "<!-- jumi-check: success -->",
        ].join("\n"),
        user: makeUser({ login: "jumi" }),
      });
      const pr = jumiPr();
      pr.head.sha = sha;
      const api = makeApi({
        listOpenPulls: async () => [pr],
        listIssueComments: async () => [
          sticky,
          makeComment({ id: 88, body: "let's do that", user: makeUser({ login: "alice" }) }),
        ],
      });
      let openCode = 0;
      await implementFollowUp({
        api,
        job: followUpJob({
          headSha: sha,
          trigger: { event: "issue_comment", commentId: 88, sender: "alice" },
        }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return sha;
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("## Last review");
          expect(feedback).toContain("is the timeout intentional");
          expect(feedback).toContain("let's do that");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(openCode).toBe(1);
    });
  });

  test("address-the-earlier-review stub injects the last jumi review", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [
          jumiReviewSticky({ sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
          makeComment({
            id: 88,
            body: "Address the earlier review",
            user: makeUser({ login: "alice" }),
          }),
        ],
      });
      let openCode = 0;
      await implementFollowUp({
        api,
        job: followUpJob({
          trigger: { event: "issue_comment", commentId: 88, sender: "alice" },
        }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("## Last review");
          expect(feedback).toContain("🟡 risk: guard the null deref in `connectToServer`");
          expect(feedback).toContain("Address the earlier review");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(openCode).toBe(1);
      expect(api.comments.some((body) => body.includes("Jumi is addressing review comments."))).toBe(true);
    });
  });

  test("writer phrase without findings still runs OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      let openCode = 0;
      const result = await implementFollowUp({
        api: makeApi({
          listIssueComments: async () => [
            makeComment({
              id: 88,
              body: "Address the earlier review",
              user: makeUser({ login: "alice" }),
            }),
          ],
        }),
        job: followUpJob({
          trigger: { event: "issue_comment", commentId: 88, sender: "alice" },
        }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("Address the earlier review");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("no-changes");
      expect(openCode).toBe(1);
    });
  });

  test("clone/fetch failure before OpenCode does not record CI handled", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
        listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha" }],
        getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
      });
      let openCode = 0;
      await expect(
        implementFollowUp({
          api,
          job: followUpJob({ trigger: { event: "workflow_job", sender: "alice" } }),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner: async (args) => {
            const gitArgs = stripGitConfigArgs(args);
            if (gitArgs[0] === "clone" || gitArgs[0] === "fetch") throw new Error("clone failed");
            throw new Error("git should not run");
          },
          openCodeRunner: async () => {
            openCode++;
            return { status: "ok" };
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("clone failed");
      expect(openCode).toBe(0);
      expect((await readCiState(ciStatePath(home, "kirmanak", "demo", 12))).handled).toEqual([]);
    });
  });

  test("CI-only OpenCode failure still records handled CI", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
        listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha" }],
        getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
      });
      await expect(
        implementFollowUp({
          api,
          job: followUpJob({ trigger: { event: "workflow_job", sender: "alice" } }),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner: async (args) => {
            const gitArgs = stripGitConfigArgs(args);
            if (gitArgs[0] === "rev-parse") return "abc123";
            if (gitArgs[0] === "status") return "";
            if (gitArgs[0] === "rev-list") return "0";
            return "";
          },
          openCodeRunner: async () => {
            throw new Error("opencode exploded");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("opencode exploded");
      const ciState = await readCiState(ciStatePath(home, "kirmanak", "demo", 12));
      expect(ciState.handled).toHaveLength(1);
      expect(ciState.handled[0]?.checkName).toBe("build");
      expect(ciState.handled[0]?.sha).toBe("headsha");
    });
  });

  test("CI still pending skips OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      let listed = 0;
      const waits: number[] = [];
      const api = makeApi({
        listIssueComments: async () => [],
        listCommitStatuses: async () => {
          listed++;
          return [
            { id: 1, context: "build", status: "failure" },
            { id: 2, context: "test", status: "pending" },
          ];
        },
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: { event: "workflow_job", sender: "alice" } }),
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
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "CI still pending" });
      expect(openCode).toBe(0);
      expect(listed).toBe(2);
      expect(waits).toEqual([CI_PENDING_RETRY_MS]);
    });
  });

  test("pending then terminal completed wake re-lists once and runs OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      let listed = 0;
      const api = makeApi({
        listIssueComments: async () => [],
        listCommitStatuses: async () => {
          listed++;
          if (listed === 1) {
            return [
              { id: 1, context: "build", status: "failure" },
              { id: 2, context: "test", status: "pending" },
            ];
          }
          return [{ id: 1, context: "build", status: "failure" }];
        },
        listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha" }],
        getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: { event: "workflow_job", sender: "alice" } }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
        logger: () => undefined,
        sleep: async () => undefined,
      });
      expect(result.status).toBe("no-changes");
      expect(openCode).toBe(1);
      expect(listed).toBe(2);
    });
  });

  test("known infra flake comments and does not run OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
        listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha" }],
        getActionJobLogs: async () => "##[error]Failed to connect to 140.82.112.4 port 443: Connection timed out\n",
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: { event: "workflow_job", sender: "alice" } }),
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
      expect(result).toEqual({
        status: "skipped",
        reason: "CI infra flake: GitHub 140.82 checkout/cache timeout or unreachable",
      });
      expect(openCode).toBe(0);
      expect(api.comments.some((body) => body.includes("infra flake"))).toBe(true);
    });
  });

  test("review follow-up still injects failed CI logs", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
        listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha" }],
        getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
      });
      await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          const ci = await readFile(join(workdir, "kirmanak/demo/12/JUMI_CI.md"), "utf8");
          expect(ci).toContain("platforms;android-37");
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("please fix the tests");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
    });
  });
});

describe("buildFeedbackMarkdown", () => {
  test("omits trimmed extra comment ids that are not in markdown", () => {
    const huge = "x".repeat(FEEDBACK_MAX_BYTES);
    const result = buildFeedbackMarkdown({
      pr: jumiPr(),
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      triggerBody: "please fix the tests",
      comments: [
        makeComment({
          id: 1,
          body: huge,
          created_at: "2026-01-01T00:00:00Z",
          user: makeUser({ login: "bob" }),
        }),
        makeComment({
          id: 55,
          body: "please fix the tests",
          created_at: "2026-01-02T00:00:00Z",
          user: makeUser({ login: "alice" }),
        }),
      ],
      inlines: [],
      reviews: [],
    });
    expect(result.markdown).not.toContain("### Comment 1");
    expect(result.markdown).toContain("Comment id: 55");
    expect(result.commentIds).toContain(55);
    expect(result.commentIds).not.toContain(1);
  });

  test("keeps last jumi review when extras exceed the byte cap", () => {
    const huge = "x".repeat(FEEDBACK_MAX_BYTES);
    const lastReview = jumiReviewSticky();
    const result = buildFeedbackMarkdown({
      pr: jumiPr(),
      trigger: { event: "workflow_job", sender: "gitea" },
      comments: [
        makeComment({
          id: 1,
          body: huge,
          created_at: "2026-01-01T00:00:00Z",
          user: makeUser({ login: "bob" }),
        }),
        lastReview,
      ],
      inlines: [],
      reviews: [],
      lastReview,
    });
    expect(result.markdown).toContain("## Last review");
    expect(result.markdown).toContain("🟡 risk: guard the null deref in `connectToServer`");
    expect(result.markdown).not.toContain("### Comment 1");
    expect(result.commentIds).toContain(38022);
    expect(result.commentIds).not.toContain(1);
  });

  test("puts current-head review and unresolved inlines before earlier jumi findings", () => {
    const lastReview = jumiReviewSticky({ id: 2, finding: "current finding" });
    const earlier = jumiReviewSticky({
      id: 1,
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      finding: "earlier finding",
    });
    const result = buildFeedbackMarkdown({
      pr: jumiPr(),
      comments: [],
      inlines: [],
      reviews: [],
      lastReview,
      currentInlines: [
        makeComment({
          id: 11,
          body: "🔴 bug: unresolved inline\n\n<!-- jumi-review:kirmanak/demo#127 -->",
          user: makeUser({ login: "jumi" }),
        }),
      ],
      earlierReviews: [earlier],
    });
    const currentAt = result.markdown.indexOf("current finding");
    const inlineAt = result.markdown.indexOf("unresolved inline");
    const earlierAt = result.markdown.indexOf("earlier finding");
    expect(currentAt).toBeGreaterThan(-1);
    expect(inlineAt).toBeGreaterThan(currentAt);
    expect(earlierAt).toBeGreaterThan(inlineAt);
    expect(result.markdown).toContain("### Earlier review 1");
  });
});

describe("pickLatestJumiReview", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const staleSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  test("prefers current-head sticky over a newer stale one", () => {
    const stale = jumiReviewSticky({
      id: 1,
      sha: staleSha,
      finding: "stale finding",
      createdAt: "2026-09-12T00:00:00Z",
    });
    const current = jumiReviewSticky({ id: 2, sha: head, createdAt: "2026-09-11T00:00:00Z" });
    expect(pickLatestJumiReview([stale, current], head)?.id).toBe(2);
  });

  test("falls back to the latest sticky when none match head", () => {
    const older = jumiReviewSticky({ id: 1, sha: staleSha, createdAt: "2026-09-10T00:00:00Z" });
    const newer = jumiReviewSticky({
      id: 2,
      sha: "cccccccccccccccccccccccccccccccccccccccc",
      createdAt: "2026-09-11T00:00:00Z",
    });
    expect(pickLatestJumiReview([older, newer], head)?.id).toBe(2);
  });
});

describe("pickLatestJumiFinding", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const staleSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function items(overrides: Partial<FollowUpItems> = {}): FollowUpItems {
    return {
      comments: [],
      inlines: [],
      reviews: [],
      jumiStickies: [],
      jumiInlines: [],
      jumiReviews: [],
      jumiFindingReviews: [],
      ...overrides,
    };
  }

  function jumiPull(opts: { id: number; sha: string; finding: string; submittedAt: string }) {
    return makeReview({
      id: opts.id,
      body: [
        "<!-- jumi-review:kirmanak/demo#127 -->",
        "### Jumi review",
        "",
        `Reviewed commit: \`${opts.sha}\``,
        "",
        opts.finding,
        "<!-- jumi-check: failure -->",
      ].join("\n"),
      state: "REQUEST_CHANGES",
      commit_id: opts.sha,
      user: makeUser({ login: "jumi" }),
      submitted_at: opts.submittedAt,
    });
  }

  test("prefers a current-head sticky over a stale pull review", () => {
    const stalePull = jumiPull({
      id: 1,
      sha: staleSha,
      finding: "stale pull finding",
      submittedAt: "2026-09-12T00:00:00Z",
    });
    const currentSticky = jumiReviewSticky({
      id: 2,
      sha: head,
      finding: "current sticky finding",
      createdAt: "2026-09-11T00:00:00Z",
    });
    expect(pickLatestJumiFinding(items({ jumiReviews: [stalePull], jumiStickies: [currentSticky] }), head)?.id).toBe(2);
  });

  test("prefers a current-head pull review over a current-head sticky", () => {
    const currentPull = jumiPull({
      id: 1,
      sha: head,
      finding: "current pull finding",
      submittedAt: "2026-09-10T00:00:00Z",
    });
    const currentSticky = jumiReviewSticky({
      id: 2,
      sha: head,
      finding: "current sticky finding",
      createdAt: "2026-09-12T00:00:00Z",
    });
    expect(pickLatestJumiFinding(items({ jumiReviews: [currentPull], jumiStickies: [currentSticky] }), head)?.id).toBe(
      1
    );
  });

  test("falls back to the latest dated finding when none match head", () => {
    const olderPull = jumiPull({
      id: 1,
      sha: staleSha,
      finding: "older pull finding",
      submittedAt: "2026-09-10T00:00:00Z",
    });
    const newerSticky = jumiReviewSticky({
      id: 2,
      sha: "cccccccccccccccccccccccccccccccccccccccc",
      finding: "newer sticky finding",
      createdAt: "2026-09-11T00:00:00Z",
    });
    expect(pickLatestJumiFinding(items({ jumiReviews: [olderPull], jumiStickies: [newerSticky] }), head)?.id).toBe(1);
  });
});

describe("collectFollowUpItems", () => {
  test("keeps human issue comments when inline listing 404s", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
      ],
      listPullReviewComments: async () => {
        throw new Error("404: not found");
      },
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.comments.map((comment) => comment.id)).toEqual([55]);
    expect(items.inlines).toEqual([]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  test("needsFollowUp is false when inlines 404 and there is no human feedback", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviewComments: async () => {
        throw new Error("404: not found");
      },
      listPullReviews: async () => [],
    });
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
    });
  });

  test("includes request-changes and human COMMENT reviews with a body", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviews: async () => [
        makeReview({ id: 1, body: "please change this", state: "REQUEST_CHANGES" }),
        makeReview({
          id: 2,
          body: "please rename",
          state: "COMMENT",
          type: "pull_request_review_comment",
        }),
        makeReview({ id: 3, body: "please review this", state: "REQUEST_REVIEW" }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.reviews.map((review) => review.id)).toEqual([1, 2]);
  });

  test("skips empty, approve-without-body, approve-with-body, and bot reviews", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviews: async () => [
        makeReview({ id: 1, body: "", state: "COMMENT", type: "pull_request_review_comment" }),
        makeReview({ id: 2, body: "", state: "APPROVED" }),
        makeReview({ id: 3, body: "looks good", state: "APPROVED" }),
        makeReview({
          id: 4,
          body: "please rename",
          state: "COMMENT",
          type: "pull_request_review_comment",
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.reviews).toEqual([]);
  });

  test("skips jumi REQUEST_CHANGES reviews so the worker does not follow up itself", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviews: async () => [
        makeReview({
          id: 1,
          body: "Review requested changes",
          state: "REQUEST_CHANGES",
          user: makeUser({ login: "jumi" }),
        }),
        makeReview({ id: 2, body: "please change this", state: "REQUEST_CHANGES", user: makeUser({ login: "alice" }) }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.reviews.map((review) => review.id)).toEqual([2]);
  });

  test("skips bot inlines the same way stickies are ignored", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviewComments: async () => [
        makeComment({
          id: 11,
          body: "🔴 bug: null deref. Guard it.\n\n<!-- jumi-review:kirmanak/demo#127 -->",
          user: makeUser({ login: "jumi" }),
        }),
        makeComment({
          id: 12,
          body: "please rename this helper",
          user: makeUser({ login: "alice" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.inlines.map((comment) => comment.id)).toEqual([12]);
  });

  test("skips listed ignore logins and still skips the bot", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 1, body: "## PR Change Summary", user: makeUser({ login: "tapio" }) }),
        makeComment({ id: 2, body: "Edited/Blocked", user: makeUser({ login: "renovate-bot" }) }),
        makeComment({ id: 3, body: "please fix", user: makeUser({ login: "alice" }) }),
        makeComment({ id: 4, body: "bot note", user: makeUser({ login: "jumi" }) }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha, [
      "tapio",
      "renovate-bot",
    ]);
    expect(items.comments.map((comment) => comment.id)).toEqual([3]);
  });

  test("unset ignore list keeps non-bot comments as human feedback", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 1, body: "## PR Change Summary", user: makeUser({ login: "tapio" }) }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.comments.map((comment) => comment.id)).toEqual([1]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
          followupIgnoreLogins: ["tapio"],
        })
      ).toBe(false);
    });
  });

  const HEAD_SHA = "a62c750c0ffee000000000000000000000000000";
  const STALE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function reviewSticky(opts: { sha?: string; trailer?: string | null; worker?: boolean; review?: boolean } = {}) {
    const lines: string[] = [];
    if (opts.worker) lines.push("<!-- jumi-worker:kirmanak/demo#12 -->");
    if (opts.review !== false) lines.push("<!-- jumi-review:kirmanak/demo#127 -->");
    lines.push("### Jumi review", "", `Reviewed commit: \`${opts.sha ?? HEAD_SHA}\``, "", "1 blocking");
    if (opts.trailer !== null) lines.push(opts.trailer ?? "<!-- jumi-check: failure -->");
    return lines.join("\n");
  }

  function prWithHead(sha = HEAD_SHA) {
    const pr = jumiPr();
    return { ...pr, head: { ...pr.head, sha } };
  }

  test("keeps current-head jumi failure sticky with reason suffix and needsFollowUp", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: "<!-- jumi-check: failure; 1 blocking, 1 risk -->" }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments.map((comment) => comment.id)).toEqual([38022]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  test("keeps current-head jumi failure sticky and needsFollowUp", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky(),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments.map((comment) => comment.id)).toEqual([38022]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  test("excludes jumi review sticky when trailer is missing", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: null }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
    });
  });

  test("excludes jumi failure sticky for a SHA that is not pr.head.sha", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ sha: STALE_SHA }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
    expect(items.jumiStickies.map((comment) => comment.id)).toEqual([38022]);
  });

  test("keeps jumi inlines for the brief without treating them as human feedback", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviewComments: async () => [
        makeComment({
          id: 11,
          body: "🟡 risk: guard the null deref\n\n<!-- jumi-review:kirmanak/demo#127 -->",
          user: makeUser({ login: "jumi" }),
        }),
        makeComment({
          id: 12,
          body: "please rename this helper",
          user: makeUser({ login: "alice" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.inlines.map((comment) => comment.id)).toEqual([12]);
    expect(items.jumiInlines.map((comment) => comment.id)).toEqual([11]);
  });

  test("includes a stale-head jumi failure sticky when extraHeadShas or review-failure match", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ sha: STALE_SHA }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const byExtra = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA, [], {
      extraHeadShas: [STALE_SHA],
    });
    expect(byExtra.comments.map((comment) => comment.id)).toEqual([38022]);
    const byTrigger = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA, [], {
      anyReviewedCommit: true,
    });
    expect(byTrigger.comments.map((comment) => comment.id)).toEqual([38022]);
  });

  test("excludes questions-only success sticky from findings but keeps it for the brief", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: "<!-- jumi-check: success -->" }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
    expect(items.jumiStickies.map((comment) => comment.id)).toEqual([38022]);
  });

  test("excludes success sticky without a suggestion count from findings", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: "<!-- jumi-check: success; no blocking issues -->" }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
    expect(items.jumiStickies.map((comment) => comment.id)).toEqual([38022]);
  });

  test("keeps current-head success sticky with leftover simplifications and needsFollowUp", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: "<!-- jumi-check: success; 2 suggestions -->" }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments.map((comment) => comment.id)).toEqual([38022]);
    expect(items.jumiStickies.map((comment) => comment.id)).toEqual([38022]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  test("excludes jumi-worker sticky", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 1,
          body: reviewSticky({ worker: true }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
  });

  test("keeps a human alice root comment in scope", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
        makeComment({
          id: 1,
          body: "<!-- jumi-worker:kirmanak/demo#12 -->\nworking",
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments.map((comment) => comment.id)).toEqual([55]);
  });

  test("excludes human jumi-check failure without jumi-review", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 77,
          body: "please fix\n<!-- jumi-check: failure -->",
          user: makeUser({ login: "alice" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
  });

  test("needsFollowUp is false when the same jumi-review id and reviewed SHA are already handled", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky(),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    await withDirs(async (home) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: HEAD_SHA,
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [{ id: 38022, sha: HEAD_SHA }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
    });
  });

  test("needsFollowUp is true when the same jumi-review id has a new current-head SHA", async () => {
    const nextSha = "cccccccccccccccccccccccccccccccccccccccc";
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ sha: nextSha }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    await withDirs(async (home) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: HEAD_SHA,
        handledCommentIds: [38022],
        handledReviewIds: [],
        handledReviewFindings: [{ id: 38022, sha: HEAD_SHA }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(nextSha),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  function reviewWriteup(opts: { sha?: string; trailer?: string; prose?: string } = {}) {
    return [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi review",
      "",
      `Reviewed commit: \`${opts.sha ?? HEAD_SHA}\``,
      "",
      opts.prose ?? "Guard the null deref.",
      opts.trailer ?? "<!-- jumi-check: failure -->",
    ].join("\n");
  }

  test("keeps current-head jumi pull review with failure trailer and needsFollowUp", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviews: async () => [
        makeReview({
          id: 88,
          body: reviewWriteup(),
          state: "REQUEST_CHANGES",
          commit_id: HEAD_SHA,
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.jumiFindingReviews.map((review) => review.id)).toEqual([88]);
    expect(items.comments).toEqual([]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  test("skips empty success pull reviews and old verdict-only bodies", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviews: async () => [
        makeReview({
          id: 1,
          body: "No blocking issues",
          state: "APPROVED",
          commit_id: HEAD_SHA,
          user: makeUser({ login: "jumi" }),
        }),
        makeReview({
          id: 2,
          body: reviewWriteup({ trailer: "<!-- jumi-check: success -->" }),
          state: "APPROVED",
          commit_id: HEAD_SHA,
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.jumiReviews.map((review) => review.id)).toEqual([2]);
    expect(items.jumiFindingReviews).toEqual([]);
  });

  test("needsFollowUp is false for questions-only success", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: "<!-- jumi-check: success -->" }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
    });
  });

  test("needsFollowUp is false when the same jumi pull review id and SHA are already handled", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviews: async () => [
        makeReview({
          id: 88,
          body: reviewWriteup(),
          state: "REQUEST_CHANGES",
          commit_id: HEAD_SHA,
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    await withDirs(async (home) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: HEAD_SHA,
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [{ id: 88, sha: HEAD_SHA }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
    });
  });
});

describe("needsFollowUp", () => {
  test("returns true for a human COMMENT review with a summary body", async () => {
    await withDirs(async (home) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listPullReviews: async () => [
          makeReview({
            id: 42,
            body: "please rename",
            state: "COMMENT",
            type: "pull_request_review_comment",
          }),
        ],
      });
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  test("cap sticks at configured maxFollowupRounds, not only 3", async () => {
    await withDirs(async (home) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect(
        await needsFollowUp({
          api: makeApi(),
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
      expect(
        await needsFollowUp({
          api: makeApi(),
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
          maxFollowupRounds: 5,
        })
      ).toBe(true);
    });
  });

  test("returns false for empty, approve, and bot reviews", async () => {
    await withDirs(async (home) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listPullReviews: async () => [
          makeReview({ id: 1, body: "", state: "APPROVED" }),
          makeReview({ id: 2, body: "looks good", state: "APPROVED" }),
          makeReview({
            id: 3,
            body: "please rename",
            state: "COMMENT",
            user: makeUser({ login: "jumi" }),
          }),
        ],
      });
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
    });
  });

  test("excludes outsider comments without write access from feedback", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
        makeComment({ id: 56, body: "outsider drive-by", user: makeUser({ login: "mallory" }) }),
      ],
      getCollaboratorPermission: async (_owner, _repo, username) =>
        username.toLowerCase() === "alice"
          ? { permission: "write", role_name: "write" }
          : { permission: "read", role_name: "read" },
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.comments.map((comment) => comment.id)).toEqual([55]);
  });

  test("with a trusted sender list, only listed logins steer and the forge is not asked", async () => {
    let lookups = 0;
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
        makeComment({ id: 56, body: "writer but unlisted", user: makeUser({ login: "mallory" }) }),
      ],
      getCollaboratorPermission: async (_owner, _repo, username) => {
        lookups += 1;
        return username === "mallory" ? { permission: "write", role_name: "write" } : { permission: "none" };
      },
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha, [], {}, [
      "Alice",
    ]);
    expect(items.comments.map((comment) => comment.id)).toEqual([55]);
    expect(lookups).toBe(0);
  });

  test("trusted wake does not pull outsider reviews or inlines", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviews: async () => [
        makeReview({ id: 1, body: "please change this", state: "REQUEST_CHANGES", user: makeUser({ login: "alice" }) }),
        makeReview({ id: 2, body: "outsider nit", state: "COMMENT", user: makeUser({ login: "mallory" }) }),
      ],
      listPullReviewComments: async () => [
        makeComment({ id: 11, body: "trusted inline", user: makeUser({ login: "alice" }) }),
        makeComment({ id: 12, body: "outsider inline", user: makeUser({ login: "mallory" }) }),
      ],
      getCollaboratorPermission: async (_owner, _repo, username) =>
        username.toLowerCase() === "alice"
          ? { permission: "write", role_name: "write" }
          : { permission: "read", role_name: "read" },
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.reviews.map((review) => review.id)).toEqual([1]);
    expect(items.inlines.map((comment) => comment.id)).toEqual([11]);
  });

  test("collect is fail-closed when permission lookup throws", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
      ],
      getCollaboratorPermission: async () => {
        throw new Error("forge 500");
      },
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.comments).toEqual([]);
  });

  test("bot finding sticky survives permission lookup failure while forged marker is dropped", async () => {
    const headSha = "a62c750c0ffee000000000000000000000000000";
    const stickyBody = [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi review",
      "",
      `Reviewed commit: \`${headSha}\``,
      "",
      "1 blocking",
      "<!-- jumi-check: failure -->",
    ].join("\n");
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 38022, body: stickyBody, user: makeUser({ login: "jumi" }) }),
        makeComment({ id: 38023, body: stickyBody, user: makeUser({ login: "mallory" }) }),
      ],
      getCollaboratorPermission: async () => {
        throw new Error("forge 500");
      },
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", headSha);
    expect(items.comments.map((comment) => comment.id)).toEqual([38022]);
  });
});
