import { hasLabel, type IssueAssignees, type PickupPolicy } from "./assignee.ts";
import {
  parseWorkflowJobPayload,
  shouldEnqueueSiblingCheckReview,
  shouldEnqueueWorkflowJobFollowUp,
  shouldEnqueueWorkflowJobReview,
} from "./ci_webhook.ts";
import {
  parseIssueCommentPayload,
  parsePullRejectedPayload,
  shouldEnqueueIssueCommentFollowUpWithTrust,
  shouldEnqueuePullLabel,
  shouldEnqueuePullRejectedFollowUpWithTrust,
} from "./followup_webhook.ts";
import type { ForgeKind } from "./forge.ts";
import { isWipOrDraft } from "./gitea_issues.ts";
import { githubInstallationFromPayload } from "./github_auth.ts";
import {
  blockedIssueJobsToEnqueue,
  type IssueWebhookDecision,
  isDependencyWakeAction,
  issueJobFrom,
  parseIssuesPayload,
} from "./issue_webhook.ts";
import { parsePushPayload, shouldEnqueuePushConflicts } from "./push_webhook.ts";
import type { EnqueueResult } from "./queue.ts";
import { isQueueUnavailable } from "./review_jobs.ts";
import { normalizeSitReason, type RouterSitStore } from "./router_sits.ts";
import type { GiteaIssuePayload, IssueJob, ReviewJob } from "./types.ts";
import {
  assertRepositoryPolicy,
  parsePullRequestPayload,
  peekWebhookAction,
  verifyGiteaSignature,
  type WebhookPolicy,
} from "./webhook.ts";
import { type HandleWorkerWebhookDeps, handleWorkerWebhookEvent, type WorkerWebhookPolicy } from "./worker_webhook.ts";

export const JUMI_LABEL = "jumi";
export const GITHUB_ORIGIN = "https://github.com";
export const GITHUB_REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
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
};

export type GithubReviewQueue = {
  enqueue(job: ReviewJob): EnqueueResult | Promise<EnqueueResult>;
};

export type GithubWebhookDeps = {
  review?: GithubReviewQueue;
  worker?: HandleWorkerWebhookDeps;
  getPR?: (owner: string, repo: string, index: number) => Promise<{ head: { sha: string } }>;
  logger?: (message: string) => void;
  rememberInstallation?: (installationId: string, owner?: string, repo?: string) => void;
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
    logger(`sit remember failed: ${err instanceof Error ? err.message : String(err)}`);
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
    logger(`sit clear failed: ${err instanceof Error ? err.message : String(err)}`);
    return json(503, { error: "queue unavailable" });
  }
  return undefined;
}

function cancelKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

export function githubMailboxSecret(config: GithubMailboxConfig): string {
  if (config.githubWebhookSecret) return config.githubWebhookSecret;
  if (config.forge === "github") return config.webhookSecret;
  return "";
}

export function pickupPolicyForForge(forge: ForgeKind | undefined, botUsername: string): PickupPolicy {
  return { botUsername, isPickedUp: forge === "github" ? hasJumiLabel : undefined };
}

export function githubWebhookPolicy(config: GithubMailboxConfig): GithubWebhookPolicy {
  const ignore = new Set([
    ...(config.followupIgnoreLogins ?? []).map((login) => login.toLowerCase()),
    ...DEFAULT_GITHUB_FOLLOWUP_IGNORES.map((login) => login.toLowerCase()),
  ]);
  return {
    giteaUrl: GITHUB_ORIGIN,
    allowedOrgs: config.allowedOrgs,
    allowedRepos: config.allowedRepos,
    botUsername: config.botUsername,
    followupIgnoreLogins: [...ignore],
    isPickedUp: hasJumiLabel,
  };
}

export function hasJumiLabel(issue: IssueAssignees): boolean {
  return hasLabel(issue, JUMI_LABEL);
}

export function isJumiLabel(label: { name?: string } | string | null | undefined): boolean {
  const name = typeof label === "string" ? label : (label?.name ?? "");
  return name.toLowerCase() === JUMI_LABEL;
}

export function isGithubBotSender(sender: { login?: string; type?: string } | undefined): boolean {
  if (!sender) return false;
  if (sender.type && sender.type.toLowerCase() === "bot") return true;
  return /\[bot\]$/i.test(sender.login ?? "");
}

export function isFactoryBotSender(sender: { login?: string } | undefined, botUsername: string): boolean {
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
  policy: WebhookPolicy & { botUsername: string }
): IssueWebhookDecision {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);

  if (payload.issue.pull_request != null) {
    return { type: "skip", reason: "pull request issue" };
  }

  if (payload.action === "unlabeled") {
    if (!isJumiLabel(payload.label)) return { type: "skip", reason: "unlabeled other label" };
    return { type: "cancel", owner, repo, issueNumber: payload.issue.number };
  }

  if (payload.action === "labeled") {
    if (isFactoryBotSender(payload.sender, policy.botUsername)) return { type: "skip", reason: "sender is bot" };
    if (!isJumiLabel(payload.label)) return { type: "skip", reason: "labeled other label" };
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
  policy: WebhookPolicy
): ReviewJob | { skip: string } {
  if (!GITHUB_REVIEW_ACTIONS.has(payload.action)) {
    return { skip: `unsupported action ${payload.action}` };
  }
  if (isWipOrDraft(payload.pull_request)) return { skip: "draft or WIP pull request" };
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function workflowJobBody(rawBody: Uint8Array): Uint8Array {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObject(parsed)) return rawBody;
  if (parsed.workflow_job != null) return rawBody;
  const run = parsed.workflow_run;
  if (!isObject(run)) return rawBody;
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
  if (!isObject(parsed) || parsed.issue != null) return rawBody;
  const pr = parsed.pull_request;
  if (!isObject(pr)) return rawBody;
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
  if (isObject(existing) && isObject(existing.head) && typeof existing.head.ref === "string" && existing.head.ref) {
    return rawBody;
  }
  const issue = parsed.issue;
  if (!isObject(issue) || issue.pull_request == null) return rawBody;
  const repository = parsed.repository;
  if (!isObject(repository) || typeof repository.full_name !== "string") return rawBody;
  const [owner, repo] = repository.full_name.split("/");
  if (!owner || !repo || typeof issue.number !== "number") return rawBody;
  const getPR = deps.getPR ?? deps.worker?.api?.getPR;
  if (!getPR) return rawBody;
  try {
    const pr = await getPR(owner, repo, issue.number);
    return encodeJson({ ...parsed, pull_request: pr });
  } catch (err) {
    logger(`pr lookup failed: ${err instanceof Error ? err.message : String(err)}`);
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
      for (const partial of decision.jobs) {
        const result = await deps.review.enqueue({ ...partial, delivery, receivedAt });
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
      return json(202, { queued: true, keys: reviewResults.map((item) => item.key) });
    } catch (err) {
      if (isQueueUnavailable(err)) {
        logger(`queue unavailable: ${err.message}`);
        return json(503, { error: "queue unavailable" });
      }
      logger(`status webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      return json(500, { error: "internal error" });
    }
  }

  if (event === "pull_request") {
    const action = peekWebhookAction(rawBody);
    if (action && GITHUB_REVIEW_ACTIONS.has(action) && deps.review) {
      try {
        const payload = parsePullRequestPayload(rawBody);
        const validation = validateGithubReview(payload, policy);
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
            logger(`pr head lookup failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const result = await deps.review.enqueue(job);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
        if (result.queued) {
          const cleared = await clearGithubSit(reviewSitsFor(deps), job.owner, job.repo, job.prNumber, logger);
          if (cleared) return cleared;
        }
        return json(202, result);
      } catch (err) {
        if (isQueueUnavailable(err)) {
          logger(`queue unavailable: ${err.message}`);
          return json(503, { error: "queue unavailable" });
        }
        logger(`invalid webhook payload: ${err instanceof Error ? err.message : String(err)}`);
        return json(400, { error: "invalid webhook payload" });
      }
    }
    if (deps.worker && (action === "labeled" || action === "unlabeled")) {
      try {
        const payload = parsePullRequestPayload(rawBody);
        const decision = await shouldEnqueuePullLabel(payload, policy, deps.worker.api, logger);
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
        logger(`invalid webhook payload: ${err instanceof Error ? err.message : String(err)}`);
        return json(400, { error: "invalid webhook payload" });
      }
    }
    if (deps.worker && (action === "closed" || action === "merged")) {
      return handleWorkerWebhookEvent(rawBody, event, event, delivery, policy, {
        ...deps.worker,
        logger: deps.worker.logger ?? logger,
      });
    }
    return skipped(action ? `unsupported action ${action}` : `unsupported event ${event ?? "pull_request"}`, logger);
  }

  if (!deps.worker) return skipped(`unsupported event ${event ?? "unknown"}`, logger);

  try {
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
          for (const partial of reviewDecision.jobs) {
            const result = await deps.review.enqueue({ ...partial, delivery, receivedAt });
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
      if (decision.type === "skip") return skipped(decision.reason, logger);
      const receivedAt = new Date().toISOString();
      const jobs: IssueJob[] = [];
      for (const partial of decision.jobs) {
        const job: IssueJob = { ...partial, delivery, receivedAt };
        const prNumber = job.prNumber;
        const getPR = deps.getPR ?? deps.worker.api.getPR;
        if (prNumber != null && getPR) {
          try {
            const pr = await getPR(job.owner, job.repo, prNumber);
            if (pr.head?.sha) job.headSha = pr.head.sha;
          } catch (err) {
            logger(`mergeable lookup failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        jobs.push(job);
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
      const sender = isObject(parsed) && isObject(parsed.sender) ? parsed.sender : undefined;
      const githubSender = sender as { login?: string; type?: string } | undefined;
      if (isFactoryBotSender(githubSender, policy.botUsername)) {
        return skipped("sender is bot", logger);
      }
      if (isIgnoredFollowupSender(githubSender, policy.followupIgnoreLogins)) {
        return skipped("sender ignored", logger);
      }
      const eventName = event ?? "issue_comment";
      let commentBody = rawBody;
      if (event === "pull_request_review_comment") commentBody = issueCommentBody(rawBody);
      else if (event === "issue_comment" && isObject(parsed)) {
        const resolved = await issueCommentPullRequestBody(rawBody, parsed, deps, logger);
        if (resolved == null) return json(503, { error: "pr lookup failed" });
        commentBody = resolved;
      }
      const decision =
        event === "pull_request_review"
          ? await shouldEnqueuePullRejectedFollowUpWithTrust(
              parsePullRejectedPayload(rawBody),
              policy,
              eventName,
              undefined,
              deps.worker.api
            )
          : await shouldEnqueueIssueCommentFollowUpWithTrust(
              parseIssueCommentPayload(commentBody),
              policy,
              eventName,
              undefined,
              deps.worker.api
            );
      if (decision.type === "skip") {
        const fullName =
          isObject(parsed) && isObject(parsed.repository) && typeof parsed.repository.full_name === "string"
            ? (parsed.repository.full_name as string)
            : undefined;
        const prNumber =
          isObject(parsed) && isObject(parsed.pull_request) && typeof parsed.pull_request.number === "number"
            ? (parsed.pull_request.number as number)
            : isObject(parsed) && isObject(parsed.issue) && typeof parsed.issue.number === "number"
              ? (parsed.issue.number as number)
              : undefined;
        if (fullName) {
          const [owner, repo] = fullName.split("/");
          if (owner && repo && typeof prNumber === "number") {
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
    const decision = shouldEnqueueGithubIssue(payload, policy);

    if (decision.type === "cancel") {
      const result = deps.worker.cancel
        ? await deps.worker.cancel(decision.owner, decision.repo, decision.issueNumber)
        : { key: cancelKey(decision.owner, decision.repo, decision.issueNumber), cancelled: true as const };
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

    if (decision.type === "enqueue") addJob(decision.job);

    if (isDependencyWakeAction(payload.action) && deps.worker.api?.listIssueBlocks) {
      try {
        const woken = await blockedIssueJobsToEnqueue(payload, policy, {
          listIssueBlocks: deps.worker.api.listIssueBlocks,
          getIssue: deps.worker.api.getIssue,
          getRepo: deps.worker.api.getRepo,
        });
        for (const partial of woken) addJob(partial);
      } catch (err) {
        if (isQueueUnavailable(err)) {
          logger(`queue unavailable: ${err.message}`);
          return json(503, { error: "queue unavailable" });
        }
        logger(`failed to wake waiting issues: ${err instanceof Error ? err.message : String(err)}`);
        return json(503, { error: "failed to wake waiting issues" });
      }
    }

    if (jobs.length === 0) {
      if (decision.type === "skip") {
        if (payload.action === "closed" || payload.action === "merged") {
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
    logger(`invalid webhook payload: ${err instanceof Error ? err.message : String(err)}`);
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

  return handleGithubWebhookEvent(
    rawBody,
    request.headers.get("x-github-event"),
    request.headers.get("x-github-delivery") ?? crypto.randomUUID(),
    githubWebhookPolicy(config),
    deps
  );
}
