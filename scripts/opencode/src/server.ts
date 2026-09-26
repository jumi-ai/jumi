import { hostname } from "node:os";
import { BOARD_PORT, createBoardFetchHandler } from "./board.ts";
import { CI_ABSENT_NOTE, CI_ABSENT_REASON, CI_LOOKUP_FAILED_REASON, decideCiLookupRetry } from "./ci.ts";
import type { ServiceConfig } from "./config.ts";
import { loadConfig, scrubSecretEnv } from "./config.ts";
import { meterWebhook, recordJobCompleted, renderProcessMetrics, renderWebhookMetrics } from "./control_metrics.ts";
import { formatBytes, logDiagnostic, sampleMemory } from "./diagnostics.ts";
import type { Engine } from "./engine.ts";
import { createForge } from "./forge.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { handleGithubWebhook, pickupPolicyForForge } from "./github_webhook.ts";
import { enqueueFollowUpFromReview } from "./handover.ts";
import { decideInfraRetry, engineInfraBreaker, type InfraCircuitBreaker, isInfraFailure } from "./infra.ts";
import { ensureOpenCodeWellKnownAuth } from "./opencode_auth.ts";
import type { EnqueueResult } from "./queue.ts";
import { isQuotaWaitError } from "./quota.ts";
import type { PersistReviewResult, ReviewApi, ReviewResult, WorkspacePreparer } from "./review.ts";
import {
  CI_RELIST_DELAY_MS,
  publishReviewResult,
  reviewJobKey,
  reviewPullRequest,
  skipReasonForHeadChange,
  skipReasonForOtherChecks,
  skipReasonForPR,
} from "./review.ts";
import {
  createPgReviewJobStore,
  HEARTBEAT_MS,
  hasPersistedResult,
  isQueueUnavailable,
  QUEUE_POLL_MS,
  REVIEW_KIND,
  type ReviewJobRecord,
  type ReviewJobStore,
  renderQueueMetrics,
} from "./review_jobs.ts";
import { clearSitBestEffort, rememberSitBestEffort } from "./router_sits.ts";
import { orderedRunners } from "./runners.ts";
import { installProcessShutdown, releaseLeaseOnShutdown, trackInFlightLease } from "./shutdown.ts";
import type { ReviewJob } from "./types.ts";
import {
  isReviewWebhookAction,
  parsePullRequestPayload,
  peekWebhookAction,
  validateWebhookPayload,
  verifyGiteaSignature,
} from "./webhook.ts";
import { cancelLedgerWorkerJobs, type HandleWorkerWebhookDeps, handleWorkerWebhookEvent } from "./worker_webhook.ts";
import type { GitRunner } from "./workspace.ts";
import { createReviewWorkspace, gitAuthResolverFor, removeReviewWorkspace } from "./workspace.ts";
import { adoptOrphanXaiSibling } from "./xai_auth.ts";

function log(message: string) {
  console.log(`[server] ${message}`);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authMatches(actual: string | null, expected?: string): boolean {
  if (!expected) return true;
  return actual === expected || actual === `Bearer ${expected}`;
}

export function shouldSeedOpenCodeAuth(role: ServiceConfig["role"]): boolean {
  return role !== "router";
}

export interface ReviewQueueLike {
  enqueue(job: ReviewJob): EnqueueResult | Promise<EnqueueResult>;
}

export interface FetchHandlerDeps {
  queue: ReviewQueueLike;
  logger?: (message: string) => void;
  renderMetrics?: () => string | Promise<string>;
  webhookEnabled?: boolean;
  getPR?: ReviewApi["getPR"];
  worker?: HandleWorkerWebhookDeps;
}

export interface RunReviewJobExtras {
  persistResult?: (result: PersistReviewResult) => Promise<void>;
  engine?: Engine;
  openCodeRunner?: Engine;
  workspacePreparer?: WorkspacePreparer;
  gitRunner?: GitRunner;
  abortSignal?: AbortSignal;
  heartbeatMs?: number;
  jobId?: string;
  breaker?: InfraCircuitBreaker;
  ciRelistDelayMs?: number;
  /** Lookup budget expired with no checks. Review, and say the repository has no CI. */
  assumeNoCi?: boolean;
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  now?: () => number;
  /** Previous job error (quota-wait marker) for the wait-budget decision. */
  previousError?: string | null;
}

export async function runReviewJob(
  config: ServiceConfig,
  job: ReviewJob,
  api: ReviewApi,
  logger: (message: string) => void = log,
  extras: RunReviewJobExtras = {}
): Promise<ReviewResult> {
  const pr = await api.getPR(job.owner, job.repo, job.prNumber);
  const early = skipReasonForPR(pr) ?? skipReasonForHeadChange(pr, job.headSha);
  if (early) {
    logger(`${job.owner}/${job.repo}#${job.prNumber} skipped: ${early}`);
    return { status: "skipped", reason: early };
  }
  let noCiNote: string | undefined;
  if (!extras.assumeNoCi) {
    const ciSkip = await skipReasonForOtherChecks(
      {
        api,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        home: config.home,
        abortSignal: extras.abortSignal,
        ciRelistDelayMs: extras.ciRelistDelayMs,
      },
      job.headSha,
      logger
    );
    if (ciSkip) {
      logger(`${job.owner}/${job.repo}#${job.prNumber} skipped: ${ciSkip}`);
      return { status: "skipped", reason: ciSkip };
    }
  } else {
    const ciSkip = await skipReasonForOtherChecks(
      {
        api,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        home: config.home,
        abortSignal: extras.abortSignal,
        relist: false,
      },
      job.headSha,
      logger
    );
    if (ciSkip && ciSkip !== CI_ABSENT_REASON) {
      logger(`${job.owner}/${job.repo}#${job.prNumber} skipped: ${ciSkip}`);
      return { status: "skipped", reason: ciSkip };
    }
    if (ciSkip === CI_ABSENT_REASON) noCiNote = CI_ABSENT_NOTE;
  }
  const workspace = await createReviewWorkspace(config.workdir, job);
  try {
    const result = await reviewPullRequest({
      api,
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      expectedHeadSha: job.headSha,
      model: config.model,
      variant: config.variant,
      fallbackModel: config.fallbackModel,
      fallbackVariant: config.fallbackVariant,
      chain: orderedRunners(config),
      remainingLeaseMs: extras.remainingLeaseMs,
      extendLease: extras.extendLease,
      workspace,
      giteaUrl: config.giteaUrl,
      giteaToken: config.giteaToken,
      gitAuthResolver: gitAuthResolverFor(config, api, { owner: job.owner, repo: job.repo }),
      botUsername: config.botUsername,
      home: config.home,
      sanitizeOpenCodeEnv: true,
      timeoutMs: config.opencodeTimeoutMs,
      maxFiles: config.maxFiles,
      maxPatchBytes: config.maxPatchBytes,
      maxOutputBytes: config.maxOutputBytes,
      maxIncompleteRetries: config.maxIncompleteRetries,
      logger: (message) => logger(message),
      persistResult: extras.persistResult,
      engine: extras.engine ?? extras.openCodeRunner,
      workspacePreparer: extras.workspacePreparer,
      gitRunner: extras.gitRunner,
      abortSignal: extras.abortSignal,
      jobId: extras.jobId ?? job.delivery,
      ciRelistDelayMs: extras.ciRelistDelayMs,
      inspectOtherChecks: false,
      noCiNote,
      previousError: extras.previousError,
    });
    logger(`${job.owner}/${job.repo}#${job.prNumber} ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  } finally {
    const before = await sampleMemory(process.pid);
    logDiagnostic(logger, "workspace_remove_start", {
      review: `${job.owner}/${job.repo}#${job.prNumber}`,
      workspace,
      parent_rss_bytes: before.rssBytes,
      parent_rss_h: formatBytes(before.rssBytes),
      cgroup_bytes: before.cgroupBytes,
      cgroup_h: formatBytes(before.cgroupBytes),
    });
    await removeReviewWorkspace(workspace);
    const after = await sampleMemory(process.pid);
    logDiagnostic(logger, "workspace_remove_end", {
      review: `${job.owner}/${job.repo}#${job.prNumber}`,
      workspace,
      parent_rss_bytes: after.rssBytes,
      parent_rss_h: formatBytes(after.rssBytes),
      cgroup_bytes: after.cgroupBytes,
      cgroup_h: formatBytes(after.cgroupBytes),
    });
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "cancelled");
}

function bindAbort(signal: AbortSignal | undefined, fn: () => void): void {
  if (!signal) return;
  if (signal.aborted) {
    fn();
    return;
  }
  signal.addEventListener("abort", fn, { once: true });
}

export function createFetchHandler(config: ServiceConfig, deps: FetchHandlerDeps) {
  const logger = deps.logger ?? log;
  const webhookEnabled = deps.webhookEnabled ?? true;
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (url.pathname === "/metrics") {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" });
      const body = await (deps.renderMetrics ?? renderProcessMetrics)();
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    if (url.pathname === "/webhooks/github") {
      if (!webhookEnabled) return json(404, { error: "not found" });
      return meterWebhook(
        request.headers.get("x-github-event"),
        handleGithubWebhook(request, config, {
          review: deps.queue,
          worker: deps.worker,
          getPR: deps.getPR,
          logger,
        })
      );
    }
    if (url.pathname !== "/webhooks/gitea") return json(404, { error: "not found" });
    if (!webhookEnabled) return json(404, { error: "not found" });
    const event = request.headers.get("x-gitea-event");
    const eventType = request.headers.get("x-gitea-event-type");
    return meterWebhook(event || eventType || "unknown", handleGiteaWebhook());

    async function handleGiteaWebhook(): Promise<Response> {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      if (!request.headers.get("content-type")?.includes("application/json")) {
        return json(415, { error: "expected application/json" });
      }
      if (!authMatches(request.headers.get("authorization"), config.webhookAuthToken)) {
        return json(401, { error: "invalid authorization header" });
      }

      const rawBody = new Uint8Array(await request.arrayBuffer());
      if (rawBody.byteLength > config.maxWebhookBytes) {
        return json(413, { error: "webhook payload too large" });
      }
      const signatureOk = await verifyGiteaSignature(
        rawBody,
        config.webhookSecret,
        request.headers.get("x-gitea-signature")
      );
      if (!signatureOk) return json(401, { error: "invalid signature" });

      if (event === "ping" || eventType === "ping") return json(200, { ok: true });

      const delivery = request.headers.get("x-gitea-delivery") ?? crypto.randomUUID();
      const reviewAction = event === "pull_request" ? peekWebhookAction(rawBody) : undefined;
      if (event === "pull_request" && (!deps.worker || isReviewWebhookAction(reviewAction))) {
        try {
          const payload = parsePullRequestPayload(rawBody);
          const validation = validateWebhookPayload(payload, {
            giteaUrl: config.giteaUrl,
            allowedOrgs: config.allowedOrgs,
            allowedRepos: config.allowedRepos,
          });
          if ("skip" in validation) {
            logger(`skipped ${validation.skip}`);
            return json(202, { skipped: validation.skip });
          }

          const job = { ...validation, delivery };
          if (deps.getPR) {
            try {
              const pr = await deps.getPR(job.owner, job.repo, job.prNumber);
              if (job.headSha !== pr.head.sha) {
                const key = reviewJobKey(job);
                logger(`stale head ${key} current=${pr.head.sha}`);
                return json(202, { key, queued: false });
              }
            } catch (err) {
              logger(`pr head lookup failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          const result = await deps.queue.enqueue(job);
          logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
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

      if (deps.worker) {
        return handleWorkerWebhookEvent(
          rawBody,
          event,
          eventType,
          delivery,
          {
            giteaUrl: config.giteaUrl,
            allowedOrgs: config.allowedOrgs,
            allowedRepos: config.allowedRepos,
            botUsername: config.botUsername,
            followupIgnoreLogins: config.followupIgnoreLogins,
          },
          { ...deps.worker, logger: deps.worker.logger ?? logger }
        );
      }

      const skipReason = `unsupported event ${event ?? "unknown"}`;
      logger(`skipped ${skipReason}`);
      return json(202, { skipped: skipReason });
    }
  };
}

function publishedState(result: ReviewResult): "succeeded" | "skipped" {
  return result.status === "skipped" ? "skipped" : "succeeded";
}

export async function publishPersistedJob(
  api: ReviewApi,
  config: ServiceConfig,
  row: ReviewJobRecord,
  logger: (message: string) => void = log
): Promise<ReviewResult> {
  const result = await publishReviewResult({
    api,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.prNumber,
    expectedHeadSha: row.headSha,
    botUsername: config.botUsername,
    resultMarkdown: row.resultMarkdown,
    resultRunner: row.resultRunner,
    resultReason: row.resultReason,
    error: row.error,
    logger,
  });
  return result;
}

export async function reclaimExpiredJobs(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void = log
): Promise<ReclaimResultSummary> {
  const { requeued, publish } = await store.reclaimExpired(config.maxJobAttempts, undefined, HEARTBEAT_MS, [
    REVIEW_KIND,
  ]);
  for (const row of requeued) {
    logger(`requeued ${row.jobKey} attempt=${row.attempt}`);
  }
  for (const row of publish) {
    try {
      const result = await publishAndCompleteJob(store, api, config, row, logger);
      logger(`reclaim-published ${row.jobKey} ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
    } catch (err) {
      logger(`reclaim-publish failed ${row.jobKey}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        if (row.leasedBy == null) throw new Error(`cannot expire lease for job ${row.id}`);
        await store.expireLease(row.id, row.leasedBy);
      } catch (expireErr) {
        logger(
          `reclaim expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
        );
      }
    }
  }
  return { requeued: requeued.length, published: publish.length };
}

export interface ReclaimResultSummary {
  requeued: number;
  published: number;
}

async function handoverFollowUp(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  row: ReviewJobRecord,
  published: ReviewResult,
  logger: (message: string) => void
): Promise<void> {
  try {
    const current = await store.get(row.id);
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: current ?? row,
      ...pickupPolicyForForge(config.forge, config.botUsername),
      published,
      markdown: current?.resultMarkdown ?? row.resultMarkdown,
      maxFollowupRounds: config.maxFollowupRounds,
      logger,
    });
    if (result?.queued) logger(`handover follow-up ${result.key}`);
  } catch (err) {
    logger(`handover failed ${row.jobKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function publishAndCompleteJob(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  row: ReviewJobRecord,
  logger: (message: string) => void
): Promise<ReviewResult> {
  const result = await publishPersistedJob(api, config, row, logger);
  if (row.leasedBy == null) throw new Error(`cannot mark published for job ${row.id}`);
  const failed = Boolean(row.error) && !row.resultMarkdown;
  await store.markPublished(row.id, row.leasedBy, {
    state: failed ? "failed" : publishedState(result),
    reason: result.reason,
  });
  await handoverFollowUp(store, api, config, row, result, logger);
  return result;
}

function publishedJobResult(row: ReviewJobRecord, result: ReviewResult): "succeeded" | "skipped" | "failed" {
  if (row.error && !row.resultMarkdown) return "failed";
  return publishedState(result);
}

async function settleCiLookupFailure(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  row: ReviewJobRecord,
  leasedBy: string,
  nowMs: number,
  logger: (message: string) => void
): Promise<void> {
  if (row.rewakeRequested) {
    await store.markPublished(row.id, leasedBy, { state: "skipped", reason: CI_LOOKUP_FAILED_REASON });
    logger(`ci-lookup-rewake ${row.jobKey}`);
    return;
  }
  const decision = decideCiLookupRetry(row.error, nowMs);
  if (decision.action === "requeue") {
    const ok = await store.requeueInfra(row.id, leasedBy, decision.backoffMs, decision.marker, new Date(nowMs));
    if (!ok) {
      logger(`ci-lookup requeue failed ${row.jobKey}`);
      return;
    }
    logger(`ci-lookup-retry ${row.jobKey} backoff=${decision.backoffMs} n=${decision.count}`);
    return;
  }
  await store.saveResult(row.id, leasedBy, { kind: "error", error: decision.reason });
  const saved = await store.get(row.id);
  if (!saved || saved.leasedBy !== leasedBy) {
    logger(`ci-lookup exhaust lost lease ${row.jobKey}`);
    return;
  }
  const published = await publishAndCompleteJob(store, api, config, saved, logger);
  recordJobCompleted(row.kind, publishedJobResult(saved, published));
  logger(`ci-lookup-exhausted ${row.jobKey}: ${decision.reason}`);
}

async function settleCiAbsent(
  store: ReviewJobStore,
  config: ServiceConfig,
  api: ReviewApi,
  row: ReviewJobRecord,
  job: ReviewJob,
  leasedBy: string,
  nowMs: number,
  extras: RunReviewJobExtras,
  logger: (message: string) => void
): Promise<ReviewResult | undefined> {
  if (row.rewakeRequested) {
    await store.markPublished(row.id, leasedBy, { state: "skipped", reason: CI_ABSENT_REASON });
    logger(`ci-absent-rewake ${row.jobKey}`);
    return undefined;
  }
  const decision = decideCiLookupRetry(row.error, nowMs);
  if (decision.action === "requeue") {
    const ok = await store.requeueInfra(row.id, leasedBy, decision.backoffMs, decision.marker, new Date(nowMs));
    if (!ok) {
      logger(`ci-absent requeue failed ${row.jobKey}`);
      return undefined;
    }
    logger(`ci-absent-retry ${row.jobKey} backoff=${decision.backoffMs} n=${decision.count}`);
    return undefined;
  }
  logger(`ci-absent-exhausted ${row.jobKey}: reviewing with no CI`);
  return runReviewJob(config, job, api, logger, { ...extras, assumeNoCi: true });
}

export async function processEngineTick(
  store: ReviewJobStore,
  config: ServiceConfig,
  api: ReviewApi,
  leasedBy: string,
  extras: RunReviewJobExtras = {},
  logger: (message: string) => void = log
): Promise<"idle" | "processed"> {
  if (extras.abortSignal?.aborted) return "idle";
  const breaker = extras.breaker ?? engineInfraBreaker;
  if (!breaker.canLease()) {
    logger("breaker open");
    return "idle";
  }
  const nowMs = extras.now?.() ?? Date.now();
  const row = await store.lease(leasedBy, config.leaseMs, new Date(nowMs), [REVIEW_KIND]);
  if (!row) return "idle";
  if (extras.abortSignal?.aborted) {
    await store.releaseLease(row.id, leasedBy);
    return "idle";
  }

  const abort = new AbortController();
  bindAbort(extras.abortSignal, () => abort.abort());

  let heartbeatStopped = false;
  const loseLease = () => {
    if (heartbeatStopped) return;
    abort.abort();
  };
  const heartbeat = setInterval(() => {
    if (heartbeatStopped) return;
    void store.heartbeat(row.id, leasedBy, config.leaseMs).then(
      (ok) => {
        if (!ok) loseLease();
      },
      () => undefined
    );
  }, extras.heartbeatMs ?? HEARTBEAT_MS);
  const stopHeartbeat = () => {
    heartbeatStopped = true;
    clearInterval(heartbeat);
  };
  const untrack = trackInFlightLease(async () => {
    stopHeartbeat();
    await releaseLeaseOnShutdown(store, row.id, row.jobKey, leasedBy, logger, "engine expire failed");
  });

  try {
    const job: ReviewJob = {
      delivery: row.delivery,
      owner: row.owner,
      repo: row.repo,
      prNumber: row.prNumber,
      action: "synchronize",
      headSha: row.headSha,
      receivedAt: new Date(row.createdAt).toISOString(),
    };
    const runExtras: RunReviewJobExtras = {
      ...extras,
      abortSignal: abort.signal,
      jobId: String(row.id),
      previousError: row.error ?? extras.previousError ?? null,
      remainingLeaseMs: async () => {
        const current = await store.get(row.id);
        if (current?.leasedUntil == null) return 0;
        return Math.max(0, current.leasedUntil - Date.now());
      },
      extendLease: () => store.heartbeat(row.id, leasedBy, config.leaseMs),
      persistResult: async (persisted) => {
        await store.saveResult(row.id, leasedBy, persisted);
      },
    };
    let result = await runReviewJob(config, job, api, logger, runExtras);
    const current = await store.get(row.id);
    if (current?.state !== "leased" || current.leasedBy !== leasedBy) {
      stopHeartbeat();
      logger(`engine job ${row.jobKey} cancelled`);
      return "processed";
    }
    if (result.status === "skipped" && result.reason === CI_LOOKUP_FAILED_REASON) {
      stopHeartbeat();
      await settleCiLookupFailure(store, api, config, current, leasedBy, nowMs, logger);
      return "processed";
    }
    if (result.status === "skipped" && result.reason === CI_ABSENT_REASON) {
      const reviewed = await settleCiAbsent(store, config, api, current, job, leasedBy, nowMs, runExtras, logger);
      if (!reviewed) {
        stopHeartbeat();
        return "processed";
      }
      const after = await store.get(row.id);
      if (after?.state !== "leased" || after.leasedBy !== leasedBy) {
        stopHeartbeat();
        logger(`engine job ${row.jobKey} cancelled`);
        return "processed";
      }
      result = reviewed;
      if (result.status === "skipped" && result.reason === CI_LOOKUP_FAILED_REASON) {
        stopHeartbeat();
        await settleCiLookupFailure(store, api, config, after, leasedBy, nowMs, logger);
        return "processed";
      }
    }
    stopHeartbeat();
    const state = publishedState(result);
    await store.markPublished(row.id, leasedBy, { state, reason: result.reason });
    recordJobCompleted(row.kind, state);
    if (result.status === "skipped" && result.reason) {
      await rememberSitBestEffort(store.sits, row.owner, row.repo, row.prNumber, result.reason, logger);
    } else {
      await clearSitBestEffort(store.sits, row.owner, row.repo, row.prNumber, logger);
    }
    await handoverFollowUp(store, api, config, row, result, logger);
    breaker.recordModelReached();
    return "processed";
  } catch (err) {
    const shutdown = Boolean(extras.abortSignal?.aborted);
    logger(
      shutdown
        ? `engine job ${row.jobKey} interrupted`
        : abort.signal.aborted || isAbortError(err)
          ? `engine job ${row.jobKey} cancelled`
          : `engine job ${row.jobKey} failed: ${err instanceof Error ? err.message : String(err)}`
    );
    stopHeartbeat();
    if (!shutdown && !abort.signal.aborted && isQuotaWaitError(err)) {
      try {
        const ok = await store.requeueInfra(row.id, leasedBy, err.backoffMs, err.marker);
        if (!ok) {
          logger(`engine quota requeue failed ${row.jobKey}: lease lost or result persisted`);
          try {
            await store.expireLease(row.id, leasedBy);
          } catch (expireErr) {
            logger(
              `engine expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
            );
          }
        } else {
          logDiagnostic(logger, "opencode_quota_wait", {
            count: err.count,
            next_at: new Date(Date.now() + err.backoffMs).toISOString(),
            budget_remaining_ms: err.budgetRemainingMs,
          });
          logger(`quota-wait ${row.jobKey} backoff=${err.backoffMs} n=${err.count}`);
        }
      } catch (quotaErr) {
        logger(
          `engine quota requeue failed ${row.jobKey}: ${quotaErr instanceof Error ? quotaErr.message : String(quotaErr)}`
        );
        try {
          await store.expireLease(row.id, leasedBy);
        } catch (expireErr) {
          logger(
            `engine expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
          );
        }
      }
      return "processed";
    }
    if (!shutdown && !abort.signal.aborted && isInfraFailure(err)) {
      breaker.recordInfra();
      try {
        const decision = decideInfraRetry(row.error, Date.now());
        if (decision.action === "exhaust") {
          await store.saveResult(row.id, leasedBy, { kind: "error", error: decision.reason });
          const current = await store.get(row.id);
          if (current) {
            const published = await publishAndCompleteJob(store, api, config, current, logger);
            recordJobCompleted(current.kind, publishedJobResult(current, published));
          }
          logger(`infra-published ${row.jobKey} failed: ${decision.reason}`);
        } else {
          await store.requeueInfra(row.id, leasedBy, decision.backoffMs, decision.marker);
          logger(`infra-retry ${row.jobKey} backoff=${decision.backoffMs} n=${decision.count}`);
        }
      } catch (infraErr) {
        logger(
          `engine infra requeue failed ${row.jobKey}: ${infraErr instanceof Error ? infraErr.message : String(infraErr)}`
        );
        try {
          await store.expireLease(row.id, leasedBy);
        } catch (expireErr) {
          logger(
            `engine expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
          );
        }
      }
      return "processed";
    }
    if (!shutdown && !abort.signal.aborted) breaker.recordModelReached();
    let published = false;
    try {
      const current = await store.get(row.id);
      if (current && current.leasedBy !== leasedBy) {
        published = true;
      } else if (current && hasPersistedResult(current)) {
        const publishedResult = await publishAndCompleteJob(store, api, config, current, logger);
        recordJobCompleted(current.kind, publishedJobResult(current, publishedResult));
        published = true;
      }
    } catch (publishErr) {
      logger(
        `engine publish failed ${row.jobKey}: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}`
      );
    }
    if (!published) {
      if (shutdown) {
        await releaseLeaseOnShutdown(store, row.id, row.jobKey, leasedBy, logger, "engine expire failed");
      } else if (!abort.signal.aborted) {
        try {
          await store.expireLease(row.id, leasedBy);
        } catch (expireErr) {
          logger(
            `engine expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
          );
        }
      }
    }
    return "processed";
  } finally {
    untrack();
    stopHeartbeat();
  }
}

function engineId(): string {
  return `engine-${hostname()}-${process.pid}-${crypto.randomUUID()}`;
}

function workerMailboxApi(api: ReviewApi): HandleWorkerWebhookDeps["api"] {
  const extra = api as ReviewApi &
    Partial<Pick<IssueApi, "listOpenPulls" | "listIssueBlocks" | "listRepoIssues">> & {
      rememberInstallation?: (installationId: string, owner?: string, repo?: string) => void;
    };
  return {
    getIssue: (owner, repo, index) => api.getIssue(owner, repo, index),
    getRepo: (owner, repo) => api.getRepo(owner, repo),
    getPR: (owner, repo, index) => api.getPR(owner, repo, index),
    getCollaboratorPermission: (owner, repo, username) => api.getCollaboratorPermission(owner, repo, username),
    listOpenPulls: (owner, repo) => (extra.listOpenPulls ? extra.listOpenPulls(owner, repo) : Promise.resolve([])),
    listIssueBlocks: extra.listIssueBlocks
      ? (owner, repo, index) => extra.listIssueBlocks!(owner, repo, index)
      : undefined,
    listRepoIssues: extra.listRepoIssues ? (owner, repo, opts) => extra.listRepoIssues!(owner, repo, opts) : undefined,
    rememberInstallation: extra.rememberInstallation?.bind(extra),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true }
    );
  });
}

export interface StartReviewerDeps {
  api?: ReviewApi;
  store?: ReviewJobStore;
  ensureAuth?: typeof ensureOpenCodeWellKnownAuth;
  logger?: (message: string) => void;
  extras?: RunReviewJobExtras;
  signal?: AbortSignal;
  listen?: boolean;
}

export interface StartedReviewer {
  role: ServiceConfig["role"];
  server?: ReturnType<typeof Bun.serve>;
  boardServer?: ReturnType<typeof Bun.serve>;
  store?: ReviewJobStore;
  stop: () => void;
}

async function serveAndWait(
  config: ServiceConfig,
  fetch: (request: Request) => Promise<Response>,
  logger: (message: string) => void,
  deps: StartReviewerDeps
): Promise<StartedReviewer> {
  if (deps.listen === false) {
    return { role: config.role, store: deps.store, stop: () => undefined };
  }
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch,
  });
  logger(`listening on ${server.hostname}:${server.port} role=${config.role}`);
  return {
    role: config.role,
    server,
    store: deps.store,
    stop: () => server.stop(true),
  };
}

export async function startReviewer(config: ServiceConfig, deps: StartReviewerDeps = {}): Promise<StartedReviewer> {
  const logger = deps.logger ?? log;
  const api = deps.api ?? createForge(config);

  if (shouldSeedOpenCodeAuth(config.role)) {
    await adoptOrphanXaiSibling(config.home, logger).catch((err) =>
      logger(`xAI sibling adoption failed: ${err instanceof Error ? err.message : String(err)}`)
    );
    await (deps.ensureAuth ?? ensureOpenCodeWellKnownAuth)({
      home: config.home,
      url: config.opencodeWellKnownUrl,
      key: config.opencodeWellKnownKey,
      token: config.opencodeWellKnownToken,
      logger,
    });
  }

  const store = deps.store ?? (await createPgReviewJobStore(config.databaseUrl ?? ""));
  deps = { ...deps, store };

  if (config.role === "router") {
    const started = await serveAndWait(
      config,
      createFetchHandler(config, {
        queue: store,
        logger,
        renderMetrics: async () => `${await renderQueueMetrics(store)}${renderWebhookMetrics()}`,
        getPR: (owner, repo, index) => api.getPR(owner, repo, index),
        worker: {
          queue: { enqueue: (job) => store.enqueueIssue(job) },
          review: store,
          api: workerMailboxApi(api),
          cancel: (owner, repo, issueNumber) =>
            cancelLedgerWorkerJobs({
              store,
              api,
              owner,
              repo,
              issueNumber,
              botUsername: config.botUsername,
              logger,
            }),
          logger,
          sits: store.sits,
        },
      }),
      logger,
      deps
    );
    if (deps.listen !== false) {
      // Operator board on its own port. Same process (no sidecar, no new
      // Deployment), same ledger, single replica with no leader election.
      // Polling GET only; the webhook host never serves the board paths.
      let boardServer: ReturnType<typeof Bun.serve>;
      try {
        boardServer = Bun.serve({
          hostname: config.host,
          port: BOARD_PORT,
          fetch: createBoardFetchHandler({ store, logger, forge: config.forge, forgeUrl: config.giteaUrl }),
        });
      } catch (err) {
        try {
          started.stop();
        } catch {
          // Best-effort: the webhook listener must not leak on board bind failure.
        }
        throw err;
      }
      logger(`board listening on ${boardServer.hostname}:${boardServer.port} role=${config.role}`);
      started.boardServer = boardServer;
      const reclaim = new AbortController();
      const run = async () => {
        while (!reclaim.signal.aborted) {
          try {
            await reclaimExpiredJobs(store, api, config, logger);
          } catch (err) {
            if (reclaim.signal.aborted) return;
            logger(`reclaim failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          await sleep(QUEUE_POLL_MS, reclaim.signal).catch(() => undefined);
        }
      };
      void run();
      const stop = started.stop;
      started.stop = () => {
        reclaim.abort();
        try {
          boardServer.stop(true);
        } catch {
          // Best-effort: webhook stop below still runs.
        }
        stop();
      };
      bindAbort(deps.signal, () => started.stop());
    }
    return started;
  }

  const leasedBy = engineId();
  const shutdown = new AbortController();
  const stopEngine = () => {
    if (!shutdown.signal.aborted) shutdown.abort();
  };
  bindAbort(deps.signal, stopEngine);
  const started = await serveAndWait(
    config,
    createFetchHandler(config, {
      queue: {
        enqueue: () => {
          throw new Error("engine does not accept webhooks");
        },
      },
      logger,
      webhookEnabled: false,
      renderMetrics: renderProcessMetrics,
    }),
    logger,
    deps
  );
  if (deps.listen !== false) {
    const run = async () => {
      while (!shutdown.signal.aborted) {
        try {
          const result = await processEngineTick(
            store,
            config,
            api,
            leasedBy,
            { ciRelistDelayMs: CI_RELIST_DELAY_MS, ...deps.extras, abortSignal: shutdown.signal },
            logger
          );
          if (result === "idle") await sleep(QUEUE_POLL_MS, shutdown.signal);
        } catch (err) {
          if (shutdown.signal.aborted) return;
          logger(`engine tick failed: ${err instanceof Error ? err.message : String(err)}`);
          await sleep(QUEUE_POLL_MS, shutdown.signal).catch(() => undefined);
        }
      }
    };
    void run();
  }
  const httpStop = started.stop;
  started.stop = () => {
    stopEngine();
    httpStop();
  };
  return started;
}

async function main() {
  const config = loadConfig();
  scrubSecretEnv();
  const shutdown = new AbortController();
  installProcessShutdown(shutdown, log);
  await startReviewer(config, { signal: shutdown.signal });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[server] Fatal error:", err);
    process.exit(1);
  });
}
