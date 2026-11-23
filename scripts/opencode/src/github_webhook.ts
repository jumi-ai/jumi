import { hasLabel, type IssueAssignees, type PickupPolicy } from "./assignee.ts";
import { deleteCheckpointForIssueViaForge } from "./checkpoint.ts";
import {
  parseWorkflowJobPayload,
  shouldEnqueueSiblingCheckReview,
  shouldEnqueueWorkflowJobFollowUp,
  shouldEnqueueWorkflowJobReview,
} from "./ci_webhook.ts";
import {
  parseIssueCommentPayload,
  parsePullRejectedPayload,
  requireSenderPush,
  shouldEnqueueIssueCommentFollowUpWithTrust,
  shouldEnqueuePullLabel,
  shouldEnqueuePullRejectedFollowUpWithTrust,
} from "./followup_webhook.ts";
import type { ForgeKind } from "./forge.ts";
import { forgeCapabilities } from "./forge_capabilities.ts";
import { isWipOrDraft } from "./gitea_issues.ts";
import { githubInstallationFromPayload } from "./github_auth.ts";
import {
  blockedIssueJobsToEnqueue,
  enqueueEligibleBlockedIssue,
  type IssueWebhookDecision,
  isDependencyRemoveAction,
  isDependencyWakeAction,
  issueJobFrom,
  parseIssueDependenciesPayload,
  parseIssuesPayload,
} from "./issue_webhook.ts";
import { isReleaseCandidateSkipReason, tryReleaseMaintainerHold } from "./maintainer_hold_release.ts";
import { normalizeBlankTrustedSenders, withIssueAuthorPermission } from "./permissions.ts";
import { parsePushPayload, shouldEnqueuePushConflicts } from "./push_webhook.ts";
import type { EnqueueResult } from "./queue.ts";
import { resolveRepoPolicy } from "./repo_policy.ts";
import { loadReviewDraftsEnabled } from "./repo_settings.ts";
import { enqueueCiWakeWithGate, enqueueReviewWithCiGate } from "./review_gate.ts";
import { isQueueUnavailable } from "./review_jobs.ts";
import { normalizeSitReason, type RouterSitStore } from "./router_sits.ts";
import type { GiteaIssuePayload, IssueJob, ReviewJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";
import { isObjectLike } from "./util/object.ts";
import {
  assertRepositoryPolicy,
  parsePullRequestPayload,
  peekWebhookAction,
  verifyGiteaSignature,
  type WebhookPolicy,
} from "./webhook.ts";
import type { DeliveryDedupe } from "./webhook_delivery.ts";
import { type HandleWorkerWebhookDeps, handleWorkerWebhookEvent, type WorkerWebhookPolicy } from "./worker_webhook.ts";

const JUMI_LABEL = "jumi";
const GITHUB_ORIGIN = "https://github.com";
const GITHUB_REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
const GITHUB_FOLLOWUP_EVENTS = new Set(["issue_comment", "pull_request_review", "pull_request_review_comment"]);
const GITHUB_FOLLOWUP_CREATED = new Set(["created", "submitted"]);
const GITHUB_CI_EVENTS = new Set(["workflow_job", "workflow_run"]);
const DEFAULT_GITHUB_FOLLOWUP_IGNORES = ["github-actions[bot]", "dependabot[bot]"];

export type GithubMailboxConfig = {
  forge?: ForgeKind;
  webhookSecret: string;
  githubWebhookSecret?: string;
  maxWebhookBytes: number;
  allowedOrgs: readonly string[];
  allowedRepos: readonly string[];
  botUsername: string;
  followupIgnoreLogins?: readonly string[];
  trustedSenderLogins?: readonly string[];
  ignoreConflictsLabel?: string;
  pickupLabel?: string;
  automergeRepos?: readonly string[];
  automergeEnabled?: boolean;
};

type GithubReviewQueue = {
  enqueue(job: ReviewJob, opts?: import("./review_jobs.ts").EnqueueReviewOpts): EnqueueResult | Promise<EnqueueResult>;
};

export type GithubWebhookDeps = {
  review?: GithubReviewQueue;
  worker?: HandleWorkerWebhookDeps;
  getPR?: (owner: string, repo: string, index: number) => Promise<{ head: { sha: string } }>;
  logger?: (message: string) => void;
  rememberInstallation?: (installationId: string, owner?: string, repo?: string) => void;
  ciApi?: import("./worker_webhook.ts").HandleWorkerWebhookDeps["ciApi"];
  ciHome?: string;
  /**
   * Replay guard. Checked only after the HMAC passes, and marked only when
   * the event resolves to a durable 200/202 outcome — a 401, 400, or 503
   * never occupies a slot, so a failed delivery stays retryable.
   */
  deliveryDedupe?: DeliveryDedupe;
};

export type GithubWebhookPolicy = WorkerWebhookPolicy & {
  isPickedUp?: (issue: IssueAssignees) => boolean;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function skipped(reason: string, logger: (message: string) => void): Response {
  logger(`skipped ${reason}`);
  return json(202, { skipped: reason });
}

function reviewSitsFor(deps: GithubWebhookDeps): RouterSitStore | undefined {
  const fromWorker = deps.worker?.sits;
  if (fromWorker) return fromWorker;
  const review = deps.review as { sits?: RouterSitStore } | undefined;
  return review?.sits;
}

async function rememberGithubSkip(
  sits: RouterSitStore | undefined,
  owner: string,
  repo: string,
  number: number,
  reason: string,
  logger: (message: string) => void
): Promise<Response | undefined> {
  const code = normalizeSitReason(reason);
  if (!code) return undefined;
  try {
    await sits?.remember(owner, repo, number, code);
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`queue unavailable: ${(err as Error).message}`);
      return json(503, { error: "queue unavailable" });
    }
    logger(`sit remember failed: ${errorMessage(err)}`);
    return json(503, { error: "queue unavailable" });
  }
  return undefined;
}

async function clearGithubSit(
  sits: RouterSitStore | undefined,
  owner: string,
  repo: string,
  number: number,
  logger: (message: string) => void
): Promise<Response | undefined> {
  if (!sits) return undefined;
  try {
    await sits.clear(owner, repo, number);
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`queue unavailable: ${(err as Error).message}`);
      return json(503, { error: "queue unavailable" });
    }
    logger(`sit clear failed: ${errorMessage(err)}`);
    return json(503, { error: "queue unavailable" });
  }
  return undefined;
}

function cancelKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

/**
 * Shared `opened` takeover for the GitHub PR-review path. Both the
 * strict-refresh branch and the normal path use it so the two copies cannot
 * drift. Throws on failure; callers decide whether to swallow (strict
 * branch) or return 503/500 (normal path).
 */
async function enqueueGithubTakeoverForOpened(opts: {
  payload: ReturnType<typeof parsePullRequestPayload>;
  jobHeadSha: string;
  action: string;
  policy: GithubWebhookPolicy;
  deps: GithubWebhookDeps;
  delivery: string;
  logger: (message: string) => void;
}): Promise<void> {
  const { enqueueTakeoverForOpenedPull } = await import("./takeover.ts");
  const [o, r] = opts.payload.repository.full_name.split("/");
  if (!o || !r || !opts.deps.worker) return;
  const outcome = await enqueueTakeoverForOpenedPull({
    api: opts.deps.worker.api ?? {},
    forgeKind: "github",
    owner: o,
    repo: r,
    prNumber: opts.payload.pull_request.number,
    prTitle: opts.payload.pull_request.title,
    prDraft: opts.payload.pull_request.draft,
    prState: opts.payload.pull_request.state,
    prMerged: opts.payload.pull_request.merged,
    prAuthorLogin: opts.payload.pull_request.user?.login,
    prHeadRef: opts.payload.pull_request.head?.ref ?? "",
    prHeadSha: opts.payload.pull_request.head?.sha ?? opts.jobHeadSha,
    prHeadRepoFullName: opts.payload.pull_request.head?.repo?.full_name,
    defaultBranch: opts.payload.repository.default_branch,
    cloneUrl: opts.payload.repository.clone_url,
    htmlUrl: opts.payload.pull_request.html_url,
    updatedAt: opts.payload.pull_request.updated_at,
    prBody: opts.payload.pull_request.body,
    botUsername: opts.policy.botUsername,
    trustedSenderLogins: opts.policy.trustedSenderLogins,
    action: opts.action,
    delivery: `takeover-${opts.delivery}`,
    queue: opts.deps.worker.queue,
    log: (message) => opts.logger(message),
  });
  if (outcome.type === "skipped")
    opts.logger(`takeover skipped ${o}/${r}#${opts.payload.pull_request.number}: ${outcome.reason}`);
}

function githubMailboxSecret(config: GithubMailboxConfig): string {
  if (config.githubWebhookSecret) return config.githubWebhookSecret;
  if (config.forge === "github") return config.webhookSecret;
  return "";
}

export function pickupPolicyForForge(
  forge: ForgeKind | undefined,
  botUsername: string,
  pickupLabel?: string
): PickupPolicy {
  if (!forgeCapabilities(forge).pickupLabelApplies) return { botUsername };
  const label = (pickupLabel ?? "").trim() ? (pickupLabel as string).trim() : JUMI_LABEL;
  if (label.toLowerCase() === JUMI_LABEL) return { botUsername, isPickedUp: hasJumiLabel };
  return { botUsername, isPickedUp: (issue) => hasLabel(issue, label) };
}

export function githubWebhookPolicy(config: GithubMailboxConfig): GithubWebhookPolicy {
  const ignore = new Set([
    ...(config.followupIgnoreLogins ?? []).map((login) => login.toLowerCase()),
    ...DEFAULT_GITHUB_FOLLOWUP_IGNORES.map((login) => login.toLowerCase()),
  ]);
  const pickupLabel = (config.pickupLabel ?? "").trim() ? (config.pickupLabel as string).trim() : JUMI_LABEL;
  const isPickedUp = (issue: IssueAssignees) => hasLabel(issue, pickupLabel);
  return {
    giteaUrl: GITHUB_ORIGIN,
    allowedOrgs: config.allowedOrgs,
    allowedRepos: config.allowedRepos,
    botUsername: config.botUsername,
    followupIgnoreLogins: [...ignore],
    trustedSenderLogins: config.trustedSenderLogins,
    ignoreConflictsLabel: config.ignoreConflictsLabel,
    automergeRepos: config.automergeRepos,
    automergeEnabled: config.automergeEnabled,
    forgeKind: "github",
    pickupLabel,
    isPickedUp,
  };
}

export function hasJumiLabel(issue: IssueAssignees): boolean {
  return hasLabel(issue, JUMI_LABEL);
}

function pickupLabelForPolicy(policy: { pickupLabel?: string } | undefined): string {
  const raw = policy?.pickupLabel;
  return typeof raw === "string" && raw.trim() ? raw.trim() : JUMI_LABEL;
}

function hasPickupLabel(issue: IssueAssignees, pickupLabel?: string): boolean {
  const label = (pickupLabel ?? "").trim() ? (pickupLabel as string).trim() : JUMI_LABEL;
  return hasLabel(issue, label);
}

function isJumiLabel(label: { name?: string } | string | null | undefined, pickupLabel?: string): boolean {
  const name = typeof label === "string" ? label : (label?.name ?? "");
  const needle = (pickupLabel ?? "").trim() ? (pickupLabel as string).trim() : JUMI_LABEL;
  return name.toLowerCase() === needle.toLowerCase();
}

export function isGithubBotSender(sender: { login?: string; type?: string } | undefined): boolean {
  if (!sender) return false;
  if (sender.type && sender.type.toLowerCase() === "bot") return true;
  return /\[bot\]$/i.test(sender.login ?? "");
}

/**
 * Resolve the effective per-repository webhook policy from one
 * default-branch settings read. Missing, invalid, or unreadable files fall
 * back to the deployment policy (`jumi` pickup, deployer trust/ignore
 * lists). Never throws. Gitea callers ignore the pickup label.
 */
export async function effectiveGithubPolicyForRepo(
  api:
    | {
        getRepoFile?: (
          owner: string,
          repo: string,
          path: string,
          ref: string
        ) => Promise<{ found: boolean; content?: string }>;
      }
    | undefined,
  owner: string,
  repo: string,
  defaultBranch: string | undefined | null,
  basePolicy: GithubWebhookPolicy,
  log?: (message: string) => void
): Promise<GithubWebhookPolicy> {
  const branch = typeof defaultBranch === "string" && defaultBranch.trim() ? defaultBranch.trim() : "";
  const fallbackTrusted = normalizeBlankTrustedSenders(basePolicy.trustedSenderLogins);
  const fallback =
    fallbackTrusted === basePolicy.trustedSenderLogins
      ? basePolicy
      : { ...basePolicy, trustedSenderLogins: fallbackTrusted };
  if (!api || typeof api.getRepoFile !== "function" || !branch) return fallback;
  const policy = await resolveRepoPolicy(
    { api, owner, repo, ref: branch },
    {
      trustedSenderLogins: basePolicy.trustedSenderLogins,
      followupIgnoreLogins: basePolicy.followupIgnoreLogins,
      ignoreConflictsLabel: basePolicy.ignoreConflictsLabel,
      blockingQuestionAuthors: undefined,
      maxFollowupRounds: 0,
      maxConflictRounds: 0,
    },
    { onUnreadable: "fallback" }
  );
  if (policy.status === "invalid") {
    log?.(`repo settings invalid for ${owner}/${repo}@${branch}: ${policy.error}`);
    return fallback;
  }
  if (policy.status === "unreadable") {
    log?.(`repo settings unreadable for ${owner}/${repo}@${branch}: ${policy.error}`);
    return fallback;
  }
  // Missing still sets the pickup label (`jumi`) and `isPickedUp`, unlike
  // the worker webhook which returns `basePolicy` unchanged.
  const pickupLabel = policy.pickupLabel;
  const trustedSenderLogins = policy.trustedSenderLogins;
  // `basePolicy.followupIgnoreLogins` already merges the deployer list with
  // the GitHub defaults; the repository list unions on top.
  const followupIgnoreLogins = policy.followupIgnoreLogins;
  const ignoreConflictsLabel = policy.ignoreConflictsLabel;
  return {
    ...basePolicy,
    trustedSenderLogins,
    followupIgnoreLogins,
    ignoreConflictsLabel,
    pickupLabel,
    isPickedUp: (issue) => hasLabel(issue, pickupLabel),
  };
}

function isFactoryBotSender(sender: { login?: string } | undefined, botUsername: string): boolean {
  if (!sender?.login) return false;
  return sender.login.toLowerCase() === botUsername.toLowerCase();
}

function isIgnoredFollowupSender(
  sender: { login?: string } | undefined,
  followupIgnoreLogins: readonly string[] | undefined
): boolean {
  if (!sender?.login) return false;
  const needle = sender.login.toLowerCase();
  for (const login of followupIgnoreLogins ?? []) {
    if (login.toLowerCase() === needle) return true;
  }
  return false;
}

export async function verifyGithubSignature(
  rawBody: Uint8Array,
  secret: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  if (!/^sha256=/i.test(signatureHeader.trim())) return false;
  return verifyGiteaSignature(rawBody, secret, signatureHeader);
}

export function shouldEnqueueGithubIssue(
  payload: GiteaIssuePayload,
  policy: WebhookPolicy & { botUsername: string; pickupLabel?: string }
): IssueWebhookDecision {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);
  const pickupLabel = pickupLabelForPolicy(policy);

  if (payload.issue.pull_request != null) {
    return { type: "skip", reason: "pull request issue" };
  }

  if (payload.action === "unlabeled") {
    if (!isJumiLabel(payload.label, pickupLabel)) return { type: "skip", reason: "unlabeled other label" };
    return { type: "cancel", owner, repo, issueNumber: payload.issue.number };
  }

  if (payload.action === "labeled") {
    if (isFactoryBotSender(payload.sender, policy.botUsername)) return { type: "skip", reason: "sender is bot" };
    if (!isJumiLabel(payload.label, pickupLabel)) return { type: "skip", reason: "labeled other label" };
    if (payload.issue.state && payload.issue.state !== "open") {
      return { type: "skip", reason: "issue not open" };
    }
    return {
      type: "enqueue",
      job: issueJobFrom(owner, repo, payload.issue, payload.repository, payload.action),
    };
  }

  return { type: "skip", reason: `unsupported action ${payload.action}` };
}

function validateGithubReview(
  payload: ReturnType<typeof parsePullRequestPayload>,
  policy: WebhookPolicy,
  opts?: { reviewDrafts?: boolean }
): ReviewJob | { skip: string } {
  if (!GITHUB_REVIEW_ACTIONS.has(payload.action)) {
    return { skip: `unsupported action ${payload.action}` };
  }
  if (!opts?.reviewDrafts && isWipOrDraft(payload.pull_request)) return { skip: "draft or WIP pull request" };
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);
  if (!payload.pull_request.head?.sha) throw new Error("Invalid webhook payload: missing pull_request.head.sha");
  if (!payload.pull_request.updated_at) throw new Error("Invalid webhook payload: missing pull_request.updated_at");
  return {
    delivery: "",
    owner,
    repo,
    prNumber: payload.pull_request.number,
    action: payload.action,
    headSha: payload.pull_request.head.sha,
    receivedAt: new Date().toISOString(),
    prUpdatedAt: payload.pull_request.updated_at,
  };
}

function rememberWebhookInstallation(rawBody: Uint8Array, deps: GithubWebhookDeps): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return;
  }
  const info = githubInstallationFromPayload(parsed);
  if (!info.installationId) return;
  deps.rememberInstallation?.(info.installationId, info.owner, info.repo);
  deps.worker?.api?.rememberInstallation?.(info.installationId, info.owner, info.repo);
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function workflowJobBody(rawBody: Uint8Array): Uint8Array {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObjectLike(parsed)) return rawBody;
  if (parsed.workflow_job != null) return rawBody;
  const run = parsed.workflow_run;
  if (!isObjectLike(run)) return rawBody;
  return encodeJson({
    ...parsed,
    workflow_job: {
      head_sha: run.head_sha,
      head_branch: run.head_branch,
    },
  });
}

function issueCommentBody(rawBody: Uint8Array): Uint8Array {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObjectLike(parsed) || parsed.issue != null) return rawBody;
  const pr = parsed.pull_request;
  if (!isObjectLike(pr)) return rawBody;
  return encodeJson({
    ...parsed,
    issue: {
      ...pr,
      pull_request: {
        url: pr.html_url,
        merged: pr.merged,
        draft: pr.draft,
        html_url: pr.html_url,
      },
    },
  });
}

async function issueCommentPullRequestBody(
  rawBody: Uint8Array,
  parsed: Record<string, unknown>,
  deps: GithubWebhookDeps,
  logger: (message: string) => void
): Promise<Uint8Array | null> {
  const existing = parsed.pull_request;
  if (
    isObjectLike(existing) &&
    isObjectLike(existing.head) &&
    typeof existing.head.ref === "string" &&
    existing.head.ref
  ) {
    return rawBody;
  }
  const issue = parsed.issue;
  if (!isObjectLike(issue) || issue.pull_request == null) return rawBody;
  const repository = parsed.repository;
  if (!isObjectLike(repository) || typeof repository.full_name !== "string") return rawBody;
  const [owner, repo] = repository.full_name.split("/");
  if (!owner || !repo || typeof issue.number !== "number") return rawBody;
  const getPR = deps.getPR ?? deps.worker?.api?.getPR;
  if (!getPR) return rawBody;
  try {
    const pr = await getPR(owner, repo, issue.number);
    return encodeJson({ ...parsed, pull_request: pr });
  } catch (err) {
    logger(`pr lookup failed: ${errorMessage(err)}`);
    return null;
  }
}

async function enqueueJobs(
  jobs: IssueJob[],
  queue: HandleWorkerWebhookDeps["queue"],
  delivery: string,
  logger: (message: string) => void,
  sits?: RouterSitStore
): Promise<Response> {
  if (jobs.length === 1) {
    const job = jobs[0];
    if (!job) return skipped("no blocked issues to wake", logger);
    const result: EnqueueResult = await queue.enqueue(job);
    logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
    if (result.queued && sits) {
      const cleared = await clearGithubSit(sits, job.owner, job.repo, job.issueNumber, logger);
      if (cleared) return cleared;
    }
    return json(202, result);
  }
  const keys: string[] = [];
  for (const job of jobs) {
    const result: EnqueueResult = await queue.enqueue(job);
    keys.push(result.key);
    logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
    if (result.queued && sits) {
      const cleared = await clearGithubSit(sits, job.owner, job.repo, job.issueNumber, logger);
      if (cleared) return cleared;
    }
  }
  return json(202, { queued: true, keys });
}

export async function handleGithubWebhookEvent(
  rawBody: Uint8Array,
  event: string | null,
  delivery: string,
  policy: GithubWebhookPolicy,
  deps: GithubWebhookDeps
): Promise<Response> {
  const logger = deps.logger ?? ((message: string) => console.log(message));
  rememberWebhookInstallation(rawBody, deps);
  if (event === "ping") return json(200, { ok: true });
  if (event === "status" || event === "check_run") {
    if (!deps.review || !deps.worker?.api) return skipped(`unsupported event ${event}`, logger);
    try {
      const decision = await shouldEnqueueSiblingCheckReview(rawBody, event, policy, deps.worker.api, logger);
      if (decision.type === "skip") return skipped(decision.reason, logger);
      const receivedAt = new Date().toISOString();
      const reviewResults: EnqueueResult[] = [];
      const ciApi = deps.ciApi ?? deps.worker?.ciApi;
      const ciHome = deps.ciHome ?? deps.worker?.ciHome ?? "/data";
      for (const partial of decision.jobs) {
        const gated = await enqueueCiWakeWithGate(
          deps.review,
          { ...partial, delivery, receivedAt },
          { ciApi, home: ciHome, logger }
        );
        if ("waiting" in gated) {
          logger(`waiting ${gated.key} delivery=${delivery}`);
          continue;
        }
        const result = gated;
        reviewResults.push(result);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
        if (result.queued) {
          const cleared = await clearGithubSit(
            reviewSitsFor(deps),
            partial.owner,
            partial.repo,
            partial.prNumber,
            logger
          );
          if (cleared) return cleared;
        }
      }
      if (reviewResults.length === 1 && reviewResults[0]) return json(202, reviewResults[0]);
      if (reviewResults.length > 0) return json(202, { queued: true, keys: reviewResults.map((item) => item.key) });
      return skipped("CI still pending", logger);
    } catch (err) {
      if (isQueueUnavailable(err)) {
        logger(`queue unavailable: ${err.message}`);
        return json(503, { error: "queue unavailable" });
      }
      logger(`status webhook failed: ${errorMessage(err)}`);
      return json(500, { error: "internal error" });
    }
  }

  if (event === "pull_request") {
    const action = peekWebhookAction(rawBody);
    if (action && GITHUB_REVIEW_ACTIONS.has(action) && deps.review) {
      try {
        const payload = parsePullRequestPayload(rawBody);
        let reviewDrafts = false;
        try {
          const [draftOwner, draftRepo] = payload.repository.full_name.split("/");
          const defaultBranch =
            typeof payload.repository.default_branch === "string" ? payload.repository.default_branch : "";
          const draftsApi = deps.worker?.api as
            | {
                getRepoFile?: (
                  o: string,
                  r: string,
                  p: string,
                  ref: string
                ) => Promise<{ found: boolean; content?: string }>;
              }
            | undefined;
          if (draftOwner && draftRepo && draftsApi && typeof draftsApi.getRepoFile === "function") {
            reviewDrafts = await loadReviewDraftsEnabled(draftsApi, draftOwner, draftRepo, defaultBranch, logger);
          }
        } catch {
          reviewDrafts = false;
        }
        const validation = validateGithubReview(payload, policy, { reviewDrafts });
        if ("skip" in validation) {
          const [owner, repo] = payload.repository.full_name.split("/");
          if (owner && repo) {
            const remembered = await rememberGithubSkip(
              reviewSitsFor(deps),
              owner,
              repo,
              payload.pull_request.number,
              validation.skip,
              logger
            );
            if (remembered) return remembered;
          }
          return skipped(validation.skip, logger);
        }
        const job = { ...validation, delivery };
        if (deps.getPR) {
          try {
            const pr = await deps.getPR(job.owner, job.repo, job.prNumber);
            if (job.headSha !== pr.head.sha) {
              logger(`stale head ${job.owner}/${job.repo}#${job.prNumber} current=${pr.head.sha}`);
              return json(202, { key: `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`, queued: false });
            }
          } catch (err) {
            logger(`pr head lookup failed: ${errorMessage(err)}`);
          }
        }
        // Strict refresh reconcile on PR activity: a PR already behind when
        // strict checks and auto-merge are armed need not wait for another
        // base push. When GitHub reports the head behind, enqueue the
        // merge-only refresh and park this stale-head review without taking
        // a reviewer slot; the new head re-enters through the normal CI and
        // review flow. When behind-ness is not established (already current,
        // unknown while GitHub computes, or a conflict), enqueue the worker
        // wake optimistically but fall through to the normal CI-gated review
        // so the review is neither delayed to the fallback nor bypasses CI.
        if (deps.worker?.api && deps.worker?.queue) {
          try {
            const {
              shouldEnqueueStrictRefreshForPR,
              isStrictRefreshBehind,
              encodeStrictRefreshWait,
              STRICT_REFRESH_WAIT_FALLBACK_MS,
            } = await import("./strict_refresh.ts");
            const [strictOwner, strictRepo] = payload.repository.full_name.split("/");
            if (strictOwner && strictRepo) {
              let fullPr: import("./ports.ts").Pull | undefined;
              try {
                const getPR = deps.worker.api.getPR;
                if (typeof getPR === "function") {
                  fullPr = await getPR.call(deps.worker.api, strictOwner, strictRepo, payload.pull_request.number);
                }
              } catch (err) {
                logger(`strict refresh pr lookup failed: ${errorMessage(err)}`);
              }
              if (fullPr) {
                const { strictSlotsFor } = await import("./strict_refresh_queue.ts");
                const strictSlots = strictSlotsFor(deps);
                const strictJob = await shouldEnqueueStrictRefreshForPR({
                  pr: fullPr,
                  owner: strictOwner,
                  repo: strictRepo,
                  defaultBranch: payload.repository.default_branch,
                  cloneUrl: payload.repository.clone_url,
                  policy,
                  api: deps.worker.api,
                  sender: payload.sender?.login ?? "pull_request",
                  log: logger,
                  ...(strictSlots ? { slots: strictSlots } : {}),
                });
                if (strictJob) {
                  const receivedAt = new Date().toISOString();
                  const workerJob: import("./types.ts").IssueJob = { ...strictJob, delivery, receivedAt };
                  const workerResult = await deps.worker.queue.enqueue(workerJob);
                  logger(
                    `${workerResult.queued ? "queued" : "deduped"} ${workerResult.key} delivery=${delivery} strict-refresh`
                  );
                  if (!isStrictRefreshBehind(fullPr)) {
                    logger(
                      `strict refresh not behind ${strictOwner}/${strictRepo}#${payload.pull_request.number}: falling through to normal review`
                    );
                  } else {
                    const nowMs = Date.now();
                    const parked = await deps.review.enqueue(job, {
                      waitUntilMs: nowMs + STRICT_REFRESH_WAIT_FALLBACK_MS,
                      waitMarker: encodeStrictRefreshWait(nowMs),
                      nowMs,
                    });
                    logger(
                      `${parked.queued ? "queued" : "deduped"} ${parked.key} delivery=${delivery} strict-refresh-wait`
                    );
                    if (parked.queued) {
                      const cleared = await clearGithubSit(
                        reviewSitsFor(deps),
                        job.owner,
                        job.repo,
                        job.prNumber,
                        logger
                      );
                      if (cleared) return cleared;
                    }
                    if (action === "opened" && deps.worker) {
                      try {
                        await enqueueGithubTakeoverForOpened({
                          payload,
                          jobHeadSha: job.headSha,
                          action,
                          policy,
                          deps,
                          delivery,
                          logger,
                        });
                      } catch (err) {
                        logger(`takeover failed: ${errorMessage(err)}`);
                      }
                    }
                    return json(202, parked);
                  }
                }
              }
            }
          } catch (err) {
            logger(`strict refresh reconcile failed: ${errorMessage(err)}`);
          }
        }
        const result = await enqueueReviewWithCiGate(deps.review, job, {
          ciApi: deps.ciApi ?? deps.worker?.ciApi,
          home: deps.ciHome ?? deps.worker?.ciHome ?? "/data",
          logger,
          ...(typeof payload.pull_request.base?.ref === "string" && payload.pull_request.base.ref
            ? { baseBranch: payload.pull_request.base.ref }
            : {}),
          ...(typeof payload.repository?.default_branch === "string" && payload.repository.default_branch
            ? { defaultBranch: payload.repository.default_branch }
            : {}),
        });
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
        if (result.queued) {
          const cleared = await clearGithubSit(reviewSitsFor(deps), job.owner, job.repo, job.prNumber, logger);
          if (cleared) return cleared;
        }
        if (action === "opened" && deps.worker) {
          // Same contract as the Gitea PR-open path: the review above already
          // enqueued (or deduped on retry). Shared helper keeps both forges identical.
          try {
            await enqueueGithubTakeoverForOpened({
              payload,
              jobHeadSha: job.headSha,
              action,
              policy,
              deps,
              delivery,
              logger,
            });
          } catch (err) {
            if (isQueueUnavailable(err)) {
              logger(`takeover queue unavailable: ${(err as Error).message}`);
              return json(503, { error: "queue unavailable" });
            }
            logger(`takeover failed: ${errorMessage(err)}`);
            return json(500, { error: "takeover failed" });
          }
        }
        return json(202, result);
      } catch (err) {
        if (isQueueUnavailable(err)) {
          logger(`queue unavailable: ${err.message}`);
          return json(503, { error: "queue unavailable" });
        }
        logger(`invalid webhook payload: ${errorMessage(err)}`);
        return json(400, { error: "invalid webhook payload" });
      }
    }
    if (deps.worker && action === "opened") {
      try {
        const payload = parsePullRequestPayload(rawBody);
        const { shouldEnqueueTakeoverForOpenedPull } = await import("./takeover.ts");
        const [takeoverOwner, takeoverRepo] = payload.repository.full_name.split("/");
        if (!takeoverOwner || !takeoverRepo) return skipped("invalid webhook payload", logger);
        const decision = await shouldEnqueueTakeoverForOpenedPull({
          api: deps.worker.api ?? {},
          forgeKind: "github",
          owner: takeoverOwner,
          repo: takeoverRepo,
          prNumber: payload.pull_request.number,
          prTitle: payload.pull_request.title,
          prDraft: payload.pull_request.draft,
          prState: payload.pull_request.state,
          prMerged: payload.pull_request.merged,
          prAuthorLogin: payload.pull_request.user?.login,
          prHeadRef: payload.pull_request.head?.ref ?? "",
          prHeadSha: payload.pull_request.head?.sha ?? "",
          prHeadRepoFullName: payload.pull_request.head?.repo?.full_name,
          defaultBranch: payload.repository.default_branch,
          cloneUrl: payload.repository.clone_url,
          htmlUrl: payload.pull_request.html_url,
          updatedAt: payload.pull_request.updated_at,
          prBody: payload.pull_request.body,
          botUsername: policy.botUsername,
          trustedSenderLogins: policy.trustedSenderLogins,
          action,
          log: (message) => logger(message),
        });
        if (decision.type === "skip") return skipped(decision.reason, logger);
        const job: IssueJob = { ...decision.job, delivery, receivedAt: new Date().toISOString() };
        const result: EnqueueResult = await deps.worker.queue.enqueue(job);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
        return json(202, result);
      } catch (err) {
        logger(`takeover failed: ${errorMessage(err)}`);
        return skipped("takeover failed", logger);
      }
    }
    if (deps.worker && (action === "labeled" || action === "unlabeled")) {
      try {
        const { tryHandleAutomergeLabelEvent } = await import("./automerge_webhook.ts");
        const automergeHandled = await tryHandleAutomergeLabelEvent({
          rawBody,
          policy: {
            ...policy,
            forgeKind: "github",
            automergeRepos: (policy as { automergeRepos?: readonly string[] }).automergeRepos,
            automergeEnabled: (policy as { automergeEnabled?: boolean }).automergeEnabled,
          },
          api: deps.worker.api,
          log: logger,
        });
        if (automergeHandled.handled) return json(202, { queued: false, reason: automergeHandled.reason });
      } catch (err) {
        logger(`automerge label webhook failed: ${errorMessage(err)}`);
      }
      try {
        const payload = parsePullRequestPayload(rawBody);
        const [effOwner, effRepo] = payload.repository.full_name.split("/");
        const effectivePolicy =
          effOwner && effRepo
            ? await effectiveGithubPolicyForRepo(
                deps.worker.api,
                effOwner,
                effRepo,
                payload.repository.default_branch,
                policy,
                logger
              )
            : policy;
        const decision = await requireSenderPush(
          await shouldEnqueuePullLabel(payload, effectivePolicy, deps.worker.api, logger),
          deps.worker.api,
          payload.sender?.login,
          effectivePolicy.trustedSenderLogins
        );
        if (decision.type === "skip") {
          const [owner, repo] = payload.repository.full_name.split("/");
          if (owner && repo) {
            const remembered = await rememberGithubSkip(
              deps.worker.sits,
              owner,
              repo,
              payload.pull_request.number,
              decision.reason,
              logger
            );
            if (remembered) return remembered;
          }
          return skipped(decision.reason, logger);
        }
        if (decision.type === "cancel") {
          const result = deps.worker.cancel
            ? await deps.worker.cancel(decision.owner, decision.repo, decision.issueNumber)
            : { key: cancelKey(decision.owner, decision.repo, decision.issueNumber), cancelled: true as const };
          await deleteCheckpointForIssueViaForge(
            deps.worker.api ?? {},
            decision.owner,
            decision.repo,
            decision.issueNumber,
            {
              log: logger,
            }
          );
          logger(`cancelled ${result.key}`);
          const cleared = await clearGithubSit(
            deps.worker.sits,
            decision.owner,
            decision.repo,
            decision.issueNumber,
            logger
          );
          if (cleared) return cleared;
          return json(202, result);
        }
        const job: IssueJob = { ...decision.job, delivery, receivedAt: new Date().toISOString() };
        const result: EnqueueResult = await deps.worker.queue.enqueue(job);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
        if (result.queued) {
          const cleared = await clearGithubSit(deps.worker.sits, job.owner, job.repo, job.issueNumber, logger);
          if (cleared) return cleared;
        }
        return json(202, result);
      } catch (err) {
        if (isQueueUnavailable(err)) {
          logger(`queue unavailable: ${err.message}`);
          return json(503, { error: "queue unavailable" });
        }
        logger(`invalid webhook payload: ${errorMessage(err)}`);
        return json(400, { error: "invalid webhook payload" });
      }
    }
    if (deps.worker && (action === "closed" || action === "merged")) {
      return handleWorkerWebhookEvent(rawBody, event, event, delivery, policy, {
        ...deps.worker,
        logger: deps.worker.logger ?? logger,
      });
    }
    if ((action === "closed" || action === "merged") && event === "pull_request") {
      // Review-only mode has no worker handler to record the close: mark it
      // here so the board hides the requeue row, and settle the pull's
      // review rows. Forge-free, best-effort.
      try {
        const payload = parsePullRequestPayload(rawBody);
        const [owner, repo] = payload.repository.full_name.split("/");
        const sits = reviewSitsFor(deps);
        if (owner && repo && sits?.markPullClosed) {
          await sits.markPullClosed(owner, repo, payload.pull_request.number).catch(() => {});
        }
        if (owner && repo) {
          const reviewStore = deps.review as unknown as
            | { cancelQueuedForPull?: (o: string, r: string, n: number) => Promise<number> }
            | undefined;
          if (typeof reviewStore?.cancelQueuedForPull === "function") {
            try {
              await reviewStore.cancelQueuedForPull.call(reviewStore, owner, repo, payload.pull_request.number);
            } catch (err) {
              logger(`review cancel for closed pull failed: ${errorMessage(err)}`);
            }
          }
        }
      } catch {
        // Best-effort marker only; the skip below owns the response.
      }
    }
    return skipped(action ? `unsupported action ${action}` : `unsupported event ${event ?? "pull_request"}`, logger);
  }

  if (!deps.worker) return skipped(`unsupported event ${event ?? "unknown"}`, logger);

  try {
    if (event === "issue_dependencies") {
      const action = peekWebhookAction(rawBody);
      if (!action || !isDependencyRemoveAction(action)) {
        return skipped(action ? `unsupported action ${action}` : "unsupported action unknown", logger);
      }
      if (!deps.worker.api?.getIssue) return skipped("no blocked issues to wake", logger);
      try {
        const dep = parseIssueDependenciesPayload(rawBody);
        const branch = dep.blockedDefaultBranch ?? dep.triggerRepository.default_branch;
        let effectivePolicy: GithubWebhookPolicy = policy;
        try {
          if (dep.blockedOwner && dep.blockedRepo) {
            effectivePolicy = await effectiveGithubPolicyForRepo(
              deps.worker.api,
              dep.blockedOwner,
              dep.blockedRepo,
              branch,
              policy,
              logger
            );
          }
        } catch {
          effectivePolicy = policy;
        }
        try {
          assertRepositoryPolicy(dep.triggerRepository, policy);
        } catch {
          return skipped("repository not allowed", logger);
        }
        const partial = await enqueueEligibleBlockedIssue(
          { owner: dep.blockedOwner, repo: dep.blockedRepo, number: dep.blockedNumber },
          {
            owner: dep.triggerOwner,
            repo: dep.triggerRepo,
            repository: dep.triggerRepository,
            action: dep.action,
            policy: effectivePolicy,
            api: { getIssue: deps.worker.api.getIssue, getRepo: deps.worker.api.getRepo },
          }
        );
        if (!partial) return skipped("no blocked issues to wake", logger);
        const job: IssueJob = {
          ...(await withIssueAuthorPermission(partial, deps.worker.api)),
          delivery,
          receivedAt: new Date().toISOString(),
        };
        const result: EnqueueResult = await deps.worker.queue.enqueue(job);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
        if (result.queued) {
          const cleared = await clearGithubSit(deps.worker.sits, job.owner, job.repo, job.issueNumber, logger);
          if (cleared) return cleared;
        }
        return json(202, result);
      } catch (err) {
        if (isQueueUnavailable(err)) {
          logger(`queue unavailable: ${(err as Error).message}`);
          return json(503, { error: "queue unavailable" });
        }
        return skipped("malformed issue_dependencies payload", logger);
      }
    }

    if (GITHUB_CI_EVENTS.has(event ?? "")) {
      const action = peekWebhookAction(rawBody);
      if (action && action !== "completed") return skipped(`unsupported action ${action}`, logger);
      if (!deps.worker.api) return skipped("not an in-scope jumi pull request", logger);
      let payload: ReturnType<typeof parseWorkflowJobPayload>;
      try {
        payload = parseWorkflowJobPayload(workflowJobBody(rawBody));
      } catch {
        return skipped("malformed workflow_job payload", logger);
      }
      const receivedAt = new Date().toISOString();
      const decision = await shouldEnqueueWorkflowJobFollowUp(payload, policy, deps.worker.api, logger);
      const reviewResults: EnqueueResult[] = [];
      if (deps.review) {
        const reviewDecision = await shouldEnqueueWorkflowJobReview(payload, policy, deps.worker.api, logger);
        if (reviewDecision.type === "enqueue") {
          const ciApi = deps.ciApi ?? deps.worker?.ciApi;
          const ciHome = deps.ciHome ?? deps.worker?.ciHome ?? "/data";
          for (const partial of reviewDecision.jobs) {
            const gated = await enqueueCiWakeWithGate(
              deps.review,
              { ...partial, delivery, receivedAt },
              { ciApi, home: ciHome, logger }
            );
            if ("waiting" in gated) {
              logger(`waiting ${gated.key} delivery=${delivery}`);
              continue;
            }
            const result = gated;
            reviewResults.push(result);
            logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
            if (result.queued) {
              const cleared = await clearGithubSit(
                reviewSitsFor(deps),
                partial.owner,
                partial.repo,
                partial.prNumber,
                logger
              );
              if (cleared) return cleared;
            }
          }
        }
      }
      if (decision.type === "enqueue") {
        const jobs: IssueJob[] = decision.jobs.map((partial) => ({ ...partial, delivery, receivedAt }));
        return enqueueJobs(jobs, deps.worker.queue, delivery, logger, deps.worker.sits);
      }
      if (reviewResults.length === 1 && reviewResults[0]) return json(202, reviewResults[0]);
      if (reviewResults.length > 1) return json(202, { queued: true, keys: reviewResults.map((item) => item.key) });
      if (reviewResults.length === 0 && deps.review) {
        return skipped("CI still pending", logger);
      }
      return skipped(decision.reason, logger);
    }

    if (event === "push") {
      if (!deps.worker.api) return skipped("no managed jumi PRs", logger);
      let payload: ReturnType<typeof parsePushPayload>;
      try {
        payload = parsePushPayload(rawBody);
      } catch {
        return skipped("malformed push payload", logger);
      }
      const decision = await shouldEnqueuePushConflicts(payload, policy, deps.worker.api, logger);
      if (decision.type === "skip" && !deps.review) return skipped(decision.reason, logger);
      const receivedAt = new Date().toISOString();
      const jobs: IssueJob[] = [];
      if (decision.type === "enqueue") {
        for (const partial of decision.jobs) {
          const job: IssueJob = { ...partial, delivery, receivedAt };
          const prNumber = job.prNumber;
          const getPR = deps.getPR ?? deps.worker.api.getPR;
          if (prNumber != null && getPR) {
            try {
              const pr = await getPR(job.owner, job.repo, prNumber);
              if (pr.head?.sha) job.headSha = pr.head.sha;
            } catch (err) {
              logger(`mergeable lookup failed: ${errorMessage(err)}`);
            }
          }
          jobs.push(job);
        }
      }
      // Wake shared-failure waiters whose first just merged: merge-only jobs.
      try {
        const { shouldEnqueueSharedWaiterMerges } = await import("./push_webhook.ts");
        const ledger = deps.review as unknown as import("./review_jobs.ts").ReviewJobStore | undefined;
        const waiterJobs = await shouldEnqueueSharedWaiterMerges(
          payload,
          policy,
          deps.worker.api,
          ledger?.listSharedFailures ? ledger : undefined,
          logger
        );
        for (const partial of waiterJobs) {
          const job: IssueJob = { ...partial, delivery, receivedAt };
          jobs.push(job);
          logger(`shared waiter merge-only ${job.owner}/${job.repo}#${job.prNumber} delivery=${delivery}`);
        }
      } catch (err) {
        logger(`shared waiter merge wake failed: ${errorMessage(err)}`);
      }
      // Strict refresh: GitHub branches that require up-to-date heads. Clean
      // merges land via the merge-only worker path without a model call;
      // conflicts stay for the conflict workflow. Unknown/off stays silent.
      // Single-slot per repo and target branch: the oldest ready PR holds the
      // slot across CI/review/merge; waiting PRs get no speculative push.
      try {
        const { shouldEnqueueStrictRefreshOnPush } = await import("./strict_refresh.ts");
        const { strictSlotsFor } = await import("./strict_refresh_queue.ts");
        const strictSlots = strictSlotsFor(deps);
        const strict = await shouldEnqueueStrictRefreshOnPush(payload, policy, deps.worker.api, logger, strictSlots);
        for (const partial of strict.jobs) {
          const job: IssueJob = { ...partial, delivery, receivedAt };
          jobs.push(job);
          logger(`strict refresh merge-only ${job.owner}/${job.repo}#${job.prNumber} delivery=${delivery}`);
        }
      } catch (err) {
        logger(`strict refresh wake failed: ${errorMessage(err)}`);
      }
      if (jobs.length === 0) {
        if (decision.type === "skip") return skipped(decision.reason, logger);
        return skipped("no managed jumi PRs", logger);
      }
      // Push is out of scope for sits: enqueue without remembering or clearing.
      return enqueueJobs(jobs, deps.worker.queue, delivery, logger);
    }

    if (GITHUB_FOLLOWUP_EVENTS.has(event ?? "")) {
      const action = peekWebhookAction(rawBody);
      if (action && !GITHUB_FOLLOWUP_CREATED.has(action)) {
        return skipped(`unsupported action ${action}`, logger);
      }
      const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
      // Union the repository's `followup_ignore_logins` and intersect its
      // `trusted_senders` before the bot/ignore skips: an unreadable or
      // invalid file falls back to the deployment policy.
      let effectiveFollowupPolicy = policy;
      try {
        if (
          isObjectLike(parsed) &&
          isObjectLike(parsed.repository) &&
          typeof parsed.repository.full_name === "string"
        ) {
          const [fuOwner, fuRepo] = (parsed.repository.full_name as string).split("/");
          const fuBranch =
            typeof parsed.repository.default_branch === "string" ? parsed.repository.default_branch : undefined;
          if (fuOwner && fuRepo) {
            effectiveFollowupPolicy = await effectiveGithubPolicyForRepo(
              deps.worker.api,
              fuOwner,
              fuRepo,
              fuBranch,
              policy,
              logger
            );
          }
        }
      } catch {
        // Fall back to the deployment policy.
      }
      const sender = isObjectLike(parsed) && isObjectLike(parsed.sender) ? parsed.sender : undefined;
      const githubSender = sender as { login?: string; type?: string } | undefined;
      if (isFactoryBotSender(githubSender, effectiveFollowupPolicy.botUsername)) {
        return skipped("sender is bot", logger);
      }
      if (isIgnoredFollowupSender(githubSender, effectiveFollowupPolicy.followupIgnoreLogins)) {
        return skipped("sender ignored", logger);
      }
      const eventName = event ?? "issue_comment";
      let commentBody = rawBody;
      if (event === "pull_request_review_comment") commentBody = issueCommentBody(rawBody);
      else if (event === "issue_comment" && isObjectLike(parsed)) {
        const resolved = await issueCommentPullRequestBody(rawBody, parsed, deps, logger);
        if (resolved == null) return json(503, { error: "pr lookup failed" });
        commentBody = resolved;
      }
      const decision =
        event === "pull_request_review"
          ? await shouldEnqueuePullRejectedFollowUpWithTrust(
              parsePullRejectedPayload(rawBody),
              effectiveFollowupPolicy,
              eventName,
              undefined,
              deps.worker.api
            )
          : await shouldEnqueueIssueCommentFollowUpWithTrust(
              parseIssueCommentPayload(commentBody),
              effectiveFollowupPolicy,
              eventName,
              undefined,
              deps.worker.api
            );
      if (decision.type === "skip") {
        const fullName =
          isObjectLike(parsed) && isObjectLike(parsed.repository) && typeof parsed.repository.full_name === "string"
            ? (parsed.repository.full_name as string)
            : undefined;
        const prNumber =
          isObjectLike(parsed) && isObjectLike(parsed.pull_request) && typeof parsed.pull_request.number === "number"
            ? (parsed.pull_request.number as number)
            : isObjectLike(parsed) && isObjectLike(parsed.issue) && typeof parsed.issue.number === "number"
              ? (parsed.issue.number as number)
              : undefined;
        if (fullName) {
          const [owner, repo] = fullName.split("/");
          if (owner && repo && typeof prNumber === "number" && isReleaseCandidateSkipReason(decision.reason)) {
            try {
              const senderLogin =
                isObjectLike(parsed) && isObjectLike(parsed.sender) && typeof parsed.sender.login === "string"
                  ? (parsed.sender.login as string)
                  : undefined;
              const defaultBranch =
                isObjectLike(parsed) &&
                isObjectLike(parsed.repository) &&
                typeof parsed.repository.default_branch === "string"
                  ? (parsed.repository.default_branch as string)
                  : undefined;
              const release = await tryReleaseMaintainerHold({
                api: deps.worker.api as never,
                owner,
                repo,
                prNumber,
                senderLogin,
                botUsername: effectiveFollowupPolicy.botUsername,
                trustedSenderLogins: effectiveFollowupPolicy.trustedSenderLogins,
                followupIgnoreLogins: effectiveFollowupPolicy.followupIgnoreLogins,
                defaultBranch,
                logger,
              });
              if (release.outcome === "released") {
                const cleared = await clearGithubSit(deps.worker.sits, owner, repo, prNumber, logger);
                if (cleared) return cleared;
                return json(202, { released: true, key: `${owner}/${repo}#${prNumber}` });
              }
              if (release.reason !== decision.reason) {
                const remembered = await rememberGithubSkip(
                  deps.worker.sits,
                  owner,
                  repo,
                  prNumber,
                  release.reason,
                  logger
                );
                if (remembered) return remembered;
                return skipped(release.reason, logger);
              }
            } catch {
              // Fall through to the original skip below.
            }
            const remembered = await rememberGithubSkip(
              deps.worker.sits,
              owner,
              repo,
              prNumber,
              decision.reason,
              logger
            );
            if (remembered) return remembered;
          }
        }
        return skipped(decision.reason, logger);
      }
      const job: IssueJob = { ...decision.job, delivery, receivedAt: new Date().toISOString() };
      const result: EnqueueResult = await deps.worker.queue.enqueue(job);
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      if (result.queued) {
        const cleared = await clearGithubSit(deps.worker.sits, job.owner, job.repo, job.issueNumber, logger);
        if (cleared) return cleared;
      }
      return json(202, result);
    }

    if (event !== "issues") return skipped(`unsupported event ${event ?? "unknown"}`, logger);

    const payload = parseIssuesPayload(rawBody);
    if (payload.action === "closed" || payload.action === "merged") {
      try {
        const owner = payload.repository.full_name.split("/")[0] ?? "";
        const repo = payload.repository.full_name.split("/")[1] ?? "";
        if (owner && repo) {
          if (deps.worker.handoffs) await deps.worker.handoffs.deleteForIssue(owner, repo, payload.issue.number);
          await deleteCheckpointForIssueViaForge(deps.worker.api ?? {}, owner, repo, payload.issue.number, {
            log: logger,
          });
        }
      } catch {
        // Best-effort handoff/checkpoint cleanup only.
      }
    }
    // The label webhook reads the repository's default-branch settings for
    // its name: missing, unreadable, or invalid falls back to `jumi`. The
    // same read supplies the effective trusted list (intersection, never
    // widening on invalid).
    const [issueOwner, issueRepo] = payload.repository.full_name.split("/");
    const effectiveIssuePolicy =
      issueOwner && issueRepo
        ? await effectiveGithubPolicyForRepo(
            deps.worker.api,
            issueOwner,
            issueRepo,
            payload.repository.default_branch,
            policy,
            logger
          )
        : policy;
    // Dependency wakes below only re-check work a pusher already picked up; the gate is this event's own trigger.
    const decision = await requireSenderPush(
      shouldEnqueueGithubIssue(payload, effectiveIssuePolicy),
      deps.worker.api,
      payload.sender?.login,
      effectiveIssuePolicy.trustedSenderLogins
    );

    if (decision.type === "cancel") {
      const result = deps.worker.cancel
        ? await deps.worker.cancel(decision.owner, decision.repo, decision.issueNumber)
        : { key: cancelKey(decision.owner, decision.repo, decision.issueNumber), cancelled: true as const };
      await deleteCheckpointForIssueViaForge(
        deps.worker.api ?? {},
        decision.owner,
        decision.repo,
        decision.issueNumber,
        {
          log: logger,
        }
      );
      logger(`cancelled ${result.key}`);
      const cleared = await clearGithubSit(
        deps.worker.sits,
        decision.owner,
        decision.repo,
        decision.issueNumber,
        logger
      );
      if (cleared) return cleared;
      return json(202, result);
    }

    const receivedAt = new Date().toISOString();
    const jobs: IssueJob[] = [];
    const seen = new Set<string>();
    const addJob = (partial: Omit<IssueJob, "delivery" | "receivedAt">) => {
      const key = `${partial.owner}/${partial.repo}#${partial.issueNumber}`;
      if (seen.has(key)) return;
      seen.add(key);
      jobs.push({ ...partial, delivery, receivedAt });
    };

    if (decision.type === "enqueue") addJob(await withIssueAuthorPermission(decision.job, deps.worker.api));

    if (isDependencyWakeAction(payload.action) && deps.worker.api?.listIssueBlocks) {
      try {
        const woken = await blockedIssueJobsToEnqueue(payload, effectiveIssuePolicy, {
          listIssueBlocks: deps.worker.api.listIssueBlocks,
          getIssue: deps.worker.api.getIssue,
          getRepo: deps.worker.api.getRepo,
        });
        for (const partial of woken) addJob(await withIssueAuthorPermission(partial, deps.worker.api));
      } catch (err) {
        if (isQueueUnavailable(err)) {
          logger(`queue unavailable: ${err.message}`);
          return json(503, { error: "queue unavailable" });
        }
        logger(`failed to wake waiting issues: ${errorMessage(err)}`);
        return json(503, { error: "failed to wake waiting issues" });
      }
    }

    if (jobs.length === 0) {
      if (decision.type === "skip") {
        if (payload.action === "closed" || payload.action === "merged") {
          try {
            const owner = payload.repository.full_name.split("/")[0] ?? "";
            const repo = payload.repository.full_name.split("/")[1] ?? "";
            if (owner && repo) {
              if (deps.worker.handoffs) await deps.worker.handoffs.deleteForIssue(owner, repo, payload.issue.number);
              await deleteCheckpointForIssueViaForge(deps.worker.api ?? {}, owner, repo, payload.issue.number, {
                log: logger,
              });
            }
          } catch {
            // Best-effort handoff/checkpoint cleanup only.
          }
          const cleared = await clearGithubSit(
            deps.worker.sits,
            payload.repository.full_name.split("/")[0] ?? "",
            payload.repository.full_name.split("/")[1] ?? "",
            payload.issue.number,
            logger
          );
          if (cleared) return cleared;
          return skipped(decision.reason, logger);
        }
        const [owner, repo] = payload.repository.full_name.split("/");
        if (owner && repo) {
          const remembered = await rememberGithubSkip(
            deps.worker.sits,
            owner,
            repo,
            payload.issue.number,
            decision.reason,
            logger
          );
          if (remembered) return remembered;
        }
        return skipped(decision.reason, logger);
      }
      return skipped("no blocked issues to wake", logger);
    }

    return enqueueJobs(jobs, deps.worker.queue, delivery, logger, deps.worker.sits);
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`queue unavailable: ${err.message}`);
      return json(503, { error: "queue unavailable" });
    }
    logger(`invalid webhook payload: ${errorMessage(err)}`);
    return json(400, { error: "invalid webhook payload" });
  }
}

export async function handleGithubWebhook(
  request: Request,
  config: GithubMailboxConfig,
  deps: GithubWebhookDeps
): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method not allowed" });
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json(415, { error: "expected application/json" });
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > config.maxWebhookBytes) {
    return json(413, { error: "webhook payload too large" });
  }

  const secret = githubMailboxSecret(config);
  const signatureOk = await verifyGithubSignature(rawBody, secret, request.headers.get("x-hub-signature-256"));
  if (!signatureOk) return json(401, { error: "invalid signature" });

  // The replay check runs after verification on purpose: an unauthenticated
  // request must get 401, never a 202 probe answer, and must not occupy an
  // LRU slot that could evict real deliveries.
  const deliveryHeader = request.headers.get("x-github-delivery");
  const delivery = deliveryHeader ?? crypto.randomUUID();
  if (deliveryHeader && deps.deliveryDedupe?.has(delivery)) {
    deps.logger?.(`deduped replay delivery=${delivery}`);
    return json(202, { queued: false, deduped: true });
  }

  const response = await handleGithubWebhookEvent(
    rawBody,
    request.headers.get("x-github-event"),
    delivery,
    githubWebhookPolicy(config),
    deps
  );
  // Durable outcomes only: a 400/500/503 leaves the delivery unmarked so the
  // forge retry is processed, not answered as a replay.
  if (deliveryHeader && (response.status === 200 || response.status === 202)) {
    deps.deliveryDedupe?.mark(delivery);
  }
  return response;
}
