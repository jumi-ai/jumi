import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deleteClaim, reviewStuckStatePath, stuckStatePath } from "./claim.ts";
import { parseSkipWhy } from "./pr_decision.ts";
import { buildReviewFacts, type ReviewTrustCtx, resolveReviewFacts } from "./review_facts.ts";
import { type MetaFindingEntry, type MetaPayload, sha256Hex } from "./review_meta.ts";
import { type SkipLatchKey, type SkipLatchStore, skipLatchStoreFromPath } from "./skip_latches.ts";
import { SAME_FINDING_STUCK_TEXT, TOO_MANY_FOLLOWUP_ROUNDS_REASON } from "./skip_why_texts.ts";
import { upsertStickyComment } from "./sticky_comment.ts";

const SAME_ACTION_LIMIT = 4;
const SAME_ERROR_LIMIT = 3;
const SAME_FINDING_LIMIT = 3;
const STUCK_HISTORY_LIMIT = 32;

export const SAME_FINDING_STUCK = SAME_FINDING_STUCK_TEXT;

type StuckKind = "action" | "ci" | "error" | "finding";
export type StuckReason = "repeated-action" | "repeated-error" | "ping-pong" | "same-finding";

export interface StuckFingerprint {
  kind: StuckKind;
  hash: string;
}

interface QuotaStuck {
  reason: string;
  updatedAt: string;
}

export interface StuckState {
  fingerprints: StuckFingerprint[];
  updatedAt: string;
  /** Set when OpenCode hit a Free/Go usage-limit retry. Cleared with the file on kill-switch cancel. */
  quota?: QuotaStuck;
}

export function stuckComment(reason: StuckReason): string {
  if (reason === "repeated-action") return "stuck: repeated action";
  if (reason === "repeated-error") return "stuck: repeated error";
  if (reason === "same-finding") return SAME_FINDING_STUCK;
  return "stuck: ping-pong";
}

export function isSkipLatchReason(reason: string | null | undefined): boolean {
  return parseSkipWhy(reason).latches;
}
/**
 * Follow-up round-cap latch. A closer that has used its follow-up rounds
 * stores `stuck: too many follow-up rounds` as the issue skip latch. A later
 * conflict wake for the same closing issue must still dispatch to
 * `implementConflict` (which enforces its own conflict-round cap) instead of
 * publishing skipped from this latch. Every other `stuck:` latch still
 * refuses every kind.
 */
function isTooManyFollowupRoundsReason(reason: string | null | undefined): boolean {
  return parseSkipWhy(reason).why === "round-cap";
}

export function stuckMarker(owner: string, repo: string, index: number): string {
  return `<!-- jumi-stuck:${owner}/${repo}#${index} -->`;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const BOILERPLATE = new Set(["", "(no trigger body)", "no review comments this round. address jumi_ci.md."]);

function normalizeFinding(text: string): string {
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
  const facts = buildReviewFacts({ body: markdown });
  if (facts.incomplete) return undefined;
  if (facts.state !== "failure") return undefined;
  const normalized = normalizeFinding(facts.comment);
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

/** Sorted blocking finding identities (`path|bucket|severity|summary`). Empty when no blocking finding. */
export function blockingFindingIdentities(markdown: string | null | undefined, trust?: ReviewTrustCtx): string[] {
  if (!markdown?.trim()) return [];
  return resolveReviewFacts({ body: markdown, ...(trust ? { trust } : {}) }).facts.findingIdentities;
}

/**
 * Format tag for the latch's finding component. Keyed components hash
 * `k1:\n` plus the sorted key/text set; text components hash the sorted text
 * identities with no prefix. The prefix guarantees a keyed fingerprint can
 * never equal a text-era one, so history restarts at the format transition:
 * old code (text only) simply never matches a keyed entry and vice versa.
 * Rollback is safe: an old image computes text identities and compares only
 * entries it understands, restarting history instead of crashing.
 */
const KEYED_FINDING_FORMAT_PREFIX = "k1:";

const INLINE_REVIEW_MARKER = "<!-- jumi-review:";

function isKeyedBlockingEntry(entry: Pick<MetaFindingEntry, "s" | "t">): boolean {
  if (entry.s === "bug" || entry.s === "risk") return true;
  return entry.s === "question" && entry.t === "blocking";
}

function liveInlineLine(inline: FindingInlineInput): number {
  const line = (inline as { new_position?: unknown }).new_position;
  return typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : 0;
}

function liveInlineId(inline: FindingInlineInput): number | undefined {
  const id = (inline as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

function isLiveInlineResolved(inline: FindingInlineInput): boolean {
  const rec = inline as { resolved?: unknown; resolver?: unknown };
  return rec.resolved === true || rec.resolver != null;
}

function inlineEntryMatchesLive(entry: MetaFindingEntry, inline: FindingInlineInput): boolean {
  const body = inline.body ?? "";
  if (!body.includes(INLINE_REVIEW_MARKER)) return false;
  if (entry.cs === undefined) return false;
  let digest: string;
  try {
    digest = sha256Hex(body);
  } catch {
    return false;
  }
  if (digest !== entry.cs) return false;
  if (entry.path !== undefined && (inline.path ?? "").trim() !== entry.path.trim()) return false;
  const liveLine = liveInlineLine(inline);
  const entryLine =
    typeof entry.line === "number" && Number.isSafeInteger(entry.line) && entry.line > 0 ? entry.line : 0;
  // The writer mints an inline key only when the posted and live locations
  // are identical, so the latch counts a key only on an exact path/line
  // match. A reused comment at a different line falls back to text.
  if (entry.line !== undefined && liveLine !== entryLine) return false;
  return true;
}

function textIdentityForSingleInline(inline: FindingInlineInput): string | undefined {
  const identities = buildReviewFacts({ body: undefined, inlines: [inline] }).findingIdentities;
  return identities[0];
}

function logFindingIdentity(trust: ReviewTrustCtx | undefined, mode: "keyed" | "text", reason?: string): void {
  const log = trust?.log;
  if (!log) return;
  if (mode === "keyed") log("finding-identity: keyed");
  else log(`finding-identity: text reason=${reason ?? "no-block"}`);
}

function shouldStaySilentFindingIdentity(
  trust: ReviewTrustCtx | undefined,
  body: string | null | undefined,
  hasBlock: boolean
): boolean {
  // Mirror the `resolveReviewFacts` silent legacy path: with no verification
  // coordinates and no candidate block there is nothing to verify, so stay
  // completely silent exactly as today.
  return !trust && !hasBlock && !(body ?? "").includes("jumi-review:meta");
}

function hasMetaCandidate(body: string | null | undefined): boolean {
  return (body ?? "").includes("jumi-review:meta");
}

function keyedComponentsFromCurrent(
  payload: MetaPayload,
  reviewBody: string | null | undefined,
  inlines: readonly FindingInlineInput[]
): { keys: string[]; fallbackTexts: string[]; unmatched: FindingInlineInput[] } {
  const keys: string[] = [];
  const fallbackTexts: string[] = [];
  const live = inlines.filter((inline) => inline && !isLiveInlineResolved(inline));
  const bodyEntries = payload.findings.filter((entry) => entry.p === "body");
  const textBodyFacts = buildReviewFacts({ body: reviewBody }).findings.filter(
    (finding) => finding.placement === "body"
  );
  const orderedBody = [...bodyEntries].sort(
    (a, b) => (a.o ?? Number.MAX_SAFE_INTEGER) - (b.o ?? Number.MAX_SAFE_INTEGER)
  );
  for (let index = 0; index < orderedBody.length; index++) {
    const entry = orderedBody[index]!;
    if (entry.s !== "bug" && entry.s !== "risk" && entry.s !== "question") continue;
    if (!isKeyedBlockingEntry(entry)) continue;
    if (entry.k) {
      keys.push(entry.k);
      continue;
    }
    const textIdentity = textBodyFacts[index]?.identity;
    if (textIdentity) fallbackTexts.push(textIdentity);
  }
  const inlineEntries = payload.findings.filter((entry) => entry.p === "inline");
  const byCid = new Map<number, MetaFindingEntry>();
  for (const entry of inlineEntries) {
    if (typeof entry.cid === "number") byCid.set(entry.cid, entry);
  }
  const unmatched: FindingInlineInput[] = [];
  for (const inline of live) {
    const cid = liveInlineId(inline);
    const entry = cid !== undefined ? byCid.get(cid) : undefined;
    if (entry && inlineEntryMatchesLive(entry, inline) && isKeyedBlockingEntry(entry)) {
      if (entry.k) {
        keys.push(entry.k);
        continue;
      }
      const textIdentity = textIdentityForSingleInline(inline);
      if (textIdentity) fallbackTexts.push(textIdentity);
      continue;
    }
    unmatched.push(inline);
  }
  return { keys, fallbackTexts, unmatched };
}

function keyForInlineInExtraBodies(
  inline: FindingInlineInput,
  extraBodies: readonly (string | null | undefined)[],
  trust: ReviewTrustCtx
): { key?: string; fallbackText?: string } {
  const cid = liveInlineId(inline);
  if (cid === undefined) return {};
  const quietTrust: ReviewTrustCtx = { ...trust, log: () => undefined };
  for (const extraBody of extraBodies) {
    if (!extraBody?.includes("jumi-review:meta")) continue;
    let resolved: ReturnType<typeof resolveReviewFacts>;
    try {
      resolved = resolveReviewFacts({ body: extraBody, inlines: [inline], trust: quietTrust });
    } catch {
      continue;
    }
    if (resolved.source !== "typed" || !resolved.payload) continue;
    const entry = resolved.payload.findings.find((candidate) => candidate.p === "inline" && candidate.cid === cid);
    if (!entry || !isKeyedBlockingEntry(entry)) continue;
    if (!inlineEntryMatchesLive(entry, inline)) continue;
    if (entry.k) return { key: entry.k };
    const textIdentity = textIdentityForSingleInline(inline);
    if (textIdentity) return { fallbackText: textIdentity };
    return {};
  }
  return {};
}

function fingerprintFindingIdentityKeyed(
  reviewBody: string | null | undefined,
  inlines: readonly FindingInlineInput[],
  trust: ReviewTrustCtx,
  resolved: ReturnType<typeof resolveReviewFacts>,
  extraBodies: readonly (string | null | undefined)[]
): string | undefined {
  const payload = resolved.payload;
  if (!payload) {
    logFindingIdentity(trust, "text", resolved.reason ?? "no-block");
    const identities = resolved.facts.findingIdentities;
    if (identities.length === 0) return undefined;
    return hashText(identities.join("\n"));
  }
  const { keys, fallbackTexts, unmatched } = keyedComponentsFromCurrent(payload, reviewBody, inlines);
  const texts = [...fallbackTexts];
  for (const inline of unmatched) {
    const found = keyForInlineInExtraBodies(inline, extraBodies, trust);
    if (found.key) keys.push(found.key);
    else if (found.fallbackText) texts.push(found.fallbackText);
    else {
      const textIdentity = textIdentityForSingleInline(inline);
      if (textIdentity) texts.push(textIdentity);
    }
  }
  logFindingIdentity(trust, "keyed");
  const components = [...new Set([...keys, ...texts])].sort();
  if (components.length === 0) return undefined;
  return hashText(`${KEYED_FINDING_FORMAT_PREFIX}\n${components.join("\n")}`);
}

function fingerprintKeyedOrText(
  reviewBody: string | null | undefined,
  inlines: readonly FindingInlineInput[],
  trust: ReviewTrustCtx | undefined,
  extraBodies: readonly (string | null | undefined)[]
): string | undefined {
  const resolved = resolveReviewFacts({ body: reviewBody, inlines, ...(trust ? { trust } : {}) });
  if (resolved.source !== "typed" || !resolved.payload) {
    if (shouldStaySilentFindingIdentity(trust, reviewBody, hasMetaCandidate(reviewBody))) {
      const identities = resolved.facts.findingIdentities;
      if (identities.length === 0) return undefined;
      return hashText(identities.join("\n"));
    }
    logFindingIdentity(trust, "text", resolved.reason ?? "no-block");
    const identities = resolved.facts.findingIdentities;
    if (identities.length === 0) return undefined;
    return hashText(identities.join("\n"));
  }
  if (!trust) {
    const identities = resolved.facts.findingIdentities;
    if (identities.length === 0) return undefined;
    return hashText(identities.join("\n"));
  }
  return fingerprintFindingIdentityKeyed(reviewBody, inlines, trust, resolved, extraBodies);
}

export function fingerprintFindingIdentity(
  markdown: string | null | undefined,
  trust?: ReviewTrustCtx
): string | undefined {
  if (!markdown?.trim()) return undefined;
  return fingerprintKeyedOrText(markdown, [], trust, []);
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

export type FindingInlineInput = {
  id?: number | null | undefined;
  path?: string | null | undefined;
  new_position?: number | null | undefined;
  body?: string | null | undefined;
};

/** Extra review bodies to search for earlier-review inline keys (verified blocks only). */
export type FindingExtraReviews = readonly (string | null | undefined)[];

export function fingerprintFindingIdentityFromParts(
  reviewBody: string | null | undefined,
  inlines?: readonly FindingInlineInput[] | null | undefined,
  trust?: ReviewTrustCtx,
  extraReviewBodies?: FindingExtraReviews
): string | undefined {
  return fingerprintKeyedOrText(reviewBody, inlines ?? [], trust, extraReviewBodies ?? []);
}

export function sameFindingDisplayFromParts(
  reviewBody: string | null | undefined,
  inlines?: readonly FindingInlineInput[] | null | undefined,
  trust?: ReviewTrustCtx
): string | undefined {
  return resolveReviewFacts({ body: reviewBody, inlines: inlines ?? [], ...(trust ? { trust } : {}) }).facts
    .sameFindingDisplay;
}

function sameFindingLatchReason(markdown: string | null | undefined, trust?: ReviewTrustCtx): string {
  const display = resolveReviewFacts({ body: markdown, ...(trust ? { trust } : {}) }).facts.sameFindingDisplay;
  if (!display) return SAME_FINDING_STUCK;
  const reason = `${SAME_FINDING_STUCK} (${display})`;
  return reason.length > 300 ? `${reason.slice(0, 300).trimEnd()}…)` : reason;
}

export function sameFindingLatchReasonFromParts(
  reviewBody: string | null | undefined,
  inlines?: readonly FindingInlineInput[] | null | undefined,
  trust?: ReviewTrustCtx
): string {
  const display = sameFindingDisplayFromParts(reviewBody, inlines, trust);
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

async function writeStuckLatch(store: SkipLatchStore, key: SkipLatchKey, state: StuckState): Promise<void> {
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

function quotaStuckReason(state: StuckState | undefined | null): string | undefined {
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

function reviewLatchKey(owner: string, repo: string, prNumber: number): SkipLatchKey {
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

async function writeReviewStuckLatch(
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

async function clearReviewQuotaStuckLatch(
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
async function deleteReviewStuckState(
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
  ): Promise<{ id: number; body?: string } | undefined>;
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
