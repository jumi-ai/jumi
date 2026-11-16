import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type CloserSnapshot,
  CONFLICT_DEFAULT_BRANCH_REASON,
  classify,
  decide,
  type PrDecisionSnapshot,
  type Resolved,
  SKIP_WHY_TABLE,
  type SkipWhy,
} from "../src/pr_decision.ts";
import { isSkipLatchReason } from "../src/stuck.ts";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function base(): PrDecisionSnapshot {
  return {
    branchIsDefault: false,
    handledCommentIds: [],
    handledReviewIds: [],
    ciWake: false,
    ignoreAuthors: [],
    mergeable: true,
    conflictRound: 0,
    maxConflictRounds: 3,
    leftToAuthor: { value: { leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false } },
    hasFeedback: true,
    stateRound: 0,
    maxFollowupRounds: 3,
    ciPending: false,
    ciUnhandled: [],
    stuckFingerprints: [],
    quotaStuck: false,
    quotaReason: "",
    owner: "o",
    repo: "r",
    prNumber: 1,
  };
}

function left(value: { leftToAuthor: boolean; leftReason: string; conflictedLeftToAuthor: boolean }): Resolved<{
  leftToAuthor: boolean;
  leftReason: string;
  conflictedLeftToAuthor: boolean;
}> {
  return { value };
}

interface RowCase {
  name: string;
  snapshot: PrDecisionSnapshot;
  expectWhy: SkipWhy | "run";
  expectReason?: string;
  expectHasFeedback?: boolean;
}

function flakeCheck(name: string, flake: string) {
  return { name, flake };
}

const ACTION_A = hash("action-a");
const ACTION_B = hash("action-b");
const ERROR_E = hash("error-e");
const FIND_F = hash("finding-identity");
const DIFF_D = "diff-hash-value";
const SAME_H = hash(`${FIND_F}|${DIFF_D}`);

function cases(): RowCase[] {
  const out: RowCase[] = [];
  out.push({
    name: "default-branch",
    snapshot: { ...base(), branchIsDefault: true, leftToAuthor: undefined },
    expectWhy: "default-branch",
    expectReason: "refusing to follow up on the default branch",
  });
  out.push({
    name: "comment-already-handled via commentId",
    snapshot: {
      ...base(),
      triggerCommentId: 11,
      handledCommentIds: [11],
    },
    expectWhy: "comment-already-handled",
    expectReason: "comment already handled",
  });
  out.push({
    name: "comment-already-handled via reviewId",
    snapshot: {
      ...base(),
      triggerReviewId: 22,
      handledReviewIds: [22],
    },
    expectWhy: "comment-already-handled",
    expectReason: "comment already handled",
  });
  out.push({
    name: "comment-already-handled with ciWake runs",
    snapshot: {
      ...base(),
      triggerCommentId: 11,
      handledCommentIds: [11],
      ciWake: true,
      ciUnhandled: [{ name: "lint" }],
      ciHash: hash("ci-lint"),
      hasFeedback: false,
    },
    expectWhy: "run",
    expectHasFeedback: false,
  });
  out.push({
    name: "settings-unreadable",
    snapshot: { ...base(), ignoreAuthors: undefined, leftToAuthor: undefined },
    expectWhy: "settings-unreadable",
    expectReason: "ignore-conflicts settings unreadable",
  });
  out.push({
    name: "conflict-cap 3/3",
    snapshot: {
      ...base(),
      mergeable: false,
      conflictRound: 3,
      maxConflictRounds: 3,
      leftToAuthor: left({ leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false }),
    },
    expectWhy: "conflict-cap",
    expectReason: "stuck: cannot resolve conflicts (3/3 conflict rounds)",
  });
  out.push({
    name: "conflict-cap 5/3",
    snapshot: {
      ...base(),
      mergeable: false,
      conflictRound: 5,
      maxConflictRounds: 3,
      leftToAuthor: left({ leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false }),
    },
    expectWhy: "conflict-cap",
    expectReason: "stuck: cannot resolve conflicts (5/3 conflict rounds)",
  });
  out.push({
    name: "conflict-cap with mergeable true is no cap",
    snapshot: {
      ...base(),
      mergeable: true,
      conflictRound: 9,
      maxConflictRounds: 3,
      hasFeedback: false,
      ciWake: false,
      ciPending: false,
    },
    expectWhy: "no-unhandled-feedback",
    expectReason: "no unhandled feedback",
  });
  out.push({
    name: "conflict-cap wins over round-cap",
    snapshot: {
      ...base(),
      mergeable: false,
      conflictRound: 3,
      maxConflictRounds: 3,
      hasFeedback: true,
      stateRound: 3,
      maxFollowupRounds: 3,
      leftToAuthor: left({ leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false }),
    },
    expectWhy: "conflict-cap",
    expectReason: "stuck: cannot resolve conflicts (3/3 conflict rounds)",
  });
  out.push({
    name: "round-cap",
    snapshot: { ...base(), hasFeedback: true, stateRound: 3, maxFollowupRounds: 3 },
    expectWhy: "round-cap",
    expectReason: "stuck: too many follow-up rounds",
  });
  out.push({
    name: "round-cap ciWake flips to run without feedback",
    snapshot: {
      ...base(),
      hasFeedback: true,
      stateRound: 3,
      maxFollowupRounds: 3,
      ciWake: true,
      ciUnhandled: [{ name: "lint", flake: undefined }],
      ciHash: hash("ci-lint"),
    },
    expectWhy: "run",
    expectHasFeedback: false,
  });
  out.push({
    name: "round-cap not reached runs",
    snapshot: { ...base(), hasFeedback: true, stateRound: 1, maxFollowupRounds: 3 },
    expectWhy: "run",
    expectHasFeedback: true,
  });
  out.push({
    name: "ci-pending",
    snapshot: { ...base(), hasFeedback: false, ciPending: true },
    expectWhy: "ci-pending",
    expectReason: "CI still pending",
  });
  out.push({
    name: "ci-pending beats no-unhandled-feedback",
    snapshot: { ...base(), hasFeedback: false, ciPending: true, mergeable: true },
    expectWhy: "ci-pending",
    expectReason: "CI still pending",
  });
  out.push({
    name: "no-unhandled-feedback",
    snapshot: { ...base(), hasFeedback: false, ciPending: false, mergeable: true },
    expectWhy: "no-unhandled-feedback",
    expectReason: "no unhandled feedback",
  });
  out.push({
    name: "no-unhandled-feedback skipped when mergeable false",
    snapshot: {
      ...base(),
      hasFeedback: false,
      ciPending: false,
      mergeable: false,
      leftToAuthor: left({ leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false }),
    },
    expectWhy: "run",
    expectHasFeedback: false,
  });
  out.push({
    name: "flake single check",
    snapshot: {
      ...base(),
      hasFeedback: false,
      ciPending: false,
      ciWake: true,
      mergeable: true,
      ciUnhandled: [flakeCheck("build", "GitHub 140.82 timeout or unreachable")],
    },
    expectWhy: "flake",
    expectReason: "CI infra flake: GitHub 140.82 timeout or unreachable",
  });
  out.push({
    name: "flake multiple checks shared reason",
    snapshot: {
      ...base(),
      hasFeedback: false,
      ciPending: false,
      ciWake: true,
      mergeable: true,
      ciUnhandled: [flakeCheck("build", "tofu S3 state lock"), flakeCheck("test", "tofu S3 state lock")],
    },
    expectWhy: "flake",
    expectReason: "CI infra flake: tofu S3 state lock",
  });
  out.push({
    name: "flake multiple distinct reasons",
    snapshot: {
      ...base(),
      hasFeedback: false,
      ciPending: false,
      ciWake: true,
      mergeable: true,
      ciUnhandled: [flakeCheck("build", "reason-a"), flakeCheck("test", "reason-b")],
    },
    expectWhy: "flake",
    expectReason: "CI infra flake: reason-a; reason-b",
  });
  out.push({
    name: "flake with mergeable false continues",
    snapshot: {
      ...base(),
      hasFeedback: false,
      ciPending: false,
      ciWake: true,
      mergeable: false,
      ciUnhandled: [flakeCheck("build", "reason-a")],
      leftToAuthor: left({ leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false }),
    },
    expectWhy: "run",
    expectHasFeedback: false,
  });
  out.push({
    name: "flake mixed flake and real failure continues",
    snapshot: {
      ...base(),
      hasFeedback: false,
      ciPending: false,
      ciWake: true,
      mergeable: true,
      ciUnhandled: [flakeCheck("build", "reason-a"), { name: "test" }],
      ciHash: hash("ci-mixed"),
      leftToAuthor: left({ leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false }),
    },
    expectWhy: "run",
    expectHasFeedback: false,
  });
  out.push({
    name: "left-to-author label",
    snapshot: {
      ...base(),
      hasFeedback: false,
      mergeable: false,
      leftToAuthor: left({
        leftToAuthor: true,
        leftReason: "conflicted, left to author (label `ignore-conflicts`)",
        conflictedLeftToAuthor: true,
      }),
    },
    expectWhy: "left-to-author",
    expectReason: "conflicted, left to author (label `ignore-conflicts`)",
  });
  out.push({
    name: "left-to-author listed author",
    snapshot: {
      ...base(),
      hasFeedback: false,
      mergeable: false,
      leftToAuthor: left({
        leftToAuthor: true,
        leftReason: "conflicted, left to author (author `alice`)",
        conflictedLeftToAuthor: true,
      }),
    },
    expectWhy: "left-to-author",
    expectReason: "conflicted, left to author (author `alice`)",
  });
  out.push({
    name: "left-to-author vs ciWake runs",
    snapshot: {
      ...base(),
      hasFeedback: false,
      ciWake: true,
      mergeable: false,
      ciUnhandled: [{ name: "lint" }],
      ciHash: hash("ci-x"),
      leftToAuthor: left({
        leftToAuthor: true,
        leftReason: "conflicted, left to author (label `ignore-conflicts`)",
        conflictedLeftToAuthor: true,
      }),
    },
    expectWhy: "run",
    expectHasFeedback: false,
  });
  out.push({
    name: "left-to-author needs feedback false",
    snapshot: {
      ...base(),
      hasFeedback: true,
      mergeable: false,
      leftToAuthor: left({
        leftToAuthor: true,
        leftReason: "conflicted, left to author (label `ignore-conflicts`)",
        conflictedLeftToAuthor: true,
      }),
    },
    expectWhy: "run",
    expectHasFeedback: true,
  });
  out.push({
    name: "quota usage limit",
    snapshot: { ...base(), quotaStuck: true, quotaReason: "stuck: usage limit exceeded" },
    expectWhy: "quota",
    expectReason: "stuck: usage limit exceeded",
  });
  out.push({
    name: "quota credit balance",
    snapshot: { ...base(), quotaStuck: true, quotaReason: "stuck: credit balance is too low" },
    expectWhy: "quota",
    expectReason: "stuck: credit balance is too low",
  });
  out.push({
    name: "quota beats repeated-action",
    snapshot: {
      ...base(),
      quotaStuck: true,
      quotaReason: "stuck: usage limit exceeded",
      stuckFingerprints: [
        { kind: "action", hash: ACTION_A },
        { kind: "action", hash: ACTION_A },
        { kind: "action", hash: ACTION_A },
      ],
      preCapFingerprint: { kind: "action", hash: ACTION_A },
    },
    expectWhy: "quota",
    expectReason: "stuck: usage limit exceeded",
  });
  out.push({
    name: "stuck repeated-action",
    snapshot: {
      ...base(),
      stuckFingerprints: [
        { kind: "action", hash: ACTION_A },
        { kind: "action", hash: ACTION_A },
        { kind: "action", hash: ACTION_A },
      ],
      preCapFingerprint: { kind: "action", hash: ACTION_A },
    },
    expectWhy: "stuck",
    expectReason: "stuck: repeated action",
  });
  out.push({
    name: "stuck repeated-error from history",
    snapshot: {
      ...base(),
      stuckFingerprints: [
        { kind: "error", hash: ERROR_E },
        { kind: "error", hash: ERROR_E },
        { kind: "error", hash: ERROR_E },
      ],
      preCapFingerprint: { kind: "action", hash: ACTION_A },
    },
    expectWhy: "stuck",
    expectReason: "stuck: repeated error",
  });
  out.push({
    name: "stuck ping-pong",
    snapshot: {
      ...base(),
      stuckFingerprints: [
        { kind: "action", hash: ACTION_A },
        { kind: "action", hash: ACTION_B },
        { kind: "action", hash: ACTION_A },
      ],
      preCapFingerprint: { kind: "action", hash: ACTION_B },
    },
    expectWhy: "stuck",
    expectReason: "stuck: ping-pong",
  });
  out.push({
    name: "stuck beats same-finding",
    snapshot: {
      ...base(),
      stuckFingerprints: [
        { kind: "action", hash: ACTION_A },
        { kind: "action", hash: ACTION_A },
        { kind: "action", hash: ACTION_A },
      ],
      preCapFingerprint: { kind: "action", hash: ACTION_A },
      findingIdentityHash: FIND_F,
      diffHash: { value: DIFF_D },
      sameFindingDisplay: "src/a.ts:10 🔴 boom",
    },
    expectWhy: "stuck",
    expectReason: "stuck: repeated action",
  });
  out.push({
    name: "same-finding without display",
    snapshot: {
      ...base(),
      stuckFingerprints: [
        { kind: "finding", hash: SAME_H },
        { kind: "finding", hash: SAME_H },
      ],
      preCapFingerprint: { kind: "action", hash: ACTION_A },
      findingIdentityHash: FIND_F,
      diffHash: { value: DIFF_D },
    },
    expectWhy: "same-finding",
    expectReason: "stuck: same finding repeated",
  });
  out.push({
    name: "same-finding with display",
    snapshot: {
      ...base(),
      stuckFingerprints: [
        { kind: "finding", hash: SAME_H },
        { kind: "finding", hash: SAME_H },
      ],
      preCapFingerprint: { kind: "action", hash: ACTION_A },
      findingIdentityHash: FIND_F,
      diffHash: { value: DIFF_D },
      sameFindingDisplay: "src/a.ts:10 🔴 boom",
    },
    expectWhy: "same-finding",
    expectReason: "stuck: same finding repeated (src/a.ts:10 🔴 boom)",
  });
  out.push({
    name: "same-finding fail-open without diff continues",
    snapshot: {
      ...base(),
      stuckFingerprints: [
        { kind: "finding", hash: SAME_H },
        { kind: "finding", hash: SAME_H },
      ],
      preCapFingerprint: { kind: "action", hash: ACTION_A },
      findingIdentityHash: FIND_F,
      diffHash: { value: undefined },
    },
    expectWhy: "run",
    expectHasFeedback: true,
  });
  out.push({
    name: "same-finding different diff continues",
    snapshot: {
      ...base(),
      stuckFingerprints: [
        { kind: "finding", hash: SAME_H },
        { kind: "finding", hash: SAME_H },
      ],
      preCapFingerprint: { kind: "action", hash: ACTION_A },
      findingIdentityHash: FIND_F,
      diffHash: { value: "other-diff" },
    },
    expectWhy: "run",
    expectHasFeedback: true,
  });
  out.push({
    name: "stuck from same-finding current ping-pong",
    snapshot: {
      ...base(),
      stuckFingerprints: [
        { kind: "finding", hash: ACTION_A },
        { kind: "finding", hash: ACTION_B },
      ],
      preCapFingerprint: { kind: "action", hash: "current-action" },
      findingIdentityHash: FIND_F,
      diffHash: { value: DIFF_D },
    },
    expectWhy: "run",
    expectHasFeedback: true,
  });
  out.push({
    name: "run with feedback no stuck",
    snapshot: { ...base() },
    expectWhy: "run",
    expectHasFeedback: true,
  });
  out.push({
    name: "run ci hash carried",
    snapshot: {
      ...base(),
      hasFeedback: false,
      ciPending: false,
      mergeable: false,
      ciHash: hash("ci-empty"),
      leftToAuthor: left({ leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false }),
    },
    expectWhy: "run",
    expectHasFeedback: false,
  });
  out.push({
    name: "quota ciWake still skips",
    snapshot: {
      ...base(),
      hasFeedback: false,
      ciWake: true,
      ciUnhandled: [{ name: "lint" }],
      quotaStuck: true,
      quotaReason: "stuck: usage limit exceeded",
    },
    expectWhy: "quota",
    expectReason: "stuck: usage limit exceeded",
  });
  out.push({
    name: "conflict-cap below cap runs",
    snapshot: {
      ...base(),
      mergeable: false,
      conflictRound: 1,
      maxConflictRounds: 3,
      hasFeedback: false,
      ciPending: false,
      leftToAuthor: left({ leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false }),
    },
    expectWhy: "run",
    expectHasFeedback: false,
  });
  return out;
}

describe("pr_decision table", () => {
  const rows = cases();
  test(`has at least 40 rows (has ${rows.length})`, () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });
  for (const row of rows) {
    test(row.name, () => {
      const decision = decide(row.snapshot);
      if (row.expectWhy === "run") {
        expect(decision.kind).toBe("run");
        if (decision.kind === "run") {
          expect(decision.hasFeedback).toBe(row.expectHasFeedback as boolean);
        }
        return;
      }
      expect(decision.kind).toBe("skip");
      if (decision.kind !== "skip") return;
      expect(decision.why).toBe(row.expectWhy);
      expect(decision.reason).toBe(row.expectReason as string);
      const entry = SKIP_WHY_TABLE[row.expectWhy as SkipWhy];
      expect(decision.reason).toBe((entry.reason as (params: unknown) => string)(decision.params as never));
      const kinds = decision.effects.map((effect) => effect.kind);
      if (row.expectWhy === "same-finding") {
        expect(kinds).toEqual(["log", "sticky", "resolveHeld", "forgetClaim"]);
      } else if (row.expectWhy === "flake" || row.expectWhy === "shared-failure") {
        expect(kinds).toEqual(["sticky", "recordCiHandled", "resolveHeld", "forgetClaim"]);
      } else if (
        row.expectWhy === "conflict-cap" ||
        row.expectWhy === "round-cap" ||
        row.expectWhy === "quota" ||
        row.expectWhy === "stuck"
      ) {
        expect(kinds).toEqual(["sticky", "resolveHeld", "forgetClaim"]);
      } else {
        expect(kinds).toEqual(["resolveHeld", "forgetClaim"]);
      }
      if (row.expectWhy === "conflict-cap") {
        const sticky = decision.effects.find((effect) => effect.kind === "sticky");
        expect(sticky).toMatchObject({ text: expect.stringContaining(" — run a stuck kick to retry") });
        expect(decision.reason).not.toContain("stuck kick");
      }
    });
  }

  test("latchesIssue matches isSkipLatchReason for every table row", () => {
    const samples: Record<SkipWhy, unknown> = {
      "comment-already-handled": {},
      "settings-unreadable": {},
      "conflict-cap": { round: 3, max: 3 },
      "round-cap": {},
      "ci-pending": {},
      "no-unhandled-feedback": {},
      flake: { checks: [{ name: "build", flake: "reason-a" }] },
      "shared-failure": {
        firstPr: 7,
        check: "build",
        defaultBranch: "main",
        checks: [{ name: "build" }],
      },
      "left-to-author": { leftReason: "conflicted, left to author (label `ignore-conflicts`)" },
      quota: { quotaReason: "stuck: usage limit exceeded" },
      stuck: { stuckReason: "repeated-action" },
      "same-finding": { display: "src/a.ts:10 🔴 boom" },
      "default-branch": {},
      "merge-default-stuck": {},
      "dependency-cycle": {},
      "blocked-by-rejected": {},
      "stuck-other": {},
    };
    for (const [why, params] of Object.entries(samples)) {
      const entry = SKIP_WHY_TABLE[why as SkipWhy];
      const reason = (entry.reason as (params: unknown) => string)(params);
      expect(entry.latchesIssue).toBe(isSkipLatchReason(reason));
    }
    const noDisplay = SKIP_WHY_TABLE["same-finding"];
    const reasonNoDisplay = (noDisplay.reason as (params: unknown) => string)({ display: undefined });
    expect(noDisplay.latchesIssue).toBe(isSkipLatchReason(reasonNoDisplay));
  });

  test("early exits never ask for diffHash", () => {
    for (const row of rows) {
      if (row.expectWhy === "run") continue;
      if (row.expectWhy === "same-finding") continue;
      const withoutDiff: PrDecisionSnapshot = { ...row.snapshot, diffHash: undefined };
      if (withoutDiff.findingIdentityHash && withoutDiff.hasFeedback) continue;
      const decision = decide(withoutDiff);
      expect(decision).not.toMatchObject({ kind: "need", field: "diffHash" });
    }
  });

  test("settings-unreadable never asks for leftToAuthor", () => {
    const snapshot: PrDecisionSnapshot = { ...base(), ignoreAuthors: undefined, leftToAuthor: undefined };
    const decision = decide(snapshot);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.why).toBe("settings-unreadable");
  });

  test("needs leftToAuthor when unresolved", () => {
    const snapshot: PrDecisionSnapshot = { ...base(), leftToAuthor: undefined };
    expect(decide(snapshot)).toMatchObject({ kind: "need", field: "leftToAuthor" });
  });

  test("needs diffHash when same-finding identity present", () => {
    const snapshot: PrDecisionSnapshot = {
      ...base(),
      findingIdentityHash: FIND_F,
      diffHash: undefined,
      preCapFingerprint: { kind: "action", hash: ACTION_A },
    };
    expect(decide(snapshot)).toMatchObject({ kind: "need", field: "diffHash" });
  });
});

describe("pr_decision conflict caller", () => {
  function conflictBase(): PrDecisionSnapshot {
    return {
      ...base(),
      ignoreAuthors: [],
      leftToAuthor: left({ leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false }),
      mergeable: false,
      conflictRound: 0,
      maxConflictRounds: 3,
      hasFeedback: false,
      ciPending: false,
      ciUnhandled: [],
      stuckFingerprints: [],
      quotaStuck: false,
      quotaReason: "",
    };
  }

  test("left-to-author skips with reason and forgetClaim only", () => {
    const decision = decide(
      {
        ...conflictBase(),
        leftToAuthor: left({
          leftToAuthor: true,
          leftReason: "conflicted, left to author (label `ignore-conflicts`)",
          conflictedLeftToAuthor: true,
        }),
      },
      "conflict"
    );
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.why).toBe("left-to-author");
    expect(decision.reason).toBe("conflicted, left to author (label `ignore-conflicts`)");
    expect(decision.effects.map((effect) => effect.kind)).toEqual(["forgetClaim"]);
  });

  test("conflict-cap skips stuck with sticky then forgetClaim", () => {
    const decision = decide({ ...conflictBase(), conflictRound: 3, maxConflictRounds: 3 }, "conflict");
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.why).toBe("conflict-cap");
    expect(decision.reason).toBe("stuck: cannot resolve conflicts (3/3 conflict rounds)");
    expect(decision.effects.map((effect) => effect.kind)).toEqual(["sticky", "forgetClaim"]);
  });

  test("quota skips stuck with sticky then forgetClaim", () => {
    const decision = decide(
      { ...conflictBase(), quotaStuck: true, quotaReason: "stuck: usage limit exceeded" },
      "conflict"
    );
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.why).toBe("quota");
    expect(decision.reason).toBe("stuck: usage limit exceeded");
    expect(decision.effects.map((effect) => effect.kind)).toEqual(["sticky", "forgetClaim"]);
  });

  test("repeated-action history skips stuck without a current fingerprint", () => {
    const decision = decide(
      {
        ...conflictBase(),
        stuckFingerprints: [
          { kind: "action", hash: ACTION_A },
          { kind: "action", hash: ACTION_A },
          { kind: "action", hash: ACTION_A },
          { kind: "action", hash: ACTION_A },
        ],
      },
      "conflict"
    );
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.why).toBe("stuck");
    expect(decision.reason).toBe("stuck: repeated action");
    expect(decision.effects.map((effect) => effect.kind)).toEqual(["sticky", "forgetClaim"]);
  });

  test("left-to-author wins before conflict-cap", () => {
    const decision = decide(
      {
        ...conflictBase(),
        conflictRound: 3,
        maxConflictRounds: 3,
        leftToAuthor: left({
          leftToAuthor: true,
          leftReason: "conflicted, left to author (author `alice`)",
          conflictedLeftToAuthor: true,
        }),
      },
      "conflict"
    );
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.why).toBe("left-to-author");
  });

  test("no resolveHeld in any conflict row", () => {
    const rows: PrDecisionSnapshot[] = [
      { ...conflictBase(), branchIsDefault: true },
      { ...conflictBase(), ignoreAuthors: undefined, leftToAuthor: undefined },
      {
        ...conflictBase(),
        leftToAuthor: left({ leftToAuthor: true, leftReason: "x", conflictedLeftToAuthor: true }),
      },
      { ...conflictBase(), conflictRound: 3, maxConflictRounds: 3 },
      { ...conflictBase(), quotaStuck: true, quotaReason: "stuck: usage limit exceeded" },
      {
        ...conflictBase(),
        stuckFingerprints: [
          { kind: "error", hash: ERROR_E },
          { kind: "error", hash: ERROR_E },
          { kind: "error", hash: ERROR_E },
        ],
      },
    ];
    for (const snapshot of rows) {
      const decision = decide(snapshot, "conflict");
      expect(decision.kind).toBe("skip");
      if (decision.kind !== "skip") continue;
      expect(decision.effects.map((effect) => effect.kind)).not.toContain("resolveHeld");
    }
  });

  test("conflict never returns same-finding", () => {
    const decision = decide(
      {
        ...conflictBase(),
        stuckFingerprints: [
          { kind: "finding", hash: SAME_H },
          { kind: "finding", hash: SAME_H },
        ],
        findingIdentityHash: FIND_F,
        diffHash: { value: DIFF_D },
        preCapFingerprint: { kind: "action", hash: ACTION_A },
      },
      "conflict"
    );
    expect(decision.kind).toBe("run");
    if (decision.kind === "run") expect(decision.hasFeedback).toBe(false);
  });

  test("conflict default-branch text refuses the merge", () => {
    const decision = decide({ ...conflictBase(), branchIsDefault: true }, "conflict");
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.why).toBe("default-branch");
    expect(decision.reason).toBe(CONFLICT_DEFAULT_BRANCH_REASON);
    expect(decision.effects.map((effect) => effect.kind)).toEqual(["forgetClaim"]);
  });

  test("conflict settings-unreadable skips with forgetClaim only", () => {
    const decision = decide({ ...conflictBase(), ignoreAuthors: undefined, leftToAuthor: undefined }, "conflict");
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.why).toBe("settings-unreadable");
    expect(decision.effects.map((effect) => effect.kind)).toEqual(["forgetClaim"]);
  });

  test("conflict needs leftToAuthor when unresolved", () => {
    expect(decide({ ...conflictBase(), leftToAuthor: undefined }, "conflict")).toMatchObject({
      kind: "need",
      field: "leftToAuthor",
    });
  });
});

describe("classify closer snapshot", () => {
  function closerBase(): CloserSnapshot {
    return {
      followupRound: 0,
      maxFollowupRounds: 3,
      hasUnhandledFeedback: false,
      maintainerOnlyPending: false,
      ciPending: true,
      ciUnhandledCount: 0,
      prEligible: false,
      mergeable: undefined,
      hasJumiCommit: undefined,
      labeledOrAuthorListed: false,
      conflictRound: 0,
      maxConflictRounds: 3,
      conflictSameHeadBase: true,
    };
  }

  test("follow-up true when round allows with unhandled non-maintainer items", () => {
    expect(classify({ ...closerBase(), hasUnhandledFeedback: true }).followUp).toBe(true);
  });

  test("follow-up false at round cap", () => {
    expect(
      classify({ ...closerBase(), followupRound: 3, maxFollowupRounds: 3, hasUnhandledFeedback: true }).followUp
    ).toBe(false);
  });

  test("follow-up false with no unhandled items", () => {
    expect(classify({ ...closerBase(), hasUnhandledFeedback: false }).followUp).toBe(false);
  });

  test("follow-up false when only maintainer questions pending", () => {
    expect(classify({ ...closerBase(), hasUnhandledFeedback: true, maintainerOnlyPending: true }).followUp).toBe(false);
  });

  test("ci true when not pending with unhandled checks", () => {
    expect(classify({ ...closerBase(), ciPending: false, ciUnhandledCount: 2 }).ci).toBe(true);
  });

  test("ci false when pending", () => {
    expect(classify({ ...closerBase(), ciPending: true, ciUnhandledCount: 2 }).ci).toBe(false);
  });

  test("ci false with no unhandled checks", () => {
    expect(classify({ ...closerBase(), ciPending: false, ciUnhandledCount: 0 }).ci).toBe(false);
  });

  test("conflict true for eligible mergeable-false PR below cap on new head", () => {
    expect(
      classify({
        ...closerBase(),
        prEligible: true,
        mergeable: false,
        conflictRound: 1,
        maxConflictRounds: 3,
        conflictSameHeadBase: false,
      }).conflict
    ).toBe(true);
  });

  test("conflict false when ineligible", () => {
    expect(
      classify({
        ...closerBase(),
        prEligible: false,
        mergeable: false,
        conflictRound: 0,
        conflictSameHeadBase: false,
      }).conflict
    ).toBe(false);
  });

  test("conflict false when mergeable is not false", () => {
    expect(
      classify({
        ...closerBase(),
        prEligible: true,
        mergeable: true,
        conflictRound: 0,
        conflictSameHeadBase: false,
      }).conflict
    ).toBe(false);
  });

  test("conflict false when untouched by jumi with label or author", () => {
    expect(
      classify({
        ...closerBase(),
        prEligible: true,
        mergeable: false,
        hasJumiCommit: false,
        labeledOrAuthorListed: true,
        conflictRound: 0,
        conflictSameHeadBase: false,
      }).conflict
    ).toBe(false);
  });

  test("conflict false at round cap", () => {
    expect(
      classify({
        ...closerBase(),
        prEligible: true,
        mergeable: false,
        conflictRound: 3,
        maxConflictRounds: 3,
        conflictSameHeadBase: false,
      }).conflict
    ).toBe(false);
  });

  test("conflict false on already-attempted head and base", () => {
    expect(
      classify({
        ...closerBase(),
        prEligible: true,
        mergeable: false,
        conflictRound: 0,
        conflictSameHeadBase: true,
      }).conflict
    ).toBe(false);
  });

  test("follow-up true and conflict true resolves to follow-up", () => {
    expect(
      classify({
        ...closerBase(),
        hasUnhandledFeedback: true,
        ciPending: true,
        prEligible: true,
        mergeable: false,
        conflictRound: 0,
        conflictSameHeadBase: false,
      }).mode
    ).toBe("follow-up");
  });

  test("conflict only resolves to conflict", () => {
    expect(
      classify({
        ...closerBase(),
        prEligible: true,
        mergeable: false,
        conflictRound: 0,
        conflictSameHeadBase: false,
      }).mode
    ).toBe("conflict");
  });

  test("nothing to do resolves to undefined", () => {
    expect(classify(closerBase()).mode).toBeUndefined();
  });
});
