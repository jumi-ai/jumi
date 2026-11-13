import { deleteCheckpointForIssueViaForge } from "./checkpoint.ts";
import {
  parseWorkflowJobPayload,
  shouldEnqueueSiblingCheckReview,
  shouldEnqueueWorkflowJobFollowUp,
  shouldEnqueueWorkflowJobReview,
} from "./ci_webhook.ts";
import {
  effectiveFollowupIgnoreLogins,
  effectiveIgnoreConflictsLabel,
  effectiveTrustedSenderLogins,
  loadRepoSettings,
} from "./repo_settings.ts";
import {
  parseIssueCommentPayload,
  parsePullRejectedPayload,
  requireSenderPush,
  shouldEnqueueIssueCommentFollowUpWithTrust,
  shouldEnqueuePullAssign,
  shouldEnqueuePullRejectedFollowUpWithTrust,
} from "./followup_webhook.ts";
import { extractClosingIssueNumbers, type IssueApi, upsertWorkerComment } from "./gitea_issues.ts";
import {
  blockedIssueJobsToEnqueue,
  isDependencyWakeAction,
  isPullWaitClearAction,
  parseIssuesPayload,
  pullWaitClearJobsToEnqueue,
  shouldEnqueueIssue,
} from "./issue_webhook.ts";
import { withIssueAuthorPermission } from "./permissions.ts";
import { parsePushPayload, shouldEnqueuePushConflicts } from "./push_webhook.ts";
import type { EnqueueResult } from "./queue.ts";
import { enqueueCiWakeWithGate } from "./review_gate.ts";
import { isQueueUnavailable, type ReviewJobStore } from "./review_jobs.ts";
import { isKickableSitReason, normalizeSitReason, type RouterSitStore } from "./router_sits.ts";
import type { IssueJob, ReviewJob } from "./types.ts";
import { assertRepositoryPolicy, parsePullRequestPayload, peekWebhookAction, type WebhookPolicy } from "./webhook.ts";

export type WorkerWebhookPolicy = WebhookPolicy & {
  botUsername: string;
  followupIgnoreLogins?: readonly string[];
  trustedSenderLogins?: readonly string[];
  ignoreConflictsLabel?: string;
  pickupLabel?: string;
  automergeRepos?: readonly string[];
  automergeEnabled?: boolean;
  forgeKind?: string;
};

/**
 * Resolve the effective per-repository worker policy from one
 * default-branch settings read. Missing, invalid, or unreadable files fall
 * back to the deployment policy. Never throws. Gitea ignores `pickup_label`.
 */
export async function effectiveWorkerPolicyForRepo(
  api: { getRepoFile?: (owner: string, repo: string, path: string, ref: string) => Promise<{ found: boolean; content?: string }> } | undefined,
  owner: string,
  repo: string,
  defaultBranch: string | undefined | null,
  basePolicy: WorkerWebhookPolicy,
  log?: (message: string) => void
): Promise<WorkerWebhookPolicy> {
  const branch = typeof defaultBranch === "string" && defaultBranch.trim() ? defaultBranch.trim() : "";
  if (!api || typeof api.getRepoFile !== "function" || !branch) return basePolicy;
  try {
    const settings = await loadRepoSettings(api, owner, repo, branch);
    if (settings.state !== "valid") {
      if (settings.state === "invalid") log?.(`repo settings invalid for ${owner}/${repo}@${branch}: ${settings.error}`);
      return basePolicy;
    }
    return {
      ...basePolicy,
      trustedSenderLogins: effectiveTrustedSenderLogins(basePolicy.trustedSenderLogins, settings),
      followupIgnoreLogins: effectiveFollowupIgnoreLogins(basePolicy.followupIgnoreLogins, settings),
      ignoreConflictsLabel: effectiveIgnoreConflictsLabel(basePolicy.ignoreConflictsLabel, settings),
    };
  } catch (err) {
    log?.(`repo settings unreadable for ${owner}/${repo}@${branch}: ${err instanceof Error ? err.message : String(err)}`);
    return basePolicy;
  }
}

export interface WorkerWebhookQueue {
  enqueue(job: IssueJob): EnqueueResult | Promise<EnqueueResult>;
}

export type WorkerWebhookApi = Pick<IssueApi, "listOpenPulls" | "getIssue"> &
  Partial<
    Pick<
      IssueApi,
      | "getRepo"
      | "listIssueBlocks"
      | "listRepoIssues"
      | "getPR"
      | "getCollaboratorPermission"
      | "getAppPermissions"
      | "listPullCommits"
      | "deleteGitRef"
      | "getRepoFile"
      | "addIssueAssignees"
      | "addIssueLabel"
      | "findStickyIssueComment"
      | "createIssueComment"
      | "updateIssueComment"
      | "getBranch"
      | "scheduleAutoMerge"
      | "cancelAutoMerge"
    >
  > &
  Partial<Pick<import("./ports.ts").Forge, "getPRFiles" | "listIssueTimeline">> & {
    rememberInstallation?: (installationId: string, owner?: string, repo?: string) => void;
  };

export interface WorkerReviewQueue {
  enqueue(job: ReviewJob, opts?: import("./review_jobs.ts").EnqueueReviewOpts): EnqueueResult | Promise<EnqueueResult>;
}

export interface HandleWorkerWebhookDeps {
  queue: WorkerWebhookQueue;
  review?: WorkerReviewQueue;
  api?: WorkerWebhookApi;
  cancel?: (owner: string, repo: string, issueNumber: number) => Promise<{ key: string; cancelled: true }>;
  logger?: (message: string) => void;
  sits?: RouterSitStore;
  /** Previous-round handoff notes; deleted when an issue closes. Best-effort. */
  handoffs?: Pick<import("./handoff.ts").HandoffStore, "deleteForIssue">;
  /** Full forge for router-side CI gating (pending -> waiting). */
  ciApi?: Pick<
    import("./review.ts").ReviewApi,
    "listCommitStatuses" | "listCheckRuns" | "listActionJobs" | "getActionJobLogs"
  >;
  ciHome?: string;
}

/** Gitea HookEventType.Event() maps issues/issue_assign/issue_label/issue_milestone → "issues". */
export function isIssuesWebhookEvent(event: string | null, eventType: string | null): boolean {
  return event === "issues" || event === "issue_assign" || eventType === "issues" || eventType === "issue_assign";
}

const FOLLOWUP_EVENTS = new Set([
  "issue_comment",
  "pull_request_comment",
  "pull_request_rejected",
  "pull_request_review_comment",
  "pull_request_review_rejected",
]);

export function isFollowUpWebhookEvent(event: string | null, eventType: string | null): boolean {
  if (event === "pull_request") return false;
  return FOLLOWUP_EVENTS.has(event ?? "") || FOLLOWUP_EVENTS.has(eventType ?? "");
}

export function isPushWebhookEvent(event: string | null, eventType: string | null): boolean {
  return event === "push" || eventType === "push";
}

export function isWorkflowJobWebhookEvent(event: string | null, eventType: string | null): boolean {
  return event === "workflow_job" || eventType === "workflow_job";
}

export function isCommitStatusWebhookEvent(event: string | null, eventType: string | null): boolean {
  return event === "status" || eventType === "status";
}

export function isPullAssignWebhookEvent(event: string | null, eventType: string | null): boolean {
  return event === "pull_request" || event === "pull_request_assign" || eventType === "pull_request_assign";
}

export function isWorkerWebhookEvent(event: string | null, eventType: string | null): boolean {
  return (
    isIssuesWebhookEvent(event, eventType) ||
    isFollowUpWebhookEvent(event, eventType) ||
    isPushWebhookEvent(event, eventType) ||
    isWorkflowJobWebhookEvent(event, eventType) ||
    isPullAssignWebhookEvent(event, eventType)
  );
}

function isPullRejectedEvent(event: string | null, eventType: string | null): boolean {
  return (
    event === "pull_request_rejected" ||
    eventType === "pull_request_rejected" ||
    eventType === "pull_request_review_rejected"
  );
}

function isPullRequestPayloadFollowUp(event: string | null, eventType: string | null): boolean {
  if (event === "pull_request" || event === "issue_comment") return false;
  return (
    isPullRejectedEvent(event, eventType) ||
    event === "pull_request_comment" ||
    eventType === "pull_request_review_comment"
  );
}

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

async function rememberSkipSit(
  sits: RouterSitStore | undefined,
  owner: string | undefined,
  repo: string | undefined,
  number: number | undefined,
  reason: string,
  logger: (message: string) => void
): Promise<Response | undefined> {
  if (!sits || !owner || !repo || number == null || !Number.isFinite(number)) return undefined;
  // Push is out of scope and never touches sits. Unknown reasons never grow a kick button.
  const code = normalizeSitReason(reason);
  if (!code || !isKickableSitReason(code)) return undefined;
  try {
    await sits.remember(owner, repo, number, code);
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

async function clearSitForEnqueue(
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

/** Best-effort checkpoint cleanup when a PR closes: the PR's own ref plus any
 * issue it closes (jumi closer bodies say `Fixes #N`). Deleting a missing ref
 * is not an error; failures are logged once and never fail the webhook. */
async function deleteCheckpointsForPrCloseBestEffort(
  api: WorkerWebhookApi | undefined,
  owner: string,
  repo: string,
  prNumber: number,
  body: string | null | undefined,
  logger: (message: string) => void
): Promise<void> {
  if (!api?.deleteGitRef) return;
  const targets = new Set<number>([prNumber, ...extractClosingIssueNumbers({ number: prNumber, body } as never)]);
  for (const issueNumber of targets) {
    await deleteCheckpointForIssueViaForge(api, owner, repo, issueNumber, { log: logger });
  }
}

async function deleteCheckpointForCancelBestEffort(
  api: WorkerWebhookApi | undefined,
  owner: string,
  repo: string,
  issueNumber: number,
  logger: (message: string) => void
): Promise<void> {
  if (!api?.deleteGitRef) return;
  await deleteCheckpointForIssueViaForge(api, owner, repo, issueNumber, { log: logger });
}

/** Best-effort closed/merged marker for the board requeue filter. Never fails the webhook. */
async function markPullClosedBestEffort(
  sits: RouterSitStore | undefined,
  owner: string,
  repo: string,
  number: number,
  logger: (message: string) => void
): Promise<void> {
  if (!sits?.markPullClosed || !owner || !repo || !Number.isFinite(number)) return;
  try {
    await sits.markPullClosed(owner, repo, number);
  } catch (err) {
    logger(`closed marker remember failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function wakeFailedResponse(err: unknown, logger: (message: string) => void): Response {
  if (isQueueUnavailable(err)) {
    logger(`queue unavailable: ${err.message}`);
    return json(503, { error: "queue unavailable" });
  }
  logger(`failed to wake waiting issues: ${err instanceof Error ? err.message : String(err)}`);
  return json(503, { error: "failed to wake waiting issues" });
}

function cancelKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

async function enqueueJobList(
  jobs: IssueJob[],
  queue: WorkerWebhookQueue,
  delivery: string,
  logger: (message: string) => void,
  sits?: RouterSitStore
): Promise<Response> {
  if (jobs.length === 1) {
    const job = jobs[0];
    if (!job) return skipped("no waiting issues to wake", logger);
    const result: EnqueueResult = await queue.enqueue(job);
    logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
    if (result.queued && sits) {
      const cleared = await clearSitForEnqueue(sits, job.owner, job.repo, job.issueNumber, logger);
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
      const cleared = await clearSitForEnqueue(sits, job.owner, job.repo, job.issueNumber, logger);
      if (cleared) return cleared;
    }
  }
  return json(202, { queued: true, keys });
}

async function wakeJobsFromPull(
  payload: ReturnType<typeof parsePullRequestPayload>,
  delivery: string,
  policy: WorkerWebhookPolicy,
  deps: HandleWorkerWebhookDeps,
  logger?: (message: string) => void
): Promise<IssueJob[]> {
  if (!deps.api) return [];
  const partials = await pullWaitClearJobsToEnqueue(payload, policy, deps.api, logger);
  const receivedAt = new Date().toISOString();
  const jobs: IssueJob[] = [];
  for (const partial of partials) {
    jobs.push({ ...(await withIssueAuthorPermission(partial, deps.api)), delivery, receivedAt });
  }
  return jobs;
}

export async function cancelLedgerWorkerJobs(opts: {
  store: Pick<ReviewJobStore, "cancelQueuedForIssue" | "clearIssueSkipLatch">;
  api: Pick<IssueApi, "findStickyIssueComment" | "createIssueComment" | "updateIssueComment">;
  owner: string;
  repo: string;
  issueNumber: number;
  botUsername: string;
  logger?: (message: string) => void;
}): Promise<{ key: string; cancelled: true }> {
  const key = cancelKey(opts.owner, opts.repo, opts.issueNumber);
  await opts.store.clearIssueSkipLatch(opts.owner, opts.repo, opts.issueNumber);
  const cancelled = await opts.store.cancelQueuedForIssue(opts.owner, opts.repo, opts.issueNumber);
  // Queued rows settle here, so the router posts `stopped` for them. Leased
  // rows are only marked cancel_requested (not counted above): the running
  // one-shot job posts `stopped` itself when it observes the mark and
  // settles via markCancelled.
  if (cancelled > 0) {
    try {
      await upsertWorkerComment(opts.api, opts.owner, opts.repo, opts.issueNumber, opts.botUsername, "stopped");
    } catch (err) {
      opts.logger?.(`stopped comment failed ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { key, cancelled: true };
}

export async function handleWorkerWebhookEvent(
  rawBody: Uint8Array,
  event: string | null,
  eventType: string | null,
  delivery: string,
  policy: WorkerWebhookPolicy,
  deps: HandleWorkerWebhookDeps
): Promise<Response> {
  const logger = deps.logger ?? ((message: string) => console.log(message));
  if (event === "ping" || eventType === "ping") return json(200, { ok: true });
  // Per-PR auto-merge override labels on a Jumi PR schedule or cancel without
  // enqueueing worker work. The bot's own copy event is ignored. Falls through
  // when the event is not an automerge label on a Jumi PR.
  {
    const action = peekWebhookAction(rawBody);
    if (action === "labeled" || action === "unlabeled") {
      try {
        const { tryHandleAutomergeLabelEvent } = await import("./automerge_webhook.ts");
        const handled = await tryHandleAutomergeLabelEvent({
          rawBody,
          policy: {
            ...policy,
            forgeKind: (policy as { forgeKind?: string }).forgeKind ?? "gitea",
          },
          api: deps.api as never,
          log: logger,
        });
        if (handled.handled) return json(202, { queued: false, reason: handled.reason });
      } catch (err) {
        logger(`automerge label webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // Gitea 1.27: PR assignment is pull_request_assign; X-Gitea-Event is still pull_request.
  // Handle only assigned/unassigned. Any other pull_request action skips 202, never 400.
  if (isPullAssignWebhookEvent(event, eventType)) {
    const action = peekWebhookAction(rawBody);
    if (action === "opened") {
      try {
        const payload = parsePullRequestPayload(rawBody);
        const { shouldEnqueueTakeoverForOpenedPull } = await import("./takeover.ts");
        const [owner, repo] = payload.repository.full_name.split("/");
        if (!owner || !repo) return skipped("invalid webhook payload", logger);
        try {
          assertRepositoryPolicy(payload.repository, policy);
        } catch (err) {
          logger(`repository not allowed: ${err instanceof Error ? err.message : String(err)}`);
          return skipped("repository not allowed", logger);
        }
        const decision = await shouldEnqueueTakeoverForOpenedPull({
          api: (deps.api ?? {}) as never,
          forgeKind: (policy as { forgeKind?: string }).forgeKind ?? "gitea",
          owner,
          repo,
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
        const job = { ...decision.job, delivery, receivedAt: new Date().toISOString() };
        const result = await deps.queue.enqueue(job);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
        if (result.queued && deps.sits) {
          const cleared = await clearSitForEnqueue(deps.sits, job.owner, job.repo, job.issueNumber, logger);
          if (cleared) return cleared;
        }
        return json(202, result);
      } catch (err) {
        if (isQueueUnavailable(err)) {
          logger(`queue unavailable: ${(err as Error).message}`);
          return json(503, { error: "queue unavailable" });
        }
        logger(`invalid webhook payload: ${err instanceof Error ? err.message : String(err)}`);
        return json(400, { error: "invalid webhook payload" });
      }
    }
    if (action !== "assigned" && action !== "unassigned" && !isPullWaitClearAction(action)) {
      return skipped(
        action ? `unsupported action ${action}` : `unsupported event ${event ?? eventType ?? "pull_request"}`,
        logger
      );
    }
    try {
      const payload = parsePullRequestPayload(rawBody);
      if (action === "closed" || action === "merged") {
        assertRepositoryPolicy(payload.repository, policy);
        {
          const [owner, repo] = payload.repository.full_name.split("/");
          if (owner && repo) {
            await deleteCheckpointsForPrCloseBestEffort(
              deps.api,
              owner,
              repo,
              payload.pull_request.number,
              payload.pull_request.body,
              logger
            );
          }
        }
        // Handoffs are keyed by issue number, not PR number: a PR close must
        // not delete an unrelated issue's note that shares the number.
        // Issue close cleans the right key on the issues closed path.
        try {
          const jobs = await wakeJobsFromPull(payload, delivery, policy, deps, logger);
          if (jobs.length === 0) {
            // Close or merge that needs no kick removes the record.
            if (deps.sits) {
              const [owner, repo] = payload.repository.full_name.split("/");
              if (owner && repo) {
                await markPullClosedBestEffort(deps.sits, owner, repo, payload.pull_request.number, logger);
                const cleared = await clearSitForEnqueue(deps.sits, owner, repo, payload.pull_request.number, logger);
                if (cleared) return cleared;
              }
            }
            return skipped(action ? `unsupported action ${action}` : "no waiting issues to wake", logger);
          }
          // The pull itself is closed even when blocked issues wake: mark it
          // so the board hides its requeue row. The woken issue rows are separate.
          try {
            const [owner, repo] = payload.repository.full_name.split("/");
            if (owner && repo) {
              await markPullClosedBestEffort(deps.sits, owner, repo, payload.pull_request.number, logger);
            }
          } catch {
            // Best-effort marker only; the enqueue below owns the response.
          }
          return enqueueJobList(jobs, deps.queue, delivery, logger, deps.sits);
        } catch (err) {
          return wakeFailedResponse(err, logger);
        }
      }
      const [paOwner, paRepo] = payload.repository.full_name.split("/");
      const effectivePaPolicy =
        paOwner && paRepo
          ? await effectiveWorkerPolicyForRepo(deps.api, paOwner, paRepo, payload.repository.default_branch, policy, logger)
          : policy;
      const decision = await requireSenderPush(
        await shouldEnqueuePullAssign(payload, effectivePaPolicy, deps.api, logger),
        deps.api,
        payload.sender?.login,
        effectivePaPolicy.trustedSenderLogins
      );
      if (decision.type === "skip") {
        const [owner, repo] = payload.repository.full_name.split("/");
        if (owner && repo) {
          const remembered = await rememberSkipSit(
            deps.sits,
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
        const result = deps.cancel
          ? await deps.cancel(decision.owner, decision.repo, decision.issueNumber)
          : { key: cancelKey(decision.owner, decision.repo, decision.issueNumber), cancelled: true as const };
        await deleteCheckpointForCancelBestEffort(
          deps.api,
          decision.owner,
          decision.repo,
          decision.issueNumber,
          logger
        );
        logger(`cancelled ${result.key}`);
        if (deps.sits) {
          const cleared = await clearSitForEnqueue(
            deps.sits,
            decision.owner,
            decision.repo,
            decision.issueNumber,
            logger
          );
          if (cleared) return cleared;
        }
        try {
          const jobs = await wakeJobsFromPull(payload, delivery, policy, deps, logger);
          if (jobs.length > 0) return enqueueJobList(jobs, deps.queue, delivery, logger, deps.sits);
        } catch (err) {
          return wakeFailedResponse(err, logger);
        }
        return json(202, result);
      }
      const job: IssueJob = {
        ...decision.job,
        delivery,
        receivedAt: new Date().toISOString(),
      };
      const result: EnqueueResult = await deps.queue.enqueue(job);
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      if (result.queued && deps.sits) {
        const cleared = await clearSitForEnqueue(deps.sits, job.owner, job.repo, job.issueNumber, logger);
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
  // Gitea 1.27: assignment uses X-Gitea-Event=issues and X-Gitea-Event-Type=issue_assign.
  // Accept either header so a proxy that copies Event-Type into Event still works.
  if (isCommitStatusWebhookEvent(event, eventType)) {
    if (!deps.review || !deps.api) return skipped(`unsupported event ${event ?? eventType ?? "status"}`, logger);
    try {
      const decision = await shouldEnqueueSiblingCheckReview(rawBody, "status", policy, deps.api, logger);
      if (decision.type === "skip") return skipped(decision.reason, logger);
      const receivedAt = new Date().toISOString();
      const reviewResults: EnqueueResult[] = [];
      const ciHome = deps.ciHome ?? "/data";
      for (const partial of decision.jobs) {
        const gated = await enqueueCiWakeWithGate(
          deps.review,
          { ...partial, delivery, receivedAt },
          { ciApi: deps.ciApi, home: ciHome, logger }
        );
        if ("waiting" in gated) {
          logger(`waiting ${gated.key} delivery=${delivery}`);
          continue;
        }
        const result = gated;
        reviewResults.push(result);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
        if (result.queued && deps.sits) {
          const cleared = await clearSitForEnqueue(deps.sits, partial.owner, partial.repo, partial.prNumber, logger);
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
      logger(`status webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      return json(500, { error: "internal error" });
    }
  }
  if (!isWorkerWebhookEvent(event, eventType)) {
    return skipped(`unsupported event ${event ?? eventType ?? "unknown"}`, logger);
  }

  if (isWorkflowJobWebhookEvent(event, eventType)) {
    if (!deps.api) return skipped("not an in-scope jumi pull request", logger);
    let payload: ReturnType<typeof parseWorkflowJobPayload>;
    try {
      payload = parseWorkflowJobPayload(rawBody);
    } catch {
      return skipped("malformed workflow_job payload", logger);
    }
    try {
      const receivedAt = new Date().toISOString();
      const decision = await shouldEnqueueWorkflowJobFollowUp(payload, policy, deps.api, logger);
      const keys: string[] = [];
      if (decision.type === "enqueue") {
        for (const partial of decision.jobs) {
          const job: IssueJob = { ...partial, delivery, receivedAt };
          const result: EnqueueResult = await deps.queue.enqueue(job);
          keys.push(result.key);
          logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
          if (result.queued && deps.sits) {
            const cleared = await clearSitForEnqueue(deps.sits, job.owner, job.repo, job.issueNumber, logger);
            if (cleared) return cleared;
          }
        }
      }
      const reviewResults: EnqueueResult[] = [];
      if (deps.review) {
        const reviewDecision = await shouldEnqueueWorkflowJobReview(payload, policy, deps.api, logger);
        if (reviewDecision.type === "enqueue") {
          const ciHome = deps.ciHome ?? "/data";
          for (const partial of reviewDecision.jobs) {
            const gated = await enqueueCiWakeWithGate(
              deps.review,
              { ...partial, delivery, receivedAt },
              { ciApi: deps.ciApi, home: ciHome, logger }
            );
            if ("waiting" in gated) {
              logger(`waiting ${gated.key} delivery=${delivery}`);
              continue;
            }
            const result: EnqueueResult = gated;
            reviewResults.push(result);
            logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
            if (result.queued && deps.sits) {
              const cleared = await clearSitForEnqueue(
                deps.sits,
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
      if (keys.length > 0) return json(202, { queued: true, keys });
      if (reviewResults.length === 1 && reviewResults[0]) return json(202, reviewResults[0]);
      if (reviewResults.length > 1) return json(202, { queued: true, keys: reviewResults.map((item) => item.key) });
      if (reviewResults.length === 0 && deps.review) {
        // All review wakes are still waiting for CI: no Job yet, not a skip.
        const waitingSkip = decision.type === "skip" ? decision.reason : "CI still pending";
        // Keep the follow-up keys response when follow-ups were queued; otherwise
        // report the CI wait so the delivery is visible but not counted as done.
        if (keys.length === 0) return skipped(waitingSkip, logger);
      }
      return skipped(decision.type === "skip" ? decision.reason : "no matching pull request", logger);
    } catch (err) {
      if (isQueueUnavailable(err)) {
        logger(`queue unavailable: ${err.message}`);
        return json(503, { error: "queue unavailable" });
      }
      logger(`workflow job webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      return json(500, { error: "internal error" });
    }
  }

  if (isPushWebhookEvent(event, eventType)) {
    if (!deps.api) return skipped("no managed jumi PRs", logger);
    let payload: ReturnType<typeof parsePushPayload>;
    try {
      payload = parsePushPayload(rawBody);
    } catch {
      return skipped("malformed push payload", logger);
    }
    try {
      const decision = await shouldEnqueuePushConflicts(payload, policy, deps.api, logger);
      if (decision.type === "skip") return skipped(decision.reason, logger);
      const receivedAt = new Date().toISOString();
      const keys: string[] = [];
      for (const partial of decision.jobs) {
        const job: IssueJob = { ...partial, delivery, receivedAt };
        const result: EnqueueResult = await deps.queue.enqueue(job);
        keys.push(result.key);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      }
      return json(202, { queued: true, keys });
    } catch (err) {
      if (isQueueUnavailable(err)) {
        logger(`queue unavailable: ${err.message}`);
        return json(503, { error: "queue unavailable" });
      }
      logger(`push webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      return json(500, { error: "internal error" });
    }
  }

  try {
    if (isFollowUpWebhookEvent(event, eventType)) {
      const eventName = event ?? eventType ?? "issue_comment";
      let rawPayload:
        | { repository?: { full_name?: string; default_branch?: string }; issue?: { number?: number }; pull_request?: { number?: number } }
        | undefined;
      try {
        rawPayload = JSON.parse(new TextDecoder().decode(rawBody)) as {
          repository?: { full_name?: string; default_branch?: string };
          issue?: { number?: number };
          pull_request?: { number?: number };
        };
      } catch {
        rawPayload = undefined;
      }
      let effectiveFollowupPolicy = policy;
      try {
        const fullName = rawPayload?.repository?.full_name;
        const [fuOwner, fuRepo] = (fullName ?? "").split("/");
        if (fuOwner && fuRepo) {
          effectiveFollowupPolicy = await effectiveWorkerPolicyForRepo(
            deps.api,
            fuOwner,
            fuRepo,
            rawPayload?.repository?.default_branch,
            policy,
            logger
          );
        }
      } catch {
        // Fall back to the deployment policy.
      }
      const decision = isPullRequestPayloadFollowUp(event, eventType)
        ? await shouldEnqueuePullRejectedFollowUpWithTrust(
            parsePullRejectedPayload(rawBody),
            effectiveFollowupPolicy,
            eventName,
            undefined,
            deps.api
          )
        : await shouldEnqueueIssueCommentFollowUpWithTrust(
            parseIssueCommentPayload(rawBody),
            effectiveFollowupPolicy,
            eventName,
            undefined,
            deps.api
          );
      if (decision.type === "skip") {
        const fullName = rawPayload?.repository?.full_name;
        const [owner, repo] = (fullName ?? "").split("/");
        const prNumber = rawPayload?.pull_request?.number ?? rawPayload?.issue?.number;
        if (owner && repo && typeof prNumber === "number") {
          const remembered = await rememberSkipSit(deps.sits, owner, repo, prNumber, decision.reason, logger);
          if (remembered) return remembered;
        }
        return skipped(decision.reason, logger);
      }
      const job: IssueJob = {
        ...decision.job,
        delivery,
        receivedAt: new Date().toISOString(),
      };
      const result: EnqueueResult = await deps.queue.enqueue(job);
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      if (result.queued && deps.sits) {
        const cleared = await clearSitForEnqueue(deps.sits, job.owner, job.repo, job.issueNumber, logger);
        if (cleared) return cleared;
      }
      return json(202, result);
    }

    const payload = parseIssuesPayload(rawBody);
    if (payload.action === "closed" || payload.action === "merged") {
      try {
        const owner = payload.repository.full_name.split("/")[0] ?? "";
        const repo = payload.repository.full_name.split("/")[1] ?? "";
        if (owner && repo) {
          if (deps.handoffs) await deps.handoffs.deleteForIssue(owner, repo, payload.issue.number);
          await deleteCheckpointForIssueViaForge(deps.api ?? {}, owner, repo, payload.issue.number, { log: logger });
        }
      } catch {
        // Best-effort handoff/checkpoint cleanup only.
      }
    }
    const [issueOwner, issueRepo] = payload.repository.full_name.split("/");
    const effectiveIssuePolicy =
      issueOwner && issueRepo
        ? await effectiveWorkerPolicyForRepo(deps.api, issueOwner, issueRepo, payload.repository.default_branch, policy, logger)
        : policy;
    // Dependency wakes below only re-check work a pusher already picked up; the gate is this event's own trigger.
    const decision = await requireSenderPush(
      shouldEnqueueIssue(payload, effectiveIssuePolicy),
      deps.api,
      payload.sender?.login,
      effectiveIssuePolicy.trustedSenderLogins
    );

    if (decision.type === "cancel") {
      const result = deps.cancel
        ? await deps.cancel(decision.owner, decision.repo, decision.issueNumber)
        : { key: cancelKey(decision.owner, decision.repo, decision.issueNumber), cancelled: true as const };
      await deleteCheckpointForCancelBestEffort(deps.api, decision.owner, decision.repo, decision.issueNumber, logger);
      logger(`cancelled ${result.key}`);
      if (deps.sits) {
        const cleared = await clearSitForEnqueue(
          deps.sits,
          decision.owner,
          decision.repo,
          decision.issueNumber,
          logger
        );
        if (cleared) return cleared;
      }
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

    if (decision.type === "enqueue") addJob(await withIssueAuthorPermission(decision.job, deps.api));

    if (isDependencyWakeAction(payload.action) && deps.api?.listIssueBlocks) {
      try {
        const woken = await blockedIssueJobsToEnqueue(payload, effectiveIssuePolicy, {
          listIssueBlocks: deps.api.listIssueBlocks,
          getIssue: deps.api.getIssue,
          getRepo: deps.api.getRepo,
        });
        for (const partial of woken) addJob(await withIssueAuthorPermission(partial, deps.api));
      } catch (err) {
        return wakeFailedResponse(err, logger);
      }
    }

    if (jobs.length === 0) {
      if (decision.type === "skip") {
        // A close that needs no kick removes the record instead of sitting.
        if (payload.action === "closed" || payload.action === "merged") {
          try {
            const { owner, repo } = {
              owner: payload.repository.full_name.split("/")[0] ?? "",
              repo: payload.repository.full_name.split("/")[1] ?? "",
            };
            if (owner && repo && deps.sits) {
              await markPullClosedBestEffort(deps.sits, owner, repo, payload.issue.number, logger);
              const cleared = await clearSitForEnqueue(deps.sits, owner, repo, payload.issue.number, logger);
              if (cleared) return cleared;
            }
          } catch {
            // Repository policy failures already return 400; never sit here.
          }
          try {
            const owner = payload.repository.full_name.split("/")[0] ?? "";
            const repo = payload.repository.full_name.split("/")[1] ?? "";
            if (owner && repo) {
              if (deps.handoffs) await deps.handoffs.deleteForIssue(owner, repo, payload.issue.number);
              await deleteCheckpointForIssueViaForge(deps.api ?? {}, owner, repo, payload.issue.number, {
                log: logger,
              });
            }
          } catch {
            // Best-effort handoff/checkpoint cleanup only.
          }
          return skipped(decision.reason, logger);
        }
        try {
          const { owner, repo } = {
            owner: payload.repository.full_name.split("/")[0] ?? "",
            repo: payload.repository.full_name.split("/")[1] ?? "",
          };
          if (owner && repo) {
            const remembered = await rememberSkipSit(
              deps.sits,
              owner,
              repo,
              payload.issue.number,
              decision.reason,
              logger
            );
            if (remembered) return remembered;
          }
        } catch {
          // Never sit on repository policy failures.
        }
        return skipped(decision.reason, logger);
      }
      return skipped("no blocked issues to wake", logger);
    }

    if (jobs.length === 1) {
      const job = jobs[0];
      if (!job) return skipped("no blocked issues to wake", logger);
      const result: EnqueueResult = await deps.queue.enqueue(job);
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      if (result.queued && deps.sits) {
        const cleared = await clearSitForEnqueue(deps.sits, job.owner, job.repo, job.issueNumber, logger);
        if (cleared) return cleared;
      }
      return json(202, result);
    }

    const keys: string[] = [];
    for (const job of jobs) {
      const result: EnqueueResult = await deps.queue.enqueue(job);
      keys.push(result.key);
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      if (result.queued && deps.sits) {
        const cleared = await clearSitForEnqueue(deps.sits, job.owner, job.repo, job.issueNumber, logger);
        if (cleared) return cleared;
      }
    }
    return json(202, { queued: true, keys });
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`queue unavailable: ${err.message}`);
      return json(503, { error: "queue unavailable" });
    }
    logger(`invalid webhook payload: ${err instanceof Error ? err.message : String(err)}`);
    return json(400, { error: "invalid webhook payload" });
  }
}
