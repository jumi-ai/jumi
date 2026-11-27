/**
 * Pi production executors for reviews and the three worker intents (jumi#981).
 *
 * With `JUMI_HARNESS_MODE=pi`, reviews and implement / follow-up / conflict
 * jobs run through the existing Pi sessions (`runPiReviewAttempt`,
 * `runPiWorkerAttempt`) on the OpenCode Go route. Everything around the
 * session stays exactly as in legacy: the ticks own leases, role policy, the
 * `required` verdict contract and its validation, retries, quota holds, push
 * and publication. Only the coding loop is Pi, and a Pi failure never starts
 * a legacy process.
 *
 * - The route chain is the deployment allowlist order capped at
 *   `PI_HOP_MAX_ROUTES` and driven by `runPiHop`; a repository may narrow it,
 *   never add to it.
 * - Data scope comes from the forge's repository visibility read at job time:
 *   `private: true`, any visibility other than `public`, or a failed read
 *   means `private`. Private work is refused with a clear reason before any
 *   request is sent to the provider, and no legacy runner spawns.
 * - The Go key arrives fresh via `resolvePiGoApiKey`; the model never holds
 *   the forge token. Session env scrubbing, write scopes, and
 *   `allowedFetchHosts` stay in force.
 * - Every attempt, including refused and failed ones, persists the attempt
 *   stamp (`harness_mode` plus the `PiAttemptStamp`); unknown usage stays
 *   NULL. Quota and auth failures are classified with `classifyPiGoError`
 *   into the existing quota-hold / auth handling.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { EngineFailedError } from "./engine.ts";
import { buildPiAttemptStamp, type PiAttemptRole, type PiAttemptStamp } from "./pi_attempt.ts";
import { runPiHop } from "./pi_hop.ts";
import { classifyPiGoError } from "./pi_opencode_go.ts";
import { checkPiHandoff, type PiAdapterResult, type PiResolvedRoute } from "./pi_profiles.ts";
import type { PiDeployment } from "./pi_runtime.ts";
import { createPiGoSessionDeps, piChainForJob, piScopeForRepo } from "./pi_runtime.ts";
import {
  checkoutPullRequestWorkspace,
  createReviewWorkspace,
  gitAuthResolverFor,
  gitConfigArgs,
  gitEnv,
  gitRemoteUrl,
  removeReviewWorkspace,
  runGit,
  validateCloneUrl,
} from "./workspace.ts";

export { loadPiDeployment } from "./pi_runtime.ts";
export type { PiDeployment };

import {
  CI_ABSENT_NOTE,
  CI_ABSENT_REASON,
  CI_LOOKUP_FAILED_REASON,
  type CiCheckSummary,
  resolveCiGate,
  reviewSkipReasonForCi,
} from "./ci.ts";
import type { ConflictResult } from "./conflict.ts";
import type { FollowUpResult } from "./followup.ts";
import type { ImplementResult } from "./implement.ts";
import { wrapJumiPrBody } from "./implement.ts";
import { pullAuthorCanPush } from "./permissions.ts";
import { runPiReviewAttempt } from "./pi_review.ts";
import { type PiWorkerIntent, runPiWorkerAttempt } from "./pi_worker.ts";
import type { IssueApi, Pull, ReviewApi } from "./ports.ts";
import { decideQuotaRetry, type QuotaWaitDecision, QuotaWaitError } from "./quota.ts";
import type { CiGateWait } from "./repo_settings.ts";
import { isReviewDraftsEnabled, loadDefaultBranchSettings } from "./repo_settings.ts";
import {
  inspectOtherChecks,
  type PersistReviewResult,
  PR_AUTHOR_CANNOT_PUSH,
  publishReviewResult,
  type ReviewResult,
  skipReasonForDraft,
  skipReasonForHeadChange,
  skipReasonForPR,
} from "./review.ts";
import { checkReviewSandbox } from "./review_sandbox.ts";
import { ReviewVerdictStore } from "./review_verdict_store.ts";
import { errorMessage, isAbortError } from "./util/error.ts";
import { WorkerResultStore } from "./worker_mcp.ts";

/** Injectable seams. Production passes none; tests inject loopback doubles. */
export interface PiJobSeams {
  /** Session deps per route. Production builds the real Go session. */
  sessionDepsFor?: (
    route: PiResolvedRoute,
    sessionId: string
  ) => Promise<{ modelRuntime: unknown; model: unknown; allowedFetchHosts: readonly string[] }>;
  /** Override the shell-sandbox probe (production probes Landlock for real). */
  sandboxAvailable?: boolean;
  /** Override the review checkout (production prepares a real checkout). */
  workdirForReview?: string;
  /**
   * Use this workdir as-is for a worker session: no clone, no commit, no
   * push, no forge publication. The caller observes the diff itself. Tests
   * only; production always clones.
   */
  workdirForWorker?: string;
  /**
   * Override the worker checkout (clone plus branch checkout). Production
   * clones from the configured forge; tests point it at a file:// fixture.
   * Only used when `workdirForWorker` is unset.
   */
  prepareCheckout?: (workdir: string) => Promise<PiWorkerCheckout>;
  /** Skip the real git push (tests assert the commit without a remote). */
  skipPush?: boolean;
  /** Injectable clock. */
  nowMs?: () => number;
}

/** Checked-out worktree a Pi worker session edits and the parent releases. */
interface PiWorkerCheckout {
  branch: string;
  env: Record<string, string | undefined>;
  cleanup: () => Promise<void>;
}

type PiPersist = (result: PersistReviewResult) => Promise<void>;

type PiSave = (result: PersistReviewResult) => Promise<void>;

function nowMsOf(seams?: PiJobSeams): number {
  try {
    return seams?.nowMs?.() ?? Date.now();
  } catch {
    return Date.now();
  }
}

function sandboxProbeOf(seams?: PiJobSeams): { available: boolean; reason?: string } {
  if (seams?.sandboxAvailable !== undefined) return { available: seams.sandboxAvailable };
  const probe = checkReviewSandbox();
  return { available: probe.available, ...(probe.reason ? { reason: probe.reason } : {}) };
}

/**
 * Scope refusal reason. Names the repository and whether the visibility read
 * failed; never a secret, never provider content.
 */
export function piScopeRefusalReason(owner: string, repo: string, visibilityFailed: boolean): string {
  return visibilityFailed
    ? `pi refused: repository visibility for ${owner}/${repo} is unreadable, treating it as private; ` +
        `Contributor routes serve public scope only`
    : `pi refused: ${owner}/${repo} is private; Contributor routes serve public scope only`;
}

async function depsForRoute(
  route: PiResolvedRoute,
  sessionId: string,
  seams?: PiJobSeams
): Promise<{ modelRuntime: unknown; model: unknown; allowedFetchHosts: readonly string[] }> {
  if (seams?.sessionDepsFor) return seams.sessionDepsFor(route, sessionId);
  const deps = await createPiGoSessionDeps({ sessionId });
  const hosts = new Set<string>(deps.allowedFetchHosts);
  try {
    hosts.add(new URL(route.endpoint).hostname.toLowerCase());
  } catch {
    // Route endpoints are validated at resolve time; ignore a parse failure.
  }
  return { modelRuntime: deps.modelRuntime, model: deps.model, allowedFetchHosts: [...hosts] };
}

/**
 * Map one finished Pi session to the shared adapter result. Session-level
 * quota/auth text (loopback 429/401 on Go) classifies through
 * `classifyPiGoError` into the existing quota-hold / auth handling. A clean
 * session is `ok`. Provider HTTP statuses observed on the wire cover the
 * case where the SDK ends the turn without surfacing the status in the
 * session result (a loopback 429 still holds, a 401 still follows the auth
 * handling). Anything else that is not quota/auth/cancelled is a provider
 * failure (retryable when transient) and never a legacy fallback.
 */
export function piSessionToAdapterResult(
  status: "complete" | "incomplete",
  reason: string | undefined,
  message: string,
  fetchStatuses: readonly number[] = []
): PiAdapterResult {
  if (status === "complete") return { kind: "ok", message };
  const text = reason ?? message;
  const kind = classifyPiGoError(text);
  switch (kind) {
    case "quota":
      return { kind: "quota", message: text.slice(0, 500), quota: { resetting: false }, retryable: true };
    case "auth-expired":
      return { kind: "auth-expired", message: text.slice(0, 500), authExpired: true, retryable: false };
    case "cancelled":
      return { kind: "cancelled", message: text.slice(0, 500), retryable: false };
    case "denied":
      return { kind: "denied", message: text.slice(0, 500), retryable: false };
    default: {
      if (fetchStatuses.includes(429)) {
        return { kind: "quota", message: text.slice(0, 500), quota: { resetting: false }, retryable: true };
      }
      if (fetchStatuses.includes(401)) {
        return { kind: "auth-expired", message: text.slice(0, 500), authExpired: true, retryable: false };
      }
      return {
        kind: "provider-failure",
        message: text.slice(0, 500),
        retryable: /529|overloaded|fetch failed|Connection error|timeout|timed out|502|503|500/i.test(text),
      };
    }
  }
}

/**
 * Quota-wait error carrying the Pi attempt stamp. The tick's quota-hold
 * path requeues without a `saveResult`, so the stamp rides on the error and
 * the tick passes it to `requeueInfra`; every Pi attempt still writes its
 * stamp.
 */
export class PiQuotaWaitError extends QuotaWaitError {
  readonly piAttempt?: PiAttemptStamp;
  constructor(decision: Extract<QuotaWaitDecision, { action: "requeue" }>, piAttempt?: PiAttemptStamp) {
    super(decision);
    this.piAttempt = piAttempt;
  }
}

/**
 * Throw the existing quota-wait error for a Pi quota outcome so the tick's
 * quota-hold path (requeue plus role hold) runs unchanged. Exhaustion
 * returns the stuck reason instead of throwing. The stamp is never
 * persisted here: the tick carries it into `requeueInfra`, because a
 * `saveResult` would block the requeue.
 */
export function piQuotaDecision(
  prevError: string | null | undefined,
  nowMs: number,
  quotaResetAtMs?: number,
  piAttempt?: PiAttemptStamp
): { action: "throw"; error: PiQuotaWaitError } | { action: "exhaust"; reason: string } {
  const retryAfterMs =
    typeof quotaResetAtMs === "number" && Number.isFinite(quotaResetAtMs)
      ? Math.max(0, quotaResetAtMs - nowMs)
      : undefined;
  const decision = decideQuotaRetry(prevError, nowMs, retryAfterMs);
  if (decision.action === "exhaust") return { action: "exhaust", reason: decision.reason };
  return { action: "throw", error: new PiQuotaWaitError(decision, piAttempt) };
}

// --- Reviews ---

export interface PiReviewJobOptions {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  config: {
    workdir: string;
    home: string;
    giteaUrl: string;
    giteaToken: string;
    botUsername: string;
    blockingQuestionAuthors?: readonly string[];
    automergeRepos?: readonly string[];
    trustedSenderLogins?: readonly string[];
    opencodeTimeoutMs?: number;
  };
  api: ReviewApi;
  logger?: (message: string) => void;
  deployment: PiDeployment;
  repoAllowed?: readonly string[];
  baseInstructions?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  prevError?: string | null;
  persist?: PiPersist;
  seams?: PiJobSeams;
  ciRelistDelayMs?: number;
  /** Skip the CI gate and review with a no-CI note (the tick sets this after the absent retry budget). */
  assumeNoCi?: boolean;
}

function piReviewPrompt(pr: Pull, headSha: string, files: readonly { filename: string }[], noCiNote?: string): string {
  const names = files.map((file) => file.filename).slice(0, 200);
  return (
    `Review pull request #${pr.number} "${pr.title}" at head ${headSha}.\n` +
    `Base: ${pr.base.ref}, head branch: ${pr.head.ref}.\n` +
    `PR body:\n${(pr.body ?? "").slice(0, 4000)}\n` +
    `Changed files (${names.length}):\n${names.join("\n")}\n` +
    (noCiNote ? `${noCiNote}\n` : "") +
    `Record one finding per issue through jumi_add_finding (path must be a changed file, line in the diff hunks) ` +
    `and exactly one verdict through jumi_set_verdict. Do not write files to record the verdict.`
  );
}

/**
 * Run one review through the Pi session on the Go route and publish the
 * verdict through the parent store. Throws `QuotaWaitError` / auth /
 * provider errors for the tick's existing handling; returns a terminal
 * `ReviewResult` for skips, scope refusals, and denied routes.
 */
export async function runPiReviewJob(opts: PiReviewJobOptions): Promise<ReviewResult> {
  const log = opts.logger ?? (() => undefined);
  const persist = opts.persist ?? (async () => undefined);
  const persistPi = async (result: PersistReviewResult): Promise<void> => {
    await persist({ ...result, harnessMode: "pi" });
  };

  const pr = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
  const early = skipReasonForPR(pr) ?? skipReasonForHeadChange(pr, opts.headSha);
  if (early) {
    log(`${opts.owner}/${opts.repo}#${opts.prNumber} skipped: ${early}`);
    await persistPi({ kind: "skip", reason: early });
    return { status: "skipped", reason: early };
  }
  if (!(await pullAuthorCanPush(opts.api, opts.owner, opts.repo, pr))) {
    log(`${opts.owner}/${opts.repo}#${opts.prNumber} skipped: ${PR_AUTHOR_CANNOT_PUSH}`);
    await persistPi({ kind: "skip", reason: PR_AUTHOR_CANNOT_PUSH });
    return { status: "skipped", reason: PR_AUTHOR_CANNOT_PUSH };
  }
  // Route chain and data scope gate before any CI wait or session: private,
  // non-public, or unreadable visibility refuses with a clear reason and
  // zero requests sent to the provider, and no legacy runner spawns.
  const names = piChainForJob(opts.deployment, opts.repoAllowed);
  if (names.length === 0) {
    const reason = "pi refused: no Pi route is allowlisted for this job";
    await persistPi({ kind: "error", error: reason });
    return { status: "skipped", reason };
  }
  const { scope, visibilityFailed } = await piScopeForRepo(
    (owner, repo) => opts.api.getRepo(owner, repo),
    opts.owner,
    opts.repo
  );
  const firstRoute = checkPiHandoff(names[0]!, opts.deployment.catalog, opts.deployment.allowlist, {
    ...(opts.repoAllowed !== undefined ? { repoAllowed: opts.repoAllowed } : {}),
  });
  if (scope === "private") {
    const reason = piScopeRefusalReason(opts.owner, opts.repo, visibilityFailed);
    log(reason);
    await persistPi({
      kind: "error",
      error: reason,
      piAttempt: buildPiAttemptStamp({ route: firstRoute, role: "review", outcome: "denied" }),
    });
    return { status: "skipped", reason };
  }
  // Draft / WIP gate mirrors the legacy review dispatch: a draft reviews
  // only when the default branch opts in via `review_drafts`. Fail-open to
  // today's skip so an unreadable file never reviews a draft by accident.
  try {
    const { load: draftLoad } = await loadDefaultBranchSettings(opts.api, opts.owner, opts.repo, undefined, log);
    const draftsEnabled = draftLoad.state === "valid" ? isReviewDraftsEnabled(draftLoad) : false;
    const draftSkip = skipReasonForDraft(pr, draftsEnabled);
    if (draftSkip) {
      log(`${opts.owner}/${opts.repo}#${opts.prNumber} skipped: ${draftSkip}`);
      await persistPi({ kind: "skip", reason: draftSkip });
      return { status: "skipped", reason: draftSkip };
    }
  } catch {
    // Fail-open: an unexpected mode-gate failure still runs the review and
    // the publisher below applies its own draft check.
  }

  // CI gate mirrors the legacy review dispatch: failing or pending CI skips
  // before any session runs. The lookup-failed and absent markers flow back
  // to the tick, whose settle paths never spawn a legacy runner.
  let noCiNote: string | undefined;
  let ciChecks: CiCheckSummary[] | undefined;
  let ciPendingOptional: readonly string[] | undefined;
  {
    let ciGateWait: CiGateWait = "required";
    let ciGateRequiredContexts: readonly string[] | undefined;
    try {
      const gate = await resolveCiGate(opts.api, {
        owner: opts.owner,
        repo: opts.repo,
        prNumber: opts.prNumber,
        baseBranch: pr.base.ref,
        log,
      });
      ciGateWait = gate.wait;
      ciGateRequiredContexts = gate.requiredContexts;
    } catch {
      ciGateWait = "required";
    }
    const inspectHeadCi = async (relist?: boolean): Promise<string | undefined> => {
      try {
        const ci = await inspectOtherChecks(
          {
            api: opts.api,
            owner: opts.owner,
            repo: opts.repo,
            prNumber: opts.prNumber,
            home: opts.config.home,
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
            ...(opts.ciRelistDelayMs !== undefined ? { ciRelistDelayMs: opts.ciRelistDelayMs } : {}),
            baseBranch: pr.base.ref,
            ...(ciGateRequiredContexts ? { requiredContexts: ciGateRequiredContexts } : {}),
            ...(ciGateWait !== "required" ? { wait: ciGateWait } : {}),
            ...(relist === false ? { relist: false as const } : {}),
          },
          opts.headSha,
          log
        );
        if (ci.checks.length > 0) ciChecks = ci.checks;
        if (ci.pendingOptional.length > 0) ciPendingOptional = ci.pendingOptional;
        return reviewSkipReasonForCi(ci, ciGateWait);
      } catch (err) {
        if (isAbortError(err) || opts.abortSignal?.aborted) throw err;
        log(`CI inspect failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
        return CI_LOOKUP_FAILED_REASON;
      }
    };
    if (!opts.assumeNoCi) {
      const ciSkip = await inspectHeadCi();
      if (ciSkip) {
        // The lookup-failed and absent markers flow back to the tick, whose
        // settle paths requeue the row: persisting here would block the
        // requeue, so only terminal CI skips are persisted.
        if (ciSkip !== CI_ABSENT_REASON && ciSkip !== CI_LOOKUP_FAILED_REASON) {
          log(`${opts.owner}/${opts.repo}#${opts.prNumber} skipped: ${ciSkip}`);
          await persistPi({ kind: "skip", reason: ciSkip });
        }
        return { status: "skipped", reason: ciSkip };
      }
    } else {
      const ciSkip = await inspectHeadCi(false);
      if (ciSkip && ciSkip !== CI_ABSENT_REASON) {
        if (ciSkip !== CI_LOOKUP_FAILED_REASON) {
          log(`${opts.owner}/${opts.repo}#${opts.prNumber} skipped: ${ciSkip}`);
          await persistPi({ kind: "skip", reason: ciSkip });
        }
        return { status: "skipped", reason: ciSkip };
      }
      if (ciSkip === CI_ABSENT_REASON) noCiNote = CI_ABSENT_NOTE;
    }
  }

  const ownWorkspace = opts.seams?.workdirForReview === undefined;
  const workspace =
    opts.seams?.workdirForReview ??
    (await createReviewWorkspace(opts.config.workdir, {
      delivery: "",
      owner: opts.owner,
      repo: opts.repo,
      prNumber: opts.prNumber,
      action: "synchronize",
      headSha: opts.headSha,
      receivedAt: new Date().toISOString(),
    }));
  try {
    if (ownWorkspace) {
      const auth = await gitAuthResolverFor(
        { giteaUrl: opts.config.giteaUrl, giteaToken: opts.config.giteaToken, botUsername: opts.config.botUsername },
        opts.api,
        { owner: opts.owner, repo: opts.repo }
      )();
      const repoInfo = await opts.api.getRepo(opts.owner, opts.repo);
      await checkoutPullRequestWorkspace({
        workdir: workspace,
        repo: repoInfo,
        pr,
        giteaUrl: opts.config.giteaUrl,
        username: auth.username,
        token: auth.token,
        logger: log,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      });
    }
    const files = await opts.api.getPRFiles(opts.owner, opts.repo, opts.prNumber);
    const store = new ReviewVerdictStore({
      changedFiles: files.map((file) => ({ filename: file.filename, ...(file.patch ? { patch: file.patch } : {}) })),
    });
    let baseInstructions = opts.baseInstructions;
    if (baseInstructions === undefined) {
      try {
        const info = await opts.api.getRepo(opts.owner, opts.repo);
        const ref = info.default_branch?.trim();
        if (ref && opts.api.getRepoFile) {
          const file = await opts.api.getRepoFile(opts.owner, opts.repo, "REVIEW.md", ref);
          if (file.found && file.content?.trim()) {
            baseInstructions = `Repository review instructions (default branch):\n${file.content.slice(0, 8000)}`;
          }
        }
      } catch (err) {
        log(`pi base instructions unreadable for ${opts.owner}/${opts.repo}: ${errorMessage(err)}`);
      }
    }
    const lease = {
      isLeaseHeld: async () => true,
      isCancelled: async () => opts.abortSignal?.aborted ?? false,
      isWorktreeSafe: async () => true,
    };
    const role: PiAttemptRole = "review";
    const hop = await runPiHop({
      routes: names.length === 1 ? [names[0]!] : [names[0]!, names[1]!],
      catalog: opts.deployment.catalog,
      deploymentAllowlist: opts.deployment.allowlist,
      ...(opts.repoAllowed !== undefined ? { repoAllowed: opts.repoAllowed } : {}),
      scope,
      role,
      lease,
      invoke: async (route, ctx) => {
        const deps = await depsForRoute(route, ctx.sessionId, opts.seams);
        // The Pi SDK ends a turn on provider HTTP failures without surfacing
        // the status in the session result; record response statuses on the
        // wire so a loopback 429/401 still classifies into the quota-hold and
        // auth handling. The attempt's own destinations spy stays in force
        // inside (it chains through this wrapper and is restored first).
        const seenStatuses: number[] = [];
        const outerFetch = globalThis.fetch;
        globalThis.fetch = (async (input: never, init: never) => {
          const response = await outerFetch(input, init);
          try {
            seenStatuses.push(response.status);
          } catch {
            // A broken response still counts as observed; ignore the read.
          }
          return response;
        }) as typeof fetch;
        try {
          const result = await runPiReviewAttempt({
            workdir: workspace,
            ...(baseInstructions ? { baseInstructions } : {}),
            prompt: piReviewPrompt(pr, opts.headSha, files, noCiNote),
            store,
            modelRuntime: deps.modelRuntime,
            model: deps.model,
            allowedFetchHosts: deps.allowedFetchHosts,
            sandboxProbe: sandboxProbeOf(opts.seams),
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
            timeoutMs: opts.timeoutMs ?? opts.config.opencodeTimeoutMs ?? 15 * 60 * 1000,
            logger: log,
          });
          return piSessionToAdapterResult(result.status, result.reason, "pi review session finished", seenStatuses);
        } finally {
          globalThis.fetch = outerFetch;
        }
      },
    });

    if (hop.status === "ok" && hop.route && hop.stamp) {
      if (!store.hasVerdict()) {
        const reason = "Incomplete review: no verdict";
        await persistPi({ kind: "error", error: reason, piAttempt: hop.stamp });
        throw new EngineFailedError(`pi review ${reason.toLowerCase()}`, false);
      }
      const record = store.toRecord();
      const published = await publishReviewResult({
        api: opts.api,
        owner: opts.owner,
        repo: opts.repo,
        prNumber: opts.prNumber,
        expectedHeadSha: opts.headSha,
        botUsername: opts.config.botUsername,
        ...(opts.config.blockingQuestionAuthors
          ? { blockingQuestionAuthors: opts.config.blockingQuestionAuthors }
          : {}),
        ...(opts.config.automergeRepos ? { automergeRepos: opts.config.automergeRepos } : {}),
        ...(opts.config.trustedSenderLogins ? { trustedSenderLogins: opts.config.trustedSenderLogins } : {}),
        resultMarkdown: store.toMarkdown(),
        resultRunner: `pi:${hop.route.name}`,
        ...(ciChecks ? { ciChecks, ciHeadSha: opts.headSha } : {}),
        ...(ciPendingOptional && ciPendingOptional.length > 0 ? { ciPendingOptional } : {}),
        ...(noCiNote ? { noCiNote } : {}),
        logger: log,
      });
      await persistPi({
        kind: "markdown",
        markdown: store.toMarkdown(),
        runner: `pi:${hop.route.name}`,
        record,
        piAttempt: hop.stamp,
      });
      return published;
    }

    const stamp =
      hop.stamp ??
      buildPiAttemptStamp({
        route: firstRoute,
        role,
        outcome: hop.status === "refused" ? "denied" : "provider-failure",
      });
    const reason =
      hop.status === "refused"
        ? `pi refused: ${hop.reason ?? "route denied"}`
        : `pi review failed: ${hop.result?.message ?? hop.reason ?? "provider failure"}`;
    if (hop.status === "refused") {
      log(reason);
      await persistPi({ kind: "error", error: reason, piAttempt: stamp });
      return { status: "skipped", reason };
    }
    const failedKind = hop.result?.kind ?? "provider-failure";
    if (failedKind === "quota") {
      // No saveResult: the tick carries the stamp into `requeueInfra`, and a
      // persisted result would block the requeue.
      const decision = piQuotaDecision(opts.prevError ?? null, nowMsOf(opts.seams), hop.quotaResetAtMs, stamp);
      if (decision.action === "exhaust") {
        await persistPi({ kind: "error", error: reason, piAttempt: stamp });
        return { status: "skipped", reason: decision.reason };
      }
      throw decision.error;
    }
    await persistPi({ kind: "error", error: reason, piAttempt: stamp });
    throw new EngineFailedError(reason, false);
  } finally {
    if (ownWorkspace) await removeReviewWorkspace(workspace).catch(() => undefined);
  }
}

// --- Workers ---

type PiWorkerJobKind = "implement" | "follow-up" | "conflict";

export interface PiWorkerJobOptions {
  kind: PiWorkerJobKind;
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber?: number;
  headSha?: string;
  title?: string;
  body?: string;
  defaultBranch?: string;
  cloneUrl?: string;
  config: {
    workdir: string;
    home: string;
    giteaUrl: string;
    giteaToken: string;
    botUsername: string;
    opencodeTimeoutMs?: number;
  };
  api: IssueApi;
  logger?: (message: string) => void;
  deployment: PiDeployment;
  repoAllowed?: readonly string[];
  baseInstructions?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  prevError?: string | null;
  save?: PiSave;
  seams?: PiJobSeams;
}

function piWorkerPrompt(kind: PiWorkerJobKind, opts: PiWorkerJobOptions): string {
  const header = `Repository ${opts.owner}/${opts.repo}, issue #${opts.issueNumber}.`;
  const issue = `Issue title: ${(opts.title ?? "").slice(0, 500)}\nIssue body:\n${(opts.body ?? "").slice(0, 6000)}`;
  if (kind === "implement") {
    return (
      `${header} Implement the change described below in the worktree. ` +
      `Make the code change with the edit/write tools and verify it by running the repo's tests through bash. ` +
      `Do not commit, push, or open pulls; the parent owns releases. ` +
      `Record results only through the jumi_* tools.\n${issue}`
    );
  }
  if (kind === "follow-up") {
    const pr =
      opts.prNumber !== undefined ? ` Pull request #${opts.prNumber} at head ${opts.headSha ?? "unknown"}.` : "";
    return (
      `${header}${pr} Address the follow-up feedback below in the worktree. ` +
      `Do not commit, push, or open pulls; the parent owns releases. ` +
      `Use jumi_no_changes when the tree stays clean.\n${issue}`
    );
  }
  const pr = opts.prNumber !== undefined ? ` Pull request #${opts.prNumber}.` : "";
  return (
    `${header}${pr} Resolve the merge conflict in the worktree. ` +
    `Do not commit, push, or open pulls; the parent owns releases.\n${issue}`
  );
}

function piBranchName(issueNumber: number, title: string): string {
  const slug =
    (title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  return `jumi/issue-${issueNumber}-${slug}`;
}

async function piCloneRepo(opts: {
  workdir: string;
  cloneUrl: string;
  giteaUrl: string;
  username: string;
  token: string;
  logger: (message: string) => void;
  abortSignal?: AbortSignal;
}): Promise<Record<string, string | undefined>> {
  const configArgs = gitConfigArgs();
  const auth = { giteaUrl: opts.giteaUrl, username: opts.username, token: opts.token };
  const env = gitEnv(auth) as Record<string, string | undefined>;
  const run = (args: string[], cwd: string) =>
    opts.abortSignal
      ? runGit([...configArgs, ...args], { cwd, env, signal: opts.abortSignal })
      : runGit([...configArgs, ...args], { cwd, env });
  await mkdir(join(opts.workdir, ".."), { recursive: true }).catch(() => undefined);
  await rm(opts.workdir, { recursive: true, force: true });
  opts.logger(`Cloning for pi worker`);
  const remote = gitRemoteUrl(validateCloneUrl(opts.cloneUrl, opts.giteaUrl), auth);
  await run(["clone", remote, opts.workdir], process.cwd());
  return env;
}

async function piCommitAll(
  workdir: string,
  env: Record<string, string | undefined>,
  message: string,
  author: { name: string; email: string },
  abortSignal?: AbortSignal
): Promise<boolean> {
  const configArgs = gitConfigArgs();
  const run = (args: string[]) =>
    abortSignal
      ? runGit([...configArgs, ...args], { cwd: workdir, env, signal: abortSignal })
      : runGit([...configArgs, ...args], { cwd: workdir, env });
  const status = await run(["status", "--porcelain"]);
  if (!status.trim()) return false;
  await run(["add", "-A"]);
  const again = await run(["status", "--porcelain"]);
  if (!again.trim()) return false;
  await run(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message]);
  return true;
}

/**
 * Run one worker intent through the Pi session on the Go route with the
 * parent doing the push and publication. Returns the legacy result shape so
 * the tick settles exactly as in legacy; persists the attempt stamp through
 * `save` before returning or throwing.
 */
export async function runPiWorkerJob(
  opts: PiWorkerJobOptions
): Promise<ImplementResult | FollowUpResult | ConflictResult> {
  const log = opts.logger ?? (() => undefined);
  const save = opts.save ?? (async () => undefined);
  const savePi = async (result: PersistReviewResult): Promise<void> => {
    await save({ ...result, harnessMode: "pi" });
  };
  const intent: PiWorkerIntent =
    opts.kind === "implement" ? "implement" : opts.kind === "follow-up" ? "follow-up" : "conflict";
  const role: PiAttemptRole = intent;

  const names = piChainForJob(opts.deployment, opts.repoAllowed);
  if (names.length === 0) {
    const reason = "pi refused: no Pi route is allowlisted for this job";
    await savePi({ kind: "error", error: reason });
    return { status: "skipped", reason };
  }
  const { scope, visibilityFailed } = await piScopeForRepo(
    (owner, repo) => (opts.api as IssueApi).getRepo(owner, repo),
    opts.owner,
    opts.repo
  );
  const firstRoute = checkPiHandoff(names[0]!, opts.deployment.catalog, opts.deployment.allowlist, {
    ...(opts.repoAllowed !== undefined ? { repoAllowed: opts.repoAllowed } : {}),
  });
  if (scope === "private") {
    const reason = piScopeRefusalReason(opts.owner, opts.repo, visibilityFailed);
    log(reason);
    await savePi({
      kind: "error",
      error: reason,
      piAttempt: buildPiAttemptStamp({ route: firstRoute, role, outcome: "denied" }),
    });
    return { status: "skipped", reason };
  }

  const store = new WorkerResultStore();
  const lease = {
    isLeaseHeld: async () => true,
    isCancelled: async () => opts.abortSignal?.aborted ?? false,
    isWorktreeSafe: async () => true,
  };
  // One worktree for the session and the parent-owned release: the session
  // edits here, the parent commits and pushes from here. A caller-provided
  // worktree (tests) is used as-is and never cleaned up; otherwise the
  // executor clones the job branch and removes the checkout afterwards.
  const seamWorkdir = opts.seams?.workdirForWorker;
  const workdir = seamWorkdir ?? join(opts.config.workdir, `jumi-pi-${opts.owner}-${opts.repo}-${opts.issueNumber}`);
  let release: PiWorkerCheckout | undefined;
  if (seamWorkdir === undefined) {
    release = opts.seams?.prepareCheckout
      ? await opts.seams.prepareCheckout(workdir)
      : await preparePiWorkerCheckout(opts, workdir, log);
  }
  try {
    const hop = await runPiHop({
      routes: names.length === 1 ? [names[0]!] : [names[0]!, names[1]!],
      catalog: opts.deployment.catalog,
      deploymentAllowlist: opts.deployment.allowlist,
      ...(opts.repoAllowed !== undefined ? { repoAllowed: opts.repoAllowed } : {}),
      scope,
      role,
      lease,
      invoke: async (route, ctx) => {
        const deps = await depsForRoute(route, ctx.sessionId, opts.seams);
        // The session owns one conversation over the worktree; the parent
        // observes the diff afterwards and alone decides what to push. As in
        // reviews, provider HTTP statuses are recorded on the wire because
        // the SDK ends the turn without surfacing them in the result.
        const seenStatuses: number[] = [];
        const outerFetch = globalThis.fetch;
        globalThis.fetch = (async (input: never, init: never) => {
          const response = await outerFetch(input, init);
          try {
            seenStatuses.push(response.status);
          } catch {
            // A broken response still counts as observed; ignore the read.
          }
          return response;
        }) as typeof fetch;
        try {
          const result = await runPiWorkerAttempt({
            workdir,
            ...(opts.baseInstructions ? { baseInstructions: opts.baseInstructions } : {}),
            intent,
            prompt: piWorkerPrompt(opts.kind, opts),
            store,
            modelRuntime: deps.modelRuntime,
            model: deps.model,
            allowedFetchHosts: deps.allowedFetchHosts,
            sandboxProbe: sandboxProbeOf(opts.seams),
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
            timeoutMs: opts.timeoutMs ?? opts.config.opencodeTimeoutMs ?? 60 * 60 * 1000,
            logger: log,
          });
          return piSessionToAdapterResult(result.status, result.reason, "pi worker session finished", seenStatuses);
        } finally {
          globalThis.fetch = outerFetch;
        }
      },
    });

    const stamp =
      hop.stamp ??
      buildPiAttemptStamp({
        route: firstRoute,
        role,
        outcome: hop.status === "refused" ? "denied" : "provider-failure",
      });
    if (hop.status !== "ok" || !hop.route) {
      const reason =
        hop.status === "refused"
          ? `pi refused: ${hop.reason ?? "route denied"}`
          : `pi worker failed: ${hop.result?.message ?? hop.reason ?? "provider failure"}`;
      if (hop.status === "refused" || hop.result?.kind === "denied") {
        log(reason);
        await savePi({ kind: "error", error: reason, piAttempt: stamp });
        return { status: "skipped", reason };
      }
      if (hop.result?.kind === "quota") {
        // No saveResult: the tick carries the stamp into `requeueInfra`.
        const decision = piQuotaDecision(opts.prevError ?? null, nowMsOf(opts.seams), hop.quotaResetAtMs, stamp);
        if (decision.action === "exhaust") {
          await savePi({ kind: "error", error: reason, piAttempt: stamp });
          return { status: "skipped", reason: decision.reason };
        }
        throw decision.error;
      }
      await savePi({ kind: "error", error: reason, piAttempt: stamp });
      throw new EngineFailedError(reason, false);
    }

    if (opts.abortSignal?.aborted || isAbortError(hop.result)) {
      throw new EngineFailedError("pi worker cancelled", false);
    }

    // Parent-owned release: the session never commits, pushes, or opens a
    // pull. Skip/blocked and no-change reports settle without touching git.
    const skipReason = store.getSkipReason() ?? (intent === "follow-up" ? store.getNoChangesReason() : undefined);
    const blocked = store.getBlockedOn();
    if (blocked) {
      const reason = `pi blocked on ${blocked.ref}: ${blocked.reason}`;
      await savePi({ kind: "skip", reason, piAttempt: stamp });
      return { status: "skipped", reason };
    }
    if (skipReason) {
      await savePi({ kind: "skip", reason: skipReason, piAttempt: stamp });
      return intent === "follow-up" || opts.kind === "implement"
        ? { status: "no-changes" }
        : { status: "skipped", reason: skipReason };
    }

    if (seamWorkdir !== undefined) {
      // Test seam: the caller observes the diff itself. Record the stamp and
      // report the session outcome without touching git or the forge.
      const prBody = store.getPrBody() ?? "";
      await savePi({
        kind: "markdown",
        markdown: prBody || `${opts.kind} complete`,
        runner: `pi:${hop.route.name}`,
        piAttempt: stamp,
      });
      if (opts.kind === "implement") {
        return prBody
          ? { status: "skipped", reason: `pi implement draft: ${prBody.slice(0, 160)}` }
          : { status: "no-changes" };
      }
      if (opts.kind === "follow-up") {
        return { status: "no-changes" };
      }
      return { status: "up-to-date" };
    }

    // Production release from the same worktree the session edited.
    const prBody = store.getPrBody() ?? store.getHandoff() ?? `Pi ${opts.kind} for #${opts.issueNumber}.`;
    return await publishPiWorkerRelease(
      { ...opts, savePi, stamp, hopRoute: hop.route, log, prBody },
      release!,
      workdir
    );
  } finally {
    await release?.cleanup().catch(() => undefined);
  }
}

/**
 * Check out the job branch for a Pi worker attempt: implement starts a new
 * `jumi/issue-<n>-<slug>` branch off the default branch; follow-up and
 * conflict resume the pull's head branch (same repo or fork).
 */
async function preparePiWorkerCheckout(
  opts: PiWorkerJobOptions,
  workdir: string,
  log: (message: string) => void
): Promise<PiWorkerCheckout> {
  const auth = await gitAuthResolverFor(
    { giteaUrl: opts.config.giteaUrl, giteaToken: opts.config.giteaToken, botUsername: opts.config.botUsername },
    opts.api,
    { owner: opts.owner, repo: opts.repo }
  )();
  const repoInfo = await (opts.api as IssueApi).getRepo(opts.owner, opts.repo);
  const cloneUrl = opts.cloneUrl ?? repoInfo.clone_url;
  const defaultBranch = opts.defaultBranch ?? repoInfo.default_branch;
  const env = await piCloneRepo({
    workdir,
    cloneUrl,
    giteaUrl: opts.config.giteaUrl,
    username: auth.username,
    token: auth.token,
    logger: log,
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
  const run = (args: string[], cwd: string) =>
    opts.abortSignal
      ? runGit([...gitConfigArgs(), ...args], { cwd, env, signal: opts.abortSignal })
      : runGit([...gitConfigArgs(), ...args], { cwd, env });
  let branch: string;
  if (opts.kind === "implement") {
    branch = piBranchName(opts.issueNumber, opts.title ?? "");
    await run(["checkout", "-B", branch, `origin/${defaultBranch}`], workdir);
  } else {
    if (opts.prNumber === undefined) {
      throw new EngineFailedError(`pi ${opts.kind} needs a pull request number`, false);
    }
    const pr = await (opts.api as unknown as { getPR: (o: string, r: string, n: number) => Promise<Pull> }).getPR(
      opts.owner,
      opts.repo,
      opts.prNumber
    );
    const headRef = pr.head.ref;
    const headClone = pr.head.repo?.clone_url ?? cloneUrl;
    if (headClone !== cloneUrl) {
      await run(
        [
          "fetch",
          gitRemoteUrl(validateCloneUrl(headClone, opts.config.giteaUrl), auth),
          `+refs/heads/${headRef}:refs/remotes/head/${headRef}`,
        ],
        workdir
      );
      await run(["checkout", "-B", headRef, `refs/remotes/head/${headRef}`], workdir);
    } else {
      await run(["fetch", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`], workdir);
      await run(["checkout", "-B", headRef, `refs/remotes/origin/${headRef}`], workdir);
    }
    branch = headRef;
  }
  return { branch, env, cleanup: async () => rm(workdir, { recursive: true, force: true }).catch(() => undefined) };
}

async function publishPiWorkerRelease(
  opts: PiWorkerJobOptions & {
    savePi: PiPersist;
    stamp: PiAttemptStamp;
    hopRoute: PiResolvedRoute;
    log: (message: string) => void;
    prBody: string;
  },
  release: PiWorkerCheckout,
  workdir: string
): Promise<ImplementResult | FollowUpResult | ConflictResult> {
  const gitName = process.env.JUMI_GIT_NAME?.trim() || "jumi";
  const gitEmail = process.env.JUMI_GIT_EMAIL?.trim() || "jumi@localhost";
  const dirty = await piCommitAll(
    workdir,
    release.env,
    opts.title?.trim() ? opts.title.trim() : `jumi pi ${opts.kind} ${opts.owner}/${opts.repo}#${opts.issueNumber}`,
    { name: gitName, email: gitEmail },
    opts.abortSignal
  );
  if (!dirty) {
    await opts.savePi({ kind: "skip", reason: "pi worker: no changes", piAttempt: opts.stamp });
    if (opts.kind === "conflict") return { status: "up-to-date" };
    return { status: "no-changes" };
  }
  const run = (args: string[], cwd: string) =>
    opts.abortSignal
      ? runGit([...gitConfigArgs(), ...args], { cwd, env: release.env, signal: opts.abortSignal })
      : runGit([...gitConfigArgs(), ...args], { cwd, env: release.env });
  if (!opts.seams?.skipPush) {
    await run(["push", "origin", release.branch], workdir);
  }
  const body = wrapJumiPrBody(opts.prBody);
  if (opts.kind === "implement") {
    const pr = await (opts.api as IssueApi).createPullRequest(opts.owner, opts.repo, {
      title: opts.title?.trim() || `jumi pi implement #${opts.issueNumber}`,
      body,
      head: release.branch,
      base: opts.defaultBranch ?? (await (opts.api as IssueApi).getRepo(opts.owner, opts.repo)).default_branch,
    });
    await opts.savePi({
      kind: "markdown",
      markdown: body,
      runner: `pi:${opts.hopRoute.name}`,
      piAttempt: opts.stamp,
    });
    opts.log(`pi implement opened ${pr.html_url}`);
    return { status: "pr", htmlUrl: pr.html_url, prNumber: pr.number };
  }
  const prNumber = opts.prNumber!;
  const pr = await (opts.api as unknown as { getPR: (o: string, r: string, n: number) => Promise<Pull> }).getPR(
    opts.owner,
    opts.repo,
    prNumber
  );
  await opts.savePi({
    kind: "markdown",
    markdown: `Pi ${opts.kind} pushed to ${release.branch}.`,
    runner: `pi:${opts.hopRoute.name}`,
    piAttempt: opts.stamp,
  });
  return { status: "pushed", prNumber, htmlUrl: pr.html_url };
}
