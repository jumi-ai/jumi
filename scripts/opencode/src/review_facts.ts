/**
 * Review facts: the single legacy text classifier for published reviews.
 *
 * Every consumer of a published Jumi review (hold/wake gates, handover,
 * carry, same-finding latch inputs) used to derive its own answers by running
 * text parsers over the review body, the check trailer and the Jumi inline
 * comments. This module is now the only place that calls the legacy text
 * parsers in `verdict.ts` (plus the record bridge `reviewVerdictView`) to
 * build one explicit value per published review artifact. Consumers import
 * this module and read the facts; they never import `verdict.ts` themselves.
 *
 * This is a pure refactor seam: `source` is always `"text"` for now. A later
 * slice adds a second producer (typed facts from a verified signed block)
 * and chooses between producers; every consumer predicate below already runs
 * on the facts value alone so the switch only changes the producer.
 *
 * Inline folding (this module's `inlines` input):
 * - Counts (`openBugs`, `openRisks`, `openQuestions`, `openMaintainers`,
 *   `openMaintainersAnyTrailer`, `openBlockingQuestions`) fold only open
 *   Jumi-owned inlines (review marker, bot login, unresolved), exactly like
 *   the `followup.ts` helpers and the `hold_settlement.ts` locals did. Those
 *   two foldings were compared statement for statement and are identical, so
 *   they share this one path with no behavior delta.
 * - Latch inputs (`findingIdentities`, `sameFindingDisplay`) fold every
 *   passed inline without an ownership gate, exactly like
 *   `blockingFindingIdentitiesFromParts` / `sameFindingDisplayFromParts` did.
 *   Callers pass pre-filtered inlines (for example `unresolvedJumiInlines`).
 * - Carry/delta line folding (`carryInlineLine`) takes caller-filtered
 *   inlines plus the review marker and reproduces the `path:line: text`
 *   construction. The bot-login matching deliberately stays with the callers:
 *   carry compares bot slugs while delta uses exact login equality, and that
 *   difference is preserved rather than unified.
 */
import type { ReviewRecord } from "./review_verdict_store.ts";
import { loginEquals } from "./util/login.ts";
import {
  countBugFindings,
  countMaintainerQuestionFindings,
  countNonMaintainerQuestionFindings,
  countQuestionFindings,
  countRiskFindings,
  countSuggestionFindings,
  hasFindingProof,
  isBlockingQuestionAuthor,
  isBugFindingFirstLine,
  isMaintainerQuestionFirstLine,
  isMaintainerQuestionInline,
  isNonMaintainerQuestionInline,
  isQuestionFindingFirstLine,
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
} from "./verdict.ts";

/** Formatting passthrough for consumer descriptions (not a text parser). */
export { describeSuggestionsReason } from "./verdict.ts";

/** Provenance discriminator. Only `"text"` exists until the typed-block slice lands. */
export type ReviewFactsSource = "text";

export type ReviewFindingSeverity = "bug" | "risk" | "suggestion" | "question" | "other";

/**
 * Question subtype. `maintainer` carries the `❓ maintainer:` marker.
 * `blocking` is an ordinary question on a review where it would block
 * (complete success trailer plus an allowlisted PR author). `plain` is an
 * ordinary question anywhere else.
 */
export type ReviewQuestionKind = "maintainer" | "blocking" | "plain";

export type ReviewFindingPlacement = "body" | "inline";

/** One classified finding: a located body finding or one folded inline. */
export interface ReviewFindingFact {
  severity: ReviewFindingSeverity;
  questionKind: ReviewQuestionKind | undefined;
  placement: ReviewFindingPlacement;
  /** Empty when the finding carries no location. */
  path: string;
  /** 0 when the finding carries no usable line number. */
  line: number;
  hasProof: boolean;
  /** Same-finding latch identity; only set for blocking findings with a summary. */
  identity: string | undefined;
}

/**
 * One published review artifact as explicit facts. Raw body counts come from
 * the parsed comment exactly like the legacy counters; `view*` fields come
 * from the record-aware `reviewVerdictView` exactly like the row consumers;
 * `open*` totals add the open Jumi-owned inline fold exactly like the
 * hold/wake gates.
 */
export interface ReviewFacts {
  source: ReviewFactsSource;
  /** Raw text verdict: incomplete when no check verdict parsed. */
  incomplete: boolean;
  state: "success" | "failure";
  description: string;
  /** Parsed body without the check trailer. */
  comment: string;
  /** Last-non-empty-line trailer, mirroring `followup.lastCheckTrailer`. */
  trailerState: "success" | "failure" | undefined;
  trailerReason: string;
  /** Raw body counts on the parsed comment (no record, no inlines). */
  bugCount: number;
  riskCount: number;
  suggestionCount: number;
  questionCount: number;
  maintainerQuestionCount: number;
  nonMaintainerQuestionCount: number;
  trailerSuggestionCount: number;
  trailerNonBlockingRiskCount: number;
  /** Record-aware verdict view (authoritative suggestion count when recorded). */
  viewIncomplete: boolean;
  viewState: "success" | "failure";
  viewDescription: string;
  viewSuggestionCount: number;
  viewMaintainerQuestionCount: number;
  viewIsMaintainerOnly: boolean;
  viewBlockingQuestionCount: number;
  /** Body plus open Jumi-owned inline fold (see module doc for gates). */
  openBugs: number;
  openRisks: number;
  openSuggestions: number;
  openQuestions: number;
  openMaintainers: number;
  openMaintainersAnyTrailer: number;
  openBlockingQuestions: number;
  /** Inline-only raw counts (open Jumi-owned inlines). */
  inlineBugCount: number;
  inlineRiskCount: number;
  inlineQuestionCount: number;
  inlineMaintainerCount: number;
  inlineNonMaintainerCount: number;
  /** Located body findings plus one entry per passed inline. */
  findings: ReviewFindingFact[];
  /** Sorted, deduped blocking identities for the same-finding latch. */
  findingIdentities: string[];
  /** Human display for the latch/board. */
  sameFindingDisplay: string | undefined;
  /** Body finding lines in publish order (carry/delta input). */
  bodyLines: string[];
  /** Body lines plus folded inline lines (undeduplicated; callers dedupe). */
  carryLines: string[];
  /** Whether any carry line still opens a 🔴, 🟡 or ❓. */
  hasOpenBlockers: boolean;
}

/** Minimal inline shape: forge `InlineComment` values satisfy this. */
export interface ReviewFactsInlineInput {
  path?: string | null | undefined;
  new_position?: number | null | undefined;
  body?: string | null | undefined;
  user?: { login?: string | null | undefined } | null | undefined;
  resolved?: boolean | null | undefined;
  resolver?: { login?: string | null | undefined } | null | undefined;
}

export interface ReviewFactsInput {
  body: string | null | undefined;
  record?: ReviewRecord | null;
  inlines?: readonly ReviewFactsInlineInput[] | null | undefined;
  botUsername?: string;
  prAuthorLogin?: string | null | undefined;
  blockingAuthors?: readonly string[] | null | undefined;
  singleFilePath?: string;
  /** When set, `carryLines` also folds one line per passed inline. */
  carryMarker?: string | null | undefined;
}

export interface ParsedCheckTrailer {
  state: "success" | "failure";
  reason: string;
}

/**
 * Last-non-empty-line check trailer, mirroring `followup.lastCheckTrailer`
 * (and the identical `hold_settlement` local): scan from the end, skip blank
 * lines, parse the first non-empty line as a check comment.
 */
export function parseLastCheckTrailer(body: string | null | undefined): ParsedCheckTrailer | undefined {
  for (const line of (body ?? "").split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return parseCheckLine(trimmed);
  }
  return undefined;
}

const REVIEW_MARKER = "<!-- jumi-review:";

function isUnresolvedInline(inline: ReviewFactsInlineInput): boolean {
  return inline.resolved !== true && inline.resolver == null;
}

/**
 * Whether an inline takes part in the count fold: Jumi-owned (review marker
 * plus bot author) and unresolved. The marker/type gate from the legacy
 * `followup`/`hold_settlement` open-inline checks, verbatim.
 */
function isOpenJumiInline(inline: ReviewFactsInlineInput, botUsername?: string): boolean {
  const body = inline.body ?? "";
  if (!body.includes(REVIEW_MARKER)) return false;
  if (typeof botUsername === "string" && botUsername) {
    if (!loginEquals(inline.user?.login ?? undefined, botUsername)) return false;
  }
  if (!isUnresolvedInline(inline)) return false;
  return true;
}

export interface InlineFindingClass {
  bugLike: boolean;
  riskLike: boolean;
  suggestionLike: boolean;
  maintainerQuestion: boolean;
  ordinaryQuestion: boolean;
  anyQuestion: boolean;
}

/**
 * Single-inline text classification: the shared core behind the legacy
 * `followup` bug/risk/maintainer inline checks, the `hold_settlement` locals
 * and the `hold_resolve` bug-like/risk-like/suggestion-like checks. The
 * ownership gate stays with the caller; this only classifies the text.
 */
export function classifyInlineText(
  path: string | null | undefined,
  body: string | null | undefined
): InlineFindingClass {
  const name = typeof path === "string" ? path : "";
  const text = typeof body === "string" ? body : "";
  const bugLike =
    (name.trim() !== "" && isBugFindingFirstLine(name)) || (text.trim() !== "" && countBugFindings(text) > 0);
  const riskLike =
    (name.trim() !== "" && isRiskFindingFirstLine(name)) || (text.trim() !== "" && countRiskFindings(text) > 0);
  const suggestionLike =
    (name.trim() !== "" && isSuggestionFindingFirstLine(name)) ||
    (text.trim() !== "" && countSuggestionFindings(text) > 0);
  const maintainerQuestion = isMaintainerQuestionInline(name, text);
  const ordinaryQuestion = isNonMaintainerQuestionInline(name, text);
  const anyQuestion = isQuestionInline(name, text);
  return { bugLike, riskLike, suggestionLike, maintainerQuestion, ordinaryQuestion, anyQuestion };
}

/** Carry/delta inline line: `path:line: text` or `path: text`, marker stripped. */
function carryInlineLine(
  inline: Pick<ReviewFactsInlineInput, "path" | "new_position" | "body">,
  marker: string
): string | undefined {
  const body = inline.body ?? "";
  if (!inline.path || !body.includes(marker)) return undefined;
  const text = body.split(marker).join("").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return inline.new_position ? `${inline.path}:${inline.new_position}: ${text}` : `${inline.path}: ${text}`;
}

function severityOfBodyFindingText(body: string): ReviewFindingSeverity {
  if (isBugFindingFirstLine(body)) return "bug";
  if (isRiskFindingFirstLine(body)) return "risk";
  if (isSuggestionFindingFirstLine(body)) return "suggestion";
  if (isQuestionFindingFirstLine(body)) return "question";
  return "other";
}

// The latch identity helpers below moved verbatim from `stuck.ts`: bucketing,
// severity, summary signature and display. Only the callers changed (this
// builder instead of the stuck latch functions).

function bucketFindingLine(line: number): number {
  if (!Number.isSafeInteger(line) || line < 1) return 0;
  return Math.floor((line - 1) / 5) * 5 + 1;
}

function severityForIdentity(body: string): "bug" | "risk" | undefined {
  const text = body.trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
  const emoji = /^(🔴|🟡)/u.exec(text);
  if (emoji) return emoji[1] === "🔴" ? "bug" : "risk";
  const word = /^(bug|risk)\s*:/i.exec(text);
  if (word) return word[1].toLowerCase() === "bug" ? "bug" : "risk";
  return undefined;
}

function stripSeverityPrefix(body: string): string {
  return body
    .trim()
    .replace(/^(?:[-*]|\d+\.)\s+/, "")
    .replace(/^(?:🔴|🟡)\s*/u, "")
    .replace(/^(?:bug|risk)\s*:\s*/i, "");
}

const PER_ROUND_SENTENCE_RE =
  /(re-?check|this head|head sha|merge (of|from)|base branch|on this round|per-?round note|reviewed commit)/i;

const SUMMARY_STOPWORDS = new Set([
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

function firstContentSentence(paragraph: string): string {
  const sentences = paragraph.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) ?? [paragraph];
  const cleaned = sentences.map((sentence) => sentence.trim()).filter(Boolean);
  for (const sentence of cleaned) {
    if (!PER_ROUND_SENTENCE_RE.test(sentence)) return sentence;
  }
  return cleaned[0] ?? "";
}

function findingSummarySignature(body: string): string {
  let text = stripSeverityPrefix(body);
  text = text.replace(/<!--\s*jumi-(?:review|check|stuck|worker)[\s\S]*?-->/gi, " ");
  text = text.replace(/\b[0-9a-f]{7,40}\b/gi, " ");
  text = text.replace(/[`*_>#]+/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const firstParagraph = text.split(/\n\s*\n/)[0] ?? "";
  const sentence = firstContentSentence(firstParagraph.trim());
  const words = sentence
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !SUMMARY_STOPWORDS.has(word));
  if (words.length === 0) return "";
  words.sort();
  return words.join(" ");
}

function firstSentenceForDisplay(body: string): string {
  const text = stripSeverityPrefix(body).replace(/\s+/g, " ").trim();
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text);
  const sentence = (match?.[1] ?? text).trim();
  return sentence.length > 140 ? `${sentence.slice(0, 140).trimEnd()}…` : sentence;
}

function identityForBodyFinding(path: string, line: number, body: string): string | undefined {
  const severity = severityForIdentity(body);
  if (!severity) return undefined;
  const summary = findingSummarySignature(body);
  if (!summary) return undefined;
  return `${path}|${bucketFindingLine(line)}|${severity}|${summary}`;
}

function identityForInline(
  path: string | null | undefined,
  line: number | null | undefined,
  body: string | null | undefined
): string | undefined {
  const name = (path ?? "").trim();
  if (!name) return undefined;
  const severity = severityForIdentity(body ?? "");
  if (!severity) return undefined;
  const summary = findingSummarySignature(body ?? "");
  if (!summary) return undefined;
  const lineNum = typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : 0;
  return `${name}|${bucketFindingLine(lineNum)}|${severity}|${summary}`;
}

function displayForInline(
  path: string | null | undefined,
  line: number | null | undefined,
  body: string | null | undefined
): string | undefined {
  if (!path?.trim()) return undefined;
  const severity = severityForIdentity(body ?? "");
  if (!severity) return undefined;
  const emoji = severity === "bug" ? "🔴" : "🟡";
  const summary = firstSentenceForDisplay(body ?? "");
  if (!summary) return undefined;
  const lineNum = typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : 0;
  const display =
    lineNum > 0 ? `${path.trim()}:${lineNum} ${emoji} ${summary}`.trim() : `${path.trim()} ${emoji} ${summary}`.trim();
  return display.length > 200 ? `${display.slice(0, 200).trimEnd()}…` : display;
}

/**
 * Build the facts for one published review artifact. The only place outside
 * `verdict.ts` that calls the legacy text parsers; every consumer below reads
 * the returned value instead of parsing text itself.
 */
export function buildReviewFacts(input: ReviewFactsInput): ReviewFacts {
  const body = input.body ?? "";
  const parsed = parseReviewOutput(body);
  const comment = parsed.comment;
  const trailer = parseLastCheckTrailer(body);
  const trailerState = trailer?.state;
  const trailerReason = trailer?.reason ?? "";
  const incomplete = parsed.verdict.incomplete;
  const state = parsed.verdict.state;
  const description = parsed.verdict.description;
  const completeSuccess = !incomplete && state === "success";

  const scope = input.singleFilePath ? { singleFilePath: input.singleFilePath } : undefined;
  const bugCount = countBugFindings(comment, scope);
  const riskCount = countRiskFindings(comment, scope);
  const suggestionCount = countSuggestionFindings(comment, scope);
  const questionCount = countQuestionFindings(comment, scope);
  const maintainerQuestionCount = countMaintainerQuestionFindings(comment, scope);
  const nonMaintainerQuestionCount = countNonMaintainerQuestionFindings(comment, scope);

  // Trailer prose never feeds suggestion/risk counts (see `reviewVerdictView`):
  // the model-written reason is consulted only through these fixed patterns,
  // exactly like the wake/handover gates did. A default verdict description
  // ("No blocking issues", "Review requested changes") matches neither
  // pattern, so reading `description` here agrees with the old trailer-reason
  // reads site by site.
  const trailerSuggestionCountValue = trailerSuggestionCount(description);
  const trailerNonBlockingRiskCountValue = trailerNonBlockingRiskCount(description);

  // Record-aware row view, exactly as the handover gates read it.
  const view = reviewVerdictView({ markdown: input.body, record: input.record });
  const viewBlockingQuestionCount = view.blockingQuestionCount(input.prAuthorLogin, input.blockingAuthors, scope);

  // Ordinary questions block only on a complete success review whose author
  // is allowlisted; maintainer questions never block.
  const blockingGate = isBlockingQuestionAuthor(input.prAuthorLogin, input.blockingAuthors) && completeSuccess;

  let inlineBugCount = 0;
  let inlineRiskCount = 0;
  let inlineQuestionCount = 0;
  let inlineMaintainerCount = 0;
  let inlineNonMaintainerCount = 0;
  for (const inline of input.inlines ?? []) {
    if (!inline) continue;
    if (!isOpenJumiInline(inline, input.botUsername)) continue;
    const cls = classifyInlineText(inline.path, inline.body);
    if (cls.bugLike) inlineBugCount++;
    if (cls.riskLike) inlineRiskCount++;
    if (cls.anyQuestion) inlineQuestionCount++;
    if (cls.maintainerQuestion) inlineMaintainerCount++;
    if (cls.ordinaryQuestion) inlineNonMaintainerCount++;
  }

  const openBugs = bugCount + inlineBugCount;
  const openRisks = riskCount + inlineRiskCount;
  // Suggestions never folded inlines: the hold release reads the body count.
  const openSuggestions = suggestionCount;
  // Question totals read zero without a complete success trailer, mirroring
  // the hold/wake gates (an empty body reads zero even with open inlines).
  const openQuestions = completeSuccess ? questionCount + inlineQuestionCount : 0;
  const openMaintainers = completeSuccess ? maintainerQuestionCount + inlineMaintainerCount : 0;
  const openMaintainersAnyTrailer = incomplete ? 0 : maintainerQuestionCount + inlineMaintainerCount;
  const openBlockingQuestions = blockingGate ? nonMaintainerQuestionCount + inlineNonMaintainerCount : 0;

  // Per-finding facts: located body findings (the same `parseReviewFindings`
  // input the latch identities use) plus one entry per passed inline.
  // Unlocated severity-marker lines count in the body counters above but stay
  // out of here, exactly like they stay out of the latch identities.
  const findings: ReviewFindingFact[] = [];
  for (const finding of parseReviewFindings(body)) {
    const severity = severityOfBodyFindingText(finding.body);
    const questionKind =
      severity === "question"
        ? isMaintainerQuestionFirstLine(finding.body)
          ? ("maintainer" as const)
          : blockingGate
            ? ("blocking" as const)
            : ("plain" as const)
        : undefined;
    findings.push({
      severity,
      questionKind,
      placement: "body",
      path: finding.path,
      line: finding.line,
      hasProof: hasFindingProof(finding.body),
      identity: identityForBodyFinding(finding.path, finding.line, finding.body),
    });
  }
  for (const inline of input.inlines ?? []) {
    if (!inline) continue;
    const cls = classifyInlineText(inline.path, inline.body);
    const severity: ReviewFindingSeverity = cls.bugLike
      ? "bug"
      : cls.riskLike
        ? "risk"
        : cls.maintainerQuestion || cls.ordinaryQuestion
          ? "question"
          : cls.suggestionLike
            ? "suggestion"
            : "other";
    const questionKind =
      severity === "question"
        ? cls.maintainerQuestion
          ? ("maintainer" as const)
          : blockingGate
            ? ("blocking" as const)
            : ("plain" as const)
        : undefined;
    const line =
      typeof inline.new_position === "number" && Number.isSafeInteger(inline.new_position) && inline.new_position > 0
        ? inline.new_position
        : 0;
    findings.push({
      severity,
      questionKind,
      placement: "inline",
      path: (inline.path ?? "").trim(),
      line,
      hasProof: hasFindingProof(inline.body ?? ""),
      identity: identityForInline(inline.path, inline.new_position, inline.body),
    });
  }

  // Latch identities: body plus every passed inline, ungated, sorted and
  // deduped exactly like `blockingFindingIdentitiesFromParts`.
  const identitySet = new Set<string>();
  for (const finding of findings) {
    if (finding.identity) identitySet.add(finding.identity);
  }
  const findingIdentities = [...identitySet].sort();

  // Latch/board display: first blocking body finding wins, else the first
  // blocking inline, exactly like `sameFindingDisplayFromParts`.
  let sameFindingDisplay: string | undefined;
  for (const finding of parseReviewFindings(body)) {
    const severity = severityForIdentity(finding.body);
    if (!severity) continue;
    const emoji = severity === "bug" ? "🔴" : "🟡";
    const summary = firstSentenceForDisplay(finding.body);
    if (!summary) continue;
    const display = `${finding.path}:${finding.line} ${emoji} ${summary}`.trim();
    sameFindingDisplay = display.length > 200 ? `${display.slice(0, 200).trimEnd()}…` : display;
    break;
  }
  if (!sameFindingDisplay) {
    for (const inline of input.inlines ?? []) {
      if (!inline) continue;
      const display = displayForInline(inline.path, inline.new_position, inline.body);
      if (display) {
        sameFindingDisplay = display;
        break;
      }
    }
  }

  // Carry/delta line forms: body finding lines plus one folded line per
  // passed inline when the caller supplies the review marker.
  const bodyLines = reviewFindingLines(body);
  const carryLines = [...bodyLines];
  if (input.carryMarker) {
    for (const inline of input.inlines ?? []) {
      if (!inline) continue;
      const line = carryInlineLine(inline, input.carryMarker);
      if (line) carryLines.push(line);
    }
  }
  const hasOpenBlockers = carryLines.some((line) => /🔴|🟡|❓/.test(line));

  return {
    source: "text",
    incomplete,
    state,
    description,
    comment,
    trailerState,
    trailerReason,
    bugCount,
    riskCount,
    suggestionCount,
    questionCount,
    maintainerQuestionCount,
    nonMaintainerQuestionCount,
    trailerSuggestionCount: trailerSuggestionCountValue,
    trailerNonBlockingRiskCount: trailerNonBlockingRiskCountValue,
    viewIncomplete: view.incomplete,
    viewState: view.state,
    viewDescription: view.description,
    viewSuggestionCount: view.suggestionCount,
    viewMaintainerQuestionCount: view.maintainerQuestionCount,
    viewIsMaintainerOnly: view.isMaintainerOnly,
    viewBlockingQuestionCount,
    openBugs,
    openRisks,
    openSuggestions,
    openQuestions,
    openMaintainers,
    openMaintainersAnyTrailer,
    openBlockingQuestions,
    inlineBugCount,
    inlineRiskCount,
    inlineQuestionCount,
    inlineMaintainerCount,
    inlineNonMaintainerCount,
    findings,
    findingIdentities,
    sameFindingDisplay,
    bodyLines,
    carryLines,
    hasOpenBlockers,
  };
}

export interface IgnoredSuccessOpts {
  followupOnSuggestions?: boolean;
  followupOnRisks?: boolean;
}

/**
 * Whether a `success` review should not wake a follow-up worker: no open
 * blocking questions, and every wake category it carries is switched off.
 * Pure over the facts plus the repository switches.
 */
export function isIgnoredSuccessFromFacts(facts: ReviewFacts, opts: IgnoredSuccessOpts = {}): boolean {
  if (facts.trailerState !== "success") return false;
  if (facts.openBlockingQuestions > 0) return false;
  const hasSuggestions = facts.trailerSuggestionCount > 0;
  const hasRisks = facts.trailerNonBlockingRiskCount > 0;
  if (!hasSuggestions && !hasRisks) return false;
  if (hasSuggestions && opts.followupOnSuggestions !== false) return false;
  if (hasRisks && opts.followupOnRisks !== false) return false;
  return true;
}

/**
 * Handover trailer decision over the facts: a failure, leftover
 * simplifications, blocking questions, or non-blocking risks still hand over.
 * The posted/updated and maintainer-only gates stay with the caller.
 */
export function handoverWakesFromFacts(facts: ReviewFacts): boolean {
  if (!facts.viewIncomplete && facts.viewState === "failure") return true;
  if (!facts.viewIncomplete && facts.viewState === "success" && facts.viewSuggestionCount > 0) return true;
  if (facts.viewBlockingQuestionCount > 0) return true;
  if (!facts.incomplete && facts.trailerNonBlockingRiskCount > 0) return true;
  return false;
}
