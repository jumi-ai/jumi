import { isSameSuggestion, runnerLabelForStamp } from "./review_suggestions.ts";
import { findingFingerprint, parseReviewFindings, type ReviewFinding } from "./verdict.ts";

/**
 * Per-blocking-finding outcome ledger (issue #902).
 *
 * Jumi already records 💡 outcomes (`jumi_review_suggestions`); 🔴/🟡
 * findings that fail the status cost a round but were never recorded. This
 * module is the parent-side classifier plus the worker pushback validator.
 * The durable rows live in `jumi_review_findings` (see `review_jobs.ts`):
 * one row per blocking finding of the previous review, written when the
 * next review's verdict is stored and settled to `open_at_merge` when the
 * PR merges or closes.
 */

export const BLOCKING_FINDING_SEVERITIES = ["bug", "risk"] as const;
export type BlockingFindingSeverity = (typeof BLOCKING_FINDING_SEVERITIES)[number];

export const BLOCKING_FINDING_OUTCOMES = ["fixed", "dismissed", "repeated", "open_at_merge", "unmatched"] as const;
export type BlockingFindingOutcome = (typeof BLOCKING_FINDING_OUTCOMES)[number];

export function isBlockingFindingOutcome(value: unknown): value is BlockingFindingOutcome {
  return (
    value === "fixed" ||
    value === "dismissed" ||
    value === "repeated" ||
    value === "open_at_merge" ||
    value === "unmatched"
  );
}

export interface BlockingFinding extends ReviewFinding {
  severity: BlockingFindingSeverity;
}

const BUG_BODY_RE = /^(?:[`*_\s]*)(?:🔴\s*(?:bug\s*:)?|bug\s*:|🔴)/iu;
const RISK_BODY_RE = /^(?:[`*_\s]*)(?:🟡\s*(?:risk\s*:)?|risk\s*:|🟡)/iu;

/** Severity of a parsed finding body, or null when it is not blocking. */
export function blockingSeverityOf(body: string): BlockingFindingSeverity | null {
  const text = body.trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
  if (BUG_BODY_RE.test(text)) return "bug";
  if (RISK_BODY_RE.test(text)) return "risk";
  return null;
}

/** Keep only the 🔴/🟡 findings from parsed findings, with their severity. */
export function filterBlockingFindings(findings: readonly ReviewFinding[]): BlockingFinding[] {
  const out: BlockingFinding[] = [];
  for (const finding of findings) {
    const severity = blockingSeverityOf(finding.body);
    if (severity) out.push({ ...finding, severity });
  }
  return out;
}

/** Parse a review body (or joined finding lines) down to its blocking findings. */
export function parseBlockingFindings(text: string, opts?: { singleFilePath?: string }): BlockingFinding[] {
  return filterBlockingFindings(parseReviewFindings(text, opts));
}

/** Same-file similar-text match, reusing the 💡 matcher across heads. */
export function isSameBlockingFinding(
  prev: Pick<ReviewFinding, "path" | "body">,
  curr: Pick<ReviewFinding, "path" | "body">
): boolean {
  return isSameSuggestion(prev, curr);
}

export interface TouchedBetween {
  /** Files touched by at least one commit between the two reviews. */
  paths: Set<string>;
  /** Optional per-file touched lines (new-file lines). Absent means file-level only. */
  lines?: Map<string, Set<number>>;
}

/** Build a file-level touched set from the current PR file list. */
export function touchedFromFilenames(filenames: readonly string[]): TouchedBetween {
  const paths = new Set<string>();
  for (const name of filenames) {
    const clean = name.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (clean) paths.add(clean);
  }
  return { paths };
}

/** True when the commit range touched the finding's file and line. */
export function isFindingTouched(finding: Pick<ReviewFinding, "path" | "line">, touched: TouchedBetween): boolean {
  if (!touched.paths.has(finding.path)) return false;
  const perFile = touched.lines?.get(finding.path);
  if (!perFile) return true;
  if (perFile.size === 0) return true;
  return perFile.has(finding.line);
}

export interface ClassifiedBlockingFinding {
  prev: BlockingFinding;
  outcome: Exclude<BlockingFindingOutcome, "open_at_merge">;
  /** The current-review finding it repeated, when any. */
  matched?: BlockingFinding;
  fingerprint: string;
}

/**
 * Classify each previous blocking finding against the next review:
 * - `repeated`: still reported (same file, similar text);
 * - `fixed`: gone and the range touched its file and line;
 * - `dismissed`: gone and untouched;
 * - `unmatched`: no location, so touching cannot be decided.
 */
export function classifyBlockingFindings(
  prev: readonly BlockingFinding[],
  curr: readonly BlockingFinding[],
  touched: TouchedBetween
): ClassifiedBlockingFinding[] {
  return prev.map((before) => {
    const fingerprint = findingFingerprint(before.path, before.body);
    const matched = curr.find((after) => isSameBlockingFinding(before, after));
    if (matched) return { prev: before, outcome: "repeated" as const, matched, fingerprint };
    if (!before.path) return { prev: before, outcome: "unmatched" as const, fingerprint };
    return {
      prev: before,
      outcome: (isFindingTouched(before, touched) ? "fixed" : "dismissed") as "fixed" | "dismissed",
      fingerprint,
    };
  });
}

/** One ledger row per previous-review blocking finding. */
export interface NewReviewFindingRow {
  forge: string;
  owner: string;
  repo: string;
  prNumber: number;
  severity: BlockingFindingSeverity;
  reviewerRunner: string;
  writerRunner: string;
  reviewRound: number;
  outcome: BlockingFindingOutcome;
  fingerprint: string;
  path: string;
  line: number;
  workerStatus?: string;
  workerReason?: string;
}

export interface ReviewFindingTotalsRow {
  runner: string;
  forge: string;
  severity: string;
  outcome: string;
  count: number;
}

export function normalizeFindingRunner(value: string | null | undefined): string {
  if (!value?.trim()) return "unknown";
  const stamped = runnerLabelForStamp(value);
  if (stamped !== "unknown") return stamped;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "opencode" || trimmed === "claude" || trimmed === "agy" || trimmed === "codex") return trimmed;
  return "unknown";
}

export function normalizeFindingForge(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase() === "github" ? "github" : "gitea";
}

export function normalizeFindingSeverity(value: string | null | undefined): string {
  const v = (value ?? "").trim().toLowerCase();
  return v === "bug" || v === "risk" ? v : "unknown";
}

export function normalizeFindingOutcome(value: string | null | undefined): string {
  return isBlockingFindingOutcome(value) ? value : "unmatched";
}

// ── Structured worker pushback ─────────────────────────────────────────────

export const FINDING_RESPONSE_STATUSES = ["fixed", "unchanged"] as const;
export type FindingResponseStatus = (typeof FINDING_RESPONSE_STATUSES)[number];

export interface FindingResponseInput {
  finding?: unknown;
  fingerprint?: unknown;
  status?: unknown;
  reason?: unknown;
}

export const MAX_FINDING_RESPONSE_REASON_CHARS = 2000;

export function validateFindingResponse(
  input: FindingResponseInput
): { ok: true; finding: string; status: FindingResponseStatus; reason: string } | { ok: false; error: string } {
  const rawFinding =
    typeof input.finding === "string" && input.finding.trim()
      ? input.finding.trim()
      : typeof input.fingerprint === "string"
        ? input.fingerprint.trim()
        : "";
  if (!rawFinding) return { ok: false, error: "finding (or fingerprint) is required" };
  if (input.status !== "fixed" && input.status !== "unchanged") {
    return { ok: false, error: "status must be fixed or unchanged" };
  }
  const reason = typeof input.reason === "string" ? input.reason.replaceAll("\0", "").trim() : "";
  if (reason.length > MAX_FINDING_RESPONSE_REASON_CHARS) {
    return { ok: false, error: `reason is too long (max ${MAX_FINDING_RESPONSE_REASON_CHARS} chars)` };
  }
  if (input.status === "unchanged" && !reason) {
    return { ok: false, error: "reason is required when nothing changed" };
  }
  return { ok: true, finding: rawFinding, status: input.status, reason };
}
