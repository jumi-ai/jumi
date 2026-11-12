import { describe, expect, test } from "bun:test";
import { publishReviewResult } from "../src/review.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import {
  countAddressedSuggestions,
  filterSuggestionFindings,
  forgeLabelForKind,
  isSameSuggestion,
  parseSuggestionFindings,
  runnerLabelForStamp,
} from "../src/review_suggestions.ts";
import { renderLedgerMetrics } from "../src/run_usage.ts";
import {
  capSuggestionFindings,
  countSuggestionFindings,
  formatSuggestionCapNote,
  MAX_SUGGESTION_FINDINGS,
  parseReviewFindings,
} from "../src/verdict.ts";
import { emptyCiMethods, makeComment, makeFile, makePR, makeRepo } from "./fixtures.ts";

function suggestionLine(index: number): string {
  return `src/a.ts:${index}: 💡 simpler: simplify helper ${index}.`;
}

function makeApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => ({ number: 12 }),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_o: string, _r: string, _i: number, body: string) => makeComment({ id: 1, body }),
    updateIssueComment: async (_o: string, _r: string, id: number, body: string) => makeComment({ id, body }),
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_o: string, _r: string, _s: string, status: unknown) => status,
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  };
  return { ...defaults, ...overrides } as never;
}

describe("suggestion cap", () => {
  test("six suggestions publish as five plus the dropped line", () => {
    const lines = Array.from({ length: 6 }, (_, i) => suggestionLine(i + 1));
    const { comment, posted, dropped } = capSuggestionFindings(lines.join("\n"));
    expect(posted).toBe(5);
    expect(dropped).toBe(1);
    expect(countSuggestionFindings(comment)).toBe(5);
    expect(comment).toContain(formatSuggestionCapNote(1));
    expect(comment).toContain("Jumi dropped 1 💡 suggestion (cap 5).");
    // The first five stay, the sixth is gone.
    expect(comment).toContain("simplify helper 1.");
    expect(comment).toContain("simplify helper 5.");
    expect(comment).not.toContain("simplify helper 6.");
  });

  test("other severities are never dropped by the cap", () => {
    const lines = [
      "src/a.ts:1: 🔴 bug: null deref. Guard it.",
      "src/a.ts:2: 🟡 risk: race on retry.",
      "src/a.ts:3: ❓ q: is the timeout intentional?",
      ...Array.from({ length: 7 }, (_, i) => suggestionLine(i + 10)),
    ];
    const { comment, posted, dropped } = capSuggestionFindings(lines.join("\n"));
    expect(posted).toBe(MAX_SUGGESTION_FINDINGS);
    expect(dropped).toBe(2);
    expect(comment).toContain("🔴 bug: null deref.");
    expect(comment).toContain("🟡 risk: race on retry.");
    expect(comment).toContain("❓ q: is the timeout intentional?");
    expect(countSuggestionFindings(comment)).toBe(5);
  });

  test("five or fewer suggestions publish unchanged with no dropped line", () => {
    const text = Array.from({ length: 5 }, (_, i) => suggestionLine(i + 1)).join("\n");
    const { comment, posted, dropped } = capSuggestionFindings(text);
    expect(posted).toBe(5);
    expect(dropped).toBe(0);
    expect(comment).toBe(text);
    expect(comment).not.toContain("Jumi dropped");
  });
});

describe("suggestion matching", () => {
  test("same file and similar text matches; different file does not", () => {
    const prev = { path: "src/a.ts", body: "💡 simpler: drop the helper, it duplicates the stdlib." };
    expect(
      isSameSuggestion(prev, { path: "src/a.ts", body: "💡 simpler: drop the helper since the stdlib covers it." })
    ).toBe(true);
    expect(
      isSameSuggestion(prev, { path: "src/b.ts", body: "💡 simpler: drop the helper, it duplicates the stdlib." })
    ).toBe(false);
    expect(isSameSuggestion(prev, { path: "src/a.ts", body: "💡 simpler: rename the variable for clarity." })).toBe(
      false
    );
  });

  test("addressed counts previous suggestions missing from the later review", () => {
    const prev = parseReviewFindings(
      ["src/a.ts:1: 💡 simpler: drop the helper.", "src/b.ts:2: 💡 simpler: inline the flag."].join("\n")
    );
    const curr = parseReviewFindings(["src/a.ts:1: 💡 simpler: drop the helper function."].join("\n"));
    expect(filterSuggestionFindings(prev)).toHaveLength(2);
    expect(countAddressedSuggestions(filterSuggestionFindings(prev), filterSuggestionFindings(curr))).toBe(1);
  });

  test("bold-prefixed markers count for addressed just like the cap", () => {
    const text = [
      "src/a.ts:1: **💡 simpler:** bold suggestion one.",
      "src/a.ts:2: 💡 simpler: plain suggestion two.",
    ].join("\n");
    expect(countSuggestionFindings(text)).toBe(2);
    expect(parseSuggestionFindings(text)).toHaveLength(2);
  });

  test("runner and forge labels stay bounded", () => {
    expect(runnerLabelForStamp("_Jumi · opencode · xai/grok-4.6_")).toBe("opencode");
    expect(runnerLabelForStamp("_Jumi · claude · claude-opus-5 (high)_")).toBe("claude");
    expect(runnerLabelForStamp(undefined)).toBe("unknown");
    expect(runnerLabelForStamp("garbage")).toBe("unknown");
    expect(forgeLabelForKind("github")).toBe("github");
    expect(forgeLabelForKind("GITHUB")).toBe("github");
    expect(forgeLabelForKind(undefined)).toBe("gitea");
    expect(forgeLabelForKind("gitea")).toBe("gitea");
  });
});

describe("publishReviewResult suggestion cap", () => {
  const publishOpts = {
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    expectedHeadSha: "headsha",
    botUsername: "jumi",
    logger: () => undefined,
  };

  test("six suggestions publish five inlines plus the dropped line and record counts", async () => {
    const markdown = [
      ...Array.from({ length: 6 }, (_, i) => suggestionLine(i + 1)),
      "<!-- jumi-check: success -->",
    ].join("\n");
    const inlines: Array<{ path: string; new_position: number; body: string }> = [];
    const bodies: string[] = [];
    const recorded: Array<{ runner: string; forge: string; posted: number; dropped: number; addressed: number }> = [];
    const result = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: markdown,
      resultRunner: "_Jumi · opencode · xai/grok-4.6_",
      forgeKind: "gitea",
      recordSuggestions: async (counts) => {
        recorded.push(counts);
      },
      api: makeApi({
        createPullReview: async (
          _o: string,
          _r: string,
          _i: number,
          review: { body?: string; comments?: typeof inlines }
        ) => {
          if (review.comments) inlines.push(...review.comments);
          if (review.body) bodies.push(review.body);
          return { id: 1 };
        },
      }),
    });
    expect(result.status).toBe("posted");
    expect(inlines).toHaveLength(5);
    expect(bodies.join("\n")).toContain("Jumi dropped 1 💡 suggestion (cap 5).");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ runner: "opencode", forge: "gitea", posted: 5, dropped: 1, addressed: 0 });
  });

  test("blocking and question findings survive the cap", async () => {
    const markdown = [
      "src/a.ts:1: 🔴 bug: null deref. Guard it.",
      "src/a.ts:2: 🟡 risk: race on retry.",
      "src/a.ts:3: ❓ q: is the timeout intentional?",
      ...Array.from({ length: 6 }, (_, i) => suggestionLine(i + 1)),
      "<!-- jumi-check: failure; 1 blocking, 1 risk -->",
    ].join("\n");
    const inlines: Array<{ path: string }> = [];
    const bodies: string[] = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: markdown,
      api: makeApi({
        createPullReview: async (
          _o: string,
          _r: string,
          _i: number,
          review: { body?: string; comments?: typeof inlines }
        ) => {
          if (review.comments) inlines.push(...review.comments);
          if (review.body) bodies.push(review.body);
          return { id: 1 };
        },
      }),
    });
    const inlineBodies = inlines.map((inline) => (inline as unknown as { body: string }).body).join("\n");
    expect(inlineBodies).toContain("null deref");
    expect(inlineBodies).toContain("race on retry");
    expect(bodies.join("\n")).toContain("Jumi dropped 1 💡 suggestion (cap 5).");
  });

  test("addressed counts previous suggestions not repeated", async () => {
    const previous = ["src/a.ts:1: 💡 simpler: drop the helper.", "src/b.ts:2: 💡 simpler: inline the flag."];
    const markdown = ["src/a.ts:1: 💡 simpler: drop the helper function.", "<!-- jumi-check: success -->"].join("\n");
    const recorded: Array<{ addressed: number }> = [];
    await publishReviewResult({
      ...publishOpts,
      resultMarkdown: markdown,
      previousFindings: previous,
      recordSuggestions: async (counts) => {
        recorded.push(counts);
      },
      api: makeApi({
        createPullReview: async () => ({ id: 1 }),
      }),
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.addressed).toBe(1);
  });
});

describe("suggestion ledger metrics", () => {
  test("counters increment and render alongside existing review metrics", async () => {
    const store = new MemoryReviewJobStore();
    await store.recordReviewSuggestions({ runner: "opencode", forge: "gitea", posted: 5, dropped: 1, addressed: 0 });
    await store.recordReviewSuggestions({ runner: "opencode", forge: "gitea", posted: 2, dropped: 0, addressed: 1 });
    await store.recordReviewSuggestions({ runner: "claude", forge: "github", posted: 1, dropped: 0, addressed: 0 });
    const totals = await store.getReviewSuggestionTotals();
    expect(totals).toContainEqual({
      runner: "opencode",
      forge: "gitea",
      posted: 7,
      dropped: 1,
      addressed: 1,
      reviews: 2,
    });
    expect(totals).toContainEqual({
      runner: "claude",
      forge: "github",
      posted: 1,
      dropped: 0,
      addressed: 0,
      reviews: 1,
    });
    const text = await renderLedgerMetrics(store);
    expect(text).toContain('jumi_review_suggestions_posted_total{runner="opencode",forge="gitea"} 7');
    expect(text).toContain('jumi_review_suggestions_dropped_total{runner="opencode",forge="gitea"} 1');
    expect(text).toContain('jumi_review_suggestions_addressed_total{runner="opencode",forge="gitea"} 1');
    expect(text).toContain('jumi_review_suggestions_posted_total{runner="claude",forge="github"} 1');
    expect(text).toContain("jumi_jobs_completed_total");
  });
});
