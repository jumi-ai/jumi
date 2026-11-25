import { describe, expect, test } from "bun:test";
import { followUpStatePath } from "../src/claim.ts";
import { implementFollowUp, writeFollowUpState } from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { markSuggestionHoldConsumed } from "../src/suggestion_hold.ts";
import { handleIssueCancel } from "../src/worker.ts";
import { cancelLedgerWorkerJobs } from "../src/worker_webhook.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser, makeWorkerConfig } from "./fixtures.ts";
import { withDirs, withWorkspace } from "./harness/temp.ts";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const key = { owner: "kirmanak", repo: "demo", issueNumber: 12 };

function jumiPr(headSha: string = HEAD) {
  const repo = makeRepo();
  return {
    ...makePR({
      number: 127,
      title: "Fix the thing",
      body: "Fixes #12",
      user: makeUser({ login: "jumi" }),
      html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    }),
    head: {
      label: "kirmanak:jumi/issue-12-fix-the-thing",
      ref: "jumi/issue-12-fix-the-thing",
      sha: headSha,
      repo,
      repo_id: repo.id,
    },
  };
}

function suggestionBody(headSha: string = HEAD): string {
  return [
    "<!-- jumi-review:kirmanak/demo#127 -->",
    "### Jumi review",
    "",
    `Reviewed commit: \`${headSha}\``,
    "",
    "src/foo.ts:12: 💡 suggestion: extract a helper",
    "<!-- jumi-check: success; 1 suggestion -->",
  ].join("\n");
}

function mixedBody(headSha: string = HEAD): string {
  return [
    "<!-- jumi-review:kirmanak/demo#127 -->",
    "### Jumi review",
    "",
    `Reviewed commit: \`${headSha}\``,
    "",
    "<!-- jumi-findings-list:start -->",
    "- 💡 [`src/foo.ts:10`](https://example.test): extract a helper",
    "- ❓ [`src/foo.ts:73`](https://example.test): maintainer: please file the follow-up issue?",
    "<!-- jumi-findings-list:end -->",
    "",
    "<!-- jumi-check: success; 1 suggestion; 1 maintainer question -->",
  ].join("\n");
}

function suggestionReview(headSha: string = HEAD) {
  return {
    id: 4110,
    body: suggestionBody(headSha),
    user: makeUser({ login: "jumi" }),
    commit_id: headSha,
    submitted_at: "2026-11-19T18:29:20Z",
    updated_at: "2026-11-19T18:29:20Z",
  };
}

function mixedSummary(headSha: string = HEAD) {
  return {
    id: 4110,
    body: mixedBody(headSha),
    user: makeUser({ login: "jumi" }),
    commit_id: headSha,
    submitted_at: "2026-11-19T18:29:20Z",
    updated_at: "2026-11-19T18:29:20Z",
  };
}

function mixedEmptyCompanion(headSha: string = HEAD) {
  return {
    id: 4109,
    body: "",
    user: makeUser({ login: "jumi" }),
    commit_id: headSha,
    submitted_at: "2026-11-19T18:29:19Z",
    updated_at: "2026-11-19T18:29:19Z",
  };
}

function suggestionInline() {
  return {
    ...makeComment({
      id: 9002,
      body: "💡 suggestion: extract a helper\n\n<!-- jumi-review:kirmanak/demo#127 -->",
      user: makeUser({ login: "jumi" }),
    }),
    path: "src/foo.ts",
    pull_request_review_id: 4109,
  };
}

function maintainerInline() {
  return {
    ...makeComment({
      id: 9001,
      body: "❓ maintainer: please file the follow-up issue?\n\n<!-- jumi-review:kirmanak/demo#127 -->",
      user: makeUser({ login: "jumi" }),
    }),
    path: "src/foo.ts",
    pull_request_review_id: 4109,
  };
}

function baseForge(
  statuses: Array<{ sha?: string; state: string; description?: string }>,
  opts: {
    pr?: ReturnType<typeof jumiPr>;
    reviews?: unknown[];
    inlines?: unknown[];
    statusesList?: Array<{ state: string; description?: string; context?: string }>;
  } = {}
) {
  const pr = opts.pr ?? jumiPr();
  return makeIssueApi({
    listOpenPulls: async () => [pr],
    getPR: async () => pr,
    getRepo: async () => makeRepo(),
    getRepoFile: async () => ({ found: false }),
    getCollaboratorPermission: async () => ({ permission: "write" }),
    listPullReviews: async () => (opts.reviews ?? [suggestionReview()]) as never,
    listIssueComments: async () => [],
    listPullReviewComments: async () => (opts.inlines ?? []) as never,
    listCommitStatuses: async () => (opts.statusesList ?? []) as never,
    createCommitStatus: async (_o: string, _r: string, sha: string, status: never) => {
      statuses.push({ sha, ...(status as { state: string; description?: string }) });
      return status;
    },
  } as never);
}

function followupApi(
  statuses: Array<{ state: string; description?: string }>,
  overrides: Record<string, unknown> = {}
): IssueApi & { comments: string[] } {
  const comments: string[] = [];
  const fake = makeIssueApi({
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [jumiPr()],
    getPR: async () => jumiPr(),
    getRepo: async () => makeRepo(),
    getRepoFile: async () => ({ found: false }),
    getCollaboratorPermission: async () => ({ permission: "write" }),
    listIssueComments: async () => [],
    listPullReviews: async () => [suggestionReview()],
    listPullReviewComments: async () => [],
    listCommitStatuses: async () => [],
    createPullRequest: async (_o: string, _r: string, pull: { title: string; body: string }) =>
      makePR({ number: 3, title: pull.title, body: pull.body }),
    createIssueComment: async (_o: string, _r: string, index: number, body: string) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_o: string, _r: string, _id: number, body: string) => {
      comments.push(body);
      return makeComment({ body });
    },
    createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
      statuses.push(status as never);
      return status;
    },
    ...overrides,
  } as never);
  return Object.assign(fake, { comments });
}

function followUpJob(overrides: Record<string, unknown> = {}) {
  return makeIssueJob({
    mode: "follow-up",
    prNumber: 127,
    trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
    ...overrides,
  } as never);
}

describe("cancel paths reuse the shared gate", () => {
  test("mixed held review: worker cancel leaves pending", async () => {
    await withWorkspace(async (home) => {
      const store = new MemoryReviewJobStore();
      await markSuggestionHoldConsumed(store.skipLatches, key, HEAD, 1);
      const statuses: Array<{ sha?: string; state: string; description?: string }> = [];
      const api = baseForge(statuses, {
        reviews: [mixedEmptyCompanion(), mixedSummary()],
        inlines: [suggestionInline(), maintainerInline()],
      });
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: unknown) => {
        logs.push(String(msg));
      };
      try {
        await handleIssueCancel(
          makeWorkerConfig({ home }),
          api as never,
          key.owner,
          key.repo,
          key.issueNumber,
          undefined,
          store
        );
      } finally {
        console.log = origLog;
      }
      expect(statuses).toHaveLength(0);
    });
  });

  test("mixed held review: ledger cancel leaves pending", async () => {
    const store = new MemoryReviewJobStore();
    await markSuggestionHoldConsumed(store.skipLatches, key, HEAD, 1);
    const statuses: Array<{ sha?: string; state: string; description?: string }> = [];
    const api = baseForge(statuses, {
      reviews: [mixedEmptyCompanion(), mixedSummary()],
      inlines: [suggestionInline(), maintainerInline()],
    });
    const logs: string[] = [];
    await cancelLedgerWorkerJobs({
      store,
      api: api as never,
      owner: key.owner,
      repo: key.repo,
      issueNumber: key.issueNumber,
      botUsername: "jumi",
      logger: (msg) => logs.push(msg),
    });
    expect(statuses).toHaveLength(0);
  });

  test("suggestion-only held review: worker cancel posts unassigned", async () => {
    await withWorkspace(async (home) => {
      const store = new MemoryReviewJobStore();
      await markSuggestionHoldConsumed(store.skipLatches, key, HEAD, 1);
      const statuses: Array<{ sha?: string; state: string; description?: string }> = [];
      const api = baseForge(statuses, { reviews: [suggestionReview()], inlines: [] });
      await handleIssueCancel(
        makeWorkerConfig({ home }),
        api as never,
        key.owner,
        key.repo,
        key.issueNumber,
        undefined,
        store
      );
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.description).toBe("1 suggestion (follow-up skipped: unassigned)");
    });
  });

  test("suggestion-only held review: ledger cancel posts unassigned", async () => {
    const store = new MemoryReviewJobStore();
    await markSuggestionHoldConsumed(store.skipLatches, key, HEAD, 1);
    const statuses: Array<{ sha?: string; state: string; description?: string }> = [];
    const api = baseForge(statuses, { reviews: [suggestionReview()], inlines: [] });
    await cancelLedgerWorkerJobs({
      store,
      api: api as never,
      owner: key.owner,
      repo: key.repo,
      issueNumber: key.issueNumber,
      botUsername: "jumi",
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.description).toBe("1 suggestion (follow-up skipped: unassigned)");
  });

  test("ledger cancel honors deployment blocking authors", async () => {
    const blockingBody = [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi review",
      "",
      `Reviewed commit: \`${HEAD}\``,
      "",
      "- \u2753 [`src/foo.ts:10`](https://example.test): what should this do?",
      "<!-- jumi-check: success; 1 question -->",
    ].join("\n");
    const blockingReview = {
      id: 4110,
      body: blockingBody,
      user: makeUser({ login: "jumi" }),
      commit_id: HEAD,
      submitted_at: "2026-11-19T18:29:20Z",
      updated_at: "2026-11-19T18:29:20Z",
    };
    // Without the deployer blocking list the generic question is not
    // blocking, so the gate posts the unchanged success note.
    {
      const store = new MemoryReviewJobStore();
      await markSuggestionHoldConsumed(store.skipLatches, key, HEAD, 1);
      const statuses: Array<{ sha?: string; state: string; description?: string }> = [];
      const api = baseForge(statuses, { reviews: [blockingReview], inlines: [] });
      await cancelLedgerWorkerJobs({
        store,
        api: api as never,
        owner: key.owner,
        repo: key.repo,
        issueNumber: key.issueNumber,
        botUsername: "jumi",
      });
      expect(statuses).toHaveLength(1);
    }
    // With the PR author on the deployer blocking list the same review
    // keeps pending: no write.
    {
      const store = new MemoryReviewJobStore();
      await markSuggestionHoldConsumed(store.skipLatches, key, HEAD, 1);
      const statuses: Array<{ sha?: string; state: string; description?: string }> = [];
      const api = baseForge(statuses, { reviews: [blockingReview], inlines: [] });
      const logs: string[] = [];
      await cancelLedgerWorkerJobs({
        store,
        api: api as never,
        owner: key.owner,
        repo: key.repo,
        issueNumber: key.issueNumber,
        botUsername: "jumi",
        logger: (msg) => logs.push(msg),
        deploymentBlocking: ["jumi"],
      });
      expect(statuses).toHaveLength(0);
      expect(logs.some((line) => line.includes("blocking-questions"))).toBe(true);
    }
  });

  test("review lookup failure: no write, one unknown log", async () => {
    const store = new MemoryReviewJobStore();
    await markSuggestionHoldConsumed(store.skipLatches, key, HEAD, 1);
    const statuses: Array<{ sha?: string; state: string; description?: string }> = [];
    const api = baseForge(statuses, { reviews: [suggestionReview()], inlines: [] });
    (api as { listPullReviews: unknown }).listPullReviews = async () => {
      throw new Error("forge exploded");
    };
    const logs: string[] = [];
    await cancelLedgerWorkerJobs({
      store,
      api: api as never,
      owner: key.owner,
      repo: key.repo,
      issueNumber: key.issueNumber,
      botUsername: "jumi",
      logger: (msg) => logs.push(msg),
    });
    expect(statuses).toHaveLength(0);
    const unknowns = logs.filter((line) => line.includes("unknown"));
    expect(unknowns).toHaveLength(1);
  });

  test("PR not found: no write, one unknown log", async () => {
    const store = new MemoryReviewJobStore();
    await markSuggestionHoldConsumed(store.skipLatches, key, HEAD, 1);
    const statuses: Array<{ sha?: string; state: string; description?: string }> = [];
    const api = makeIssueApi({
      listOpenPulls: async () => [],
      getRepo: async () => makeRepo(),
      createCommitStatus: async (_o: string, _r: string, sha: string, status: never) => {
        statuses.push({ sha, ...(status as { state: string }) });
        return status;
      },
    } as never);
    const logs: string[] = [];
    await cancelLedgerWorkerJobs({
      store,
      api: api as never,
      owner: key.owner,
      repo: key.repo,
      issueNumber: key.issueNumber,
      botUsername: "jumi",
      logger: (msg) => logs.push(msg),
    });
    expect(statuses).toHaveLength(0);
    expect(logs.filter((line) => line.includes("unknown"))).toHaveLength(1);
  });

  test("head moved: no write, one unknown log", async () => {
    const store = new MemoryReviewJobStore();
    await markSuggestionHoldConsumed(store.skipLatches, key, HEAD, 1);
    const statuses: Array<{ sha?: string; state: string; description?: string }> = [];
    const api = baseForge(statuses, {
      pr: jumiPr(OTHER_HEAD),
      reviews: [suggestionReview(OTHER_HEAD)],
      inlines: [],
    });
    const logs: string[] = [];
    await cancelLedgerWorkerJobs({
      store,
      api: api as never,
      owner: key.owner,
      repo: key.repo,
      issueNumber: key.issueNumber,
      botUsername: "jumi",
      logger: (msg) => logs.push(msg),
    });
    expect(statuses).toHaveLength(0);
    expect(logs.filter((line) => line.includes("unknown"))).toHaveLength(1);
  });
});

describe("early-exit branches reuse the shared gate", () => {
  test("mixed held review: unassigned early exit leaves pending", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
        suggestionHold: { consumed: true, headSha: HEAD, count: 1 },
      });
      const statuses: Array<{ state: string; description?: string }> = [];
      const api = followupApi(statuses, {
        getIssue: async () => makeIssue({ state: "closed" }),
        listPullReviews: async () => [mixedEmptyCompanion(), mixedSummary()],
        listPullReviewComments: async () => [suggestionInline(), maintainerInline()],
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
      expect(result).toEqual({ status: "cancelled" });
      expect(statuses).toHaveLength(0);
    });
  });

  test("mixed held review: no closing PR early exit leaves pending", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
        suggestionHold: { consumed: true, headSha: HEAD, count: 1 },
      });
      const statuses: Array<{ state: string; description?: string }> = [];
      const foreign = makePR({
        title: "Fix",
        body: "Fixes #12",
        user: makeUser({ login: "alice" }),
      });
      const api = followupApi(statuses, {
        listOpenPulls: async () => [foreign],
        getPR: async () => jumiPr(),
        listPullReviews: async () => [mixedEmptyCompanion(), mixedSummary()],
        listPullReviewComments: async () => [suggestionInline(), maintainerInline()],
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
      expect(statuses).toHaveLength(0);
    });
  });

  test("suggestion-only: unassigned early exit posts job cancelled", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
        suggestionHold: { consumed: true, headSha: HEAD, count: 1 },
      });
      const statuses: Array<{ state: string; description?: string }> = [];
      const api = followupApi(statuses, {
        getIssue: async () => makeIssue({ state: "closed" }),
        listPullReviews: async () => [suggestionReview()],
        listPullReviewComments: async () => [],
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
      expect(result).toEqual({ status: "cancelled" });
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.description).toContain("job cancelled");
    });
  });

  test("suggestion-only: no closing PR early exit posts no open jumi closing PR", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
        suggestionHold: { consumed: true, headSha: HEAD, count: 1 },
      });
      const statuses: Array<{ state: string; description?: string }> = [];
      const foreign = makePR({
        title: "Fix",
        body: "Fixes #12",
        user: makeUser({ login: "alice" }),
      });
      const api = followupApi(statuses, {
        listOpenPulls: async () => [foreign],
        getPR: async () => jumiPr(),
        listPullReviews: async () => [suggestionReview()],
        listPullReviewComments: async () => [],
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
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.description).toContain("no open jumi closing PR");
    });
  });

  test("head moved early exit: no write, one unknown log", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
        suggestionHold: { consumed: true, headSha: HEAD, count: 1 },
      });
      const statuses: Array<{ state: string; description?: string }> = [];
      const logged: string[] = [];
      const api = followupApi(statuses, {
        getIssue: async () => makeIssue({ state: "closed" }),
        listOpenPulls: async () => [jumiPr(OTHER_HEAD)],
        getPR: async () => jumiPr(OTHER_HEAD),
        listPullReviews: async () => [suggestionReview(OTHER_HEAD)],
        listPullReviewComments: async () => [],
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
        logger: (msg: string) => logged.push(msg),
      });
      expect(result).toEqual({ status: "cancelled" });
      expect(statuses).toHaveLength(0);
      expect(logged.filter((line) => line.includes("unknown"))).toHaveLength(1);
    });
  });
});
