import type { CheckState } from "./ports.ts";

export interface ReviewVerdict {
  state: Extract<CheckState, "success" | "failure">;
  description: string;
  incomplete: boolean;
}

export interface ParsedReviewOutput {
  comment: string;
  verdict: ReviewVerdict;
  checkLine?: string;
}

export interface ReviewFinding {
  path: string;
  line: number;
  body: string;
}

const MAX_FINDING_LINE = 1_000_000;
const FILE_LINE_RE = /^(.+?):(\d+):\s+(\S.*)$/;
const L_LINE_RE = /^L(\d+):\s+(\S.*)$/;

const CHECK_LINE_RE = /^<!--\s*jumi-check:\s*(success|failure)(?:\s*;\s*([^>]*?))?\s*-->$/i;

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

export function parseCheckLine(line: string): { state: "success" | "failure"; reason: string } | undefined {
  const match = CHECK_LINE_RE.exec(line);
  if (!match) return undefined;
  return {
    state: match[1].toLowerCase() === "success" ? "success" : "failure",
    reason: (match[2] ?? "").trim(),
  };
}

export function trailerSuggestionCount(reason: string): number {
  const match = /\b(\d+)\s+suggestions?\b/i.exec(reason);
  if (!match) return 0;
  const n = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function stripCheckComments(text: string): string {
  return text
    .replace(/<!--\s*jumi-check:\s*(?:success|failure)(?:\s*;\s*[^>]*?)?\s*-->/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripFindingPrefix(line: string): string {
  return line.trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
}

function parseFindingLine(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const line = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(line) || line < 1 || line > MAX_FINDING_LINE) return undefined;
  return line;
}

function usableFindingPath(path: string): string | undefined {
  let value = path.trim().replace(/\\/g, "/");
  if (value.startsWith("./")) value = value.slice(2);
  if (!value || value.startsWith("/") || value.includes("\0")) return undefined;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return value;
}

export function normalizeFindingText(text: string): string {
  return text
    .replace(/<!--\s*jumi-review:[^>]*-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function findingFingerprint(path: string, text: string): string {
  return `${path}\n${normalizeFindingText(text)}`;
}

function findingFromLine(original: string, opts?: { singleFilePath?: string }): ReviewFinding | undefined {
  const line = stripFindingPrefix(original);
  if (!line) return undefined;

  const lForm = L_LINE_RE.exec(line);
  if (lForm) {
    const findingLine = parseFindingLine(lForm[1]);
    const path = opts?.singleFilePath ? usableFindingPath(opts.singleFilePath) : undefined;
    const body = lForm[2].trim();
    if (!findingLine || !path || !body) return undefined;
    return { path, line: findingLine, body };
  }

  const fileLine = FILE_LINE_RE.exec(line);
  if (!fileLine) return undefined;
  const path = usableFindingPath(fileLine[1]);
  const findingLine = parseFindingLine(fileLine[2]);
  const body = fileLine[3].trim();
  if (!path || !findingLine || !body) return undefined;
  return { path, line: findingLine, body };
}

export function parseReviewFindings(text: string, opts?: { singleFilePath?: string }): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const original of text.split(/\r?\n/)) {
    const finding = findingFromLine(original, opts);
    if (finding) findings.push(finding);
  }
  return findings;
}

export function stripFindingLines(
  text: string,
  opts?: { singleFilePath?: string; posted?: ReadonlySet<string> }
): string {
  const kept: string[] = [];
  for (const original of text.split(/\r?\n/)) {
    const finding = findingFromLine(original, opts);
    if (finding) {
      const key = findingFingerprint(finding.path, finding.body);
      if (!opts?.posted || opts.posted.has(key)) continue;
    }
    kept.push(original);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A severity marker leading the line, optionally after an `L<n>:` or `<path>:<n>:` location.
// The location may be wrapped in backticks or emphasis and may be a range (`:12-14`).
const FINDING_MARKER_RE =
  /^(?:[`*_]*(?:L\d+|\S+?:\d+(?:[-–]\d+)?)[`*_]*:\s+)?(?:\*\*|__)?\s*(?:🔴|🟡|💡|❓|(?:bug|risk|simpler|suggestion|q|question)\s*:)/iu;

function isFindingMarkerLine(original: string): boolean {
  return FINDING_MARKER_RE.test(stripFindingPrefix(original));
}

/**
 * The published review body: finding lines only. A tour, verification essay,
 * restated diff, or "no findings" paragraph is dropped, never promoted. `keep`
 * lists parent-authored notes (e.g. the no-CI note); a line that contains one
 * publishes as that note alone, without the child's bullet or surrounding text.
 */
export function keepReviewFindingLines(
  text: string,
  opts?: { singleFilePath?: string; keep?: readonly string[] }
): string {
  const keep = (opts?.keep ?? []).map((line) => line.trim()).filter(Boolean);
  let out = "";
  let previous = -2;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const note = keep.find((k) => original.includes(k));
    let kept: string | undefined;
    if (note) kept = note;
    else if (findingFromLine(original, opts) !== undefined || isFindingMarkerLine(original)) kept = original.trimEnd();
    if (kept === undefined) continue;
    if (out) out += previous === i - 1 ? "\n" : "\n\n";
    out += kept;
    previous = i;
  }
  return out.trim();
}

export function parseReviewOutput(output: string): ParsedReviewOutput {
  const text = output.trim();
  if (!text) {
    return {
      comment: "",
      verdict: { state: "failure", description: "Incomplete review: no output", incomplete: true },
    };
  }

  const lastLine = lastNonEmptyLine(text);
  const check = parseCheckLine(lastLine);
  const comment = stripCheckComments(text);
  if (!check) {
    return {
      comment,
      verdict: { state: "failure", description: "Incomplete review: no check verdict", incomplete: true },
    };
  }

  const description = check.reason || (check.state === "success" ? "No blocking issues" : "Review requested changes");
  return {
    comment,
    checkLine: lastLine,
    verdict: { state: check.state, description, incomplete: false },
  };
}
