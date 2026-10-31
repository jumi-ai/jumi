import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deleteClaim, reviewStuckStatePath, stuckStatePath } from "./claim.ts";
import { type SkipLatchKey, type SkipLatchStore, skipLatchStoreFromPath } from "./skip_latches.ts";
import { parseReviewOutput } from "./verdict.ts";

export const SAME_ACTION_LIMIT = 4;
export const SAME_ERROR_LIMIT = 3;
export const STUCK_HISTORY_LIMIT = 32;

export type StuckKind = "action" | "ci" | "error";
export type StuckReason = "repeated-action" | "repeated-error" | "ping-pong";

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
  return "stuck: ping-pong";
}

export function isSkipLatchReason(reason: string | null | undefined): boolean {
  return Boolean(reason?.startsWith("stuck:"));
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
  value = value.replace(/^# Review feedback\s*$/gim, "");
  value = value.replace(/^## (?:Trigger|Other comments|Failed CI)\s*$/gim, "");
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
      if ((fp.kind === "action" || fp.kind === "ci" || fp.kind === "error") && typeof fp.hash === "string" && fp.hash) {
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
  const text = `${marker}\n${body}`;
  const existing = await api.findStickyIssueComment(owner, repo, index, botUsername, marker);
  if (existing) {
    await api.updateIssueComment(owner, repo, existing.id, text);
    return;
  }
  await api.createIssueComment(owner, repo, index, text);
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
