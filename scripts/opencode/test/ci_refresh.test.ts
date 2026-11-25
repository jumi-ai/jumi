import { describe, expect, test } from "bun:test";
import { readCiLatch } from "../src/ci.ts";
import { isCiRefreshSpent, splitCiRefreshBudget } from "../src/ci_refresh.ts";
import { ciStatePath } from "../src/claim.ts";
import { implementFollowUp } from "../src/followup.ts";
import type { CheckState } from "../src/ports.ts";
import { forEachForge, makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";
import { withDirs } from "./harness/temp.ts";

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function renovatePr(headSha: string) {
  const repo = makeRepo();
  return makePR({
    number: 50,
    title: "chore(deps)",
    body: "",
    user: makeUser({ login: "renovate" }),
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
    head: { label: "kirmanak:renovate/all-digest", ref: "renovate/all-digest", sha: headSha, repo, repo_id: repo.id },
    base: { label: "kirmanak:main", ref: "main", sha: "basesha", repo, repo_id: repo.id },
  });
}

function redCiApi(comments: string[], pr: ReturnType<typeof renovatePr>, log = "##[error]boom\n") {
  return makeIssueApi({
    getIssue: async () => makeIssue({ number: 50, title: "chore(deps)", body: "" }),
    listOpenPulls: async () => [pr],
    getPR: async () => pr,
    listIssueComments: async () => [],
    createIssueComment: async (_o, _r, _i, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_o, _r, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
    listCheckRuns: async () => [],
    listActionJobs: async () => [{ id: 9, name: "build", head_sha: pr.head.sha }],
    getActionJobLogs: async () => log,
  });
}

forEachForge("red CI behind base on a foreign PR refreshes mechanically, then runs the worker", (preset) => {
  return withDirs(async (home, workdir) => {
    const comments: string[] = [];
    let merged = false;
    let pushCalls = 0;
    let openCode = 0;
    const logs: string[] = [];
    let pr = renovatePr("headsha");
    const api = redCiApi(comments, pr) as unknown as ReturnType<typeof makeIssueApi> & {
      capabilities: unknown;
    };
    (api as { capabilities: unknown }).capabilities = preset.capabilities;
    const gitRunner = async (args: string[]) => {
      const gitArgs = stripGitConfigArgs(args);
      if (gitArgs[0] === "merge-base" && gitArgs.includes("--is-ancestor")) {
        if (merged) return "";
        throw new Error("not ancestor");
      }
      if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
      if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/renovate/all-digest")) {
        return merged ? "newsha" : "headsha";
      }
      if (gitArgs[0] === "rev-parse") return merged ? "newsha" : "headsha";
      if (gitArgs[0] === "status") return "";
      if (gitArgs[0] === "rev-list") return "0";
      if (gitArgs[0] === "push") {
        pushCalls++;
        merged = true;
        pr = renovatePr("newsha");
        (api as unknown as { listOpenPulls: unknown }).listOpenPulls = async () => [pr];
        (api as unknown as { getPR: unknown }).getPR = async () => pr;
        return "";
      }
      return "";
    };
    const jobBase = {
      mode: "follow-up" as const,
      issueNumber: 50,
      prNumber: 50,
      title: "chore(deps)",
      body: "",
      htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
      trigger: { event: "workflow_job" as const, sender: "alice" },
    };
    const first = await implementFollowUp({
      api: api as never,
      job: makeIssueJob(jobBase),
      giteaUrl: "https://gitea.kirmanak.stream",
      giteaToken: "bot-token",
      botUsername: "jumi",
      model: "openai/gpt-5.5",
      home,
      workdir,
      heartbeatIntervalMs: 0,
      gitRunner: gitRunner as never,
      openCodeRunner: async () => {
        openCode++;
        return { status: "ok" };
      },
      logger: (message: string) => {
        logs.push(message);
      },
    });
    expect(first.status).toBe("pushed");
    expect(openCode).toBe(0);
    expect(pushCalls).toBe(1);
    expect(logs.some((line) => line.includes("ci refresh: merged main@basesha without a worker run"))).toBe(true);
    expect(comments.some((body) => body.includes("ci refresh: merged main@basesha without a worker run"))).toBe(true);

    // Second red on the refreshed head with the same base SHA runs the normal CI follow-up.
    const secondLogs: string[] = [];
    const second = await implementFollowUp({
      api: api as never,
      job: makeIssueJob(jobBase),
      giteaUrl: "https://gitea.kirmanak.stream",
      giteaToken: "bot-token",
      botUsername: "jumi",
      model: "openai/gpt-5.5",
      home,
      workdir,
      heartbeatIntervalMs: 0,
      gitRunner: gitRunner as never,
      openCodeRunner: async () => {
        openCode++;
        return { status: "ok" };
      },
      logger: (message: string) => {
        secondLogs.push(message);
      },
    });
    expect(openCode).toBe(1);
    expect(second.status).not.toBe("pushed");
    expect(pushCalls).toBe(1);
  });
});

function cleanMergePr() {
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
    base: { label: "kirmanak:main", ref: "main", sha: "basesha", repo, repo_id: repo.id },
  });
}

function cleanMergeApi(comments: string[], baseState: CheckState) {
  return makeIssueApi({
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [cleanMergePr()],
    getPR: async () => cleanMergePr(),
    listIssueComments: async () => [],
    createIssueComment: async (_o, _r, _i, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_o, _r, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    listCommitStatuses: async (_o, _r, sha) =>
      String(sha) === "headsha"
        ? [{ id: 1, context: "build", status: "failure" }]
        : [{ id: 2, context: "build", status: baseState }],
    listCheckRuns: async () => [],
    listActionJobs: async (filter) =>
      (filter as { headSha?: string } | undefined)?.headSha === "headsha"
        ? [{ id: 9, name: "build", head_sha: "headsha" }]
        : [],
    getActionJobLogs: async () => "##[error]boom\n",
  });
}

function cleanMergeGitRunner() {
  return async (args: string[]) => {
    const gitArgs = stripGitConfigArgs(args);
    if (gitArgs[0] === "merge-base" && gitArgs.includes("--is-ancestor")) throw new Error("not ancestor");
    if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
    if (gitArgs[0] === "rev-parse") return "newsha";
    if (gitArgs[0] === "status") return "";
    if (gitArgs[0] === "rev-list") return "1";
    return "";
  };
}

forEachForge("a worker-only clean base merge pushes nothing and records no-changes", (preset) => {
  return withDirs(async (home, workdir) => {
    const comments: string[] = [];
    const api = cleanMergeApi(comments, "failure") as unknown as ReturnType<typeof makeIssueApi> & {
      capabilities: unknown;
    };
    (api as { capabilities: unknown }).capabilities = preset.capabilities;
    // Spend the refresh budget so the worker path runs instead of the mechanical refresh.
    const { recordCiRefreshes } = await import("../src/ci_refresh.ts");
    const { memorySkipLatchesFor } = await import("../src/skip_latches.ts");
    const store = memorySkipLatchesFor(home);
    await recordCiRefreshes({
      home,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 127,
      baseSha: "basesha",
      checkNames: ["build"],
      skipLatches: store,
    });
    const logs: string[] = [];
    const result = await implementFollowUp({
      api: api as never,
      job: makeIssueJob({
        mode: "follow-up",
        prNumber: 127,
        trigger: { event: "workflow_job", sender: "alice" },
      }),
      giteaUrl: "https://gitea.kirmanak.stream",
      giteaToken: "bot-token",
      botUsername: "jumi",
      model: "openai/gpt-5.5",
      home,
      workdir,
      heartbeatIntervalMs: 0,
      gitRunner: cleanMergeGitRunner() as never,
      openCodeRunner: async () => ({ status: "ok" }),
      logger: (message: string) => {
        logs.push(message);
      },
    });
    expect(result).toEqual({ status: "no-changes" });
    expect(logs.some((line) => line.includes("worker result was a clean base merge only; not pushed"))).toBe(true);
    expect(comments.some((body) => body.includes("worker result was a clean base merge only; not pushed"))).toBe(true);
  });
});

forEachForge("a clean base merge with green base surfaces stuck/needs_kick", (preset) => {
  return withDirs(async (home, workdir) => {
    const comments: string[] = [];
    const api = cleanMergeApi(comments, "success") as unknown as ReturnType<typeof makeIssueApi> & {
      capabilities: unknown;
    };
    (api as { capabilities: unknown }).capabilities = preset.capabilities;
    const { recordCiRefreshes } = await import("../src/ci_refresh.ts");
    const { memorySkipLatchesFor } = await import("../src/skip_latches.ts");
    const store = memorySkipLatchesFor(home);
    await recordCiRefreshes({
      home,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 127,
      baseSha: "basesha",
      checkNames: ["build"],
      skipLatches: store,
    });
    const result = await implementFollowUp({
      api: api as never,
      job: makeIssueJob({
        mode: "follow-up",
        prNumber: 127,
        trigger: { event: "workflow_job", sender: "alice" },
      }),
      giteaUrl: "https://gitea.kirmanak.stream",
      giteaToken: "bot-token",
      botUsername: "jumi",
      model: "openai/gpt-5.5",
      home,
      workdir,
      heartbeatIntervalMs: 0,
      gitRunner: cleanMergeGitRunner() as never,
      openCodeRunner: async () => ({ status: "ok" }),
      logger: () => undefined,
    });
    expect(result.status).toBe("skipped");
    expect(String((result as { reason?: unknown }).reason ?? "")).toMatch(/^stuck: /);
    expect(String((result as { reason?: unknown }).reason ?? "")).toContain("attributable to");
  });
});

forEachForge("a clean prefix merge plus a committed worker fix pushes", (preset) => {
  return withDirs(async (home, workdir) => {
    const comments: string[] = [];
    const api = cleanMergeApi(comments, "failure") as unknown as ReturnType<typeof makeIssueApi> & {
      capabilities: unknown;
    };
    (api as { capabilities: unknown }).capabilities = preset.capabilities;
    // Spend the refresh budget so the worker path runs instead of the mechanical refresh.
    const { recordCiRefreshes } = await import("../src/ci_refresh.ts");
    const { memorySkipLatchesFor } = await import("../src/skip_latches.ts");
    const store = memorySkipLatchesFor(home);
    await recordCiRefreshes({
      home,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      prNumber: 127,
      baseSha: "basesha",
      checkNames: ["build"],
      skipLatches: store,
    });
    let workerRan = false;
    const pushArgs: string[][] = [];
    const gitRunner = async (args: string[]) => {
      const gitArgs = stripGitConfigArgs(args);
      if (gitArgs[0] === "merge-base" && gitArgs.includes("--is-ancestor")) throw new Error("not ancestor");
      if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
      // The worker commits after the prefix merge, so HEAD moves.
      if (gitArgs[0] === "rev-parse") return workerRan ? "workersha" : "mergesha";
      if (gitArgs[0] === "status") return "";
      if (gitArgs[0] === "rev-list") return workerRan ? "2" : "1";
      if (gitArgs[0] === "push") {
        pushArgs.push(gitArgs);
        return "";
      }
      return "";
    };
    const logs: string[] = [];
    const result = await implementFollowUp({
      api: api as never,
      job: makeIssueJob({
        mode: "follow-up",
        prNumber: 127,
        trigger: { event: "workflow_job", sender: "alice" },
      }),
      giteaUrl: "https://gitea.kirmanak.stream",
      giteaToken: "bot-token",
      botUsername: "jumi",
      model: "openai/gpt-5.5",
      home,
      workdir,
      heartbeatIntervalMs: 0,
      gitRunner: gitRunner as never,
      openCodeRunner: async () => {
        workerRan = true;
        return { status: "ok" };
      },
      logger: (message: string) => {
        logs.push(message);
      },
    });
    expect(result.status).toBe("pushed");
    expect(pushArgs.filter((push) => push.includes("jumi/issue-12-fix-the-thing"))).toHaveLength(1);
    expect(logs.some((line) => line.includes("worker result was a clean base merge only; not pushed"))).toBe(false);
  });
});
