import { describe, expect, test } from "bun:test";
import { holdResolveNoteMarker, isResolvableHoldInline, resolveSettledHoldThreads } from "../src/hold_resolve.ts";
import { settleFollowUpHold } from "../src/hold_settlement.ts";
import { tryReleaseMaintainerHold } from "../src/maintainer_hold_release.ts";
import { MemorySkipLatchStore } from "../src/skip_latches.ts";
import { markSuggestionHoldConsumed } from "../src/suggestion_hold.ts";
import { forEachForge, makeForgeApi, makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makePR, makeRepo, makeUser } from "./fixtures.ts";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOT = "jumi";

function jumiInline(id: number, body: string, reviewId: number, login = BOT) {
  return {
    ...makeComment({ id, body, user: makeUser({ login }) }),
    path: "src/foo.ts",
    pull_request_review_id: reviewId,
  };
}

function jumiBody(text: string): string {
  return `${text}\n\n<!-- jumi-review:kirmanak/demo#127 -->`;
}

describe("isResolvableHoldInline", () => {
  test("resolves Jumi maintainer and suggestion inlines", () => {
    expect(isResolvableHoldInline(jumiInline(1, jumiBody("❓ maintainer: please file the issue?"), 10), BOT)).toBe(
      true
    );
    expect(isResolvableHoldInline(jumiInline(2, jumiBody("💡 suggestion: extract a helper"), 10), BOT)).toBe(true);
  });

  test("never resolves bugs, risks, foreign threads, or resolved threads", () => {
    expect(isResolvableHoldInline(jumiInline(3, jumiBody("🔴 bug: null deref"), 10), BOT)).toBe(false);
    expect(isResolvableHoldInline(jumiInline(4, jumiBody("🟡 risk: race in retry"), 10), BOT)).toBe(false);
    // Same review group but started by someone else.
    expect(
      isResolvableHoldInline(
        {
          ...makeComment({ id: 5, body: "❓ maintainer: mine?", user: makeUser({ login: "alice" }) }),
          path: "src/foo.ts",
          pull_request_review_id: 10,
        } as never,
        BOT
      )
    ).toBe(false);
    // Another bot.
    expect(isResolvableHoldInline(jumiInline(6, jumiBody("❓ maintainer: other bot?"), 10, "other-bot"), BOT)).toBe(
      false
    );
    // Already resolved is not a target.
    const resolved = jumiInline(7, jumiBody("❓ maintainer: done?"), 10) as Record<string, unknown>;
    resolved["resolved"] = true;
    expect(isResolvableHoldInline(resolved as never, BOT)).toBe(false);
  });
});

describe("resolveSettledHoldThreads ordering and retry", () => {
  test("release stands when resolve fails and the next wake resolves", async () => {
    const inlines = [jumiInline(9001, jumiBody("❓ maintainer: please?"), 4109)];
    const logged: string[] = [];
    let calls = 0;
    const api = {
      resolvePullComment: async () => {
        calls++;
        throw new Error("Gitea API POST /repos/o/r/pulls/comments/9001/resolve → 500: boom");
      },
    };
    const out = await resolveSettledHoldThreads({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      inlines: inlines as never,
      botUsername: BOT,
      log: (message) => logged.push(message),
    });
    expect(out).toEqual({ resolved: 0, failed: 1, permission: false });
    expect(calls).toBe(1);
    expect(logged.some((line) => line.includes("9001"))).toBe(true);

    const api2 = {
      resolvePullComment: async () => {
        calls++;
      },
    };
    const out2 = await resolveSettledHoldThreads({
      api: api2,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      inlines: inlines as never,
      botUsername: BOT,
      log: () => undefined,
    });
    expect(out2).toEqual({ resolved: 1, failed: 0, permission: false });
    expect(calls).toBe(2);
  });

  test("permission failure posts one board note", async () => {
    const inlines = [jumiInline(9001, jumiBody("❓ maintainer: please?"), 4109)];
    const created: string[] = [];
    const api = {
      resolvePullComment: async () => {
        throw new Error("Gitea API POST /repos/o/r/pulls/comments/9001/resolve → 403: forbidden");
      },
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_o: string, _r: string, _n: number, body: string) => {
        created.push(body);
        return { id: 1 };
      },
    };
    const logged: string[] = [];
    await resolveSettledHoldThreads({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      inlines: inlines as never,
      botUsername: BOT,
      log: (message) => logged.push(message),
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toContain(holdResolveNoteMarker("kirmanak", "demo", 127));
    expect(logged.some((line) => line.includes("9001"))).toBe(true);

    // Second permission failure does not duplicate the note.
    const api2 = {
      resolvePullComment: async () => {
        throw new Error("Gitea API POST /repos/o/r/pulls/comments/9001/resolve → 403: forbidden");
      },
      findStickyIssueComment: async () => ({ id: 9, body: "exists" }),
      createIssueComment: async () => {
        throw new Error("should not create twice");
      },
    };
    await resolveSettledHoldThreads({
      api: api2,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      inlines: inlines as never,
      botUsername: BOT,
      log: () => undefined,
    });
  });
});

function heldPr() {
  const repo = makeRepo();
  return makePR({
    number: 127,
    title: "Fix the thing",
    body: "Fixes #12",
    user: makeUser({ login: "jumi" }),
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    head: { label: "kirmanak:jumi/issue-12-fix", ref: "jumi/issue-12-fix", sha: HEAD, repo, repo_id: repo.id },
  });
}

function pairBody(): string {
  return [
    "<!-- jumi-review:kirmanak/demo#127 -->",
    "### Jumi review",
    "",
    `Reviewed commit: \`${HEAD}\``,
    "",
    "<!-- jumi-findings-list:start -->",
    "- 💡 [`src/foo.ts:10`](https://example.test): extract a helper",
    "- ❓ [`src/foo.ts:73`](https://example.test): maintainer: please file the follow-up issue?",
    "<!-- jumi-findings-list:end -->",
    "",
    "<!-- jumi-check: success; 1 suggestion; 1 maintainer question -->",
  ].join("\n");
}

function pairReviews() {
  return [
    {
      id: 4109,
      body: "",
      user: makeUser({ login: BOT }),
      commit_id: HEAD,
      submitted_at: "2026-11-19T18:29:19Z",
      updated_at: "2026-11-19T18:29:19Z",
    },
    {
      id: 4110,
      body: pairBody(),
      user: makeUser({ login: BOT }),
      commit_id: HEAD,
      submitted_at: "2026-11-19T18:29:20Z",
      updated_at: "2026-11-19T18:29:20Z",
    },
  ];
}

describe("settleFollowUpHold resolves held threads", () => {
  test("trusted reply releases and resolves the answered maintainer thread", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const resolvedIds: number[] = [];
    const suggestion = {
      ...makeComment({
        id: 9002,
        body: "💡 suggestion: extract a helper\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: BOT }),
      }),
      path: "src/foo.ts",
      pull_request_review_id: 4109,
    };
    const maintainer = {
      ...makeComment({
        id: 9001,
        body: "❓ maintainer: please file the follow-up issue?\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: BOT }),
      }),
      path: "src/foo.ts",
      pull_request_review_id: 4109,
    };
    const human = makeComment({ id: 55, body: "answered, thanks", user: makeUser({ login: "alice" }) });
    const api = makeIssueApi({
      listOpenPulls: async () => [heldPr()],
      getPR: async () => heldPr(),
      listIssueComments: async () => [human],
      listPullReviews: async () => pairReviews(),
      listPullReviewComments: async () => [suggestion, maintainer],
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        statuses.push(status as never);
        return status;
      },
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listCommitStatuses: async () => [],
      resolvePullComment: async (_o: string, _r: string, commentId: number) => {
        resolvedIds.push(commentId);
      },
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => ({ id: 1, body: "", user: { login: BOT } }) as never,
    } as never);
    const store = new MemorySkipLatchStore();
    const latchKey = { owner: "kirmanak", repo: "demo", issueNumber: 12 };
    await markSuggestionHoldConsumed(store, latchKey, HEAD, 1);
    const logged: string[] = [];
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: store,
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      botUsername: BOT,
      defaultBranch: "main",
      log: (message) => logged.push(message),
      targetUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    });
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(resolvedIds).toContain(9001);
    expect(logged.some((line) => line.includes("maintainer hold released"))).toBe(true);
  });

  test("suggestion cleanup resolves the suggestion and leaves bug and foreign threads open", async () => {
    const statuses: Array<{ state: string }> = [];
    const resolvedIds: number[] = [];
    const summaryOnly = [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi review",
      "",
      `Reviewed commit: \`${HEAD}\``,
      "",
      "src/foo.ts:12: 💡 suggestion: extract a helper",
      "<!-- jumi-check: success; 1 suggestion -->",
    ].join("\n");
    const review = {
      id: 4110,
      body: summaryOnly,
      user: makeUser({ login: BOT }),
      commit_id: HEAD,
      submitted_at: "2026-11-19T18:29:20Z",
      updated_at: "2026-11-19T18:29:20Z",
    };
    const suggestion = {
      ...makeComment({
        id: 9002,
        body: "💡 suggestion: extract a helper\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: BOT }),
      }),
      path: "src/foo.ts",
      pull_request_review_id: 4110,
    };
    // Same review group but started by someone else: never resolved.
    const foreign = {
      ...makeComment({ id: 9003, body: "❓ maintainer: mine?", user: makeUser({ login: "alice" }) }),
      path: "src/foo.ts",
      pull_request_review_id: 4110,
    };
    // Open Jumi bug on another review: outside the held group, left open.
    const bugElsewhere = {
      ...makeComment({
        id: 9004,
        body: "🔴 bug: null deref\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: BOT }),
      }),
      path: "src/foo.ts",
      pull_request_review_id: 5555,
    };
    const api = makeIssueApi({
      listOpenPulls: async () => [heldPr()],
      getPR: async () => heldPr(),
      listIssueComments: async () => [makeComment({ id: 55, body: "thanks", user: makeUser({ login: "alice" }) })],
      listPullReviews: async () => [review],
      listPullReviewComments: async () => [suggestion, foreign, bugElsewhere],
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        statuses.push(status as never);
        return status;
      },
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listCommitStatuses: async () => [],
      resolvePullComment: async (_o: string, _r: string, commentId: number) => {
        resolvedIds.push(commentId);
      },
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => ({ id: 1, body: "", user: { login: BOT } }) as never,
    } as never);
    const store = new MemorySkipLatchStore();
    const latchKey = { owner: "kirmanak", repo: "demo", issueNumber: 12 };
    await markSuggestionHoldConsumed(store, latchKey, HEAD, 1);
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: store,
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "workflow_job", sender: "jumi" },
      botUsername: BOT,
      defaultBranch: "main",
      log: () => undefined,
    });
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(resolvedIds).toContain(9002);
    expect(resolvedIds).not.toContain(9003);
    expect(resolvedIds).not.toContain(9004);
  });

  test("failed resolve keeps the release and retries on the next wake", async () => {
    const statuses: Array<{ state: string }> = [];
    const resolvedIds: number[] = [];
    const maintainer = {
      ...makeComment({
        id: 9001,
        body: "❓ maintainer: please file the follow-up issue?\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: BOT }),
      }),
      path: "src/foo.ts",
      pull_request_review_id: 4109,
    };
    const suggestion = {
      ...makeComment({
        id: 9002,
        body: "💡 suggestion: extract a helper\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: BOT }),
      }),
      path: "src/foo.ts",
      pull_request_review_id: 4109,
    };
    let failResolve = true;
    const human = makeComment({ id: 55, body: "answered", user: makeUser({ login: "alice" }) });
    const api = makeIssueApi({
      listOpenPulls: async () => [heldPr()],
      getPR: async () => heldPr(),
      listIssueComments: async () => [human],
      listPullReviews: async () => pairReviews(),
      listPullReviewComments: async () => [suggestion, maintainer],
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        statuses.push(status as never);
        return status;
      },
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listCommitStatuses: async () => [],
      resolvePullComment: async (_o: string, _r: string, commentId: number) => {
        if (failResolve) throw new Error(`Gitea API POST /x → 500: boom ${commentId}`);
        resolvedIds.push(commentId);
      },
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => ({ id: 1, body: "", user: { login: BOT } }) as never,
    } as never);
    const store = new MemorySkipLatchStore();
    const latchKey = { owner: "kirmanak", repo: "demo", issueNumber: 12 };
    await markSuggestionHoldConsumed(store, latchKey, HEAD, 1);
    const logged: string[] = [];
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: store,
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      botUsername: BOT,
      defaultBranch: "main",
      log: (message) => logged.push(message),
    });
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(resolvedIds).toHaveLength(0);
    expect(logged.some((line) => line.includes("9001"))).toBe(true);

    // Next wake: the status is already success, so nothing re-posts, but the
    // still-open threads resolve.
    failResolve = false;
    const api2 = makeIssueApi({
      listOpenPulls: async () => [heldPr()],
      getPR: async () => heldPr(),
      listIssueComments: async () => [human],
      listPullReviews: async () => pairReviews(),
      listPullReviewComments: async () => [suggestion, maintainer],
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        statuses.push(status as never);
        return status;
      },
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listCommitStatuses: async () => [
        { context: "jumi/opencode-review", state: "success", description: "No blocking issues" } as never,
      ],
      resolvePullComment: async (_o: string, _r: string, commentId: number) => {
        resolvedIds.push(commentId);
      },
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => ({ id: 1, body: "", user: { login: BOT } }) as never,
    } as never);
    await settleFollowUpHold({
      api: api2,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: store,
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      botUsername: BOT,
      defaultBranch: "main",
      log: () => undefined,
    });
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(resolvedIds).toContain(9001);
  });
});

describe("tryReleaseMaintainerHold resolves held threads", () => {
  function nonJumiPr(sha = HEAD) {
    const repo = makeRepo();
    return makePR({
      number: 15,
      title: "Chronicle of Lenora",
      body: "Lore update",
      user: makeUser({ login: "sampo" }),
      assignee: null,
      assignees: [],
      html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/15",
      head: {
        label: "kirmanak:lore/lenora-chronicle-kildrak",
        ref: "lore/lenora-chronicle-kildrak",
        sha,
        repo,
        repo_id: repo.id,
      },
    });
  }

  test("release-only path on a non-Jumi PR resolves the answered thread", async () => {
    const statuses: Array<{ state: string }> = [];
    const resolvedIds: number[] = [];
    const api = {
      getPR: async () => nonJumiPr(),
      listPullReviews: async () => [],
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: [
            "<!-- jumi-review:kirmanak/demo#15 -->",
            "### Jumi review",
            "",
            `Reviewed commit: \`${HEAD}\``,
            "",
            "src/table.ts:12: ❓ maintainer: can the table see that?",
            "<!-- jumi-check: success -->",
          ].join("\n"),
          user: makeUser({ login: BOT }),
        }),
      ],
      listPullReviewComments: async () => [
        jumiInline(9001, "❓ maintainer: can the table see that?\n\n<!-- jumi-review:kirmanak/demo#15 -->", 1),
      ],
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        statuses.push(status as never);
        return status;
      },
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      resolvePullComment: async (_o: string, _r: string, commentId: number) => {
        resolvedIds.push(commentId);
      },
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => ({ id: 1 }) as never,
    };
    const logged: string[] = [];
    const outcome = await tryReleaseMaintainerHold({
      api: api as never,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 15,
      senderLogin: "kirmanak",
      botUsername: BOT,
      trustedSenderLogins: [],
      followupIgnoreLogins: [],
      defaultBranch: "main",
      logger: (message) => logged.push(message),
    });
    expect(outcome.outcome).toBe("released");
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(resolvedIds).toEqual([9001]);
    expect(logged.some((line) => line.includes("maintainer hold released"))).toBe(true);
  });
});

forEachForge("hold resolve through the shared port", async (preset) => {
  const resolvedIds: number[] = [];
  const api = makeForgeApi({
    capabilities: preset.capabilities,
    resolvePullComment: async (_owner: string, _repo: string, commentId: number) => {
      resolvedIds.push(commentId);
    },
  });
  const out = await resolveSettledHoldThreads({
    api: api as never,
    owner: "kirmanak",
    repo: "demo",
    prNumber: 127,
    inlines: [jumiInline(9001, jumiBody("❓ maintainer: please?"), 4109)] as never,
    botUsername: BOT,
    log: () => undefined,
  });
  expect(out).toEqual({ resolved: 1, failed: 0, permission: false });
  expect(resolvedIds).toEqual([9001]);
});
