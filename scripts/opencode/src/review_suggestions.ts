import { isSuggestionFindingFirstLine, parseReviewFindings, type ReviewFinding } from "./verdict.ts";

/**
 * Approximate matching for 💡 suggestions across two reviews of the same PR.
 *
 * A previous 💡 counts as still present when the later review holds a 💡 on
 * the same file with similar text. "Similar" is intentionally cheap and
 * documented here (no PR number or repo in any metric label):
 *
 * - paths must match exactly (after the publisher's `./` and backslash
 *   normalization, so `src/foo.ts` never matches `src/bar.ts`);
 * - bodies are normalized (lowercased, severity words and emoji stripped,
 *   punctuation folded to spaces, whitespace collapsed);
 * - a pair matches when the normalized bodies are equal, when one contains
 *   the other, or when their word Jaccard similarity is >= 0.5.
 *
 * This tolerates rewording and line shifts without pulling in an NLP
 * dependency. Anything still unmatched counts as addressed (fixed or dropped).
 */

function normalizeSuggestionBody(body: string): string {
  return body
    .replace(/<!--\s*jumi-review:[^>]*-->/g, " ")
    .replace(/^[🔴🟡💡❓\s]+/u, " ")
    .replace(/^(?:\*\*|__)?\s*(?:bug|risk|simpler|suggestions?|questions?|q)\s*:\s*/i, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function suggestionWords(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((word) => word.length > 0));
}

/** Same file and similar text per the rule documented above. */
export function isSameSuggestion(
  prev: Pick<ReviewFinding, "path" | "body">,
  curr: Pick<ReviewFinding, "path" | "body">
): boolean {
  if (prev.path !== curr.path) return false;
  const a = normalizeSuggestionBody(prev.body);
  const b = normalizeSuggestionBody(curr.body);
  if (!a || !b) return a === b;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aWords = suggestionWords(a);
  const bWords = suggestionWords(b);
  let intersection = 0;
  for (const word of aWords) {
    if (bWords.has(word)) intersection++;
  }
  const union = aWords.size + bWords.size - intersection;
  if (union === 0) return true;
  return intersection / union >= 0.5;
}

/** True when a parsed finding body carries the 💡 suggestion marker. */
export function isSuggestionBody(body: string): boolean {
  if (isSuggestionFindingFirstLine(body)) return true;
  // `finding.body` keeps a leading emphasis/backtick run verbatim (e.g.
  // `**💡 simpler:`), which the cap regex already anticipates. Strip it here
  // too so both detectors agree.
  const text = body.trim().replace(/^[`*_]+/, "");
  if (/^💡/u.test(text)) return true;
  return /^(?:simpler|suggestions?)\s*:/i.test(text);
}

/** Keep only the 💡 suggestions from parsed findings. */
export function filterSuggestionFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.filter((finding) => isSuggestionBody(finding.body));
}

/**
 * How many earlier 💡 findings are not repeated in the later review: every
 * `prev` suggestion with no `isSameSuggestion` partner in `curr` counts once.
 * Both lists must already be filtered to suggestions.
 */
export function countAddressedSuggestions(
  prev: readonly Pick<ReviewFinding, "path" | "body">[],
  curr: readonly Pick<ReviewFinding, "path" | "body">[]
): number {
  let addressed = 0;
  for (const before of prev) {
    if (!curr.some((after) => isSameSuggestion(before, after))) addressed++;
  }
  return addressed;
}

/** Parse a review body (or joined finding lines) down to its 💡 suggestions. */
export function parseSuggestionFindings(text: string, opts?: { singleFilePath?: string }): ReviewFinding[] {
  return filterSuggestionFindings(parseReviewFindings(text, opts));
}

/** Bounded `runner` label for metrics: opencode/claude/agy/codex, else unknown. */
export function runnerLabelForStamp(stamp?: string | null): string {
  if (!stamp) return "unknown";
  const parts = stamp.split("·").map((part) => part.trim().toLowerCase());
  const type = parts[1]?.replace(/^_+|_+$/g, "").trim();
  if (type === "opencode" || type === "claude" || type === "agy" || type === "codex") return type;
  return "unknown";
}

/** Bounded `forge` label for metrics: github or gitea (default). */
export function forgeLabelForKind(kind?: string | null): string {
  return (kind ?? "").trim().toLowerCase() === "github" ? "github" : "gitea";
}

export interface ReviewSuggestionCounts {
  runner: string;
  forge: string;
  posted: number;
  dropped: number;
  addressed: number;
}

export interface ReviewSuggestionTotalsRow extends ReviewSuggestionCounts {
  reviews: number;
}
