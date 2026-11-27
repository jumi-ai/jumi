import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assessMaintainerHoldRelease,
  blockingOpenQuestionCountWithInlines,
  isBlockingQuestionInline,
  openBugsForReview,
  openMaintainerQuestionsAnyTrailer,
  openMaintainerQuestionsForReview,
  openQuestionsForReview,
  openRisksForReview,
} from "../src/followup.ts";
import { isMaintainerOnlyTrailer, shouldHandoverFollowUp } from "../src/handover.ts";
import { isResolvableHoldInline } from "../src/hold_resolve.ts";
import type { InlineComment, PullReview } from "../src/ports.ts";
import type { ReviewResult } from "../src/review.ts";
import {
  buildReviewFacts,
  handoverWakesFromFacts,
  isIgnoredSuccessFromFacts,
  type ReviewFacts,
  type ReviewFactsInlineInput,
  type ReviewFactsSource,
  type ReviewFindingFact,
  type ReviewFindingPlacement,
  type ReviewFindingSeverity,
  type ReviewQuestionKind,
} from "../src/review_facts.ts";
import type { ReviewRecord } from "../src/review_verdict_store.ts";
import {
  blockingFindingIdentities,
  fingerprintFindingIdentityFromParts,
  sameFindingDisplayFromParts,
} from "../src/stuck.ts";
import { loginEquals } from "../src/util/login.ts";
import {
  blockingOpenQuestionCount,
  countBugFindings,
  countMaintainerQuestionFindings,
  countQuestionFindings,
  countRiskFindings,
  countSuggestionFindings,
  hasFindingProof,
  isBlockingQuestionAuthor,
  isBugFindingFirstLine,
  isMaintainerQuestionInline,
  isNonMaintainerQuestionInline,
  isQuestionInline,
  isRiskFindingFirstLine,
  isSuggestionFindingFirstLine,
  parseCheckLine,
  parseReviewFindings,
  parseReviewOutput,
  reviewFindingLines,
  reviewVerdictView,
  trailerNonBlockingRiskCount,
  trailerSuggestionCount,
} from "../src/verdict.ts";

// ---------------------------------------------------------------------------
// Frozen old path: verbatim pre-refactor consumer logic. The new facts path
// (imported above) must agree with these on every corpus case. The frozen
// copies keep importing the retained `verdict.ts` parsers directly, exactly
// like the consumers did before the refactor.
// ---------------------------------------------------------------------------

const REVIEW_MARKER = "<!-- jumi-review:";
const BOT = "jumi[bot]";

function oldLastCheckTrailer(body: string): { state: "success" | "failure"; reason: string } | undefined {
  const lines = body.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    return parseCheckLine(line);
  }
  return undefined;
}

function oldIsOpenJumiInline(inline: InlineComment, botUsername?: string): boolean {
  const body = inline.body ?? "";
  if (!body.includes(REVIEW_MARKER)) return false;
  if (typeof botUsername === "string" && botUsername) {
    if (!loginEquals(inline.user?.login, botUsername)) return false;
  }
  if (!oldIsUnresolvedInline(inline)) return false;
  return true;
}

function oldIsUnresolvedInline(comment: InlineComment): boolean {
  return comment.resolved !== true && comment.resolver == null;
}

function oldIsBlockingQuestionInline(inline: InlineComment, botUsername?: string): boolean {
  if (!oldIsOpenJumiInline(inline, botUsername)) return false;
  return isNonMaintainerQuestionInline(inline.path, inline.body ?? "");
}

function oldIsBugInline(inline: InlineComment, botUsername?: string): boolean {
  if (!oldIsOpenJumiInline(inline, botUsername)) return false;
  if (typeof inline.path === "string" && inline.path.trim() && isBugFindingFirstLine(inline.path)) return true;
  const body = inline.body ?? "";
  return body.trim() !== "" && countBugFindings(body) > 0;
}

function oldIsRiskInline(inline: InlineComment, botUsername?: string): boolean {
  if (!oldIsOpenJumiInline(inline, botUsername)) return false;
  if (typeof inline.path === "string" && inline.path.trim() && isRiskFindingFirstLine(inline.path)) return true;
  const body = inline.body ?? "";
  return body.trim() !== "" && countRiskFindings(body) > 0;
}

function oldIsMaintainerInline(inline: InlineComment, botUsername?: string): boolean {
  if (!oldIsOpenJumiInline(inline, botUsername)) return false;
  return isMaintainerQuestionInline(inline.path, inline.body ?? "");
}

function oldOpenBugsForReview(
  reviewBody: string | null | undefined,
  inlines: readonly InlineComment[],
  botUsername?: string
): number {
  const parsed = parseReviewOutput(reviewBody ?? "");
  const bodyCount = countBugFindings(parsed.comment);
  let inlineCount = 0;
  for (const inline of inlines) {
    if (oldIsBugInline(inline, botUsername)) inlineCount++;
  }
  return bodyCount + inlineCount;
}

function oldOpenRisksForReview(
  reviewBody: string | null | undefined,
  inlines: readonly InlineComment[],
  botUsername?: string
): number {
  const parsed = parseReviewOutput(reviewBody ?? "");
  const bodyCount = countRiskFindings(parsed.comment);
  let inlineCount = 0;
  for (const inline of inlines) {
    if (oldIsRiskInline(inline, botUsername)) inlineCount++;
  }
  return bodyCount + inlineCount;
}

function oldBlockingOpenQuestionCountWithInlines(
  reviewBody: string | null | undefined,
  inlines: readonly InlineComment[],
  prAuthorLogin: string | undefined | null,
  blockingAuthors: readonly string[] | undefined | null,
  botUsername?: string
): number {
  if (!isBlockingQuestionAuthor(prAuthorLogin, blockingAuthors)) return 0;
  const body = reviewBody ?? "";
  const trailer = oldLastCheckTrailer(body);
  if (trailer?.state !== "success") return 0;
  const bodyCount = blockingOpenQuestionCount(body, prAuthorLogin, blockingAuthors);
  let inlineCount = 0;
  for (const inline of inlines) {
    if (oldIsBlockingQuestionInline(inline, botUsername)) inlineCount++;
  }
  return bodyCount + inlineCount;
}

function oldOpenQuestionsForReview(
  reviewBody: string | null | undefined,
  inlines: readonly InlineComment[],
  botUsername?: string
): number {
  const body = reviewBody ?? "";
  if (!body.trim()) return 0;
  const trailer = oldLastCheckTrailer(body);
  if (trailer?.state !== "success") return 0;
  const parsed = parseReviewOutput(body);
  if (parsed.verdict.incomplete || parsed.verdict.state !== "success") return 0;
  const bodyCount = countQuestionFindings(parsed.comment);
  let inlineCount = 0;
  for (const inline of inlines) {
    if (!oldIsOpenJumiInline(inline, botUsername)) continue;
    if (isQuestionInline(inline.path, inline.body ?? "")) inlineCount++;
  }
  return bodyCount + inlineCount;
}

function oldOpenMaintainerQuestionsForReview(
  reviewBody: string | null | undefined,
  inlines: readonly InlineComment[],
  botUsername?: string
): number {
  const body = reviewBody ?? "";
  if (!body.trim()) return 0;
  const trailer = oldLastCheckTrailer(body);
  if (trailer?.state !== "success") return 0;
  const parsed = parseReviewOutput(body);
  if (parsed.verdict.incomplete || parsed.verdict.state !== "success") return 0;
  const bodyCount = countMaintainerQuestionFindings(parsed.comment);
  let inlineCount = 0;
  for (const inline of inlines) {
    if (oldIsMaintainerInline(inline, botUsername)) inlineCount++;
  }
  return bodyCount + inlineCount;
}

function oldOpenMaintainerQuestionsAnyTrailer(
  reviewBody: string | null | undefined,
  inlines: readonly InlineComment[],
  botUsername?: string
): number {
  const body = reviewBody ?? "";
  if (!body.trim()) return 0;
  let parsed: ReturnType<typeof parseReviewOutput>;
  try {
    parsed = parseReviewOutput(body);
  } catch {
    return 0;
  }
  if (parsed.verdict.incomplete) return 0;
  const bodyCount = countMaintainerQuestionFindings(parsed.comment);
  let inlineCount = 0;
  for (const inline of inlines) {
    if (oldIsMaintainerInline(inline, botUsername)) inlineCount++;
  }
  return bodyCount + inlineCount;
}

function oldAssessMaintainerHoldRelease(opts: {
  reviewBody: string | null | undefined;
  inlines: readonly InlineComment[];
  prAuthorLogin?: string | null;
  blockingAuthors?: readonly string[] | null;
  botUsername?: string;
  holdEnabled: boolean;
}) {
  const reviewBody = opts.reviewBody ?? "";
  const parsed = parseReviewOutput(reviewBody);
  const completeSuccess = !parsed.verdict.incomplete && parsed.verdict.state === "success";
  const openBugs = oldOpenBugsForReview(reviewBody, opts.inlines, opts.botUsername);
  const openRisks = oldOpenRisksForReview(reviewBody, opts.inlines, opts.botUsername);
  const openBlockingQuestions = oldBlockingOpenQuestionCountWithInlines(
    reviewBody,
    opts.inlines,
    opts.prAuthorLogin,
    opts.blockingAuthors,
    opts.botUsername
  );
  const openMaintainers = oldOpenMaintainerQuestionsForReview(reviewBody, opts.inlines, opts.botUsername);
  const openSuggestions = countSuggestionFindings(parsed.comment);
  const releasable =
    completeSuccess &&
    openBugs === 0 &&
    openRisks === 0 &&
    openBlockingQuestions === 0 &&
    openMaintainers > 0 &&
    opts.holdEnabled;
  let keepReason: string | undefined;
  if (!releasable) {
    if (!opts.holdEnabled) keepReason = "hold disabled";
    else if (!completeSuccess) keepReason = "not complete success";
    else if (openBugs > 0) keepReason = `${openBugs} blocking`;
    else if (openRisks > 0) keepReason = `${openRisks} risk`;
    else if (openBlockingQuestions > 0) keepReason = `${openBlockingQuestions} blocking questions`;
    else if (openMaintainers === 0) keepReason = "no open maintainer questions";
  }
  const description =
    openSuggestions > 0 ? `${openSuggestions} suggestion${openSuggestions === 1 ? "" : "s"}` : "No blocking issues";
  return {
    releasable,
    ...(keepReason !== undefined ? { keepReason } : {}),
    completeSuccess,
    openBugs,
    openRisks,
    openBlockingQuestions,
    openMaintainers,
    openSuggestions,
    holdEnabled: opts.holdEnabled,
    description,
  };
}

function oldIsBlockingQuestionFinding(
  body: string,
  prAuthor?: string | undefined | null,
  blockingQuestionAuthors?: readonly string[] | null,
  inlines: readonly InlineComment[] = [],
  botUsername?: string
): boolean {
  return oldBlockingOpenQuestionCountWithInlines(body, inlines, prAuthor, blockingQuestionAuthors, botUsername) > 0;
}

function oldIsIgnoredSuccessBody(
  body: string,
  opts: {
    prAuthor?: string | undefined | null;
    blockingQuestionAuthors?: readonly string[] | null;
    followupOnSuggestions?: boolean;
    followupOnRisks?: boolean;
  } = {},
  inlines: readonly InlineComment[] = [],
  botUsername?: string
): boolean {
  const trailer = oldLastCheckTrailer(body);
  if (trailer?.state !== "success") return false;
  if (oldIsBlockingQuestionFinding(body, opts.prAuthor, opts.blockingQuestionAuthors, inlines, botUsername))
    return false;
  const hasSuggestions = trailerSuggestionCount(trailer.reason) > 0;
  const hasRisks = trailerNonBlockingRiskCount(trailer.reason) > 0;
  if (!hasSuggestions && !hasRisks) return false;
  if (hasSuggestions && opts.followupOnSuggestions !== false) return false;
  if (hasRisks && opts.followupOnRisks !== false) return false;
  return true;
}

function oldInlinesForPullReview(reviewId: number, inlines: readonly InlineComment[]): InlineComment[] {
  return inlines.filter(
    (inline) => inline.pull_request_review_id == null || inline.pull_request_review_id === reviewId
  );
}

function oldIsMaintainerOnlyPullReview(
  review: PullReview,
  allJumiInlines: readonly InlineComment[],
  botUsername?: string
): boolean {
  const body = review.body ?? review.content ?? "";
  const trailer = oldLastCheckTrailer(body);
  if (trailer?.state !== "success") return false;
  if (trailerSuggestionCount(trailer.reason) !== 0) return false;
  const inlines = oldInlinesForPullReview(review.id, allJumiInlines);
  const total = oldOpenQuestionsForReview(body, inlines, botUsername);
  if (total === 0) return false;
  return oldOpenMaintainerQuestionsForReview(body, inlines, botUsername) === total;
}

function oldIsMaintainerOnlyTrailer(markdown: string | null | undefined, record?: ReviewRecord | null): boolean {
  return reviewVerdictView({ markdown, record }).isMaintainerOnly;
}

function oldHandoverWakes(
  markdown: string | null | undefined,
  record: ReviewRecord | null | undefined,
  prAuthor: string | undefined | null,
  blockingAuthors: readonly string[] | undefined | null
): boolean {
  if (reviewVerdictView({ markdown, record }).isMaintainerOnly) return false;
  const failure =
    !reviewVerdictView({ markdown, record }).incomplete && reviewVerdictView({ markdown, record }).state === "failure";
  const leftover =
    !reviewVerdictView({ markdown, record }).incomplete &&
    reviewVerdictView({ markdown, record }).state === "success" &&
    reviewVerdictView({ markdown, record }).suggestionCount > 0;
  const blocking = reviewVerdictView({ markdown, record }).blockingQuestionCount(prAuthor, blockingAuthors) > 0;
  if (failure || leftover || blocking) return true;
  try {
    const parsed = parseReviewOutput(markdown ?? "");
    if (!parsed.verdict.incomplete && trailerNonBlockingRiskCount(parsed.verdict.description) > 0) return true;
  } catch {
    return false;
  }
  return false;
}

function oldIsResolvableHoldInline(inline: InlineComment, botUsername?: string): boolean {
  const ownedBody = inline.body ?? "";
  if (!ownedBody.includes(REVIEW_MARKER)) return false;
  if (typeof botUsername === "string" && botUsername) {
    if (!loginEquals(inline.user?.login, botUsername)) return false;
  }
  if (!(inline.resolved !== true && inline.resolver == null)) return false;
  if (oldIsBugLikeInline(inline)) return false;
  if (oldIsRiskLikeInline(inline)) return false;
  if (isMaintainerQuestionInline(inline.path, inline.body ?? "")) return true;
  if (oldIsSuggestionLikeInline(inline)) return true;
  return false;
}

function oldIsBugLikeInline(inline: InlineComment): boolean {
  if (typeof inline.path === "string" && inline.path.trim() && isBugFindingFirstLine(inline.path)) return true;
  const body = inline.body ?? "";
  return body.trim() !== "" && countBugFindings(body) > 0;
}

function oldIsRiskLikeInline(inline: InlineComment): boolean {
  if (typeof inline.path === "string" && inline.path.trim() && isRiskFindingFirstLine(inline.path)) return true;
  const body = inline.body ?? "";
  return body.trim() !== "" && countRiskFindings(body) > 0;
}

function oldIsSuggestionLikeInline(inline: InlineComment): boolean {
  if (typeof inline.path === "string" && inline.path.trim() && isSuggestionFindingFirstLine(inline.path)) return true;
  const body = inline.body ?? "";
  return body.trim() !== "" && countSuggestionFindings(body) > 0;
}

// Frozen latch helpers, verbatim from the pre-refactor `stuck.ts`.
function oldBucketFindingLine(line: number): number {
  if (!Number.isSafeInteger(line) || line < 1) return 0;
  return Math.floor((line - 1) / 5) * 5 + 1;
}

function oldSeverityForIdentity(body: string): "bug" | "risk" | undefined {
  const text = body.trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
  const emoji = /^(🔴|🟡)/u.exec(text);
  if (emoji) return emoji[1] === "🔴" ? "bug" : "risk";
  const word = /^(bug|risk)\s*:/i.exec(text);
  if (word) return word[1].toLowerCase() === "bug" ? "bug" : "risk";
  return undefined;
}

function oldStripSeverityPrefix(body: string): string {
  return body
    .trim()
    .replace(/^(?:[-*]|\d+\.)\s+/, "")
    .replace(/^(?:🔴|🟡)\s*/u, "")
    .replace(/^(?:bug|risk)\s*:\s*/i, "");
}

const OLD_PER_ROUND_SENTENCE_RE =
  /(re-?check|this head|head sha|merge (of|from)|base branch|on this round|per-?round note|reviewed commit)/i;

const OLD_SUMMARY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "will",
  "would",
  "should",
  "there",
  "their",
  "which",
  "while",
  "also",
  "into",
  "about",
  "after",
  "before",
  "again",
  "still",
  "just",
  "than",
  "then",
  "them",
  "they",
  "been",
  "are",
  "was",
  "its",
  "you",
  "your",
  "all",
  "please",
  "thanks",
  "rechecked",
  "recheck",
  "checked",
  "head",
  "merge",
  "base",
  "round",
  "sha",
  "commit",
  "branch",
  "note",
  "review",
  "reviewed",
]);

function oldFirstContentSentence(paragraph: string): string {
  const sentences = paragraph.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) ?? [paragraph];
  const cleaned = sentences.map((sentence) => sentence.trim()).filter(Boolean);
  for (const sentence of cleaned) {
    if (!OLD_PER_ROUND_SENTENCE_RE.test(sentence)) return sentence;
  }
  return cleaned[0] ?? "";
}

function oldFindingSummarySignature(body: string): string {
  let text = oldStripSeverityPrefix(body);
  text = text.replace(/<!--\s*jumi-(?:review|check|stuck|worker)[\s\S]*?-->/gi, " ");
  text = text.replace(/\b[0-9a-f]{7,40}\b/gi, " ");
  text = text.replace(/[`*_>#]+/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const firstParagraph = text.split(/\n\s*\n/)[0] ?? "";
  const sentence = oldFirstContentSentence(firstParagraph.trim());
  const words = sentence
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !OLD_SUMMARY_STOPWORDS.has(word));
  if (words.length === 0) return "";
  words.sort();
  return words.join(" ");
}

function oldBlockingFindingIdentities(markdown: string | null | undefined): string[] {
  if (!markdown?.trim()) return [];
  const findings = parseReviewFindings(markdown);
  const identities: string[] = [];
  for (const finding of findings) {
    const severity = oldSeverityForIdentity(finding.body);
    if (!severity) continue;
    const summary = oldFindingSummarySignature(finding.body);
    if (!summary) continue;
    identities.push(`${finding.path}|${oldBucketFindingLine(finding.line)}|${severity}|${summary}`);
  }
  return [...new Set(identities)].sort();
}

type OldInlineInput = {
  path?: string | null | undefined;
  new_position?: number | null | undefined;
  body?: string | null | undefined;
};

function oldFindingIdentityFromInline(
  path: string | null | undefined,
  line: number | null | undefined,
  body: string | null | undefined
): string | undefined {
  const name = (path ?? "").trim();
  if (!name) return undefined;
  const severity = oldSeverityForIdentity(body ?? "");
  if (!severity) return undefined;
  const summary = oldFindingSummarySignature(body ?? "");
  if (!summary) return undefined;
  const lineNum = typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : 0;
  return `${name}|${oldBucketFindingLine(lineNum)}|${severity}|${summary}`;
}

function oldBlockingFindingIdentitiesFromParts(
  reviewBody: string | null | undefined,
  inlines?: readonly OldInlineInput[] | null | undefined
): string[] {
  const out = new Set<string>(oldBlockingFindingIdentities(reviewBody));
  for (const inline of inlines ?? []) {
    if (!inline) continue;
    const identity = oldFindingIdentityFromInline(
      inline.path ?? undefined,
      typeof inline.new_position === "number" ? inline.new_position : undefined,
      inline.body ?? undefined
    );
    if (identity) out.add(identity);
  }
  return [...out].sort();
}

function oldFirstSentenceForDisplay(body: string): string {
  const text = oldStripSeverityPrefix(body).replace(/\s+/g, " ").trim();
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text);
  const sentence = (match?.[1] ?? text).trim();
  return sentence.length > 140 ? `${sentence.slice(0, 140).trimEnd()}…` : sentence;
}

function oldSameFindingDisplay(markdown: string | null | undefined): string | undefined {
  if (!markdown?.trim()) return undefined;
  const findings = parseReviewFindings(markdown);
  for (const finding of findings) {
    const severity = oldSeverityForIdentity(finding.body);
    if (!severity) continue;
    const emoji = severity === "bug" ? "🔴" : "🟡";
    const summary = oldFirstSentenceForDisplay(finding.body);
    if (!summary) continue;
    const display = `${finding.path}:${finding.line} ${emoji} ${summary}`.trim();
    return display.length > 200 ? `${display.slice(0, 200).trimEnd()}…` : display;
  }
  return undefined;
}

function oldSameFindingDisplayFromParts(
  reviewBody: string | null | undefined,
  inlines?: readonly OldInlineInput[] | null | undefined
): string | undefined {
  const fromBody = oldSameFindingDisplay(reviewBody);
  if (fromBody) return fromBody;
  for (const inline of inlines ?? []) {
    if (!inline?.path?.trim()) continue;
    const severity = oldSeverityForIdentity(inline.body ?? "");
    if (!severity) continue;
    const emoji = severity === "bug" ? "🔴" : "🟡";
    const summary = oldFirstSentenceForDisplay(inline.body ?? "");
    if (!summary) continue;
    const line =
      typeof inline.new_position === "number" && Number.isSafeInteger(inline.new_position) && inline.new_position > 0
        ? inline.new_position
        : 0;
    const display =
      line > 0
        ? `${inline.path!.trim()}:${line} ${emoji} ${summary}`.trim()
        : `${inline.path!.trim()} ${emoji} ${summary}`.trim();
    return display.length > 200 ? `${display.slice(0, 200).trimEnd()}…` : display;
  }
  return undefined;
}

function oldCarryInlineLine(
  inline: {
    path?: string | null | undefined;
    new_position?: number | null | undefined;
    body?: string | null | undefined;
  },
  marker: string
): string | undefined {
  const body = inline.body ?? "";
  if (!inline.path || !body.includes(marker)) return undefined;
  const text = body.split(marker).join("").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return inline.new_position ? `${inline.path}:${inline.new_position}: ${text}` : `${inline.path}: ${text}`;
}

function oldHasOpenBlockers(findings: readonly string[]): boolean {
  return findings.some((line) => /🔴|🟡|❓/.test(line));
}

// ---------------------------------------------------------------------------
// Corpus fixtures.
// ---------------------------------------------------------------------------

const SUCCESS_TRAILER = "<!-- jumi-check: success -->";
const FAIL_TRAILER = "<!-- jumi-check: failure; 1 blocking -->";
const REVIEWED = "Reviewed commit: `abc1234567890`";

let nextInlineId = 9000;

function jumiInline(
  body: string,
  opts: {
    path?: string | null;
    line?: number;
    resolved?: boolean;
    resolver?: string;
    login?: string;
    reviewId?: number;
    marker?: boolean;
    resolveFlag?: boolean;
  } = {}
): InlineComment {
  return {
    id: nextInlineId++,
    body: opts.marker === false ? body : `${REVIEW_MARKER}abc -->\n${body}`,
    user: { login: opts.login ?? BOT },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    path: opts.path ?? "src/a.ts",
    new_position: opts.line ?? 12,
    resolved: opts.resolved,
    resolver: opts.resolver ? { login: opts.resolver } : undefined,
    pull_request_review_id: opts.reviewId,
  } as InlineComment;
}

interface CorpusCase {
  name: string;
  body: string;
  record?: ReviewRecord | null;
  inlines: InlineComment[];
  prAuthor?: string | null;
  blockingAuthors?: readonly string[];
  followupOnSuggestions?: boolean;
  followupOnRisks?: boolean;
}

function recordFixture(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    version: 1,
    state: "success",
    reason: "1 suggestion",
    findings: [],
    counts: { bug: 0, risk: 0, question: 0, suggestion: 1 },
    ...overrides,
  };
}

const BUG_BODY = `src/a.ts:12: 🔴 Null deref on empty input.\n\n${REVIEWED}\n${FAIL_TRAILER}`;

const CORPUS: CorpusCase[] = [
  { name: "bug emoji located, failure", body: BUG_BODY, inlines: [] },
  {
    name: "risk word form, failure",
    body: `src/b.ts:3: risk: Retry storm on 429s.\n\n${REVIEWED}\n${FAIL_TRAILER}`,
    inlines: [],
  },
  {
    name: "suggestion, success with suggestion trailer",
    body: `src/c.ts:7: 💡 simpler: Extract a helper.\n\n${REVIEWED}\n<!-- jumi-check: success; 1 suggestion -->`,
    inlines: [],
  },
  {
    name: "plain question, success",
    body: `src/d.ts:9: ❓ q: Should this retry?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [],
    prAuthor: "alice",
    blockingAuthors: ["alice"],
  },
  {
    name: "maintainer single prefix, success",
    body: `src/e.ts:4: ❓ maintainer: File the upstream issue?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [],
    prAuthor: "alice",
    blockingAuthors: ["alice"],
  },
  {
    name: "maintainer doubled prefix, success",
    body: `src/f.ts:4: ❓ q: ❓ maintainer: Decide the scope?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [],
  },
  {
    name: "unlocated marker line, failure",
    body: `🔴 Database melts under load.\n\n${REVIEWED}\n${FAIL_TRAILER}`,
    inlines: [],
  },
  {
    name: "legacy severity-less located line, success",
    body: `src/g.ts:20: Refactor this loop when nearby.\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [],
  },
  {
    name: "proof present (file:line plus fenced command)",
    body: [
      "src/proof.ts:5: 🔴 Data loss on concurrent write.",
      "",
      "Proof: repro at src/proof.ts:5",
      "",
      "```",
      "$ bun test repro",
      "```",
      "",
      REVIEWED,
      FAIL_TRAILER,
    ].join("\n"),
    inlines: [],
  },
  {
    name: "proof absent",
    body: `src/proof.ts:5: 🔴 Data loss on concurrent write, probably.\n\n${REVIEWED}\n${FAIL_TRAILER}`,
    inlines: [],
  },
  {
    name: "emoji filename with suggestion",
    body: `🔴.ts:2: 💡 simpler: Rename this module.\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [],
  },
  {
    name: "failure trailer with could-not-finish reason",
    body: `Partial review, the tree was dirty.\n\n${REVIEWED}\n<!-- jumi-check: failure; could not finish: dirty tree -->`,
    inlines: [],
  },
  {
    name: "success trailer counts without body findings",
    body: `All clear.\n\n${REVIEWED}\n<!-- jumi-check: success; 2 suggestions -->`,
    inlines: [],
  },
  {
    name: "non-blocking risk trailer with body risk",
    body: `src/h.ts:1: 🟡 risk: Slow query on cold cache.\n\n${REVIEWED}\n<!-- jumi-check: success; 1 non-blocking risk -->`,
    inlines: [],
  },
  {
    name: "mixed maintainer and plain questions",
    body: `src/i.ts:2: ❓ maintainer: File the ticket?\n\nsrc/i.ts:8: ❓ q: Retry here?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [],
    prAuthor: "alice",
    blockingAuthors: ["alice"],
  },
  {
    name: "bare L-form line without scope",
    body: `- L12: 🔴 Off by one.\n\n${REVIEWED}\n${FAIL_TRAILER}`,
    inlines: [],
  },
  {
    name: "dash-prefixed path form",
    body: `- a.ts:12: 🔴 Null deref.\n\n${REVIEWED}\n${FAIL_TRAILER}`,
    inlines: [],
  },
  {
    name: "identical findings at distinct ordinals",
    body: `src/j.ts:12: 🔴 Null deref on empty input.\n\nsrc/j.ts:17: 🔴 Null deref on empty input.\n\n${REVIEWED}\n${FAIL_TRAILER}`,
    inlines: [],
  },
  {
    name: "inline-only findings on trailer-only body",
    body: `${REVIEWED}\n${FAIL_TRAILER}`,
    inlines: [jumiInline("🔴 Null deref on empty input.", { path: "src/a.ts", line: 12 })],
  },
  {
    name: "open bug inline on success body",
    body: `src/k.ts:1: 💡 simpler: Tidy.\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [jumiInline("🔴 Null deref on empty input.", { path: "src/a.ts", line: 12 })],
  },
  {
    name: "resolved and foreign inlines are ignored",
    body: `src/k.ts:1: 💡 simpler: Tidy.\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [
      jumiInline("🔴 Stale bug.", { path: "src/a.ts", line: 12, resolved: true }),
      jumiInline("🔴 Foreign bug.", { path: "src/a.ts", line: 13, login: "someone-else" }),
      jumiInline("🔴 No marker.", { path: "src/a.ts", line: 14, marker: false }),
      jumiInline("🔴 Human resolved.", {
        path: "src/a.ts",
        line: 15,
        resolved: true,
        resolver: "a-human",
      }),
    ],
  },
  {
    name: "inline path carries the marker",
    body: `${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [
      {
        ...jumiInline("Follow-up detail.", { path: "❓ q: src/m.ts", line: 3 }),
        body: `${REVIEW_MARKER}abc -->\nFollow-up detail.`,
      },
    ],
  },
  {
    name: "record present",
    body: `src/r.ts:2: 💡 simpler: Extract.\n\n${REVIEWED}\n<!-- jumi-check: success; 1 suggestion -->`,
    record: recordFixture(),
    inlines: [],
  },
  {
    name: "record present with maintainer question",
    body: `src/r.ts:2: ❓ maintainer: File the ticket?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    record: recordFixture({
      state: "success",
      reason: "1 maintainer question",
      findings: [{ id: "f1", severity: "question", title: "❓ maintainer: File the ticket?", body: "" }],
      counts: { bug: 0, risk: 0, question: 1, suggestion: 0, maintainerQuestion: 1 },
    }),
    inlines: [],
  },
  {
    name: "record absent on same markdown",
    body: `src/r.ts:2: 💡 simpler: Extract.\n\n${REVIEWED}\n<!-- jumi-check: success; 1 suggestion -->`,
    record: null,
    inlines: [],
  },
  {
    name: "corrupt record falls back to text",
    body: `src/r.ts:2: 🔴 Null deref.\n\n${REVIEWED}\n${FAIL_TRAILER}`,
    record: {
      version: 2,
      state: "success",
      findings: [],
      counts: { bug: 0, risk: 0, question: 0, suggestion: 0 },
    } as unknown as ReviewRecord,
    inlines: [],
  },
  {
    name: "blocking authors unset keeps questions unblocking",
    body: `src/d.ts:9: ❓ q: Should this retry?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    inlines: [],
    prAuthor: "alice",
    blockingAuthors: [],
  },
];

// ---------------------------------------------------------------------------
// Equivalence: every consumer predicate, old path vs facts path.
// ---------------------------------------------------------------------------

describe("review facts equivalence (old text path vs facts path)", () => {
  for (const c of CORPUS) {
    test(`counts agree: ${c.name}`, () => {
      expect(openBugsForReview(c.body, c.inlines, BOT)).toBe(oldOpenBugsForReview(c.body, c.inlines, BOT));
      expect(openRisksForReview(c.body, c.inlines, BOT)).toBe(oldOpenRisksForReview(c.body, c.inlines, BOT));
      expect(blockingOpenQuestionCountWithInlines(c.body, c.inlines, c.prAuthor, c.blockingAuthors, BOT)).toBe(
        oldBlockingOpenQuestionCountWithInlines(c.body, c.inlines, c.prAuthor, c.blockingAuthors, BOT)
      );
      expect(openQuestionsForReview(c.body, c.inlines, BOT)).toBe(oldOpenQuestionsForReview(c.body, c.inlines, BOT));
      expect(openMaintainerQuestionsForReview(c.body, c.inlines, BOT)).toBe(
        oldOpenMaintainerQuestionsForReview(c.body, c.inlines, BOT)
      );
      expect(openMaintainerQuestionsAnyTrailer(c.body, c.inlines, BOT)).toBe(
        oldOpenMaintainerQuestionsAnyTrailer(c.body, c.inlines, BOT)
      );
    });

    test(`hold assessment agrees: ${c.name}`, () => {
      const opts = {
        reviewBody: c.body,
        inlines: c.inlines,
        prAuthorLogin: c.prAuthor ?? null,
        blockingAuthors: c.blockingAuthors ?? null,
        botUsername: BOT,
        holdEnabled: true,
      };
      expect(assessMaintainerHoldRelease(opts)).toEqual(oldAssessMaintainerHoldRelease(opts));
      expect(assessMaintainerHoldRelease({ ...opts, holdEnabled: false })).toEqual(
        oldAssessMaintainerHoldRelease({ ...opts, holdEnabled: false })
      );
    });

    test(`ignored-success agrees: ${c.name}`, () => {
      const opts = {
        prAuthor: c.prAuthor ?? null,
        blockingQuestionAuthors: c.blockingAuthors ?? null,
        followupOnSuggestions: c.followupOnSuggestions,
        followupOnRisks: c.followupOnRisks,
      };
      const facts = buildReviewFacts({
        body: c.body,
        inlines: c.inlines,
        botUsername: BOT,
        prAuthorLogin: c.prAuthor,
        blockingAuthors: c.blockingAuthors,
      });
      expect(isIgnoredSuccessFromFacts(facts, opts)).toBe(oldIsIgnoredSuccessBody(c.body, opts, c.inlines, BOT));
      expect(isIgnoredSuccessFromFacts(facts, { ...opts, followupOnSuggestions: false })).toBe(
        oldIsIgnoredSuccessBody(c.body, { ...opts, followupOnSuggestions: false }, c.inlines, BOT)
      );
      expect(isIgnoredSuccessFromFacts(facts, { ...opts, followupOnRisks: false })).toBe(
        oldIsIgnoredSuccessBody(c.body, { ...opts, followupOnRisks: false }, c.inlines, BOT)
      );
    });

    test(`handover agrees: ${c.name}`, () => {
      const record = c.record ?? null;
      expect(isMaintainerOnlyTrailer(c.body, record)).toBe(oldIsMaintainerOnlyTrailer(c.body, record));
      const facts = buildReviewFacts({
        body: c.body,
        record,
        prAuthorLogin: c.prAuthor,
        blockingAuthors: c.blockingAuthors,
      });
      expect(handoverWakesFromFacts(facts)).toBe(oldHandoverWakes(c.body, record, c.prAuthor, c.blockingAuthors));
      for (const status of ["posted", "updated", "skipped"] as const) {
        const published: ReviewResult = { status };
        expect(
          shouldHandoverFollowUp({
            published,
            markdown: c.body,
            record,
            prAuthor: c.prAuthor,
            blockingQuestionAuthors: c.blockingAuthors,
          })
        ).toBe(
          (() => {
            if (status !== "posted" && status !== "updated") return false;
            return oldHandoverWakes(c.body, record, c.prAuthor, c.blockingAuthors);
          })()
        );
      }
    });

    test(`view agrees with reviewVerdictView: ${c.name}`, () => {
      const record = c.record ?? null;
      const view = reviewVerdictView({ markdown: c.body, record });
      const facts = buildReviewFacts({
        body: c.body,
        record,
        prAuthorLogin: c.prAuthor,
        blockingAuthors: c.blockingAuthors,
      });
      expect(facts.viewIncomplete).toBe(view.incomplete);
      expect(facts.viewState).toBe(view.state);
      expect(facts.viewDescription).toBe(view.description);
      expect(facts.viewSuggestionCount).toBe(view.suggestionCount);
      expect(facts.viewMaintainerQuestionCount).toBe(view.maintainerQuestionCount);
      expect(facts.viewIsMaintainerOnly).toBe(view.isMaintainerOnly);
      expect(facts.viewBlockingQuestionCount).toBe(view.blockingQuestionCount(c.prAuthor, c.blockingAuthors));
    });

    test(`latch identities and display agree: ${c.name}`, () => {
      expect(blockingFindingIdentities(c.body)).toEqual(oldBlockingFindingIdentities(c.body));
      expect(fingerprintFindingIdentityFromParts(c.body, c.inlines)).toBe(
        (() => {
          const oldIdentities = oldBlockingFindingIdentitiesFromParts(c.body, c.inlines);
          if (oldIdentities.length === 0) return undefined;
          return createHash("sha256").update(oldIdentities.join("\n")).digest("hex");
        })()
      );
      expect(sameFindingDisplayFromParts(c.body, c.inlines)).toBe(oldSameFindingDisplayFromParts(c.body, c.inlines));
    });

    test(`carry lines and blockers agree: ${c.name}`, () => {
      const oldLines = [
        ...reviewFindingLines(c.body),
        ...c.inlines.map((inline) => oldCarryInlineLine(inline, REVIEW_MARKER)).filter((line) => line !== undefined),
      ];
      const facts = buildReviewFacts({ body: c.body, inlines: c.inlines, carryMarker: REVIEW_MARKER });
      expect(facts.bodyLines).toEqual(reviewFindingLines(c.body));
      expect(facts.carryLines).toEqual(oldLines);
      expect(facts.hasOpenBlockers).toBe(oldHasOpenBlockers(oldLines));
    });

    test(`proof flags match hasFindingProof: ${c.name}`, () => {
      const facts = buildReviewFacts({ body: c.body, inlines: c.inlines });
      const located = parseReviewFindings(c.body);
      expect(facts.findings.filter((finding) => finding.placement === "body")).toHaveLength(located.length);
      for (const [index, finding] of located.entries()) {
        expect(facts.findings[index]?.hasProof).toBe(hasFindingProof(finding.body));
        expect(facts.findings[index]?.path).toBe(finding.path);
        expect(facts.findings[index]?.line).toBe(finding.line);
      }
      const inlineFacts = facts.findings.filter((finding) => finding.placement === "inline");
      expect(inlineFacts).toHaveLength(c.inlines.length);
      for (const [index, inline] of c.inlines.entries()) {
        expect(inlineFacts[index]?.hasProof).toBe(hasFindingProof(inline.body ?? ""));
      }
    });
  }

  test("hold resolve agrees per inline", () => {
    const bodies = [
      "❓ maintainer: please file the issue?",
      "💡 suggestion: extract a helper",
      "🔴 bug: null deref",
      "🟡 risk: race in retry",
      "q: should this retry?",
      "plain text without a marker",
    ];
    for (const text of bodies) {
      for (const login of [BOT, "other-bot"]) {
        for (const resolved of [undefined, true, false]) {
          const inline = jumiInline(text, { login, resolved, line: 10 });
          expect(isResolvableHoldInline(inline, BOT)).toBe(oldIsResolvableHoldInline(inline, BOT));
          expect(isBlockingQuestionInline(inline, BOT)).toBe(oldIsBlockingQuestionInline(inline, BOT));
        }
      }
    }
    const pathMarked = jumiInline("detail", { path: "🔴 bug: src/z.ts" });
    expect(isResolvableHoldInline(pathMarked, BOT)).toBe(oldIsResolvableHoldInline(pathMarked, BOT));
  });

  test("maintainer-only pull review agrees", () => {
    const review = (body: string): PullReview => ({ id: 7, body, user: { login: BOT } }) as PullReview;
    const bodies = [
      `src/e.ts:4: ❓ maintainer: File the upstream issue?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
      `src/d.ts:9: ❓ q: Should this retry?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
      `src/c.ts:7: 💡 simpler: Extract a helper.\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
      `src/a.ts:12: 🔴 Null deref.\n\n${REVIEWED}\n${FAIL_TRAILER}`,
    ];
    const maintainerInline = jumiInline("❓ maintainer: File the ticket?", { path: "src/e.ts", line: 5 });
    for (const body of bodies) {
      for (const inlines of [[], [maintainerInline]]) {
        const facts = buildReviewFacts({ body, inlines, botUsername: BOT });
        const expected = oldIsMaintainerOnlyPullReview(review(body), inlines, BOT);
        const actual =
          facts.trailerState === "success" &&
          facts.trailerSuggestionCount === 0 &&
          facts.openQuestions !== 0 &&
          facts.openMaintainers === facts.openQuestions;
        expect(actual).toBe(expected);
      }
    }
  });

  test("a.ts vs - a.ts path forms agree, distinct ordinals agree", () => {
    const plain = `a.ts:12: 🔴 Null deref.\n\n${REVIEWED}\n${FAIL_TRAILER}`;
    const dashed = `- a.ts:12: 🔴 Null deref.\n\n${REVIEWED}\n${FAIL_TRAILER}`;
    expect(blockingFindingIdentities(dashed)).toEqual(blockingFindingIdentities(plain));
    expect(blockingFindingIdentities(dashed)).toEqual(oldBlockingFindingIdentities(plain));
    expect(openBugsForReview(dashed, [], BOT)).toBe(openBugsForReview(plain, [], BOT));
    const ordinals = `src/j.ts:12: 🔴 Null deref on empty input.\n\nsrc/j.ts:17: 🔴 Null deref on empty input.\n\n${REVIEWED}\n${FAIL_TRAILER}`;
    expect(blockingFindingIdentities(ordinals)).toEqual(oldBlockingFindingIdentities(ordinals));
    expect(openBugsForReview(ordinals, [], BOT)).toBe(oldOpenBugsForReview(ordinals, [], BOT));
  });
});

// ---------------------------------------------------------------------------
// Seam shape: the facts value carries the documented review-level and
// per-finding fields a future typed producer must also provide.
// ---------------------------------------------------------------------------

describe("review facts seam shape", () => {
  test("body text produces typed review-level and per-finding facts", () => {
    const facts = buildReviewFacts({ body: BUG_BODY });
    const source: ReviewFactsSource = facts.source;
    expect(source).toBe("text");
    const severities: ReviewFindingSeverity[] = facts.findings.map((finding) => finding.severity);
    expect(severities).toContain("bug");
    const placements: ReviewFindingPlacement[] = facts.findings.map((finding) => finding.placement);
    expect(placements).toContain("body");
    const first: ReviewFindingFact | undefined = facts.findings[0];
    expect(first?.path).toBe("src/a.ts");
    expect(first?.identity).toBe("src/a.ts|11|bug|deref empty input null");
  });

  test("question kinds distinguish maintainer, blocking and plain", () => {
    const maintainer = buildReviewFacts({
      body: `src/e.ts:4: ❓ maintainer: File the ticket?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    });
    const questionKinds: (ReviewQuestionKind | undefined)[] = maintainer.findings.map(
      (finding) => finding.questionKind
    );
    expect(questionKinds).toEqual(["maintainer"]);
    const plain = buildReviewFacts({
      body: `src/d.ts:9: ❓ q: Should this retry?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
    });
    const plainKinds: (ReviewQuestionKind | undefined)[] = plain.findings.map((finding) => finding.questionKind);
    expect(plainKinds).toEqual(["plain"]);
    const blocking = buildReviewFacts({
      body: `src/d.ts:9: ❓ q: Should this retry?\n\n${REVIEWED}\n${SUCCESS_TRAILER}`,
      prAuthorLogin: "alice",
      blockingAuthors: ["alice"],
    });
    const blockingKinds: (ReviewQuestionKind | undefined)[] = blocking.findings.map((finding) => finding.questionKind);
    expect(blockingKinds).toEqual(["blocking"]);
    const inlineInput: ReviewFactsInlineInput = { path: "src/a.ts", new_position: 1, body: "🔴 x" };
    expect(inlineInput.path).toBe("src/a.ts");
  });
});

// ---------------------------------------------------------------------------
// Fake producer: hand-built facts (no body text) drive consumer predicates.
// ---------------------------------------------------------------------------

function fakeFacts(overrides: Partial<ReviewFacts> = {}): ReviewFacts {
  return {
    source: "text",
    incomplete: false,
    state: "success",
    description: "1 suggestion",
    comment: "",
    trailerState: "success",
    trailerReason: "1 suggestion",
    bugCount: 0,
    riskCount: 0,
    suggestionCount: 1,
    questionCount: 0,
    maintainerQuestionCount: 0,
    nonMaintainerQuestionCount: 0,
    trailerSuggestionCount: 1,
    trailerNonBlockingRiskCount: 0,
    viewIncomplete: false,
    viewState: "success",
    viewDescription: "1 suggestion",
    viewSuggestionCount: 1,
    viewMaintainerQuestionCount: 0,
    viewIsMaintainerOnly: false,
    viewBlockingQuestionCount: 0,
    openBugs: 0,
    openRisks: 0,
    openSuggestions: 1,
    openQuestions: 0,
    openMaintainers: 0,
    openMaintainersAnyTrailer: 0,
    openBlockingQuestions: 0,
    inlineBugCount: 0,
    inlineRiskCount: 0,
    inlineQuestionCount: 0,
    inlineMaintainerCount: 0,
    inlineNonMaintainerCount: 0,
    findings: [
      {
        severity: "suggestion",
        questionKind: undefined,
        placement: "body",
        path: "src/a.ts",
        line: 3,
        hasProof: false,
        identity: undefined,
      },
    ],
    findingIdentities: [],
    sameFindingDisplay: undefined,
    bodyLines: ["src/a.ts:3: 💡 simpler: Extract helper."],
    carryLines: ["src/a.ts:3: 💡 simpler: Extract helper."],
    hasOpenBlockers: false,
    ...overrides,
  };
}

describe("review facts fake producer (no body text)", () => {
  test("suggestion-only facts wake unless suggestions are off", () => {
    const facts = fakeFacts();
    expect(isIgnoredSuccessFromFacts(facts, {})).toBe(false);
    expect(isIgnoredSuccessFromFacts(facts, { followupOnSuggestions: false })).toBe(true);
    expect(handoverWakesFromFacts(facts)).toBe(true);
  });

  test("maintainer-only facts never wake a worker", () => {
    const facts = fakeFacts({
      suggestionCount: 0,
      trailerSuggestionCount: 0,
      questionCount: 1,
      maintainerQuestionCount: 1,
      viewSuggestionCount: 0,
      viewIsMaintainerOnly: true,
      openQuestions: 1,
      openMaintainers: 1,
      openMaintainersAnyTrailer: 1,
      openSuggestions: 0,
      findings: [
        {
          severity: "question",
          questionKind: "maintainer",
          placement: "inline",
          path: "src/a.ts",
          line: 3,
          hasProof: false,
          identity: undefined,
        },
      ],
    });
    expect(isIgnoredSuccessFromFacts(facts, {})).toBe(false);
    expect(handoverWakesFromFacts(facts)).toBe(false);
  });

  test("blocking facts wake and never count as ignored", () => {
    const facts = fakeFacts({
      state: "failure",
      description: "1 blocking",
      trailerState: "failure",
      trailerReason: "1 blocking",
      bugCount: 1,
      suggestionCount: 0,
      trailerSuggestionCount: 0,
      viewIncomplete: false,
      viewState: "failure",
      viewDescription: "1 blocking",
      viewSuggestionCount: 0,
      openBugs: 1,
      openSuggestions: 0,
    });
    expect(isIgnoredSuccessFromFacts(facts, {})).toBe(false);
    expect(handoverWakesFromFacts(facts)).toBe(true);
  });

  test("blocking questions wake through the trailer decision", () => {
    const facts = fakeFacts({
      questionCount: 1,
      nonMaintainerQuestionCount: 1,
      openQuestions: 1,
      openBlockingQuestions: 1,
      viewBlockingQuestionCount: 1,
    });
    expect(isIgnoredSuccessFromFacts(facts, {})).toBe(false);
    expect(handoverWakesFromFacts(facts)).toBe(true);
  });

  test("plain success facts stay quiet", () => {
    const facts = fakeFacts({
      description: "No blocking issues",
      trailerReason: "",
      suggestionCount: 0,
      trailerSuggestionCount: 0,
      viewDescription: "No blocking issues",
      viewSuggestionCount: 0,
      openSuggestions: 0,
      findings: [],
      bodyLines: [],
      carryLines: [],
    });
    expect(isIgnoredSuccessFromFacts(facts, {})).toBe(false);
    expect(handoverWakesFromFacts(facts)).toBe(false);
  });
});
