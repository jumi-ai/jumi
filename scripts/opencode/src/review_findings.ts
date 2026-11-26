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
  return touchedFromFiles(filenames.map((filename) => ({ filename })));
}

const TOUCH_HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** New-file lines covered by a unified patch hunk set (added + context lines). */
function touchedLinesForPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  const raw = patch.split(/\r?\n/);
  let next = 0;
  let inHunk = false;
  for (const row of raw) {
    const hunk = TOUCH_HUNK_RE.exec(row);
    if (hunk) {
      next = Number.parseInt(hunk[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (row.startsWith("+++") || row.startsWith("---")) continue;
    if (row.startsWith("+")) {
      if (Number.isSafeInteger(next) && next >= 1) lines.add(next);
      next += 1;
    } else if (row.startsWith("-")) {
      // Removed line: not a line in the new file.
    } else if (row.startsWith("\\")) {
      // "\ No newline at end of file": no line advance.
    } else {
      if (Number.isSafeInteger(next) && next >= 1) lines.add(next);
      next += 1;
    }
  }
  return lines;
}

/** Build a touched set from files with optional patches; patch hunks populate per-file lines. */
export function touchedFromFiles(files: readonly { filename: string; patch?: string }[]): TouchedBetween {
  const paths = new Set<string>();
  const lines = new Map<string, Set<number>>();
  for (const file of files) {
    const clean = file.filename.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!clean) continue;
    paths.add(clean);
    if (typeof file.patch === "string" && file.patch.trim()) {
      lines.set(clean, touchedLinesForPatch(file.patch));
    }
  }
  return lines.size > 0 ? { paths, lines } : { paths };
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

export interface FindingResponseSelector {
  fingerprint: string;
  path?: string;
  line?: number;
}

/** Split a worker `finding` answer into a ledger selector (path:line prefix, else bare fingerprint). */
export function parseFindingResponseSelector(finding: string): FindingResponseSelector {
  const raw = finding.trim();
  const match = /^\s*([^:\s][^:]*?)\s*:\s*(\d+)\s*:/.exec(raw);
  if (!match) return { fingerprint: raw };
  const path = match[1]?.trim() ?? "";
  const line = Number.parseInt(match[2] ?? "", 10);
  if (!path || !Number.isFinite(line)) return { fingerprint: raw };
  return { fingerprint: raw, path, line };
}

/** Ledger surface for persisting worker pushback (the full store satisfies this). */
export type FindingResponseLedger = Pick<import("./review_jobs.ts").ReviewJobStore, "recordFindingResponse">;

/** Persist buffered worker `finding_response` answers (fail-open per answer); returns the number recorded. */
export async function persistFindingResponses(
  responses: readonly { finding: string; status: string; reason: string }[],
  target: { owner: string; repo: string; prNumber: number },
  ledger: FindingResponseLedger | undefined,
  log?: (message: string) => void
): Promise<number> {
  if (!ledger || responses.length === 0) return 0;
  let recorded = 0;
  for (const response of responses) {
    const selector = parseFindingResponseSelector(response.finding);
    try {
      const ok = await ledger.recordFindingResponse({
        ...target,
        fingerprint: selector.fingerprint,
        ...(selector.path !== undefined ? { path: selector.path } : {}),
        ...(selector.line !== undefined ? { line: selector.line } : {}),
        status: response.status,
        reason: response.reason,
      });
      if (ok) recorded++;
      else log?.(`finding response unmatched: ${response.finding.slice(0, 120)}`);
    } catch (err) {
      log?.(`finding response unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return recorded;
}

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
