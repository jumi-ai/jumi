import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  branchRequiresReviewCheck,
  CI_ABSENT_NOTE,
  CI_LOOKUP_FAILED_REASON,
  type CiCheckSummary,
  type CiGateResolverApi,
  type CiInspection,
  inspectCi,
  isCiLookupRetryMarker,
  isCiWaitMarker,
  JUMI_REVIEW_CONTEXT,
  type RequiredCiResolver,
  resolveCiGate,
  resolveRequiredCiContexts,
  reviewSkipReasonForCi,
} from "./ci.ts";
import { isEngineTempPath, porcelainPaths } from "./claimed_worktree.ts";
import { claudeApiKeySecrets } from "./claude_credentials.ts";
import { byteLength, formatBytes, logDiagnostic, sampleMemory } from "./diagnostics.ts";
import { type Engine, type EngineRunOptions, resolveEngine, resultRunner, throwIfEngineFailed } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import { ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { hasResumableSession, withEngineChain } from "./fallback.ts";
import { extractClosingIssueNumbers } from "./gitea_issues.ts";
import {
  isIndependentReviewRefusal,
  provenanceLookupFailureReason,
  resolveIndependentReviewers,
} from "./independent_review.ts";
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
import {
  buildIncompleteWritePrompt,
  buildNoFindingsWritePrompt,
  buildNoTrailerWritePrompt,
  buildPROpenedPrompt,
} from "./prompt.ts";
import type { ProvenanceLookup, ProvenanceStore } from "./provenance.ts";
import { isQuotaError, isQuotaText, isQuotaWaitError, quotaStuckReasonForText } from "./quota.ts";
import { throwIfQuotaWait } from "./quota_wait.ts";
import {
  CONTRACT_PATH,
  contractEnvIssues,
  formatContractEnvIssue,
  parseContract,
  REVIEWER_LOADER_PATH,
  WORKER_LOADER_PATH,
} from "./release.ts";
import type { CiGateWait } from "./repo_settings.ts";
import {
  applyRepoChain,
  compileReviewExcludePatterns,
  loadEffectiveBlockingQuestionAuthors,
  loadRepoSettings,
  partitionReviewExcludedFiles,
  prTouchesRepoSettings,
  REPO_SETTINGS_PATH,
} from "./repo_settings.ts";
import { DEFAULT_MAX_THREAD_BYTES, fitReviewThread, mapReviewThread } from "./review_context.ts";
import { findPreviousReview, isJumiReviewComment, loadReviewDelta, type ReviewDelta } from "./review_delta.ts";
import { collectRecentHistory } from "./review_history.ts";
import { DEFAULT_MAX_REVIEW_MD_BYTES, loadReviewMdSectionsFromBase } from "./review_md.ts";
import {
  countAddressedSuggestions,
  forgeLabelForKind,
  parseSuggestionFindings,
  type ReviewSuggestionCounts,
  runnerLabelForStamp,
} from "./review_suggestions.ts";
import {
  appendRunnerStamp,
  describeAttemptOrder,
  formatRunnerStamp,
  type IndependentReviewConfig,
  type NamedRunner,
  OPENCODE_RUNNER_TYPE,
  orderChainForJob,
  orderChainForRetry,
  resolveRunnerSelection,
} from "./runners.ts";
import type { SkipLatchStore } from "./skip_latches.ts";
import {
  GITEA_STATUS_DESCRIPTION_MAX_BYTES,
  omitOpenCodeStderr,
  truncateStatusDescription,
} from "./status_description.ts";
import {
  appendReviewStuckState,
  clearReviewQuotaStuckState,
  evaluateStuck,
  fingerprintError,
  fingerprintReviewArtifact,
  isReviewQuotaStuck,
  markReviewQuotaStuckState,
  readReviewStuckState,
  stuckComment,
  upsertStuckComment,
  upsertStuckText,
} from "./stuck.ts";
import type { ReviewJob } from "./types.ts";
import {
  buildFindingsList,
  capSuggestionFindings,
  countQuestionFindings,
  findingFingerprint,
  hasColonEndingFinding,
  hasPublishedFindings,
  isBlockingQuestionAuthor,
  keepReviewFindingLines,
  openQuestionDescription,
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
  /** Opt-in independent-review policy from the runners catalog. Unset/disabled preserves today's behavior. */
  independentReview?: IndependentReviewConfig;
  /**
   * Opt-in runner distribution. `ordered` (default when absent) keeps
   * configured order; `random-start` uniformly picks a start from the eligible
   * chain per fresh job and rotates. Invalid modes fail at config load.
   */
  runnerSelection?: string;
  /** Injectable randomness for deterministic tests. Defaults to `Math.random`. */
  runnerRandom?: () => number;
  /** Durable writer provenance. Required when the policy is enabled; unset keeps legacy behavior. */
  provenance?: ProvenanceStore;
  /** Forge kind for the provenance lookup. Defaults to `gitea`; shared parent behavior for both forges. */
  forgeKind?: string;
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  workspace: string;
  giteaUrl: string;
  giteaToken: string;
  botUsername: string;
  /** Opt-in logins whose open `❓` questions block the status. Unset/empty preserves today's behavior. */
  blockingQuestionAuthors?: readonly string[];
  /**
   * Retained for compatibility (auto-merge scheduling still uses it
   * elsewhere). The head settings check no longer reads it and runs in
   * every repository.
   */
  automergeRepos?: readonly string[];
  gitAuthResolver?: GitAuthResolver;
  home?: string;
  /** Postgres ledger for review stuck state. When present (production always
   * passes the engine store), stuck reads/writes use the ledger and never
   * touch the HOME file, so a fresh HOME keeps the same-finding, ping-pong,
   * and quota stops. Absent keeps the legacy HOME file for local/dev. */
  skipLatches?: SkipLatchStore;
  sanitizeOpenCodeEnv?: boolean;
  timeoutMs?: number;
  maxFiles?: number;
  maxPatchBytes?: number;
  maxThreadBytes?: number;
  /** Byte budget for the base branch's REVIEW.md sections pasted into the prompt. */
  maxReviewMdBytes?: number;
  maxOutputBytes?: number;
  engine?: Engine;
  openCodeRunner?: Engine;
  workspacePreparer?: WorkspacePreparer;
  gitRunner?: GitRunner;
  logger?: (message: string) => void;
  persistResult?: (result: PersistReviewResult) => Promise<void>;
  /**
   * Fail-open recorder for the per-review 💡 counts. The engine tick wires
   * this to the ledger; tests and local runs may omit it. Forwarded to
   * `publishReviewResult` with the capped counts.
   */
  recordSuggestions?: (counts: ReviewSuggestionCounts) => Promise<void>;
  abortSignal?: AbortSignal;
  jobId?: string;
  maxIncompleteRetries?: number;
  /** Wait before the single CI re-list when the first look finds no checks or a lookup failed. */
  ciRelistDelayMs?: number;
  /** When false, the caller already applied `skipReasonForOtherChecks`. */
  inspectOtherChecks?: boolean;
  /** Inspected non-Jumi checks on the head, forwarded when the caller already ran the CI inspection. */
  ciChecks?: CiCheckSummary[];
  /** Head the forwarded `ciChecks` were inspected on. Defaults to the reviewed head. */
  ciHeadSha?: string;
  /** Pending checks that are still running but not required; rendered as not-required in the prompt. */
  ciPendingOptional?: readonly string[];
  /** Prepended to the review when the lookup budget expired with no checks at all. */
  noCiNote?: string;
  /** Previous job error (e.g. quota-wait marker) for the wait-budget decision. */
  previousError?: string | null;
  /**
   * Runner name that failed the previous attempt (ledger `result_runner`).
   * With `random-start` the retry starts on the next runner, independent of
   * the random source; `ordered` keeps configured order.
   */
  failedRunner?: string | null;
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
  /** Opt-in logins whose open `❓` questions block the status. Unset/empty preserves today's behavior. */
  blockingQuestionAuthors?: readonly string[];
  /**
   * Retained for compatibility. The head settings check no longer reads it
   * and runs in every repository.
   */
  automergeRepos?: readonly string[];
  resultMarkdown?: string | null;
  resultReason?: string | null;
  /** Formatted stamp for the runner that produced `resultMarkdown`. */
  resultRunner?: string | null;
  error?: string | null;
  logger?: (message: string) => void;
  /** Forge kind for the `forge` suggestion-metric label. Defaults to `gitea`. */
  forgeKind?: string;
  /** Previous review finding lines for the addressed-💡 count. Unset counts 0 addressed. */
  previousFindings?: readonly string[];
  /**
   * Fail-open recorder for the per-review 💡 counts. The engine tick wires
   * this to the ledger; tests and local runs may omit it.
   */
  recordSuggestions?: (counts: ReviewSuggestionCounts) => Promise<void>;
  /** Repository-relative paths left out of this review per the default-branch settings file. */
  excludedFiles?: readonly string[];
  /** True when every changed file was left out (no patches were read). */
  allExcluded?: boolean;
  /**
   * Already-fetched PR files. When set, the head settings check reuses them
   * instead of listing PR files again; when unset it lists them itself (the
   * reclaim path has no fetched files).
   */
  changedFiles?: readonly { filename: string }[];
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

/** Inline URLs by finding fingerprint, so the top-level body can link each listed finding. */
function inlineUrlsByFingerprint(comments: InlineComment[], marker: string): Map<string, string> {
  const urls = new Map<string, string>();
  for (const comment of comments) {
    const url = comment.html_url?.trim();
    if (!url || !comment.path) continue;
    if (!(comment.body ?? "").includes(marker)) continue;
    const fingerprint = commentFingerprint(comment, marker);
    if (!fingerprint) continue;
    urls.set(fingerprint, url);
  }
  return urls;
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

  const create = (event: PullReviewEvent, reviewComments: CreatePullReviewComment[], reviewBody?: string) =>
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

  // Publish new inlines ahead of the top-level body so the body can link each
  // listed finding to the inline the forge created for it.
  if (comments.length > 0) {
    try {
      await create("COMMENT", comments, "");
      for (const comment of comments) {
        const fingerprint = commentFingerprint(comment, opts.marker);
        if (fingerprint) posted.add(fingerprint);
      }
    } catch (err) {
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
    }
  }

  let urls = inlineUrlsByFingerprint(existing, opts.marker);
  if (comments.length > 0) {
    try {
      const published = await opts.api.listPullReviewComments(opts.owner, opts.repo, opts.prNumber);
      urls = inlineUrlsByFingerprint(published, opts.marker);
    } catch (err) {
      opts.log(`inline urls unavailable: ${errorMessage(err)}`);
    }
  }

  // The top-level body lists every finding (linked when the forge gave a URL
  // for its inline) and keeps the full text of any finding whose inline could
  // not be posted, as before. A review with no findings keeps today's body.
  const failed = stripFindingLines(opts.comment, { singleFilePath: opts.singleFilePath, posted });
  const list = buildFindingsList(findings, urls);
  const content = [list, failed].filter((part) => part.trim()).join("\n\n");
  try {
    await createWithFallback(
      opts.event,
      [],
      buildCommentBody(opts.marker, opts.headSha, content, opts.checkLine, opts.runner)
    );
    return true;
  } catch (err) {
    opts.log(`review event skipped: ${errorMessage(err)}`);
    return false;
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
export const INCOMPLETE_NO_FINDINGS_REASON = "Incomplete review: no findings";

function porcelainAllowsOnlyReviewArtifact(porcelain: string): boolean {
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (porcelainPaths(line).some((path) => path !== REVIEW_ARTIFACT && !isEngineTempPath(path))) return false;
  }
  return true;
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
    if (result.reason?.startsWith("Incomplete review:") || isIndependentReviewRefusal(result.reason)) {
      return { state: "failure", description: result.reason ?? "Incomplete review" };
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

export async function inspectOtherChecks(
  opts: Pick<ReviewOptions, "api" | "owner" | "repo" | "prNumber" | "home" | "abortSignal" | "ciRelistDelayMs"> & {
    relist?: boolean;
    baseBranch?: string;
    defaultBranch?: string;
    requiredContexts?: readonly string[];
    wait?: CiGateWait;
  },
  sha: string,
  log: (message: string) => void
): Promise<CiInspection> {
  const resolveBranch = opts.baseBranch;
  let requiredContexts = opts.requiredContexts;
  let wait = opts.wait;
  if (wait === undefined) {
    try {
      const gate = await resolveCiGate(opts.api as unknown as CiGateResolverApi, {
        owner: opts.owner,
        repo: opts.repo,
        prNumber: opts.prNumber,
        ...(resolveBranch ? { baseBranch: resolveBranch } : {}),
        ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
        log,
      });
      wait = gate.wait;
      if (requiredContexts === undefined) requiredContexts = gate.requiredContexts;
    } catch {
      wait = "required";
    }
  } else if (wait !== "all" && wait !== "none" && requiredContexts === undefined && resolveBranch) {
    requiredContexts = await resolveRequiredCiContexts(opts.api as unknown as RequiredCiResolver, {
      owner: opts.owner,
      repo: opts.repo,
      prNumber: opts.prNumber,
      baseBranch: resolveBranch,
      log,
    });
  }
  const inspectOpts = {
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    sha,
    home: opts.home ?? "",
    issueNumber: opts.prNumber,
    log,
    ...(requiredContexts ? { requiredContexts } : {}),
    ...(wait && wait !== "required" ? { wait } : {}),
  };
  let ci = await inspectCi(inspectOpts);
  if ((ci.empty || ci.lookupFailed) && opts.relist !== false && wait !== "none") {
    // Actions may not have created the push's jobs yet, or a list call blipped;
    // give it one short beat, then re-list once. Still no checks is not green:
    // the engine waits on the CI lookup budget, then reviews and says so.
    await delay(opts.ciRelistDelayMs ?? 0, opts.abortSignal);
    ci = await inspectCi(inspectOpts);
  }
  return ci;
}

export async function skipReasonForOtherChecks(
  opts: Pick<ReviewOptions, "api" | "owner" | "repo" | "prNumber" | "home" | "abortSignal" | "ciRelistDelayMs"> & {
    relist?: boolean;
    baseBranch?: string;
    defaultBranch?: string;
    requiredContexts?: readonly string[];
    wait?: CiGateWait;
  },
  sha: string,
  log: (message: string) => void
): Promise<string | undefined> {
  try {
    let wait = opts.wait;
    let requiredContexts = opts.requiredContexts;
    if (wait === undefined) {
      try {
        const gate = await resolveCiGate(opts.api as unknown as CiGateResolverApi, {
          owner: opts.owner,
          repo: opts.repo,
          prNumber: opts.prNumber,
          ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
          ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
          log,
        });
        wait = gate.wait;
        if (requiredContexts === undefined) requiredContexts = gate.requiredContexts;
      } catch {
        wait = "required";
      }
    }
    const ci = await inspectOtherChecks(
      { ...opts, ...(wait ? { wait } : {}), ...(requiredContexts ? { requiredContexts } : {}) },
      sha,
      log
    );
    return reviewSkipReasonForCi(ci, wait);
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
  return (
    reason.startsWith("Incomplete review:") ||
    reason.startsWith("PR head changed from ") ||
    isIndependentReviewRefusal(reason)
  );
}

export function activeReviewChain(
  opts: Pick<ReviewOptions, "model" | "variant" | "fallbackModel" | "fallbackVariant" | "chain">
): NamedRunner[] {
  if (opts.chain && opts.chain.length > 0) return [...opts.chain];
  const primary: NamedRunner = {
    name: "primary",
    type: OPENCODE_RUNNER_TYPE,
    model: opts.model,
    ...(opts.variant ? { variant: opts.variant } : {}),
  } as NamedRunner;
  if (!opts.fallbackModel) return [primary];
  return [
    primary,
    {
      name: "fallback",
      type: OPENCODE_RUNNER_TYPE,
      model: opts.fallbackModel,
      ...(opts.fallbackVariant ? { variant: opts.fallbackVariant } : {}),
    } as NamedRunner,
  ];
}

async function resolveProvenanceForReview(
  opts: Pick<ReviewOptions, "provenance" | "forgeKind" | "owner" | "repo" | "prNumber">,
  pr: Pull,
  headSha: string
): Promise<ProvenanceLookup> {
  if (!opts.provenance) {
    throw new Error(provenanceLookupFailureReason(headSha, "provenance store unavailable"));
  }
  const forge = (opts.forgeKind ?? "gitea").trim() || "gitea";
  return opts.provenance.lookupForReview({
    forge,
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.prNumber,
    headSha,
    branch: pr.head.ref,
  });
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
  pullReviews: PullReview[],
  reviewComments: InlineComment[],
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
  for (const review of pullReviews) logins.push(review.user?.login);
  for (const comment of reviewComments) {
    logins.push(comment.user?.login);
    if (comment.resolver?.login) logins.push(comment.resolver.login);
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

/**
 * Failure reason when the pull head leaves the repository settings file
 * invalid, else undefined. Runs in every repository, but reads the head
 * file only when the pull changes it: callers pass the changed-file list
 * the review already has, or the function lists the pull files itself (the
 * same check as `prIncludesSettingsFile` in `automerge.ts`), so pulls
 * that do not touch the file cost no extra head-file read. Read failures
 * (pull files, head file, or branch) are fail-open (no failure); only an
 * invalid file fails, with the parser's error, and a valid file that sets
 * `mode: off` where the base branch requires `jumi/opencode-review` fails
 * because pull requests there would become unable to merge.
 */
export async function invalidHeadSettingsFailure(opts: {
  api: {
    getRepoFile?: ReviewApi["getRepoFile"];
    getPRFiles?: ReviewApi["getPRFiles"];
    getBranch?: (
      owner: string,
      repo: string,
      branch: string
    ) => Promise<{
      enableStatusCheck?: boolean;
      requiredContexts?: string[];
    }>;
  };
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseBranch: string;
  changedFiles?: readonly { filename: string }[];
  /** Retained for compatibility; no longer gates the check. */
  automergeRepos?: readonly string[] | undefined;
  log: (message: string) => void;
}): Promise<string | undefined> {
  let touches: boolean;
  if (opts.changedFiles !== undefined) {
    touches = prTouchesRepoSettings(opts.changedFiles);
  } else {
    const listFiles = opts.api.getPRFiles;
    if (typeof listFiles !== "function") return undefined;
    let files: Awaited<ReturnType<NonNullable<ReviewApi["getPRFiles"]>>>;
    try {
      files = await listFiles.call(opts.api, opts.owner, opts.repo, opts.prNumber);
    } catch (err) {
      opts.log(
        `settings pull files unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
    touches = prTouchesRepoSettings(files);
  }
  if (!touches) return undefined;
  let settings: Awaited<ReturnType<typeof loadRepoSettings>>;
  try {
    settings = await loadRepoSettings(opts.api, opts.owner, opts.repo, opts.headSha);
  } catch (err) {
    opts.log(
      `settings head unreadable for ${opts.owner}/${opts.repo}@${opts.headSha}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
  if (settings.state === "invalid") return `${REPO_SETTINGS_PATH} is invalid: ${settings.error}`;
  if (settings.state !== "valid" || settings.mode !== "off") return undefined;
  const getBranch = opts.api.getBranch;
  if (typeof getBranch !== "function") {
    opts.log(
      `settings branch unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: branch requirements are not readable`
    );
    return undefined;
  }
  let branch: Awaited<ReturnType<NonNullable<typeof opts.api.getBranch>>>;
  try {
    branch = await getBranch.call(opts.api, opts.owner, opts.repo, opts.baseBranch);
  } catch (err) {
    opts.log(
      `settings branch unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
  const required = branchRequiresReviewCheck(branch);
  if (!required) return undefined;
  return `${REPO_SETTINGS_PATH} sets mode: off, but \`${JUMI_REVIEW_CONTEXT}\` is required on ${opts.baseBranch}; pull requests would become unable to merge`;
}

/** Max left-out files named in the published note; longer lists name the count. */
export const MAX_LISTED_EXCLUDED_FILES = 10;

/**
 * Shared truncated backtick list for left-out files: names up to
 * `MAX_LISTED_EXCLUDED_FILES`, then "and N more". Used by both the published
 * note and the child-directed `JUMI_TASK.md` review note so the listing
 * format edits in one place.
 */
function formatExcludedFileList(excludedFiles: readonly string[]): string {
  const names = [...new Set(excludedFiles)];
  const shown = names.slice(0, MAX_LISTED_EXCLUDED_FILES);
  const quoted = shown.map((name) => `\`${name}\``).join(", ");
  return names.length > shown.length ? `${quoted} and ${names.length - shown.length} more` : quoted;
}

/**
 * Single-line published note naming the files left out of the review.
 * Empty when nothing was left out. The parent appends it, so a green
 * review is never read as covering these files.
 */
export function formatReviewExcludedNote(excludedFiles: readonly string[], opts?: { allExcluded?: boolean }): string {
  if (excludedFiles.length === 0) return "";
  const names = [...new Set(excludedFiles)];
  const total = names.length;
  const tail = formatExcludedFileList(names);
  const filesWord = total === 1 ? "file" : "files";
  if (opts?.allExcluded) {
    return (
      `No patches were read: all ${total} changed ${filesWord} ${total === 1 ? "was" : "were"} left out of ` +
      `review per \`.jumi.yml\` \`review_exclude\` (patches not read): ${tail}. ` +
      `A green review does not cover these files; they can merge without review.`
    );
  }
  return (
    `Left out of review per \`.jumi.yml\` \`review_exclude\` (patches not read, ${total} ${filesWord}): ` +
    `${tail}. A green review does not cover these files; they can merge without review.`
  );
}

/**
 * Load the default-branch `review_exclude` patterns as matchers. Missing,
 * invalid, unreadable, or empty means no exclusions: the review runs in
 * full instead of failing. Patterns come from the default branch only, so
 * a pull that adds patterns is still reviewed in full.
 */
export async function loadReviewExcludeMatchers(opts: {
  api: Pick<ReviewApi, "getRepoFile">;
  owner: string;
  repo: string;
  defaultBranch: string | undefined | null;
  log: (message: string) => void;
}): Promise<RegExp[]> {
  const ref = (opts.defaultBranch ?? "").trim();
  if (!ref) return [];
  let settings: Awaited<ReturnType<typeof loadRepoSettings>>;
  try {
    settings = await loadRepoSettings(opts.api, opts.owner, opts.repo, ref);
  } catch (err) {
    opts.log(
      `review excludes unreadable for ${opts.owner}/${opts.repo}@${ref}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
  if (settings.state === "missing") return [];
  if (settings.state === "invalid") {
    opts.log(`review excludes invalid for ${opts.owner}/${opts.repo}@${ref}: ${settings.error}; reviewing in full`);
    return [];
  }
  if (settings.reviewExclude.length === 0) return [];
  return compileReviewExcludePatterns(settings.reviewExclude);
}

export async function publishReviewResult(opts: PublishReviewOptions): Promise<ReviewResult> {
  const log = opts.logger ?? defaultLog;
  const forgeApi = opts.forge ?? opts.api;
  const pr = await forgeApi.getPR(opts.owner, opts.repo, opts.prNumber);
  const reviewLabel = `${opts.owner}/${opts.repo}#${opts.prNumber}`;
  // Effective blocking authors: the deployer list plus the repository's
  // default-branch file. Read from the default branch only so a change takes
  // effect when it reaches the default branch. Fail-open to the deployer
  // list: a missing, invalid, or unreadable file contributes nothing.
  let blockingQuestionAuthors = opts.blockingQuestionAuthors;
  try {
    const repoInfo = await forgeApi.getRepo(opts.owner, opts.repo);
    const defaultBranch = repoInfo.default_branch?.trim() ? repoInfo.default_branch : "";
    if (defaultBranch) {
      blockingQuestionAuthors = await loadEffectiveBlockingQuestionAuthors(
        forgeApi,
        opts.owner,
        opts.repo,
        defaultBranch,
        opts.blockingQuestionAuthors,
        log
      );
    }
  } catch {
    // Fail-open: the deployer list still applies.
  }
  const skipReason = skipReasonForPR(pr) ?? skipReasonForHeadChange(pr, opts.expectedHeadSha);
  if (skipReason) {
    const result: ReviewResult = { status: "skipped", reason: skipReason };
    const { state, description } = statusForResult(result);
    await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
    return result;
  }

  // A pull that changes the repository settings file to an invalid file
  // fails the review check with the parser's error, and a valid head file
  // that sets `mode: off` where the base branch requires the review check
  // fails because those pulls could never merge. The parser decides: the
  // reviewer model is never consulted. The head file is read only when the
  // pull changes it, so other pulls cost no extra head-file read.
  const settingsFailure = await invalidHeadSettingsFailure({
    api: forgeApi,
    owner: opts.owner,
    repo: opts.repo,
    prNumber: pr.number,
    headSha: opts.expectedHeadSha,
    baseBranch: pr.base.ref,
    changedFiles: opts.changedFiles,
    log,
  });
  if (settingsFailure) {
    await postReviewStatus(
      forgeApi,
      opts.owner,
      opts.repo,
      opts.expectedHeadSha,
      "failure",
      settingsFailure,
      pr.html_url
    );
    return { status: "skipped", reason: settingsFailure };
  }

  if (opts.error && !opts.resultMarkdown) {
    // Internal CI wait/retry markers must never become a forge status
    // description. A leaked `ci-wait-*` / `ci-lookup-retry:*` marker would
    // otherwise publish the raw `marker:timestamp` as a failed check.
    const safeError =
      isCiWaitMarker(opts.error) || isCiLookupRetryMarker(opts.error) ? CI_LOOKUP_FAILED_REASON : opts.error;
    await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, "failure", safeError, pr.html_url);
    return { status: "skipped", reason: safeError };
  }

  if (!opts.resultMarkdown) {
    const rawReason = opts.resultReason ?? "Incomplete review: no output";
    const reason = isCiWaitMarker(rawReason) || isCiLookupRetryMarker(rawReason) ? CI_LOOKUP_FAILED_REASON : rawReason;
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
  // A failure trailer with no published finding is an incomplete review: the
  // trailer reason is not a finding, and prose the publisher drops must not
  // become a blank required-check failure. Success with no findings stays clean.
  if (
    !parsed.verdict.incomplete &&
    parsed.verdict.state === "failure" &&
    !hasPublishedFindings(parsed.comment, { singleFilePath })
  ) {
    const result: ReviewResult = { status: "skipped", reason: INCOMPLETE_NO_FINDINGS_REASON };
    await upsertStuckText(forgeApi, opts.owner, opts.repo, pr.number, opts.botUsername, INCOMPLETE_REVIEW_STUCK);
    const { state, description } = statusForResult(result);
    await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
    await logParentDiag(log, "post_review_done", { review: reviewLabel, status: result.status });
    return result;
  }
  // Publish finding blocks and the trailer only; the child's tour is not published.
  // A finding keeps its indented/list continuation; unrelated prose is dropped.
  // The left-out disclosure is parent-enforced below, so the keep lists must
  // not contain the `` `review_exclude` `` marker: `collectFindingBlocks`
  // would collapse any line containing it (a child disclosure, or a real
  // finding about the setting) to the bare marker.
  const kept = keepReviewFindingLines(parsed.comment, { singleFilePath, keep: [CI_ABSENT_NOTE] });
  // Parent-enforced 💡 cap: at most MAX_SUGGESTION_FINDINGS publish. 🔴/🟡/❓
  // are never dropped. The dropped count rides in one body line so the next
  // follow-up still sees the trailer but not a wall of suggestions.
  const capped = capSuggestionFindings(kept, { singleFilePath, keep: [CI_ABSENT_NOTE] });
  // Parent-enforced left-out disclosure: a green review must never read as
  // covering files whose patches were withheld. Always appended when non-empty
  // so it publishes exactly once with the canonical names/count even when the
  // child omitted it or wrote its own disclosure line; it is not a finding.
  const excludedNote = formatReviewExcludedNote(opts.excludedFiles ?? [], { allExcluded: opts.allExcluded });
  const comment = excludedNote
    ? capped.comment
      ? `${capped.comment.trimEnd()}\n\n${excludedNote}`
      : excludedNote
    : capped.comment;
  let suggestionAddressed = 0;
  if (opts.previousFindings && opts.previousFindings.length > 0) {
    try {
      const prevSuggestions = parseSuggestionFindings(opts.previousFindings.join("\n\n"), { singleFilePath });
      const currSuggestions = parseSuggestionFindings(comment, { singleFilePath });
      suggestionAddressed = countAddressedSuggestions(prevSuggestions, currSuggestions);
    } catch {
      suggestionAddressed = 0;
    }
  }
  if (opts.recordSuggestions) {
    const counts: ReviewSuggestionCounts = {
      runner: runnerLabelForStamp(opts.resultRunner),
      forge: forgeLabelForKind(opts.forgeKind),
      posted: capped.posted,
      dropped: capped.dropped,
      addressed: suggestionAddressed,
    };
    try {
      await opts.recordSuggestions(counts);
    } catch (err) {
      log(`suggestion metrics unavailable: ${errorMessage(err)}`);
    }
    logDiagnostic(log, "review_suggestions", {
      review: reviewLabel,
      runner: counts.runner,
      forge: counts.forge,
      posted: counts.posted,
      dropped: counts.dropped,
      addressed: counts.addressed,
    });
  }
  // Opt-in blocking questions: when the effective list (deployer plus the
  // repository's default-branch file) names this PR author, a
  // questions-only success still fails the required check so automerge waits,
  // and the worker follow-up below answers the questions. With neither list
  // naming the author the count is zero and nothing changes.
  const blockingQuestions =
    !parsed.verdict.incomplete &&
    parsed.verdict.state === "success" &&
    isBlockingQuestionAuthor(pr.user?.login, blockingQuestionAuthors)
      ? countQuestionFindings(comment, { singleFilePath })
      : 0;
  const effectiveVerdict =
    blockingQuestions > 0
      ? { state: "failure" as const, description: openQuestionDescription(blockingQuestions), incomplete: false }
      : parsed.verdict;
  if (blockingQuestions > 0) {
    logDiagnostic(log, "review_blocking_questions", {
      review: reviewLabel,
      questions: blockingQuestions,
      author: (pr.user?.login ?? "").toLowerCase() || null,
    });
  }
  if (hasColonEndingFinding(comment, { singleFilePath })) {
    logDiagnostic(log, "review_finding_truncated", {
      review: reviewLabel,
      reason: "finding_ends_with_colon",
      kept_bytes: comment.length,
    });
  }
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
        event: reviewEventForVerdict(effectiveVerdict.state, pr.user?.login, opts.botUsername),
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

  const { state, description } = statusForResult(result, effectiveVerdict);
  await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
  await logParentDiag(log, "post_review_done", { review: reviewLabel, status: result.status });
  return result;
}

export async function reviewPullRequest(opts: ReviewOptions): Promise<ReviewResult> {
  const log = opts.logger ?? defaultLog;
  const trackerApi = opts.tracker ?? opts.api;
  const forgeApi = opts.forge ?? opts.api;
  throwIfAborted(opts.abortSignal);
  const repoFullName = `${opts.owner}/${opts.repo}`;
  const pr = await forgeApi.getPR(opts.owner, opts.repo, opts.prNumber);
  const reviewedHeadSha = opts.expectedHeadSha ?? pr.head.sha;

  const initialSkipReason = skipReasonForPR(pr) ?? skipReasonForHeadChange(pr, reviewedHeadSha);
  if (initialSkipReason) return { status: "skipped", reason: initialSkipReason };

  // Repository runner allow-list (default branch only) narrows every job for
  // the repository. Invalid fails closed before any runner starts; an
  // allow-list that matches nothing fails closed with the same shape as an
  // independent-review refusal (failure status, no runner). Unreadable
  // settings fail open with a log so a transient read never blocks the repo.
  // This runs before stuck/CI so the config reason wins over cached latches.
  let effectiveChain = opts.chain;
  let effectiveFallbackModel = opts.fallbackModel;
  let effectiveFallbackVariant = opts.fallbackVariant;
  let earlyRepo: Repo | undefined;
  try {
    earlyRepo = await forgeApi.getRepo(opts.owner, opts.repo);
  } catch (err) {
    log(
      `runner settings repo unreadable for ${repoFullName}#${opts.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const defaultBranch = earlyRepo?.default_branch ?? "";
  if (opts.chain && opts.chain.length > 0) {
    // Only the resolve runs in the fail-open `try` (inside the helper);
    // the fail-closed publish below runs after it so a status or ledger
    // failure propagates instead of continuing on the full chain.
    const applied = await applyRepoChain({
      api: forgeApi,
      owner: opts.owner,
      repo: opts.repo,
      defaultBranch,
      chain: opts.chain,
      log,
      diagBase: { review: `${repoFullName}#${opts.prNumber}`, head: reviewedHeadSha },
      unreadableContext: `${repoFullName}@${defaultBranch || "(unknown branch)"}`,
      publish: async (reason) => {
        await opts.persistResult?.({ kind: "skip", reason });
        await postReviewStatus(forgeApi, opts.owner, opts.repo, reviewedHeadSha, "failure", reason, pr.html_url);
      },
    });
    if (applied.failedClosed) return { status: "skipped", reason: applied.reason };
    if (applied.narrowed) {
      effectiveChain = applied.chain;
      // Keep hops inside the narrowed set: the legacy fallback model may
      // name an excluded runner, and the narrowed chain already covers hops.
      effectiveFallbackModel = undefined;
      effectiveFallbackVariant = undefined;
    }
  }

  if (opts.home || opts.skipLatches || process.env.DATABASE_URL) {
    const stuckRef = {
      home: opts.home,
      owner: opts.owner,
      repo: opts.repo,
      prNumber: opts.prNumber,
      ...(opts.skipLatches ? { skipLatches: opts.skipLatches } : {}),
    };
    const stuckState = await readReviewStuckState(stuckRef);
    // Reviewer quota uses a TTL (not permanent like the worker flag): quota
    // resets in hours/days, and nothing else clears this per-PR latch, so an
    // expired flag re-checks instead of blocking the PR forever. Use
    // `cancelReviewWork` as the human kill-switch equivalent to the worker
    // cancel path.
    if (isReviewQuotaStuck(stuckState)) {
      const stuckReasonText = quotaStuckReasonForText(stuckState.quota?.reason);
      await opts.persistResult?.({ kind: "skip", reason: stuckReasonText });
      await upsertStuckText(forgeApi, opts.owner, opts.repo, opts.prNumber, opts.botUsername, stuckReasonText);
      return { status: "skipped", reason: stuckReasonText };
    }
    if (stuckState.quota) {
      // Expired quota: clear the stale flag so the next run starts clean.
      await clearReviewQuotaStuckState(stuckRef).catch(() => undefined);
    }
    const stuckReason = evaluateStuck(stuckState.fingerprints);
    if (stuckReason) {
      await opts.persistResult?.({ kind: "skip", reason: stuckComment(stuckReason) });
      await upsertStuckComment(forgeApi, opts.owner, opts.repo, opts.prNumber, opts.botUsername, stuckReason);
      return { status: "skipped", reason: stuckComment(stuckReason) };
    }
  }

  let ciResults: { headSha: string; checks: CiCheckSummary[]; pendingOptional?: readonly string[] } | undefined;
  if (opts.inspectOtherChecks !== false) {
    let ci: CiInspection;
    let ciWait: CiGateWait = "required";
    try {
      const gate = await resolveCiGate(forgeApi as unknown as CiGateResolverApi, {
        owner: opts.owner,
        repo: opts.repo,
        prNumber: opts.prNumber,
        baseBranch: pr.base.ref,
        ...(defaultBranch ? { defaultBranch } : {}),
        log,
      });
      ciWait = gate.wait;
      ci = await inspectOtherChecks(
        {
          ...opts,
          api: forgeApi,
          baseBranch: pr.base.ref,
          ...(defaultBranch ? { defaultBranch } : {}),
          ...(gate.requiredContexts ? { requiredContexts: gate.requiredContexts } : {}),
          ...(gate.wait !== "required" ? { wait: gate.wait } : {}),
        },
        reviewedHeadSha,
        log
      );
    } catch (err) {
      if (isAbortError(err) || opts.abortSignal?.aborted) throw err;
      log(`CI inspect failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
      return { status: "skipped", reason: CI_LOOKUP_FAILED_REASON };
    }
    const ciSkip = reviewSkipReasonForCi(ci, ciWait);
    if (ciSkip) return { status: "skipped", reason: ciSkip };
    if (ci.checks.length > 0)
      ciResults = {
        headSha: reviewedHeadSha,
        checks: ci.checks,
        ...(ci.pendingOptional.length > 0 ? { pendingOptional: ci.pendingOptional } : {}),
      };
  } else if (opts.ciChecks && opts.ciChecks.length > 0) {
    ciResults = {
      headSha: opts.ciHeadSha ?? reviewedHeadSha,
      checks: opts.ciChecks,
      ...(opts.ciPendingOptional && opts.ciPendingOptional.length > 0
        ? { pendingOptional: opts.ciPendingOptional }
        : {}),
    };
  }

  // Parent-owned independent reviewer selection from exact-head writer provenance.
  // Unset/disabled preserves today's behavior without touching provenance storage.
  // The allow-list narrowing above already ran: exclusion works inside the
  // narrowed set, so a writer-only allow-list refuses like an empty eligible set.
  if (opts.independentReview?.enabled === true) {
    let lookup: ProvenanceLookup;
    try {
      lookup = await resolveProvenanceForReview(opts, pr, reviewedHeadSha);
    } catch (err) {
      const reason = provenanceLookupFailureReason(reviewedHeadSha, err instanceof Error ? err.message : String(err));
      logDiagnostic(log, "independent_review", {
        review: `${repoFullName}#${pr.number}`,
        head: reviewedHeadSha,
        policy: "enabled",
        provenance_status: "error",
        reason,
      });
      await opts.persistResult?.({ kind: "skip", reason });
      await postReviewStatus(forgeApi, opts.owner, opts.repo, reviewedHeadSha, "failure", reason, pr.html_url);
      return { status: "skipped", reason };
    }
    const active = effectiveChain && effectiveChain.length > 0 ? [...effectiveChain] : activeReviewChain(opts);
    const outcome = resolveIndependentReviewers({
      chain: active,
      provenance: lookup,
      policy: opts.independentReview,
      headSha: reviewedHeadSha,
    });
    logDiagnostic(log, "independent_review", {
      review: `${repoFullName}#${pr.number}`,
      head: outcome.diagnostics.head,
      policy: outcome.diagnostics.policy,
      provenance_status: outcome.diagnostics.provenanceStatus,
      writers: outcome.diagnostics.writers.join(",") || null,
      writer_groups: outcome.diagnostics.writerGroups.join(",") || null,
      excluded: outcome.diagnostics.excludedFamilies.join(",") || null,
      eligible: outcome.diagnostics.eligible.join(",") || null,
      chosen: outcome.diagnostics.chosen ?? null,
      reason: outcome.diagnostics.reason ?? null,
    });
    if (outcome.kind === "refused") {
      await opts.persistResult?.({ kind: "skip", reason: outcome.reason });
      await postReviewStatus(forgeApi, opts.owner, opts.repo, reviewedHeadSha, "failure", outcome.reason, pr.html_url);
      return { status: "skipped", reason: outcome.reason };
    }
    // `unknown` keeps the ordinary chain with an explicit diagnostic;
    // `selected` retains chain order while excluding every writer family.
    // Dormant catalog entries are never eligible: only the active chain filters.
    // Clearing the legacy fallback keeps an availability hop inside the eligible set.
    effectiveChain = outcome.eligible;
    effectiveFallbackModel = undefined;
    effectiveFallbackVariant = undefined;
  }

  // Opt-in random-start distribution: exclusions first, then uniformly pick a
  // start from the eligible chain and rotate. A retry after a runner failure
  // starts on the next runner instead of drawing again. Continuations and
  // artifact-recovery calls reuse this order via the engine wrapper.
  const runnerSelection = resolveRunnerSelection({ selection: opts.runnerSelection ?? undefined });
  if (effectiveChain && effectiveChain.length > 1) {
    const rotated = opts.failedRunner
      ? orderChainForRetry(effectiveChain, runnerSelection, opts.runnerRandom ?? Math.random, opts.failedRunner)
      : orderChainForJob(effectiveChain, runnerSelection, opts.runnerRandom ?? Math.random);
    if (rotated.length === effectiveChain.length) {
      logDiagnostic(log, "runner_selection", {
        review: `${repoFullName}#${pr.number}`,
        head: reviewedHeadSha,
        selection: runnerSelection,
        start: rotated[0]?.name ?? null,
        order: describeAttemptOrder(rotated),
      });
    }
    effectiveChain = rotated;
  }

  const engine = withEngineChain(resolveEngine(opts, registeredEngine), {
    chain: effectiveChain,
    fallbackModel: effectiveFallbackModel,
    fallbackVariant: effectiveFallbackVariant,
    // Already rotated above for quota/provenance correctness; keep order here
    // but still report the opt-in mode so hop logs stay consistent.
    selection: runnerSelection,
    random: () => 0,
    remainingLeaseMs: opts.remainingLeaseMs,
    extendLease: opts.extendLease,
    logger: log,
  });

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
  // Withheld from the persisted/published failure text: forge tokens plus any
  // resolved Anthropic API key the review chain names (values only).
  const failureSecrets: string[] = [opts.giteaToken, ...claudeApiKeySecrets(effectiveChain)];
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
      earlyRepo ?? forgeApi.getRepo(opts.owner, opts.repo),
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

    // Repository settings come from the default branch only, so a pull that
    // adds patterns is still reviewed in full. Missing, invalid, or
    // unreadable means no exclusions: the review runs in full.
    const excludeMatchers = await loadReviewExcludeMatchers({
      api: forgeApi,
      owner: opts.owner,
      repo: opts.repo,
      defaultBranch: repoInfo.default_branch,
      log,
    });
    const { included: includedPrFiles, excluded: excludedPrFiles } = partitionReviewExcludedFiles(
      prFiles,
      excludeMatchers
    );
    const excludedFiles = excludedPrFiles.map((file) => file.filename);
    const excludedSet = new Set(excludedFiles);
    const allExcluded = prFiles.length > 0 && includedPrFiles.length === 0;
    const strippedPrFiles = prFiles.map((file) =>
      excludedSet.has(file.filename) ? { ...file, patch: undefined } : file
    );

    const ids = extractClosingIssueNumbers(pr);
    const linkedResults = await Promise.all(ids.map((id) => loadLinkedIssue(trackerApi, opts.owner, opts.repo, id)));
    const notes: string[] = [];
    if (opts.noCiNote) notes.push(`${opts.noCiNote} Mention it in the review. It is not a finding.`);
    if (excludedFiles.length > 0) {
      const preview = formatExcludedFileList(excludedFiles);
      notes.push(
        allExcluded
          ? `No patches were read: all ${excludedFiles.length} changed file${excludedFiles.length === 1 ? "" : "s"} per \`.jumi.yml\` \`review_exclude\`: ${preview}. Do not review them. Mention it in the review. It is not a finding.`
          : `${excludedFiles.length} changed file${excludedFiles.length === 1 ? " is" : "s are"} left out per \`.jumi.yml\` \`review_exclude\` (patches omitted): ${preview}. Do not review ${excludedFiles.length === 1 ? "it" : "them"}. Mention it in the review. It is not a finding.`
      );
    }
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
    // Writer pull-review bodies and inline feedback are reviewer product
    // context alongside PR discussion and linked-issue comments. The same
    // fetches already drive previous-review tracking; reuse them here so both
    // forges behave the same. Jumi's own reviews/inlines stay out: delta
    // findings already carry them, and bot text must not become a product
    // requirement. Dismissed/stale human reviews stay in: dismissal is not a
    // retraction, and a stale review the worker implemented is not withdrawn.
    const botLower = opts.botUsername.trim().toLowerCase();
    const threadReviews = prReviews.filter((review) => (review.user?.login ?? "").toLowerCase() !== botLower);
    const threadInlines = prInlines.filter((comment) => (comment.user?.login ?? "").toLowerCase() !== botLower);
    const {
      permissions,
      permissionDetail,
      lookups: permissionLookups,
      failures: permissionFailures,
    } = await resolveThreadPermissions(
      forgeApi,
      opts.owner,
      opts.repo,
      prComments,
      linkedIssues,
      threadReviews,
      threadInlines,
      log
    );
    const thread = mapReviewThread({
      prComments,
      linkedIssues,
      pullReviews: threadReviews,
      reviewComments: threadInlines,
      permissions,
      permissionDetail,
    });

    const maxFiles = opts.maxFiles ?? 100;
    const maxPatchBytes = opts.maxPatchBytes ?? 500_000;
    const maxThreadBytes = opts.maxThreadBytes ?? DEFAULT_MAX_THREAD_BYTES;
    const rawPatchBytes = prFiles.reduce((sum, file) => sum + (file.patch ? byteLength(file.patch) : 0), 0);
    const { files, notes: fileNotes } = prepareFiles(strippedPrFiles, maxFiles, maxPatchBytes);
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
    logDiagnostic(log, "review_excludes", {
      review: reviewLabel,
      excluded: excludedFiles.length,
      all_excluded: allExcluded,
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
        maxFiles,
        git,
        cwd: opts.workspace,
        env: gitCmdEnv,
        log,
      });
      if (loaded) {
        const strippedDeltaFiles = loaded.files.map((file) =>
          excludedSet.has(file.filename) ? { ...file, patch: undefined } : file
        );
        const { files: deltaFiles, notes: deltaNotes } = prepareFiles(strippedDeltaFiles, maxFiles, maxPatchBytes);
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
      ...(fitted.thread.pullReviews ?? []),
      ...(fitted.thread.reviewComments ?? []),
      ...fitted.thread.linkedIssues.flatMap((issue) => issue.comments),
    ];
    const productComments = allFittedComments.filter((comment) => comment.intent === "product").length;
    const discussionComments = allFittedComments.filter((comment) => comment.intent === "discussion").length;
    logDiagnostic(log, "review_thread", {
      review: reviewLabel,
      pr_comments: fitted.thread.comments.length,
      pull_reviews: (fitted.thread.pullReviews ?? []).length,
      review_comments: (fitted.thread.reviewComments ?? []).length,
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

    // Repo rules come from the base commit the review diffs against, not the
    // checked-out head, so a PR cannot rewrite the rules that judge it. Read
    // via read-only git: the worktree and the porcelain checks stay untouched.
    // Match against every reviewed file, not only the ones that fit the patch
    // budget; left-out files need no path sections.
    const reviewMd = await loadReviewMdSectionsFromBase({
      git,
      cwd: opts.workspace,
      env: gitCmdEnv,
      baseRef: pr.base.sha,
      files: includedPrFiles,
      maxBytes: opts.maxReviewMdBytes ?? DEFAULT_MAX_REVIEW_MD_BYTES,
    });
    logDiagnostic(log, "review_md", {
      review: reviewLabel,
      injected: Boolean(reviewMd),
      bytes: reviewMd?.bytes ?? 0,
      truncated: reviewMd?.truncated ?? false,
      path_sections: reviewMd?.pathSections ?? 0,
      matched_path_sections: reviewMd?.matchedPathSections ?? 0,
    });

    // Parent-side file history: the latest target-branch commits that touched
    // the files in the diff. Same block for every runner on both forges, and
    // cheap enough for Renovate PRs. A checkout without enough history skips
    // the block with one log line instead of failing the review.
    const recentHistory = await collectRecentHistory({
      git,
      cwd: opts.workspace,
      env: gitCmdEnv,
      files: includedPrFiles.map((file) => file.filename),
      log,
    });
    logDiagnostic(log, "review_history", {
      review: reviewLabel,
      injected: Boolean(recentHistory),
      bytes: recentHistory?.bytes ?? 0,
      truncated: recentHistory?.truncated ?? false,
      commits: recentHistory?.commits.length ?? 0,
    });

    const effectiveBlockingAuthors = await loadEffectiveBlockingQuestionAuthors(
      forgeApi,
      opts.owner,
      opts.repo,
      repoInfo.default_branch?.trim() ? repoInfo.default_branch : "",
      opts.blockingQuestionAuthors,
      log
    );

    const prompt = buildPROpenedPrompt({
      repo: repoInfo,
      pr,
      prFiles: delta ? strippedPrFiles.slice(0, maxFiles) : files,
      reviewNotes: notes,
      ...(ciResults ? { ciResults } : {}),
      thread: fitted.thread,
      delta,
      reviewMd,
      recentHistory,
      blockingQuestions: isBlockingQuestionAuthor(pr.user?.login, effectiveBlockingAuthors),
      ...(excludedFiles.length > 0 ? { excludedFiles } : {}),
      // Written for the first runner in attempt order; a hop keeps this
      // wording while the per-spawn tool enforcement stays exact.
      runnerType: effectiveChain?.[0]?.type,
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
          fallbackModel: effectiveFallbackModel,
          chain: effectiveChain,
          previousError: opts.previousError,
        });
        const quotaReason = quotaStuckReasonForText(engineResult.message);
        if (opts.home || opts.skipLatches || process.env.DATABASE_URL) {
          await markReviewQuotaStuckState(
            {
              home: opts.home,
              owner: opts.owner,
              repo: opts.repo,
              prNumber: opts.prNumber,
              ...(opts.skipLatches ? { skipLatches: opts.skipLatches } : {}),
            },
            quotaReason
          ).catch(() => undefined);
        }
        throw new Error(quotaReason);
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

    const artifactPath = join(opts.workspace, REVIEW_ARTIFACT);
    // A stale JUMI_REVIEW.md planted before this run must not count as this
    // run's output. Porcelain cannot distinguish stale from fresh (and an
    // ignored artifact is absent from porcelain entirely), so clear any
    // pre-existing artifact and read the filesystem directly afterwards.
    await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
    let lastStdout = (await runOpenCode()).stdout;
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

        // Read the artifact directly from the filesystem. An ignored
        // JUMI_REVIEW.md (e.g. via `JUMI_REVIEW.md` or `JUMI_*.md` in
        // .gitignore) is absent from `git status --porcelain` even though it
        // exists, so porcelain must not gate discovery. The dirty-tree check
        // above still guards source modifications; the pre-run removal above
        // guards stale pre-existing output.
        const artifact = await readReviewArtifact(opts.workspace, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
        if (artifact.status === "too_large") {
          return await persistSkipAndStatus("Incomplete review: output too large", currentPR.html_url);
        }
        if (artifact.status !== "missing" && artifact.content.trim()) {
          let markdown = await gatePersonalJumiContractEnv(opts.owner, opts.repo, opts.workspace, artifact.content);
          // The API key lives in the child env (unlike the git token), so a
          // prompt-injected model could echo it into the artifact. Withhold
          // the value from everything persisted or published below.
          markdown = redactGitSecrets(markdown, claudeApiKeySecrets(effectiveChain));
          if (opts.noCiNote && !markdown.includes(opts.noCiNote)) {
            markdown = `${opts.noCiNote}\n\n${markdown}`;
          }
          const parsedArtifact = parseReviewOutput(markdown);
          if (parsedArtifact.verdict.incomplete) {
            if (extrasUsed >= extraCap) {
              return await persistSkipAndStatus(
                "Incomplete review: no check verdict",
                currentPR.html_url,
                INCOMPLETE_REVIEW_STUCK
              );
            }
            extrasUsed++;
            log(`Incomplete review: no check verdict; write-only OpenCode retry (${extrasUsed}/${extraCap})`);
            await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
            const continueSessionNoTrailer = await hasResumableSession(opts.workspace);
            const writePromptNoTrailer = buildNoTrailerWritePrompt(
              continueSessionNoTrailer ? undefined : artifact.content
            );
            lastStdout = (
              await runOpenCode({ prompt: writePromptNoTrailer, continueSession: continueSessionNoTrailer })
            ).stdout;
            continue;
          }
          let blankFailure = false;
          if (parsedArtifact.verdict.state === "failure") {
            const singleFilePath = needsSingleFilePath(parsedArtifact.comment)
              ? await resolveSingleFilePath(forgeApi, opts.owner, opts.repo, opts.prNumber, log)
              : undefined;
            blankFailure = !hasPublishedFindings(parsedArtifact.comment, { singleFilePath });
            if (!blankFailure) {
              const keptArtifact = keepReviewFindingLines(parsedArtifact.comment, { singleFilePath });
              if (hasColonEndingFinding(keptArtifact, { singleFilePath })) {
                logDiagnostic(log, "review_finding_truncated", {
                  review: reviewLabel,
                  reason: "finding_ends_with_colon",
                  kept_bytes: keptArtifact.length,
                });
              }
            }
          }
          if (!blankFailure) {
            await persistOutcome({ kind: "markdown", markdown, ...(runner ? { runner } : {}) });
            if (opts.home || opts.skipLatches || process.env.DATABASE_URL) {
              const stuckRef = {
                home: opts.home,
                owner: opts.owner,
                repo: opts.repo,
                prNumber: opts.prNumber,
                ...(opts.skipLatches ? { skipLatches: opts.skipLatches } : {}),
              };
              // A successful run clears any stale (TTL-expired) quota flag.
              await clearReviewQuotaStuckState(stuckRef).catch(() => undefined);
              const actionHash = fingerprintReviewArtifact(markdown);
              if (actionHash) {
                await appendReviewStuckState(stuckRef, {
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
              blockingQuestionAuthors: effectiveBlockingAuthors,
              automergeRepos: opts.automergeRepos,
              resultMarkdown: markdown,
              resultRunner: runner,
              logger: log,
              forgeKind: opts.forgeKind,
              previousFindings: previousReview?.findings,
              recordSuggestions: opts.recordSuggestions,
              changedFiles: prFiles,
              ...(excludedFiles.length > 0 ? { excludedFiles, allExcluded } : {}),
            });
          }

          if (extrasUsed >= extraCap) {
            return await persistSkipAndStatus(
              INCOMPLETE_NO_FINDINGS_REASON,
              currentPR.html_url,
              INCOMPLETE_REVIEW_STUCK
            );
          }
          extrasUsed++;
          log(`Incomplete review: no findings; write-only OpenCode retry (${extrasUsed}/${extraCap})`);
          await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
          const continueSessionNoFindings = await hasResumableSession(opts.workspace);
          const writePromptNoFindings = buildNoFindingsWritePrompt(
            continueSessionNoFindings ? undefined : artifact.content
          );
          lastStdout = (
            await runOpenCode({ prompt: writePromptNoFindings, continueSession: continueSessionNoFindings })
          ).stdout;
          continue;
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
      // quota (including credit exhaustion, which never waits) falls through
      // to the day-long skip below.
      // The eligible chain keeps exclusions through the wait-budget decision:
      // an excluded author family is never a later model.
      throwIfQuotaWait({
        err,
        model: opts.model,
        fallbackModel: effectiveFallbackModel,
        chain: effectiveChain,
        previousError: opts.previousError,
      });
      const quotaReason = quotaStuckReasonForText(err instanceof Error ? err.message : String(err));
      if (opts.home || opts.skipLatches || process.env.DATABASE_URL) {
        await markReviewQuotaStuckState(
          {
            home: opts.home,
            owner: opts.owner,
            repo: opts.repo,
            prNumber: opts.prNumber,
            ...(opts.skipLatches ? { skipLatches: opts.skipLatches } : {}),
          },
          quotaReason
        ).catch(() => undefined);
      }
      if (!persisted && !persistFailed) {
        await opts.persistResult?.({ kind: "skip", reason: quotaReason });
        await upsertStuckText(forgeApi, opts.owner, opts.repo, opts.prNumber, opts.botUsername, quotaReason);
        const skipped: ReviewResult = { status: "skipped", reason: quotaReason };
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
      if (opts.home || opts.skipLatches || process.env.DATABASE_URL) {
        const errorHash = fingerprintError(message);
        if (errorHash) {
          await appendReviewStuckState(
            {
              home: opts.home,
              owner: opts.owner,
              repo: opts.repo,
              prNumber: opts.prNumber,
              ...(opts.skipLatches ? { skipLatches: opts.skipLatches } : {}),
            },
            {
              kind: "error",
              hash: errorHash,
            }
          ).catch(() => undefined);
        }
      }
      await postReviewStatus(forgeApi, opts.owner, opts.repo, reviewedHeadSha, "failure", message, pr.html_url);
    }
    throw err;
  }
}
