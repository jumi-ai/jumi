import { describe, expect, test } from "bun:test";
import { implementFollowUp } from "../src/followup.ts";
import { FORGE_CAPABILITIES } from "../src/forge_capabilities.ts";
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
  overrides: Parameters<typeof makeIssueApi>[0] = {}
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

  test("git token in the reason is redacted before reaching the forge", async () => {
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
            reason: "Already addressed in abc123 with bot-token.",
          });
          expect(out.ok).toBe(true);
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      const last = api.comments.at(-1) ?? "";
      expect(last).toContain("no follow-up changes:");
      expect(last).not.toContain("bot-token");
      expect(last).toContain("***");
    });
  });
});

describe("maintainer hold release", () => {
  const HELD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  function maintainerSticky(body: string, sha = HELD_SHA): ReturnType<typeof makeComment> {
    return makeComment({
      id: 38022,
      body: [
        "<!-- jumi-review:kirmanak/demo#127 -->",
        "### Jumi review",
        "",
        `Reviewed commit: \`${sha}\``,
        "",
        body,
      ].join("\n"),
      user: makeUser({ login: "jumi" }),
    });
  }

  function heldPr() {
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
        sha: HELD_SHA,
        repo,
        repo_id: repo.id,
      },
    });
  }

  function maintainerApi(
    statuses: Array<{ state: string; description?: string; context?: string }>,
    stickyBody: string,
    caps = FORGE_CAPABILITIES.gitea
  ) {
    const sticky = maintainerSticky(stickyBody);
    const human = makeComment({ id: 55, body: "looks good, thanks", user: makeUser({ login: "alice" }) });
    return followupApi({
      capabilities: caps,
      listOpenPulls: async () => [heldPr()],
      listIssueComments: async () => [human, sticky],
      createCommitStatus: async (
        _owner: string,
        _repo: string,
        _sha: string,
        status: { state: string; description?: string; context?: string }
      ) => {
        statuses.push(status);
        return status as never;
      },
    } as never);
  }

  for (const [forgeLabel, caps] of [
    ["gitea", FORGE_CAPABILITIES.gitea],
    ["github", FORGE_CAPABILITIES.github],
  ] as const) {
    test(`trusted reply with no changes releases the held head to success on ${forgeLabel}`, async () => {
      await withDirs(async (home, workdir) => {
        const statuses: Array<{ state: string; description?: string; context?: string }> = [];
        const api = maintainerApi(
          statuses,
          "src/foo.ts:12: ❓ maintainer: please file the follow-up issue?\n<!-- jumi-check: success -->",
          caps
        );
        expect((api as unknown as { capabilities: unknown }).capabilities).toBe(caps);
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
        const success = statuses.filter((status) => status.state === "success");
        expect(success.length).toBeGreaterThan(0);
        expect(success.at(-1)?.description).toBe("No blocking issues");
      });
    });

    test(`held review with a 💡 keeps the suggestion count on release on ${forgeLabel}`, async () => {
      await withDirs(async (home, workdir) => {
        const statuses: Array<{ state: string; description?: string; context?: string }> = [];
        const api = maintainerApi(
          statuses,
          [
            "src/foo.ts:12: ❓ maintainer: please file the follow-up issue?",
            "src/foo.ts:13: 💡 simpler: extract a helper",
            "<!-- jumi-check: success; 1 suggestion -->",
          ].join("\n"),
          caps
        );
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
        const success = statuses.filter((status) => status.state === "success");
        expect(success.length).toBeGreaterThan(0);
        expect(success.at(-1)?.description).toBe("1 suggestion");
      });
    });

    test(`trusted reply that pushes posts no success on the old head on ${forgeLabel}`, async () => {
      await withDirs(async (home, workdir) => {
        const statuses: Array<{ state: string; description?: string; context?: string }> = [];
        const api = maintainerApi(
          statuses,
          "src/foo.ts:12: ❓ maintainer: please file the follow-up issue?\n<!-- jumi-check: success -->",
          caps
        );
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
        expect(result.status).toBe("pushed");
        expect(gitCalls.some((args) => args[0] === "push")).toBe(true);
        expect(statuses.filter((status) => status.state === "success")).toHaveLength(0);
      });
    });

    test(`failure with 🔴 plus ❓ maintainer: stays failed after no-changes on ${forgeLabel}`, async () => {
      await withDirs(async (home, workdir) => {
        const statuses: Array<{ state: string; description?: string; context?: string }> = [];
        const api = maintainerApi(
          statuses,
          [
            "src/foo.ts:12: 🔴 bug: null deref. Guard it.",
            "src/foo.ts:13: ❓ maintainer: please file the follow-up issue?",
            "<!-- jumi-check: failure; 1 blocking -->",
          ].join("\n"),
          caps
        );
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
        expect(statuses.filter((status) => status.state === "success")).toHaveLength(0);
      });
    });

    test(`failure with 🟡 plus ❓ maintainer: stays failed after no-changes on ${forgeLabel}`, async () => {
      await withDirs(async (home, workdir) => {
        const statuses: Array<{ state: string; description?: string; context?: string }> = [];
        const api = maintainerApi(
          statuses,
          [
            "src/foo.ts:12: 🟡 risk: race in the retry loop.",
            "src/foo.ts:13: ❓ maintainer: please file the follow-up issue?",
            "<!-- jumi-check: failure; 1 risk -->",
          ].join("\n"),
          caps
        );
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
        expect(statuses.filter((status) => status.state === "success")).toHaveLength(0);
      });
    });
  }
});

describe("maintainer hold release from inlines", () => {
  const HELD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const REVIEW_ID = 9101;

  function inlineReviewBody(): string {
    return [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi review",
      "",
      `Reviewed commit: \`${HELD_SHA}\``,
      "",
      "<!-- jumi-findings-list:start -->",
      "- ❓ [`src/foo.ts:73`](https://gitea.kirmanak.stream/kirmanak/demo/pulls/127#issuecomment-1): maintainer: please file the follow-up issue?",
      "<!-- jumi-findings-list:end -->",
      "",
      "<!-- jumi-check: success; 1 maintainer question -->",
    ].join("\n");
  }

  function heldPr() {
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
        sha: HELD_SHA,
        repo,
        repo_id: repo.id,
      },
    });
  }

  function inlineApi(statuses: Array<{ state: string; description?: string; context?: string }>, inlines: unknown[]) {
    const review = {
      id: REVIEW_ID,
      body: inlineReviewBody(),
      user: makeUser({ login: "jumi" }),
      commit_id: HELD_SHA,
      submitted_at: "2026-11-19T06:47:00Z",
      updated_at: "2026-11-19T06:47:00Z",
    };
    const human = makeComment({ id: 55, body: "answered, thanks", user: makeUser({ login: "alice" }) });
    return followupApi({
      listOpenPulls: async () => [heldPr()],
      getPR: async () => heldPr(),
      listIssueComments: async () => [human],
      listPullReviews: async () => [review],
      listPullReviewComments: async () => inlines,
      createCommitStatus: async (
        _owner: string,
        _repo: string,
        _sha: string,
        status: { state: string; description?: string; context?: string }
      ) => {
        statuses.push(status);
        return status as never;
      },
    } as never);
  }

  function maintainerInline() {
    return {
      ...makeComment({
        id: 9001,
        body: "❓ maintainer: please file the follow-up issue?\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: "jumi" }),
      }),
      path: "src/foo.ts",
      pull_request_review_id: REVIEW_ID,
    };
  }

  function riskInline() {
    return {
      ...makeComment({
        id: 9002,
        body: "🟡 risk: race in the retry loop.\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: "jumi" }),
      }),
      path: "src/bar.ts",
      pull_request_review_id: REVIEW_ID,
    };
  }

  test("inline-only ❓ maintainer: releases on a trusted reply with no changes", async () => {
    await withDirs(async (home, workdir) => {
      const statuses: Array<{ state: string; description?: string; context?: string }> = [];
      const api = inlineApi(statuses, [maintainerInline()]);
      const logged: string[] = [];
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
        logger: (message: string) => {
          logged.push(message);
        },
      });
      expect(result).toEqual({ status: "no-changes" });
      const success = statuses.filter((status) => status.state === "success");
      expect(success.length).toBeGreaterThan(0);
      expect(success.at(-1)?.description).toBe("No blocking issues");
      expect(logged.some((line) => line.includes("maintainer hold released") && line.includes("1 answered"))).toBe(
        true
      );
    });
  });

  test("inline 🟡 on the same review keeps the hold and logs the kept reason", async () => {
    await withDirs(async (home, workdir) => {
      const statuses: Array<{ state: string; description?: string; context?: string }> = [];
      const logged: string[] = [];
      const api = inlineApi(statuses, [maintainerInline(), riskInline()]);
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
        logger: (message: string) => {
          logged.push(message);
        },
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(statuses.filter((status) => status.state === "success")).toHaveLength(0);
      expect(logged.some((line) => line.includes("maintainer hold kept"))).toBe(true);
    });
  });
});
