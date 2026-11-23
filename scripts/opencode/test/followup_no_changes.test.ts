import { describe, expect, test } from "bun:test";
import { AUTOMERGE_NOTE_MARKER, AUTOMERGE_REFUSED_MARKER, retryRefusedAutomergeSchedule } from "../src/automerge.ts";
import { JUMI_REVIEW_CONTEXT } from "../src/ci.ts";
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

describe("maintainer hold release from a two-review publish pair", () => {
  const HELD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const INLINE_REVIEW_ID = 4109;
  const SUMMARY_REVIEW_ID = 4110;

  function pairBody(): string {
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

  function pairReviews() {
    return [
      {
        id: INLINE_REVIEW_ID,
        body: "",
        user: makeUser({ login: "jumi" }),
        commit_id: HELD_SHA,
        submitted_at: "2026-11-19T18:29:19Z",
        updated_at: "2026-11-19T18:29:19Z",
      },
      {
        id: SUMMARY_REVIEW_ID,
        body: pairBody(),
        user: makeUser({ login: "jumi" }),
        commit_id: HELD_SHA,
        submitted_at: "2026-11-19T18:29:20Z",
        updated_at: "2026-11-19T18:29:20Z",
      },
    ];
  }

  function pairApi(statuses: Array<{ state: string; description?: string; context?: string }>, inlines: unknown[]) {
    const human = makeComment({ id: 55, body: "answered, thanks", user: makeUser({ login: "alice" }) });
    return followupApi({
      listOpenPulls: async () => [heldPr()],
      getPR: async () => heldPr(),
      listIssueComments: async () => [human],
      listPullReviews: async () => pairReviews(),
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

  function pairMaintainerInline(reviewId = INLINE_REVIEW_ID) {
    return {
      ...makeComment({
        id: 9001,
        body: "❓ maintainer: please file the follow-up issue?\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: "jumi" }),
      }),
      path: "src/foo.ts",
      pull_request_review_id: reviewId,
    };
  }

  function pairRiskInline() {
    return {
      ...makeComment({
        id: 9002,
        body: "🟡 risk: race in the retry loop.\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: "jumi" }),
      }),
      path: "src/bar.ts",
      pull_request_review_id: INLINE_REVIEW_ID,
    };
  }

  test("empty-body companion inline releases on a trusted reply with no changes", async () => {
    await withDirs(async (home, workdir) => {
      const statuses: Array<{ state: string; description?: string; context?: string }> = [];
      const api = pairApi(statuses, [pairMaintainerInline()]);
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

  test("companion 🟡 keeps the hold and logs the counted review ids", async () => {
    await withDirs(async (home, workdir) => {
      const statuses: Array<{ state: string; description?: string; context?: string }> = [];
      const logged: string[] = [];
      const api = pairApi(statuses, [pairMaintainerInline(), pairRiskInline()]);
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
      const kept = logged.filter((line) => line.includes("maintainer hold kept"));
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.some((line) => line.includes(`${INLINE_REVIEW_ID}`) && line.includes(`${SUMMARY_REVIEW_ID}`))).toBe(
        true
      );
    });
  });
});

const NEW_RETRY_SENTENCE =
  "Jumi tries again after its next push or its next follow-up round (for example after a maintainer reply);" +
  " otherwise a person merges once reviews and CI are green.";

function refusedBody(detail = "405: User not allowed to merge PR"): string {
  return (
    `Jumi tried to schedule auto-merge on this pull request but the forge refused (${detail}). ` +
    `${NEW_RETRY_SENTENCE}\n` +
    AUTOMERGE_REFUSED_MARKER
  );
}

function refusedComment(body: string, login: string | undefined): ReturnType<typeof makeComment> {
  return makeComment({
    id: 9001,
    body: `${AUTOMERGE_NOTE_MARKER}\n${body}`,
    ...(login === undefined ? { user: undefined as never } : { user: makeUser({ login }) }),
  });
}

type GiteaAutomergeFake = IssueApi & { calls: string[]; notes: string[]; scheduled: Array<unknown> };

function giteaAutomergeApi(overrides: Record<string, unknown> = {}): GiteaAutomergeFake {
  const calls: string[] = [];
  const notes: string[] = [];
  const scheduled: Array<unknown> = [];
  const {
    listIssueComments: listIssueCommentsOverride,
    listIssueTimeline: listIssueTimelineOverride,
    getPRFiles: getPRFilesOverride,
    ...rest
  } = overrides as Record<string, unknown> & {
    listIssueComments?: unknown;
    listIssueTimeline?: unknown;
    getPRFiles?: unknown;
  };
  const fake = makeIssueApi({
    getRepo: async () => {
      calls.push("getRepo");
      return makeRepo();
    },
    getPR: async (_owner: string, _repo: string, index: number) => {
      calls.push("getPR");
      return makePR({ number: index, labels: ["automerge"] as never });
    },
    getRepoFile: async () => {
      calls.push("getRepoFile");
      return { found: true, content: "automerge: true\n" };
    },
    getBranch: async () => {
      calls.push("getBranch");
      return { protected: true, enableStatusCheck: true, requiredContexts: [JUMI_REVIEW_CONTEXT] };
    },
    scheduleAutoMerge: async () => {
      calls.push("scheduleAutoMerge");
      scheduled.push({});
    },
    cancelAutoMerge: async () => {
      calls.push("cancelAutoMerge");
      return true;
    },
    getCollaboratorPermission: async () => ({ permission: "write" }),
    createIssueComment: async (_owner: string, _repo: string, _index: number, body: string) => {
      calls.push("createIssueComment");
      notes.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner: string, _repo: string, _id: number, body: string) => {
      calls.push("updateIssueComment");
      notes.push(body);
      return makeComment({ body });
    },
    ...(listIssueCommentsOverride !== undefined ? { listIssueComments: listIssueCommentsOverride } : {}),
    ...(rest as Partial<IssueApi>),
  } as Partial<IssueApi>);
  const api = fake as unknown as GiteaAutomergeFake;
  (api as unknown as Record<string, unknown>)["listIssueTimeline"] =
    listIssueTimelineOverride !== undefined
      ? listIssueTimelineOverride
      : async () => {
          calls.push("listIssueTimeline");
          return [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
        };
  (api as unknown as Record<string, unknown>)["getPRFiles"] =
    getPRFilesOverride !== undefined
      ? getPRFilesOverride
      : async () => {
          calls.push("getPRFiles");
          return [];
        };
  return Object.assign(api, { calls, notes, scheduled });
}

function withRefusedSticky(api: GiteaAutomergeFake, body: string, login = "jumi"): void {
  (api as unknown as Record<string, unknown>)["listIssueComments"] = async () => {
    api.calls.push("listIssueComments");
    return [refusedComment(body, login)];
  };
}

describe("retryRefusedAutomergeSchedule on a Gitea fake", () => {
  test("refused at open retried through the shared helper schedules and clears the note", async () => {
    const api = giteaAutomergeApi();
    withRefusedSticky(api, refusedBody());
    const result = await retryRefusedAutomergeSchedule({
      api: api as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: true });
    expect(api.calls.filter((call) => call === "scheduleAutoMerge")).toHaveLength(1);
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain("Auto-merge is now scheduled");
  });

  test("refused again keeps the refused marker with the new reason", async () => {
    const api = giteaAutomergeApi();
    withRefusedSticky(api, refusedBody("405: User not allowed to merge PR"));
    api.scheduleAutoMerge = async () => {
      api.calls.push("scheduleAutoMerge");
      throw new Error(
        "Gitea API POST https://gitea.example.test/api/v1/repos/kirmanak/demo/pulls/3/merge → 405: " +
          '{"message":"User not allowed to merge PR"}'
      );
    };
    const result = await retryRefusedAutomergeSchedule({
      api: api as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: false });
    expect(api.calls.filter((call) => call === "scheduleAutoMerge")).toHaveLength(1);
    expect(api.notes).toHaveLength(1);
    expect(api.notes[0]).toContain(AUTOMERGE_REFUSED_MARKER);
    expect(api.notes[0]).toContain("405: User not allowed to merge PR");
  });

  test("no refused note means no schedule call", async () => {
    const absent = giteaAutomergeApi({
      listIssueComments: async () => [],
    });
    const absentResult = await retryRefusedAutomergeSchedule({
      api: absent as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(absentResult).toEqual({ scheduled: false });
    expect(absent.calls).not.toContain("scheduleAutoMerge");
    expect(absent.notes).toEqual([]);

    const personCancelled = giteaAutomergeApi({
      listIssueComments: async () => [
        makeComment({
          id: 2,
          body: `${AUTOMERGE_NOTE_MARKER}\nJumi did not schedule auto-merge: the labeller could not be read.`,
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const cancelledResult = await retryRefusedAutomergeSchedule({
      api: personCancelled as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(cancelledResult).toEqual({ scheduled: false });
    expect(personCancelled.calls).not.toContain("scheduleAutoMerge");
    expect(personCancelled.notes).toEqual([]);
  });

  test("refused markers without the bot author never trigger a schedule", async () => {
    for (const comments of [
      [refusedComment(refusedBody(), undefined)],
      [refusedComment(refusedBody(), "someone-else")],
    ]) {
      const api = giteaAutomergeApi({
        listIssueComments: async () => comments,
      });
      const result = await retryRefusedAutomergeSchedule({
        api: api as never,
        forgeKind: "gitea",
        owner: "kirmanak",
        repo: "demo",
        prNumber: 3,
        automergeRepos: ["kirmanak/demo"],
        botUsername: "jumi",
        log: () => undefined,
      });
      expect(result).toEqual({ scheduled: false });
      expect(api.calls).not.toContain("scheduleAutoMerge");
      expect(api.notes).toEqual([]);
    }
  });

  test("refused sticky plus no_automerge label makes no schedule call", async () => {
    const api = giteaAutomergeApi();
    withRefusedSticky(api, refusedBody());
    api.getPR = async (_owner: string, _repo: string, index: number) => {
      api.calls.push("getPR");
      return makePR({ number: index, labels: ["no-automerge"] as never });
    };
    const result = await retryRefusedAutomergeSchedule({
      api: api as never,
      forgeKind: "gitea",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 3,
      automergeRepos: ["kirmanak/demo"],
      botUsername: "jumi",
      log: () => undefined,
    });
    expect(result).toEqual({ scheduled: false });
    expect(api.calls).not.toContain("scheduleAutoMerge");
  });
});

describe("follow-up no-changes automerge retry", () => {
  function automergeFollowupApi(opts: {
    comments: Array<ReturnType<typeof makeComment>>;
    scheduleCalls: unknown[];
  }): ReturnType<typeof followupApi> {
    const pr = { ...jumiPr(), labels: ["automerge"] as never };
    const api = followupApi({
      listOpenPulls: async () => [pr],
      getPR: async () => pr,
      getRepo: async () => makeRepo(),
      getRepoFile: async () => ({ found: true, content: "automerge: true\n" }),
      getBranch: async () => ({
        protected: true,
        enableStatusCheck: true,
        requiredContexts: [JUMI_REVIEW_CONTEXT],
      }),
      scheduleAutoMerge: async () => {
        opts.scheduleCalls.push({});
      },
      cancelAutoMerge: async () => true,
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listIssueComments: async () => opts.comments,
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    });
    const rec = api as unknown as Record<string, unknown>;
    rec["getPRFiles"] = async () => [];
    rec["listIssueTimeline"] = async () => [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
    return api;
  }

  function dirtyGitRunner(): GitRunner {
    return async (args) => {
      const gitArgs = stripGitConfigArgs(args);
      if (gitArgs[0] === "rev-parse") return "abc123";
      if (gitArgs[0] === "status") return " M src/demo.ts";
      if (gitArgs[0] === "rev-list") return "1";
      return "";
    };
  }

  test("refused at open, trusted reply, no-changes: schedule retried exactly once", async () => {
    await withDirs(async (home, workdir) => {
      const scheduleCalls: unknown[] = [];
      const api = automergeFollowupApi({
        comments: [
          makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
          refusedComment(refusedBody(), "jumi"),
        ],
        scheduleCalls,
      });
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        forgeKind: "gitea",
        automergeRepos: ["kirmanak/demo"],
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: cleanGitRunner(),
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(scheduleCalls).toHaveLength(1);
      expect(api.comments.some((body) => body.includes("Auto-merge is now scheduled."))).toBe(true);
    });
  });

  test("mid-round no_automerge is visible to the no-changes retry", async () => {
    await withDirs(async (home, workdir) => {
      const scheduleCalls: unknown[] = [];
      const api = automergeFollowupApi({
        comments: [
          makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
          refusedComment(refusedBody(), "jumi"),
        ],
        scheduleCalls,
      });
      // Round-start snapshot still carries `automerge`; the live PR has
      // since gained `no-automerge`. The retry must honour the live labels.
      const rec = api as unknown as Record<string, unknown>;
      rec["listOpenPulls"] = async () => [{ ...jumiPr(), labels: ["automerge"] as never }];
      rec["getPR"] = async () => ({ ...jumiPr(), labels: ["no-automerge"] as never });
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        forgeKind: "gitea",
        automergeRepos: ["kirmanak/demo"],
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: cleanGitRunner(),
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(scheduleCalls).toHaveLength(0);
    });
  });

  test("pushed follow-up schedules exactly once through ensureAutomergeAfterPush", async () => {
    await withDirs(async (home, workdir) => {
      const scheduleCalls: unknown[] = [];
      const api = automergeFollowupApi({
        comments: [
          makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
          refusedComment(refusedBody(), "jumi"),
        ],
        scheduleCalls,
      });
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        forgeKind: "gitea",
        automergeRepos: ["kirmanak/demo"],
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: dirtyGitRunner(),
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      expect(scheduleCalls).toHaveLength(1);
    });
  });
});
