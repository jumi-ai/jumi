import { describe, expect, test } from "bun:test";
import { holdReasonForSkippedResult, parseSkipWhy, reasonText, type SkipWhy } from "../src/pr_decision.ts";
import { normalizeSitReason } from "../src/router_sits.ts";

describe("skip why round trip", () => {
  const rows: Array<{ why: SkipWhy; params: never }> = [
    { why: "comment-already-handled", params: {} as never },
    { why: "settings-unreadable", params: {} as never },
    { why: "conflict-cap", params: { round: 3, max: 3 } as never },
    { why: "conflict-cap", params: { round: 1, max: 5 } as never },
    { why: "conflict-cap", params: { round: 10, max: 10 } as never },
    { why: "round-cap", params: {} as never },
    { why: "ci-pending", params: {} as never },
    { why: "no-unhandled-feedback", params: {} as never },
    { why: "left-to-author", params: { leftReason: "conflicted, left to author (label `ignore-conflicts`)" } as never },
    { why: "left-to-author", params: { leftReason: "conflicted, left to author (author `alice`)" } as never },
    { why: "quota", params: { quotaReason: "stuck: usage limit exceeded" } as never },
    { why: "quota", params: { quotaReason: "stuck: credit balance is too low" } as never },
    { why: "stuck", params: { stuckReason: "repeated-action" } as never },
    { why: "stuck", params: { stuckReason: "repeated-error" } as never },
    { why: "stuck", params: { stuckReason: "ping-pong" } as never },
    { why: "same-finding", params: { display: "src/a.ts:10 boom" } as never },
    { why: "same-finding", params: { display: undefined } as never },
    { why: "default-branch", params: {} as never },
    { why: "merge-default-stuck", params: {} as never },
    { why: "dependency-cycle", params: {} as never },
    { why: "blocked-by-rejected", params: {} as never },
    { why: "stuck-other", params: {} as never },
  ];
  for (const row of rows) {
    test(`${row.why} ${JSON.stringify(row.params)}`, () => {
      expect(parseSkipWhy(reasonText(row.why, row.params)).why).toBe(row.why);
    });
  }

  test("stuck with same-finding shares the bare same-finding text", () => {
    expect(reasonText("stuck", { stuckReason: "same-finding" } as never)).toBe(
      reasonText("same-finding", { display: undefined } as never)
    );
    expect(parseSkipWhy(reasonText("stuck", { stuckReason: "same-finding" } as never)).why).toBe("same-finding");
  });
});

describe("skip why matrix", () => {
  const rows: Array<{
    input: string | null | undefined;
    why: SkipWhy | undefined;
    latches: boolean;
    kickKind: "conflict" | "follow-up";
    sit: "implement-latch" | "ci-not-completed" | "conflict-ignored" | undefined;
  }> = [
    {
      input: "comment already handled",
      why: "comment-already-handled",
      latches: false,
      kickKind: "follow-up",
      sit: undefined,
    },
    {
      input: "ignore-conflicts settings unreadable",
      why: "settings-unreadable",
      latches: false,
      kickKind: "follow-up",
      sit: undefined,
    },
    {
      input: "stuck: cannot resolve conflicts (3/3 conflict rounds)",
      why: "conflict-cap",
      latches: true,
      kickKind: "conflict",
      sit: "implement-latch",
    },
    {
      input: "stuck: too many follow-up rounds",
      why: "round-cap",
      latches: true,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    { input: "CI still pending", why: "ci-pending", latches: false, kickKind: "follow-up", sit: "ci-not-completed" },
    {
      input: "no unhandled feedback",
      why: "no-unhandled-feedback",
      latches: false,
      kickKind: "follow-up",
      sit: undefined,
    },
    { input: "CI infra flake: reason-a", why: undefined, latches: false, kickKind: "follow-up", sit: undefined },
    {
      input: "conflicted, left to author (label `ignore-conflicts`)",
      why: "left-to-author",
      latches: false,
      kickKind: "follow-up",
      sit: "conflict-ignored",
    },
    {
      input: "conflicted, left to author (author `alice`)",
      why: "left-to-author",
      latches: false,
      kickKind: "follow-up",
      sit: "conflict-ignored",
    },
    {
      input: "stuck: usage limit exceeded",
      why: "quota",
      latches: true,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    {
      input: "stuck: credit balance is too low",
      why: "quota",
      latches: true,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    { input: "stuck: repeated action", why: "stuck", latches: true, kickKind: "follow-up", sit: "implement-latch" },
    { input: "stuck: repeated error", why: "stuck", latches: true, kickKind: "follow-up", sit: "implement-latch" },
    { input: "stuck: ping-pong", why: "stuck", latches: true, kickKind: "follow-up", sit: "implement-latch" },
    {
      input: "stuck: same finding repeated",
      why: "same-finding",
      latches: true,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    {
      input: "stuck: same finding repeated (src/a.ts:10 boom)",
      why: "same-finding",
      latches: true,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    {
      input: "refusing to follow up on the default branch",
      why: "default-branch",
      latches: false,
      kickKind: "follow-up",
      sit: undefined,
    },
    {
      input: "stuck: cannot resolve conflicts",
      why: "merge-default-stuck",
      latches: true,
      kickKind: "conflict",
      sit: "implement-latch",
    },
    {
      input: "stuck: dependency cycle",
      why: "dependency-cycle",
      latches: true,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    {
      input: "stuck: blocked-by rejected",
      why: "blocked-by-rejected",
      latches: true,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    {
      input: "stuck: incomplete review",
      why: "stuck-other",
      latches: true,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    { input: "stuck: foo", why: "stuck-other", latches: true, kickKind: "follow-up", sit: "implement-latch" },
    { input: "stuck:", why: "stuck-other", latches: true, kickKind: "follow-up", sit: "implement-latch" },
    {
      input: "stuck: conflict resolution failed",
      why: "stuck-other",
      latches: true,
      kickKind: "conflict",
      sit: "implement-latch",
    },
    { input: "stuck: conflict", why: "stuck-other", latches: true, kickKind: "conflict", sit: "implement-latch" },
    {
      input: "  stuck: repeated action  ",
      why: "stuck",
      latches: false,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    { input: "STUCK: REPEATED ACTION", why: undefined, latches: false, kickKind: "follow-up", sit: undefined },
    {
      input: "  stuck: cannot resolve conflicts (1/3 conflict rounds)  ",
      why: "conflict-cap",
      latches: false,
      kickKind: "conflict",
      sit: "implement-latch",
    },
    {
      input: "Stuck: Cannot Resolve Conflicts (1/3 Conflict Rounds)",
      why: undefined,
      latches: false,
      kickKind: "conflict",
      sit: undefined,
    },
    { input: null, why: undefined, latches: false, kickKind: "follow-up", sit: undefined },
    { input: undefined, why: undefined, latches: false, kickKind: "follow-up", sit: undefined },
    { input: "", why: undefined, latches: false, kickKind: "follow-up", sit: undefined },
    { input: "ping", why: undefined, latches: false, kickKind: "follow-up", sit: undefined },
    { input: "round cap", why: undefined, latches: false, kickKind: "follow-up", sit: undefined },
    {
      input: "same head and base already attempted",
      why: undefined,
      latches: false,
      kickKind: "follow-up",
      sit: undefined,
    },
    { input: "blocked on #1, #2", why: undefined, latches: false, kickKind: "follow-up", sit: undefined },
    {
      input: "  CI still pending  ",
      why: "ci-pending",
      latches: false,
      kickKind: "follow-up",
      sit: "ci-not-completed",
    },
    {
      input: "CONFLICTED, LEFT TO AUTHOR (LABEL `X`)",
      why: "left-to-author",
      latches: false,
      kickKind: "follow-up",
      sit: "conflict-ignored",
    },
    {
      input: " stuck: too many follow-up rounds ",
      why: "round-cap",
      latches: false,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    {
      input: "stuck: too many follow-up rounds ",
      why: "round-cap",
      latches: true,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    {
      input: " stuck: foo ",
      why: undefined,
      latches: false,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    {
      input: " stuck: incomplete review ",
      why: undefined,
      latches: false,
      kickKind: "follow-up",
      sit: "implement-latch",
    },
    {
      input: " stuck: conflict resolution failed ",
      why: undefined,
      latches: false,
      kickKind: "conflict",
      sit: "implement-latch",
    },
  ];
  test(`has at least 30 rows (has ${rows.length})`, () => {
    expect(rows.length).toBeGreaterThanOrEqual(30);
  });
  for (const row of rows) {
    test(JSON.stringify(row.input) ?? "undefined", () => {
      expect(parseSkipWhy(row.input)).toEqual({
        why: row.why,
        latches: row.latches,
        kickKind: row.kickKind,
        sit: row.sit,
      });
      expect(normalizeSitReason(row.input)).toBe(row.sit);
    });
  }
});

describe("hold reason for skipped result", () => {
  test("round-cap substring maps to the hold alias", () => {
    expect(holdReasonForSkippedResult("stuck: too many follow-up rounds")).toBe("round cap");
    expect(holdReasonForSkippedResult("xx too many follow-up yy")).toBe("round cap");
  });
  test("other reasons pass through", () => {
    expect(holdReasonForSkippedResult("stuck: repeated action")).toBe("stuck: repeated action");
    expect(holdReasonForSkippedResult("follow-up skipped")).toBe("follow-up skipped");
  });
  test("missing reason falls back", () => {
    expect(holdReasonForSkippedResult(undefined)).toBe("follow-up skipped");
    expect(holdReasonForSkippedResult(42)).toBe("follow-up skipped");
  });
});
