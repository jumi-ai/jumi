import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCiMarkdown,
  CI_LOG_FILE,
  type CiInspection,
  flakeComment,
  flakeSkipReason,
  inspectCi,
  recordCiHandled,
} from "./ci.ts";
import { followUpStatePath } from "./claim.ts";
import {
  attachPrWorktree,
  beginClaimedWorktree,
  commitIfDirty,
  commitsAheadOf,
  ensureBareCache,
  inspectMovedPrHead,
  isClaimedEarlyResult,
  openClaimedLoop,
  pushClaimedBranch,
  recheckAssignedAndOpen,
  runClaimedLoop,
  skipClaimedWork,
  stripSentinels,
  throwIfAborted,
  worktreePorcelain,
} from "./claimed_worktree.ts";
import {
  CONFLICT_TIMEOUT_MS,
  MAX_CONFLICT_ROUNDS,
  type MergeDefaultResult,
  mergeDefaultIntoWorktree,
  readConflictLatch,
  shouldIncrementRound,
  writeConflictLatch,
} from "./conflict.ts";
import { type EngineRunOptions, runEngineStamped, throwIfEngineFailed, thrownRunner } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import { isJumiInternalBody, isJumiWorkerBody, loginInList } from "./followup_webhook.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { isEligibleWorkerPR, resolveWorkerPullRequest, upsertWorkerComment } from "./gitea_issues.ts";
import {
  buildPullRequestBody,
  buildTaskMarkdown,
  type ImplementOptions,
  jumiPrBodyRegion,
  PR_DESCRIPTION_FILE,
  readPullRequestDescription,
  replaceJumiPrBodyRegion,
  seedPullRequestDescription,
} from "./implement.ts";
import { gateShipAfterOpenCode, jobWithIssue, type ShipGate, snapshotFromJob } from "./issue_recheck.ts";
import { trustedWriteLogins } from "./permissions.ts";
import type { Comment, InlineComment, Pull, PullReview } from "./ports.ts";
import { isQuotaError, isQuotaText, QUOTA_STUCK_TEXT } from "./quota.ts";
import { throwIfQuotaWait } from "./quota_wait.ts";
import { appendRunnerStamp, type RunnerStamp } from "./runners.ts";
import { type SkipLatchKey, type SkipLatchStore, skipLatchesFor, skipLatchStoreFromPath } from "./skip_latches.ts";
import {
  appendStuckLatchFingerprint,
  evaluateStuck,
  fingerprintCiChecks,
  fingerprintError,
  fingerprintFollowUpText,
  isQuotaStuck,
  markQuotaStuckLatch,
  readStuckLatch,
  stuckComment,
} from "./stuck.ts";
import type { IssueJob } from "./types.ts";
import { parseCheckLine, trailerSuggestionCount } from "./verdict.ts";
import { redactGitSecrets, workerOpenCodeChildEnv } from "./workspace.ts";

export { FOLLOWUP_PROMPT } from "./git.ts";

export const FOLLOWUP_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_FOLLOWUP_ROUNDS = 3;
export const FEEDBACK_MAX_BYTES = 32 * 1024;
export const CI_PENDING_RETRY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FollowUpResult =
  | { status: "pushed"; prNumber: number; htmlUrl: string }
  | { status: "no-changes" }
  | { status: "skipped"; reason: string }
  | { status: "cancelled" };

export interface HandledReviewFinding {
  id: number;
  sha: string;
}

export interface FollowUpState {
  prNumber: number;
  round: number;
  lastHeadSha: string;
  handledCommentIds: number[];
  handledReviewIds: number[];
  handledReviewFindings: HandledReviewFinding[];
  updatedAt: string;
}

function logDefault(message: string) {
  console.log(`[followup] ${message}`);
}

function loginEquals(login: string | undefined, botUsername: string): boolean {
  return typeof login === "string" && login.toLowerCase() === botUsername.toLowerCase();
}

export { followUpStatePath };

function emptyFollowUpState(): FollowUpState {
  return {
    prNumber: 0,
    round: 0,
    lastHeadSha: "",
    handledCommentIds: [],
    handledReviewIds: [],
    handledReviewFindings: [],
    updatedAt: "",
  };
}

export function parseFollowUpState(parsed: unknown): FollowUpState {
  if (!parsed || typeof parsed !== "object") return emptyFollowUpState();
  const state = parsed as FollowUpState;
  return {
    prNumber: typeof state.prNumber === "number" ? state.prNumber : 0,
    round: typeof state.round === "number" ? state.round : 0,
    lastHeadSha: typeof state.lastHeadSha === "string" ? state.lastHeadSha : "",
    handledCommentIds: Array.isArray(state.handledCommentIds)
      ? state.handledCommentIds.filter((id): id is number => typeof id === "number")
      : [],
    handledReviewIds: Array.isArray(state.handledReviewIds)
      ? state.handledReviewIds.filter((id): id is number => typeof id === "number")
      : [],
    handledReviewFindings: parseHandledReviewFindings(state.handledReviewFindings),
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
  };
}

export async function readFollowUpLatch(store: SkipLatchStore, key: SkipLatchKey): Promise<FollowUpState> {
  return parseFollowUpState((await store.get(key)).followup);
}

export async function writeFollowUpLatch(
  store: SkipLatchStore,
  key: SkipLatchKey,
  state: FollowUpState
): Promise<void> {
  await store.put(key, { followup: state });
}

export async function readFollowUpState(path: string): Promise<FollowUpState> {
  const latch = skipLatchStoreFromPath(path);
  if (!latch) return emptyFollowUpState();
  return readFollowUpLatch(latch.store, latch.key);
}

function parseHandledReviewFindings(value: unknown): HandledReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: HandledReviewFinding[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as { id?: unknown; sha?: unknown };
    if (typeof rec.id === "number" && typeof rec.sha === "string" && rec.sha) {
      findings.push({ id: rec.id, sha: rec.sha });
    }
  }
  return findings;
}

function reviewFindingKey(id: number, sha: string): string {
  return `${id}:${sha.toLowerCase()}`;
}

function uniqueReviewFindings(findings: HandledReviewFinding[]): HandledReviewFinding[] {
  const seen = new Set<string>();
  const out: HandledReviewFinding[] = [];
  for (const finding of findings) {
    const key = reviewFindingKey(finding.id, finding.sha);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: finding.id, sha: finding.sha.toLowerCase() });
  }
  return out;
}

export async function writeFollowUpState(path: string, state: FollowUpState): Promise<void> {
  const latch = skipLatchStoreFromPath(path);
  if (!latch) return;
  await writeFollowUpLatch(latch.store, latch.key, state);
}

export function isInScopeHumanComment(
  comment: { body?: string | null; user?: { login?: string } },
  botUsername: string,
  ignoreLogins: readonly string[] = []
): boolean {
  const body = comment.body ?? "";
  if (!body.trim()) return false;
  if (isJumiInternalBody(body)) return false;
  if (loginEquals(comment.user?.login, botUsername)) return false;
  if (loginInList(comment.user?.login, ignoreLogins)) return false;
  return true;
}

const REVIEW_MARKER = "<!-- jumi-review:";
const REVIEWED_COMMIT_RE = /^Reviewed commit:\s*`([0-9a-fA-F]+)`\s*$/i;

function lastCheckTrailer(body: string): { state: "success" | "failure"; reason: string } | undefined {
  const lines = body.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    return parseCheckLine(line);
  }
  return undefined;
}

function isFindingCheck(check: { state: "success" | "failure"; reason: string } | undefined): boolean {
  if (!check) return false;
  if (check.state === "failure") return true;
  return trailerSuggestionCount(check.reason) > 0;
}

export function parseReviewedCommitSha(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = REVIEWED_COMMIT_RE.exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

function commitMatchesHead(stickySha: string, headSha: string): boolean {
  const sticky = stickySha.toLowerCase();
  const head = headSha.toLowerCase();
  if (!sticky || !head) return false;
  if (sticky === head) return true;
  return sticky.length < head.length && head.startsWith(sticky);
}

export function isJumiReviewSticky(
  comment: { body?: string | null; user?: { login?: string } },
  botUsername?: string
): boolean {
  const body = comment.body ?? "";
  if (!body.trim()) return false;
  if (!body.includes(REVIEW_MARKER)) return false;
  if (!lastCheckTrailer(body)) return false;
  if (isJumiWorkerBody(body)) return false;
  if (typeof botUsername === "string" && botUsername) {
    if (!loginEquals(comment.user?.login, botUsername)) return false;
  }
  return Boolean(parseReviewedCommitSha(body));
}

const EMPTY_SUCCESS_RE = /^No blocking issues\.?$/i;

export function isEmptySuccessReview(body: string | null | undefined): boolean {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return true;
  return EMPTY_SUCCESS_RE.test(trimmed);
}

function pullReviewBody(review: PullReview): string {
  return review.body ?? review.content ?? "";
}

function pullReviewFindingSha(review: PullReview): string | undefined {
  return parseReviewedCommitSha(pullReviewBody(review)) ?? (review.commit_id || undefined);
}

export function isJumiPullReviewWriteup(review: PullReview, botUsername: string): boolean {
  if (!loginEquals(review.user?.login, botUsername)) return false;
  const body = pullReviewBody(review);
  if (!body.trim() || isJumiWorkerBody(body) || isEmptySuccessReview(body)) return false;
  return lastCheckTrailer(body) !== undefined;
}

export function isJumiFailurePullReview(review: PullReview, botUsername: string): boolean {
  if (!isJumiPullReviewWriteup(review, botUsername)) return false;
  return lastCheckTrailer(pullReviewBody(review))?.state === "failure";
}

export function isJumiPullReviewFinding(
  review: PullReview,
  botUsername: string,
  headSha: string,
  opts: ReviewFindingMatchOpts = {}
): boolean {
  if (!isJumiPullReviewWriteup(review, botUsername)) return false;
  if (!isFindingCheck(lastCheckTrailer(pullReviewBody(review)))) return false;
  const sha = pullReviewFindingSha(review);
  if (!sha) return false;
  if (opts.anyReviewedCommit) return true;
  if (commitMatchesHead(sha, headSha)) return true;
  return (opts.extraHeadShas ?? []).some((extra) => commitMatchesHead(sha, extra));
}

export function isUnresolvedInline(comment: InlineComment): boolean {
  return comment.resolved !== true && comment.resolver == null;
}

function asReviewComment(review: PullReview): Comment {
  const body = pullReviewBody(review);
  const created = review.submitted_at ?? review.updated_at ?? review.created_at ?? "";
  return {
    id: review.id,
    body,
    user: review.user ?? { login: "" },
    created_at: created,
    updated_at: review.updated_at ?? created,
  };
}

export interface ReviewFindingMatchOpts {
  extraHeadShas?: readonly string[];
  anyReviewedCommit?: boolean;
}

export function isJumiReviewFinding(
  comment: { body?: string | null; user?: { login?: string } },
  headSha: string,
  opts: ReviewFindingMatchOpts = {},
  botUsername?: string
): boolean {
  if (!isJumiReviewSticky(comment, botUsername)) return false;
  if (!isFindingCheck(lastCheckTrailer(comment.body ?? ""))) return false;
  const stickySha = parseReviewedCommitSha(comment.body ?? "");
  if (!stickySha) return false;
  if (opts.anyReviewedCommit) return true;
  if (commitMatchesHead(stickySha, headSha)) return true;
  return (opts.extraHeadShas ?? []).some((sha) => commitMatchesHead(stickySha, sha));
}

function isJumiReviewInline(
  comment: { body?: string | null; user?: { login?: string } },
  botUsername: string
): boolean {
  const body = comment.body ?? "";
  if (!body.trim() || !body.includes(REVIEW_MARKER) || isJumiWorkerBody(body)) return false;
  return loginEquals(comment.user?.login, botUsername);
}

export function pickLatestJumiReview(stickies: readonly Comment[], headSha: string): Comment | undefined {
  if (stickies.length === 0) return undefined;
  const byDate = (a: Comment, b: Comment) => (a.created_at ?? "").localeCompare(b.created_at ?? "");
  const currentHead = stickies.filter((comment) => {
    const sha = parseReviewedCommitSha(comment.body ?? "");
    return sha !== undefined && commitMatchesHead(sha, headSha);
  });
  const pool = currentHead.length ? currentHead : stickies;
  return [...pool].sort(byDate).at(-1);
}

export function pickLatestJumiPullReview(reviews: readonly PullReview[], headSha: string): PullReview | undefined {
  if (reviews.length === 0) return undefined;
  const byDate = (a: PullReview, b: PullReview) =>
    (a.submitted_at ?? a.updated_at ?? a.created_at ?? "").localeCompare(
      b.submitted_at ?? b.updated_at ?? b.created_at ?? ""
    );
  const currentHead = reviews.filter((review) => {
    const sha = pullReviewFindingSha(review);
    return sha !== undefined && commitMatchesHead(sha, headSha);
  });
  const pool = currentHead.length ? currentHead : reviews;
  return [...pool].sort(byDate).at(-1);
}

export function isInScopeFollowUpComment(
  comment: { body?: string | null; user?: { login?: string } },
  botUsername: string,
  headSha: string,
  ignoreLogins: readonly string[] = [],
  findingOpts: ReviewFindingMatchOpts = {}
): boolean {
  if (!loginEquals(comment.user?.login, botUsername) && loginInList(comment.user?.login, ignoreLogins)) return false;
  return (
    isJumiReviewFinding(comment, headSha, findingOpts, botUsername) ||
    isInScopeHumanComment(comment, botUsername, ignoreLogins)
  );
}

export function prHeadChangedReason(from: string, to: string): string {
  return `PR head changed from ${from} to ${to}`;
}

export function parsePrHeadChangedReason(reason: string): { from: string; to: string } | undefined {
  const match = /^PR head changed from (\S+) to (\S+)$/.exec(reason.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return { from: match[1], to: match[2] };
}

export function isRequestChangesReview(review: PullReview): boolean {
  const blob = `${review.state ?? ""} ${review.type ?? ""}`.toLowerCase();
  return blob.includes("request_changes") || blob.includes("reject");
}

export function isCommentReview(review: PullReview): boolean {
  const blob = `${review.state ?? ""} ${review.type ?? ""}`.toLowerCase();
  return blob.includes("comment");
}

export interface FollowUpItems {
  comments: Comment[];
  inlines: InlineComment[];
  reviews: PullReview[];
  jumiStickies: Comment[];
  jumiInlines: InlineComment[];
  jumiReviews: PullReview[];
  jumiFindingReviews: PullReview[];
}

export function pickLatestJumiFinding(items: FollowUpItems, headSha: string): Comment | undefined {
  const headPull = pickLatestJumiPullReview(
    items.jumiReviews.filter((review) => {
      const sha = pullReviewFindingSha(review);
      return sha !== undefined && commitMatchesHead(sha, headSha);
    }),
    headSha
  );
  if (headPull) return asReviewComment(headPull);
  const headSticky = pickLatestJumiReview(
    items.jumiStickies.filter((comment) => {
      const sha = parseReviewedCommitSha(comment.body ?? "");
      return sha !== undefined && commitMatchesHead(sha, headSha);
    }),
    headSha
  );
  if (headSticky) return headSticky;
  const pull = pickLatestJumiPullReview(items.jumiReviews, headSha);
  if (pull) return asReviewComment(pull);
  return pickLatestJumiReview(items.jumiStickies, headSha);
}

export async function collectFollowUpItems(
  api: IssueApi,
  owner: string,
  repo: string,
  prNumber: number,
  botUsername: string,
  headSha: string,
  ignoreLogins: readonly string[] = [],
  findingOpts: ReviewFindingMatchOpts = {}
): Promise<FollowUpItems> {
  const [rawComments, rawReviews, rawInlines] = await Promise.all([
    api.listIssueComments(owner, repo, prNumber),
    api.listPullReviews(owner, repo, prNumber),
    api.listPullReviewComments(owner, repo, prNumber).catch((err: unknown): InlineComment[] => {
      logDefault(
        `inline review comments unavailable for ${owner}/${repo}#${prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return [];
    }),
  ]);
  const candidateComments = rawComments.filter((comment) =>
    isInScopeFollowUpComment(comment, botUsername, headSha, ignoreLogins, findingOpts)
  );
  const candidateInlines = rawInlines.filter((comment) => isInScopeHumanComment(comment, botUsername, ignoreLogins));
  const candidateReviews = rawReviews.filter(
    (review) =>
      (isRequestChangesReview(review) || isCommentReview(review)) &&
      isInScopeHumanComment({ body: review.body ?? review.content ?? "", user: review.user }, botUsername, ignoreLogins)
  );
  const trusted = await trustedWriteLogins(api, owner, repo, [
    ...candidateComments.map((comment) => comment.user?.login),
    ...candidateInlines.map((comment) => comment.user?.login),
    ...candidateReviews.map((review) => review.user?.login),
  ]);
  const isTrusted = (login: string | undefined): boolean =>
    typeof login === "string" && trusted.has(login.toLowerCase());
  const isBot = (login: string | undefined): boolean => loginEquals(login, botUsername);
  return {
    comments: candidateComments.filter((comment) => isBot(comment.user?.login) || isTrusted(comment.user?.login)),
    inlines: candidateInlines.filter((comment) => isTrusted(comment.user?.login)),
    reviews: candidateReviews.filter((review) => isTrusted(review.user?.login)),
    jumiStickies: rawComments.filter((comment) => isJumiReviewSticky(comment, botUsername)),
    jumiInlines: rawInlines.filter((comment) => isJumiReviewInline(comment, botUsername)),
    jumiReviews: rawReviews.filter((review) => isJumiPullReviewWriteup(review, botUsername)),
    jumiFindingReviews: rawReviews.filter((review) =>
      isJumiPullReviewFinding(review, botUsername, headSha, findingOpts)
    ),
  };
}

function reviewFindingFromComment(comment: { id: number; body?: string | null }): HandledReviewFinding | undefined {
  const body = comment.body ?? "";
  if (!body.includes(REVIEW_MARKER)) return undefined;
  const sha = parseReviewedCommitSha(body);
  if (!sha) return undefined;
  return { id: comment.id, sha };
}

function reviewFindingFromReview(review: PullReview): HandledReviewFinding | undefined {
  const sha = pullReviewFindingSha(review);
  if (!sha) return undefined;
  return { id: review.id, sha };
}

function briefInlines(items: FollowUpItems): InlineComment[] {
  const seen = new Set<number>();
  const out: InlineComment[] = [];
  for (const comment of items.inlines) {
    if (seen.has(comment.id)) continue;
    seen.add(comment.id);
    out.push(comment);
  }
  return out;
}

function unresolvedJumiInlines(items: FollowUpItems): InlineComment[] {
  return items.jumiInlines.filter(isUnresolvedInline);
}

function earlierJumiReviews(items: FollowUpItems, lastReview?: Comment): Comment[] {
  const skip = lastReview?.id;
  const out: Comment[] = [];
  const seen = new Set<number>();
  for (const review of items.jumiReviews) {
    if (review.id === skip) continue;
    seen.add(review.id);
    out.push(asReviewComment(review));
  }
  for (const comment of items.jumiStickies) {
    if (comment.id === skip || seen.has(comment.id)) continue;
    seen.add(comment.id);
    out.push(comment);
  }
  return out;
}

function hasUnhandledFollowUpItems(
  items: {
    comments: Comment[];
    inlines: InlineComment[];
    reviews: PullReview[];
    jumiFindingReviews?: PullReview[];
  },
  state: Pick<FollowUpState, "handledCommentIds" | "handledReviewIds" | "handledReviewFindings">
): boolean {
  const handledComments = new Set(state.handledCommentIds);
  const handledReviews = new Set(state.handledReviewIds);
  const handledFindings = new Set(
    state.handledReviewFindings.map((finding) => reviewFindingKey(finding.id, finding.sha))
  );
  const unhandledComments = items.comments.some((comment) => {
    const finding = reviewFindingFromComment(comment);
    if (finding) return !handledFindings.has(reviewFindingKey(finding.id, finding.sha));
    return !handledComments.has(comment.id);
  });
  const unhandledInlines = items.inlines.some((comment) => !handledComments.has(comment.id));
  const unhandledReviews = items.reviews.some((review) => !handledReviews.has(review.id));
  const unhandledJumiReviews = (items.jumiFindingReviews ?? []).some((review) => {
    const finding = reviewFindingFromReview(review);
    if (finding) return !handledFindings.has(reviewFindingKey(finding.id, finding.sha));
    return !handledReviews.has(review.id);
  });
  return unhandledComments || unhandledInlines || unhandledReviews || unhandledJumiReviews;
}

export async function needsFollowUp(opts: {
  api: IssueApi;
  owner: string;
  repo: string;
  pr: Pull;
  issueNumber: number;
  botUsername: string;
  home: string;
  maxFollowupRounds?: number;
  followupIgnoreLogins?: readonly string[];
  skipLatches?: SkipLatchStore;
}): Promise<boolean> {
  const state = await readFollowUpLatch(skipLatchesFor(opts), {
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: opts.issueNumber,
  });
  if (state.round >= (opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS)) return false;
  const items = await collectFollowUpItems(
    opts.api,
    opts.owner,
    opts.repo,
    opts.pr.number,
    opts.botUsername,
    opts.pr.head.sha,
    opts.followupIgnoreLogins
  );
  if (!hasUnhandledFollowUpItems(items, state)) return false;
  if (state.lastHeadSha && state.lastHeadSha === opts.pr.head.sha && !hasUnhandledFollowUpItems(items, state)) {
    return false;
  }
  return true;
}

interface FeedbackItem {
  kind: "comment" | "inline" | "review";
  id: number;
  createdAt: string;
  text: string;
}

export function buildFeedbackMarkdown(opts: {
  pr: Pull;
  trigger?: IssueJob["trigger"];
  triggerBody?: string;
  comments: Comment[];
  inlines: InlineComment[];
  reviews: PullReview[];
  lastReview?: Comment;
  currentInlines?: InlineComment[];
  earlierReviews?: Comment[];
}): { markdown: string; commentIds: number[]; reviewIds: number[] } {
  const header = [
    `# Review feedback`,
    ``,
    `PR: ${opts.pr.html_url}`,
    `Number: ${opts.pr.number}`,
    `Head SHA: ${opts.pr.head.sha}`,
    `Head ref: ${opts.pr.head.ref}`,
    ``,
  ].join("\n");

  const triggerLines = ["## Trigger", ""];
  if (opts.trigger) {
    triggerLines.push(`Event: ${opts.trigger.event}`);
    triggerLines.push(`Sender: ${opts.trigger.sender}`);
    if (opts.trigger.commentId !== undefined) triggerLines.push(`Comment id: ${opts.trigger.commentId}`);
    if (opts.trigger.reviewId !== undefined) triggerLines.push(`Review id: ${opts.trigger.reviewId}`);
    triggerLines.push("");
    const triggerBody = (opts.triggerBody ?? opts.trigger.body ?? "").trim();
    triggerLines.push(triggerBody ? triggerBody : "(no trigger body)");
  } else {
    triggerLines.push("Event: assigned");
    triggerLines.push("");
  }
  triggerLines.push("");
  const triggerSection = triggerLines.join("\n");

  const lastReviewSection = opts.lastReview ? `## Last review\n\n${opts.lastReview.body.trimEnd()}\n\n` : "";

  const currentInlineItems: FeedbackItem[] = [];
  for (const comment of opts.currentInlines ?? []) {
    currentInlineItems.push({
      kind: "inline",
      id: comment.id,
      createdAt: comment.created_at ?? "",
      text: `### Inline ${comment.id} by ${comment.user?.login ?? "unknown"}${comment.path ? ` on ${comment.path}` : ""}\n\n${comment.body}\n`,
    });
  }
  const currentInlineSection = currentInlineItems.length
    ? `${currentInlineItems.map((item) => item.text).join("\n")}\n`
    : "";

  const extras: FeedbackItem[] = [];
  for (const comment of opts.earlierReviews ?? []) {
    if (opts.lastReview?.id === comment.id) continue;
    extras.push({
      kind: "comment",
      id: comment.id,
      createdAt: comment.created_at ?? "",
      text: `### Earlier review ${comment.id}\n\n${comment.body}\n`,
    });
  }
  for (const comment of opts.comments) {
    if (opts.trigger?.commentId === comment.id) continue;
    if (opts.lastReview?.id === comment.id) continue;
    extras.push({
      kind: "comment",
      id: comment.id,
      createdAt: comment.created_at ?? "",
      text: `### Comment ${comment.id} by ${comment.user?.login ?? "unknown"}\n\n${comment.body}\n`,
    });
  }
  for (const comment of opts.inlines) {
    extras.push({
      kind: "inline",
      id: comment.id,
      createdAt: comment.created_at ?? "",
      text: `### Inline ${comment.id} by ${comment.user?.login ?? "unknown"}${comment.path ? ` on ${comment.path}` : ""}\n\n${comment.body}\n`,
    });
  }
  for (const review of opts.reviews) {
    if (opts.trigger?.reviewId === review.id) continue;
    extras.push({
      kind: "review",
      id: review.id,
      createdAt: review.submitted_at ?? review.updated_at ?? review.created_at ?? "",
      text: `### Review ${review.id} by ${review.user?.login ?? "unknown"}\n\n${review.body ?? review.content ?? ""}\n`,
    });
  }
  extras.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const encoder = new TextEncoder();
  const otherHeader = "## Other comments\n\n";
  const prefix = header + triggerSection + lastReviewSection + currentInlineSection;
  const fit: FeedbackItem[] = [...extras];
  const sizeOf = (items: FeedbackItem[]) => {
    const extra = items.length ? otherHeader + items.map((item) => item.text).join("\n") : "";
    return encoder.encode(prefix + extra).byteLength;
  };
  const isJumiReviewText = (item: FeedbackItem) => item.text.includes(REVIEW_MARKER);
  while (fit.length > 0 && sizeOf(fit) > FEEDBACK_MAX_BYTES) {
    const dropIdx = fit.findIndex((item) => !isJumiReviewText(item));
    if (dropIdx >= 0) fit.splice(dropIdx, 1);
    else fit.shift();
  }

  let markdown = prefix + (fit.length ? otherHeader + fit.map((item) => item.text).join("\n") : "");
  if (encoder.encode(markdown).byteLength > FEEDBACK_MAX_BYTES) {
    markdown = markdown.slice(0, FEEDBACK_MAX_BYTES);
  }

  const commentIds = new Set<number>();
  const reviewIds = new Set<number>();
  if (opts.trigger?.commentId !== undefined) commentIds.add(opts.trigger.commentId);
  if (opts.trigger?.reviewId !== undefined) reviewIds.add(opts.trigger.reviewId);
  if (opts.lastReview && markdown.includes("## Last review")) commentIds.add(opts.lastReview.id);
  for (const item of currentInlineItems) {
    if (markdown.includes(`### Inline ${item.id}`)) commentIds.add(item.id);
  }
  for (const item of fit) {
    const marker =
      item.kind === "comment"
        ? item.text.startsWith("### Earlier review ")
          ? `### Earlier review ${item.id}`
          : `### Comment ${item.id}`
        : item.kind === "inline"
          ? `### Inline ${item.id}`
          : `### Review ${item.id}`;
    if (!markdown.includes(marker)) continue;
    if (item.kind === "review") reviewIds.add(item.id);
    else commentIds.add(item.id);
  }
  return { markdown, commentIds: [...commentIds], reviewIds: [...reviewIds] };
}

function triggerBodyFromItems(
  trigger: IssueJob["trigger"] | undefined,
  items: { comments: Comment[]; inlines: InlineComment[]; reviews: PullReview[] }
): string {
  if (!trigger) return "";
  if (typeof trigger.body === "string" && trigger.body.trim()) return trigger.body;
  if (trigger.commentId !== undefined) {
    const comment =
      items.comments.find((entry) => entry.id === trigger.commentId) ??
      items.inlines.find((entry) => entry.id === trigger.commentId);
    if (comment?.body) return comment.body;
  }
  if (trigger.reviewId !== undefined) {
    const review = items.reviews.find((entry) => entry.id === trigger.reviewId);
    if (review) return review.body ?? review.content ?? "";
  }
  return "";
}

function reviewFindingMatchOptsForJob(job: IssueJob, headSha: string): ReviewFindingMatchOpts {
  const extraHeadShas = job.headSha && job.headSha.toLowerCase() !== headSha.toLowerCase() ? [job.headSha] : undefined;
  return {
    extraHeadShas,
    anyReviewedCommit: job.trigger?.event === "review-failure",
  };
}

export async function implementFollowUp(
  opts: ImplementOptions & { sleep?: (ms: number) => Promise<void> }
): Promise<FollowUpResult> {
  const log = opts.logger ?? logDefault;
  const maxFollowupRounds = opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS;
  const maxConflictRounds = opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS;
  const timeoutMs = opts.timeoutMs ?? FOLLOWUP_TIMEOUT_MS;
  const conflictTimeoutMs = opts.conflictTimeoutMs ?? CONFLICT_TIMEOUT_MS;
  const claimed = await beginClaimedWorktree({
    ...opts,
    fallbackEngine: registeredEngine,
    forgetTerminal: true,
  });
  if (isClaimedEarlyResult(claimed)) return claimed;
  const { owner, repo, issueNumber, worktree, sanitizeEnv, engine, now, forgetClaim, claim } = claimed;
  const latches = skipLatchesFor(opts);
  const latchKey = { owner, repo, issueNumber };

  // The runner behind the latest spawn; after a hop this is the one that ran.
  let runner: RunnerStamp | undefined;
  const sticky = (body: string, index: number) =>
    upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, appendRunnerStamp(body, runner), {
      index,
    });

  const assigned = await recheckAssignedAndOpen(claimed, opts);
  if (assigned) return assigned;

  const pr = await resolveWorkerPullRequest(opts.api, owner, repo, issueNumber, opts.botUsername, opts.job.prNumber);
  if (!pr || !isEligibleWorkerPR(pr, owner, repo)) {
    await forgetClaim();
    return { status: "skipped", reason: "no open jumi closing PR" };
  }
  if (opts.job.headSha && pr.head.sha && opts.job.headSha !== pr.head.sha) {
    log(`PR head moved from ${opts.job.headSha} to ${pr.head.sha}; continuing on current head`);
  }
  const findingOpts = reviewFindingMatchOptsForJob(opts.job, pr.head.sha);

  const branch = pr.head.ref;
  claim.branch = branch;
  if (!branch || branch === opts.job.defaultBranch) {
    await forgetClaim();
    return { status: "skipped", reason: "refusing to follow up on the default branch" };
  }

  const state = await readFollowUpLatch(latches, latchKey);
  const pendingItems = await collectFollowUpItems(
    opts.api,
    owner,
    repo,
    pr.number,
    opts.botUsername,
    pr.head.sha,
    opts.followupIgnoreLogins,
    findingOpts
  );
  const pendingTriggerBody = triggerBodyFromItems(opts.job.trigger, pendingItems);
  const pendingLastReview = pickLatestJumiFinding(pendingItems, pr.head.sha);
  let hasFeedback = hasUnhandledFollowUpItems(pendingItems, state);
  const inspectOpts = {
    api: opts.api,
    owner,
    repo,
    sha: pr.head.sha,
    home: opts.home,
    issueNumber,
    skipLatches: latches,
  };
  let ci: CiInspection = { sha: pr.head.sha, pending: false, failed: [], unhandled: [], empty: true };
  try {
    ci = await inspectCi(inspectOpts);
  } catch (err) {
    log(`CI inspect failed for ${owner}/${repo}#${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ci.pending && opts.job.trigger?.event === "workflow_job") {
    try {
      await (opts.sleep ?? sleep)(CI_PENDING_RETRY_MS);
      ci = await inspectCi(inspectOpts);
    } catch (err) {
      log(`CI inspect failed for ${owner}/${repo}#${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const ciWake = !ci.pending && ci.unhandled.length > 0;
  if (
    (opts.job.trigger?.commentId !== undefined && state.handledCommentIds.includes(opts.job.trigger.commentId)) ||
    (opts.job.trigger?.reviewId !== undefined && state.handledReviewIds.includes(opts.job.trigger.reviewId))
  ) {
    if (!ciWake) {
      await forgetClaim();
      return { status: "skipped", reason: "comment already handled" };
    }
  }
  if (hasFeedback && state.round >= maxFollowupRounds) {
    if (!ciWake) {
      await sticky("stuck: too many follow-up rounds", pr.number);
      await forgetClaim();
      return { status: "skipped", reason: "stuck: too many follow-up rounds" };
    }
    hasFeedback = false;
  }
  if (!hasFeedback) {
    if (ci.pending) {
      await forgetClaim();
      return { status: "skipped", reason: "CI still pending" };
    }
    if (!ciWake) {
      await forgetClaim();
      return { status: "skipped", reason: "no unhandled feedback" };
    }
    if (ci.unhandled.every((check) => check.flake)) {
      await sticky(flakeComment(ci.unhandled), pr.number);
      await recordCiHandled({
        home: opts.home,
        owner,
        repo,
        issueNumber,
        prNumber: pr.number,
        sha: pr.head.sha,
        checks: ci.unhandled,
        now,
        skipLatches: latches,
      });
      await forgetClaim();
      return { status: "skipped", reason: flakeSkipReason(ci.unhandled) };
    }
  }
  const previousConflict = await readConflictLatch(latches, latchKey);
  if (previousConflict.round >= maxConflictRounds) {
    await sticky("stuck: cannot resolve conflicts", pr.number);
    await forgetClaim();
    return { status: "skipped", reason: "stuck: cannot resolve conflicts" };
  }

  const feedbackPreview = buildFeedbackMarkdown({
    pr,
    trigger: opts.job.trigger,
    triggerBody: pendingTriggerBody,
    comments: pendingItems.comments,
    inlines: briefInlines(pendingItems),
    reviews: pendingItems.reviews,
    lastReview: pendingLastReview,
    currentInlines: unresolvedJumiInlines(pendingItems),
  });
  const findingHash = hasFeedback ? fingerprintFollowUpText(feedbackPreview.markdown) : undefined;
  const ciHash = hasFeedback ? undefined : fingerprintCiChecks(ci.unhandled);
  const currentFingerprint = findingHash
    ? { kind: "action" as const, hash: findingHash }
    : ciHash
      ? { kind: "ci" as const, hash: ciHash }
      : undefined;
  const stuckState = await readStuckLatch(latches, latchKey);
  if (isQuotaStuck(stuckState)) {
    await sticky(QUOTA_STUCK_TEXT, pr.number);
    await forgetClaim();
    return { status: "skipped", reason: QUOTA_STUCK_TEXT };
  }
  const stuckReason = evaluateStuck(stuckState.fingerprints, currentFingerprint);
  if (stuckReason) {
    await sticky(stuckComment(stuckReason), pr.number);
    await forgetClaim();
    return { status: "skipped", reason: stuckComment(stuckReason) };
  }

  const loop = openClaimedLoop(claimed, opts);

  let handledCommentIds = [...state.handledCommentIds];
  let handledReviewIds = [...state.handledReviewIds];
  const handledReviewFindings = [...state.handledReviewFindings];
  if (opts.job.trigger?.commentId !== undefined) handledCommentIds.push(opts.job.trigger.commentId);
  if (opts.job.trigger?.reviewId !== undefined) handledReviewIds.push(opts.job.trigger.reviewId);

  let followUpEngineRan = false;
  const persistCi = async () => {
    if (!followUpEngineRan || ci.failed.length === 0) return;
    await recordCiHandled({
      home: opts.home,
      owner,
      repo,
      issueNumber,
      prNumber: pr.number,
      sha: pr.head.sha,
      checks: ci.failed,
      now,
      skipLatches: latches,
    });
  };

  const recordAttempt = async (headSha: string) => {
    const uniqueComments = [...new Set(handledCommentIds)];
    const uniqueReviews = [...new Set(handledReviewIds)];
    await writeFollowUpLatch(latches, latchKey, {
      prNumber: pr.number,
      round: hasFeedback ? state.round + 1 : state.round,
      lastHeadSha: headSha,
      handledCommentIds: uniqueComments,
      handledReviewIds: uniqueReviews,
      handledReviewFindings: uniqueReviewFindings(handledReviewFindings),
      updatedAt: now().toISOString(),
    });
    if (currentFingerprint) {
      await appendStuckLatchFingerprint(latches, latchKey, currentFingerprint, now);
    }
    await persistCi();
  };

  // After a pushed follow-up, rewrite only the jumi-owned region from JUMI_PR.md.
  // Missing/empty artifact or an unfenced body leaves the posted body alone, and
  // a forge failure here must not fail a good code fix.
  const refreshPullRequestBody = async (description: string | null) => {
    if (description == null || !description.replaceAll("\0", "").trim()) return;
    try {
      const live = await opts.api.getPR(owner, repo, pr.number);
      const body = replaceJumiPrBodyRegion(
        live.body,
        buildPullRequestBody(issueNumber, description, runner, [loop.auth.token])
      );
      if (body == null || body === live.body) return;
      await opts.api.updatePullRequestBody(owner, repo, pr.number, body);
    } catch (err) {
      log(
        `PR body refresh failed for ${owner}/${repo}#${pr.number}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  let attemptedHeadSha = "";
  let attemptedBaseSha = "";
  let prefixMergeThrew = false;

  return runClaimedLoop(
    loop,
    opts.abortSignal,
    async () => {
      await ensureBareCache(loop, {
        cloneUrl: opts.job.cloneUrl,
        giteaUrl: opts.giteaUrl,
        abortSignal: opts.abortSignal,
        log,
      });
      const attached = await attachPrWorktree(loop, {
        branch,
        defaultBranch: opts.job.defaultBranch,
        abortSignal: opts.abortSignal,
        log,
      });
      if (isClaimedEarlyResult(attached)) return attached;
      const { headSha, baseSha } = attached;
      attemptedHeadSha = headSha;
      attemptedBaseSha = baseSha;
      await loop.stampHeadSha(headSha);

      if (
        previousConflict.lastHeadSha &&
        previousConflict.lastBaseSha &&
        previousConflict.lastHeadSha === headSha &&
        previousConflict.lastBaseSha === baseSha
      ) {
        return skipClaimedWork(loop, "same head and base already attempted");
      }

      const currentIssue = await opts.api.getIssue(owner, repo, issueNumber);
      const taskJob: IssueJob = {
        ...opts.job,
        title: currentIssue.title,
        body: currentIssue.body ?? "",
        htmlUrl: currentIssue.html_url,
      };
      let mergeResult: MergeDefaultResult;
      try {
        mergeResult = await mergeDefaultIntoWorktree({
          git: loop.runConfiguredGit,
          env: loop.env,
          worktree,
          defaultBranch: opts.job.defaultBranch,
          headRef: branch,
          job: taskJob,
          pr,
          model: opts.model,
          variant: opts.variant,
          home: opts.home,
          sanitizeOpenCodeEnv: sanitizeEnv,
          extraEnv: workerOpenCodeChildEnv(loop.auth, worktree),
          maxOutputBytes: opts.maxOutputBytes,
          timeoutMs: conflictTimeoutMs,
          openCodeRunner: engine,
          helmRunner: opts.helmRunner,
          logger: log,
          abortSignal: opts.abortSignal,
          jobId: opts.jobId ?? opts.job.delivery,
          ciMarkdown: ci.failed.length ? buildCiMarkdown({ sha: pr.head.sha, checks: ci.failed }) : undefined,
          onPid: loop.engineOnPid(opts.onPid),
          onRunner: (r) => {
            runner = r;
          },
        });
      } catch (err: unknown) {
        if (isQuotaError(err)) {
          throwIfQuotaWait({
            err,
            model: opts.model,
            fallbackModel: opts.fallbackModel,
            chain: opts.chain,
            previousError: opts.previousError,
          });
          await sticky(QUOTA_STUCK_TEXT, pr.number);
          await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
          return skipClaimedWork(loop, QUOTA_STUCK_TEXT);
        }
        prefixMergeThrew = true;
        throw err;
      }
      runner = mergeResult.runner;
      const persistConflictAttempt = async (result: typeof mergeResult) => {
        if (!shouldIncrementRound(result)) return;
        await writeConflictLatch(latches, latchKey, {
          prNumber: pr.number,
          round: previousConflict.round + 1,
          lastHeadSha: result.headSha,
          lastBaseSha: result.baseSha,
          updatedAt: now().toISOString(),
        });
      };
      if (mergeResult.status === "stuck") {
        await persistConflictAttempt(mergeResult);
        await sticky("stuck: cannot resolve conflicts", pr.number);
        return skipClaimedWork(loop, "stuck: cannot resolve conflicts");
      }

      throwIfAborted(opts.abortSignal);
      await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(taskJob));
      if (hasFeedback) {
        const items = await collectFollowUpItems(
          opts.api,
          owner,
          repo,
          pr.number,
          opts.botUsername,
          pr.head.sha,
          opts.followupIgnoreLogins,
          findingOpts
        );
        const briefReview = pickLatestJumiFinding(items, pr.head.sha) ?? pendingLastReview;
        const feedback = buildFeedbackMarkdown({
          pr,
          trigger: opts.job.trigger,
          triggerBody: triggerBodyFromItems(opts.job.trigger, items),
          comments: items.comments,
          inlines: briefInlines(items),
          reviews: items.reviews,
          lastReview: briefReview,
          currentInlines: unresolvedJumiInlines(items),
          earlierReviews: earlierJumiReviews(items, briefReview),
        });
        handledCommentIds = [...handledCommentIds, ...feedback.commentIds];
        handledReviewIds = [...handledReviewIds, ...feedback.reviewIds];
        const findingById = new Map<number, HandledReviewFinding>();
        for (const comment of [...items.comments, ...items.jumiStickies]) {
          const finding = reviewFindingFromComment(comment);
          if (finding) findingById.set(finding.id, finding);
        }
        for (const review of [...items.jumiFindingReviews, ...items.jumiReviews]) {
          const finding = reviewFindingFromReview(review);
          if (finding) findingById.set(finding.id, finding);
        }
        if (briefReview) {
          const finding = reviewFindingFromComment(briefReview);
          if (finding) findingById.set(finding.id, finding);
        }
        handledCommentIds = handledCommentIds.filter((id) => {
          const finding = findingById.get(id);
          if (!finding) return true;
          handledReviewFindings.push(finding);
          return false;
        });
        await writeFile(join(worktree, "JUMI_FEEDBACK.md"), feedback.markdown);
      } else if (pendingLastReview || unresolvedJumiInlines(pendingItems).length > 0) {
        await writeFile(
          join(worktree, "JUMI_FEEDBACK.md"),
          buildFeedbackMarkdown({
            pr,
            trigger: opts.job.trigger,
            triggerBody: pendingTriggerBody,
            comments: [],
            inlines: [],
            reviews: [],
            lastReview: pendingLastReview,
            currentInlines: unresolvedJumiInlines(pendingItems),
            earlierReviews: earlierJumiReviews(pendingItems, pendingLastReview),
          }).markdown
        );
      } else {
        await writeFile(
          join(worktree, "JUMI_FEEDBACK.md"),
          "# Review feedback\n\nNo review comments this round. Address JUMI_CI.md.\n"
        );
      }
      if (ci.failed.length) {
        await writeFile(join(worktree, CI_LOG_FILE), buildCiMarkdown({ sha: pr.head.sha, checks: ci.failed }));
      }
      // Let the child edit the description already posted; only a fenced body is jumi-owned.
      const postedRegion = jumiPrBodyRegion(pr.body);
      if (postedRegion != null) {
        await writeFile(join(worktree, PR_DESCRIPTION_FILE), seedPullRequestDescription(postedRegion));
      } else {
        await rm(join(worktree, PR_DESCRIPTION_FILE), { recursive: true, force: true }).catch(() => undefined);
      }
      // No follow-up runner has spawned yet; don't carry the resolver's stamp.
      runner = undefined;
      await sticky(hasFeedback ? "Jumi is addressing review comments." : "Jumi is addressing CI failure.", pr.number);

      const runEngine = async (
        label: string,
        extra?: { continueSession?: boolean }
      ): Promise<{ status: "skipped"; reason: string } | undefined> => {
        throwIfAborted(opts.abortSignal);
        log(label);
        followUpEngineRan = true;
        const runOpts: EngineRunOptions = {
          model: opts.model,
          variant: opts.variant,
          workdir: worktree,
          home: opts.home,
          sanitizeEnv,
          extraEnv: workerOpenCodeChildEnv(loop.auth, worktree),
          timeoutMs,
          maxOutputBytes: opts.maxOutputBytes,
          reviewLabel: `${owner}/${repo}#${issueNumber}`,
          trace: {
            kind: "follow-up",
            owner,
            repo,
            sha: pr.head.sha,
            jobId: opts.jobId ?? opts.job.delivery,
          },
          ...(extra?.continueSession ? { continueSession: true } : {}),
          logger: log,
          abortSignal: opts.abortSignal,
          onPid: loop.engineOnPid(opts.onPid),
        };
        runner = undefined;
        const result = await runEngineStamped(engine, runOpts, (r) => {
          runner = r;
        });
        // Gate on the message so a future non-quota `stuck` producer uses the
        // fingerprint path instead of the human-clear quota flag.
        if (result.status === "stuck" && isQuotaText(result.message)) {
          throwIfQuotaWait({
            result,
            model: opts.model,
            fallbackModel: opts.fallbackModel,
            chain: opts.chain,
            previousError: opts.previousError,
          });
          await sticky(QUOTA_STUCK_TEXT, pr.number);
          await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
          return skipClaimedWork(loop, QUOTA_STUCK_TEXT);
        }
        throwIfEngineFailed(result);
        return undefined;
      };

      const quotaFollowUp = await runEngine(
        `Running OpenCode follow-up for ${owner}/${repo}#${issueNumber} PR ${pr.number}`
      );
      if (quotaFollowUp) return quotaFollowUp;

      let gate: ShipGate;
      try {
        gate = await gateShipAfterOpenCode({
          api: opts.api,
          owner,
          repo,
          issueNumber,
          botUsername: opts.botUsername,
          snapshot: snapshotFromJob(taskJob),
          closerPrNumber: pr.number,
          continueOpenCode: async (issue) => {
            await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(jobWithIssue(taskJob, issue)));
            const quotaContinued = await runEngine(
              `Re-running OpenCode after issue change for ${owner}/${repo}#${issueNumber} PR ${pr.number}`,
              { continueSession: true }
            );
            if (quotaContinued) throw new Error(QUOTA_STUCK_TEXT);
          },
        });
      } catch (err) {
        if (isQuotaError(err)) {
          throwIfQuotaWait({
            err,
            model: opts.model,
            fallbackModel: opts.fallbackModel,
            chain: opts.chain,
            previousError: opts.previousError,
          });
          return skipClaimedWork(loop, QUOTA_STUCK_TEXT);
        }
        throw err;
      }
      if (gate.action === "skip") {
        return skipClaimedWork(loop, gate.reason, { detach: !gate.keepLocalWork });
      }

      throwIfAborted(opts.abortSignal);
      const prFileContents = await readPullRequestDescription(worktree);
      await stripSentinels(worktree, [PR_DESCRIPTION_FILE, "JUMI_TASK.md", "JUMI_FEEDBACK.md", CI_LOG_FILE]);
      const porcelain = await worktreePorcelain(loop);
      if (!porcelain && (await commitsAheadOf(loop, `origin/${branch}`)) <= 0) {
        const sha = (await loop.runConfiguredGit(["rev-parse", "HEAD"], { cwd: worktree, env: loop.env })).trim();
        await loop.stopHeartbeat();
        await sticky("no follow-up changes", pr.number);
        await recordAttempt(sha || pr.head.sha);
        await loop.forgetSerialized();
        await loop.detachWorktree();
        return { status: "no-changes" };
      }

      await commitIfDirty(loop, porcelain, `Address review on #${pr.number}: ${gate.snapshot.title}`);
      try {
        await pushClaimedBranch(loop, branch);
      } catch (err) {
        const remoteSha = await inspectMovedPrHead(loop, branch, attemptedHeadSha);
        if (remoteSha) {
          return skipClaimedWork(loop, prHeadChangedReason(opts.job.headSha || attemptedHeadSha, remoteSha));
        }
        throw err;
      }
      throwIfAborted(opts.abortSignal);
      await persistConflictAttempt(mergeResult);

      await refreshPullRequestBody(prFileContents);

      const sha = (await loop.runConfiguredGit(["rev-parse", "HEAD"], { cwd: worktree, env: loop.env })).trim();
      await sticky(`Pushed follow-up to ${pr.html_url}`, pr.number);
      await recordAttempt(sha || pr.head.sha);
      await loop.stopHeartbeat();
      await loop.forgetSerialized();
      await loop.detachWorktree();
      return { status: "pushed", prNumber: pr.number, htmlUrl: pr.html_url };
    },
    async (err) => {
      runner = thrownRunner(err) ?? runner;
      if (isQuotaError(err)) {
        throwIfQuotaWait({
          err,
          model: opts.model,
          fallbackModel: opts.fallbackModel,
          chain: opts.chain,
          previousError: opts.previousError,
        });
        await sticky(QUOTA_STUCK_TEXT, pr.number).catch(() => undefined);
        await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
        await loop.stopHeartbeat();
        await loop.forgetSerialized().catch(() => undefined);
        await loop.detachWorktree();
        return;
      }
      await sticky(
        redactGitSecrets(`Jumi failed: ${err instanceof Error ? err.message : String(err)}`, [loop.auth.token]),
        pr.number
      ).catch(() => undefined);
      const errorHash = fingerprintError(err instanceof Error ? err.message : String(err));
      if (errorHash) {
        await appendStuckLatchFingerprint(latches, latchKey, { kind: "error", hash: errorHash }, now).catch(
          () => undefined
        );
      }
      if (prefixMergeThrew && attemptedHeadSha && attemptedBaseSha) {
        await writeConflictLatch(latches, latchKey, {
          prNumber: pr.number,
          round: previousConflict.round + 1,
          lastHeadSha: attemptedHeadSha,
          lastBaseSha: attemptedBaseSha,
          updatedAt: now().toISOString(),
        }).catch(() => undefined);
      }
      await writeFollowUpLatch(latches, latchKey, {
        prNumber: pr.number,
        round: hasFeedback ? state.round + 1 : state.round,
        lastHeadSha: pr.head.sha,
        handledCommentIds: state.handledCommentIds,
        handledReviewIds: state.handledReviewIds,
        handledReviewFindings: state.handledReviewFindings,
        updatedAt: now().toISOString(),
      }).catch(() => undefined);
      await persistCi().catch(() => undefined);
      await loop.stopHeartbeat();
      await loop.forgetSerialized().catch(() => undefined);
      await loop.detachWorktree();
    }
  );
}
