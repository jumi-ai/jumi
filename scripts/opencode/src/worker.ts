import { deleteCheckpointForIssueViaForge } from "./checkpoint.ts";
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
import { thrownRunner } from "./engine.ts";
import { implementFollowUp, parsePrHeadChangedReason } from "./followup.ts";
import { createForge } from "./forge.ts";
import { type IssueApi, upsertWorkerComment } from "./gitea_issues.ts";
import { pickupPolicyForForge } from "./github_webhook.ts";
import { type HandoffStore, handoffsFor } from "./handoff.ts";
import { cancelIssueWork, implementIssue, issueJobKey } from "./implement.ts";
import { decideInfraRetry, type InfraCircuitBreaker, isInfraFailure } from "./infra.ts";
import { conflictJobIfUnmergeable, pushedPrNumber } from "./pickup.ts";
import { ReviewQueue } from "./queue.ts";
import { isQuotaWaitError, type QuotaCooldown } from "./quota.ts";
import {
  effectiveFollowupIgnoreLogins,
  effectiveIgnoreConflictsLabel,
  effectiveLeaseMs,
  effectivePickupLabel,
  effectiveTimeoutMsForKind,
  effectiveTrustedSenderLogins,
  loadDefaultBranchSettings,
  REPO_MODE_DISABLED_NOTE,
  REPO_MODE_OFF_REASON,
  REPO_MODE_REVIEW_ONLY_REASON,
  type RepoMode,
  type RepoSettingsFileApi,
  type RepoSettingsLoad,
  resolveRepoMode,
} from "./repo_settings.ts";
import { HEARTBEAT_MS, issueJobFromRecord, type ReviewJobStore, WORKER_JOB_KINDS } from "./review_jobs.ts";
import { clearSitBestEffort, rememberSitBestEffort } from "./router_sits.ts";
import { setActiveRunUsageRecording } from "./run_usage.ts";
import { runnerAuthFingerprints } from "./runner_cooldown.ts";
import { orderedRunners, runnerNameForStamp } from "./runners.ts";
import { type StandingPodRuntime, standingPodRuntime } from "./runtime.ts";
import { releaseLeaseOnShutdown } from "./shutdown.ts";
import { type SkipLatchStore, skipLatchesFor } from "./skip_latches.ts";
import { describeTriedRunnersSuffix } from "./sticky_failure.ts";
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
  runnerCooldowns?: import("./runner_cooldown.ts").RunnerCooldownStore;
  runnerCooldownConfig?: import("./runner_cooldown.ts").RunnerCooldownConfig;
  cooldownNowMs?: () => number;
  /** Current credential fingerprints by runner name; clears auth cooldowns on rotation. */
  authFingerprints?: Record<string, string | undefined>;
  now?: () => number;
  /** One-shot jobs inject a full-clone runtime (no shared cache). Long-running keeps the standing pod. */
  runtime?: StandingPodRuntime;
}

function log(message: string) {
  console.log(`[worker] ${message}`);
}

/**
 * Repository timeouts for one worker job, read once from the default branch
 * at job start. A change does not affect an already running job. Fail-open to
 * deployment defaults when the file is missing, invalid, or unreadable.
 */
export async function resolveWorkerTimeouts(
  api: RepoSettingsFileApi,
  config: Pick<
    WorkerConfig,
    | "opencodeTimeoutMs"
    | "opencodeTimeoutMaxMs"
    | "followupTimeoutMs"
    | "followupTimeoutMaxMs"
    | "conflictTimeoutMs"
    | "conflictTimeoutMaxMs"
  >,
  owner: string,
  repo: string,
  defaultBranch: string | undefined,
  logger: (message: string) => void = log
): Promise<{ load: RepoSettingsLoad; implementMs: number; followupMs: number; conflictMs: number }> {
  const { load } = await loadDefaultBranchSettings(api, owner, repo, defaultBranch, logger);
  return {
    load,
    implementMs: effectiveTimeoutMsForKind(load, "implement", config.opencodeTimeoutMs, config.opencodeTimeoutMaxMs),
    followupMs: effectiveTimeoutMsForKind(load, "follow-up", config.followupTimeoutMs, config.followupTimeoutMaxMs),
    conflictMs: effectiveTimeoutMsForKind(load, "conflict", config.conflictTimeoutMs, config.conflictTimeoutMaxMs),
  };
}

/**
 * Resolve the repository mode and post the one-time worker-disabled note for
 * `review-only`. Returns the mode; callers keep only their settle shape
 * (queue early-return vs. ledger-tick settle-and-publish). The `try` covers
 * the lookup alone so settle failures propagate instead of silently running
 * the gated job. Fail-open to `full` on lookup failure.
 */
async function checkWorkerMode(
  api: IssueApi,
  owner: string,
  repo: string,
  issueNumber: number | undefined | null,
  botUsername: string,
  noteKey: string,
  logger: (message: string) => void
): Promise<RepoMode> {
  let mode: RepoMode = "full";
  try {
    mode = await resolveRepoMode(api, owner, repo, logger);
  } catch {
    mode = "full";
  }
  if (mode === "review-only" && issueNumber != null) {
    try {
      await upsertWorkerComment(api, owner, repo, issueNumber, botUsername, REPO_MODE_DISABLED_NOTE);
    } catch (err) {
      logger(`mode note failed ${noteKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return mode;
}

export function createIssueQueue(
  config: WorkerConfig,
  api: IssueApi = createForge(config),
  logger: (message: string) => void = log,
  skipLatches?: SkipLatchStore,
  handoffs?: HandoffStore
): ReviewQueue<IssueJob> {
  const aborts = new Map<string, AbortController>();

  const queue = new ReviewQueue<IssueJob>(
    async (job: IssueJob) => {
      const key = issueJobKey(job);
      const abort = new AbortController();
      aborts.set(key, abort);
      try {
        // Repository mode is read when the job starts. Restricted repos cost
        // no model time. Fail-open to full on lookup failure.
        const mode = await checkWorkerMode(api, job.owner, job.repo, job.issueNumber, config.botUsername, key, logger);
        if (mode === "off") {
          logger(`${key} skipped: ${REPO_MODE_OFF_REASON}`);
          return;
        }
        if (mode === "review-only") {
          logger(`${key} skipped: ${REPO_MODE_REVIEW_ONLY_REASON}`);
          return;
        }
        // Local/dev path also reads the default-branch timeouts once at job
        // start so it behaves like the ledger tick. Fail-open to deployment
        // defaults when the file is missing, invalid, or unreadable.
        const {
          load: localSettingsLoad,
          implementMs: localImplementMs,
          followupMs: localFollowupMs,
          conflictMs: localConflictMs,
        } = await resolveWorkerTimeouts(api, config, job.owner, job.repo, job.defaultBranch, logger);
        const shared = {
          api,
          tracker: api,
          forge: api,
          job,
          // Core asks the runtime for the computer. Both live factories keep
          // using the standing pod: same pickup, same pods, same cgroup. No
          // Kubernetes API, no Jobs, no Actions. Docker is test-only and never
          // selected here.
          runtime: standingPodRuntime,
          giteaUrl: config.giteaUrl,
          giteaToken: config.giteaToken,
          gitAuthResolver: gitAuthResolverFor(config, api, { owner: job.owner, repo: job.repo }),
          ...pickupPolicyForForge(
            config.forge,
            config.botUsername,
            config.forge === "github" ? effectivePickupLabel(localSettingsLoad) : undefined
          ),
          followupIgnoreLogins: effectiveFollowupIgnoreLogins(config.followupIgnoreLogins, localSettingsLoad),
          trustedSenderLogins: effectiveTrustedSenderLogins(config.trustedSenderLogins, localSettingsLoad),
          blockingQuestionAuthors: config.blockingQuestionAuthors,
          ignoreConflictsLabel: effectiveIgnoreConflictsLabel(config.ignoreConflictsLabel, localSettingsLoad),
          automergeRepos: config.automergeRepos,
          automergeEnabled: config.automergeEnabled,
          forgeKind: config.forge,
          model: config.model,
          variant: config.variant,
          fallbackModel: config.fallbackModel,
          fallbackVariant: config.fallbackVariant,
          chain: orderedRunners(config),
          runnerSelection: config.runnerSelection,
          independentReview: config.independentReview,
          home: config.home,
          skipLatches,
          handoffs: handoffs ?? handoffsFor({ home: config.home }),
          workdir: config.workdir,
          maxOutputBytes: config.maxOutputBytes,
          checkpointEnabled: config.checkpointEnabled,
          checkpointIntervalMs: config.checkpointIntervalMs,
          checkpointMaxAgeMs: config.checkpointMaxAgeMs,
          sanitizeOpenCodeEnv: true,
          abortSignal: abort.signal,
          logger: (message: string) => logger(message),
          jobId: job.delivery,
        };
        const result =
          job.mode === "conflict"
            ? await implementConflict({
                ...shared,
                timeoutMs: localConflictMs,
                maxConflictRounds: config.maxConflictRounds,
              })
            : job.mode === "follow-up"
              ? await implementFollowUp({
                  ...shared,
                  timeoutMs: localFollowupMs,
                  conflictTimeoutMs: localConflictMs,
                  maxFollowupRounds: config.maxFollowupRounds,
                  maxConflictRounds: config.maxConflictRounds,
                })
              : await implementIssue({
                  ...shared,
                  timeoutMs: localImplementMs,
                  followupTimeoutMs: localFollowupMs,
                  conflictTimeoutMs: localConflictMs,
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
  skipLatches?: SkipLatchStore,
  handoffs?: HandoffStore
): Promise<{ key: string; cancelled: true }> {
  const key = issueJobKey({ owner, repo, issueNumber });
  if (queue) {
    queue.drop(key);
    abortIssueJob(queue, key);
  }
  const latches = skipLatches ?? store?.skipLatches ?? skipLatchesFor(config);
  const handoffStore = handoffs ?? store?.handoffs ?? handoffsFor({ home: config.home });
  const latch = store ? await store.clearIssueSkipLatch(owner, repo, issueNumber) : undefined;
  if (!store || latches !== store.skipLatches) {
    // Worker cancel clears only worker cells; review stuck lives in
    // review_stuck on the same row and must survive.
    await latches.put({ owner, repo, issueNumber }, { followup: {}, conflict: {}, ci: {}, stuck: {} });
  }
  if (!store || handoffStore !== store.handoffs) {
    await handoffStore.deleteForIssue(owner, repo, issueNumber);
  }
  await deleteCheckpointForIssueViaForge(api, owner, repo, issueNumber, {
    log: (message) => log(message),
  });
  const cancelledQueued = store ? await store.cancelQueuedForIssue(owner, repo, issueNumber) : 0;
  // The ledger mark lands before the in-process abort below: a tick woken by
  // the abort always observes the mark in its settle check instead of racing
  // it and publishing a normal result.
  abortLocalJob(aborts, pids, key);
  if (store) {
    // Ledger/job mode: no HOME claim files exist (ledger ticks run with
    // useClaim:false), so there is no claim pid to kill and no terminal
    // claim to honor. The in-process abort above stops a long-running child
    // in this pod; a one-shot child in another pod observes the
    // cancel_requested mark on its next heartbeat and runs the same
    // cancelIssueWork cleanup itself. Post `stopped` here only for rows
    // that were still queued (the job posts it for leased rows when it
    // settles, so posting here would double-post).
    if (latch) {
      await syncHomeSkipLatch(config.home, owner, repo, issueNumber, latch.generation);
    }
    if (cancelledQueued > 0) {
      await cancelIssueWork({
        api,
        owner,
        repo,
        issueNumber,
        botUsername: config.botUsername,
        home: config.home,
        killPid: () => undefined,
      });
    }
    return { key, cancelled: true };
  }
  const claimPath = claimFilePath(config.home, owner, repo, issueNumber);
  const claim = await readClaim(claimPath);
  await deleteClaim(followUpStatePath(config.home, owner, repo, issueNumber));
  await deleteClaim(conflictStatePath(config.home, owner, repo, issueNumber));
  await deleteClaim(ciStatePath(config.home, owner, repo, issueNumber));
  await deleteClaim(stuckStatePath(config.home, owner, repo, issueNumber));
  if (claim?.terminal) {
    await deleteClaim(claimPath);
    return { key, cancelled: true };
  }
  if (!claim) {
    if (cancelledQueued > 0) {
      await cancelIssueWork({
        api,
        owner,
        repo,
        issueNumber,
        botUsername: config.botUsername,
        home: config.home,
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
  });
  return { key, cancelled: true };
}

function workerPublishedState(status: string): "succeeded" | "skipped" | "failed" {
  if (status === "skipped" || status === "cancelled" || status === "no-changes") return "skipped";
  if (status === "failed") return "failed";
  return "succeeded";
}

function failedRunnerNameForWorkerRetry(config: WorkerConfig, err: unknown): string | null {
  try {
    const stamp = thrownRunner(err);
    if (!stamp) return null;
    return runnerNameForStamp(orderedRunners(config), stamp) ?? null;
  } catch {
    return null;
  }
}

function skipLatchReasonFromResult(result: { status: string; reason?: string }): string | undefined {
  if (result.status === "skipped" && isSkipLatchReason(result.reason)) return result.reason;
  if (result.status === "stuck") return result.reason ?? "stuck: cannot resolve conflicts";
  return undefined;
}

export async function reclaimExpiredWorkerJobs(
  store: ReviewJobStore,
  maxAttempts: number,
  logger: (message: string) => void = log,
  opts?: {
    api?: Pick<IssueApi, "findStickyIssueComment" | "createIssueComment" | "updateIssueComment">;
    botUsername?: string;
  }
): Promise<{ requeued: number; published: number }> {
  const { requeued, publish } = await store.reclaimExpired(maxAttempts, undefined, HEARTBEAT_MS, WORKER_JOB_KINDS);
  for (const row of requeued) {
    logger(`requeued ${row.jobKey} attempt=${row.attempt}`);
  }
  for (const row of publish) {
    try {
      if (row.leasedBy == null) throw new Error(`cannot mark published for job ${row.id}`);
      // Max-attempts rows previously got `markPublished` with no forge comment,
      // leaving the sticky at "Jumi is implementing this issue". Publish the
      // failure when the forge is available so the router-only path and the
      // long-running worker path behave the same.
      if (opts?.api && row.issueNumber != null) {
        const reason = row.error ?? row.resultReason ?? "Jumi failed: max attempts exceeded";
        await upsertWorkerComment(opts.api, row.owner, row.repo, row.issueNumber, opts.botUsername ?? "jumi", reason);
        const published = await store.markPublished(row.id, row.leasedBy, { state: "failed", reason });
        if (published.cancelled) {
          await upsertWorkerComment(
            opts.api,
            row.owner,
            row.repo,
            row.issueNumber,
            opts.botUsername ?? "jumi",
            "stopped"
          );
          logger(`reclaim-cancelled ${row.jobKey}`);
        } else {
          logger(`reclaim-published ${row.jobKey} failed${row.error ? `: ${row.error}` : ""}`);
        }
      } else {
        const published = await store.markPublished(row.id, row.leasedBy, {
          state: "failed",
          reason: row.error ?? row.resultReason ?? undefined,
        });
        if (published.cancelled) logger(`reclaim-cancelled ${row.jobKey}`);
        else logger(`reclaim-published ${row.jobKey} failed${row.error ? `: ${row.error}` : ""}`);
      }
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
  const nowMs = extras.now?.() ?? Date.now();
  if (extras.runnerCooldowns && typeof store.listRunnerCooldowns === "function") {
    try {
      const persisted = await store.listRunnerCooldowns("worker");
      for (const entry of persisted) {
        if (entry.untilMs <= nowMs) {
          await store.clearRunnerCooldown?.("worker", entry.runner).catch(() => undefined);
          continue;
        }
        if (extras.runnerCooldowns.cooldownUntil(entry.runner) < entry.untilMs) {
          extras.runnerCooldowns.restore(entry.runner, {
            untilMs: entry.untilMs,
            reason: (entry.reason as "quota" | "credit" | "auth") ?? "quota",
            source: (entry.source as "parsed" | "default" | "credential") ?? "default",
            ...(entry.fingerprint != null ? { fingerprint: entry.fingerprint } : {}),
          });
        }
      }
    } catch {
      // Fail-open.
    }
  }
  const needsLedger = !extras.breaker || !extras.quotaCooldown;
  const gate = needsLedger ? await store.checkRoleGate("worker", new Date(nowMs)) : undefined;
  if (extras.breaker) {
    if (!extras.breaker.canLease()) {
      logger("breaker open");
      return "idle";
    }
  } else if (gate?.infraBlocked) {
    logger("breaker open");
    return "idle";
  }
  if (extras.quotaCooldown) {
    if (!extras.quotaCooldown.canLease()) {
      if (extras.quotaCooldown.takeLog()) logger("quota cooldown");
      return "idle";
    }
  } else if (gate?.quotaBlocked) {
    logger("quota cooldown");
    return "idle";
  }
  const row = await store.lease(leasedBy, config.leaseMs, new Date(nowMs), WORKER_JOB_KINDS);
  if (!row) return "idle";
  if (extras.abortSignal?.aborted) {
    await store.releaseLease(row.id, leasedBy);
    return "idle";
  }
  // Repository mode is read when the job starts so a change on the default
  // branch applies to the next job without a restart; a running job finishes.
  // Restricted repos cost no model time. Off settles silently, review-only
  // leaves one worker-disabled note via the sticky (upsert says it once).
  // The lookup fail-opens to full; settle failures below propagate to the
  // tick error handling instead of silently running the gated job.
  const mode = await checkWorkerMode(api, row.owner, row.repo, row.issueNumber, config.botUsername, row.jobKey, logger);
  if (mode === "off" || mode === "review-only") {
    const reason = mode === "off" ? REPO_MODE_OFF_REASON : REPO_MODE_REVIEW_ONLY_REASON;
    await store.markPublished(row.id, leasedBy, { state: "skipped", reason });
    recordJobCompleted(row.kind, "skipped");
    logger(`${row.jobKey} skipped: ${reason}`);
    await clearSitBestEffort(store.sits, row.owner, row.repo, row.issueNumber ?? 0, logger);
    if (extras.breaker) extras.breaker.recordModelReached();
    else await store.recordRoleSuccess("worker");
    return "processed";
  }
  // Repository timeouts for this job, read once from the default branch at
  // job start. A change does not affect an already running job. The lease
  // follows the effective value for this kind so a longer run is not
  // reclaimed halfway, and the credential-refresh budget at job start uses
  // the same effective value.
  const defaultBranchHint =
    row.payload && typeof row.payload === "object" && "defaultBranch" in row.payload
      ? (row.payload as { defaultBranch?: unknown }).defaultBranch
      : undefined;
  const {
    load: tickSettingsLoad,
    implementMs: effectiveImplementMs,
    followupMs: effectiveFollowupMs,
    conflictMs: effectiveConflictMs,
  } = await resolveWorkerTimeouts(
    api,
    config,
    row.owner,
    row.repo,
    typeof defaultBranchHint === "string" && defaultBranchHint ? defaultBranchHint : undefined,
    logger
  );
  const effectiveTimeoutForLease =
    row.kind === "conflict"
      ? effectiveConflictMs
      : row.kind === "follow-up"
        ? effectiveFollowupMs
        : effectiveImplementMs;
  const effectiveLease = effectiveLeaseMs(config.leaseMs, effectiveTimeoutForLease);
  // Repository `trusted_senders` (intersection, never widening),
  // `followup_ignore_logins` (union), `ignore_conflicts_label` (override), and
  // `pickup_label` (GitHub only) all come from the same default-branch read
  // that supplied the timeouts. Missing, invalid, or unreadable falls back to
  // the deployment values.
  const repoTrusted = effectiveTrustedSenderLogins(config.trustedSenderLogins, tickSettingsLoad);
  const repoFollowupIgnore = effectiveFollowupIgnoreLogins(config.followupIgnoreLogins, tickSettingsLoad);
  const repoIgnoreLabel = effectiveIgnoreConflictsLabel(config.ignoreConflictsLabel, tickSettingsLoad);
  const repoPickup = config.forge === "github" ? effectivePickupLabel(tickSettingsLoad) : undefined;
  const effectiveConfig =
    effectiveImplementMs === config.opencodeTimeoutMs &&
    effectiveFollowupMs === config.followupTimeoutMs &&
    effectiveConflictMs === config.conflictTimeoutMs &&
    effectiveLease === config.leaseMs &&
    repoTrusted === config.trustedSenderLogins &&
    repoFollowupIgnore === config.followupIgnoreLogins &&
    repoIgnoreLabel === config.ignoreConflictsLabel &&
    (config.forge !== "github" || repoPickup === undefined || repoPickup === "jumi")
      ? config
      : {
          ...config,
          opencodeTimeoutMs: effectiveImplementMs,
          followupTimeoutMs: effectiveFollowupMs,
          conflictTimeoutMs: effectiveConflictMs,
          leaseMs: effectiveLease,
          trustedSenderLogins: repoTrusted ?? [],
          followupIgnoreLogins: repoFollowupIgnore,
          ignoreConflictsLabel: repoIgnoreLabel,
        };
  if (effectiveLease !== config.leaseMs) {
    await store.heartbeat(row.id, leasedBy, effectiveLease).catch(() => undefined);
  }
  // Same ambient ledger recorder as the engine tick: runner spawns record
  // per-run usage against this row before the tick ends. A failed metric
  // write never fails the job (the wrapper swallows it).
  setActiveRunUsageRecording({
    context: { jobId: row.id, jobKey: row.jobKey, kind: row.kind },
    recordRunUsageRows: (rows) => store.recordRunUsageRows(rows),
  });
  const rowId = row.id;

  const key = issueJobKey({
    owner: row.owner,
    repo: row.repo,
    issueNumber: row.issueNumber ?? 0,
    tracker: row.payload?.tracker,
    trackerId: row.payload?.trackerId,
    mode: row.kind,
  });
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
  // Unassign while a one-shot job runs: the router marks the leased row
  // cancel_requested (it cannot reach the pod's AbortController). Observe
  // the mark on every heartbeat, abort the child, and let the await below
  // wait for the child to stop before the tick settles the row as
  // cancelled. Long-running mode keeps its in-process abort above; this
  // poll is the backstop that also settles the ledger either way.
  let cancelObserved = false;
  const observeCancel = () => {
    if (cancelObserved || heartbeatStopped) return;
    cancelObserved = true;
    abort.abort();
    abortLocalJob(aborts, pids, key);
  };
  const checkCancelMark = async () => {
    if (cancelObserved || heartbeatStopped) return;
    try {
      if (await store.isCancelRequested(rowId)) observeCancel();
    } catch {
      // Ledger blip: the next heartbeat retries; never fail the job on a read.
    }
  };
  const heartbeat = setInterval(() => {
    if (heartbeatStopped) return;
    void store.heartbeat(rowId, leasedBy, effectiveLease).then(
      (ok) => {
        if (!ok) loseLease();
        else void checkCancelMark();
      },
      () => undefined
    );
  }, extras.heartbeatMs ?? HEARTBEAT_MS);
  const stopHeartbeat = () => {
    heartbeatStopped = true;
    clearInterval(heartbeat);
  };

  async function settleObservedCancel(
    owner: string,
    repo: string,
    issueNumber: number,
    jobKey: string
  ): Promise<boolean> {
    if (!cancelObserved) {
      try {
        if (!(await store.isCancelRequested(rowId))) return false;
        cancelObserved = true;
      } catch {
        return false;
      }
    }
    // The child already stopped: the heartbeat aborted it and the run await
    // waited for it (or it never started). Abort again defensively, then run
    // the same cleanup as handleIssueCancel's cancelIssueWork and settle.
    abort.abort();
    abortLocalJob(aborts, pids, key);
    try {
      await cancelIssueWork({
        api,
        owner,
        repo,
        issueNumber,
        botUsername: config.botUsername,
        home: config.home,
        killPid: () => undefined,
      });
    } catch (err) {
      logger(`cancel cleanup failed ${jobKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await store.markCancelled(rowId, leasedBy);
    } catch (err) {
      logger(`cancel settle failed ${jobKey}: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
    logger(`${jobKey} cancelled`);
    return true;
  }

  try {
    const job = issueJobFromRecord(row);
    const latch = await store.readIssueSkipLatch(job.owner, job.repo, job.issueNumber);
    await syncHomeSkipLatch(config.home, job.owner, job.repo, job.issueNumber, latch.generation);
    if (isSkipLatchReason(latch.skipReason)) {
      const published = await store.markPublished(row.id, leasedBy, {
        state: "skipped",
        reason: latch.skipReason ?? undefined,
      });
      if (published.cancelled) {
        try {
          await cancelIssueWork({
            api,
            owner: job.owner,
            repo: job.repo,
            issueNumber: job.issueNumber,
            botUsername: config.botUsername,
            home: config.home,
            killPid: () => undefined,
          });
        } catch (err) {
          logger(`cancel cleanup failed ${issueJobKey(job)}: ${err instanceof Error ? err.message : String(err)}`);
        }
        logger(`${issueJobKey(job)} cancelled`);
        return "processed";
      }
      recordJobCompleted(row.kind, "skipped");
      logger(`${issueJobKey(job)} skipped: ${latch.skipReason}`);
      await rememberSitBestEffort(store.sits, job.owner, job.repo, job.issueNumber, latch.skipReason, logger);
      return "processed";
    }
    // Cancel that landed between the lease and the first heartbeat: settle
    // without starting a child at all.
    try {
      if (await store.isCancelRequested(row.id)) cancelObserved = true;
    } catch {
      // Fall through and run; the heartbeat poll retries the read.
    }
    if (cancelObserved) {
      stopHeartbeat();
      await settleObservedCancel(job.owner, job.repo, job.issueNumber, issueJobKey(job));
      return "processed";
    }
    const shared = {
      api,
      tracker: api,
      forge: api,
      job,
      runtime: extras.runtime ?? standingPodRuntime,
      giteaUrl: effectiveConfig.giteaUrl,
      giteaToken: effectiveConfig.giteaToken,
      gitAuthResolver: gitAuthResolverFor(effectiveConfig, api, { owner: job.owner, repo: job.repo }),
      ...pickupPolicyForForge(effectiveConfig.forge, effectiveConfig.botUsername, repoPickup),
      followupIgnoreLogins: effectiveConfig.followupIgnoreLogins,
      trustedSenderLogins: effectiveConfig.trustedSenderLogins,
      blockingQuestionAuthors: effectiveConfig.blockingQuestionAuthors,
      ignoreConflictsLabel: effectiveConfig.ignoreConflictsLabel,
      automergeRepos: effectiveConfig.automergeRepos,
      automergeEnabled: effectiveConfig.automergeEnabled,
      forgeKind: effectiveConfig.forge,
      model: effectiveConfig.model,
      variant: effectiveConfig.variant,
      fallbackModel: effectiveConfig.fallbackModel,
      fallbackVariant: effectiveConfig.fallbackVariant,
      chain: orderedRunners(effectiveConfig),
      runnerSelection: effectiveConfig.runnerSelection,
      independentReview: effectiveConfig.independentReview,
      ...(extras.runnerCooldowns ? { runnerCooldowns: extras.runnerCooldowns } : {}),
      runnerCooldownConfig:
        extras.runnerCooldownConfig ??
        (effectiveConfig as { runnerCooldown?: RunWorkerJobExtras["runnerCooldownConfig"] }).runnerCooldown,
      ...((extras.cooldownNowMs ?? extras.now) ? { cooldownNowMs: extras.cooldownNowMs ?? extras.now } : {}),
      authFingerprints:
        extras.authFingerprints ??
        runnerAuthFingerprints(orderedRunners(effectiveConfig), { home: effectiveConfig.home }),
      remainingLeaseMs: async () => {
        const current = await store.get(row.id);
        if (current?.leasedUntil == null) return 0;
        return Math.max(0, current.leasedUntil - Date.now());
      },
      extendLease: () => store.heartbeat(row.id, leasedBy, effectiveLease),
      home: effectiveConfig.home,
      skipLatches: store.skipLatches,
      handoffs: store.handoffs,
      workdir: effectiveConfig.workdir,
      maxOutputBytes: effectiveConfig.maxOutputBytes,
      checkpointEnabled: effectiveConfig.checkpointEnabled,
      checkpointIntervalMs: effectiveConfig.checkpointIntervalMs,
      checkpointMaxAgeMs: effectiveConfig.checkpointMaxAgeMs,
      sanitizeOpenCodeEnv: true,
      useClaim: false,
      abortSignal: abort.signal,
      onPid: (pid: number) => {
        pids?.set(key, pid);
      },
      logger: (message: string) => logger(message),
      jobId: String(row.id),
      previousError: row.error,
      failedRunner: row.resultRunner,
      provenance: store.provenance,
      provenanceJob: {
        jobId: row.id,
        jobKey: row.jobKey,
        delivery: row.delivery,
        kind: row.kind,
        forge: effectiveConfig.forge,
        issueNumber: job.issueNumber,
      },
    };
    const runImplement = extras.implement ?? implementIssue;
    const runFollowUp = extras.followUp ?? implementFollowUp;
    const runConflict = extras.conflict ?? implementConflict;
    const result =
      job.mode === "conflict"
        ? await runConflict({
            ...shared,
            timeoutMs: effectiveConfig.conflictTimeoutMs,
            maxConflictRounds: effectiveConfig.maxConflictRounds,
          })
        : job.mode === "follow-up"
          ? await runFollowUp({
              ...shared,
              timeoutMs: effectiveConfig.followupTimeoutMs,
              conflictTimeoutMs: effectiveConfig.conflictTimeoutMs,
              maxFollowupRounds: effectiveConfig.maxFollowupRounds,
              maxConflictRounds: effectiveConfig.maxConflictRounds,
            })
          : await runImplement({
              ...shared,
              timeoutMs: effectiveConfig.opencodeTimeoutMs,
              followupTimeoutMs: effectiveConfig.followupTimeoutMs,
              conflictTimeoutMs: effectiveConfig.conflictTimeoutMs,
              maxFollowupRounds: effectiveConfig.maxFollowupRounds,
              maxConflictRounds: effectiveConfig.maxConflictRounds,
            });
    stopHeartbeat();
    if (await settleObservedCancel(job.owner, job.repo, job.issueNumber, issueJobKey(job))) return "processed";
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
    const published = await store.markPublished(row.id, leasedBy, { state, reason });
    if (published.cancelled) {
      try {
        await cancelIssueWork({
          api,
          owner: job.owner,
          repo: job.repo,
          issueNumber: job.issueNumber,
          botUsername: config.botUsername,
          home: config.home,
          killPid: () => undefined,
        });
      } catch (err) {
        logger(`cancel cleanup failed ${issueJobKey(job)}: ${err instanceof Error ? err.message : String(err)}`);
      }
      logger(`${issueJobKey(job)} cancelled`);
      return "processed";
    }
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
    if (extras.breaker) extras.breaker.recordModelReached();
    else await store.recordRoleSuccess("worker");
    const prNumber = pushedPrNumber(result);
    if (prNumber !== undefined) {
      try {
        const conflictJob = await conflictJobIfUnmergeable(api, job, prNumber, logger, {
          botUsername: config.botUsername,
          ignoreConflictsLabel: repoIgnoreLabel,
        });
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
    if (await settleObservedCancel(row.owner, row.repo, row.issueNumber ?? 0, row.jobKey).catch(() => false)) {
      return "processed";
    }
    if (extras.abortSignal?.aborted) {
      logger(`worker job ${row.jobKey} interrupted`);
      await releaseLeaseOnShutdown(store, row.id, row.jobKey, leasedBy, logger, "worker expire failed");
      return "processed";
    }
    if (abort.signal.aborted) {
      logger(`${row.jobKey} cancelled`);
      return "processed";
    }
    {
      const baseMessage = err instanceof Error ? err.message : String(err);
      const triedSuffix = describeTriedRunnersSuffix(err);
      logger(`worker job ${row.jobKey} failed: ${baseMessage}${triedSuffix ? ` ${triedSuffix}` : ""}`);
    }
    if (isQuotaWaitError(err)) {
      const failedRunner = failedRunnerNameForWorkerRetry(config, err);
      if (extras.runnerCooldowns && failedRunner && typeof store.recordRunnerCooldown === "function") {
        const until = extras.runnerCooldowns.cooldownUntil(failedRunner);
        const entry = extras.runnerCooldowns.entry(failedRunner);
        if (until > Date.now()) {
          await store
            .recordRunnerCooldown("worker", failedRunner, until, entry?.reason, entry?.source, entry?.fingerprint)
            .catch(() => undefined);
        }
      }
      // QuotaWaitError already encodes the job's effective-chain decision in
      // throwIfQuotaWait: it only throws when every entry is cooled, with the
      // earliest cooldown end as the backoff. Rechecking the full configured
      // chain here (which can include runners excluded from this job) would
      // defeat that decision with an immediate retry that loops every tick.
      try {
        const now = Date.now();
        await store.requeueInfra(row.id, leasedBy, err.backoffMs, err.marker, undefined, failedRunner);
        if (extras.quotaCooldown) extras.quotaCooldown.recordWaitUntil(now + err.backoffMs);
        else await store.recordRoleQuotaWait("worker", now + err.backoffMs);
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
          await store.expireLease(row.id, leasedBy, new Date(), failedRunner);
        } catch (expireErr) {
          logger(
            `worker expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
          );
        }
      }
      return "processed";
    }
    if (isInfraFailure(err)) {
      const failedRunner = failedRunnerNameForWorkerRetry(config, err);
      if (extras.breaker) extras.breaker.recordInfra();
      else await store.recordRoleInfra("worker");
      try {
        const decision = decideInfraRetry(row.error, Date.now());
        if (decision.action === "exhaust") {
          await store.saveResult(row.id, leasedBy, { kind: "error", error: decision.reason });
          const published = await store.markPublished(row.id, leasedBy, {
            state: "failed",
            reason: decision.reason,
          });
          if (published.cancelled) {
            if (row.issueNumber != null) {
              try {
                await cancelIssueWork({
                  api,
                  owner: row.owner,
                  repo: row.repo,
                  issueNumber: row.issueNumber,
                  botUsername: config.botUsername,
                  home: config.home,
                  killPid: () => undefined,
                });
              } catch (cancelErr) {
                logger(
                  `cancel cleanup failed ${row.jobKey}: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`
                );
              }
            }
            logger(`${row.jobKey} cancelled`);
          } else {
            recordJobCompleted(row.kind, "failed");
            logger(`infra-published ${row.jobKey} failed: ${decision.reason}`);
          }
        } else {
          await store.requeueInfra(row.id, leasedBy, decision.backoffMs, decision.marker, undefined, failedRunner);
          logger(`infra-retry ${row.jobKey} backoff=${decision.backoffMs} n=${decision.count}`);
        }
      } catch (infraErr) {
        logger(
          `worker infra requeue failed ${row.jobKey}: ${infraErr instanceof Error ? infraErr.message : String(infraErr)}`
        );
        try {
          await store.expireLease(row.id, leasedBy, new Date(), failedRunner);
        } catch (expireErr) {
          logger(
            `worker expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
          );
        }
      }
      return "processed";
    }
    if (extras.breaker) extras.breaker.recordModelReached();
    else await store.recordRoleSuccess("worker");
    try {
      await store.expireLease(row.id, leasedBy, new Date(), failedRunnerNameForWorkerRetry(config, err));
    } catch (expireErr) {
      logger(
        `worker expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
      );
    }
    return "processed";
  } finally {
    setActiveRunUsageRecording(undefined);
    aborts?.delete(key);
    pids?.delete(key);
    stopHeartbeat();
  }
}
