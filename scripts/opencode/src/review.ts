import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AutomergeLabelList,
  hasAutomergeLabel,
  isAutomergeLabelAdmitted,
  isAutomergeOptedIn,
  resolveAutomergeLabelNames,
} from "./automerge.ts";
import {
  branchRequiresReviewCheck,
  CI_ABSENT_NOTE,
  CI_LOOKUP_FAILED_REASON,
  type CiCheckSummary,
  type CiInspection,
  inspectCi,
  isCiLookupRetryMarker,
  isCiWaitMarker,
  JUMI_REVIEW_CONTEXT,
  resolveCiGate,
  resolveRequiredCiContexts,
  reviewSkipReasonForCi,
} from "./ci.ts";
import { isEngineTempPath, porcelainPaths } from "./claimed_worktree.ts";
import { claudeApiKeySecrets } from "./claude_credentials.ts";
import { cleanupJobHarnessTemp } from "./codex_home.ts";
import { byteLength, formatBytes, logDiagnostic, sampleMemory } from "./diagnostics.ts";
import { type Engine, type EngineRunOptions, resolveEngine, resultRunner, throwIfEngineFailed } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import { ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { hasResumableSession, withEngineChain } from "./fallback.ts";
import { forgeCapabilities } from "./forge_capabilities.ts";
import { extractClosingIssueNumbers, extractWorkingIssueNumber, isWipOrDraft } from "./gitea_issues.ts";
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
  buildMalformedTrailerWritePrompt,
  buildMcpIncompletePrompt,
  buildMcpNoFindingsPrompt,
  buildMcpNoVerdictPrompt,
  buildNoFindingsWritePrompt,
  buildNoTrailerWritePrompt,
  buildPROpenedPrompt,
} from "./prompt.ts";
import type { ProvenanceLookup, ProvenanceStore } from "./provenance.ts";
import { isQuotaError, isQuotaText, isQuotaWaitError, quotaStuckReasonForText } from "./quota.ts";
import { hasHealthyRunnerForQuota, throwIfQuotaWait } from "./quota_wait.ts";
import {
  CONTRACT_PATH,
  contractEnvIssues,
  formatContractEnvIssue,
  parseContract,
  REVIEWER_LOADER_PATH,
  WORKER_LOADER_PATH,
} from "./release.ts";
import { fallbackPolicyDeployment, resolveRepoPolicy } from "./repo_policy.ts";
import type { CiGateWait } from "./repo_settings.ts";
import {
  applyRepoChain,
  compileReviewExcludePatterns,
  effectiveReviewBudget,
  effectiveSuggestionCap,
  effectiveTrustedSenderLogins,
  isMaintainerQuestionsHoldEnabled,
  isReviewDraftsEnabled,
  isSuggestionFollowupEnabled,
  isSuggestionHoldEnabled,
  loadEffectiveBlockingQuestionAuthors,
  partitionReviewExcludedFiles,
  prTouchesRepoSettings,
  REPO_SETTINGS_PATH,
  type RepoSettingsLoad,
} from "./repo_settings.ts";
import { type RepoSetupRunScript, runRepoSetupForKind } from "./repo_setup.ts";
import { readStagedBaseFile, stageBaseReviewInstructions } from "./review_base.ts";
import { DEFAULT_MAX_THREAD_BYTES, fitReviewThread, mapReviewThread } from "./review_context.ts";
import { findPreviousReview, isJumiReviewComment, loadReviewDelta, type ReviewDelta } from "./review_delta.ts";
import {
  classifyBlockingFindings,
  normalizeFindingForge,
  normalizeFindingRunner,
  parseBlockingFindings,
  touchedFromFilenames,
} from "./review_findings.ts";
import { collectRecentHistory } from "./review_history.ts";
import { randomReviewMcpToken, startReviewMcpServer } from "./review_mcp.ts";
import { DEFAULT_MAX_REVIEW_MD_BYTES, loadReviewMdSectionsFromBase } from "./review_md.ts";
import {
  countAddressedSuggestions,
  forgeLabelForKind,
  parseSuggestionFindings,
  type ReviewSuggestionCounts,
  runnerLabelForStamp,
} from "./review_suggestions.ts";
import type { ReviewVerdictContract } from "./review_verdict_contract.ts";
import { resolveReviewVerdictContract, verdictContractAllowsFileArtifact } from "./review_verdict_contract.ts";
import { type ReviewRecord, ReviewVerdictStore } from "./review_verdict_store.ts";
import type { RunnerCooldownConfig, RunnerCooldownStore } from "./runner_cooldown.ts";
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
import { INCOMPLETE_REVIEW_STUCK } from "./skip_why_texts.ts";
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
import {
  markSuggestionHoldConsumed,
  readSuggestionHold,
  suggestionHoldPendingDescription,
  suggestionHoldSkippedDescription,
} from "./suggestion_hold.ts";
import type { ReviewJob } from "./types.ts";
import { errorMessage, isAbortError } from "./util/error.ts";
import { loginEqualsNonEmpty } from "./util/login.ts";
import {
  buildCheckTrailer,
  buildFindingsList,
  capSuggestionFindings,
  countBugFindings,
  countMaintainerQuestionFindings,
  countQuestionFindings,
  countRiskFindings,
  countSuggestionFindings,
  describeBlockingReason,
  describeSuccessReason,
  findingFingerprint,
  hasBlockingFindings,
  hasColonEndingFinding,
  isBlockingQuestionAuthor,
  isTrailerShapedLine,
  keepReviewFindingLines,
  lastNonEmptyLine,
  MAX_SUGGESTION_FINDINGS,
  maintainerHoldPendingDescription,
  openQuestionDescription,
  parseCheckLine,
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

type OpenCodeRunner = Engine;
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
  abortSignal?: AbortSignal;
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
  /** Deployment auto-merge switch. Unset defaults to on. Drives the suggestion hold. */
  automergeEnabled?: boolean;
  /** Deployment trusted-sender list for the `automerge` label admission check. Unset falls back to write access. */
  trustedSenderLogins?: readonly string[];
  gitAuthResolver?: GitAuthResolver;
  home?: string;
  /** Postgres ledger for review stuck state. When present (production always
   * passes the engine store), stuck reads/writes use the ledger and never
   * touch the HOME file, so a fresh HOME keeps the same-finding, ping-pong,
   * and quota stops. Absent keeps the legacy HOME file for local/dev. */
  skipLatches?: SkipLatchStore;
  sanitizeOpenCodeEnv?: boolean;
  timeoutMs?: number;
  /** Deployer maximum for repository `setup` runs. Unset falls back to `SETUP_TIMEOUT_MAX_MS`. */
  setupTimeoutMaxMs?: number;
  /** Injectable setup script runner (tests stub the shell). Defaults to spawning `sh -e`. */
  repoSetupRunScript?: RepoSetupRunScript;
  maxFiles?: number;
  maxPatchBytes?: number;
  /** Deployer maxima for the review size budget. Unset each defaults to the deployment value. */
  maxFilesMax?: number;
  maxPatchBytesMax?: number;
  maxThreadBytes?: number;
  /** Byte budget for the base branch's REVIEW.md sections pasted into the prompt. */
  maxReviewMdBytes?: number;
  maxOutputBytes?: number;
  engine?: Engine;
  openCodeRunner?: Engine;
  /**
   * Explicitly selected verdict contract for this job's attempts. `required`
   * keeps the structured MCP verdict mandatory; `legacy` keeps the
   * `JUMI_REVIEW.md` file fallback for runners without structured-tool
   * support. When absent the parent derives it per attempt from that
   * attempt's runner capability.
   */
  verdictContract?: ReviewVerdictContract;
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
  /**
   * Fail-open recorder for per-finding 🔴/🟡 outcomes. Forwarded to
   * `publishReviewResult` alongside the 💡 counts.
   */
  recordFindings?: (rows: import("./review_findings.ts").NewReviewFindingRow[]) => Promise<void>;
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
  /** Per-runner cooldowns: cooled runners are skipped for fresh picks. */
  runnerCooldowns?: RunnerCooldownStore;
  /** Durations for per-runner cooldowns. */
  runnerCooldownConfig?: RunnerCooldownConfig;
  /** Injectable clock for cooldown tests. */
  cooldownNowMs?: () => number;
  /** Current credential fingerprints by runner name; clears auth cooldowns on rotation. */
  authFingerprints?: Record<string, string | undefined>;
}

export type PersistReviewResult =
  | { kind: "markdown"; markdown: string; runner?: string; record?: ReviewRecord }
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
  /** Skip-latch store for the one-hold flag. Absent means no hold tracking (no hold). */
  skipLatches?: SkipLatchStore;
  /** Deployment auto-merge switch. Unset defaults to on. Drives the suggestion hold. */
  automergeEnabled?: boolean;
  /** Deployment trusted-sender list for the `automerge` label admission check. Unset falls back to write access. */
  trustedSenderLogins?: readonly string[];
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
  /**
   * Fail-open recorder for per-finding 🔴/🟡 outcomes. Wired by the engine
   * tick to the ledger; tests may omit it. Receives one row per blocking
   * finding of the previous review (fixed/dismissed/repeated/unmatched).
   */
  recordFindings?: (rows: import("./review_findings.ts").NewReviewFindingRow[]) => Promise<void>;
  /** Review round for the recorded rows (1-based). Defaults to 1. */
  reviewRound?: number;
  /** Writer runner for the recorded rows. Defaults to empty. */
  writerRunner?: string | null;
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

export function reviewJobKey(job: ReviewJob): string {
  return `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`;
}

/**
 * Internal action for a body-only re-review: a follow-up round changed only
 * the Jumi-owned PR body region on a head whose last review failed, so the
 * same head is queued again without a code push. `pull_request edited` stays
 * unhandled: human body edits never use this action and never wake the
 * reviewer through it.
 */
export const BODY_ONLY_REVIEW_ACTION = "followup-body";

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

function reviewEventForVerdict(
  state: "success" | "failure",
  prAuthor: string | undefined,
  botUsername: string
): PullReviewEvent {
  if (loginEqualsNonEmpty(prAuthor, botUsername)) return "COMMENT";
  return state === "success" ? "APPROVED" : "REQUEST_CHANGES";
}

function isSelfReviewRejection(err: unknown, prAuthor: string | undefined, botUsername: string): boolean {
  if (loginEqualsNonEmpty(prAuthor, botUsername)) return true;
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

  let reviews: PullReview[] | undefined;
  try {
    reviews = await opts.api.listPullReviews(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing reviews unavailable: ${errorMessage(err)}`);
  }
  let leftover: InlineComment[] = [];
  try {
    leftover = await opts.api.listPullReviewComments(opts.owner, opts.repo, opts.prNumber, reviews);
  } catch (err) {
    opts.log(`existing inlines unavailable: ${errorMessage(err)}`);
  }

  for (const key of leftoverAttemptedFingerprints(
    leftover,
    attempted,
    opts.marker,
    existingIds,
    reviews ?? [],
    submitted
  )) {
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

  let reviews: PullReview[] | undefined;
  try {
    reviews = await opts.api.listPullReviews(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing reviews unavailable: ${errorMessage(err)}`);
  }
  let existing: InlineComment[] = [];
  try {
    existing = await opts.api.listPullReviewComments(opts.owner, opts.repo, opts.prNumber, reviews);
  } catch (err) {
    opts.log(`existing inlines unavailable: ${errorMessage(err)}`);
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
    reviews: reviews ?? [],
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
      // Re-fetch the review list here instead of reusing the pre-create
      // `reviews`: the review just created above has a new id whose inline
      // `html_url`s would otherwise be missing from the published read.
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
export { INCOMPLETE_REVIEW_STUCK };

const INCOMPLETE_NO_FINDINGS_REASON = "Incomplete review: no findings";

function isPythonBytecodePath(path: string): boolean {
  if (path.split("/").includes("__pycache__")) return true;
  return path.endsWith(".pyc");
}

function isUntrackedPorcelainLine(line: string): boolean {
  return line.startsWith("??");
}

function porcelainOffendingPaths(porcelain: string, limit = 10): string[] {
  const offending: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const untracked = isUntrackedPorcelainLine(line);
    for (const path of porcelainPaths(line)) {
      if (path === REVIEW_ARTIFACT || isEngineTempPath(path)) continue;
      if (untracked && isPythonBytecodePath(path)) continue;
      if (offending.length < limit) offending.push(path);
    }
  }
  return offending;
}

function porcelainAllowsOnlyReviewArtifact(porcelain: string): boolean {
  return porcelainOffendingPaths(porcelain, 1).length === 0;
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

function isPersonalJumiRepo(owner: string, repo: string): boolean {
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
    const message = errorMessage(err);
    return applyContractEnvGate(markdown, [`failed to parse loader env against deploy/contract.md: ${message}`]);
  }
}

/** The pull's author cannot push to the base repository: the review ignores it. */
export const PR_AUTHOR_CANNOT_PUSH = "PR author cannot push to the base repository";

export function skipReasonForPR(pr: Pull): string | undefined {
  if (pr.state !== "open") return `PR is ${pr.state}`;
  if (pr.merged) return "PR is already merged";
  // Bare `wip` / `[wip]` prefixes disable the review. A `wip:` prefix (with
  // the colon) is owned solely by the draft gate below (`skipReasonForDraft`
  // via `isWipOrDraft`), so `review_drafts: true` reviews `WIP:` titles.
  if (/^\s*(wip(?!:)|\[wip\])/i.test(pr.title)) {
    return "PR title disables review";
  }
}

/**
 * Draft / `WIP:` skip for reviews. Returns `"draft or WIP pull request"` when
 * the pull is a draft or has a `WIP:` title and the repository has not opted
 * in via `.jumi.yml` `review_drafts: true`. `PR title disables review`
 * (bare `wip` / `[wip]` prefix, no colon) is a separate mechanism and keeps
 * working.
 */
export function skipReasonForDraft(
  pr: { title: string; draft?: boolean },
  reviewDraftsEnabled: boolean
): string | undefined {
  if (reviewDraftsEnabled) return undefined;
  if (isWipOrDraft(pr)) return "draft or WIP pull request";
  return undefined;
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
      const gate = await resolveCiGate(opts.api, {
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
    requiredContexts = await resolveRequiredCiContexts(opts.api, {
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

async function skipReasonForOtherChecks(
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
        const gate = await resolveCiGate(opts.api, {
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

/**
 * Forge-authoritative closing list for the review context. When the forge
 * exposes `listClosingIssues` (GitHub's `closingIssuesReferences`) that list
 * wins; otherwise (Gitea has no equivalent, or the call fails) fall back to
 * the shared closing-keyword parser, which already ignores code spans,
 * fenced blocks, and quotes. Never throws: failures log and fall back.
 */
export async function resolveClosingIssuesForReview(opts: {
  forge: Pick<ReviewApi, "listClosingIssues">;
  owner: string;
  repo: string;
  prNumber: number;
  pr: Pull;
  log?: (message: string) => void;
}): Promise<{ issues: number[]; source: "forge" | "fallback" }> {
  const fallback = extractClosingIssueNumbers(opts.pr);
  const list = opts.forge.listClosingIssues;
  if (typeof list !== "function") return { issues: fallback, source: "fallback" };
  try {
    const issues = await list.call(opts.forge, opts.owner, opts.repo, opts.prNumber);
    const seen = new Set<number>();
    const result: number[] = [];
    for (const value of issues ?? []) {
      if (!Number.isFinite(value) || value <= 0 || value === opts.pr.number) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return { issues: result, source: "forge" };
  } catch (err) {
    opts.log?.(`closing issues unavailable, falling back to parser: ${errorMessage(err)}`);
    return { issues: fallback, source: "fallback" };
  }
}

export function isTerminalSkipReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (
    reason.startsWith("Incomplete review:") ||
    reason.startsWith("PR head changed from ") ||
    isIndependentReviewRefusal(reason)
  );
}

function activeReviewChain(
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
  const forge = forgeCapabilities(opts.forgeKind).kind;
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

/**
 * One batched `git diff` can cover every file whose forge patch is missing
 * (Gitea's files API has no `patch` field): split the combined output back
 * into per-file patches for the verdict store's hunk map. A forge-supplied
 * patch still wins; only files without one are filled in. Prompt patch
 * budgets and `review_files` byte counts are untouched: this is only the
 * hunk map the MCP validates `add_finding` locations against.
 */
function parseDiffGitHeader(header: string): { a?: string; b?: string } | undefined {
  const rest = header.slice("diff --git ".length);
  const tokens: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quoted) {
      cur += ch;
      if (ch === "\\" && i + 1 < rest.length) {
        cur += rest[i + 1];
        i++;
      } else if (ch === '"') {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      cur += ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  if (tokens.length < 2) return undefined;
  const strip = (token: string, prefix: string): string | undefined => {
    let value = token;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\(["\\])/g, "$1")
        .replace(/\\t/g, "\t");
    }
    if (!value.startsWith(prefix)) return undefined;
    return value.slice(prefix.length);
  };
  return { a: strip(tokens[0] ?? "", "a/"), b: strip(tokens[1] ?? "", "b/") };
}

export function splitGitDiffByFile(diffText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!diffText.trim()) return out;
  const lines = diffText.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) starts.push(i);
  }
  if (starts.length === 0) return out;
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s] ?? 0;
    const end = s + 1 < starts.length ? (starts[s + 1] ?? lines.length) : lines.length;
    const section = lines.slice(start, end).join("\n");
    const paths = parseDiffGitHeader(lines[start] ?? "");
    if (!paths) continue;
    const { a, b } = paths;
    if (b && b !== "dev/null") {
      const prev = out.get(b);
      out.set(b, prev ? `${prev}\n${section}` : section);
    }
    if (a && a !== "dev/null" && a !== b && !out.has(a)) {
      out.set(a, section);
    }
  }
  return out;
}

/** Batched git-diff chunk size for the hunk-map backfill. One `git diff` call covers a whole chunk. */
const MISSING_PATCH_DIFF_BATCH_SIZE = 100;

export async function fillMissingVerdictPatches(opts: {
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  changedFiles: PullFile[];
  excludedFiles?: readonly string[];
  log?: (message: string) => void;
}): Promise<PullFile[]> {
  const excluded = new Set(opts.excludedFiles ?? []);
  const missing = opts.changedFiles.filter(
    (file) => !excluded.has(file.filename) && !(typeof file.patch === "string" && file.patch !== "")
  );
  if (missing.length === 0) return opts.changedFiles;
  const byFile = new Map<string, string>();
  for (let i = 0; i < missing.length; i += MISSING_PATCH_DIFF_BATCH_SIZE) {
    const batch = missing.slice(i, i + MISSING_PATCH_DIFF_BATCH_SIZE);
    const names = batch.map((file) => file.filename);
    let diffText: string;
    try {
      diffText = await opts.git(["diff", "jumi/target...HEAD", "--", ...names], { cwd: opts.cwd, env: opts.env });
    } catch (err) {
      opts.log?.(`git diff for hunk map unavailable: ${errorMessage(err)}`);
      continue;
    }
    if (!diffText.trim()) continue;
    for (const [name, section] of splitGitDiffByFile(diffText)) {
      const prev = byFile.get(name);
      byFile.set(name, prev ? `${prev}\n${section}` : section);
    }
  }
  if (byFile.size === 0) return opts.changedFiles;
  return opts.changedFiles.map((file) => {
    if (excluded.has(file.filename)) return file;
    if (typeof file.patch === "string" && file.patch !== "") return file;
    const patch = byFile.get(file.filename);
    if (!patch) return file;
    return { ...file, patch };
  });
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
      opts.log(`settings pull files unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
      return undefined;
    }
    touches = prTouchesRepoSettings(files);
  }
  if (!touches) return undefined;
  let settings: RepoSettingsLoad;
  try {
    settings = (
      await resolveRepoPolicy(
        { api: opts.api, owner: opts.owner, repo: opts.repo, ref: opts.headSha },
        fallbackPolicyDeployment(),
        { onUnreadable: "throw" }
      )
    ).load;
  } catch (err) {
    opts.log(`settings head unreadable for ${opts.owner}/${opts.repo}@${opts.headSha}: ${errorMessage(err)}`);
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
    opts.log(`settings branch unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
    return undefined;
  }
  const required = branchRequiresReviewCheck(branch);
  if (!required) return undefined;
  return `${REPO_SETTINGS_PATH} sets mode: off, but \`${JUMI_REVIEW_CONTEXT}\` is required on ${opts.baseBranch}; pull requests would become unable to merge`;
}

/** Max left-out files named in the published note; longer lists name the count. */
const MAX_LISTED_EXCLUDED_FILES = 10;

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
  let settings: RepoSettingsLoad;
  try {
    settings = (
      await resolveRepoPolicy({ api: opts.api, owner: opts.owner, repo: opts.repo, ref }, fallbackPolicyDeployment(), {
        onUnreadable: "throw",
      })
    ).load;
  } catch (err) {
    opts.log(`review excludes unreadable for ${opts.owner}/${opts.repo}@${ref}: ${errorMessage(err)}`);
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
  // Effective blocking authors and suggestion cap: the deployer list plus the
  // repository's default-branch file. Read from the default branch only so a
  // change takes effect when it reaches the default branch. Fail-open to the
  // deployer list and ceiling: a missing, invalid, or unreadable file
  // contributes nothing.
  let blockingQuestionAuthors = opts.blockingQuestionAuthors;
  let suggestionCap = MAX_SUGGESTION_FINDINGS;
  let settingsForHold: RepoSettingsLoad | undefined;
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
      try {
        const settingsLoad = (
          await resolveRepoPolicy(
            { api: forgeApi, owner: opts.owner, repo: opts.repo, ref: defaultBranch },
            fallbackPolicyDeployment(),
            { onUnreadable: "throw" }
          )
        ).load;
        settingsForHold = settingsLoad;
        if (settingsLoad.state === "valid") {
          suggestionCap = effectiveSuggestionCap(settingsLoad, MAX_SUGGESTION_FINDINGS);
          const draftSkipEarly = skipReasonForDraft(pr, isReviewDraftsEnabled(settingsLoad));
          if (draftSkipEarly) {
            const result: ReviewResult = { status: "skipped", reason: draftSkipEarly };
            const { state, description } = statusForResult(result);
            await postReviewStatus(
              forgeApi,
              opts.owner,
              opts.repo,
              opts.expectedHeadSha,
              state,
              description,
              pr.html_url
            );
            return result;
          }
        } else if (isWipOrDraft(pr)) {
          const result: ReviewResult = { status: "skipped", reason: "draft or WIP pull request" };
          const { state, description } = statusForResult(result);
          await postReviewStatus(
            forgeApi,
            opts.owner,
            opts.repo,
            opts.expectedHeadSha,
            state,
            description,
            pr.html_url
          );
          return result;
        }
      } catch {
        if (isWipOrDraft(pr)) {
          const result: ReviewResult = { status: "skipped", reason: "draft or WIP pull request" };
          const { state, description } = statusForResult(result);
          await postReviewStatus(
            forgeApi,
            opts.owner,
            opts.repo,
            opts.expectedHeadSha,
            state,
            description,
            pr.html_url
          );
          return result;
        }
      }
    } else if (isWipOrDraft(pr)) {
      const result: ReviewResult = { status: "skipped", reason: "draft or WIP pull request" };
      const { state, description } = statusForResult(result);
      await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
      return result;
    }
  } catch {
    // Fail-open: the deployer list still applies.
    if (isWipOrDraft(pr)) {
      const result: ReviewResult = { status: "skipped", reason: "draft or WIP pull request" };
      const { state, description } = statusForResult(result);
      await postReviewStatus(forgeApi, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
      return result;
    }
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
  // A failure trailer with no actionable published finding is an incomplete
  // review: the trailer reason is not a finding, and prose the publisher
  // drops must not become a blank required-check failure. A failure that
  // publishes only non-blocking findings (💡/❓) or marker-only lines with
  // neither a location nor a body of their own is incomplete for the same
  // reason: a "N blocking" trailer with no open 🔴/🟡 finding would fail the
  // check with nothing actionable. Success with no findings stays clean.
  if (
    !parsed.verdict.incomplete &&
    parsed.verdict.state === "failure" &&
    !hasBlockingFindings(parsed.comment, { singleFilePath })
  ) {
    logDiagnostic(log, "review_trailer_counts", {
      review: reviewLabel,
      model: parsed.verdict.description,
      published: "0 blocking",
      state: "failure",
    });
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
  // Parent-enforced 💡 cap: the repository `max_suggestions` (ceiling
  // MAX_SUGGESTION_FINDINGS) publish. 🔴/🟡/❓ are never dropped. The dropped
  // count rides in one body line so the next follow-up still sees the trailer
  // but not a wall of suggestions.
  const capped = capSuggestionFindings(kept, { singleFilePath, keep: [CI_ABSENT_NOTE], maxSuggestions: suggestionCap });
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
  if (opts.recordFindings && opts.previousFindings && opts.previousFindings.length > 0) {
    try {
      const prevBlocking = parseBlockingFindings(opts.previousFindings.join("\n\n"), { singleFilePath });
      const currBlocking = parseBlockingFindings(comment, { singleFilePath });
      const touched = touchedFromFilenames((opts.changedFiles ?? []).map((file) => file.filename));
      const classified = classifyBlockingFindings(prevBlocking, currBlocking, touched);
      const rows = classified.map((entry) => ({
        forge: normalizeFindingForge(opts.forgeKind),
        owner: opts.owner,
        repo: opts.repo,
        prNumber: opts.prNumber,
        severity: entry.prev.severity,
        reviewerRunner: normalizeFindingRunner(opts.resultRunner),
        writerRunner: (opts.writerRunner ?? "").trim(),
        reviewRound: opts.reviewRound ?? 1,
        outcome: entry.outcome,
        fingerprint: entry.fingerprint,
        path: entry.prev.path,
        line: entry.prev.line,
      }));
      await opts.recordFindings(rows);
      logDiagnostic(log, "review_findings", { review: reviewLabel, findings: rows.length });
    } catch (err) {
      log(`finding metrics unavailable: ${errorMessage(err)}`);
    }
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
  // Trailer and status counts come from the findings that actually publish,
  // never from the model's free-text reason: a model that writes "1 blocking"
  // while the store holds two open bugs (or only a stale summary) would
  // otherwise fail the check with a count that matches no open finding.
  const publishedBugs = countBugFindings(comment, { singleFilePath });
  const publishedRisks = countRiskFindings(comment, { singleFilePath });
  const publishedSuggestions = countSuggestionFindings(comment, { singleFilePath });
  const publishedFailureReason = describeBlockingReason(publishedBugs, publishedRisks);
  // The success trailer names open maintainer questions next to suggestions
  // when the maintainer hold applies, built from the published findings like
  // the suggestion count is. The status description stays the pending hold
  // note; the failure trailer stays blocking-only.
  const publishedMaintainers = countMaintainerQuestionFindings(comment, { singleFilePath });
  const countedMaintainers = isMaintainerQuestionsHoldEnabled(settingsForHold) ? publishedMaintainers : 0;
  const publishedSuccessReason = describeSuccessReason(publishedSuggestions, countedMaintainers);
  const effectiveVerdict =
    blockingQuestions > 0
      ? { state: "failure" as const, description: openQuestionDescription(blockingQuestions), incomplete: false }
      : parsed.verdict.incomplete
        ? parsed.verdict
        : parsed.verdict.state === "failure"
          ? { state: "failure" as const, description: publishedFailureReason, incomplete: false }
          : {
              state: "success" as const,
              description: publishedSuccessReason || "No blocking issues",
              incomplete: false as const,
            };
  if (!parsed.verdict.incomplete && parsed.verdict.description !== effectiveVerdict.description) {
    logDiagnostic(log, "review_trailer_counts", {
      review: reviewLabel,
      model: parsed.verdict.description,
      published: effectiveVerdict.description,
      state: effectiveVerdict.state,
    });
  }
  // The published trailer carries the same parent-computed counts. A bare
  // model trailer (no reason of its own) stays bare, except a success review
  // with open maintainer questions gains its maintainer count so the hold is
  // visible in the trailer; any model-written reason is replaced so stale
  // counts never publish. The reason is sanitized so a `>` in free text can
  // never break the single-line trailer.
  const modelReason = parsed.checkLine ? (parseCheckLine(parsed.checkLine)?.reason ?? "") : "";
  const needsMaintainerTrailer =
    countedMaintainers > 0 && !parsed.verdict.incomplete && parsed.verdict.state === "success";
  const publishedCheckLine =
    modelReason.trim() !== "" || needsMaintainerTrailer
      ? buildCheckTrailer(effectiveVerdict.state, effectiveVerdict.description)
      : parsed.checkLine;
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
  const stickyBody = buildCommentBody(marker, opts.expectedHeadSha, comment, publishedCheckLine, opts.resultRunner);

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
        checkLine: publishedCheckLine,
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

  let { state, description } = statusForResult(result, effectiveVerdict);
  // Suggestion hold: in an auto-merge repository, an open-suggestion-only
  // success holds the merge for one follow-up round by posting `pending`
  // instead of `success`. Blocking questions and failures take precedence
  // (they already failed above), and non-auto-merge repositories keep
  // today's behavior exactly.
  const holdSuggestionCount =
    !parsed.verdict.incomplete && effectiveVerdict.state === "success" && blockingQuestions === 0
      ? publishedSuggestions
      : 0;
  // One policy helper decides the hold so reviews and tests read the same
  // rule: auto-merge on, deployment switch on, full mode, no opt-out.
  // The opt-in answer is shared with `automerge.ts`: the repository file or
  // an admitted `automerge` label on the PR (same labeller trust check and
  // custom label names), never with `no-automerge`.
  // Follow-up off and restricted mode still post `success`, with a note
  // naming why, so the merge never waits on a follow-up that cannot run.
  const holdDeployOn = opts.automergeEnabled ?? true;
  let holdOptedIn = false;
  let holdForcedByLabel = false;
  if (holdSuggestionCount > 0 && holdDeployOn && settingsForHold) {
    try {
      const prLabels = (pr.labels ?? []) as AutomergeLabelList;
      const names = resolveAutomergeLabelNames(settingsForHold);
      const hasNo = hasAutomergeLabel(prLabels, names.noAutomergeLabel);
      const hasAuto = hasAutomergeLabel(prLabels, names.automergeLabel);
      if (!hasNo) {
        if (hasAuto) {
          const effectiveTrusted = effectiveTrustedSenderLogins(opts.trustedSenderLogins, settingsForHold);
          const closerForLabel = extractWorkingIssueNumber(pr) ?? pr.number;
          const verdict = await isAutomergeLabelAdmitted({
            api: forgeApi,
            owner: opts.owner,
            repo: opts.repo,
            prNumber: pr.number,
            issueNumber: closerForLabel,
            automergeLabel: names.automergeLabel,
            botUsername: opts.botUsername,
            trustedSenderLogins: effectiveTrusted,
            log,
          });
          holdForcedByLabel = verdict.admitted;
          holdOptedIn = isAutomergeOptedIn(settingsForHold, prLabels, verdict.admitted);
        } else {
          holdOptedIn = isAutomergeOptedIn(settingsForHold, prLabels, false);
        }
      }
    } catch (err) {
      log(`suggestion hold labels unreadable for ${reviewLabel}: ${errorMessage(err)}`);
    }
  }
  const holdEnabled =
    holdSuggestionCount > 0 &&
    holdOptedIn &&
    settingsForHold != null &&
    isSuggestionHoldEnabled(settingsForHold, holdDeployOn, holdForcedByLabel) &&
    isSuggestionFollowupEnabled(settingsForHold);
  if (holdEnabled && opts.skipLatches) {
    try {
      const closer = extractWorkingIssueNumber(pr) ?? pr.number;
      const latchKey = { owner: opts.owner, repo: opts.repo, issueNumber: closer };
      const hold = await readSuggestionHold(opts.skipLatches, latchKey);
      if (!hold.consumed) {
        await markSuggestionHoldConsumed(opts.skipLatches, latchKey, opts.expectedHeadSha, holdSuggestionCount);
        state = "pending";
        description = suggestionHoldPendingDescription(holdSuggestionCount);
        logDiagnostic(log, "review_suggestion_hold", {
          review: reviewLabel,
          head: opts.expectedHeadSha,
          suggestions: holdSuggestionCount,
        });
      }
    } catch (err) {
      log(`suggestion hold unavailable for ${reviewLabel}: ${errorMessage(err)}`);
    }
  } else if (
    holdSuggestionCount > 0 &&
    holdOptedIn &&
    settingsForHold != null &&
    holdDeployOn &&
    !isSuggestionFollowupEnabled(settingsForHold)
  ) {
    state = "success";
    description = suggestionHoldSkippedDescription(holdSuggestionCount, "suggestions disabled");
  } else if (
    holdSuggestionCount > 0 &&
    holdOptedIn &&
    settingsForHold?.state === "valid" &&
    holdDeployOn &&
    settingsForHold.mode !== "full"
  ) {
    state = "success";
    description = suggestionHoldSkippedDescription(holdSuggestionCount, "mode restricted");
  }
  // An explicit `suggestions_hold_merge: false` opt-out and a missing latch
  // store keep today's success silently: the follow-up still runs as today.
  // Maintainer hold: an open `❓ maintainer:` on a success review posts
  // `pending` instead of `success` so the required check gates every merge
  // (Jumi-owned, label-forced, `automerge: true`, or hand-scheduled) until a
  // maintainer answers. Failures and opt-in blocking questions take
  // precedence (they already failed above); the worker still never starts for
  // a maintainer-only review (see the handover skip). Unlike the suggestion
  // hold this is not one-shot: every review with an open maintainer question
  // holds. An explicit `maintainer_questions_hold_merge: false` opts out.
  const holdMaintainerCount =
    !parsed.verdict.incomplete && effectiveVerdict.state === "success" && blockingQuestions === 0
      ? countMaintainerQuestionFindings(comment, { singleFilePath })
      : 0;
  if (holdMaintainerCount > 0 && isMaintainerQuestionsHoldEnabled(settingsForHold)) {
    state = "pending";
    description = maintainerHoldPendingDescription(holdMaintainerCount);
    logDiagnostic(log, "review_maintainer_hold", {
      review: reviewLabel,
      head: opts.expectedHeadSha,
      questions: holdMaintainerCount,
    });
  }
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
    log(`runner settings repo unreadable for ${repoFullName}#${opts.prNumber}: ${errorMessage(err)}`);
  }
  const defaultBranch = earlyRepo?.default_branch ?? "";
  // Draft / WIP: reviews run only when the repository opts in via
  // `.jumi.yml` `review_drafts: true`. Fail-open to today's skip so an
  // unreadable file never reviews a draft by accident. Worker eligibility
  // stays draft-excluded elsewhere, so only this review gate opens.
  let repoBudgetLoad: RepoSettingsLoad | undefined;
  {
    const branch = (defaultBranch ?? "").trim();
    if (branch) {
      try {
        repoBudgetLoad = (
          await resolveRepoPolicy(
            { api: forgeApi, owner: opts.owner, repo: opts.repo, ref: branch },
            fallbackPolicyDeployment(),
            { onUnreadable: "throw" }
          )
        ).load;
      } catch (err) {
        log(`review settings unreadable for ${repoFullName}@${branch}: ${errorMessage(err)}`);
        repoBudgetLoad = undefined;
      }
    }
    const draftsEnabled = repoBudgetLoad?.state === "valid" ? isReviewDraftsEnabled(repoBudgetLoad) : false;
    const draftSkip = skipReasonForDraft(pr, draftsEnabled);
    if (draftSkip) return { status: "skipped", reason: draftSkip };
  }
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
      const gate = await resolveCiGate(forgeApi, {
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
      const reason = provenanceLookupFailureReason(reviewedHeadSha, errorMessage(err));
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
  // artifact-recovery calls reuse this order via the engine wrapper. Cooled
  // runners are excluded before the pick so a dead runner is not rediscovered.
  const runnerSelection = resolveRunnerSelection({ selection: opts.runnerSelection ?? undefined });
  const cooldownOrdering = opts.runnerCooldowns
    ? {
        cooldowns: opts.runnerCooldowns,
        nowMs: opts.cooldownNowMs?.() ?? Date.now(),
        logger: log,
        ...(opts.authFingerprints ? { fingerprints: opts.authFingerprints } : {}),
      }
    : undefined;
  if (effectiveChain && effectiveChain.length > 1) {
    const rotated = opts.failedRunner
      ? orderChainForRetry(
          effectiveChain,
          runnerSelection,
          opts.runnerRandom ?? Math.random,
          opts.failedRunner,
          cooldownOrdering
        )
      : orderChainForJob(effectiveChain, runnerSelection, opts.runnerRandom ?? Math.random, cooldownOrdering);
    if (rotated.length === effectiveChain.length || (cooldownOrdering && rotated.length > 0)) {
      logDiagnostic(log, "runner_selection", {
        review: `${repoFullName}#${pr.number}`,
        head: reviewedHeadSha,
        selection: runnerSelection,
        start: rotated[0]?.name ?? null,
        order: describeAttemptOrder(rotated),
      });
    }
    effectiveChain = rotated;
  } else if (effectiveChain && cooldownOrdering && effectiveChain.length > 0) {
    const filtered = orderChainForJob(
      effectiveChain,
      runnerSelection,
      opts.runnerRandom ?? Math.random,
      cooldownOrdering
    );
    if (filtered.length !== effectiveChain.length) effectiveChain = filtered;
  }

  // Per-attempt verdict contract, selected before each runner spawn from that
  // spawn's runner and reused when validating its result. An explicit mode
  // wins; otherwise the runner's structured-tool capability decides. A
  // failure never reselects: the attempt keeps the contract it started with.
  let attemptContract = resolveReviewVerdictContract({
    runnerType: effectiveChain?.[0]?.type,
    explicit: opts.verdictContract,
  });
  const baseEngine = resolveEngine(opts, registeredEngine);
  const contractEngine: Engine = async (engineOpts) => {
    attemptContract = resolveReviewVerdictContract({
      runnerType: engineOpts.type,
      explicit: opts.verdictContract,
    });
    logDiagnostic(log, "verdict_contract", {
      review: `${repoFullName}#${pr.number}`,
      head: reviewedHeadSha,
      runner: engineOpts.runnerName ?? engineOpts.type ?? null,
      contract: attemptContract,
    });
    // The adapter's exit-zero artifact gate must match this attempt's
    // selected contract, so structured-verdict spawns reach the parent's MCP
    // validation without a checkout file.
    return baseEngine({ ...engineOpts, verdictContract: attemptContract });
  };
  const engine = withEngineChain(contractEngine, {
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
    ...(opts.runnerCooldowns ? { runnerCooldowns: opts.runnerCooldowns } : {}),
    ...(opts.runnerCooldownConfig ? { runnerCooldownConfig: opts.runnerCooldownConfig } : {}),
    ...(opts.cooldownNowMs ? { cooldownNowMs: opts.cooldownNowMs } : {}),
    ...(opts.authFingerprints ? { authFingerprints: opts.authFingerprints } : {}),
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
    const [repoInfo, prFiles, prCommentResult, prReviews] = await Promise.all([
      earlyRepo ?? forgeApi.getRepo(opts.owner, opts.repo),
      forgeApi.getPRFiles(opts.owner, opts.repo, pr.number),
      loadPrComments(forgeApi, opts.owner, opts.repo, pr.number),
      forgeApi.listPullReviews(opts.owner, opts.repo, pr.number).catch((err: unknown): PullReview[] | undefined => {
        log(`previous reviews unavailable: ${errorMessage(err)}`);
        return undefined;
      }),
    ]);
    // Reuse the review list fetched above so the review-list pages are
    // requested exactly once per evaluation. `undefined` on a review-list
    // failure retries the fetch inside the inline read instead of silently
    // forcing inlines to `[]`.
    const prInlines = await forgeApi
      .listPullReviewComments(opts.owner, opts.repo, pr.number, prReviews)
      .catch((err: unknown): InlineComment[] => {
        log(`previous inlines unavailable: ${errorMessage(err)}`);
        return [];
      });
    const previousReview = findPreviousReview({
      comments: prCommentResult.comments,
      reviews: prReviews ?? [],
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

    const closing = await resolveClosingIssuesForReview({
      forge: forgeApi,
      owner: opts.owner,
      repo: opts.repo,
      prNumber: pr.number,
      pr,
      log,
    });
    const parserIds = extractClosingIssueNumbers(pr);
    const ids = [...new Set([...closing.issues, ...parserIds])];
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
    const threadReviews = (prReviews ?? []).filter((review) => (review.user?.login ?? "").toLowerCase() !== botLower);
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

    const deploymentMaxFiles = opts.maxFiles ?? 100;
    const deploymentMaxPatchBytes = opts.maxPatchBytes ?? 500_000;
    const deploymentMaxFilesMax = opts.maxFilesMax ?? deploymentMaxFiles;
    const deploymentMaxPatchBytesMax = opts.maxPatchBytesMax ?? deploymentMaxPatchBytes;
    const budget =
      repoBudgetLoad?.state === "valid"
        ? effectiveReviewBudget(repoBudgetLoad, {
            maxFiles: deploymentMaxFiles,
            maxFilesMax: deploymentMaxFilesMax,
            maxPatchBytes: deploymentMaxPatchBytes,
            maxPatchBytesMax: deploymentMaxPatchBytesMax,
          })
        : { maxFiles: deploymentMaxFiles, maxPatchBytes: deploymentMaxPatchBytes };
    const maxFiles = budget.maxFiles;
    const maxPatchBytes = budget.maxPatchBytes;
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
      abortSignal: opts.abortSignal,
    });

    // Post-checkout git commands below are deliberately not abortable (known
    // limitation): `opts.gitRunner ?? runGit` calls without a signal,
    // `replay.ts` runners, and `fallback.ts` `git status` spawns are short
    // local commands, not network clone/fetch.
    const git = opts.gitRunner ?? runGit;
    const gitCmdEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      GIT_TERMINAL_PROMPT: "0",
    };

    // Repository preparation step (`.jumi.yml` `setup`, default branch only).
    // Once per job, after the checkout is ready and before the first engine
    // spawn. Skipped reviews never reach here, so no setup runs for them.
    let repoSetupBlock: string | undefined;
    {
      const defaultBranchName = repoInfo.default_branch?.trim() ? repoInfo.default_branch : "";
      const setup = await runRepoSetupForKind({
        api: forgeApi,
        kind: "review",
        workdir: opts.workspace,
        defaultBranch: defaultBranchName || undefined,
        auth: gitAuth,
        owner: opts.owner,
        repo: opts.repo,
        home: opts.home,
        timeoutMaxMs: opts.setupTimeoutMaxMs,
        log,
        git,
        gitEnv: gitCmdEnv,
        runScript: opts.repoSetupRunScript,
      });
      if (setup.ran) {
        repoSetupBlock = setup.promptBlock;
        if (setup.failureReason) {
          // Repository setup runs once before the first attempt and stays
          // observable here; it never reselects that attempt's contract.
          await opts.persistResult?.({ kind: "skip", reason: setup.failureReason });
          await postReviewStatus(
            forgeApi,
            opts.owner,
            opts.repo,
            reviewedHeadSha,
            "failure",
            setup.failureReason,
            pr.html_url
          );
          return { status: "skipped", reason: setup.failureReason };
        }
      }
    }

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

    // Base-branch instructions and skills. The head never configures its
    // reviewer: AGENTS.md/CLAUDE.md and both skill roots come from the base
    // commit via read-only git and are staged outside the tracked checkout
    // (under the spawn's `.jumi-tmp`). Runners load that copy through their
    // own project-off switches; the head's copies stay on disk as diff
    // content only.
    const baseInstructionsDir = join(opts.workspace, ".jumi-tmp", "base-instructions");
    let baseInstructions: { text: string; truncated: boolean } | undefined;
    try {
      const staged = await stageBaseReviewInstructions(
        { git, cwd: opts.workspace, env: gitCmdEnv, baseRef: pr.base.sha },
        baseInstructionsDir,
        { maxBytes: opts.maxReviewMdBytes ?? DEFAULT_MAX_REVIEW_MD_BYTES }
      );
      const parts: string[] = [];
      for (const name of ["AGENTS.md", "CLAUDE.md"] as const) {
        const text = await readStagedBaseFile(baseInstructionsDir, name);
        if (text?.trim()) parts.push(text.trim());
      }
      if (parts.length > 0) {
        const text = parts.join("\n\n");
        baseInstructions = { text, truncated: staged.truncated };
      }
      logDiagnostic(log, "review_base", {
        review: reviewLabel,
        files: staged.files.length,
        skills: staged.skills.length,
        bytes: staged.bytes,
        truncated: staged.truncated,
      });
    } catch (err) {
      log(`base instructions unavailable: ${errorMessage(err)}`);
    }

    const prompt = buildPROpenedPrompt({
      repo: repoInfo,
      pr,
      prFiles: delta ? strippedPrFiles.slice(0, maxFiles) : files,
      reviewNotes: notes,
      ...(ciResults ? { ciResults } : {}),
      thread: fitted.thread,
      delta,
      reviewMd,
      ...(baseInstructions ? { baseInstructions } : {}),
      recentHistory,
      blockingQuestions: isBlockingQuestionAuthor(pr.user?.login, effectiveBlockingAuthors),
      ...(excludedFiles.length > 0 ? { excludedFiles } : {}),
      closingIssues: closing.issues,
      // Written for the first runner in attempt order; `resolveOpenCodePrompt`
      // rewords the file's guidance per attempt from the actual runner.
      runnerType: effectiveChain?.[0]?.type,
      ...(repoSetupBlock ? { repoSetupBlock } : {}),
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

    // Stamp for the spawn that produced the verdict; after a hop, the runner that ran.
    let runner: string | undefined;
    // Parent-owned per-spawn review verdict server. The model records findings
    // and the verdict through MCP tools; the parent publishes from this
    // in-memory state, never from a file. The token rides only in the harness
    // MCP config under the spawn temp root, never in the prompt or the child
    // env. Single-domain sandbox limit: that temp root is under the RW
    // checkout (`.jumi-tmp`), so sandboxed pull code can still read the token
    // file and call the server (see docs/review-sandbox.md). When the store
    // holds anything at exit it wins and any JUMI_REVIEW.md in the worktree
    // is ignored (transition fallback for runners without tool support).
    // Gitea's files API has no `patch` field, so a changed file would have no
    // hunk set and every located `add_finding` would fail as "line outside
    // hunks". Fill those gaps from the review checkout (`jumi/target` is the
    // base, HEAD is the pull head) with the same unified-diff shape GitHub
    // supplies. A forge patch still wins; files that stay hunkless (binary,
    // pure renames) keep rejecting located findings with a hint to record
    // them unlocated. Prompt budgets and `review_files` counts use the forge
    // patches only.
    const verdictChangedFiles = await fillMissingVerdictPatches({
      git,
      cwd: opts.workspace,
      env: gitCmdEnv,
      changedFiles: prFiles,
      ...(excludedFiles.length > 0 ? { excludedFiles } : {}),
      log,
    });
    const verdictStore = new ReviewVerdictStore({
      changedFiles: verdictChangedFiles,
      ...(excludedFiles.length > 0 ? { excludedFiles } : {}),
      ...((delta?.findings ?? previousReview?.findings)?.length
        ? { previousFindings: (delta?.findings ?? previousReview?.findings) as string[] }
        : {}),
    });
    const reviewMcpToken = randomReviewMcpToken();
    // Structured-verdict adapter setup. A failure is observable and never
    // changes this attempt's contract: required mode fails closed here
    // instead of silently falling back to the file, while legacy mode keeps
    // the file path without the adapter.
    let reviewMcpServer: { url: string; close: () => void } | undefined;
    let reviewMcpRef: { url: string; token: string } | undefined;
    try {
      reviewMcpServer = await startReviewMcpServer({ store: verdictStore, token: reviewMcpToken });
      reviewMcpRef = { url: reviewMcpServer.url, token: reviewMcpToken };
    } catch (err) {
      const reason = `Incomplete review: verdict adapter unavailable: ${errorMessage(err)}`;
      log(reason);
      if (!verdictContractAllowsFileArtifact(attemptContract)) {
        verdictStore.close();
        await opts.persistResult?.({ kind: "skip", reason });
        await postReviewStatus(forgeApi, opts.owner, opts.repo, reviewedHeadSha, "failure", reason, pr.html_url);
        return { status: "skipped", reason };
      }
    }
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
        sanitizeEnv: opts.sanitizeOpenCodeEnv ?? true,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
        reviewLabel,
        forgeUrl: opts.giteaUrl,
        logger: log,
        abortSignal: opts.abortSignal,
        ...(extra?.continueSession ? { continueSession: true } : {}),
        // Staged base-branch instructions for the runners' project-off
        // switches (outside the tracked checkout). Workers never set this.
        baseInstructionsDir,
        trace: {
          kind: "review",
          owner: opts.owner,
          repo: opts.repo,
          sha: reviewedHeadSha,
          jobId: opts.jobId,
        },
        reviewMcp: reviewMcpRef,
        verdictContract: attemptContract,
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
          ...(opts.runnerCooldowns ? { runnerCooldowns: opts.runnerCooldowns } : {}),
          ...(opts.cooldownNowMs ? { nowMs: opts.cooldownNowMs() } : {}),
          ...(opts.authFingerprints ? { cooldownFingerprints: opts.authFingerprints } : {}),
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

    const publishMcpVerdict = async (htmlUrl?: string): Promise<ReviewResult> => {
      const storedVerdict = verdictStore.getVerdict();
      const markdown = verdictStore.toMarkdown();
      let gated = await gatePersonalJumiContractEnv(opts.owner, opts.repo, opts.workspace, markdown);
      gated = redactGitSecrets(gated, claudeApiKeySecrets(effectiveChain));
      if (opts.noCiNote && !gated.includes(opts.noCiNote)) {
        gated = `${opts.noCiNote}\n\n${gated}`;
      }
      const parsed = parseReviewOutput(gated);
      if (parsed.verdict.incomplete && storedVerdict) {
        logDiagnostic(log, "review_trailer_unparsable", {
          review: reviewLabel,
          stored_state: storedVerdict.state,
          stored_reason: storedVerdict.reason ?? "",
        });
        // A recorded verdict must never become "no findings" because the
        // trailer text failed to parse: republish from the stored verdict
        // with a sanitized reason. With `toMarkdown()` sanitizing at build
        // time this repair is unreachable; it guards future regressions.
        const repaired = storedVerdict.reason
          ? `${parsed.comment ? `${parsed.comment}\n` : ""}${buildCheckTrailer(storedVerdict.state, storedVerdict.reason)}`
          : `${parsed.comment ? `${parsed.comment}\n` : ""}${buildCheckTrailer(storedVerdict.state)}`;
        return await publishMarkdownVerdict(repaired);
      }
      if (parsed.verdict.state === "failure" && !hasBlockingFindings(parsed.comment)) {
        return await persistSkipAndStatus(INCOMPLETE_NO_FINDINGS_REASON, htmlUrl, INCOMPLETE_REVIEW_STUCK);
      }
      // The stored record is only valid for the exact markdown the store
      // produced. Any post-processing above (contract-env gate, secret
      // redaction, the no-CI note, or the trailer repair branch) means the
      // persisted markdown no longer matches the record, so persist no
      // record: a stored record must never disagree with the stored markdown.
      const record = gated === markdown ? verdictStore.toRecord() : undefined;
      return await publishMarkdownVerdict(gated, record);
    };
    const artifactPath = join(opts.workspace, REVIEW_ARTIFACT);
    // A stale JUMI_REVIEW.md planted before this run must not count as this
    // run's output. Porcelain cannot distinguish stale from fresh (and an
    // ignored artifact is absent from porcelain entirely), so clear any
    // pre-existing artifact and read the filesystem directly afterwards.
    // The MCP store wins over the file below: when it holds anything, the
    // file (e.g. planted by a fake child) is ignored.
    await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
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
    // Shared publish tail for the MCP-verdict and file-artifact branches:
    // gated markdown in, quota-state bookkeeping and forge publish out.
    const publishMarkdownVerdict = async (gatedMarkdown: string, record?: ReviewRecord): Promise<ReviewResult> => {
      await persistOutcome({
        kind: "markdown",
        markdown: gatedMarkdown,
        ...(runner ? { runner } : {}),
        ...(record ? { record } : {}),
      });
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
        const actionHash = fingerprintReviewArtifact(gatedMarkdown);
        if (actionHash) {
          await appendReviewStuckState(stuckRef, { kind: "action", hash: actionHash });
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
        ...(opts.skipLatches ? { skipLatches: opts.skipLatches } : {}),
        ...(opts.automergeEnabled !== undefined ? { automergeEnabled: opts.automergeEnabled } : {}),
        ...(opts.trustedSenderLogins !== undefined ? { trustedSenderLogins: opts.trustedSenderLogins } : {}),
        resultMarkdown: gatedMarkdown,
        resultRunner: runner,
        logger: log,
        forgeKind: opts.forgeKind,
        previousFindings: previousReview?.findings,
        recordSuggestions: opts.recordSuggestions,
        ...(opts.recordFindings ? { recordFindings: opts.recordFindings } : {}),
        changedFiles: prFiles,
        ...(excludedFiles.length > 0 ? { excludedFiles, allExcluded } : {}),
      });
    };
    try {
      const extraCap = opts.maxIncompleteRetries ?? MAX_INCOMPLETE_RETRIES;
      let extrasUsed = 0;
      let lastStdout = (await runOpenCode()).stdout;
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
          const offending = porcelainOffendingPaths(porcelain);
          log(`Incomplete review: dirty tree: ${offending.join(", ")}`);
          return await persistSkipAndStatus("Incomplete review: dirty tree", currentPR.html_url);
        }

        // Parent-owned MCP verdict wins over the file. When the model recorded
        // anything through the review tools, a JUMI_REVIEW.md in the worktree
        // (e.g. planted by pull code) is ignored.
        if (verdictStore.hasAnything() || !verdictContractAllowsFileArtifact(attemptContract)) {
          if (!verdictStore.hasVerdict()) {
            if (extrasUsed >= extraCap) {
              verdictStore.close();
              return await persistSkipAndStatus(
                "Incomplete review: no check verdict",
                currentPR.html_url,
                INCOMPLETE_REVIEW_STUCK
              );
            }
            extrasUsed++;
            // In required mode the file artifact never counts, so the retry
            // asks for the structured verdict even when the store is empty.
            // A stale file is dropped below so it cannot satisfy a later round.
            await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
            const continueMcp = await hasResumableSession(opts.workspace);
            log(
              verdictStore.hasFindings()
                ? `Incomplete review: no verdict recorded; tool retry (${extrasUsed}/${extraCap})`
                : `Incomplete review: no structured verdict; tool retry (${extrasUsed}/${extraCap})`
            );
            lastStdout = (
              await runOpenCode({
                prompt: verdictStore.hasFindings() ? buildMcpNoVerdictPrompt() : buildMcpIncompletePrompt(),
                continueSession: continueMcp,
              })
            ).stdout;
            continue;
          }
          if (verdictStore.getVerdict()?.state === "failure" && !verdictStore.hasFindings()) {
            if (extrasUsed >= extraCap) {
              verdictStore.close();
              return await persistSkipAndStatus(
                INCOMPLETE_NO_FINDINGS_REASON,
                currentPR.html_url,
                INCOMPLETE_REVIEW_STUCK
              );
            }
            extrasUsed++;
            log(`Incomplete review: failure verdict with no findings; tool retry (${extrasUsed}/${extraCap})`);
            const continueMcpFindings = await hasResumableSession(opts.workspace);
            lastStdout = (
              await runOpenCode({ prompt: buildMcpNoFindingsPrompt(), continueSession: continueMcpFindings })
            ).stdout;
            continue;
          }
          verdictStore.close();
          return await publishMcpVerdict(currentPR.html_url);
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
            const lastLine = lastNonEmptyLine(artifact.content);
            const malformedTrailer = isTrailerShapedLine(lastLine) && !parseCheckLine(lastLine);
            const writePromptNoTrailer = malformedTrailer
              ? buildMalformedTrailerWritePrompt(continueSessionNoTrailer ? undefined : artifact.content)
              : buildNoTrailerWritePrompt(continueSessionNoTrailer ? undefined : artifact.content);
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
            blankFailure = !hasBlockingFindings(parsedArtifact.comment, { singleFilePath });
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
            return await publishMarkdownVerdict(markdown);
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
      verdictStore.close();
      try {
        reviewMcpServer?.close();
      } catch {
        // Best-effort: never replace the review result.
      }
      await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
      // The job ends here (success, failure, or abort): remove the worktree
      // harness temp and the retained Codex homes with it.
      await cleanupJobHarnessTemp(opts.workspace);
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
      // an excluded author family is never a later model. When a healthy
      // runner remains outside cooldown, do not park: rethrow so the queue
      // retries immediately on the next runner instead of idling for an hour.
      throwIfQuotaWait({
        err,
        model: opts.model,
        fallbackModel: effectiveFallbackModel,
        chain: effectiveChain,
        previousError: opts.previousError,
        ...(opts.runnerCooldowns ? { runnerCooldowns: opts.runnerCooldowns } : {}),
        ...(opts.cooldownNowMs ? { nowMs: opts.cooldownNowMs() } : {}),
        ...(opts.authFingerprints ? { cooldownFingerprints: opts.authFingerprints } : {}),
      });
      if (opts.runnerCooldowns && effectiveChain?.length) {
        if (
          hasHealthyRunnerForQuota(
            effectiveChain,
            opts.runnerCooldowns,
            opts.cooldownNowMs?.() ?? Date.now(),
            opts.authFingerprints
          )
        ) {
          throw err;
        }
      }
      const quotaReason = quotaStuckReasonForText(errorMessage(err));
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
      const message = redactGitSecrets(`Jumi review failed: ${errorMessage(err)}`, failureSecrets);
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
