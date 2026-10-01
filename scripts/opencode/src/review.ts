import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CI_ABSENT_NOTE, CI_LOOKUP_FAILED_REASON, inspectCi, reviewSkipReasonForCi } from "./ci.ts";
import { isEngineTempPath, porcelainPaths } from "./claimed_worktree.ts";
import { byteLength, formatBytes, logDiagnostic, sampleMemory } from "./diagnostics.ts";
import { type Engine, type EngineRunOptions, resolveEngine, resultRunner, throwIfEngineFailed } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import { ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { hasResumableSession, withEngineChain } from "./fallback.ts";
import { extractClosingIssueNumbers } from "./gitea_issues.ts";
import { isInfraFailure } from "./infra.ts";
import { resolvePermissions } from "./permissions.ts";
import type {
  CheckPayload,
  Comment,
  CreatePullReviewComment,
  InlineComment,
  Pull,
  PullFile,
  PullReview,
  Repo,
  ReviewApi,
  Task,
} from "./ports.ts";
import { buildIncompleteWritePrompt, buildPROpenedPrompt } from "./prompt.ts";
import { isQuotaError, isQuotaText, isQuotaWaitError, QUOTA_STUCK_TEXT } from "./quota.ts";
import { throwIfQuotaWait } from "./quota_wait.ts";
import {
  CONTRACT_PATH,
  contractEnvIssues,
  formatContractEnvIssue,
  parseContract,
  REVIEWER_LOADER_PATH,
  WORKER_LOADER_PATH,
} from "./release.ts";
import { DEFAULT_MAX_THREAD_BYTES, fitReviewThread, mapReviewThread } from "./review_context.ts";
import { findPreviousReview, isJumiReviewComment, loadReviewDelta, type ReviewDelta } from "./review_delta.ts";
import { DEFAULT_MAX_REVIEW_MD_BYTES, loadReviewMdSections } from "./review_md.ts";
import { appendRunnerStamp, formatRunnerStamp, type NamedRunner } from "./runners.ts";
import {
  GITEA_STATUS_DESCRIPTION_MAX_BYTES,
  omitOpenCodeStderr,
  truncateStatusDescription,
} from "./status_description.ts";
import {
  appendStuckFingerprint,
  clearQuotaStuck,
  evaluateStuck,
  fingerprintError,
  fingerprintReviewArtifact,
  isReviewQuotaStuck,
  markQuotaStuck,
  readStuckState,
  reviewStuckStatePath,
  stuckComment,
  upsertStuckComment,
  upsertStuckText,
} from "./stuck.ts";
import type { ReviewJob } from "./types.ts";
import {
  findingFingerprint,
  keepReviewFindingLines,
  parseReviewFindings,
  parseReviewOutput,
  stripFindingLines,
} from "./verdict.ts";
import {
  checkoutPullRequestWorkspace,
  type GitAuthResolver,
  type GitRunner,
  redactGitSecrets,
  resolveGitAuth,
  runGit,
} from "./workspace.ts";

async function logParentDiag(
  log: (message: string) => void,
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>
): Promise<void> {
  const mem = await sampleMemory(process.pid);
  logDiagnostic(log, event, {
    ...fields,
    parent_rss_bytes: mem.rssBytes,
    parent_rss_h: formatBytes(mem.rssBytes),
    cgroup_bytes: mem.cgroupBytes,
    cgroup_h: formatBytes(mem.cgroupBytes),
  });
}

export type { ReviewApi } from "./ports.ts";

export type OpenCodeRunner = Engine;
export type WorkspacePreparer = (opts: {
  workdir: string;
  repo: Repo;
  pr: Pull;
  giteaUrl: string;
  username: string;
  token: string;
  embedTokenInUrl?: boolean;
  authorName?: string;
  authorEmail?: string;
  logger?: (message: string) => void;
}) => Promise<void>;

export interface ReviewOptions {
  api: ReviewApi;
  /** Tracker capability (linked-issue briefs). Defaults to `api`. A git-host adapter satisfies both. */
  tracker?: Pick<ReviewApi, "getIssue" | "listIssueComments"> | ReviewApi;
  /** Forge capability (PR + status). Defaults to `api`. A git-host adapter satisfies both. */
  forge?: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadSha?: string;
  model: string;
  variant?: string;
  fallbackModel?: string;
  fallbackVariant?: string;
  chain?: NamedRunner[];
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  workspace: string;
  giteaUrl: string;
  giteaToken: string;
  botUsername: string;
  gitAuthResolver?: GitAuthResolver;
  home?: string;
  sanitizeOpenCodeEnv?: boolean;
  timeoutMs?: number;
  maxFiles?: number;
  maxPatchBytes?: number;
  maxThreadBytes?: number;
  /** Byte budget for the head's REVIEW.md sections pasted into the prompt. */
  maxReviewMdBytes?: number;
  maxOutputBytes?: number;
  engine?: Engine;
  openCodeRunner?: Engine;
  workspacePreparer?: WorkspacePreparer;
  gitRunner?: GitRunner;
  logger?: (message: string) => void;
  persistResult?: (result: PersistReviewResult) => Promise<void>;
  abortSignal?: AbortSignal;
  jobId?: string;
  maxIncompleteRetries?: number;
  /** Wait before the single CI re-list when the first look finds no checks or a lookup failed. */
  ciRelistDelayMs?: number;
  /** When false, the caller already applied `skipReasonForOtherChecks`. */
  inspectOtherChecks?: boolean;
  /** Prepended to the review when the lookup budget expired with no checks at all. */
  noCiNote?: string;
  /** Previous job error (e.g. quota-wait marker) for the wait-budget decision. */
  previousError?: string | null;
}

export type PersistReviewResult =
  | { kind: "markdown"; markdown: string; runner?: string }
  | { kind: "skip"; reason: string }
  | { kind: "error"; error: string };

export interface ReviewResult {
  status: "posted" | "updated" | "skipped";
  reason?: string;
  commentId?: number;
}

export interface PublishReviewOptions {
  api: ReviewApi;
  forge?: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
  botUsername: string;
  resultMarkdown?: string | null;
  resultReason?: string | null;
  /** Formatted stamp for the runner that produced `resultMarkdown`. */
  resultRunner?: string | null;
  error?: string | null;
  logger?: (message: string) => void;
}

const encoder = new TextEncoder();

function defaultLog(message: string) {
  console.log(`[review] ${message}`);
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const err = new Error("cancelled");
  err.name = "AbortError";
  throw err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "cancelled");
}

export function reviewJobKey(job: ReviewJob): string {
  return `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`;
}

function markerFor(owner: string, repo: string, prNumber: number): string {
  return `<!-- jumi-review:${owner}/${repo}#${prNumber} -->`;
}

function buildCommentBody(
  marker: string,
  headSha: string,
  output: string,
  checkLine?: string,
  runner?: string | null
): string {
  const body = appendRunnerStamp(
    `${marker}\n### Jumi review\n\nReviewed commit: \`${headSha}\`\n\n${output.trim()}`,
    runner ?? undefined
  );
  if (!checkLine) return body;
  return `${body.trimEnd()}\n\n${checkLine}`;
}

function needsSingleFilePath(text: string): boolean {
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
    if (/^L\d+:\s+\S/.test(line)) return true;
  }
  return false;
}

async function resolveSingleFilePath(
  api: ReviewApi,
  owner: string,
  repo: string,
  prNumber: number,
  log: (message: string) => void
): Promise<string | undefined> {
  try {
    const files = await api.getPRFiles(owner, repo, prNumber);
    const names = [...new Set(files.map((file) => file.filename).filter((name) => typeof name === "string" && name))];
    if (names.length === 1) return names[0];
  } catch (err) {
    log(`inline single-file path unavailable: ${errorMessage(err)}`);
  }
  return undefined;
}

function isPendingPullReview(review: PullReview): boolean {
  const blob = `${review.state ?? ""} ${review.type ?? ""}`.toLowerCase();
  return blob.includes("pending");
}

function isBotPullReview(review: PullReview, botUsername: string): boolean {
  const login = review.user?.login;
  if (!login) return false;
  return login.toLowerCase() === botUsername.toLowerCase();
}

type PullReviewEvent = "APPROVED" | "REQUEST_CHANGES" | "COMMENT";

function loginEquals(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

function reviewEventForVerdict(
  state: "success" | "failure",
  prAuthor: string | undefined,
  botUsername: string
): PullReviewEvent {
  if (loginEquals(prAuthor, botUsername)) return "COMMENT";
  return state === "success" ? "APPROVED" : "REQUEST_CHANGES";
}

function isSelfReviewRejection(err: unknown, prAuthor: string | undefined, botUsername: string): boolean {
  if (loginEquals(prAuthor, botUsername)) return true;
  const message = errorMessage(err).toLowerCase();
  return /own pull|not allowed to (?:approve|reject|review)|author of (?:the )?pull|poster of (?:the )?pull/.test(
    message
  );
}

function isResolvedInline(comment: InlineComment): boolean {
  return comment.resolved === true || comment.resolver != null;
}

function commentFingerprint(comment: { path?: string; body?: string | null }, marker: string): string | undefined {
  if (!comment.path) return undefined;
  if (!(comment.body ?? "").includes(marker)) return undefined;
  const text = findingFingerprint(comment.path, comment.body ?? "");
  return text.endsWith("\n") ? undefined : text;
}

function isPendingInline(comment: InlineComment, reviews: PullReview[]): boolean {
  const reviewId = comment.pull_request_review_id;
  if (reviewId == null) return false;
  const review = reviews.find((item) => item.id === reviewId);
  return review != null && isPendingPullReview(review);
}

async function submitPendingBotReviews(opts: {
  api: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  marker: string;
  botUsername: string;
  log: (message: string) => void;
}): Promise<boolean> {
  let submitted = false;
  try {
    const reviews = await opts.api.listPullReviews(opts.owner, opts.repo, opts.prNumber);
    for (const review of reviews) {
      if (!isPendingPullReview(review) || !isBotPullReview(review, opts.botUsername)) continue;
      try {
        await opts.api.submitPullReview(opts.owner, opts.repo, opts.prNumber, review.id, opts.marker);
        submitted = true;
      } catch (err) {
        opts.log(`pending review ${review.id} not submitted: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    opts.log(`pending reviews unavailable: ${errorMessage(err)}`);
  }
  return submitted;
}

async function submitPendingAndRefreshPosted(
  opts: {
    api: ReviewApi;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    marker: string;
    botUsername: string;
    log: (message: string) => void;
  },
  posted: Set<string>,
  attempted: CreatePullReviewComment[],
  existingIds: Set<number>
): Promise<void> {
  const submitted = await submitPendingBotReviews(opts);

  let leftover: InlineComment[] = [];
  try {
    leftover = await opts.api.listPullReviewComments(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing inlines unavailable: ${errorMessage(err)}`);
  }
  let reviews: PullReview[] = [];
  try {
    reviews = await opts.api.listPullReviews(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing reviews unavailable: ${errorMessage(err)}`);
  }

  for (const key of leftoverAttemptedFingerprints(leftover, attempted, opts.marker, existingIds, reviews, submitted)) {
    posted.add(key);
  }
}

async function reconcileReviewInlines(opts: {
  api: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  marker: string;
  findings: Array<{ path: string; body: string }>;
  existing: InlineComment[];
  reviews: PullReview[];
  log: (message: string) => void;
}): Promise<Set<string>> {
  const current = new Set(opts.findings.map((finding) => findingFingerprint(finding.path, finding.body)));
  const byFingerprint = new Map<string, InlineComment[]>();
  for (const comment of opts.existing) {
    const fingerprint = commentFingerprint(comment, opts.marker);
    if (!fingerprint) continue;
    const list = byFingerprint.get(fingerprint) ?? [];
    list.push(comment);
    byFingerprint.set(fingerprint, list);
  }

  const open = new Set<string>();
  for (const [fingerprint, comments] of byFingerprint) {
    const published = comments.filter((comment) => !isPendingInline(comment, opts.reviews));
    const unresolved = published.filter((comment) => !isResolvedInline(comment));
    if (!current.has(fingerprint)) {
      for (const comment of comments.filter((item) => !isResolvedInline(item))) {
        try {
          await opts.api.resolvePullComment(opts.owner, opts.repo, comment.id);
        } catch (err) {
          opts.log(`resolve skipped ${comment.id}: ${errorMessage(err)}`);
        }
      }
      continue;
    }
    if (unresolved.length > 0) {
      open.add(fingerprint);
      continue;
    }
    if (published.length === 0) continue;
    const latest = published[published.length - 1];
    try {
      await opts.api.unresolvePullComment(opts.owner, opts.repo, latest.id);
      open.add(fingerprint);
    } catch (err) {
      opts.log(`unresolve skipped ${latest.id}: ${errorMessage(err)}`);
    }
  }
  return open;
}

async function postPullReview(opts: {
  api: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  marker: string;
  comment: string;
  botUsername: string;
  prAuthor: string | undefined;
  event: PullReviewEvent;
  body: string;
  checkLine?: string;
  runner?: string | null;
  singleFilePath?: string;
  log: (message: string) => void;
}): Promise<boolean> {
  const findings = parseReviewFindings(opts.comment, { singleFilePath: opts.singleFilePath });

  await submitPendingBotReviews(opts);

  let existing: InlineComment[] = [];
  try {
    existing = await opts.api.listPullReviewComments(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing inlines unavailable: ${errorMessage(err)}`);
  }
  let reviews: PullReview[] = [];
  try {
    reviews = await opts.api.listPullReviews(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing reviews unavailable: ${errorMessage(err)}`);
  }
  const existingIds = new Set(existing.map((comment) => comment.id));

  const posted = await reconcileReviewInlines({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.prNumber,
    marker: opts.marker,
    findings,
    existing,
    reviews,
    log: opts.log,
  });

  const comments: CreatePullReviewComment[] = [];
  const queued = new Set<string>();
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding.path, finding.body);
    if (posted.has(fingerprint) || queued.has(fingerprint)) continue;
    queued.add(fingerprint);
    comments.push({
      path: finding.path,
      new_position: finding.line,
      body: `${finding.body}\n\n${opts.marker}`,
    });
  }

  const create = (event: PullReviewEvent, reviewComments: CreatePullReviewComment[], reviewBody = opts.body) =>
    opts.api.createPullReview(opts.owner, opts.repo, opts.prNumber, {
      commit_id: opts.headSha,
      event,
      ...(reviewBody ? { body: reviewBody } : {}),
      ...(reviewComments.length > 0 ? { comments: reviewComments } : {}),
    });

  const createWithFallback = async (
    event: PullReviewEvent,
    reviewComments: CreatePullReviewComment[],
    reviewBody?: string
  ): Promise<PullReviewEvent> => {
    const post = (ev: PullReviewEvent) =>
      reviewBody === undefined ? create(ev, reviewComments) : create(ev, reviewComments, reviewBody);
    try {
      await post(event);
      return event;
    } catch (err) {
      if (event !== "COMMENT" && isSelfReviewRejection(err, opts.prAuthor, opts.botUsername)) {
        opts.log(`review event ${event} rejected as self-review, falling back to COMMENT`);
        await post("COMMENT");
        return "COMMENT";
      }
      throw err;
    }
  };

  try {
    await createWithFallback(opts.event, comments);
    return true;
  } catch (err) {
    if (comments.length === 0) {
      opts.log(`review event skipped: ${errorMessage(err)}`);
      return false;
    }
    opts.log(`batch inlines rejected, retrying individually: ${errorMessage(err)}`);
    await submitPendingAndRefreshPosted(opts, posted, comments, existingIds);
    for (const comment of comments) {
      const fingerprint = commentFingerprint(comment, opts.marker);
      if (fingerprint && posted.has(fingerprint)) continue;
      try {
        await create("COMMENT", [comment], "");
        if (fingerprint) posted.add(fingerprint);
      } catch (inner) {
        await submitPendingAndRefreshPosted(opts, posted, comments, existingIds);
        if (fingerprint && posted.has(fingerprint)) continue;
        opts.log(`inline skipped ${comment.path}:${comment.new_position}: ${errorMessage(inner)}`);
      }
    }
    try {
      await createWithFallback(
        opts.event,
        [],
        buildCommentBody(
          opts.marker,
          opts.headSha,
          stripFindingLines(opts.comment, { singleFilePath: opts.singleFilePath, posted }),
          opts.checkLine,
          opts.runner
        )
      );
      return true;
    } catch (eventErr) {
      opts.log(`review event skipped: ${errorMessage(eventErr)}`);
      return false;
    }
  }
}

function leftoverAttemptedFingerprints(
  comments: InlineComment[],
  attempted: CreatePullReviewComment[],
  marker: string,
  existingIds: Set<number>,
  reviews: PullReview[],
  submitted: boolean
): Set<string> {
  const attemptedKeys = new Set(
    attempted.flatMap((comment) => {
      const key = commentFingerprint(comment, marker);
      return key ? [key] : [];
    })
  );
  return new Set(
    comments.flatMap((comment) => {
      if (existingIds.has(comment.id)) return [];
      const key = commentFingerprint(comment, marker);
      if (!key || !attemptedKeys.has(key)) return [];
      if (submitted) return [key];
      const reviewId = comment.pull_request_review_id;
      const review = reviewId == null ? undefined : reviews.find((item) => item.id === reviewId);
      if (review && !isPendingPullReview(review)) return [key];
      return [];
    })
  );
}

const CHECK_CONTEXT = "jumi/opencode-review";
const REVIEW_ARTIFACT = "JUMI_REVIEW.md";
const DEFAULT_MAX_OUTPUT_BYTES = 80_000;
export const MAX_INCOMPLETE_RETRIES = 2;
export const INCOMPLETE_REVIEW_STUCK = "stuck: incomplete review";

function porcelainAllowsOnlyReviewArtifact(porcelain: string): boolean {
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (porcelainPaths(line).some((path) => path !== REVIEW_ARTIFACT && !isEngineTempPath(path))) return false;
  }
  return true;
}

function porcelainIncludesReviewArtifact(porcelain: string): boolean {
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (porcelainPaths(line).some((path) => path === REVIEW_ARTIFACT)) return true;
  }
  return false;
}

type ReviewArtifactRead = { status: "ok"; content: string } | { status: "missing" } | { status: "too_large" };

async function readReviewArtifact(worktree: string, maxOutputBytes: number): Promise<ReviewArtifactRead> {
  const path = join(worktree, REVIEW_ARTIFACT);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { status: "missing" };
    if (info.size > maxOutputBytes) return { status: "too_large" };
    return { status: "ok", content: await readFile(path, "utf8") };
  } catch {
    return { status: "missing" };
  }
}

function statusDescription(description: string): string {
  return truncateStatusDescription(omitOpenCodeStderr(description), {
    maxBytes: GITEA_STATUS_DESCRIPTION_MAX_BYTES,
  });
}

async function postReviewStatus(
  api: ReviewApi,
  owner: string,
  repo: string,
  headSha: string,
  state: CheckPayload["state"],
  description: string,
  targetUrl?: string
): Promise<void> {
  await api.createCommitStatus(owner, repo, headSha, {
    state,
    context: CHECK_CONTEXT,
    description: statusDescription(description),
    target_url: targetUrl,
  });
}

function statusDescriptionForSkip(result: ReviewResult): string {
  return `Jumi review skipped: ${result.reason ?? "not needed"}`;
}

function statusForResult(
  result: ReviewResult,
  verdict?: { state: CheckPayload["state"]; description: string }
): { state: CheckPayload["state"]; description: string } {
  if (result.status === "skipped") {
    if (result.reason?.startsWith("Incomplete review:")) {
      return { state: "failure", description: result.reason };
    }
    return { state: "warning", description: statusDescriptionForSkip(result) };
  }

  return verdict ?? parseReviewOutput("").verdict;
}

export function isPersonalJumiRepo(owner: string, repo: string): boolean {
  return owner === "personal" && repo === "jumi";
}

export function applyContractEnvGate(markdown: string, findings: string[]): string {
  if (findings.length === 0) return markdown;
  const parsed = parseReviewOutput(markdown);
  const lines = findings.map((finding) => `deploy/contract.md:1: 🟡 risk: ${finding}.`);
  const comment = [parsed.comment.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
  return `${comment}\n<!-- jumi-check: failure; contract env drift -->\n`;
}

async function gatePersonalJumiContractEnv(
  owner: string,
  repo: string,
  workspace: string,
  markdown: string
): Promise<string> {
  if (!isPersonalJumiRepo(owner, repo)) return markdown;
  try {
    const [contractMd, reviewerSrc, workerSrc] = await Promise.all([
      readFile(join(workspace, CONTRACT_PATH), "utf8"),
      readFile(join(workspace, REVIEWER_LOADER_PATH), "utf8"),
      readFile(join(workspace, WORKER_LOADER_PATH), "utf8"),
    ]);
    const issues = contractEnvIssues(parseContract(contractMd), reviewerSrc, workerSrc);
    return applyContractEnvGate(markdown, issues.map(formatContractEnvIssue));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return applyContractEnvGate(markdown, [`failed to parse loader env against deploy/contract.md: ${message}`]);
  }
}

/** The pull's author cannot push to the base repository: the review ignores it. */
export const PR_AUTHOR_CANNOT_PUSH = "PR author cannot push to the base repository";

export function skipReasonForPR(pr: Pull): string | undefined {
  if (pr.state !== "open") return `PR is ${pr.state}`;
  if (pr.merged) return "PR is already merged";
  if (/^\s*(wip|\[wip\])/i.test(pr.title)) {
    return "PR title disables review";
  }
}

/** Production wait before the one CI re-list; tests default to no wait. */
export const CI_RELIST_DELAY_MS = 5_000;

export async function skipReasonForOtherChecks(
  opts: Pick<ReviewOptions, "api" | "owner" | "repo" | "prNumber" | "home" | "abortSignal" | "ciRelistDelayMs"> & {
    relist?: boolean;
  },
  sha: string,
  log: (message: string) => void
): Promise<string | undefined> {
  const inspectOpts = {
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    sha,
    home: opts.home ?? "",
    issueNumber: opts.prNumber,
  };
  try {
    let ci = await inspectCi(inspectOpts);
    if ((ci.empty || ci.lookupFailed) && opts.relist !== false) {
      // Actions may not have created the push's jobs yet, or a list call blipped;
      // give it one short beat, then re-list once. Still no checks is not green:
      // the engine waits on the CI lookup budget, then reviews and says so.
      await delay(opts.ciRelistDelayMs ?? 0, opts.abortSignal);
      ci = await inspectCi(inspectOpts);
    }
    return reviewSkipReasonForCi(ci);
  } catch (err) {
    if (isAbortError(err) || opts.abortSignal?.aborted) throw err;
    log(`CI inspect failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
    return CI_LOOKUP_FAILED_REASON;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function skipReasonForHeadChange(pr: Pull, expectedHeadSha: string): string | undefined {
  if (pr.head.sha === expectedHeadSha) return undefined;
  return `PR head changed from ${expectedHeadSha} to ${pr.head.sha}`;
}

export function isTerminalSkipReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.startsWith("Incomplete review:") || reason.startsWith("PR head changed from ");
}

function prepareFiles(
  files: PullFile[],
  maxFiles: number,
  maxPatchBytes: number
): { files: PullFile[]; notes: string[] } {
  const notes: string[] = [];
  const selected = files.slice(0, maxFiles);
  if (files.length > selected.length) {
    notes.push(`Only the first ${selected.length} of ${files.length} changed files are included.`);
  }

  let remainingPatchBytes = maxPatchBytes;
  const prepared = selected.map((file) => {
    if (!file.patch) return file;
    const patchBytes = byteLength(file.patch);
    if (patchBytes <= remainingPatchBytes) {
      remainingPatchBytes -= patchBytes;
      return file;
    }

    if (remainingPatchBytes <= 0) {
      notes.push(`Patch for ${file.filename} was omitted because the patch budget was exhausted.`);
      return { ...file, patch: undefined };
    }

    const truncated = new TextDecoder().decode(encoder.encode(file.patch).slice(0, remainingPatchBytes));
    notes.push(`Patch for ${file.filename} was truncated to fit the patch budget.`);
    remainingPatchBytes = 0;
    return { ...file, patch: `${truncated}\n[patch truncated]` };
  });

  return { files: prepared, notes };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadPrComments(
  api: ReviewApi,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ comments: Comment[]; note?: string }> {
  try {
    return { comments: await api.listIssueComments(owner, repo, prNumber) };
  } catch (err) {
    return { comments: [], note: `Failed to load PR comments: ${errorMessage(err)}` };
  }
}

async function loadLinkedIssue(
  api: Pick<ReviewApi, "getIssue" | "listIssueComments">,
  owner: string,
  repo: string,
  id: number
): Promise<{ issue: Task; comments: Comment[] } | { note: string }> {
  try {
    const [issue, comments] = await Promise.all([
      api.getIssue(owner, repo, id),
      api.listIssueComments(owner, repo, id),
    ]);
    return { issue, comments };
  } catch (err) {
    return { note: `Failed to load linked issue #${id}: ${errorMessage(err)}` };
  }
}

async function resolveThreadPermissions(
  api: ReviewApi,
  owner: string,
  repo: string,
  prComments: Comment[],
  linkedIssues: Array<{ issue: Task; comments: Comment[] }>,
  log: (message: string) => void
): Promise<{
  permissions: Map<string, boolean>;
  permissionDetail: Map<string, string>;
  lookups: number;
  failures: number;
}> {
  const logins: Array<string | undefined> = [];
  for (const comment of prComments) logins.push(comment.user?.login);
  for (const linked of linkedIssues) {
    for (const comment of linked.comments) logins.push(comment.user?.login);
  }
  let detail: Map<string, string>;
  let writes: Map<string, boolean>;
  let lookups = 0;
  let failures = 0;
  try {
    const resolved = await resolvePermissions(api, owner, repo, logins);
    detail = resolved.detail;
    writes = resolved.writes;
    lookups = resolved.lookups;
    failures = resolved.failures;
    if (failures > 0) {
      const sample = resolved.sampleError ? ` (sample: ${resolved.sampleError.slice(0, 240)})` : "";
      log(`comment permissions: ${failures}/${lookups} lookups failed, treating failures as discussion${sample}`);
    }
  } catch (err) {
    log(`comment permissions unavailable, treating thread as discussion: ${errorMessage(err)}`);
    detail = new Map();
    writes = new Map();
    const seen = new Set<string>();
    for (const login of logins) {
      if (typeof login !== "string" || !login.trim()) continue;
      seen.add(login.trim().toLowerCase());
    }
    lookups = seen.size;
    failures = seen.size;
  }
  const permissions = new Map<string, boolean>(writes);
  // Fail-closed for logins the forge could not report: missing entries are discussion.
  for (const login of logins) {
    if (typeof login !== "string" || !login.trim()) continue;
    const key = login.trim().toLowerCase();
    if (!permissions.has(key)) {
      permissions.set(key, false);
      if (!detail.has(key)) detail.set(key, "none");
    }
  }
  return { permissions, permissionDetail: detail, lookups, failures };
}

export async function publishReviewResult(opts: PublishReviewOptions): Promise<ReviewResult> {
  const log = opts.logger ?? defaultLog;
  const forgeApi = opts.forge ?? opts.api;
  const pr = await forgeApi.getPR(opts.owner, opts.repo, opts.prNumber);
  const reviewLabel = `${opts.owner}/${opts.repo}#${opts.prNumber}`;
  const skipReason = skipReasonForPR(pr) ?? skipReasonForHeadChange(pr, opts.expectedHeadSha);
  if (skipReason) {
    const result: ReviewResult = { status: "skipped", reason: skipReason };
    const { state, description } = statusForResult(result);
    await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
    return result;
  }

  if (opts.error && !opts.resultMarkdown) {
    await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, "failure", opts.error, pr.html_url);
    return { status: "skipped", reason: opts.error };
  }

  if (!opts.resultMarkdown) {
    const reason = opts.resultReason ?? "Incomplete review: no output";
    const result: ReviewResult = { status: "skipped", reason };
    if (reason === "Incomplete review: no output") {
      await upsertStuckText(forgeApi, opts.owner, opts.repo, pr.number, opts.botUsername, INCOMPLETE_REVIEW_STUCK);
    }
    const { state, description } = statusForResult(result);
    await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
    return result;
  }

  const marker = markerFor(opts.owner, opts.repo, pr.number);
  const parsed = parseReviewOutput(opts.resultMarkdown);
  const singleFilePath = needsSingleFilePath(parsed.comment)
    ? await resolveSingleFilePath(forgeApi, opts.owner, opts.repo, pr.number, log)
    : undefined;
  // Publish finding lines and the trailer only; the child's tour is not published.
  const comment = keepReviewFindingLines(parsed.comment, { singleFilePath, keep: [CI_ABSENT_NOTE] });
  const writeup = buildCommentBody(
    marker,
    opts.expectedHeadSha,
    stripFindingLines(comment, { singleFilePath }),
    parsed.checkLine,
    opts.resultRunner
  );
  const stickyBody = buildCommentBody(marker, opts.expectedHeadSha, comment, parsed.checkLine, opts.resultRunner);

  let result: ReviewResult | undefined;
  if (!parsed.verdict.incomplete) {
    try {
      const landed = await postPullReview({
        api: forgeApi,
        owner: opts.owner,
        repo: opts.repo,
        prNumber: pr.number,
        headSha: opts.expectedHeadSha,
        marker,
        comment,
        botUsername: opts.botUsername,
        prAuthor: pr.user?.login,
        event: reviewEventForVerdict(parsed.verdict.state, pr.user?.login, opts.botUsername),
        body: writeup,
        checkLine: parsed.checkLine,
        runner: opts.resultRunner,
        singleFilePath,
        log,
      });
      if (landed) result = { status: "posted" };
    } catch (err) {
      log(`pull review not posted: ${errorMessage(err)}`);
    }
  }

  if (!result) {
    await logParentDiag(log, "post_find_sticky", {
      review: reviewLabel,
      body_bytes: byteLength(stickyBody),
      body_bytes_h: formatBytes(byteLength(stickyBody)),
    });
    const existing = await forgeApi.findStickyIssueComment(opts.owner, opts.repo, pr.number, opts.botUsername, marker);
    await logParentDiag(log, "post_sticky_result", {
      review: reviewLabel,
      sticky_id: existing?.id ?? null,
      sticky_found: Boolean(existing),
    });
    if (existing) {
      await logParentDiag(log, "post_comment_update", { review: reviewLabel, sticky_id: existing.id });
      const updated = await forgeApi.updateIssueComment(opts.owner, opts.repo, existing.id, stickyBody);
      result = { status: "updated", commentId: updated.id };
    } else {
      await logParentDiag(log, "post_comment_create", { review: reviewLabel });
      const created = await forgeApi.createIssueComment(opts.owner, opts.repo, pr.number, stickyBody);
      result = { status: "posted", commentId: created.id };
    }
  }

  const { state, description } = statusForResult(result, parsed.verdict);
  await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
  await logParentDiag(log, "post_review_done", { review: reviewLabel, status: result.status });
  return result;
}

export async function reviewPullRequest(opts: ReviewOptions): Promise<ReviewResult> {
  const log = opts.logger ?? defaultLog;
  const trackerApi = opts.tracker ?? opts.api;
  const forgeApi = opts.forge ?? opts.api;
  const engine = withEngineChain(resolveEngine(opts, registeredEngine), {
    chain: opts.chain,
    fallbackModel: opts.fallbackModel,
    fallbackVariant: opts.fallbackVariant,
    remainingLeaseMs: opts.remainingLeaseMs,
    extendLease: opts.extendLease,
    logger: log,
  });
  throwIfAborted(opts.abortSignal);
  const repoFullName = `${opts.owner}/${opts.repo}`;
  const pr = await forgeApi.getPR(opts.owner, opts.repo, opts.prNumber);
  const reviewedHeadSha = opts.expectedHeadSha ?? pr.head.sha;

  const initialSkipReason = skipReasonForPR(pr) ?? skipReasonForHeadChange(pr, reviewedHeadSha);
  if (initialSkipReason) return { status: "skipped", reason: initialSkipReason };

  if (opts.home) {
    const stuckPath = reviewStuckStatePath(opts.home, opts.owner, opts.repo, opts.prNumber);
    const stuckState = await readStuckState(stuckPath);
    // Reviewer quota uses a TTL (not permanent like the worker flag): quota
    // resets in hours/days, and nothing else clears this per-PR file, so an
    // expired flag re-checks instead of blocking the PR forever. Use
    // `cancelReviewWork` (deleteReviewStuckState) as the human kill-switch
    // equivalent to the worker cancel path.
    if (isReviewQuotaStuck(stuckState)) {
      await opts.persistResult?.({ kind: "skip", reason: QUOTA_STUCK_TEXT });
      await upsertStuckText(forgeApi, opts.owner, opts.repo, opts.prNumber, opts.botUsername, QUOTA_STUCK_TEXT);
      return { status: "skipped", reason: QUOTA_STUCK_TEXT };
    }
    if (stuckState.quota) {
      // Expired quota: clear the stale flag so the next run starts clean.
      await clearQuotaStuck(stuckPath).catch(() => undefined);
    }
    const stuckReason = evaluateStuck(stuckState.fingerprints);
    if (stuckReason) {
      await opts.persistResult?.({ kind: "skip", reason: stuckComment(stuckReason) });
      await upsertStuckComment(forgeApi, opts.owner, opts.repo, opts.prNumber, opts.botUsername, stuckReason);
      return { status: "skipped", reason: stuckComment(stuckReason) };
    }
  }

  if (opts.inspectOtherChecks !== false) {
    const ciSkip = await skipReasonForOtherChecks({ ...opts, api: forgeApi }, reviewedHeadSha, log);
    if (ciSkip) return { status: "skipped", reason: ciSkip };
  }

  await postReviewStatus(
    forgeApi,
    opts.owner,
    opts.repo,
    reviewedHeadSha,
    "pending",
    "Jumi review is running",
    pr.html_url
  );

  let persisted = false;
  let persistFailed = false;
  const failureSecrets: string[] = [opts.giteaToken];
  const persistOutcome = async (result: PersistReviewResult): Promise<void> => {
    if (!opts.persistResult) return;
    try {
      await opts.persistResult(result);
      persisted = true;
    } catch (err) {
      persistFailed = true;
      throw err;
    }
  };
  try {
    log(`Fetching ${repoFullName}#${pr.number} files`);
    const [repoInfo, prFiles, prCommentResult, prReviews, prInlines] = await Promise.all([
      forgeApi.getRepo(opts.owner, opts.repo),
      forgeApi.getPRFiles(opts.owner, opts.repo, pr.number),
      loadPrComments(forgeApi, opts.owner, opts.repo, pr.number),
      forgeApi.listPullReviews(opts.owner, opts.repo, pr.number).catch((err: unknown): PullReview[] => {
        log(`previous reviews unavailable: ${errorMessage(err)}`);
        return [];
      }),
      forgeApi.listPullReviewComments(opts.owner, opts.repo, pr.number).catch((err: unknown): InlineComment[] => {
        log(`previous inlines unavailable: ${errorMessage(err)}`);
        return [];
      }),
    ]);
    const previousReview = findPreviousReview({
      comments: prCommentResult.comments,
      reviews: prReviews,
      inlines: prInlines,
      botUsername: opts.botUsername,
      marker: markerFor(opts.owner, opts.repo, pr.number),
    });

    const ids = extractClosingIssueNumbers(pr);
    const linkedResults = await Promise.all(ids.map((id) => loadLinkedIssue(trackerApi, opts.owner, opts.repo, id)));
    const notes: string[] = [];
    if (opts.noCiNote) notes.push(`${opts.noCiNote} Mention it in the review. It is not a finding.`);
    if (prCommentResult.note) notes.push(prCommentResult.note);
    const linkedIssues: Array<{ issue: Task; comments: Comment[] }> = [];
    for (const result of linkedResults) {
      if ("note" in result) {
        notes.push(result.note);
        continue;
      }
      linkedIssues.push({ issue: result.issue, comments: result.comments });
    }
    const prComments = prCommentResult.comments;
    const {
      permissions,
      permissionDetail,
      lookups: permissionLookups,
      failures: permissionFailures,
    } = await resolveThreadPermissions(forgeApi, opts.owner, opts.repo, prComments, linkedIssues, log);
    const thread = mapReviewThread({ prComments, linkedIssues, permissions, permissionDetail });

    const maxFiles = opts.maxFiles ?? 100;
    const maxPatchBytes = opts.maxPatchBytes ?? 500_000;
    const maxThreadBytes = opts.maxThreadBytes ?? DEFAULT_MAX_THREAD_BYTES;
    const rawPatchBytes = prFiles.reduce((sum, file) => sum + (file.patch ? byteLength(file.patch) : 0), 0);
    const { files, notes: fileNotes } = prepareFiles(prFiles, maxFiles, maxPatchBytes);
    const includedPatchBytes = files.reduce((sum, file) => sum + (file.patch ? byteLength(file.patch) : 0), 0);
    const reviewLabel = `${repoFullName}#${pr.number}`;

    logDiagnostic(log, "review_files", {
      review: reviewLabel,
      head: reviewedHeadSha,
      files_total: prFiles.length,
      files_included: files.length,
      max_files: maxFiles,
      raw_patch_bytes: rawPatchBytes,
      raw_patch_bytes_h: formatBytes(rawPatchBytes),
      included_patch_bytes: includedPatchBytes,
      included_patch_bytes_h: formatBytes(includedPatchBytes),
      max_patch_bytes: maxPatchBytes,
      notes: notes.length + fileNotes.length,
    });

    const prepareWorkspace = opts.workspacePreparer ?? checkoutPullRequestWorkspace;
    const gitAuth = await resolveGitAuth(opts);
    failureSecrets.push(gitAuth.token);
    await prepareWorkspace({
      workdir: opts.workspace,
      repo: repoInfo,
      pr,
      giteaUrl: opts.giteaUrl,
      username: gitAuth.username,
      token: gitAuth.token,
      embedTokenInUrl: gitAuth.embedTokenInUrl,
      authorName: gitAuth.authorName,
      authorEmail: gitAuth.authorEmail,
      logger: log,
    });

    const git = opts.gitRunner ?? runGit;
    const gitCmdEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      GIT_TERMINAL_PROMPT: "0",
    };

    let delta: ReviewDelta | undefined;
    let scopeNotes = fileNotes;
    if (previousReview) {
      const loaded = await loadReviewDelta({
        previous: previousReview,
        headSha: reviewedHeadSha,
        pullFiles: prFiles,
        git,
        cwd: opts.workspace,
        env: gitCmdEnv,
        log,
      });
      if (loaded) {
        const { files: deltaFiles, notes: deltaNotes } = prepareFiles(loaded.files, maxFiles, maxPatchBytes);
        delta = { ...loaded, files: deltaFiles };
        scopeNotes =
          prFiles.length > maxFiles
            ? [`Only the first ${maxFiles} of ${prFiles.length} changed files are listed.`, ...deltaNotes]
            : deltaNotes;
      }
    }
    // A later review gets the finding lines, not the previous essay. Drop it
    // before fitting so it does not use up the thread budget.
    const fitted = fitReviewThread(
      delta
        ? {
            ...thread,
            comments: thread.comments.filter(
              (comment) =>
                !isJumiReviewComment({ body: comment.body, user: { login: comment.author } }, opts.botUsername)
            ),
          }
        : thread,
      maxThreadBytes
    );
    if (fitted.truncated) {
      notes.push(`Thread context truncated to maxThreadBytes (dropped ${fitted.droppedCommentBodies} comment bodies).`);
    }
    notes.push(...scopeNotes);
    const allFittedComments = [
      ...fitted.thread.comments,
      ...fitted.thread.linkedIssues.flatMap((issue) => issue.comments),
    ];
    const productComments = allFittedComments.filter((comment) => comment.intent === "product").length;
    const discussionComments = allFittedComments.filter((comment) => comment.intent === "discussion").length;
    logDiagnostic(log, "review_thread", {
      review: reviewLabel,
      pr_comments: fitted.thread.comments.length,
      linked_issues: fitted.thread.linkedIssues.length,
      linked_issue_comments: fitted.thread.linkedIssues.reduce((sum, issue) => sum + issue.comments.length, 0),
      thread_bytes: fitted.threadBytes,
      thread_bytes_h: formatBytes(fitted.threadBytes),
      max_thread_bytes: maxThreadBytes,
      truncated: fitted.truncated,
      product_comments: productComments,
      discussion_comments: discussionComments,
      permission_lookups: permissionLookups,
      permission_failures: permissionFailures,
    });
    logDiagnostic(log, "review_delta", {
      review: reviewLabel,
      later: Boolean(delta),
      previous_sha: previousReview?.sha ?? null,
      previous_findings: delta?.findings.length ?? null,
      commits: delta?.commits.length ?? null,
      delta_files: delta?.files.length ?? null,
    });

    // The workspace is the PR head checkout, so this is the head's REVIEW.md; no base-branch fallback.
    // Match against every changed file, not only the ones that fit the patch budget.
    const reviewMd = await loadReviewMdSections(
      opts.workspace,
      prFiles,
      opts.maxReviewMdBytes ?? DEFAULT_MAX_REVIEW_MD_BYTES
    );
    logDiagnostic(log, "review_md", {
      review: reviewLabel,
      injected: Boolean(reviewMd),
      bytes: reviewMd?.bytes ?? 0,
      truncated: reviewMd?.truncated ?? false,
      path_sections: reviewMd?.pathSections ?? 0,
      matched_path_sections: reviewMd?.matchedPathSections ?? 0,
    });

    const prompt = buildPROpenedPrompt({
      repo: repoInfo,
      pr,
      prFiles: delta ? prFiles.slice(0, maxFiles) : files,
      reviewNotes: notes,
      thread: fitted.thread,
      delta,
      reviewMd,
    });

    logDiagnostic(log, "review_prompt", {
      review: reviewLabel,
      prompt_bytes: byteLength(prompt),
      prompt_bytes_h: formatBytes(byteLength(prompt)),
      model: opts.model,
    });

    let taskTracked = false;
    try {
      taskTracked =
        (await git(["ls-files", "--", "JUMI_TASK.md"], { cwd: opts.workspace, env: gitCmdEnv })).trim() !== "";
    } catch {
      taskTracked = false;
    }

    const restoreTaskFile = async () => {
      if (taskTracked) {
        await git(["checkout", "--", "JUMI_TASK.md"], { cwd: opts.workspace, env: gitCmdEnv });
      } else {
        await rm(join(opts.workspace, "JUMI_TASK.md"), { force: true }).catch(() => undefined);
      }
    };

    // Stamp for the spawn that wrote the artifact; after a hop, the runner that ran.
    let runner: string | undefined;
    const runOpenCode = async (extra?: { prompt: string; continueSession: boolean }) => {
      throwIfAborted(opts.abortSignal);
      await writeFile(join(opts.workspace, "JUMI_TASK.md"), extra?.prompt ?? prompt);
      log(`Running OpenCode for ${repoFullName}#${pr.number}`);
      await ensureEngineScratchIgnored(opts.workspace);
      const runOpts: EngineRunOptions = {
        model: opts.model,
        variant: opts.variant,
        workdir: opts.workspace,
        home: opts.home,
        sanitizeEnv: opts.sanitizeOpenCodeEnv,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
        reviewLabel,
        logger: log,
        abortSignal: opts.abortSignal,
        ...(extra?.continueSession ? { continueSession: true } : {}),
        trace: {
          kind: "review",
          owner: opts.owner,
          repo: opts.repo,
          sha: reviewedHeadSha,
          jobId: opts.jobId,
        },
      };
      const engineResult = await engine(runOpts);
      runner = formatRunnerStamp(resultRunner(engineResult, runOpts));
      // Only the quota path in git.ts returns engine `stuck`; gate on the
      // message so a future non-quota `stuck` producer falls through to the
      // fingerprint path instead of setting the human-clear quota flag.
      // A resetting quota with wait budget left throws QuotaWaitError so the
      // same head is requeued; only hard or budget-exhausted quota parks here.
      if (engineResult.status === "stuck" && isQuotaText(engineResult.message)) {
        throwIfQuotaWait({
          result: engineResult,
          model: opts.model,
          fallbackModel: opts.fallbackModel,
          chain: opts.chain,
          previousError: opts.previousError,
        });
        if (opts.home) {
          await markQuotaStuck(
            reviewStuckStatePath(opts.home, opts.owner, opts.repo, opts.prNumber),
            QUOTA_STUCK_TEXT
          ).catch(() => undefined);
        }
        throw new Error(QUOTA_STUCK_TEXT);
      }
      throwIfEngineFailed(engineResult);

      await logParentDiag(log, "post_opencode", {
        review: reviewLabel,
        output_bytes: byteLength(engineResult.stdout ?? ""),
        output_bytes_h: formatBytes(byteLength(engineResult.stdout ?? "")),
      });

      await restoreTaskFile();
      return engineResult;
    };

    let lastStdout = (await runOpenCode()).stdout;
    const artifactPath = join(opts.workspace, REVIEW_ARTIFACT);
    const persistSkipAndStatus = async (
      reason: string,
      htmlUrl?: string,
      stuckText?: string
    ): Promise<ReviewResult> => {
      const result: ReviewResult = { status: "skipped", reason };
      await persistOutcome({ kind: "skip", reason });
      if (stuckText) {
        await upsertStuckText(forgeApi, opts.owner, opts.repo, opts.prNumber, opts.botUsername, stuckText);
      }
      const { state, description } = statusForResult(result);
      await postReviewStatus(forgeApi, opts.owner, opts.repo, reviewedHeadSha, state, description, htmlUrl);
      return result;
    };
    try {
      const extraCap = opts.maxIncompleteRetries ?? MAX_INCOMPLETE_RETRIES;
      let extrasUsed = 0;
      while (true) {
        await logParentDiag(log, "post_fetch_pr", { review: reviewLabel });
        const currentPR = await forgeApi.getPR(opts.owner, opts.repo, opts.prNumber);
        const currentSkipReason = skipReasonForPR(currentPR) ?? skipReasonForHeadChange(currentPR, reviewedHeadSha);
        if (currentSkipReason) return await persistSkipAndStatus(currentSkipReason, currentPR.html_url);

        const headAfter = (await git(["rev-parse", "HEAD"], { cwd: opts.workspace, env: gitCmdEnv })).trim();
        if (headAfter !== reviewedHeadSha) {
          return await persistSkipAndStatus("Incomplete review: HEAD moved", currentPR.html_url);
        }

        const porcelain = await git(["status", "--porcelain"], { cwd: opts.workspace, env: gitCmdEnv });
        if (!porcelainAllowsOnlyReviewArtifact(porcelain)) {
          return await persistSkipAndStatus("Incomplete review: dirty tree", currentPR.html_url);
        }

        const noArtifact = !porcelainIncludesReviewArtifact(porcelain);
        const artifact = noArtifact
          ? ({ status: "missing" } as const)
          : await readReviewArtifact(opts.workspace, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
        if (artifact.status === "too_large") {
          return await persistSkipAndStatus("Incomplete review: output too large", currentPR.html_url);
        }
        if (artifact.status !== "missing" && artifact.content.trim()) {
          let markdown = await gatePersonalJumiContractEnv(opts.owner, opts.repo, opts.workspace, artifact.content);
          if (opts.noCiNote && !markdown.includes(opts.noCiNote)) {
            markdown = `${opts.noCiNote}\n\n${markdown}`;
          }
          await persistOutcome({ kind: "markdown", markdown, ...(runner ? { runner } : {}) });
          if (opts.home) {
            const stuckPath = reviewStuckStatePath(opts.home, opts.owner, opts.repo, opts.prNumber);
            // A successful run clears any stale (TTL-expired) quota flag.
            await clearQuotaStuck(stuckPath).catch(() => undefined);
            const actionHash = fingerprintReviewArtifact(markdown);
            if (actionHash) {
              await appendStuckFingerprint(stuckPath, {
                kind: "action",
                hash: actionHash,
              });
            }
          }
          return await publishReviewResult({
            api: forgeApi,
            forge: forgeApi,
            owner: opts.owner,
            repo: opts.repo,
            prNumber: opts.prNumber,
            expectedHeadSha: reviewedHeadSha,
            botUsername: opts.botUsername,
            resultMarkdown: markdown,
            resultRunner: runner,
            logger: log,
          });
        }

        if (extrasUsed >= extraCap) {
          return await persistSkipAndStatus(
            "Incomplete review: no output",
            currentPR.html_url,
            INCOMPLETE_REVIEW_STUCK
          );
        }
        extrasUsed++;
        log(`Incomplete review: no output; write-only OpenCode retry (${extrasUsed}/${extraCap})`);
        await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
        const continueSession = await hasResumableSession(opts.workspace);
        const writePrompt = buildIncompleteWritePrompt(continueSession ? undefined : lastStdout);
        lastStdout = (await runOpenCode({ prompt: writePrompt, continueSession })).stdout;
      }
    } finally {
      await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
      await rm(join(opts.workspace, ".jumi-tmp"), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (err) {
    if (isAbortError(err) || opts.abortSignal?.aborted) throw err;
    if (isInfraFailure(err)) throw err;
    if (isQuotaWaitError(err)) throw err;
    if (isQuotaError(err)) {
      // Resetting quota with wait budget left waits and retries the same
      // head; QuotaWaitError propagates to the queue. Hard or exhausted
      // quota falls through to the day-long skip below.
      throwIfQuotaWait({
        err,
        model: opts.model,
        fallbackModel: opts.fallbackModel,
        chain: opts.chain,
        previousError: opts.previousError,
      });
      if (opts.home) {
        await markQuotaStuck(
          reviewStuckStatePath(opts.home, opts.owner, opts.repo, opts.prNumber),
          QUOTA_STUCK_TEXT
        ).catch(() => undefined);
      }
      if (!persisted && !persistFailed) {
        await opts.persistResult?.({ kind: "skip", reason: QUOTA_STUCK_TEXT });
        await upsertStuckText(forgeApi, opts.owner, opts.repo, opts.prNumber, opts.botUsername, QUOTA_STUCK_TEXT);
        const skipped: ReviewResult = { status: "skipped", reason: QUOTA_STUCK_TEXT };
        const { state, description } = statusForResult(skipped);
        await postReviewStatus(forgeApi, opts.owner, opts.repo, reviewedHeadSha, state, description, pr.html_url);
        return skipped;
      }
      throw err;
    }
    if (!persisted && !persistFailed) {
      const message = redactGitSecrets(
        `Jumi review failed: ${err instanceof Error ? err.message : String(err)}`,
        failureSecrets
      );
      await opts.persistResult?.({ kind: "error", error: message });
      if (opts.home) {
        const errorHash = fingerprintError(message);
        if (errorHash) {
          await appendStuckFingerprint(reviewStuckStatePath(opts.home, opts.owner, opts.repo, opts.prNumber), {
            kind: "error",
            hash: errorHash,
          }).catch(() => undefined);
        }
      }
      await postReviewStatus(forgeApi, opts.owner, opts.repo, reviewedHeadSha, "failure", message, pr.html_url);
    }
    throw err;
  }
}
