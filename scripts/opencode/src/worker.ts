import {
  ciStatePath,
  claimFilePath,
  conflictStatePath,
  deleteClaim,
  followUpStatePath,
  isPidAlive,
  readClaim,
  stuckStatePath,
  syncHomeSkipLatch,
} from "./claim.ts";
import { implementConflict } from "./conflict.ts";
import { recordJobCompleted } from "./control_metrics.ts";
import { logDiagnostic } from "./diagnostics.ts";
import { implementFollowUp, parsePrHeadChangedReason } from "./followup.ts";
import { createForge } from "./forge.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { pickupPolicyForForge } from "./github_webhook.ts";
import { cancelIssueWork, implementIssue, issueJobKey } from "./implement.ts";
import { decideInfraRetry, type InfraCircuitBreaker, isInfraFailure, workerInfraBreaker } from "./infra.ts";
import { conflictJobIfUnmergeable, pushedPrNumber } from "./pickup.ts";
import { ReviewQueue } from "./queue.ts";
import { isQuotaWaitError, type QuotaCooldown, workerQuotaCooldown } from "./quota.ts";
import { HEARTBEAT_MS, issueJobFromRecord, type ReviewJobStore, WORKER_JOB_KINDS } from "./review_jobs.ts";
import { clearSitBestEffort, rememberSitBestEffort } from "./router_sits.ts";
import { orderedRunners } from "./runners.ts";
import { releaseLeaseOnShutdown, trackInFlightLease } from "./shutdown.ts";
import { type SkipLatchStore, skipLatchesFor } from "./skip_latches.ts";
import { isSkipLatchReason } from "./stuck.ts";
import type { IssueJob } from "./types.ts";
import type { WorkerConfig } from "./worker_config.ts";
import { gitAuthResolverFor } from "./workspace.ts";

export { issueJobKey };

export interface WorkerQueueLike {
  enqueue(job: IssueJob): { key: string; queued: boolean } | Promise<{ key: string; queued: boolean }>;
}

export interface RunWorkerJobExtras {
  implement?: typeof implementIssue;
  followUp?: typeof implementFollowUp;
  conflict?: typeof implementConflict;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  breaker?: InfraCircuitBreaker;
  quotaCooldown?: QuotaCooldown;
}

function log(message: string) {
  console.log(`[worker] ${message}`);
}

export function createIssueQueue(
  config: WorkerConfig,
  api: IssueApi = createForge(config),
  logger: (message: string) => void = log,
  skipLatches?: SkipLatchStore
): ReviewQueue<IssueJob> {
  const aborts = new Map<string, AbortController>();

  const queue = new ReviewQueue<IssueJob>(
    async (job: IssueJob) => {
      const key = issueJobKey(job);
      const abort = new AbortController();
      aborts.set(key, abort);
      try {
        const shared = {
          api,
          job,
          giteaUrl: config.giteaUrl,
          giteaToken: config.giteaToken,
          gitAuthResolver: gitAuthResolverFor(config, api, { owner: job.owner, repo: job.repo }),
          ...pickupPolicyForForge(config.forge, config.botUsername),
          followupIgnoreLogins: config.followupIgnoreLogins,
          model: config.model,
          variant: config.variant,
          fallbackModel: config.fallbackModel,
          fallbackVariant: config.fallbackVariant,
          chain: orderedRunners(config),
          home: config.home,
          skipLatches,
          workdir: config.workdir,
          maxOutputBytes: config.maxOutputBytes,
          sanitizeOpenCodeEnv: true,
          abortSignal: abort.signal,
          logger: (message: string) => logger(message),
          jobId: job.delivery,
        };
        const result =
          job.mode === "conflict"
            ? await implementConflict({
                ...shared,
                timeoutMs: config.conflictTimeoutMs,
                maxConflictRounds: config.maxConflictRounds,
              })
            : job.mode === "follow-up"
              ? await implementFollowUp({
                  ...shared,
                  timeoutMs: config.followupTimeoutMs,
                  conflictTimeoutMs: config.conflictTimeoutMs,
                  maxFollowupRounds: config.maxFollowupRounds,
                  maxConflictRounds: config.maxConflictRounds,
                })
              : await implementIssue({
                  ...shared,
                  timeoutMs: config.opencodeTimeoutMs,
                  followupTimeoutMs: config.followupTimeoutMs,
                  conflictTimeoutMs: config.conflictTimeoutMs,
                  maxFollowupRounds: config.maxFollowupRounds,
                  maxConflictRounds: config.maxConflictRounds,
                });
        logger(`${key} ${result.status}${result.status === "skipped" ? `: ${result.reason}` : ""}`);
      } finally {
        aborts.delete(key);
      }
    },
    config.queueConcurrency,
    logger,
    issueJobKey
  );

  (queue as ReviewQueue<IssueJob> & { aborts: Map<string, AbortController> }).aborts = aborts;
  return queue;
}

export function abortIssueJob(queue: ReviewQueue<IssueJob>, key: string): void {
  const withAborts = queue as ReviewQueue<IssueJob> & { aborts?: Map<string, AbortController> };
  withAborts.aborts?.get(key)?.abort();
}

export function abortIssueQueue(queue: ReviewQueue<IssueJob>): void {
  const withAborts = queue as ReviewQueue<IssueJob> & { aborts?: Map<string, AbortController> };
  for (const abort of withAborts.aborts?.values() ?? []) abort.abort();
}

function bindAbort(signal: AbortSignal | undefined, fn: () => void): void {
  if (!signal) return;
  if (signal.aborted) {
    fn();
    return;
  }
  signal.addEventListener("abort", fn, { once: true });
}

function abortLocalJob(
  aborts: Map<string, AbortController> | undefined,
  pids: Map<string, number> | undefined,
  key: string
): void {
  aborts?.get(key)?.abort();
  const pid = pids?.get(key);
  if (pid && pid !== process.pid && isPidAlive(pid)) {
    try {
      process.kill(pid);
    } catch {
      // Child may have already exited.
    }
  }
}

export async function handleIssueCancel(
  config: WorkerConfig,
  api: IssueApi,
  owner: string,
  repo: string,
  issueNumber: number,
  queue?: ReviewQueue<IssueJob>,
  store?: ReviewJobStore,
  aborts?: Map<string, AbortController>,
  pids?: Map<string, number>,
  skipLatches?: SkipLatchStore
): Promise<{ key: string; cancelled: true }> {
  const key = issueJobKey({ owner, repo, issueNumber });
  if (queue) {
    queue.drop(key);
    abortIssueJob(queue, key);
  }
  abortLocalJob(aborts, pids, key);
  const latches = skipLatches ?? store?.skipLatches ?? skipLatchesFor(config);
  const latch = store ? await store.clearIssueSkipLatch(owner, repo, issueNumber) : undefined;
  if (!store || latches !== store.skipLatches) {
    await latches.delete({ owner, repo, issueNumber });
  }
  const cancelledQueued = store ? await store.cancelQueuedForIssue(owner, repo, issueNumber) : 0;
  const claimPath = claimFilePath(config.home, owner, repo, issueNumber);
  const claim = await readClaim(claimPath);
  if (latch) {
    await syncHomeSkipLatch(config.home, owner, repo, issueNumber, latch.generation);
  } else {
    await deleteClaim(followUpStatePath(config.home, owner, repo, issueNumber));
    await deleteClaim(conflictStatePath(config.home, owner, repo, issueNumber));
    await deleteClaim(ciStatePath(config.home, owner, repo, issueNumber));
    await deleteClaim(stuckStatePath(config.home, owner, repo, issueNumber));
  }
  if (claim?.terminal) {
    await deleteClaim(claimPath);
    return { key, cancelled: true };
  }
  const skipClaimKill = store ? { killPid: () => undefined } : {};
  if (!claim) {
    if (cancelledQueued > 0) {
      await cancelIssueWork({
        api,
        owner,
        repo,
        issueNumber,
        botUsername: config.botUsername,
        home: config.home,
        ...skipClaimKill,
      });
    }
    return { key, cancelled: true };
  }
  await cancelIssueWork({
    api,
    owner,
    repo,
    issueNumber,
    botUsername: config.botUsername,
    home: config.home,
    ...skipClaimKill,
  });
  return { key, cancelled: true };
}

function workerPublishedState(status: string): "succeeded" | "skipped" | "failed" {
  if (status === "skipped" || status === "cancelled" || status === "no-changes") return "skipped";
  if (status === "failed") return "failed";
  return "succeeded";
}

function skipLatchReasonFromResult(result: { status: string; reason?: string }): string | undefined {
  if (result.status === "skipped" && isSkipLatchReason(result.reason)) return result.reason;
  if (result.status === "stuck") return result.reason ?? "stuck: cannot resolve conflicts";
  return undefined;
}

export async function reclaimExpiredWorkerJobs(
  store: ReviewJobStore,
  maxAttempts: number,
  logger: (message: string) => void = log
): Promise<{ requeued: number; published: number }> {
  const { requeued, publish } = await store.reclaimExpired(maxAttempts, undefined, HEARTBEAT_MS, WORKER_JOB_KINDS);
  for (const row of requeued) {
    logger(`requeued ${row.jobKey} attempt=${row.attempt}`);
  }
  for (const row of publish) {
    try {
      if (row.leasedBy == null) throw new Error(`cannot mark published for job ${row.id}`);
      await store.markPublished(row.id, row.leasedBy, {
        state: "failed",
        reason: row.error ?? row.resultReason ?? undefined,
      });
      logger(`reclaim-published ${row.jobKey} failed${row.error ? `: ${row.error}` : ""}`);
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

export async function processWorkerTick(
  store: ReviewJobStore,
  config: WorkerConfig,
  api: IssueApi,
  leasedBy: string,
  extras: RunWorkerJobExtras = {},
  logger: (message: string) => void = log,
  aborts?: Map<string, AbortController>,
  pids?: Map<string, number>
): Promise<"idle" | "processed"> {
  if (extras.abortSignal?.aborted) return "idle";
  const breaker = extras.breaker ?? workerInfraBreaker;
  if (!breaker.canLease()) {
    logger("breaker open");
    return "idle";
  }
  const quotaCooldown = extras.quotaCooldown ?? workerQuotaCooldown;
  if (!quotaCooldown.canLease()) {
    if (quotaCooldown.takeLog()) logger("quota cooldown");
    return "idle";
  }
  const row = await store.lease(leasedBy, config.leaseMs, undefined, WORKER_JOB_KINDS);
  if (!row) return "idle";
  if (extras.abortSignal?.aborted) {
    await store.releaseLease(row.id, leasedBy);
    return "idle";
  }

  const key = issueJobKey({ owner: row.owner, repo: row.repo, issueNumber: row.issueNumber ?? 0 });
  const abort = new AbortController();
  aborts?.set(key, abort);
  bindAbort(extras.abortSignal, () => {
    abort.abort();
    abortLocalJob(aborts, pids, key);
  });

  let heartbeatStopped = false;
  const loseLease = () => {
    if (heartbeatStopped) return;
    abort.abort();
    abortLocalJob(aborts, pids, key);
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
    await releaseLeaseOnShutdown(store, row.id, row.jobKey, leasedBy, logger, "worker expire failed");
  });

  try {
    const job = issueJobFromRecord(row);
    const latch = await store.readIssueSkipLatch(job.owner, job.repo, job.issueNumber);
    await syncHomeSkipLatch(config.home, job.owner, job.repo, job.issueNumber, latch.generation);
    if (isSkipLatchReason(latch.skipReason)) {
      await store.markPublished(row.id, leasedBy, { state: "skipped", reason: latch.skipReason ?? undefined });
      recordJobCompleted(row.kind, "skipped");
      logger(`${issueJobKey(job)} skipped: ${latch.skipReason}`);
      await rememberSitBestEffort(store.sits, job.owner, job.repo, job.issueNumber, latch.skipReason, logger);
      return "processed";
    }
    const shared = {
      api,
      job,
      giteaUrl: config.giteaUrl,
      giteaToken: config.giteaToken,
      gitAuthResolver: gitAuthResolverFor(config, api, { owner: job.owner, repo: job.repo }),
      ...pickupPolicyForForge(config.forge, config.botUsername),
      followupIgnoreLogins: config.followupIgnoreLogins,
      model: config.model,
      variant: config.variant,
      fallbackModel: config.fallbackModel,
      fallbackVariant: config.fallbackVariant,
      chain: orderedRunners(config),
      remainingLeaseMs: async () => {
        const current = await store.get(row.id);
        if (current?.leasedUntil == null) return 0;
        return Math.max(0, current.leasedUntil - Date.now());
      },
      extendLease: () => store.heartbeat(row.id, leasedBy, config.leaseMs),
      home: config.home,
      skipLatches: store.skipLatches,
      workdir: config.workdir,
      maxOutputBytes: config.maxOutputBytes,
      sanitizeOpenCodeEnv: true,
      useClaim: false,
      abortSignal: abort.signal,
      onPid: (pid: number) => {
        pids?.set(key, pid);
      },
      logger: (message: string) => logger(message),
      jobId: String(row.id),
      previousError: row.error,
    };
    const runImplement = extras.implement ?? implementIssue;
    const runFollowUp = extras.followUp ?? implementFollowUp;
    const runConflict = extras.conflict ?? implementConflict;
    const result =
      job.mode === "conflict"
        ? await runConflict({
            ...shared,
            timeoutMs: config.conflictTimeoutMs,
            maxConflictRounds: config.maxConflictRounds,
          })
        : job.mode === "follow-up"
          ? await runFollowUp({
              ...shared,
              timeoutMs: config.followupTimeoutMs,
              conflictTimeoutMs: config.conflictTimeoutMs,
              maxFollowupRounds: config.maxFollowupRounds,
              maxConflictRounds: config.maxConflictRounds,
            })
          : await runImplement({
              ...shared,
              timeoutMs: config.opencodeTimeoutMs,
              followupTimeoutMs: config.followupTimeoutMs,
              conflictTimeoutMs: config.conflictTimeoutMs,
              maxFollowupRounds: config.maxFollowupRounds,
              maxConflictRounds: config.maxConflictRounds,
            });
    stopHeartbeat();
    const current = await store.get(row.id);
    if (current?.state !== "leased" || current.leasedBy !== leasedBy) {
      logger(`${issueJobKey(job)} cancelled`);
      return "processed";
    }
    if (result.status === "cancelled" && extras.abortSignal?.aborted) {
      await releaseLeaseOnShutdown(store, row.id, row.jobKey, leasedBy, logger, "worker expire failed");
      return "processed";
    }
    const reason =
      result.status === "no-changes" ? "no-changes" : result.status === "skipped" ? result.reason : undefined;
    const latchReason = skipLatchReasonFromResult(result);
    if (latchReason) {
      await store.setIssueSkipReason(job.owner, job.repo, job.issueNumber, latchReason);
    }
    if (result.status === "skipped" && job.mode === "follow-up" && reason) {
      const moved = parsePrHeadChangedReason(reason);
      if (moved?.to && moved.to !== job.headSha) {
        const enqueued = await store.enqueueIssue({
          ...job,
          headSha: moved.to,
          delivery: `head-changed-${row.id}-${moved.to}`,
          receivedAt: new Date().toISOString(),
        });
        logger(`${enqueued.queued ? "queued" : "deduped"} ${enqueued.key} after PR head changed`);
      }
    }
    const state = workerPublishedState(result.status);
    await store.markPublished(row.id, leasedBy, { state, reason });
    recordJobCompleted(row.kind, state);
    logger(`${issueJobKey(job)} ${result.status}${reason ? `: ${reason}` : ""}`);
    if (result.status === "no-changes" || (result.status === "skipped" && reason)) {
      await rememberSitBestEffort(store.sits, job.owner, job.repo, job.issueNumber, reason, logger);
    } else if (result.status === "pr" || result.status === "pushed" || state === "succeeded") {
      await clearSitBestEffort(store.sits, job.owner, job.repo, job.issueNumber, logger);
    }
    // A freshly latched object gets its board row now, not on some later run:
    // latchReason is already computed above, and still flows through normalizeSitReason.
    // Placed after the clear branch because stuck publishes as succeeded.
    if (latchReason) {
      await rememberSitBestEffort(store.sits, job.owner, job.repo, job.issueNumber, latchReason, logger);
    }
    breaker.recordModelReached();
    const prNumber = pushedPrNumber(result);
    if (prNumber !== undefined) {
      try {
        const conflictJob = await conflictJobIfUnmergeable(api, job, prNumber, logger);
        if (conflictJob) {
          const enqueued = await store.enqueueIssue(conflictJob);
          logger(`${enqueued.queued ? "queued" : "deduped"} ${enqueued.key} after-push mergeable=false`);
        }
      } catch (enqueueErr) {
        logger(
          `after-push conflict enqueue failed: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`
        );
      }
    }
    return "processed";
  } catch (err) {
    stopHeartbeat();
    if (extras.abortSignal?.aborted) {
      logger(`worker job ${row.jobKey} interrupted`);
      await releaseLeaseOnShutdown(store, row.id, row.jobKey, leasedBy, logger, "worker expire failed");
      return "processed";
    }
    if (abort.signal.aborted) {
      logger(`${row.jobKey} cancelled`);
      return "processed";
    }
    logger(`worker job ${row.jobKey} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (isQuotaWaitError(err)) {
      try {
        const now = Date.now();
        await store.requeueInfra(row.id, leasedBy, err.backoffMs, err.marker);
        quotaCooldown.recordWaitUntil(now + err.backoffMs);
        logDiagnostic(logger, "opencode_quota_wait", {
          count: err.count,
          next_at: new Date(now + err.backoffMs).toISOString(),
          budget_remaining_ms: err.budgetRemainingMs,
        });
        logger(`quota-wait ${row.jobKey} backoff=${err.backoffMs} n=${err.count}`);
      } catch (quotaErr) {
        logger(
          `worker quota requeue failed ${row.jobKey}: ${quotaErr instanceof Error ? quotaErr.message : String(quotaErr)}`
        );
        try {
          await store.expireLease(row.id, leasedBy);
        } catch (expireErr) {
          logger(
            `worker expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
          );
        }
      }
      return "processed";
    }
    if (isInfraFailure(err)) {
      breaker.recordInfra();
      try {
        const decision = decideInfraRetry(row.error, Date.now());
        if (decision.action === "exhaust") {
          await store.saveResult(row.id, leasedBy, { kind: "error", error: decision.reason });
          await store.markPublished(row.id, leasedBy, { state: "failed", reason: decision.reason });
          recordJobCompleted(row.kind, "failed");
          logger(`infra-published ${row.jobKey} failed: ${decision.reason}`);
        } else {
          await store.requeueInfra(row.id, leasedBy, decision.backoffMs, decision.marker);
          logger(`infra-retry ${row.jobKey} backoff=${decision.backoffMs} n=${decision.count}`);
        }
      } catch (infraErr) {
        logger(
          `worker infra requeue failed ${row.jobKey}: ${infraErr instanceof Error ? infraErr.message : String(infraErr)}`
        );
        try {
          await store.expireLease(row.id, leasedBy);
        } catch (expireErr) {
          logger(
            `worker expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
          );
        }
      }
      return "processed";
    }
    breaker.recordModelReached();
    try {
      await store.expireLease(row.id, leasedBy);
    } catch (expireErr) {
      logger(
        `worker expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
      );
    }
    return "processed";
  } finally {
    untrack();
    aborts?.delete(key);
    pids?.delete(key);
    stopHeartbeat();
  }
}
