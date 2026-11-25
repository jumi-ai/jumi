import { describe, expect, test } from "bun:test";
import {
  decideHoldSettlement,
  type HoldSettlementEvidence,
  type HoldSettlementStatus,
  settleFollowUpHold,
} from "../src/hold_settlement.ts";
import { MemorySkipLatchStore } from "../src/skip_latches.ts";
import { markSuggestionHoldConsumed } from "../src/suggestion_hold.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makePR, makeRepo, makeUser } from "./fixtures.ts";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function knownEvidence(overrides: Partial<Extract<HoldSettlementEvidence, { kind: "known" }>> = {}) {
  return {
    kind: "known" as const,
    reviewHeadSha: HEAD,
    reviewOwnerOk: true,
    completeSuccess: true,
    openBugs: 0,
    openRisks: 0,
    openBlockingQuestions: 0,
    openMaintainers: 0,
    openSuggestions: 1,
    ...overrides,
  };
}

function pendingStatus(description?: string): HoldSettlementStatus {
  return { kind: "known", state: "pending", description };
}

describe("decideHoldSettlement pure table", () => {
  test("suggestion-only releases on completed with pending status", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 2 },
      currentHeadSha: HEAD,
      status: pendingStatus("2 suggestions waiting for follow-up"),
      holdEnabled: true,
      evidence: knownEvidence({ openMaintainers: 0, openSuggestions: 2 }),
      authorizedReply: false,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "post-success", description: "2 suggestions (follow-up completed)" });
  });

  test("suggestion-only releases on skipped with skipped description", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus("1 suggestion waiting for follow-up"),
      holdEnabled: true,
      evidence: knownEvidence({ openMaintainers: 0, openSuggestions: 0 }),
      authorizedReply: false,
      intent: { kind: "skipped", reason: "round cap" },
    });
    expect(decision).toEqual({
      action: "post-success",
      description: "1 suggestion (follow-up skipped: round cap)",
    });
  });

  test("head mismatch keeps", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: OTHER_HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus(),
      holdEnabled: true,
      evidence: knownEvidence(),
      authorizedReply: true,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "keep", reason: "head-mismatch" });
  });

  test("review head mismatch keeps", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus(),
      holdEnabled: true,
      evidence: knownEvidence({ reviewHeadSha: OTHER_HEAD }),
      authorizedReply: true,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "keep", reason: "review-head-mismatch" });
  });

  test("non-pending status keeps", () => {
    for (const state of ["success", "failure", "error"]) {
      const decision = decideHoldSettlement({
        hold: { consumed: true, headSha: HEAD, count: 1 },
        currentHeadSha: HEAD,
        status: { kind: "known", state, description: "1 suggestion (follow-up completed)" },
        holdEnabled: true,
        evidence: knownEvidence(),
        authorizedReply: true,
        intent: { kind: "completed" },
      });
      expect(decision).toEqual({ action: "keep", reason: "not-pending" });
    }
  });

  test("zero count keeps", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 0 },
      currentHeadSha: HEAD,
      status: pendingStatus(),
      holdEnabled: true,
      evidence: knownEvidence(),
      authorizedReply: true,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "keep", reason: "zero-count" });
  });

  test("no hold keeps for suggestion-only", () => {
    const decision = decideHoldSettlement({
      hold: undefined,
      currentHeadSha: HEAD,
      status: pendingStatus(),
      holdEnabled: true,
      evidence: knownEvidence({ openMaintainers: 0 }),
      authorizedReply: false,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "keep", reason: "no-hold" });
  });

  test("unknown evidence keeps", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus(),
      holdEnabled: true,
      evidence: { kind: "unknown", reason: "failed to load pull reviews" },
      authorizedReply: true,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "keep", reason: "unknown-evidence" });
  });

  test("unknown status keeps", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: { kind: "unknown", reason: "failed to load status" },
      holdEnabled: true,
      evidence: knownEvidence(),
      authorizedReply: true,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "keep", reason: "unknown-status" });
  });

  test("other-hold description keeps", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus("waiting on something else"),
      holdEnabled: true,
      evidence: knownEvidence(),
      authorizedReply: true,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "keep", reason: "other-hold" });
  });

  test("status description never authorises success", () => {
    // Even with a maintainer-worded pending description, a failing review cannot release.
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus("waiting on maintainer: 1 question"),
      holdEnabled: true,
      evidence: knownEvidence({ completeSuccess: false, openBugs: 1, openMaintainers: 1 }),
      authorizedReply: true,
      intent: { kind: "completed" },
    });
    expect(decision.action).toBe("keep");
  });

  test("mixed without authorized reply keeps", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus("waiting on maintainer: 1 question"),
      holdEnabled: true,
      evidence: knownEvidence({ openMaintainers: 1, openSuggestions: 1 }),
      authorizedReply: false,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "keep", reason: "no-authorized-reply" });
  });

  test("mixed with authorized reply releases with maintainer description", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus("waiting on maintainer: 1 question"),
      holdEnabled: true,
      evidence: knownEvidence({ openMaintainers: 1, openSuggestions: 1 }),
      authorizedReply: true,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "post-success", description: "1 suggestion" });
  });

  test("mixed skipped keeps even with authorized reply", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus("waiting on maintainer: 1 question"),
      holdEnabled: true,
      evidence: knownEvidence({ openMaintainers: 1 }),
      authorizedReply: true,
      intent: { kind: "skipped", reason: "round cap" },
    });
    expect(decision).toEqual({ action: "keep", reason: "maintainer-questions-pending" });
  });

  test("hold-disabled mixed releases without authorized reply", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus("1 suggestion waiting for follow-up"),
      holdEnabled: false,
      evidence: knownEvidence({ openMaintainers: 1, openSuggestions: 1 }),
      authorizedReply: false,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "post-success", description: "1 suggestion (follow-up completed)" });
  });

  test("blocking findings keep", () => {
    const decision = decideHoldSettlement({
      hold: { consumed: true, headSha: HEAD, count: 1 },
      currentHeadSha: HEAD,
      status: pendingStatus(),
      holdEnabled: false,
      evidence: knownEvidence({ openBugs: 1 }),
      authorizedReply: true,
      intent: { kind: "completed" },
    });
    expect(decision).toEqual({ action: "keep", reason: "blocking-findings" });
  });
});

describe("settleFollowUpHold with mixed summary plus empty-body companion", () => {
  const SUMMARY_ID = 4110;
  const INLINE_ID = 4109;

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
        sha: HEAD,
        repo,
        repo_id: repo.id,
      },
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
        id: INLINE_ID,
        body: "",
        user: makeUser({ login: "jumi" }),
        commit_id: HEAD,
        submitted_at: "2026-11-19T18:29:19Z",
        updated_at: "2026-11-19T18:29:19Z",
      },
      {
        id: SUMMARY_ID,
        body: pairBody(),
        user: makeUser({ login: "jumi" }),
        commit_id: HEAD,
        submitted_at: "2026-11-19T18:29:20Z",
        updated_at: "2026-11-19T18:29:20Z",
      },
    ];
  }

  function suggestionInline() {
    return {
      ...makeComment({
        id: 9002,
        body: "💡 suggestion: extract a helper\n\n<!-- jumi-review:kirmanak/demo#127 -->",
        user: makeUser({ login: "jumi" }),
      }),
      path: "src/foo.ts",
      pull_request_review_id: INLINE_ID,
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
      pull_request_review_id: INLINE_ID,
    };
  }

  function baseApi(
    statuses: Array<{ state: string; description?: string; context?: string }>,
    inlines: unknown[],
    overrides: Record<string, unknown> = {}
  ) {
    const human = makeComment({ id: 55, body: "answered, thanks", user: makeUser({ login: "alice" }) });
    return makeIssueApi({
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
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listCommitStatuses: async () => [],
      ...overrides,
    } as never);
  }

  async function withHold(count = 1) {
    const store = new MemorySkipLatchStore();
    await markSuggestionHoldConsumed(store, { owner: "kirmanak", repo: "demo", issueNumber: 12 }, HEAD, count);
    return store;
  }

  const latchKey = { owner: "kirmanak", repo: "demo", issueNumber: 12 };

  test("non-reply wake keeps mixed hold", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const api = baseApi(statuses, [suggestionInline(), maintainerInline()]);
    const logged: string[] = [];
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: await withHold(),
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "workflow_job", sender: "jumi" },
      botUsername: "jumi",
      defaultBranch: "main",
      log: (message) => logged.push(message),
      targetUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    });
    expect(statuses).toHaveLength(0);
    expect(logged.some((line) => line.includes("no-authorized-reply"))).toBe(true);
  });

  test("trusted reply releases mixed hold", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const api = baseApi(statuses, [suggestionInline(), maintainerInline()]);
    const logged: string[] = [];
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: await withHold(),
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      botUsername: "jumi",
      defaultBranch: "main",
      log: (message) => logged.push(message),
      targetUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    });
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(logged.some((line) => line.includes("maintainer hold released"))).toBe(true);
  });

  test("skipped intent keeps mixed hold even with trusted reply", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const api = baseApi(statuses, [suggestionInline(), maintainerInline()]);
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: await withHold(),
      latchKey,
      intent: { kind: "skipped", reason: "round cap" },
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      botUsername: "jumi",
      defaultBranch: "main",
      log: () => undefined,
    });
    expect(statuses).toHaveLength(0);
  });

  test("failing review-list writes nothing and logs unknown", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const api = baseApi(statuses, [], {
      listPullReviews: async () => {
        throw new Error("forge exploded");
      },
    });
    const logged: string[] = [];
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: await withHold(),
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      botUsername: "jumi",
      defaultBranch: "main",
      log: (message) => logged.push(message),
    });
    expect(statuses).toHaveLength(0);
    expect(logged.some((line) => line.includes("unknown"))).toBe(true);
  });

  test("untrusted reply cannot release", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const mallory = makeComment({ id: 56, body: "looks fine", user: makeUser({ login: "mallory" }) });
    const human = makeComment({ id: 55, body: "answered", user: makeUser({ login: "alice" }) });
    const api = makeIssueApi({
      listOpenPulls: async () => [heldPr()],
      getPR: async () => heldPr(),
      listIssueComments: async () => [human, mallory],
      listPullReviews: async () => pairReviews(),
      listPullReviewComments: async () => [suggestionInline(), maintainerInline()],
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        statuses.push(status as never);
        return status;
      },
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "read" }),
      listCommitStatuses: async () => [],
    } as never);
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: await withHold(),
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "issue_comment", commentId: 56, sender: "mallory" },
      botUsername: "jumi",
      defaultBranch: "main",
      log: () => undefined,
    });
    expect(statuses).toHaveLength(0);
  });

  test("hold-disabled mixed releases without authorized reply", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const api = baseApi(statuses, [suggestionInline(), maintainerInline()], {
      getRepoFile: async () => ({ found: true, content: "maintainer_questions_hold_merge: false\n" }),
    });
    await settleFollowUpHold({
      api,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 127,
      latches: await withHold(),
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "workflow_job", sender: "jumi" },
      botUsername: "jumi",
      defaultBranch: "main",
      log: () => undefined,
    });
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(statuses.at(-1)?.description).toBe("1 suggestion (follow-up completed)");
  });

  test("suggestion-only releases for completed and skipped with unchanged descriptions", async () => {
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
      id: SUMMARY_ID,
      body: summaryOnly,
      user: makeUser({ login: "jumi" }),
      commit_id: HEAD,
      submitted_at: "2026-11-19T18:29:20Z",
      updated_at: "2026-11-19T18:29:20Z",
    };
    for (const intent of [{ kind: "completed" }, { kind: "skipped", reason: "round cap" }] as const) {
      const statuses: Array<{ state: string; description?: string }> = [];
      const api = makeIssueApi({
        listOpenPulls: async () => [heldPr()],
        getPR: async () => heldPr(),
        listIssueComments: async () => [makeComment({ id: 55, body: "thanks", user: makeUser({ login: "alice" }) })],
        listPullReviews: async () => [review],
        listPullReviewComments: async () => [],
        createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
          statuses.push(status as never);
          return status;
        },
        getRepoFile: async () => ({ found: false }),
        getCollaboratorPermission: async () => ({ permission: "write" }),
        listCommitStatuses: async () => [],
      } as never);
      await settleFollowUpHold({
        api,
        owner: "kirmanak",
        repo: "demo",
        prNumber: 127,
        latches: await withHold(),
        latchKey,
        intent,
        trigger: { event: "workflow_job", sender: "jumi" },
        botUsername: "jumi",
        defaultBranch: "main",
        log: () => undefined,
      });
      expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
      const expected =
        intent.kind === "completed"
          ? "1 suggestion (follow-up completed)"
          : "1 suggestion (follow-up skipped: round cap)";
      expect(statuses.at(-1)?.description).toBe(expected);
    }
  });
});
