import { describe, expect, test } from "bun:test";
import { JUMI_REVIEW_CONTEXT } from "../src/ci.ts";
import { resolveExhaustedFollowUpHoldOrThrow } from "../src/exhausted_hold.ts";
import {
  assessMaintainerHoldRelease,
  blockingOpenQuestionCountWithInlines,
  isBlockingQuestionInline,
} from "../src/followup.ts";
import { settleFollowUpHold } from "../src/hold_settlement.ts";
import type { Check } from "../src/ports.ts";
import { publishReviewResult } from "../src/review.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import type { ReviewRecord } from "../src/review_verdict_store.ts";
import { MemorySkipLatchStore } from "../src/skip_latches.ts";
import { markSuggestionHoldConsumed } from "../src/suggestion_hold.ts";
import {
  blockingOpenQuestionCount,
  countNonMaintainerQuestionFindings,
  isNonMaintainerQuestionInline,
  reviewVerdictView,
} from "../src/verdict.ts";
import { makeIssueApi, makeReviewApi } from "./fakes/forge.ts";
import { makeBranch, makeComment, makeFile, makePR, makeRepo, makeUser } from "./fixtures.ts";

const HEAD = "a08988b2a08988b2a08988b2a08988b2a08988b2";
const BLOCKING = ["renovate-bot"];
const BOT = "jumi";

const MAINTAINER_ONLY = [
  "src/foo.ts:12: ❓ maintainer: please file a follow-up issue?",
  "<!-- jumi-check: success -->",
].join("\n");

const MIXED = [
  "src/foo.ts:12: ❓ maintainer: please file a follow-up issue?",
  "src/bar.ts:7: ❓ q: is the timeout intentional?",
  "<!-- jumi-check: success -->",
].join("\n");

const ORDINARY_ONLY = ["src/bar.ts:7: ❓ q: is the timeout intentional?", "<!-- jumi-check: success -->"].join("\n");

function openInline(id: number, body: string, path = "src/foo.ts") {
  return {
    ...makeComment({ id, body: `${body}\n\n<!-- jumi-review:kirmanak/demo#127 -->`, user: makeUser({ login: BOT }) }),
    path,
    pull_request_review_id: 4342,
  };
}

describe("issue #926: maintainer questions are never blocking questions", () => {
  test("text counter excludes ❓ maintainer: for a listed author", () => {
    expect(blockingOpenQuestionCount(MAINTAINER_ONLY, "renovate-bot", BLOCKING)).toBe(0);
    expect(countNonMaintainerQuestionFindings(MAINTAINER_ONLY)).toBe(0);
    expect(blockingOpenQuestionCount(MIXED, "renovate-bot", BLOCKING)).toBe(1);
    expect(countNonMaintainerQuestionFindings(MIXED)).toBe(1);
    expect(blockingOpenQuestionCount(ORDINARY_ONLY, "renovate-bot", BLOCKING)).toBe(1);
    // Unlisted author stays zero either way.
    expect(blockingOpenQuestionCount(MAINTAINER_ONLY, "alice", BLOCKING)).toBe(0);
    expect(blockingOpenQuestionCount(MIXED, "alice", BLOCKING)).toBe(0);
  });

  test("record path agrees: question minus maintainer count", () => {
    const maintainerOnly: ReviewRecord = {
      version: 1,
      state: "success",
      reason: "No blocking issues",
      findings: [
        {
          id: "1",
          path: "src/foo.ts",
          line: 12,
          severity: "question",
          title: "❓ maintainer: please decide?",
          body: "detail",
        },
      ],
      counts: { bug: 0, risk: 0, question: 1, suggestion: 0, maintainerQuestion: 1 },
    };
    const mixed: ReviewRecord = {
      version: 1,
      state: "success",
      reason: "No blocking issues",
      findings: [
        {
          id: "1",
          path: "src/foo.ts",
          line: 12,
          severity: "question",
          title: "❓ maintainer: please decide?",
          body: "detail",
        },
        { id: "2", path: "src/bar.ts", line: 7, severity: "question", title: "❓ q: is this right?", body: "detail" },
      ],
      counts: { bug: 0, risk: 0, question: 2, suggestion: 0, maintainerQuestion: 1 },
    };
    const textMaintainer = reviewVerdictView({ markdown: MAINTAINER_ONLY });
    const textMixed = reviewVerdictView({ markdown: MIXED });
    expect(textMaintainer.blockingQuestionCount("renovate-bot", BLOCKING)).toBe(0);
    expect(
      reviewVerdictView({ markdown: MAINTAINER_ONLY, record: maintainerOnly }).blockingQuestionCount(
        "renovate-bot",
        BLOCKING
      )
    ).toBe(0);
    expect(textMixed.blockingQuestionCount("renovate-bot", BLOCKING)).toBe(1);
    expect(reviewVerdictView({ markdown: MIXED, record: mixed }).blockingQuestionCount("renovate-bot", BLOCKING)).toBe(
      1
    );
  });

  test("inline counters exclude ❓ maintainer: inlines", () => {
    const ordinary = openInline(9001, "❓ q: is the timeout intentional?");
    const maintainer = openInline(9002, "❓ maintainer: please file a follow-up issue?");
    expect(isBlockingQuestionInline(ordinary, BOT)).toBe(true);
    expect(isBlockingQuestionInline(maintainer, BOT)).toBe(false);
    expect(isNonMaintainerQuestionInline(maintainer.path, maintainer.body)).toBe(false);
    expect(isNonMaintainerQuestionInline(ordinary.path, ordinary.body)).toBe(true);

    const emptySuccess = `Reviewed commit: \`${HEAD}\`\n\n<!-- jumi-check: success -->`;
    expect(blockingOpenQuestionCountWithInlines(emptySuccess, [maintainer], "renovate-bot", BLOCKING, BOT)).toBe(0);
    expect(blockingOpenQuestionCountWithInlines(emptySuccess, [ordinary], "renovate-bot", BLOCKING, BOT)).toBe(1);
    expect(blockingOpenQuestionCountWithInlines(MAINTAINER_ONLY, [maintainer], "renovate-bot", BLOCKING, BOT)).toBe(0);
    expect(blockingOpenQuestionCountWithInlines(MAINTAINER_ONLY, [ordinary], "renovate-bot", BLOCKING, BOT)).toBe(1);
    expect(blockingOpenQuestionCountWithInlines(MIXED, [], "renovate-bot", BLOCKING, BOT)).toBe(1);
  });

  test("maintainer hold releases for a listed blocking author with an authorized reply shape", () => {
    const releasable = assessMaintainerHoldRelease({
      reviewBody: MAINTAINER_ONLY,
      inlines: [],
      prAuthorLogin: "renovate-bot",
      blockingAuthors: BLOCKING,
      botUsername: BOT,
      holdEnabled: true,
    });
    expect(releasable.releasable).toBe(true);
    expect(releasable.openBlockingQuestions).toBe(0);
    expect(releasable.openMaintainers).toBe(1);
    expect(releasable.completeSuccess).toBe(true);

    const mixed = assessMaintainerHoldRelease({
      reviewBody: MIXED,
      inlines: [],
      prAuthorLogin: "renovate-bot",
      blockingAuthors: BLOCKING,
      botUsername: BOT,
      holdEnabled: true,
    });
    expect(mixed.releasable).toBe(false);
    expect(mixed.openBlockingQuestions).toBe(1);
    expect(mixed.keepReason).toBe("1 blocking questions");
  });
});

describe("issue #926: blocking-author publish posts a maintainer hold, not a failure", () => {
  const holdOpts = {
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    expectedHeadSha: "headsha",
    botUsername: "jumi",
    logger: () => undefined,
  };

  function blockingApi(statuses: Array<{ state: string; description?: string; context?: string }>, settings?: string) {
    return makeReviewApi({
      getPR: async () => makePR({ head: makeBranch({ sha: "headsha" }) }),
      getPRFiles: async () => [makeFile()],
      getRepoFile: async () => (settings === undefined ? { found: false } : { found: true, content: settings }),
      createPullReview: async () => ({ id: 1 }),
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        statuses.push(status as never);
        return status;
      },
    });
  }

  test("maintainer-only review on a blocking author holds as pending with a success trailer", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const bodies: string[] = [];
    const api = makeReviewApi({
      getPR: async () => makePR({ head: makeBranch({ sha: "headsha" }) }),
      getPRFiles: async () => [makeFile()],
      getRepoFile: async () => ({ found: false }),
      createPullReview: async (_o: string, _r: string, _i: number, review: unknown) => {
        const body = (review as { body?: unknown }).body;
        if (typeof body === "string") bodies.push(body);
        return { id: 1 };
      },
      createIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
        bodies.push(body);
        return makeComment({ id: 1, body });
      },
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        statuses.push(status as never);
        return status;
      },
    });
    const result = await publishReviewResult({
      ...holdOpts,
      blockingQuestionAuthors: ["alice"],
      resultMarkdown: "src/foo.ts:12: ❓ maintainer: please file the follow-up issue?\n<!-- jumi-check: success -->",
      api,
    });
    expect(result).toEqual({ status: "posted" });
    expect(statuses.at(-1)).toMatchObject({ state: "pending", description: "waiting on maintainer: 1 question" });
  });

  test("ordinary plus maintainer ❓ fails with 1 open question on a blocking author", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const result = await publishReviewResult({
      ...holdOpts,
      blockingQuestionAuthors: ["alice"],
      resultMarkdown: MIXED,
      api: blockingApi(statuses, undefined),
    });
    expect(result).toEqual({ status: "posted" });
    expect(statuses.at(-1)).toMatchObject({ state: "failure", description: "1 open question" });
  });

  test("maintainer-only review with the hold off posts success on a blocking author", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const result = await publishReviewResult({
      ...holdOpts,
      blockingQuestionAuthors: ["alice"],
      resultMarkdown: "src/foo.ts:12: ❓ maintainer: please file the follow-up issue?\n<!-- jumi-check: success -->",
      api: blockingApi(statuses, "maintainer_questions_hold_merge: false\n"),
    });
    expect(result).toEqual({ status: "posted" });
    expect(statuses.at(-1)).toMatchObject({ state: "success" });
    expect(statuses.at(-1)?.description).not.toContain("waiting on maintainer");
  });
});

describe("issue #926: settlement and exhausted holds read the newest status", () => {
  // #7007 history: oldest pending running, failure, pending running, newest failure.
  // Distinct ids plus timestamps keep latestStatuses order-independent.
  function failureHistory(): Check[] {
    return [
      {
        id: 1,
        context: JUMI_REVIEW_CONTEXT,
        state: "pending",
        description: "Jumi review is running",
        updated_at: "2026-11-26T12:34:35Z",
      },
      {
        id: 2,
        context: JUMI_REVIEW_CONTEXT,
        state: "failure",
        description: "1 open question",
        updated_at: "2026-11-26T12:36:46Z",
      },
      {
        id: 3,
        context: JUMI_REVIEW_CONTEXT,
        state: "pending",
        description: "Jumi review is running",
        updated_at: "2026-11-26T12:41:03Z",
      },
      {
        id: 4,
        context: JUMI_REVIEW_CONTEXT,
        state: "failure",
        description: "1 open question",
        updated_at: "2026-11-26T12:42:19Z",
      },
    ];
  }

  function maintainerHistory(): Check[] {
    return [
      {
        id: 1,
        context: JUMI_REVIEW_CONTEXT,
        state: "pending",
        description: "Jumi review is running",
        updated_at: "2026-11-26T12:34:35Z",
      },
      {
        id: 2,
        context: JUMI_REVIEW_CONTEXT,
        state: "failure",
        description: "1 open question",
        updated_at: "2026-11-26T12:36:46Z",
      },
      {
        id: 3,
        context: JUMI_REVIEW_CONTEXT,
        state: "pending",
        description: "Jumi review is running",
        updated_at: "2026-11-26T12:41:03Z",
      },
      {
        id: 4,
        context: JUMI_REVIEW_CONTEXT,
        state: "pending",
        description: "waiting on maintainer: 1 question",
        updated_at: "2026-11-26T12:42:19Z",
      },
    ];
  }

  function maintainerReviewBody() {
    return [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi review",
      "",
      `Reviewed commit: \`${HEAD}\``,
      "",
      "src/foo.ts:12: ❓ maintainer: please file a follow-up issue?",
      "<!-- jumi-check: success; 1 maintainer question -->",
    ].join("\n");
  }

  function blockingPr() {
    const repo = makeRepo();
    return makePR({
      number: 127,
      user: makeUser({ login: "renovate-bot" }),
      head: { label: "kirmanak:feature", ref: "feature", sha: HEAD, repo, repo_id: repo.id },
      html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    });
  }

  async function settleWithStatuses(history: Check[]) {
    const posted: Array<{ state: string; description?: string }> = [];
    const logged: string[] = [];
    const review = {
      id: 4342,
      body: maintainerReviewBody(),
      user: makeUser({ login: BOT }),
      commit_id: HEAD,
      submitted_at: "2026-11-26T12:42:20Z",
      updated_at: "2026-11-26T12:42:20Z",
    };
    const api = makeIssueApi({
      listOpenPulls: async () => [blockingPr()],
      getPR: async () => blockingPr(),
      listIssueComments: async () => [],
      listPullReviews: async () => [review],
      listPullReviewComments: async () => [],
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        posted.push(status as never);
        return status;
      },
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listCommitStatuses: async () => history,
    } as never);
    const latches = new MemorySkipLatchStore();
    await markSuggestionHoldConsumed(latches, { owner: "kirmanak", repo: "demo", issueNumber: 12 }, HEAD, 1);
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches,
      latchKey: { owner: "kirmanak", repo: "demo", issueNumber: 12 },
      intent: { kind: "completed" },
      trigger: { event: "workflow_job", sender: "jumi" },
      botUsername: BOT,
      defaultBranch: "main",
      deploymentBlocking: ["renovate-bot"],
      log: (message) => logged.push(message),
      targetUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    });
    return { posted, logged };
  }

  test("newest failure settles as not-pending in both forge orders (no other-hold)", async () => {
    for (const history of [failureHistory(), [...failureHistory()].reverse()]) {
      const { posted, logged } = await settleWithStatuses(history);
      expect(posted).toHaveLength(0);
      expect(logged.some((line) => line.includes("other-hold"))).toBe(false);
    }
  });

  test("newest pending maintainer still settles as a maintainer hold in both orders", async () => {
    for (const history of [maintainerHistory(), [...maintainerHistory()].reverse()]) {
      const { posted, logged } = await settleWithStatuses(history);
      expect(posted).toHaveLength(0);
      const kept = logged.filter((line) => line.includes("maintainer hold kept"));
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.some((line) => line.includes("no-authorized-reply"))).toBe(true);
      expect(kept.some((line) => line.includes("blocking=0"))).toBe(true);
      expect(kept.some((line) => line.includes("maintainers=1"))).toBe(true);
    }
  });

  test("exhausted hold with a newest non-pending entry is already-resolved in both orders", async () => {
    for (const history of [failureHistory(), [...failureHistory()].reverse()]) {
      const store = new MemoryReviewJobStore();
      await markSuggestionHoldConsumed(
        store.skipLatches,
        { owner: "kirmanak", repo: "demo", issueNumber: 12 },
        HEAD,
        1
      );
      const api = {
        listCommitStatuses: async () => history,
        getPR: async () => makePR({ number: 19 }),
        findStickyIssueComment: async () => undefined,
        createIssueComment: async () => makeComment({ id: 7, body: "x" }),
        updateIssueComment: async () => makeComment({ id: 7, body: "x" }),
        createCommitStatus: async () => {
          throw new Error("must not post when already resolved");
        },
      };
      const outcome = await resolveExhaustedFollowUpHoldOrThrow({
        api: api as never,
        store: store as never,
        row: { kind: "follow-up", owner: "kirmanak", repo: "demo", issueNumber: 12, headSha: HEAD, prNumber: 19 },
      });
      expect(outcome).toEqual({ resolved: false, reason: "already-resolved" });
    }
  });
});
