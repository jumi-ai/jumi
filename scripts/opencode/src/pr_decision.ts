import { createHash } from "node:crypto";
import type { RouterSitReason } from "./router_sits.ts";
import {
  BLOCKED_BY_REJECTED_STUCK,
  CONFLICT_CAP_PREFIX,
  CONFLICT_LEGACY_PREFIX,
  CREDIT_STUCK_TEXT,
  DEPENDENCY_CYCLE_REASON,
  FLAKE_PREFIX,
  IGNORE_CONFLICTS_PREFIX,
  MERGE_DEFAULT_STUCK_TEXT,
  QUOTA_STUCK_TEXT,
  ROUND_CAP_HOLD_TEXT,
  SAME_FINDING_STUCK_TEXT,
  STUCK_OTHER_TEXT,
  TOO_MANY_FOLLOWUP_ROUNDS_REASON,
} from "./skip_why_texts.ts";

export { TOO_MANY_FOLLOWUP_ROUNDS_REASON };

export type DecideCaller = "follow-up" | "conflict";

export const CONFLICT_DEFAULT_BRANCH_REASON = "refusing to merge on the default branch";

type StuckReason = "repeated-action" | "repeated-error" | "ping-pong" | "same-finding";

export type SkipWhy =
  | "comment-already-handled"
  | "settings-unreadable"
  | "conflict-cap"
  | "round-cap"
  | "ci-pending"
  | "no-unhandled-feedback"
  | "flake"
  | "shared-failure"
  | "left-to-author"
  | "quota"
  | "stuck"
  | "same-finding"
  | "default-branch"
  | "merge-default-stuck"
  | "dependency-cycle"
  | "blocked-by-rejected"
  | "stuck-other";

export type Resolved<T> = { value: T };

type StuckKind = "action" | "ci" | "error" | "finding";

interface StuckFingerprintInput {
  kind: StuckKind;
  hash: string;
}

export interface CiCheckRef {
  name: string;
  flake?: string | undefined;
  fingerprint?: string | undefined;
  /** Preserved so `recordCiHandled` writes a latch `isCheckHandled` can match. */
  logHash?: string | undefined;
}

export type SkipParamsMap = {
  "comment-already-handled": Record<string, never>;
  "settings-unreadable": Record<string, never>;
  "conflict-cap": { round: number; max: number };
  "round-cap": Record<string, never>;
  "ci-pending": Record<string, never>;
  "no-unhandled-feedback": Record<string, never>;
  flake: { checks: CiCheckRef[] };
  "shared-failure": { firstPr: number; check: string; defaultBranch: string; checks: CiCheckRef[] };
  "left-to-author": { leftReason: string };
  quota: { quotaReason: string };
  stuck: { stuckReason: StuckReason };
  "same-finding": { display?: string | undefined };
  "default-branch": Record<string, never>;
  "merge-default-stuck": Record<string, never>;
  "dependency-cycle": Record<string, never>;
  "blocked-by-rejected": Record<string, never>;
  "stuck-other": Record<string, never>;
};

type HoldRelease = { kind: "completed" } | { kind: "skipped"; reason: string };

export type Effect =
  | { kind: "log"; message: string }
  | { kind: "sticky"; text: string }
  | { kind: "recordCiHandled"; checks: CiCheckRef[] }
  | { kind: "resolveHeld"; holdKind: "completed" | "skipped"; reason?: string }
  | { kind: "forgetClaim" };

export interface ApplyDeps {
  log: (message: string) => void;
  sticky: (text: string) => Promise<void>;
  recordCiHandled: (checks: CiCheckRef[]) => Promise<void>;
  resolveHeld: (kind: "completed" | "skipped", reason?: string) => Promise<void>;
  forgetClaim: () => Promise<void>;
}

export async function applyEffects(effects: Effect[], deps: ApplyDeps): Promise<void> {
  for (const effect of effects) {
    switch (effect.kind) {
      case "log":
        deps.log(effect.message);
        break;
      case "sticky":
        await deps.sticky(effect.text);
        break;
      case "recordCiHandled":
        await deps.recordCiHandled(effect.checks);
        break;
      case "resolveHeld":
        await deps.resolveHeld(effect.holdKind, effect.reason);
        break;
      case "forgetClaim":
        await deps.forgetClaim();
        break;
    }
  }
}

export interface LeftToAuthorInfo {
  leftToAuthor: boolean;
  leftReason: string;
  conflictedLeftToAuthor: boolean;
}

interface CurrentFingerprint {
  kind: "action" | "ci";
  hash: string;
}

interface SameFindingCurrent {
  kind: "finding";
  hash: string;
}

export interface PrDecisionSnapshot {
  branchIsDefault: boolean;
  triggerCommentId?: number | undefined;
  triggerReviewId?: number | undefined;
  handledCommentIds: readonly number[];
  handledReviewIds: readonly number[];
  ciWake: boolean;
  ignoreAuthors: readonly string[] | undefined;
  mergeable: boolean | null | undefined;
  conflictRound: number;
  maxConflictRounds: number;
  leftToAuthor?: Resolved<LeftToAuthorInfo> | undefined;
  hasFeedback: boolean;
  stateRound: number;
  maxFollowupRounds: number;
  ciPending: boolean;
  ciUnhandled: CiCheckRef[];
  ciHash?: string | undefined;
  /** Pre-elected shared failure: another open PR already owns this fingerprint. */
  sharedFailure?: { firstPr: number; check: string; defaultBranch: string; checks: CiCheckRef[] } | undefined;
  preCapFingerprint?: CurrentFingerprint | undefined;
  findingIdentityHash?: string | undefined;
  diffHash?: Resolved<string | undefined> | undefined;
  stuckFingerprints: readonly StuckFingerprintInput[];
  quotaStuck: boolean;
  quotaReason: string;
  sameFindingDisplay?: string | undefined;
  owner: string;
  repo: string;
  prNumber: number;
}

export type Decision =
  | { kind: "skip"; why: SkipWhy; params: SkipParamsMap[SkipWhy]; effects: Effect[]; reason: string }
  | {
      kind: "run";
      hasFeedback: boolean;
      currentFingerprint: CurrentFingerprint | undefined;
      sameFindingCurrent: SameFindingCurrent | undefined;
    }
  | { kind: "need"; field: "leftToAuthor" | "diffHash" };

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fingerprintSameFinding(findingHash: string, diffHash: string): string {
  return hashText(`${findingHash}|${diffHash}`);
}

function stuckCommentFor(reason: StuckReason): string {
  if (reason === "repeated-action") return "stuck: repeated action";
  if (reason === "repeated-error") return "stuck: repeated error";
  if (reason === "same-finding") return SAME_FINDING_STUCK_TEXT;
  return "stuck: ping-pong";
}

function conflictCapReasonFor(round: number, max: number): string {
  return `stuck: cannot resolve conflicts (${round}/${max} conflict rounds)`;
}

function conflictCapStickyFor(round: number, max: number): string {
  return `${conflictCapReasonFor(round, max)} — run a stuck kick to retry`;
}

function uniqueFlakeReasons(checks: CiCheckRef[]): string[] {
  return [...new Set(checks.map((check) => check.flake).filter((value): value is string => Boolean(value)))];
}

function flakeSkipReasonFor(checks: CiCheckRef[]): string {
  return `${FLAKE_PREFIX} ${uniqueFlakeReasons(checks).join("; ")}`;
}

function flakeCommentFor(checks: CiCheckRef[]): string {
  const names = checks.map((check) => check.name).join(", ");
  return `CI looks like an infra flake (${uniqueFlakeReasons(checks).join("; ")}) on ${names}. A human needs to rerun.`;
}

export function sharedFailureReasonFor(firstPr: number, check: string): string {
  return `waiting on #${firstPr} (check ${check})`;
}

export function sharedFailureStickyFor(firstPr: number, check: string, defaultBranch: string): string {
  return `Same failure as #${firstPr} (check ${check}); waiting for that fix to reach \`${defaultBranch}\`.`;
}

function sameFindingLatchReasonFor(display: string | undefined): string {
  if (!display) return SAME_FINDING_STUCK_TEXT;
  const reason = `${SAME_FINDING_STUCK_TEXT} (${display})`;
  return reason.length > 300 ? `${reason.slice(0, 300).trimEnd()}…)` : reason;
}

const SAME_ACTION_LIMIT = 4;
const SAME_ERROR_LIMIT = 3;
const SAME_FINDING_LIMIT = 3;

function lastThreePingPong(fingerprints: readonly StuckFingerprintInput[]): boolean {
  if (fingerprints.length < 3) return false;
  const a = fingerprints[fingerprints.length - 3];
  const b = fingerprints[fingerprints.length - 2];
  const c = fingerprints[fingerprints.length - 1];
  return a.hash === c.hash && a.hash !== b.hash;
}

function lastRepeat(fingerprints: readonly StuckFingerprintInput[], limit: number): boolean {
  if (fingerprints.length < limit) return false;
  const slice = fingerprints.slice(-limit);
  return slice.every((fp) => fp.hash === slice[0].hash);
}

function detectKindStuck(
  history: readonly StuckFingerprintInput[],
  kind: StuckKind,
  repeatLimit: number,
  repeatReason: StuckReason
): StuckReason | undefined {
  const slice = history.filter((fp) => fp.kind === kind);
  if (lastThreePingPong(slice)) return "ping-pong";
  if (lastRepeat(slice, repeatLimit)) return repeatReason;
  return undefined;
}

function detectStuck(history: readonly StuckFingerprintInput[]): StuckReason | undefined {
  const valid = history.filter((fp) => fp.hash);
  return (
    detectKindStuck(valid, "action", SAME_ACTION_LIMIT, "repeated-action") ??
    detectKindStuck(valid, "ci", SAME_ACTION_LIMIT, "repeated-action") ??
    detectKindStuck(valid, "finding", SAME_FINDING_LIMIT, "same-finding") ??
    detectKindStuck(valid, "error", SAME_ERROR_LIMIT, "repeated-error")
  );
}

function evaluateStuckLocal(
  history: readonly StuckFingerprintInput[],
  current?: StuckFingerprintInput | undefined
): StuckReason | undefined {
  const existing = detectStuck(history);
  if (existing) return existing;
  if (current) return detectStuck([...history, current]);
  return undefined;
}

export interface SkipRow {
  reason: (params: never) => string;
  sticky: (params: never) => string | undefined;
  hold: HoldRelease;
  latchesIssue: boolean;
}

function row<Why extends SkipWhy>(entry: {
  reason: (params: SkipParamsMap[Why]) => string;
  sticky: (params: SkipParamsMap[Why]) => string | undefined;
  hold: HoldRelease;
  latchesIssue: boolean;
}): SkipRow {
  return entry as unknown as SkipRow;
}

export const SKIP_WHY_TABLE: Record<SkipWhy, SkipRow> = {
  "comment-already-handled": row<"comment-already-handled">({
    reason: () => "comment already handled",
    sticky: () => undefined,
    hold: { kind: "skipped", reason: "comment already handled" },
    latchesIssue: false,
  }),
  "settings-unreadable": row<"settings-unreadable">({
    reason: () => "ignore-conflicts settings unreadable",
    sticky: () => undefined,
    hold: { kind: "skipped", reason: "settings unreadable" },
    latchesIssue: false,
  }),
  "conflict-cap": row<"conflict-cap">({
    reason: (params) => conflictCapReasonFor(params.round, params.max),
    sticky: (params) => conflictCapStickyFor(params.round, params.max),
    hold: { kind: "skipped", reason: "conflict cap" },
    latchesIssue: true,
  }),
  "round-cap": row<"round-cap">({
    reason: () => TOO_MANY_FOLLOWUP_ROUNDS_REASON,
    sticky: () => TOO_MANY_FOLLOWUP_ROUNDS_REASON,
    hold: { kind: "skipped", reason: "round cap" },
    latchesIssue: true,
  }),
  "ci-pending": row<"ci-pending">({
    reason: () => "CI still pending",
    sticky: () => undefined,
    hold: { kind: "skipped", reason: "CI still pending" },
    latchesIssue: false,
  }),
  "no-unhandled-feedback": row<"no-unhandled-feedback">({
    reason: () => "no unhandled feedback",
    sticky: () => undefined,
    hold: { kind: "completed" },
    latchesIssue: false,
  }),
  flake: row<"flake">({
    reason: (params) => flakeSkipReasonFor(params.checks),
    sticky: (params) => flakeCommentFor(params.checks),
    hold: { kind: "skipped", reason: "flake" },
    latchesIssue: false,
  }),
  "shared-failure": row<"shared-failure">({
    reason: (params) => sharedFailureReasonFor(params.firstPr, params.check),
    sticky: (params) => sharedFailureStickyFor(params.firstPr, params.check, params.defaultBranch),
    hold: { kind: "skipped", reason: "shared failure" },
    latchesIssue: false,
  }),
  "left-to-author": row<"left-to-author">({
    reason: (params) => params.leftReason,
    sticky: () => undefined,
    hold: { kind: "skipped", reason: "left to author" },
    latchesIssue: false,
  }),
  quota: row<"quota">({
    reason: (params) => params.quotaReason,
    sticky: (params) => params.quotaReason,
    hold: { kind: "skipped", reason: "quota" },
    latchesIssue: true,
  }),
  stuck: row<"stuck">({
    reason: (params) => stuckCommentFor(params.stuckReason),
    sticky: (params) => stuckCommentFor(params.stuckReason),
    hold: { kind: "skipped", reason: "stuck" },
    latchesIssue: true,
  }),
  "same-finding": row<"same-finding">({
    reason: (params) => sameFindingLatchReasonFor(params.display),
    sticky: (params) => sameFindingLatchReasonFor(params.display),
    hold: { kind: "skipped", reason: "same finding" },
    latchesIssue: true,
  }),
  "default-branch": row<"default-branch">({
    reason: () => "refusing to follow up on the default branch",
    sticky: () => undefined,
    hold: { kind: "skipped", reason: "default branch" },
    latchesIssue: false,
  }),
  // Parse-only rows for skip reasons produced outside `decide()`. They are
  // never returned by `decide()`; they exist so `parseSkipWhy` recognizes
  // every stored text through this one table instead of ad-hoc matching.
  "merge-default-stuck": row<"merge-default-stuck">({
    reason: () => MERGE_DEFAULT_STUCK_TEXT,
    sticky: () => MERGE_DEFAULT_STUCK_TEXT,
    hold: { kind: "skipped", reason: "conflict cap" },
    latchesIssue: true,
  }),
  "dependency-cycle": row<"dependency-cycle">({
    reason: () => DEPENDENCY_CYCLE_REASON,
    sticky: () => DEPENDENCY_CYCLE_REASON,
    hold: { kind: "skipped", reason: "stuck" },
    latchesIssue: true,
  }),
  "blocked-by-rejected": row<"blocked-by-rejected">({
    reason: () => BLOCKED_BY_REJECTED_STUCK,
    sticky: () => BLOCKED_BY_REJECTED_STUCK,
    hold: { kind: "skipped", reason: "stuck" },
    latchesIssue: true,
  }),
  "stuck-other": row<"stuck-other">({
    reason: () => STUCK_OTHER_TEXT,
    sticky: () => STUCK_OTHER_TEXT,
    hold: { kind: "skipped", reason: "stuck" },
    latchesIssue: true,
  }),
};

/**
 * A stored skip reason read back through the decision table.
 *
 * - `why` is the table row that produced the text (`stuck-other` for any
 *   other `stuck:` text, so rows written by older images keep latching).
 * - `latches` preserves `isSkipLatchReason` (untrimmed, case-sensitive).
 * - `kickKind` preserves `isConflictStuckReason` (trimmed, lower-cased).
 * - `sit` preserves the decision-owned slice of `normalizeSitReason`.
 */
export interface ParsedSkipWhy {
  why: SkipWhy | undefined;
  latches: boolean;
  kickKind: "conflict" | "follow-up";
  sit: RouterSitReason | undefined;
}

/**
 * Canonical reason text for one table row. `parseSkipWhy` derives its `why`
 * matching from these same rows, so a text change here flows through.
 */
export function reasonText<Why extends SkipWhy>(why: Why, params: SkipParamsMap[Why]): string {
  return (SKIP_WHY_TABLE[why].reason as (params: SkipParamsMap[Why]) => string)(params);
}

/**
 * Hold reason for a skipped follow-up result. Intentionally keeps the old
 * substring semantics (`includes("too many follow-up")`): any round-cap
 * wording, counted or not, resolves the held `pending` as `round cap`,
 * while every other reason passes through unchanged.
 */
export function holdReasonForSkippedResult(reason: unknown): string {
  if (typeof reason === "string" && reason.includes("too many follow-up")) return ROUND_CAP_HOLD_TEXT;
  if (typeof reason === "string") return reason;
  return "follow-up skipped";
}

const COUNTED_CONFLICT_CAP_RE = /^stuck: cannot resolve conflicts \(\d+\/\d+ conflict rounds\)$/;

export function parseSkipWhy(reason: string | null | undefined): ParsedSkipWhy {
  // Preserves `isSkipLatchReason`: untrimmed, case-sensitive `stuck:` prefix.
  const latches = typeof reason === "string" && reason.startsWith("stuck:");
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  const lowered = trimmed.toLowerCase();
  // Preserves `isConflictStuckReason`: trimmed, lower-cased conflict prefixes,
  // which also cover older `stuck: conflict ...` variants and the counted cap.
  const kickKind: ParsedSkipWhy["kickKind"] =
    lowered.startsWith(CONFLICT_CAP_PREFIX) || lowered.startsWith(CONFLICT_LEGACY_PREFIX) ? "conflict" : "follow-up";
  // Preserves the decision-owned slice of `normalizeSitReason`.
  let sit: RouterSitReason | undefined;
  if (trimmed === reasonText("ci-pending", {})) sit = "ci-not-completed";
  else if (lowered.startsWith(IGNORE_CONFLICTS_PREFIX)) sit = "conflict-ignored";
  else if (
    trimmed === reasonText("no-unhandled-feedback", {}) ||
    trimmed === ROUND_CAP_HOLD_TEXT ||
    trimmed === reasonText("comment-already-handled", {})
  )
    sit = undefined;
  else if (trimmed.startsWith("stuck:")) sit = "implement-latch";
  else sit = undefined;

  let why: SkipWhy | undefined;
  if (typeof reason !== "string" || trimmed === "") {
    why = undefined;
  } else if (trimmed === TOO_MANY_FOLLOWUP_ROUNDS_REASON) {
    // Preserves `isTooManyFollowupRoundsReason`: trimmed exact equality.
    why = "round-cap";
  } else if (COUNTED_CONFLICT_CAP_RE.test(trimmed)) {
    why = "conflict-cap";
  } else if (trimmed === MERGE_DEFAULT_STUCK_TEXT) {
    why = "merge-default-stuck";
  } else if (trimmed === DEPENDENCY_CYCLE_REASON) {
    why = "dependency-cycle";
  } else if (trimmed === BLOCKED_BY_REJECTED_STUCK) {
    why = "blocked-by-rejected";
  } else if (trimmed === QUOTA_STUCK_TEXT || trimmed === CREDIT_STUCK_TEXT) {
    why = "quota";
  } else if (trimmed === SAME_FINDING_STUCK_TEXT || trimmed.startsWith(`${SAME_FINDING_STUCK_TEXT} (`)) {
    // The bare text is produced both by `stuck` with `same-finding` and by
    // `same-finding` without a display; it maps to `same-finding` here.
    why = "same-finding";
  } else if (
    trimmed === stuckCommentFor("repeated-action") ||
    trimmed === stuckCommentFor("repeated-error") ||
    trimmed === stuckCommentFor("ping-pong")
  ) {
    why = "stuck";
  } else if (lowered.startsWith(IGNORE_CONFLICTS_PREFIX)) {
    // Preserves `isIgnoreConflictsSkipReason`: trimmed, case-insensitive leave prefix.
    why = "left-to-author";
  } else if (trimmed.startsWith(FLAKE_PREFIX)) {
    why = "flake";
  } else if (trimmed === reasonText("comment-already-handled", {})) {
    why = "comment-already-handled";
  } else if (trimmed === reasonText("settings-unreadable", {})) {
    why = "settings-unreadable";
  } else if (trimmed === reasonText("ci-pending", {})) {
    why = "ci-pending";
  } else if (trimmed === reasonText("no-unhandled-feedback", {})) {
    why = "no-unhandled-feedback";
  } else if (trimmed === reasonText("default-branch", {})) {
    why = "default-branch";
  } else if (latches) {
    why = "stuck-other";
  } else {
    why = undefined;
  }
  return { why, latches, kickKind, sit };
}

/**
 * Whether the router owns no sit mapping for this text and the decision
 * table does. `normalizeSitReason` returns `sit` for owned texts (including
 * the round-cap hold alias, which is never a skip reason) and falls through
 * to the router-computed list otherwise. A trimmed `stuck:` sit without a
 * `why` (leading-whitespace unknown `stuck:` text, where `latches` stays
 * false) is still owned, so the parsed sit is not discarded.
 */
export function sitForOwnedReason(reason: string | null | undefined): {
  owned: boolean;
  sit: RouterSitReason | undefined;
} {
  const parsed = parseSkipWhy(reason);
  if (parsed.why !== undefined || parsed.sit !== undefined) return { owned: true, sit: parsed.sit };
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text === ROUND_CAP_HOLD_TEXT) return { owned: true, sit: undefined };
  return { owned: false, sit: undefined };
}

function buildSkipEffects(
  why: SkipWhy,
  params: SkipParamsMap[SkipWhy],
  snapshot: PrDecisionSnapshot,
  caller: DecideCaller = "follow-up"
): { reason: string; effects: Effect[] } {
  const entry = SKIP_WHY_TABLE[why];
  const reason =
    caller === "conflict" && why === "default-branch"
      ? CONFLICT_DEFAULT_BRANCH_REASON
      : (entry.reason as (params: unknown) => string)(params);
  const stickyText = (entry.sticky as (params: unknown) => string | undefined)(params);
  const effects: Effect[] = [];
  if (caller === "conflict") {
    if (stickyText !== undefined) {
      effects.push({ kind: "sticky", text: stickyText });
    }
    effects.push({ kind: "forgetClaim" });
    return { reason, effects };
  }
  if (why === "same-finding") {
    const display = (params as SkipParamsMap["same-finding"]).display;
    const message = `same finding repeated${display ? ` (${display})` : ""} on unchanged diff for ${snapshot.owner}/${snapshot.repo}#${snapshot.prNumber}`;
    effects.push({ kind: "log", message });
  }
  if (stickyText !== undefined) {
    effects.push({ kind: "sticky", text: stickyText });
  }
  if (why === "flake") {
    effects.push({ kind: "recordCiHandled", checks: (params as SkipParamsMap["flake"]).checks });
  }
  if (why === "shared-failure") {
    effects.push({ kind: "recordCiHandled", checks: (params as SkipParamsMap["shared-failure"]).checks });
  }
  if (entry.hold.kind === "completed") {
    effects.push({ kind: "resolveHeld", holdKind: "completed" });
  } else {
    effects.push({ kind: "resolveHeld", holdKind: "skipped", reason: entry.hold.reason });
  }
  effects.push({ kind: "forgetClaim" });
  return { reason, effects };
}

function skip<Why extends SkipWhy>(
  why: Why,
  params: SkipParamsMap[Why],
  snapshot: PrDecisionSnapshot,
  caller: DecideCaller = "follow-up"
): Extract<Decision, { kind: "skip" }> {
  const { reason, effects } = buildSkipEffects(why, params, snapshot, caller);
  return { kind: "skip", why, params, effects, reason };
}

export function decide(snapshot: PrDecisionSnapshot, caller: DecideCaller = "follow-up"): Decision {
  if (caller === "conflict") {
    return decideConflict(snapshot);
  }
  if (snapshot.branchIsDefault) {
    return skip("default-branch", {}, snapshot, caller);
  }
  const triggerHandled =
    (snapshot.triggerCommentId !== undefined && snapshot.handledCommentIds.includes(snapshot.triggerCommentId)) ||
    (snapshot.triggerReviewId !== undefined && snapshot.handledReviewIds.includes(snapshot.triggerReviewId));
  if (triggerHandled && !snapshot.ciWake) {
    return skip("comment-already-handled", {}, snapshot, caller);
  }
  if (snapshot.ignoreAuthors === undefined) {
    return skip("settings-unreadable", {}, snapshot, caller);
  }
  const leftResolved = snapshot.leftToAuthor;
  if (!leftResolved) {
    return { kind: "need", field: "leftToAuthor" };
  }
  const { conflictedLeftToAuthor, leftReason } = leftResolved.value;
  if (snapshot.mergeable === false && !conflictedLeftToAuthor && snapshot.conflictRound >= snapshot.maxConflictRounds) {
    return skip("conflict-cap", { round: snapshot.conflictRound, max: snapshot.maxConflictRounds }, snapshot, caller);
  }
  let hasFeedback = snapshot.hasFeedback;
  if (hasFeedback && snapshot.stateRound >= snapshot.maxFollowupRounds) {
    if (!snapshot.ciWake) {
      return skip("round-cap", {}, snapshot, caller);
    }
    hasFeedback = false;
  }
  if (!hasFeedback) {
    if (snapshot.ciPending) {
      return skip("ci-pending", {}, snapshot, caller);
    }
    if (!snapshot.ciWake) {
      if (snapshot.mergeable !== false) {
        return skip("no-unhandled-feedback", {}, snapshot, caller);
      }
    } else if (
      snapshot.mergeable !== false &&
      snapshot.ciUnhandled.length > 0 &&
      snapshot.ciUnhandled.every((check) => check.flake)
    ) {
      return skip("flake", { checks: snapshot.ciUnhandled }, snapshot, caller);
    } else if (snapshot.ciWake && snapshot.sharedFailure && snapshot.mergeable !== false) {
      // Shared failure waits instead of fixing again. It never counts toward
      // the round cap (CI wakes bypass it above) and its reason is not
      // `stuck:`, so it never latches as stuck. Only skip when every
      // unhandled check is shared: a single distinct failure must still run.
      // `resolveSharedFailureForWake` only produces `sharedFailure` in that
      // case; this length guard is defense-in-depth for direct callers.
      const sharedNames = new Set(snapshot.sharedFailure.checks.map((check) => check.name));
      const allShared =
        snapshot.ciUnhandled.length > 0 &&
        snapshot.sharedFailure.checks.length >= snapshot.ciUnhandled.length &&
        snapshot.ciUnhandled.every((check) => sharedNames.has(check.name));
      if (allShared) {
        return skip(
          "shared-failure",
          {
            firstPr: snapshot.sharedFailure.firstPr,
            check: snapshot.sharedFailure.check,
            defaultBranch: snapshot.sharedFailure.defaultBranch,
            checks: snapshot.sharedFailure.checks,
          },
          snapshot,
          caller
        );
      }
    }
  }
  if (conflictedLeftToAuthor && !hasFeedback && !snapshot.ciWake) {
    return skip("left-to-author", { leftReason }, snapshot, caller);
  }
  let currentFingerprint: CurrentFingerprint | undefined;
  if (!hasFeedback) {
    currentFingerprint = snapshot.ciHash ? { kind: "ci", hash: snapshot.ciHash } : undefined;
  } else {
    currentFingerprint = snapshot.preCapFingerprint;
  }
  if (snapshot.quotaStuck) {
    return skip("quota", { quotaReason: snapshot.quotaReason }, snapshot, caller);
  }
  const stuckReason = evaluateStuckLocal(snapshot.stuckFingerprints, currentFingerprint);
  if (stuckReason) {
    return skip("stuck", { stuckReason }, snapshot, caller);
  }
  if (hasFeedback) {
    if (snapshot.findingIdentityHash) {
      const diffResolved = snapshot.diffHash;
      if (!diffResolved) {
        return { kind: "need", field: "diffHash" };
      }
      const diffValue = diffResolved.value;
      let sameFindingCurrent: SameFindingCurrent | undefined;
      if (diffValue) {
        sameFindingCurrent = {
          kind: "finding",
          hash: fingerprintSameFinding(snapshot.findingIdentityHash, diffValue),
        };
      } else {
        sameFindingCurrent = undefined;
      }
      if (sameFindingCurrent) {
        const sameStuck = evaluateStuckLocal(snapshot.stuckFingerprints, sameFindingCurrent);
        if (sameStuck === "same-finding") {
          return skip("same-finding", { display: snapshot.sameFindingDisplay }, snapshot, caller);
        }
        if (sameStuck) {
          return skip("stuck", { stuckReason: sameStuck }, snapshot, caller);
        }
      }
      return { kind: "run", hasFeedback, currentFingerprint, sameFindingCurrent };
    }
    return { kind: "run", hasFeedback, currentFingerprint, sameFindingCurrent: undefined };
  }
  return { kind: "run", hasFeedback, currentFingerprint, sameFindingCurrent: undefined };
}

function decideConflict(snapshot: PrDecisionSnapshot): Decision {
  const caller: DecideCaller = "conflict";
  if (snapshot.branchIsDefault) {
    return skip("default-branch", {}, snapshot, caller);
  }
  if (snapshot.ignoreAuthors === undefined) {
    return skip("settings-unreadable", {}, snapshot, caller);
  }
  const leftResolved = snapshot.leftToAuthor;
  if (!leftResolved) {
    return { kind: "need", field: "leftToAuthor" };
  }
  if (leftResolved.value.leftToAuthor) {
    return skip("left-to-author", { leftReason: leftResolved.value.leftReason }, snapshot, caller);
  }
  if (snapshot.conflictRound >= snapshot.maxConflictRounds) {
    return skip("conflict-cap", { round: snapshot.conflictRound, max: snapshot.maxConflictRounds }, snapshot, caller);
  }
  if (snapshot.quotaStuck) {
    return skip("quota", { quotaReason: snapshot.quotaReason }, snapshot, caller);
  }
  const stuckReason = evaluateStuckLocal(snapshot.stuckFingerprints, undefined);
  if (stuckReason) {
    return skip("stuck", { stuckReason }, snapshot, caller);
  }
  return { kind: "run", hasFeedback: false, currentFingerprint: undefined, sameFindingCurrent: undefined };
}

export interface CloserSnapshot {
  followupRound: number;
  maxFollowupRounds: number;
  hasUnhandledFeedback: boolean;
  maintainerOnlyPending: boolean;
  ciPending: boolean;
  ciUnhandledCount: number;
  prEligible: boolean;
  mergeable: boolean | null | undefined;
  hasJumiCommit: boolean | undefined;
  labeledOrAuthorListed: boolean;
  conflictRound: number;
  maxConflictRounds: number;
  conflictSameHeadBase: boolean;
}

export interface CloserClassification {
  followUp: boolean;
  ci: boolean;
  conflict: boolean;
  mode: "follow-up" | "conflict" | undefined;
}

export function classify(snapshot: CloserSnapshot): CloserClassification {
  const followUp =
    snapshot.followupRound < snapshot.maxFollowupRounds &&
    snapshot.hasUnhandledFeedback &&
    !snapshot.maintainerOnlyPending;
  const ci = !snapshot.ciPending && snapshot.ciUnhandledCount > 0;
  const conflict =
    snapshot.prEligible &&
    snapshot.mergeable === false &&
    !(snapshot.hasJumiCommit === false && snapshot.labeledOrAuthorListed) &&
    snapshot.conflictRound < snapshot.maxConflictRounds &&
    !snapshot.conflictSameHeadBase;
  let mode: CloserClassification["mode"];
  if (conflict && !(followUp || ci)) mode = "conflict";
  else if (followUp || ci || conflict) mode = "follow-up";
  else mode = undefined;
  return { followUp, ci, conflict, mode };
}
