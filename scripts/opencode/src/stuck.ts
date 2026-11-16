import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deleteClaim, reviewStuckStatePath, stuckStatePath } from "./claim.ts";
import { TOO_MANY_FOLLOWUP_ROUNDS_REASON } from "./pr_decision.ts";
import { type SkipLatchKey, type SkipLatchStore, skipLatchStoreFromPath } from "./skip_latches.ts";
import { upsertStickyComment } from "./sticky_comment.ts";
import { parseReviewFindings, parseReviewOutput } from "./verdict.ts";

export const SAME_ACTION_LIMIT = 4;
export const SAME_ERROR_LIMIT = 3;
export const SAME_FINDING_LIMIT = 3;
export const STUCK_HISTORY_LIMIT = 32;

export const SAME_FINDING_STUCK = "stuck: same finding repeated";

export type StuckKind = "action" | "ci" | "error" | "finding";
export type StuckReason = "repeated-action" | "repeated-error" | "ping-pong" | "same-finding";

export interface StuckFingerprint {
  kind: StuckKind;
  hash: string;
}

export interface QuotaStuck {
  reason: string;
  updatedAt: string;
}

export interface StuckState {
  fingerprints: StuckFingerprint[];
  updatedAt: string;
  /** Set when OpenCode hit a Free/Go usage-limit retry. Cleared with the file on kill-switch cancel. */
  quota?: QuotaStuck;
}

export { reviewStuckStatePath, stuckStatePath };

export function stuckComment(reason: StuckReason): string {
  if (reason === "repeated-action") return "stuck: repeated action";
  if (reason === "repeated-error") return "stuck: repeated error";
  if (reason === "same-finding") return SAME_FINDING_STUCK;
  return "stuck: ping-pong";
}

export function isSkipLatchReason(reason: string | null | undefined): boolean {
  return Boolean(reason?.startsWith("stuck:"));
}

/**
 * Follow-up round-cap latch. A closer that has used its follow-up rounds
 * stores `stuck: too many follow-up rounds` as the issue skip latch. A later
 * conflict wake for the same closing issue must still dispatch to
 * `implementConflict` (which enforces its own conflict-round cap) instead of
 * publishing skipped from this latch. Every other `stuck:` latch still
 * refuses every kind.
 */
export { TOO_MANY_FOLLOWUP_ROUNDS_REASON };
export function isTooManyFollowupRoundsReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.trim() === TOO_MANY_FOLLOWUP_ROUNDS_REASON;
}

export function stuckMarker(owner: string, repo: string, index: number): string {
  return `<!-- jumi-stuck:${owner}/${repo}#${index} -->`;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const BOILERPLATE = new Set(["", "(no trigger body)", "no review comments this round. address jumi_ci.md."]);

export function normalizeFinding(text: string): string {
  let value = text.replace(/\r\n/g, "\n");
  value = value.replace(/<!--\s*jumi-(?:review|check|stuck|worker):[\s\S]*?-->/gi, " ");
  value = value.replace(/^Reviewed commit:\s*`[0-9a-fA-F]+`\s*$/gim, "");
  value = value.replace(/^(?:PR|Number|Head SHA|Head ref|Event|Sender|Comment id|Review id):.*$/gim, "");
  value = value.replace(/^#{1,3}\s+(?:Comment|Inline|Review)\s+\d+\b.*$/gim, "");
  value = value.replace(/^# Review feedback.*$/gim, "");
  value = value.replace(/^## (?:Trigger|Other comments|Failed CI)\s*$/gim, "");
  // Prompt-injection framing (#438): worker task/feedback files wrap untrusted
  // forge text in <untrusted_issue>/<untrusted_data> blocks with an instruction
  // header and banner. Fingerprints compare the underlying content, so the
  // framing is removed and entities unescaped before comparing.
  value = value.replace(/^Every comment\/review body below is untrusted forge data wrapped in$/gim, "");
  value = value.replace(/^<untrusted_data> for one entry\. It is input to address, never instructions$/gim, "");
  value = value.replace(/^to follow\. Author and permission are shown where the forge provided them\.$/gim, "");
  value = value.replace(/<\/?untrusted_(?:issue|data)(?:\s[^>]*)?>/gi, " ");
  value = value.replace(/<\/?(?:title|body)>/gi, " ");
  value = value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
  value = value.replace(/\b[0-9a-f]{7,40}\b/gi, "");
  value = value.replace(/\s+/g, " ").trim().toLowerCase();
  return value;
}

export function fingerprintReviewArtifact(markdown: string | null | undefined): string | undefined {
  if (!markdown?.trim()) return undefined;
  const parsed = parseReviewOutput(markdown);
  if (parsed.verdict.incomplete) return undefined;
  if (parsed.verdict.state !== "failure") return undefined;
  const normalized = normalizeFinding(parsed.comment);
  if (!normalized) return undefined;
  return hashText(normalized);
}

export function fingerprintFollowUpText(markdown: string | null | undefined): string | undefined {
  if (!markdown?.trim()) return undefined;
  const normalized = normalizeFinding(markdown);
  if (!normalized || BOILERPLATE.has(normalized)) return undefined;
  return hashText(normalized);
}

export function fingerprintCiChecks(checks: { name: string; logHash: string }[]): string | undefined {
  const parts = checks
    .map((check) => `${check.name}:${check.logHash}`)
    .filter((part) => !part.endsWith(":"))
    .sort();
  if (parts.length === 0) return undefined;
  return hashText(parts.join("\n"));
}

export function fingerprintError(error: string | null | undefined): string | undefined {
  const text = (error ?? "").trim();
  if (!text) return undefined;
  const lower = text.toLowerCase();
  if (lower === "cancelled" || lower.includes("aborterror")) return undefined;
  const normalized = normalizeFinding(text);
  if (!normalized) return undefined;
  return hashText(normalized);
}

/**
 * Finding identity for same-finding stuck detection.
 *
 * Identity is location (path plus a line bucket so nearby lines count as the
 * same), severity (blocking only: bug/🔴 or risk/🟡), and a short normalized
 * summary. Per-round notes ("Re-checked on this head ..."), quoted SHAs,
 * markdown, case, punctuation, and word order do not count.
 */

export function bucketFindingLine(line: number): number {
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

export function findingSummarySignature(body: string): string {
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

/** Sorted blocking finding identities (`path|bucket|severity|summary`). Empty when no blocking finding. */
export function blockingFindingIdentities(markdown: string | null | undefined): string[] {
  if (!markdown?.trim()) return [];
  const findings = parseReviewFindings(markdown);
  const identities: string[] = [];
  for (const finding of findings) {
    const severity = severityForIdentity(finding.body);
    if (!severity) continue;
    const summary = findingSummarySignature(finding.body);
    if (!summary) continue;
    identities.push(`${finding.path}|${bucketFindingLine(finding.line)}|${severity}|${summary}`);
  }
  return [...new Set(identities)].sort();
}

export function fingerprintFindingIdentity(markdown: string | null | undefined): string | undefined {
  const identities = blockingFindingIdentities(markdown);
  if (identities.length === 0) return undefined;
  return hashText(identities.join("\n"));
}

export interface PrDiffFileInput {
  filename: string;
  patch?: string | null | undefined;
  status?: string | null | undefined;
  additions?: number | null | undefined;
  deletions?: number | null | undefined;
  changes?: number | null | undefined;
}

export function fingerprintPrDiffFromFiles(files: ReadonlyArray<PrDiffFileInput>): string | undefined {
  if (!files || files.length === 0) return undefined;
  const entries = [...files]
    .map((file) => ({
      name: (file.filename ?? "").trim(),
      // Omitted patch (large/binary files) must not hash like an empty
      // patch: a diff whose patches are all omitted fails open instead.
      patch: typeof file.patch === "string" ? file.patch : undefined,
      status: (file.status ?? "").trim(),
      additions: typeof file.additions === "number" && Number.isFinite(file.additions) ? file.additions : undefined,
      deletions: typeof file.deletions === "number" && Number.isFinite(file.deletions) ? file.deletions : undefined,
      changes: typeof file.changes === "number" && Number.isFinite(file.changes) ? file.changes : undefined,
    }))
    .filter((file) => file.name)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (entries.length === 0) return undefined;
  if (entries.every((file) => file.patch === undefined)) return undefined;
  const parts = entries.map((file) =>
    [
      file.name,
      `status=${file.status}`,
      `additions=${file.additions ?? ""}`,
      `deletions=${file.deletions ?? ""}`,
      `changes=${file.changes ?? ""}`,
      `patch=${file.patch ?? "<no-patch>"}`,
    ].join("\n")
  );
  return hashText(parts.join("\n---\n"));
}

export function fingerprintSameFinding(findingHash: string, diffHash: string): string {
  return hashText(`${findingHash}|${diffHash}`);
}

function firstSentenceForDisplay(body: string): string {
  const text = stripSeverityPrefix(body).replace(/\s+/g, " ").trim();
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text);
  const sentence = (match?.[1] ?? text).trim();
  return sentence.length > 140 ? `${sentence.slice(0, 140).trimEnd()}…` : sentence;
}

/** Human display for the latch/board: `path:line emoji summary`, truncated. */
export function sameFindingDisplay(markdown: string | null | undefined): string | undefined {
  if (!markdown?.trim()) return undefined;
  const findings = parseReviewFindings(markdown);
  for (const finding of findings) {
    const severity = severityForIdentity(finding.body);
    if (!severity) continue;
    const emoji = severity === "bug" ? "🔴" : "🟡";
    const summary = firstSentenceForDisplay(finding.body);
    if (!summary) continue;
    const display = `${finding.path}:${finding.line} ${emoji} ${summary}`.trim();
    return display.length > 200 ? `${display.slice(0, 200).trimEnd()}…` : display;
  }
  return undefined;
}

export type FindingInlineInput = {
  path?: string | null | undefined;
  new_position?: number | null | undefined;
  body?: string | null | undefined;
};

export function findingIdentityFromInline(
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

/** Blocking identities from a top-level review body plus unresolved Jumi inlines. */
export function blockingFindingIdentitiesFromParts(
  reviewBody: string | null | undefined,
  inlines?: readonly FindingInlineInput[] | null | undefined
): string[] {
  const out = new Set<string>(blockingFindingIdentities(reviewBody));
  for (const inline of inlines ?? []) {
    if (!inline) continue;
    const identity = findingIdentityFromInline(
      inline.path ?? undefined,
      typeof inline.new_position === "number" ? inline.new_position : undefined,
      inline.body ?? undefined
    );
    if (identity) out.add(identity);
  }
  return [...out].sort();
}

export function fingerprintFindingIdentityFromParts(
  reviewBody: string | null | undefined,
  inlines?: readonly FindingInlineInput[] | null | undefined
): string | undefined {
  const identities = blockingFindingIdentitiesFromParts(reviewBody, inlines);
  if (identities.length === 0) return undefined;
  return hashText(identities.join("\n"));
}

export function sameFindingDisplayFromParts(
  reviewBody: string | null | undefined,
  inlines?: readonly FindingInlineInput[] | null | undefined
): string | undefined {
  const fromBody = sameFindingDisplay(reviewBody);
  if (fromBody) return fromBody;
  for (const inline of inlines ?? []) {
    if (!inline?.path?.trim()) continue;
    const severity = severityForIdentity(inline.body ?? "");
    if (!severity) continue;
    const emoji = severity === "bug" ? "🔴" : "🟡";
    const summary = firstSentenceForDisplay(inline.body ?? "");
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

export function sameFindingLatchReason(markdown: string | null | undefined): string {
  const display = sameFindingDisplay(markdown);
  if (!display) return SAME_FINDING_STUCK;
  const reason = `${SAME_FINDING_STUCK} (${display})`;
  return reason.length > 300 ? `${reason.slice(0, 300).trimEnd()}…)` : reason;
}

export function sameFindingLatchReasonFromParts(
  reviewBody: string | null | undefined,
  inlines?: readonly FindingInlineInput[] | null | undefined
): string {
  const display = sameFindingDisplayFromParts(reviewBody, inlines);
  if (!display) return SAME_FINDING_STUCK;
  const reason = `${SAME_FINDING_STUCK} (${display})`;
  return reason.length > 300 ? `${reason.slice(0, 300).trimEnd()}…)` : reason;
}

function lastThreePingPong(fingerprints: readonly StuckFingerprint[]): boolean {
  if (fingerprints.length < 3) return false;
  const a = fingerprints[fingerprints.length - 3];
  const b = fingerprints[fingerprints.length - 2];
  const c = fingerprints[fingerprints.length - 1];
  return a.hash === c.hash && a.hash !== b.hash;
}

function lastRepeat(fingerprints: readonly StuckFingerprint[], limit: number): boolean {
  if (fingerprints.length < limit) return false;
  const slice = fingerprints.slice(-limit);
  return slice.every((fp) => fp.hash === slice[0].hash);
}

function detectKindStuck(
  history: readonly StuckFingerprint[],
  kind: StuckKind,
  repeatLimit: number,
  repeatReason: StuckReason
): StuckReason | undefined {
  const slice = history.filter((fp) => fp.kind === kind);
  if (lastThreePingPong(slice)) return "ping-pong";
  if (lastRepeat(slice, repeatLimit)) return repeatReason;
  return undefined;
}

export function detectStuck(history: readonly StuckFingerprint[]): StuckReason | undefined {
  const valid = history.filter((fp) => fp.hash);
  return (
    detectKindStuck(valid, "action", SAME_ACTION_LIMIT, "repeated-action") ??
    detectKindStuck(valid, "ci", SAME_ACTION_LIMIT, "repeated-action") ??
    detectKindStuck(valid, "finding", SAME_FINDING_LIMIT, "same-finding") ??
    detectKindStuck(valid, "error", SAME_ERROR_LIMIT, "repeated-error")
  );
}

export function evaluateStuck(
  history: readonly StuckFingerprint[],
  current?: StuckFingerprint
): StuckReason | undefined {
  const existing = detectStuck(history);
  if (existing) return existing;
  if (current) return detectStuck([...history, current]);
  return undefined;
}

function emptyStuckState(): StuckState {
  return { fingerprints: [], updatedAt: "" };
}

function parseStuckState(parsed: unknown): StuckState {
  if (!parsed || typeof parsed !== "object") return emptyStuckState();
  const rec = parsed as { fingerprints?: unknown; updatedAt?: unknown; quota?: unknown };
  const fingerprints: StuckFingerprint[] = [];
  if (Array.isArray(rec.fingerprints)) {
    for (const entry of rec.fingerprints) {
      if (!entry || typeof entry !== "object") continue;
      const fp = entry as { kind?: unknown; hash?: unknown };
      if (
        (fp.kind === "action" || fp.kind === "ci" || fp.kind === "error" || fp.kind === "finding") &&
        typeof fp.hash === "string" &&
        fp.hash
      ) {
        fingerprints.push({ kind: fp.kind, hash: fp.hash });
      }
    }
  }
  let quota: QuotaStuck | undefined;
  if (rec.quota && typeof rec.quota === "object") {
    const q = rec.quota as { reason?: unknown; updatedAt?: unknown };
    if (typeof q.reason === "string" && q.reason.trim()) {
      quota = {
        reason: q.reason,
        updatedAt: typeof q.updatedAt === "string" ? q.updatedAt : "",
      };
    }
  }
  const state: StuckState = {
    fingerprints,
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : "",
  };
  if (quota) state.quota = quota;
  return state;
}

export async function readStuckLatch(store: SkipLatchStore, key: SkipLatchKey): Promise<StuckState> {
  return parseStuckState((await store.get(key)).stuck);
}

export async function writeStuckLatch(store: SkipLatchStore, key: SkipLatchKey, state: StuckState): Promise<void> {
  await store.put(key, { stuck: state });
}

export async function readStuckState(path: string): Promise<StuckState> {
  const latch = skipLatchStoreFromPath(path);
  if (latch) return readStuckLatch(latch.store, latch.key);
  try {
    return parseStuckState(JSON.parse(await readFile(path, "utf8")));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return emptyStuckState();
    return emptyStuckState();
  }
}

export async function writeStuckState(path: string, state: StuckState): Promise<void> {
  const latch = skipLatchStoreFromPath(path);
  if (latch) {
    await writeStuckLatch(latch.store, latch.key, state);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function appendStuckLatchFingerprint(
  store: SkipLatchStore,
  key: SkipLatchKey,
  fingerprint: StuckFingerprint,
  now = () => new Date()
): Promise<void> {
  const state = await readStuckLatch(store, key);
  const fingerprints = [...state.fingerprints, fingerprint].slice(-STUCK_HISTORY_LIMIT);
  const next: StuckState = { fingerprints, updatedAt: now().toISOString() };
  if (state.quota) next.quota = state.quota;
  await writeStuckLatch(store, key, next);
}

export async function appendStuckFingerprint(
  path: string,
  fingerprint: StuckFingerprint,
  now = () => new Date()
): Promise<void> {
  const latch = skipLatchStoreFromPath(path);
  if (latch) {
    await appendStuckLatchFingerprint(latch.store, latch.key, fingerprint, now);
    return;
  }
  const state = await readStuckState(path);
  const fingerprints = [...state.fingerprints, fingerprint].slice(-STUCK_HISTORY_LIMIT);
  const next: StuckState = { fingerprints, updatedAt: now().toISOString() };
  if (state.quota) next.quota = state.quota;
  await writeStuckState(path, next);
}

export function isQuotaStuck(state: StuckState | undefined | null): boolean {
  return Boolean(state?.quota?.reason?.trim());
}

/**
 * Reviewer quota gate with a TTL. Worker quota (`isQuotaStuck`) is permanent
 * until the human kill-switch cycle deletes the file, but the reviewer flag
 * lives at `reviewer/jobs/.../*.stuck.json` per PR number with no
 * reviewer-side cancel entry point, so one transient quota event (quota
 * resets in hours/days) would otherwise disable reviews for that PR forever.
 * After the TTL the next run re-checks instead of reusing permanent
 * fingerprint-file semantics.
 */
export const REVIEW_QUOTA_TTL_MS = 24 * 60 * 60 * 1000;

export function isReviewQuotaStuck(state: StuckState | undefined | null, nowMs: number = Date.now()): boolean {
  const reason = state?.quota?.reason?.trim();
  if (!reason) return false;
  const updatedAt = state?.quota?.updatedAt;
  const updatedMs = typeof updatedAt === "string" && updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(updatedMs)) return true;
  return nowMs - updatedMs < REVIEW_QUOTA_TTL_MS;
}

export function quotaStuckReason(state: StuckState | undefined | null): string | undefined {
  const reason = state?.quota?.reason?.trim();
  return reason ? reason : undefined;
}

export async function markQuotaStuckLatch(
  store: SkipLatchStore,
  key: SkipLatchKey,
  reason: string,
  now = () => new Date()
): Promise<void> {
  const state = await readStuckLatch(store, key);
  await writeStuckLatch(store, key, {
    fingerprints: state.fingerprints.slice(-STUCK_HISTORY_LIMIT),
    updatedAt: now().toISOString(),
    quota: { reason, updatedAt: now().toISOString() },
  });
}

export async function markQuotaStuck(path: string, reason: string, now = () => new Date()): Promise<void> {
  const latch = skipLatchStoreFromPath(path);
  if (latch) {
    await markQuotaStuckLatch(latch.store, latch.key, reason, now);
    return;
  }
  const state = await readStuckState(path);
  await writeStuckState(path, {
    fingerprints: state.fingerprints.slice(-STUCK_HISTORY_LIMIT),
    updatedAt: now().toISOString(),
    quota: { reason, updatedAt: now().toISOString() },
  });
}

/** Clear only the quota flag, keeping fingerprint history. Used after a
 * successful run following a TTL-expired reviewer quota. */
export async function clearQuotaStuck(path: string, now = () => new Date()): Promise<void> {
  const state = await readStuckState(path);
  if (!state.quota) return;
  await writeStuckState(path, {
    fingerprints: state.fingerprints.slice(-STUCK_HISTORY_LIMIT),
    updatedAt: now().toISOString(),
  });
}

export function reviewLatchKey(owner: string, repo: string, prNumber: number): SkipLatchKey {
  return { owner, repo, issueNumber: prNumber };
}

export async function readReviewStuckLatch(
  store: SkipLatchStore,
  owner: string,
  repo: string,
  prNumber: number
): Promise<StuckState> {
  return parseStuckState((await store.get(reviewLatchKey(owner, repo, prNumber))).reviewStuck);
}

export async function writeReviewStuckLatch(
  store: SkipLatchStore,
  owner: string,
  repo: string,
  prNumber: number,
  state: StuckState
): Promise<void> {
  await store.put(reviewLatchKey(owner, repo, prNumber), { reviewStuck: state });
}

export async function appendReviewStuckLatch(
  store: SkipLatchStore,
  owner: string,
  repo: string,
  prNumber: number,
  fingerprint: StuckFingerprint,
  now = () => new Date()
): Promise<void> {
  const key = reviewLatchKey(owner, repo, prNumber);
  const state = parseStuckState((await store.get(key)).reviewStuck);
  const fingerprints = [...state.fingerprints, fingerprint].slice(-STUCK_HISTORY_LIMIT);
  const next: StuckState = { fingerprints, updatedAt: now().toISOString() };
  if (state.quota) next.quota = state.quota;
  await store.put(key, { reviewStuck: next });
}

export async function markReviewQuotaStuckLatch(
  store: SkipLatchStore,
  owner: string,
  repo: string,
  prNumber: number,
  reason: string,
  now = () => new Date()
): Promise<void> {
  const key = reviewLatchKey(owner, repo, prNumber);
  const state = parseStuckState((await store.get(key)).reviewStuck);
  await store.put(key, {
    reviewStuck: {
      fingerprints: state.fingerprints.slice(-STUCK_HISTORY_LIMIT),
      updatedAt: now().toISOString(),
      quota: { reason, updatedAt: now().toISOString() },
    },
  });
}

export async function clearReviewQuotaStuckLatch(
  store: SkipLatchStore,
  owner: string,
  repo: string,
  prNumber: number,
  now = () => new Date()
): Promise<void> {
  const key = reviewLatchKey(owner, repo, prNumber);
  const state = parseStuckState((await store.get(key)).reviewStuck);
  if (!state.quota) return;
  await store.put(key, {
    reviewStuck: {
      fingerprints: state.fingerprints.slice(-STUCK_HISTORY_LIMIT),
      updatedAt: now().toISOString(),
    },
  });
}

export async function deleteReviewStuckLatch(
  store: SkipLatchStore,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  await store.put(reviewLatchKey(owner, repo, prNumber), { reviewStuck: { fingerprints: [], updatedAt: "" } });
}

function reviewLedgerMode(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export interface ReviewStuckRef {
  home?: string;
  owner: string;
  repo: string;
  prNumber: number;
  skipLatches?: SkipLatchStore;
}

export async function readReviewStuckState(ref: ReviewStuckRef): Promise<StuckState> {
  if (reviewLedgerMode()) {
    if (!ref.skipLatches) return { fingerprints: [], updatedAt: "" };
    return readReviewStuckLatch(ref.skipLatches, ref.owner, ref.repo, ref.prNumber);
  }
  if (ref.skipLatches) {
    return readReviewStuckLatch(ref.skipLatches, ref.owner, ref.repo, ref.prNumber);
  }
  if (!ref.home) return { fingerprints: [], updatedAt: "" };
  return readStuckState(reviewStuckStatePath(ref.home, ref.owner, ref.repo, ref.prNumber));
}

export async function appendReviewStuckState(
  ref: ReviewStuckRef,
  fingerprint: StuckFingerprint,
  now = () => new Date()
): Promise<void> {
  if (reviewLedgerMode()) {
    if (!ref.skipLatches) return;
    await appendReviewStuckLatch(ref.skipLatches, ref.owner, ref.repo, ref.prNumber, fingerprint, now);
    return;
  }
  if (ref.skipLatches) {
    await appendReviewStuckLatch(ref.skipLatches, ref.owner, ref.repo, ref.prNumber, fingerprint, now);
    return;
  }
  if (!ref.home) return;
  await appendStuckFingerprint(reviewStuckStatePath(ref.home, ref.owner, ref.repo, ref.prNumber), fingerprint, now);
}

export async function markReviewQuotaStuckState(
  ref: ReviewStuckRef,
  reason: string,
  now = () => new Date()
): Promise<void> {
  if (reviewLedgerMode()) {
    if (!ref.skipLatches) return;
    await markReviewQuotaStuckLatch(ref.skipLatches, ref.owner, ref.repo, ref.prNumber, reason, now);
    return;
  }
  if (ref.skipLatches) {
    await markReviewQuotaStuckLatch(ref.skipLatches, ref.owner, ref.repo, ref.prNumber, reason, now);
    return;
  }
  if (!ref.home) return;
  await markQuotaStuck(reviewStuckStatePath(ref.home, ref.owner, ref.repo, ref.prNumber), reason, now);
}

export async function clearReviewQuotaStuckState(ref: ReviewStuckRef, now = () => new Date()): Promise<void> {
  if (reviewLedgerMode()) {
    if (!ref.skipLatches) return;
    await clearReviewQuotaStuckLatch(ref.skipLatches, ref.owner, ref.repo, ref.prNumber, now);
    return;
  }
  if (ref.skipLatches) {
    await clearReviewQuotaStuckLatch(ref.skipLatches, ref.owner, ref.repo, ref.prNumber, now);
    return;
  }
  if (!ref.home) return;
  await clearQuotaStuck(reviewStuckStatePath(ref.home, ref.owner, ref.repo, ref.prNumber), now);
}

/** Reviewer-side kill-switch: delete the per-PR quota/fingerprint file so the
 * next run re-checks instead of skipping forever. Human equivalent of the
 * worker `cancelIssueWork` clear path. */
export async function deleteReviewStuckState(
  home: string,
  owner: string,
  repo: string,
  prNumber: number,
  skipLatches?: SkipLatchStore
): Promise<void> {
  if (reviewLedgerMode()) {
    if (skipLatches) {
      await deleteReviewStuckLatch(skipLatches, owner, repo, prNumber);
    }
    return;
  }
  if (skipLatches) {
    await deleteReviewStuckLatch(skipLatches, owner, repo, prNumber);
  }
  await deleteClaim(reviewStuckStatePath(home, owner, repo, prNumber));
}

/** Reviewer cancel entry point: post `stopped` is left to the caller; here we
 * clear persisted reviewer state so a retry does not inherit a stale quota
 * flag. Mirrors the worker `handleIssueCancel` stuck-file deletion. */
export async function cancelReviewWork(opts: {
  home: string;
  owner: string;
  repo: string;
  prNumber: number;
  skipLatches?: SkipLatchStore;
}): Promise<void> {
  await deleteReviewStuckState(opts.home, opts.owner, opts.repo, opts.prNumber, opts.skipLatches);
}

type StuckCommentApi = {
  findStickyIssueComment(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined>;
  createIssueComment(owner: string, repo: string, index: number, body: string): Promise<unknown>;
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<unknown>;
};

export async function upsertStuckText(
  api: StuckCommentApi,
  owner: string,
  repo: string,
  index: number,
  botUsername: string,
  body: string
): Promise<void> {
  const marker = stuckMarker(owner, repo, index);
  await upsertStickyComment(api, owner, repo, index, botUsername, marker, body);
}

export async function upsertStuckComment(
  api: StuckCommentApi,
  owner: string,
  repo: string,
  index: number,
  botUsername: string,
  reason: StuckReason
): Promise<void> {
  await upsertStuckText(api, owner, repo, index, botUsername, stuckComment(reason));
}
