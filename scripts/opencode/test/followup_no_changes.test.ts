import { describe, expect, test } from "bun:test";
import { implementFollowUp } from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { probeWorkerMcpServer } from "../src/worker_mcp.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";
import { withDirs } from "./harness/temp.ts";

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

function followupApi(
  overrides: Partial<IssueApi> = {}
): IssueApi & { comments: string[]; pulls: unknown[]; commentIndexes: number[] } {
  const comments: string[] = [];
  const pulls: unknown[] = [];
  const commentIndexes: number[] = [];
  const fake = makeIssueApi({
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [jumiPr()],
    createPullRequest: async (_owner, _repo, pull) => {
      pulls.push(pull);
      return makePR({ number: 3, title: pull.title, body: pull.body });
    },
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
    ...overrides,
  });
  return Object.assign(fake, { comments, pulls, commentIndexes });
}

function followUpJob(overrides: Parameters<typeof makeIssueJob>[0] = {}) {
  return makeIssueJob({
    mode: "follow-up",
    prNumber: 127,
    trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
    ...overrides,
  });
}

function cleanGitRunner(): GitRunner {
  return async (args) => {
    const gitArgs = stripGitConfigArgs(args);
    if (gitArgs[0] === "rev-parse") return "abc123";
    if (gitArgs[0] === "status") return "";
    if (gitArgs[0] === "rev-list") return "0";
    return "";
  };
}

describe("follow-up no_changes reason", () => {
  test("clean tree with no_changes call posts the reason", async () => {
    await withDirs(async (home, workdir) => {
      const api = followupApi();
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
        gitRunner: cleanGitRunner(),
        openCodeRunner: async (opts) => {
          const mcp = (opts as unknown as { workerMcp?: { url: string; token: string } }).workerMcp;
          expect(mcp).toBeDefined();
          const out = await probeWorkerMcpServer(mcp!.url, mcp!.token, "no_changes", {
            reason: "Review asked for a null guard, already addressed in abc123.",
          });
          expect(out.ok).toBe(true);
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(api.comments.at(-1)).toContain("no follow-up changes:");
      expect(api.comments.at(-1)).toContain("already addressed in abc123");
    });
  });

  test("clean tree without a call falls back with (no reason given)", async () => {
    await withDirs(async (home, workdir) => {
      const api = followupApi();
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
        gitRunner: cleanGitRunner(),
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(api.comments.at(-1)).toContain("no follow-up changes (no reason given)");
    });
  });

  test("reason with > is sanitised like verdict text", async () => {
    await withDirs(async (home, workdir) => {
      const api = followupApi();
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
        gitRunner: cleanGitRunner(),
        openCodeRunner: async (opts) => {
          const mcp = (opts as unknown as { workerMcp?: { url: string; token: string } }).workerMcp;
          const out = await probeWorkerMcpServer(mcp!.url, mcp!.token, "no_changes", {
            reason: "Blocked on external fix, see a > b.",
          });
          expect(out.ok).toBe(true);
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      const last = api.comments.at(-1) ?? "";
      expect(last).toContain("no follow-up changes:");
      expect(last).toContain("›");
      expect(last).not.toContain("a > b");
    });
  });
});
