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

function isBlankLine(line: string): boolean {
  return /^\s*$/.test(line);
}

function stripQuoteMarkers(line: string): string {
  return line.replace(/^\s*(?:>\s*)+/, "");
}

function isQuotedLine(line: string): boolean {
  return /^\s*>/.test(line);
}

function isIndentedLine(line: string): boolean {
  return /^\s+\S/.test(stripQuoteMarkers(line));
}

function isListItemLine(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(stripQuoteMarkers(line));
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}(?:\s|$)/.test(stripQuoteMarkers(line).trimStart());
}

function isCheckTrailerLine(line: string): boolean {
  return /<!--\s*jumi-check:/i.test(line);
}

function isFindingLine(original: string, opts?: { singleFilePath?: string }): boolean {
  return findingFromLine(original, opts) !== undefined || isFindingMarkerLine(original);
}

function isFindingStartForBlocks(
  original: string,
  opts?: { singleFilePath?: string },
  includeBareL?: boolean
): boolean {
  if (isFindingLine(original, opts)) return true;
  if (includeBareL) {
    const line = stripFindingPrefix(original);
    const lForm = L_LINE_RE.exec(line);
    if (lForm && parseFindingLine(lForm[1])) return true;
  }
  return false;
}

function blockLastEndsWithColon(blockLines: string[]): boolean {
  for (let i = blockLines.length - 1; i >= 0; i--) {
    const t = blockLines[i].trim();
    if (!t) continue;
    return /[:：]\s*$/.test(t);
  }
  return false;
}

interface FindingBlock {
  start: number;
  end: number;
  lines: string[];
  first: string;
  keepNote?: string;
}

function collectFindingBlocks(
  text: string,
  opts?: { singleFilePath?: string; keep?: readonly string[]; includeBareL?: boolean }
): { blocks: FindingBlock[]; lines: string[] } {
  const lines = text.split(/\r?\n/);
  const keepNotes = (opts?.keep ?? []).map((line) => line.trim()).filter(Boolean);
  const blocks: FindingBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const original = lines[i];
    if (isCheckTrailerLine(original)) {
      i++;
      continue;
    }
    const note = keepNotes.find((k) => original.includes(k));
    if (note) {
      blocks.push({ start: i, end: i, lines: [note], first: original, keepNote: note });
      i++;
      continue;
    }
    if (!isFindingStartForBlocks(original, opts, opts?.includeBareL)) {
      i++;
      continue;
    }
    const blockLines = [original.trimEnd()];
    let j = i + 1;
    let pending = 0;
    let inFence = /^\s*```/.test(stripQuoteMarkers(original));
    while (j < lines.length) {
      const nxt = lines[j];
      if (isCheckTrailerLine(nxt)) break;
      if (keepNotes.some((k) => nxt.includes(k))) break;
      if (!inFence && isHeadingLine(nxt)) break;
      if (!inFence && isFindingStartForBlocks(nxt, opts, opts?.includeBareL)) break;
      if (isBlankLine(nxt)) {
        pending++;
        j++;
        continue;
      }
      const fenceLine = /^\s*```/.test(stripQuoteMarkers(nxt));
      if (inFence || fenceLine) {
        if (pending > 0) blockLines.push("");
        blockLines.push(nxt.trimEnd());
        pending = 0;
        if (fenceLine) {
          const count = (nxt.match(/```/g) ?? []).length;
          if (count % 2 === 1) inFence = !inFence;
        }
        j++;
        continue;
      }
      const list = isListItemLine(nxt);
      const indented = isIndentedLine(nxt);
      const quoted = isQuotedLine(nxt);
      if (list || indented || quoted) {
        if (pending > 0) blockLines.push("");
        blockLines.push(nxt.trimEnd());
        pending = 0;
        j++;
        continue;
      }
      if (blockLastEndsWithColon(blockLines)) {
        if (pending > 0) blockLines.push("");
        blockLines.push(nxt.trimEnd());
        pending = 0;
        j++;
        continue;
      }
      break;
    }
    const end = j - 1 - pending;
    blocks.push({ start: i, end, lines: blockLines, first: original });
    i = j;
  }
  return { blocks, lines };
}

function fullFindingBody(first: ReviewFinding, blockLines: string[]): string {
  const cont = [...blockLines.slice(1)];
  while (cont.length > 0 && cont[0].trim() === "") cont.shift();
  while (cont.length > 0 && cont[cont.length - 1].trim() === "") cont.pop();
  if (cont.length === 0) return first.body;
  return `${first.body}\n${cont.join("\n")}`;
}

export function parseReviewFindings(text: string, opts?: { singleFilePath?: string }): ReviewFinding[] {
  const { blocks } = collectFindingBlocks(text, opts);
  const findings: ReviewFinding[] = [];
  for (const block of blocks) {
    if (block.keepNote) continue;
    const finding = findingFromLine(block.first, opts);
    if (finding) findings.push({ path: finding.path, line: finding.line, body: fullFindingBody(finding, block.lines) });
  }
  return findings;
}

/**
 * Finding blocks as written, first-line list prefix stripped: `file:line:`,
 * `L<line>:`, and every severity-marker line `keepReviewFindingLines`
 * publishes (a range, a backticked location, or no path). Continuation lines
 * (indented, list, or directly wrapped text) stay attached to their finding.
 */
export function reviewFindingLines(text: string): string[] {
  const { blocks } = collectFindingBlocks(text, { includeBareL: true });
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.keepNote) continue;
    const firstStripped = stripFindingPrefix(block.first);
    if (block.lines.length === 1) {
      lines.push(firstStripped);
      continue;
    }
    lines.push([firstStripped, ...block.lines.slice(1).map((l) => l.trimEnd())].join("\n"));
  }
  return lines;
}

export function stripFindingLines(
  text: string,
  opts?: { singleFilePath?: string; posted?: ReadonlySet<string> }
): string {
  const { blocks, lines } = collectFindingBlocks(text, opts);
  const byStart = new Map(blocks.filter((b) => !b.keepNote).map((b) => [b.start, b]));
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const block = byStart.get(i);
    if (block) {
      const finding = findingFromLine(block.first, opts);
      if (finding) {
        const body = fullFindingBody(finding, block.lines);
        const key = findingFingerprint(finding.path, body);
        if (!opts?.posted || opts.posted.has(key)) {
          i = block.end + 1;
          continue;
        }
        for (const l of block.lines) kept.push(l);
        i = block.end + 1;
        continue;
      }
    }
    kept.push(lines[i]);
    i++;
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when a kept finding block ends in an introducing colon (likely truncated). */
export function hasColonEndingFinding(text: string, opts?: { singleFilePath?: string }): boolean {
  const { blocks } = collectFindingBlocks(text, opts);
  return blocks.some((block) => !block.keepNote && blockLastEndsWithColon(block.lines));
}

// A severity marker leading the line, optionally after an `L<n>:` or `<path>:<n>:` location.
// The location may be wrapped in backticks or emphasis and may be a range (`:12-14`).
const FINDING_MARKER_RE =
  /^(?:[`*_]*(?:L\d+|\S+?:\d+(?:[-–]\d+)?)[`*_]*:\s+)?(?:\*\*|__)?\s*(?:🔴|🟡|💡|❓|(?:bug|risk|simpler|suggestion|q|question)\s*:)/iu;

function isFindingMarkerLine(original: string): boolean {
  return FINDING_MARKER_RE.test(stripFindingPrefix(original));
}

/**
 * The published review body: finding blocks only. A finding keeps its
 * continuation lines: nested or indented list items, indented paragraphs, and
 * text wrapped directly under the finding line, up to the next finding, a
 * heading, or a trailer. A tour, verification essay, restated diff, or
 * "no findings" paragraph is dropped, never promoted. `keep` lists
 * parent-authored notes (e.g. the no-CI note); a line that contains one
 * publishes as that note alone, without the child's bullet or surrounding text.
 */
export function keepReviewFindingLines(
  text: string,
  opts?: { singleFilePath?: string; keep?: readonly string[] }
): string {
  const { blocks } = collectFindingBlocks(text, opts);
  let out = "";
  let previous = -2;
  for (const block of blocks) {
    const kept = block.lines.join("\n").trimEnd();
    if (!kept.trim()) continue;
    if (out) out += block.start === previous + 1 ? "\n" : "\n\n";
    out += kept;
    previous = block.end;
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

/**
 * Whether the review publishes at least one finding: an inline
 * (`file:line:` / `L<line>:`) or a severity-marker line left in the body.
 * Parent-authored `keep` notes (e.g. the no-CI note) are not findings. A
 * trailer reason such as "1 risk" is not a finding either.
 */
export function hasPublishedFindings(text: string, opts?: { singleFilePath?: string }): boolean {
  return keepReviewFindingLines(text, opts).trim() !== "";
}
