import type { CheckState } from "./ports.ts";
import type { ReviewRecord } from "./review_verdict_store.ts";

interface ReviewVerdict {
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

/**
 * Markers around the short findings list the publisher adds to the top-level
 * pull-review body. The list points at the posted inlines so a review whose
 * every finding moved into an inline still reads at the top level. Finding
 * parsers skip the section (see `withoutFindingsListSection`) so a listed
 * finding is never counted twice: once from the body line and once from its
 * inline.
 */
const FINDINGS_LIST_START = "<!-- jumi-findings-list:start -->";
const FINDINGS_LIST_END = "<!-- jumi-findings-list:end -->";

const FINDINGS_LIST_START_RE = /<!--\s*jumi-findings-list:start\s*-->/;
const FINDINGS_LIST_END_RE = /<!--\s*jumi-findings-list:end\s*-->/;

/** Drop the published findings-list section so its lines never parse as findings. */
function withoutFindingsListSection(lines: string[]): string[] {
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    if (FINDINGS_LIST_START_RE.test(line)) {
      inList = true;
      continue;
    }
    if (FINDINGS_LIST_END_RE.test(line)) {
      inList = false;
      continue;
    }
    if (inList) continue;
    out.push(line);
  }
  return out;
}

const MAX_FINDING_LINE = 1_000_000;
const FILE_LINE_RE = /^(.+?):(\d+):\s+(\S.*)$/;
const L_LINE_RE = /^L(\d+):\s+(\S.*)$/;

const CHECK_LINE_RE = /^<!--\s*jumi-check:\s*(success|failure)(?:\s*;\s*((?:(?!-->).)*?))?\s*-->$/i;

/**
 * Make a free-text trailer reason safe for the single-line `jumi-check`
 * HTML comment. Collapses all whitespace (including newlines) to single
 * spaces, then replaces `>` (so also `-->`) with a safe form: `->` becomes
 * `→` and any remaining `>` becomes `›`. The result never contains `>` or
 * a newline, so a trailer built with it always parses back.
 */
export function sanitizeCheckReason(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.replace(/->/g, "→").replace(/>/g, "›");
}

/** Single-line `jumi-check` trailer with a sanitized reason. */
export function buildCheckTrailer(state: "success" | "failure", reason?: string): string {
  const safe = sanitizeCheckReason(reason ?? "");
  return safe ? `<!-- jumi-check: ${state}; ${safe} -->` : `<!-- jumi-check: ${state} -->`;
}

export function lastNonEmptyLine(text: string): string {
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
    reason: sanitizeCheckReason(match[2] ?? ""),
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
    .replace(/<!--\s*jumi-check:\s*(?:success|failure)(?:\s*;\s*(?:(?!-->).)*?)?\s*-->/gi, "")
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
  // A `:` inside the path would make `path:line:` ambiguous: an unlocated
  // store line `marker: <text>` whose text mentions `src/a.ts:12:` must not
  // parse as a located finding with a bogus `marker: ... src/a.ts` path.
  // Real changed-file paths never contain `:`.
  if (!value || value.startsWith("/") || value.includes("\0") || value.includes(":")) return undefined;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return value;
}

function normalizeFindingText(text: string): string {
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
  return parseCheckLine(line.trim()) !== undefined;
}

/** A line that looks like a `jumi-check` trailer, whether or not it parses. */
export function isTrailerShapedLine(line: string): boolean {
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
  const lines = withoutFindingsListSection(text.split(/\r?\n/));
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

const SEVERITY_EMOJI_RE = /^(🔴|🟡|💡|❓)\s*/u;
const SEVERITY_WORD_RE = /^(bug|risk|simpler|suggestions?|questions?|q)\s*:\s*/i;

function severityEmojiForWord(word: string): string {
  switch (word.toLowerCase()) {
    case "bug":
      return "🔴";
    case "risk":
      return "🟡";
    case "simpler":
    case "suggestion":
    case "suggestions":
      return "💡";
    default:
      return "❓";
  }
}

/** First sentence of a flattened finding body, capped so one line stays short. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const match = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  if (match) return match[1].trim();
  return flat.length > 200 ? `${flat.slice(0, 200).trimEnd()}…` : flat;
}

/**
 * One findings-list line: the severity marker, `path:line` (linked to the
 * posted inline when the forge returned a URL for it), and the first sentence
 * of the finding. The line lives inside the `FINDINGS_LIST_START/END`
 * section, so finding parsers never see it as a second copy of the finding.
 */
export function findingListLine(finding: ReviewFinding, url?: string): string {
  let rest = finding.body.replace(/\s+/g, " ").trim();
  let marker = "";
  const emoji = SEVERITY_EMOJI_RE.exec(rest);
  if (emoji) {
    marker = emoji[1];
    rest = rest.slice(emoji[0].length).trim();
    const word = SEVERITY_WORD_RE.exec(rest);
    if (word) rest = rest.slice(word[0].length).trim();
  } else {
    const word = SEVERITY_WORD_RE.exec(rest);
    if (word) {
      marker = severityEmojiForWord(word[1]);
      rest = rest.slice(word[0].length).trim();
    }
  }
  const summary = firstSentence(rest) || firstSentence(finding.body);
  const location = `${finding.path}:${finding.line}`;
  const rendered = url ? `[\`${location}\`](${url})` : `\`${location}\``;
  return `- ${marker ? `${marker} ` : ""}${rendered}: ${summary}`;
}

/**
 * The top-level findings list for a published review: one line per finding
 * that was actually published, linked when `urls` (keyed by
 * `findingFingerprint`) has the inline URL. Empty when there are no findings,
 * so a review with no findings keeps today's body. Unlinked lines mean the
 * inline could not be posted or the forge gave no URL; the full finding text
 * stays in the body for those (see `stripFindingLines` with `posted`).
 */
export function buildFindingsList(findings: ReviewFinding[], urls?: ReadonlyMap<string, string>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const finding of findings) {
    const key = findingFingerprint(finding.path, finding.body);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(findingListLine(finding, urls?.get(key)));
  }
  if (lines.length === 0) return "";
  return [FINDINGS_LIST_START, ...lines, FINDINGS_LIST_END].join("\n");
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

// Same location prefix, but only the question marker: `❓` or `q:` / `question:`.
const QUESTION_MARKER_RE =
  /^(?:[`*_]*(?:L\d+|\S+?:\d+(?:[-–]\d+)?)[`*_]*:\s+)?(?:\*\*|__)?\s*(?:❓|(?:q|question)\s*:)/iu;

function isFindingMarkerLine(original: string): boolean {
  return FINDING_MARKER_RE.test(stripFindingPrefix(original));
}

/** Whether a finding first line carries the question marker (`❓` or `q:`/`question:`). */
export function isQuestionFindingFirstLine(original: string): boolean {
  return QUESTION_MARKER_RE.test(stripFindingPrefix(original));
}

/**
 * Whether a published Jumi inline holds an open `❓` question: the marker is
 * in the inline `path` (e.g. `❓ q: <file>` when the publisher could not map a
 * `file:line:` location) or in the inline `body` (the usual
 * `file`-path + `❓ q: …` body). Uses the same `QUESTION_MARKER_RE` rule the
 * engine used to set `N open questions`, so the two counts cannot disagree.
 */
export function isQuestionInline(path: string | undefined | null, body: string | undefined | null): boolean {
  if (typeof path === "string" && path.trim() && isQuestionFindingFirstLine(path)) return true;
  if (typeof body === "string" && body.trim() && countQuestionFindings(body) > 0) return true;
  return false;
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

  const description =
    sanitizeCheckReason(check.reason) ||
    (check.state === "success" ? "No blocking issues" : "Review requested changes");
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

/**
 * Count the open `❓` questions in a review body: one per finding block
 * whose first line carries the question marker. Continuation lines stay
 * attached to their question and are never double-counted.
 */
export function countQuestionFindings(text: string, opts?: { singleFilePath?: string }): number {
  const { blocks } = collectFindingBlocks(text, { ...opts, includeBareL: true });
  let count = 0;
  for (const block of blocks) {
    if (block.keepNote) continue;
    if (isQuestionFindingFirstLine(block.first)) count++;
  }
  return count;
}

export function openQuestionDescription(count: number): string {
  return `${count} open question${count === 1 ? "" : "s"}`;
}

/** Parent-enforced cap: at most 5 💡 findings publish per review. */
export const MAX_SUGGESTION_FINDINGS = 5;

const SUGGESTION_MARKER_RE =
  /^(?:[`*_]*(?:L\d+|\S+?:\d+(?:[-–]\d+)?)[`*_]*:\s+)?(?:\*\*|__)?\s*(?:💡|(?:simpler|suggestion|suggestions)\s*:)/iu;

export function isSuggestionFindingFirstLine(original: string): boolean {
  return SUGGESTION_MARKER_RE.test(stripFindingPrefix(original));
}

/**
 * Count the 💡 suggestion findings in a review body: one per finding block
 * whose first line carries the suggestion marker. Continuation lines stay
 * attached and are never double-counted. `🔴`/`🟡`/`❓` blocks are ignored.
 */
export function countSuggestionFindings(text: string, opts?: { singleFilePath?: string }): number {
  const { blocks } = collectFindingBlocks(text, { ...opts, includeBareL: true });
  let count = 0;
  for (const block of blocks) {
    if (block.keepNote) continue;
    if (isSuggestionFindingFirstLine(block.first)) count++;
  }
  return count;
}

const BLOCKING_MARKER_RE =
  /^(?:[`*_]*(?:L\d+|\S+?:\d+(?:[-–]\d+)?)[`*_]*:\s+)?(?:\*\*|__)?\s*(?:🔴|🟡|(?:bug|risk)\s*:)/iu;

const BUG_MARKER_RE = /^(?:[`*_]*(?:L\d+|\S+?:\d+(?:[-–]\d+)?)[`*_]*:\s+)?(?:\*\*|__)?\s*(?:🔴|bug\s*:)/iu;

const RISK_MARKER_RE = /^(?:[`*_]*(?:L\d+|\S+?:\d+(?:[-–]\d+)?)[`*_]*:\s+)?(?:\*\*|__)?\s*(?:🟡|risk\s*:)/iu;

// A location prefix (`<path>:<line>:` or `L<line>:`) on a finding first line.
const LOCATION_PREFIX_RE = /^(?:[`*_]*(?:L\d+|\S+?:\d+(?:[-–]\d+)?)[`*_]*:\s+)/;

export function isBlockingFindingFirstLine(original: string): boolean {
  return BLOCKING_MARKER_RE.test(stripFindingPrefix(original));
}

export function isBugFindingFirstLine(original: string): boolean {
  return BUG_MARKER_RE.test(stripFindingPrefix(original));
}

export function isRiskFindingFirstLine(original: string): boolean {
  return RISK_MARKER_RE.test(stripFindingPrefix(original));
}

/**
 * Split a blocking finding first line into its location and its own body:
 * the text after the severity marker on that same line. A bare `🔴` with
 * neither a location nor own-body text carries nothing actionable: the
 * promised detail either never follows (as in the #562 stale summary) or
 * lives only in prose the publisher cannot stand behind.
 */
function blockingLineParts(first: string): { hasLocation: boolean; body: string } {
  let rest = stripFindingPrefix(first);
  let hasLocation = false;
  const loc = LOCATION_PREFIX_RE.exec(rest);
  if (loc) {
    hasLocation = true;
    rest = rest.slice(loc[0].length);
  }
  rest = rest.replace(/^(?:\*\*|__)?\s*/, "");
  const marker = /^(?:🔴|🟡|bug\s*:|risk\s*:)/iu.exec(rest);
  if (marker) {
    rest = rest.slice(marker[0].length).trimStart();
    // A doubled severity word (`🔴 bug:`) is still just the marker.
    const word = /^(?:bug|risk)\s*:/iu.exec(rest);
    if (word) rest = rest.slice(word[0].length);
  }
  return { hasLocation, body: rest.trim() };
}

/**
 * Whether a finding first line is an actionable blocking finding: a `🔴` /
 * `bug:` (or `🟡` / `risk:`) line that publishes with a location or a body
 * of its own. Marker-only lines with neither never fail the check.
 */
function isActionableBlockingFirstLine(original: string): boolean {
  const stripped = stripFindingPrefix(original);
  if (!BLOCKING_MARKER_RE.test(stripped)) return false;
  const { hasLocation, body } = blockingLineParts(original);
  return hasLocation || body !== "";
}

function countKindBlockingFindings(text: string, kind: "bug" | "risk", opts?: { singleFilePath?: string }): number {
  const markerRe = kind === "bug" ? BUG_MARKER_RE : RISK_MARKER_RE;
  const { blocks } = collectFindingBlocks(text, { ...opts, includeBareL: true });
  let count = 0;
  for (const block of blocks) {
    if (block.keepNote) continue;
    if (!markerRe.test(stripFindingPrefix(block.first))) continue;
    const { hasLocation, body } = blockingLineParts(block.first);
    if (hasLocation || body !== "") count++;
  }
  return count;
}

/** Actionable `🔴` / `bug:` findings: marker plus a location or own-body text. */
export function countBugFindings(text: string, opts?: { singleFilePath?: string }): number {
  return countKindBlockingFindings(text, "bug", opts);
}

/** Actionable `🟡` / `risk:` findings: marker plus a location or own-body text. */
export function countRiskFindings(text: string, opts?: { singleFilePath?: string }): number {
  return countKindBlockingFindings(text, "risk", opts);
}

/**
 * Count the actionable blocking findings in a review body: one per finding
 * block whose first line carries the `🔴`/`🟡` (or `bug:`/`risk:`) marker
 * with a location or a body of its own. `💡`/`❓` blocks are ignored, as are
 * marker-only lines with neither a location nor own-body text. A failure
 * trailer claiming "N blocking" must match at least one such published
 * finding; otherwise the check would fail with nothing actionable.
 */
export function countBlockingFindings(text: string, opts?: { singleFilePath?: string }): number {
  return countBugFindings(text, opts) + countRiskFindings(text, opts);
}

/** Whether the review body publishes at least one actionable blocking (`🔴`/`🟡`) finding. */
export function hasBlockingFindings(text: string, opts?: { singleFilePath?: string }): boolean {
  return countBlockingFindings(text, opts) > 0;
}

/**
 * Canonical failure reason from the findings that actually publish:
 * `bug:` findings report as blocking, `risk:` findings as risk. Model-written
 * counts never reach the status; the publisher logs when they disagree.
 */
export function describeBlockingReason(bugs: number, risks: number): string {
  const parts: string[] = [];
  if (bugs > 0) parts.push(`${bugs} blocking`);
  if (risks > 0) parts.push(`${risks} risk${risks === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** Canonical success reason from the suggestions that actually publish. */
export function describeSuggestionsReason(count: number): string {
  return `${count} suggestion${count === 1 ? "" : "s"}`;
}

/** Canonical success reason fragment from the open maintainer questions that actually publish. */
function describeMaintainerQuestionReason(count: number): string {
  return `${count} maintainer question${count === 1 ? "" : "s"}`;
}

/** Canonical success reason from published suggestions and open maintainer questions. */
export function describeSuccessReason(suggestions: number, maintainerQuestions: number): string {
  const parts: string[] = [];
  if (suggestions > 0) parts.push(describeSuggestionsReason(suggestions));
  if (maintainerQuestions > 0) parts.push(describeMaintainerQuestionReason(maintainerQuestions));
  return parts.join(", ");
}

/** From a PR's third review on, new unproven 🟡 risks are advisory, never blocking. */
export const THIRD_REVIEW_ADVISORY_ROUND = 3;

/**
 * Structural proof check for a blocking finding body (never a model-rated
 * score). A finding carries proof when it names a concrete failure scenario
 * (`Proof:` with text after the colon) plus either a `file:line` reference
 * or a command with its output (a fenced block or a `$ ` command line after
 * the `Proof:` marker).
 */
export function hasFindingProof(body: string): boolean {
  if (!body || !/proof\s*:\s*\S/i.test(body)) return false;
  const idx = body.search(/proof\s*:/i);
  const tail = idx >= 0 ? body.slice(idx) : body;
  if (/```/.test(tail)) return true;
  if (/^\s*\$ /m.test(tail)) return true;
  if (/[\w.~/+-]+\.[A-Za-z0-9-]+\s*:\s*\d+/.test(tail)) return true;
  return false;
}

/** Count the `N non-blocking risk(s)` fragment in a status reason. Never consults model prose. */
export function trailerNonBlockingRiskCount(reason: string): number {
  const match = /\b(\d+)\s+non-blocking risks?\b/i.exec(reason);
  if (!match) return 0;
  const n = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Canonical status fragment for risks that publish but do not block. */
function describeNonBlockingRisksReason(count: number): string {
  return `${count} non-blocking risk${count === 1 ? "" : "s"}`;
}

/** Canonical success reason with advisory risks: suggestions, non-blocking risks, maintainer questions. */
export function describeSuccessWithNonBlockingRisks(
  suggestions: number,
  nonBlockingRisks: number,
  maintainerQuestions: number
): string {
  const parts: string[] = [];
  if (suggestions > 0) parts.push(describeSuggestionsReason(suggestions));
  if (nonBlockingRisks > 0) parts.push(describeNonBlockingRisksReason(nonBlockingRisks));
  if (maintainerQuestions > 0) parts.push(describeMaintainerQuestionReason(maintainerQuestions));
  return parts.join(", ");
}

/** One body line naming how many 💡 findings the cap dropped. Never parses as a finding. */
export function formatSuggestionCapNote(dropped: number, cap: number = MAX_SUGGESTION_FINDINGS): string {
  return `Jumi dropped ${dropped} 💡 suggestion${dropped === 1 ? "" : "s"} (cap ${cap}).`;
}

/**
 * Enforce the 💡 cap on an already-filtered review body (finding blocks plus
 * parent-authored `keep` notes). Keeps the first `MAX_SUGGESTION_FINDINGS` 💡
 * blocks in order and drops the rest; `🔴`, `🟡`, and `❓` blocks are never
 * dropped. When nothing is dropped the input is returned unchanged so callers
 * that did not hit the cap keep byte-identical bodies. Otherwise the kept
 * blocks are rejoined (same adjacency rule as `keepReviewFindingLines`) with
 * one `formatSuggestionCapNote` line appended.
 */
export function capSuggestionFindings(
  text: string,
  opts?: { singleFilePath?: string; keep?: readonly string[]; maxSuggestions?: number }
): { comment: string; posted: number; dropped: number } {
  const cap = opts?.maxSuggestions ?? MAX_SUGGESTION_FINDINGS;
  const { blocks } = collectFindingBlocks(text, { ...opts, includeBareL: true });
  let total = 0;
  for (const block of blocks) {
    if (block.keepNote) continue;
    if (isSuggestionFindingFirstLine(block.first)) total++;
  }
  if (total <= cap) {
    return { comment: text, posted: total, dropped: 0 };
  }
  let keptSuggestions = 0;
  let out = "";
  let previous = -2;
  const keepBlock = (block: FindingBlock) => {
    const kept = block.lines.join("\n").trimEnd();
    if (!kept.trim()) return;
    if (out) out += block.start === previous + 1 ? "\n" : "\n\n";
    out += kept;
    previous = block.end;
  };
  for (const block of blocks) {
    if (!block.keepNote && isSuggestionFindingFirstLine(block.first)) {
      if (keptSuggestions >= cap) continue;
      keptSuggestions++;
      keepBlock(block);
      continue;
    }
    keepBlock(block);
  }
  const dropped = total - keptSuggestions;
  const note = formatSuggestionCapNote(dropped, cap);
  out = out ? `${out.trimEnd()}\n\n${note}` : note;
  return { comment: out.trim(), posted: keptSuggestions, dropped };
}

function normalizeAuthorLogin(login: string | undefined | null): string {
  return (login ?? "").trim().toLowerCase();
}

/** Case-insensitive exact login match against the blocking-questions allowlist. */
export function isBlockingQuestionAuthor(
  authorLogin: string | undefined | null,
  blockingAuthors: readonly string[] | undefined | null
): boolean {
  const author = normalizeAuthorLogin(authorLogin);
  if (!author || !blockingAuthors) return false;
  return blockingAuthors.some((entry) => normalizeAuthorLogin(entry) === author);
}

/**
 * Maintainer-only questions: a `❓` finding whose only fix needs a human.
 * The reviewer marks them `❓ maintainer:` (see the rubric): a forge action
 * other than pushing to the branch and writing the PR description (for
 * example filing or closing another issue, changing labels or assignment),
 * or a product or scope decision (for example whether to ship part 1 now or
 * keep going). Findings about the PR description itself are never
 * maintainer-only: the worker writes it with `set_pr_body` (as a fenced Jumi
 * section, appended below maintainer text when the body has no fence).
 */
const MAINTAINER_MARKER_RE =
  /^(?:[`*_]*(?:L\d+|\S+?:\d+(?:[-–]\d+)?)[`*_]*:\s+)?(?:\*\*|__)?\s*(?:(?:❓\s*(?:q\s*:|question\s*:)?|(?:q|question)\s*:)\s*)?❓\s*maintainer\s*:/iu;

/** Whether a finding first line carries the prescribed `❓ maintainer:` marker. */
export function isMaintainerQuestionFirstLine(original: string): boolean {
  return MAINTAINER_MARKER_RE.test(stripFindingPrefix(original));
}

/** Count the `❓ maintainer:` findings in a review body. */
export function countMaintainerQuestionFindings(text: string, opts?: { singleFilePath?: string }): number {
  const { blocks } = collectFindingBlocks(text, { ...opts, includeBareL: true });
  let count = 0;
  for (const block of blocks) {
    if (block.keepNote) continue;
    if (isMaintainerQuestionFirstLine(block.first)) count++;
  }
  return count;
}

/** One body line naming how many maintainer questions hold the merge. Never parses as a finding. */
export function maintainerHoldPendingDescription(count: number): string {
  return `waiting on maintainer: ${count} question${count === 1 ? "" : "s"}`;
}

/** Open maintainer `❓` count for a published body (text path for the hold). */
function openMaintainerQuestionCount(markdown: string | null | undefined, opts?: { singleFilePath?: string }): number {
  if (!markdown) return 0;
  const parsed = parseReviewOutput(markdown);
  if (parsed.verdict.incomplete || parsed.verdict.state !== "success") return 0;
  return countMaintainerQuestionFindings(parsed.comment, opts);
}

/**
 * Whether a published review body holds at least one `❓` and every `❓`
 * is a `❓ maintainer:` question. Callers also check the trailer is a
 * complete success, so a failure with a real bug never counts here.
 */
export function hasOnlyMaintainerQuestions(
  text: string | null | undefined,
  opts?: { singleFilePath?: string }
): boolean {
  if (!text) return false;
  const parsed = parseReviewOutput(text);
  if (parsed.verdict.incomplete || parsed.verdict.state !== "success") return false;
  const total = countQuestionFindings(parsed.comment, opts);
  if (total === 0) return false;
  return countMaintainerQuestionFindings(parsed.comment, opts) === total;
}

/**
 * Whether a single published question block (body or inline text) is a
 * maintainer-only question. Used by the follow-up gate so inline
 * `❓ maintainer:` questions count the same as body ones.
 */
export function isMaintainerOnlyQuestionText(text: string | null | undefined): boolean {
  if (!text) return false;
  return countQuestionFindings(text) > 0 && countMaintainerQuestionFindings(text) === countQuestionFindings(text);
}

/**
 * Whether a published Jumi inline holds a maintainer-only `❓`: the marker
 * is in the inline `path` (e.g. `❓ maintainer: <file>` when the publisher
 * could not map a `file:line:` location) or the inline `body` is a
 * maintainer-only question. A file path that merely mentions "maintainer"
 * (e.g. `src/maintainer.ts`) with a plain `❓ q:` body never counts: only
 * the prescribed `❓ maintainer:` marker counts.
 */
export function isMaintainerQuestionInline(path: string | undefined | null, body: string | undefined | null): boolean {
  if (typeof path === "string" && path.trim() && isMaintainerQuestionFirstLine(path)) return true;
  if (typeof body === "string" && body.trim() && isMaintainerOnlyQuestionText(body)) return true;
  return false;
}

/**
 * Whether a finding first line is an ordinary `❓` question: it carries the
 * question marker but not the prescribed `❓ maintainer:` marker. This is the
 * single place where the "maintainer questions are never blocking questions"
 * rule lives: body and inline blocking-question counts both derive from it,
 * so a `❓ maintainer:` never counts as blocking in either.
 */
function isNonMaintainerQuestionFirstLine(original: string): boolean {
  return isQuestionFindingFirstLine(original) && !isMaintainerQuestionFirstLine(original);
}

/** Count the ordinary `❓` findings in a review body: every `❓` that is not `❓ maintainer:`. */
export function countNonMaintainerQuestionFindings(text: string, opts?: { singleFilePath?: string }): number {
  const { blocks } = collectFindingBlocks(text, { ...opts, includeBareL: true });
  let count = 0;
  for (const block of blocks) {
    if (block.keepNote) continue;
    if (isNonMaintainerQuestionFirstLine(block.first)) count++;
  }
  return count;
}

/**
 * Whether a published Jumi inline holds an ordinary `❓` question: the marker
 * is in the inline `path` as an ordinary question, or the inline `body`
 * holds at least one ordinary question. A `❓ maintainer:` inline never
 * counts here; use `isMaintainerQuestionInline` for that.
 */
export function isNonMaintainerQuestionInline(
  path: string | undefined | null,
  body: string | undefined | null
): boolean {
  if (typeof path === "string" && path.trim() && isNonMaintainerQuestionFirstLine(path)) return true;
  if (typeof body === "string" && body.trim() && countNonMaintainerQuestionFindings(body) > 0) return true;
  return false;
}

/**
 * A review whose only open item is a maintainer-only `❓`: a complete
 * success trailer, at least one question, every question marked
 * `❓ maintainer:`, and no leftover suggestions. Single parse of the
 * trailer; the record-or-text view calls this on the text path.
 */
function isMaintainerOnlyTrailerText(markdown: string | null | undefined): boolean {
  if (!markdown) return false;
  const parsed = parseReviewOutput(markdown);
  if (parsed.verdict.incomplete || parsed.verdict.state !== "success") return false;
  if (Math.max(countSuggestionFindings(parsed.comment), trailerSuggestionCount(parsed.verdict.description)) !== 0) {
    return false;
  }
  const total = countQuestionFindings(parsed.comment);
  if (total === 0) return false;
  return countMaintainerQuestionFindings(parsed.comment) === total;
}

/**
 * Open questions that block the status: the trailer must be a complete
 * success (questions are allowed with success), the PR author must be on the
 * opt-in list, and at least one `❓` finding must remain. With the setting off
 * (no authors) or an unlisted author this is always zero, so today's
 * questions-only success behavior is unchanged.
 */
export function blockingOpenQuestionCount(
  markdown: string | null | undefined,
  prAuthorLogin: string | undefined | null,
  blockingAuthors: readonly string[] | undefined | null,
  opts?: { singleFilePath?: string }
): number {
  if (!markdown || !isBlockingQuestionAuthor(prAuthorLogin, blockingAuthors)) return 0;
  const parsed = parseReviewOutput(markdown);
  if (parsed.verdict.incomplete || parsed.verdict.state !== "success") return 0;
  return countNonMaintainerQuestionFindings(parsed.comment, opts);
}

/** Input to {@link reviewVerdictView}: the stored text plus the row's typed record, when it has one. */
export interface ReviewVerdictViewInput {
  markdown: string | null | undefined;
  record?: ReviewRecord | null;
}

/**
 * What a finished-review-row consumer needs from the verdict. Either backed
 * by the ledger row's `resultJson` or, for rows without one, by the stored
 * text — both spellings agree on stored markdown except the suggestion count
 * (see `test/verdict_view_equivalence.test.ts`): with a usable record the
 * validated `counts.suggestion` is authoritative and the trailer prose is
 * never consulted.
 */
export interface ReviewVerdictView {
  incomplete: boolean;
  state: "success" | "failure";
  description: string;
  /** Parent-computed published suggestion count, never regex over the model's reason. */
  suggestionCount: number;
  /** Open `❓ maintainer:` count: text findings or the record's stored count. */
  maintainerQuestionCount: number;
  isMaintainerOnly: boolean;
  blockingQuestionCount(
    prAuthorLogin: string | undefined | null,
    blockingAuthors: readonly string[] | undefined | null,
    opts?: { singleFilePath?: string }
  ): number;
}

function recordMaintainerQuestionCount(record: ReviewRecord): number {
  const stored = (record.counts as { maintainerQuestion?: unknown }).maintainerQuestion;
  if (typeof stored === "number" && Number.isSafeInteger(stored) && stored >= 0) {
    return Math.min(stored, record.counts.question);
  }
  // Old rows predate the stored count: derive it from the findings so the
  // record path still agrees with the text parser on stored markdown. The
  // check mirrors `toMarkdown()` canonicalization: each part (title, body)
  // is canonicalized separately, so a `❓ maintainer:` leading either part
  // counts, while a buried mention or an HTML comment prefix does not.
  // Embedded check trailers are stripped first, mirroring `parseReviewOutput`.
  const partIsMaintainer = (part: string): boolean => {
    let cur = part
      .replace(/<!--\s*jumi-check:\s*(?:success|failure)(?:\s*;\s*(?:(?!-->).)*?)?\s*-->/gi, " ")
      .replace(/<!--\s*jumi-review:[^>]*-->/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:\*\*|__)?\s*/, "");
    for (;;) {
      const maint = /^(?:(?:❓\s*(?:q\s*:|question\s*:)?|(?:q|question)\s*:)\s*)?❓\s*maintainer\s*:\s*/iu.exec(cur);
      if (maint) return true;
      const generic = /^(?:❓\s*(?:q\s*:|question\s*:)|(?:q|question)\s*:|❓)\s*/iu.exec(cur);
      if (generic && generic[0].length > 0) {
        cur = cur.slice(generic[0].length).replace(/^(?:\*\*|__)?\s*/, "");
        if (!cur) return false;
        continue;
      }
      return false;
    }
  };
  let count = 0;
  for (const finding of record.findings ?? []) {
    if (finding.severity !== "question") continue;
    if (partIsMaintainer(finding.title ?? "") || partIsMaintainer(finding.body ?? "")) count++;
  }
  return Math.min(count, record.counts.question);
}

function isUsableReviewRecord(record: ReviewRecord | null | undefined): record is ReviewRecord {
  if (!record || typeof record !== "object") return false;
  if (record.version !== 1) return false;
  if (record.state !== "success" && record.state !== "failure" && record.state !== "incomplete") return false;
  if (record.reason !== undefined && typeof record.reason !== "string") return false;
  const counts = record.counts;
  if (!counts || typeof counts !== "object") return false;
  if (
    !(
      Number.isSafeInteger(counts.bug) &&
      (counts.bug as number) >= 0 &&
      Number.isSafeInteger(counts.risk) &&
      (counts.risk as number) >= 0 &&
      Number.isSafeInteger(counts.question) &&
      (counts.question as number) >= 0 &&
      Number.isSafeInteger(counts.suggestion) &&
      (counts.suggestion as number) >= 0
    )
  ) {
    return false;
  }
  const stored = (counts as { maintainerQuestion?: unknown }).maintainerQuestion;
  if (stored !== undefined) {
    if (typeof stored !== "number" || !Number.isSafeInteger(stored) || stored < 0) return false;
    if ((stored as number) > (counts.question as number)) return false;
  }
  if (!Array.isArray((record as { findings?: unknown }).findings)) {
    // Old rows predate the findings array: still usable, the stored counts
    // decide. The maintainer count then comes from the stored count alone.
    const countsOnly = (record as { counts?: unknown }).counts;
    if (!countsOnly || typeof countsOnly !== "object") return false;
    return true;
  }
  return true;
}

/**
 * Verdict state and description for a usable record, mirroring what the text
 * parser reads back from the store's `toMarkdown()`: the sanitized reason
 * with the same success/failure defaults. A record with no verdict still has
 * a failure trailer (`Incomplete review: no verdict`) which the text parser
 * reads as a complete failure, never as incomplete — mirror that exactly so
 * row consumers keep today's skip/kick behavior.
 */
function descriptionFromRecord(record: ReviewRecord): { state: "success" | "failure"; description: string } {
  if (record.state === "success" || record.state === "failure") {
    const safe = sanitizeCheckReason(record.reason ?? "");
    return {
      state: record.state,
      description: safe || (record.state === "success" ? "No blocking issues" : "Review requested changes"),
    };
  }
  return { state: "failure", description: "Incomplete review: no verdict" };
}

/**
 * Ledger-row verdict view: the suggestion count is the parent-computed
 * published count — `record.counts.suggestion` when a usable record exists
 * (authoritative; the model-written trailer reason is never consulted for
 * counts), otherwise the published 💡 findings in the stored body
 * (`countSuggestionFindings`) with the model-written trailer reason
 * (`trailerSuggestionCount`) kept as a legacy fallback. The max of the
 * parent count and the trailer keeps old rows (trailer digit, no body
 * findings) handing over while a spelled-out model reason ("One suggestion")
 * with a real 💡 finding also hands over. A corrupt record falls back to the
 * text path.
 */
export function reviewVerdictView(input: ReviewVerdictViewInput): ReviewVerdictView {
  const record = isUsableReviewRecord(input.record) ? input.record : undefined;
  if (!record) {
    const parsed = parseReviewOutput(input.markdown ?? "");
    const description = parsed.verdict.description;
    return {
      incomplete: parsed.verdict.incomplete,
      state: parsed.verdict.state,
      description,
      suggestionCount: Math.max(countSuggestionFindings(parsed.comment), trailerSuggestionCount(description)),
      maintainerQuestionCount: countMaintainerQuestionFindings(parsed.comment),
      isMaintainerOnly: isMaintainerOnlyTrailerText(input.markdown),
      blockingQuestionCount: (prAuthorLogin, blockingAuthors, opts) =>
        blockingOpenQuestionCount(input.markdown, prAuthorLogin, blockingAuthors, opts),
    };
  }
  const base = descriptionFromRecord(record);
  const suggestionCount = record.counts.suggestion;
  const maintainerQuestionCount = recordMaintainerQuestionCount(record);
  const isMaintainerOnly =
    base.state === "success" &&
    suggestionCount === 0 &&
    record.counts.question > 0 &&
    maintainerQuestionCount === record.counts.question;
  return {
    incomplete: false,
    state: base.state,
    description: base.description,
    suggestionCount,
    maintainerQuestionCount,
    isMaintainerOnly,
    blockingQuestionCount: (prAuthorLogin, blockingAuthors, opts) => {
      // Single-file scoping can only be answered from text; no row consumer
      // passes it, but stay on the parser when one does.
      if (opts?.singleFilePath) {
        return blockingOpenQuestionCount(input.markdown, prAuthorLogin, blockingAuthors, opts);
      }
      if (!isBlockingQuestionAuthor(prAuthorLogin, blockingAuthors)) return 0;
      if (base.state !== "success") return 0;
      return Math.max(0, record.counts.question - maintainerQuestionCount);
    },
  };
}
