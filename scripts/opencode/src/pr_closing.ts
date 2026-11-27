import { createHash } from "node:crypto";
import { closesIssuePattern, isVisibleClosingMatch, refsIssuePattern, visibleClosingText } from "./gitea_issues.ts";

/** Kind of a structured remaining item. */
export type RemainingKind = "work" | "ci_check" | "post_merge_check";

/** Worker-supplied remaining item: plain text or typed text. */
export type RemainingItem = string | { text: string; kind: RemainingKind };

/** Heading for post-merge items. Must not contain `Remaining:` (the eval parser reads that heading). */
export const POST_MERGE_HEADING = "Post-merge checks:";

/**
 * Remaining items that only name checks the forge CI runs on the PR never
 * count as leftover work, even when the worker could not run them locally.
 * Dropped items never keep a PR non-closing on their own.
 */
export function isCiOnlyRemainingItem(item: string): boolean {
  const lower = item.toLowerCase();
  if (lower.includes("bun run ci") || lower.includes("test:pg") || lower.includes("gitea actions")) return true;
  if (lower.includes("ci green") || (lower.includes("ci") && lower.includes("green"))) return true;
  if (lower.trim() === "ci" || (lower.includes("full") && lower.includes("ci"))) return true;
  if (lower.includes("forge") && lower.includes("ci")) return true;
  if ((lower.includes("bun run") || lower.includes("bun test")) && (lower.includes("postgres") || /\bpg\b/.test(lower)))
    return true;
  // A postgres/pg mention is CI-only only when it names running the check on the forge,
  // not code to write ("add postgres regression test for queue").
  if (lower.includes("postgres") || /\bpg\b/.test(lower)) {
    if (lower.includes("forge") && (lower.includes("pass") || lower.includes("green") || lower.includes("run")))
      return true;
    return (
      lower.includes("ci") &&
      (lower.includes("pass") || lower.includes("green") || lower.includes("run") || lower.includes("forge"))
    );
  }
  return false;
}

function isRemainingKind(value: unknown): value is RemainingKind {
  return value === "work" || value === "ci_check" || value === "post_merge_check";
}

/**
 * Shared validator for the worker `remaining` list. Plain strings keep
 * today's behaviour; typed items carry a `kind`. The same length/size limits
 * apply to `text`. An unknown `kind` is a call-time error; a typed item with
 * blank `text` is dropped like a blank string.
 */
export function validateRemainingItems(
  input: unknown,
  opts?: { maxItems?: number; maxItemChars?: number }
): { ok: true; remaining: RemainingItem[] | undefined } | { ok: false; error: string } {
  const maxItems = opts?.maxItems ?? 20;
  const maxItemChars = opts?.maxItemChars ?? 1000;
  if (input === undefined || input === null) return { ok: true, remaining: undefined };
  if (!Array.isArray(input)) return { ok: false, error: "remaining must be an array of strings" };
  if (input.length > maxItems) {
    return { ok: false, error: `remaining is too long (max ${maxItems} items)` };
  }
  const items: RemainingItem[] = [];
  for (const entry of input) {
    if (typeof entry === "string") {
      const trimmed = entry.replaceAll("\0", "").trim();
      if (!trimmed) continue;
      if (trimmed.length > maxItemChars) {
        return { ok: false, error: `remaining item is too long (max ${maxItemChars} chars)` };
      }
      items.push(trimmed);
      continue;
    }
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const rec = entry as { text?: unknown; kind?: unknown };
      if (typeof rec.text !== "string" || !isRemainingKind(rec.kind)) {
        return { ok: false, error: "remaining must be an array of strings" };
      }
      const trimmed = rec.text.replaceAll("\0", "").trim();
      if (!trimmed) continue;
      if (trimmed.length > maxItemChars) {
        return { ok: false, error: `remaining item is too long (max ${maxItemChars} chars)` };
      }
      items.push({ text: trimmed, kind: rec.kind });
      continue;
    }
    return { ok: false, error: "remaining must be an array of strings" };
  }
  return { ok: true, remaining: items };
}

/** Remaining strings minus CI-only checks. */
export function filterCiOnlyRemainingStrings(items: readonly string[]): string[] {
  if (items == null) return [];
  const out: string[] = [];
  for (const entry of items) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.replaceAll("\0", "").trim();
    if (trimmed) out.push(trimmed);
  }
  return out.filter((item) => !isCiOnlyRemainingItem(item));
}

export interface ClassifiedRemaining {
  work: string[];
  postMerge: string[];
}

/**
 * Split a mixed remaining list. Typed items are never run through
 * `isCiOnlyRemainingItem`; untyped strings always are. `ci_check` items are
 * dropped (never rendered).
 */
export function classifyRemainingItems(input: readonly RemainingItem[] | null | undefined): ClassifiedRemaining {
  const work: string[] = [];
  const postMerge: string[] = [];
  if (input == null) return { work, postMerge };
  for (const entry of input) {
    if (typeof entry === "string") {
      const trimmed = entry.replaceAll("\0", "").trim();
      if (!trimmed) continue;
      if (isCiOnlyRemainingItem(trimmed)) continue;
      work.push(trimmed);
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const rec = entry as { text?: unknown; kind?: unknown };
      if (typeof rec.text !== "string") continue;
      const trimmed = rec.text.replaceAll("\0", "").trim();
      if (!trimmed) continue;
      if (rec.kind === "work") work.push(trimmed);
      else if (rec.kind === "post_merge_check") postMerge.push(trimmed);
      else if (rec.kind !== "ci_check") work.push(trimmed);
    }
  }
  return { work, postMerge };
}

/** Closing decision from the rule table (non-`refs` policy). `refs` policy always selects `refs`. */
export function decidePrClosing(
  remaining: readonly RemainingItem[] | null | undefined,
  closingKeyword?: string
): "fixes" | "refs" {
  if (closingKeyword === "refs") return "refs";
  const classified = classifyRemainingItems(remaining ?? []);
  return classified.work.length > 0 || classified.postMerge.length > 0 ? "refs" : "fixes";
}

export function rewriteClosingToRefs(text: string, issueNumber: number): string {
  // Replace closing-keyword references to the worked issue with a
  // non-closing `Refs #N` reference. Other issues keep their keywords.
  // Only visible references count: code spans, fenced blocks, and quotes
  // never close on the forge, so they are left untouched.
  const pattern = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#${issueNumber}\b`, "gi");
  let result = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const matched = match[0];
    if (!isVisibleClosingMatch(text, start, matched.length)) continue;
    result += text.slice(last, start);
    result += `Refs #${issueNumber}`;
    last = start + matched.length;
  }
  if (last === 0) return text;
  return result + text.slice(last);
}

export function rewriteRefsToClosing(text: string, issueNumber: number): string {
  // Replace visible non-closing references to the worked issue (`Refs #N`,
  // `Part of #N`, `Progress toward(s) #N`, `Related to #N`) with a closing
  // `Fixes #N` reference. Other issues keep their wording. Code spans,
  // fenced blocks, and quotes never close on the forge, so like the
  // closing-to-refs direction they are left untouched.
  const pattern = new RegExp(
    String.raw`\b(?:refs?|part of|progress towards?|related to)\s*:?\s*#${issueNumber}\b`,
    "gi"
  );
  let result = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const matched = match[0];
    if (!isVisibleClosingMatch(text, start, matched.length)) continue;
    result += text.slice(last, start);
    result += `Fixes #${issueNumber}`;
    last = start + matched.length;
  }
  if (last === 0) return text;
  return result + text.slice(last);
}

/** Remaining list rendering; items are scrubbed so a non-empty list never visibly closes the worked issue. */
function renderWorkRemainingItems(items: readonly string[], issueNumber: number): string {
  return `Remaining:\n${items.map((item) => `- ${rewriteClosingToRefs(item, issueNumber)}`).join("\n")}`;
}

function renderPostMergeItems(items: readonly string[], issueNumber: number): string {
  return `${POST_MERGE_HEADING}\n${items.map((item) => `- ${rewriteClosingToRefs(item, issueNumber)}`).join("\n")}`;
}

/** Rendered `Remaining:` / post-merge sections, or empty when nothing is left. */
export function renderRemainingSections(
  work: readonly string[],
  postMerge: readonly string[],
  issueNumber: number
): string {
  const parts: string[] = [];
  if (work.length > 0) parts.push(renderWorkRemainingItems(work, issueNumber));
  if (postMerge.length > 0) parts.push(renderPostMergeItems(postMerge, issueNumber));
  return parts.join("\n\n");
}

/** Whether the live body keeps the issue open: visible Refs with no visible closing keyword. */
export function isNonClosingLiveBody(liveBody: string | null | undefined, issueNumber: number): boolean {
  const visible = visibleClosingText(liveBody ?? "");
  if (closesIssuePattern(issueNumber).test(visible)) return false;
  return refsIssuePattern(issueNumber).test(visible);
}

/** SHA-256 hex of one string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface PersistedPrClosing {
  prNumber: number;
  decision: "fixes" | "refs";
  regionSha256: string;
}

/** Whitelisted parse of the persisted closing record; anything malformed is absent. */
export function parsePersistedPrClosing(value: unknown): PersistedPrClosing | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as { prNumber?: unknown; decision?: unknown; regionSha256?: unknown };
  if (typeof rec.prNumber !== "number" || !Number.isSafeInteger(rec.prNumber) || rec.prNumber <= 0) return undefined;
  if (rec.decision !== "fixes" && rec.decision !== "refs") return undefined;
  if (typeof rec.regionSha256 !== "string" || !/^[0-9a-f]{64}$/.test(rec.regionSha256)) return undefined;
  return { prNumber: rec.prNumber, decision: rec.decision, regionSha256: rec.regionSha256 };
}

/**
 * Reuse the persisted closing decision only when it names this PR and the
 * live Jumi region hashes to the persisted value. Otherwise the caller falls
 * back to today's live-body parse.
 */
export function persistedClosingDecision(
  persisted: PersistedPrClosing | undefined,
  prNumber: number,
  liveRegionOrBody: string | null | undefined
): "fixes" | "refs" | undefined {
  if (!persisted || persisted.prNumber !== prNumber) return undefined;
  if (sha256Hex(liveRegionOrBody ?? "") !== persisted.regionSha256) return undefined;
  return persisted.decision;
}
