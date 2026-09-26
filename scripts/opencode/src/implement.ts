import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PickupPolicy } from "./assignee.ts";
import { claimFilePath, deleteClaim, isPidAlive, readClaim } from "./claim.ts";
import {
  attachIssueWorktree,
  beginClaimedWorktree,
  clearLeftoverWorktree,
  commitIfDirty,
  commitsAheadOf,
  ensureBareCache,
  isClaimedEarlyResult,
  openClaimedLoop,
  pushClaimedBranch,
  recheckAssignedAndOpen,
  runClaimedLoop,
  skipClaimedWork,
  stripSentinels,
  throwIfAborted,
  worktreePorcelain,
} from "./claimed_worktree.ts";
import type { ConflictResult } from "./conflict.ts";
import {
  BLOCKED_BY_FILE,
  BLOCKED_BY_REJECTED_STUCK,
  blockedOnComment,
  checkIssueBlockers,
  collectCandidateQueue,
  formatQueueMarkdown,
  parseBlockedByArtifact,
  QUEUE_FILE,
  type QueueCandidate,
  validateYield,
} from "./dependencies.ts";
import { type Engine, type EngineRunOptions, runEngineStamped, throwIfEngineFailed, thrownRunner } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import { engineScratchTrackedReason, tipTracksEngineScratch } from "./engine_scratch.ts";
import type { FollowUpResult } from "./followup.ts";
import { BLOCKED_BY_REJECTED_PROMPT, IMPLEMENT_PROMPT, IMPLEMENT_YIELD_PROMPT } from "./git.ts";
import { closesIssuePattern, pullRequestClosesIssue, upsertWorkerComment } from "./gitea_issues.ts";
import { gateShipAfterOpenCode, jobWithIssue, type ShipGate, snapshotFromJob } from "./issue_recheck.ts";
import { isJumiCloserForIssue, runCloserWork } from "./pickup.ts";
import type { IssueApi } from "./ports.ts";
import { isQuotaError, isQuotaText, QUOTA_STUCK_TEXT } from "./quota.ts";
import { throwIfQuotaWait } from "./quota_wait.ts";
import { appendRunnerStamp, type NamedRunner, type RunnerStamp } from "./runners.ts";
import { type SkipLatchStore, skipLatchesFor } from "./skip_latches.ts";
import {
  appendStuckLatchFingerprint,
  evaluateStuck,
  fingerprintError,
  isQuotaStuck,
  markQuotaStuckLatch,
  readStuckLatch,
  stuckComment,
} from "./stuck.ts";
import type { IssueJob } from "./types.ts";
import { type GitAuthResolver, type GitRunner, redactGitSecrets, workerOpenCodeChildEnv } from "./workspace.ts";

export { HEARTBEAT_INTERVAL_MS } from "./claimed_worktree.ts";
export { BLOCKED_BY_REJECTED_PROMPT, IMPLEMENT_PROMPT, IMPLEMENT_YIELD_PROMPT } from "./git.ts";

const PARENT_PROSE_MAX_CHARS = 8000;
export const PR_DESCRIPTION_FILE = "JUMI_PR.md";
export const SKIP_FILE = "JUMI_SKIP.md";
export const INCOMPLETE_IMPLEMENT = "Incomplete implement: no skip artifact";

function parentOwnedProse(text: string): string {
  let out = text.replaceAll("\0", "").trim();
  if (out.length > PARENT_PROSE_MAX_CHARS) out = out.slice(0, PARENT_PROSE_MAX_CHARS);
  return out;
}

/** The artifact only has to be non-empty; its prose is never read as proof of anything. */
export function isValidatedSkipText(text: string | null | undefined): boolean {
  if (text == null) return false;
  return parentOwnedProse(text).length > 0;
}

export function skipDiaryText(text: string, secrets: readonly (string | undefined)[] = []): string {
  return redactGitSecrets(parentOwnedProse(text), secrets);
}

/** Non-empty regular file text, else null: missing, empty, directory, and symlink are incomplete. */
export async function readValidatedSkip(worktree: string): Promise<string | null> {
  const path = join(worktree, SKIP_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    const text = await readFile(path, "utf8");
    return isValidatedSkipText(text) ? text : null;
  } catch {
    return null;
  }
}

export type OpenCodeRunner = Engine;

export type HelmRunner = (args: string[], opts: { cwd: string }) => Promise<string>;

export type ImplementResult =
  | { status: "pr"; htmlUrl: string; prNumber: number }
  | { status: "no-changes" }
  | { status: "skipped"; reason: string }
  | { status: "cancelled" };

export interface ImplementOptions extends PickupPolicy {
  api: IssueApi;
  job: IssueJob;
  giteaUrl: string;
  giteaToken: string;
  followupIgnoreLogins?: readonly string[];
  model: string;
  variant?: string;
  fallbackModel?: string;
  fallbackVariant?: string;
  chain?: NamedRunner[];
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  home: string;
  workdir: string;
  timeoutMs?: number;
  followupTimeoutMs?: number;
  conflictTimeoutMs?: number;
  maxFollowupRounds?: number;
  maxConflictRounds?: number;
  maxOutputBytes?: number;
  sanitizeOpenCodeEnv?: boolean;
  heartbeatIntervalMs?: number;
  abortSignal?: AbortSignal;
  gitRunner?: GitRunner;
  gitAuthResolver?: GitAuthResolver;
  engine?: Engine;
  openCodeRunner?: Engine;
  helmRunner?: HelmRunner;
  now?: () => Date;
  pid?: number;
  pidAlive?: (pid: number) => boolean;
  logger?: (message: string) => void;
  useClaim?: boolean;
  onPid?: (pid: number) => void | Promise<void>;
  jobId?: string;
  skipLatches?: SkipLatchStore;
  previousError?: string | null;
}

function logDefault(message: string) {
  console.log(`[implement] ${message}`);
}

export function issueBranchName(issueNumber: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  return `jumi/issue-${issueNumber}-${slug}`;
}

export function issueJobKey(job: { owner: string; repo: string; issueNumber: number }): string {
  return `${job.owner}/${job.repo}#${job.issueNumber}`;
}

export function buildTaskMarkdown(job: IssueJob): string {
  return `# ${job.title}\n\n${job.body}\n\n${job.htmlUrl}\n`;
}

export function buildPullRequestBody(
  issueNumber: number,
  fileContents: string | null | undefined,
  runner?: RunnerStamp,
  secrets: readonly (string | undefined)[] = []
): string {
  return redactGitSecrets(appendRunnerStamp(pullRequestText(issueNumber, fileContents), runner), secrets);
}

function pullRequestText(issueNumber: number, fileContents: string | null | undefined): string {
  const fallback = `Fixes #${issueNumber}`;
  if (fileContents == null) return fallback;
  const text = parentOwnedProse(fileContents);
  if (!text) return fallback;
  if (closesIssuePattern(issueNumber).test(text)) return text;
  return `${text}\n\n${fallback}`;
}

/** Jumi owns only the text between these markers; the rest of the PR body is left alone. */
export const PR_BODY_FENCE_START = "<!-- jumi-pr-body:start -->";
export const PR_BODY_FENCE_END = "<!-- jumi-pr-body:end -->";

export function wrapJumiPrBody(text: string): string {
  return `${PR_BODY_FENCE_START}\n${text.trim()}\n${PR_BODY_FENCE_END}`;
}

function fenceBounds(body: string): { start: number; end: number } | undefined {
  const start = body.indexOf(PR_BODY_FENCE_START);
  if (start < 0) return undefined;
  const end = body.indexOf(PR_BODY_FENCE_END, start + PR_BODY_FENCE_START.length);
  if (end < 0) return undefined;
  return { start, end: end + PR_BODY_FENCE_END.length };
}

/** The jumi-owned text of a PR body, or undefined when the body was never fenced. */
export function jumiPrBodyRegion(body: string | null | undefined): string | undefined {
  const text = body ?? "";
  const bounds = fenceBounds(text);
  if (!bounds) return undefined;
  return text.slice(bounds.start + PR_BODY_FENCE_START.length, bounds.end - PR_BODY_FENCE_END.length).trim();
}

/** Replace only the fenced region; undefined when there is no fence to own. */
export function replaceJumiPrBodyRegion(body: string | null | undefined, text: string): string | undefined {
  const current = body ?? "";
  const bounds = fenceBounds(current);
  if (!bounds) return undefined;
  return `${current.slice(0, bounds.start)}${wrapJumiPrBody(text)}${current.slice(bounds.end)}`;
}

const RUNNER_STAMP_LINE = /\n*_Jumi · [^\n]*_\s*$/;

/** What the follow-up child sees in JUMI_PR.md: the posted region without the runner stamp. */
export function seedPullRequestDescription(region: string): string {
  const text = region.replace(RUNNER_STAMP_LINE, "").trim();
  return text ? `${text}\n` : "";
}

export async function readPullRequestDescription(worktree: string): Promise<string | null> {
  const path = join(worktree, PR_DESCRIPTION_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function implementIssue(
  opts: ImplementOptions
): Promise<ImplementResult | FollowUpResult | ConflictResult> {
  const log = opts.logger ?? logDefault;
  const branch = issueBranchName(opts.job.issueNumber, opts.job.title);
  const claimed = await beginClaimedWorktree({
    ...opts,
    fallbackEngine: registeredEngine,
    branch,
  });
  if (isClaimedEarlyResult(claimed)) return claimed;
  const { owner, repo, issueNumber, worktree, barePath, sanitizeEnv, engine, now, forgetClaim } = claimed;

  const pulls = await opts.api.listOpenPulls(owner, repo);
  const jumiCloser = pulls.find((pr) => isJumiCloserForIssue(pr, owner, repo, issueNumber, opts.botUsername));
  if (jumiCloser) {
    await forgetClaim();
    return runCloserWork(opts, jumiCloser);
  }
  if (pulls.some((pr) => pullRequestClosesIssue(pr, issueNumber))) {
    await forgetClaim();
    return { status: "skipped", reason: `open PR already closes #${issueNumber}` };
  }

  const assigned = await recheckAssignedAndOpen(claimed, opts);
  if (assigned) return assigned;

  try {
    const blockers = await checkIssueBlockers(opts.api, owner, repo, issueNumber);
    if (blockers.status === "stuck") {
      await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, blockers.reason);
      await forgetClaim();
      return { status: "skipped", reason: blockers.reason };
    }
    if (blockers.status === "blocked") {
      const reason = blockedOnComment(blockers.blockers, owner, repo);
      await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, reason);
      await forgetClaim();
      return { status: "skipped", reason };
    }
  } catch (err) {
    await forgetClaim();
    return {
      status: "skipped",
      reason: `failed to load dependencies: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const latches = skipLatchesFor(opts);
  const latchKey = { owner, repo, issueNumber };
  const stuckState = await readStuckLatch(latches, latchKey);
  if (isQuotaStuck(stuckState)) {
    await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, QUOTA_STUCK_TEXT);
    await forgetClaim();
    return { status: "skipped", reason: QUOTA_STUCK_TEXT };
  }
  const stuckReason = evaluateStuck(stuckState.fingerprints);
  if (stuckReason) {
    await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, stuckComment(stuckReason));
    await forgetClaim();
    return { status: "skipped", reason: stuckComment(stuckReason) };
  }

  let queue: QueueCandidate[] = [];
  try {
    queue = await collectCandidateQueue({
      api: opts.api,
      owner,
      repo,
      issueNumber,
      botUsername: opts.botUsername,
      body: opts.job.body,
      pulls,
    });
  } catch (err) {
    await forgetClaim();
    return {
      status: "skipped",
      reason: `failed to load candidate queue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const loop = openClaimedLoop(claimed, opts);
  // The runner behind the latest spawn; after a hop this is the one that ran.
  let runner: RunnerStamp | undefined;
  const diary = (body: string) =>
    upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, appendRunnerStamp(body, runner));

  return runClaimedLoop(
    loop,
    opts.abortSignal,
    async () => {
      await ensureBareCache(loop, {
        cloneUrl: opts.job.cloneUrl,
        giteaUrl: opts.giteaUrl,
        abortSignal: opts.abortSignal,
        log,
      });
      const headSha = await attachIssueWorktree(loop, {
        branch,
        defaultBranch: opts.job.defaultBranch,
        abortSignal: opts.abortSignal,
        log,
      });
      await loop.stampHeadSha(headSha);

      throwIfAborted(opts.abortSignal);
      const writeTaskFiles = async (job: IssueJob) => {
        await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(job));
        if (queue.length > 0) {
          await writeFile(join(worktree, QUEUE_FILE), formatQueueMarkdown(queue, owner, repo));
        } else {
          await rm(join(worktree, QUEUE_FILE), { force: true }).catch(() => undefined);
        }
        await rm(join(worktree, BLOCKED_BY_FILE), { force: true }).catch(() => undefined);
        // Every child-written sentinel is dropped before a re-spawn, so a skip
        // artifact can only ever describe the round that just ran.
        await rm(join(worktree, SKIP_FILE), { force: true }).catch(() => undefined);
      };
      await writeTaskFiles(opts.job);
      await upsertWorkerComment(
        opts.api,
        owner,
        repo,
        issueNumber,
        opts.botUsername,
        "Jumi is implementing this issue."
      );

      // Set when the chain refused an incomplete hop, so no child ran at all.
      let hopDeclined = false;
      const runEngine = async (
        label: string,
        kind: "implement" | "follow-up" = "implement",
        prompt?: string,
        extra?: { continueSession?: boolean; hopFromIncomplete?: boolean }
      ): Promise<ImplementResult | undefined> => {
        throwIfAborted(opts.abortSignal);
        log(label);
        const runOpts: EngineRunOptions = {
          model: opts.model,
          variant: opts.variant,
          workdir: worktree,
          home: opts.home,
          sanitizeEnv,
          extraEnv: workerOpenCodeChildEnv(loop.auth, worktree),
          timeoutMs: opts.timeoutMs,
          maxOutputBytes: opts.maxOutputBytes,
          reviewLabel: `${owner}/${repo}#${issueNumber}`,
          trace: {
            kind,
            owner,
            repo,
            sha: headSha,
            jobId: opts.jobId ?? opts.job.delivery,
          },
          ...(prompt != null ? { prompt } : {}),
          ...(extra?.continueSession ? { continueSession: true } : {}),
          ...(extra?.hopFromIncomplete ? { hopFromIncomplete: true } : {}),
          logger: log,
          abortSignal: opts.abortSignal,
          onPid: loop.engineOnPid(opts.onPid),
        };
        runner = undefined;
        hopDeclined = false;
        const result = await runEngineStamped(engine, runOpts, (r) => {
          runner = r;
        });
        if (result.hopDeclined === true) {
          // No spawn happened, so the stamp would name a runner that never ran.
          runner = undefined;
          hopDeclined = true;
          return undefined;
        }
        // Gate on the message: only the quota path returns engine `stuck`
        // today, but a future non-quota producer must not set the quota flag.
        if (result.status === "stuck" && isQuotaText(result.message)) {
          throwIfQuotaWait({
            result,
            model: opts.model,
            fallbackModel: opts.fallbackModel,
            chain: opts.chain,
            previousError: opts.previousError,
          });
          await diary(QUOTA_STUCK_TEXT);
          await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
          return skipClaimedWork(loop, QUOTA_STUCK_TEXT);
        }
        throwIfEngineFailed(result);
        return undefined;
      };

      const addWorktreeFromDefault = async () => {
        await clearLeftoverWorktree(loop);
        await mkdir(dirname(worktree), { recursive: true });
        await loop.runConfiguredGit(["worktree", "add", "-B", branch, worktree, `origin/${opts.job.defaultBranch}`], {
          cwd: barePath,
          env: loop.env,
        });
        await mkdir(worktree, { recursive: true });
      };

      const deleteRefIfPresent = async (ref: string) => {
        if (!(await loop.refExists(ref))) return;
        await loop.runConfiguredGit(["update-ref", "-d", ref], { cwd: barePath, env: loop.env });
      };

      const deletePushedIssueBranch = async () => {
        if (branch === opts.job.defaultBranch) return;
        await loop.detachWorktree();
        await deleteRefIfPresent(`refs/heads/${branch}`);
        try {
          await loop.runConfiguredGit(["push", "origin", "--delete", branch], { cwd: barePath, env: loop.env });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/remote ref does not exist/i.test(msg)) throw err;
        }
        await deleteRefIfPresent(`refs/remotes/origin/${branch}`);
        await loop.runConfiguredGit(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], {
          cwd: barePath,
          env: loop.env,
        });
        if (await loop.refExists(`refs/remotes/origin/${branch}`)) {
          throw new Error(`failed to delete origin/${branch}`);
        }
      };

      const readBlockedBy = async () => {
        const path = join(worktree, BLOCKED_BY_FILE);
        try {
          const info = await lstat(path);
          if (!info.isFile()) return parseBlockedByArtifact(null, owner, repo);
          return parseBlockedByArtifact(await readFile(path, "utf8"), owner, repo);
        } catch {
          return parseBlockedByArtifact(null, owner, repo);
        }
      };

      const skipBlocked = async (reason: string) => {
        await diary(reason);
        return skipClaimedWork(loop, reason);
      };

      // Leaves the issue retryable: a diary so the last visible state is not the
      // in-progress sticky, and no `stampTerminalClaim`, which #114 forbids here.
      const skipIncomplete = () => skipBlocked(INCOMPLETE_IMPLEMENT);

      const applyValidYield = async (blocker: { owner: string; repo: string; number: number }) => {
        try {
          await opts.api.createIssueDependency(owner, repo, issueNumber, {
            owner: blocker.owner,
            repo: blocker.repo,
            number: blocker.number,
          });
        } catch (err) {
          await deletePushedIssueBranch().catch(() => undefined);
          return skipBlocked(`failed to set dependency: ${err instanceof Error ? err.message : String(err)}`);
        }
        await deletePushedIssueBranch().catch(() => undefined);
        return skipBlocked(blockedOnComment([blocker], owner, repo));
      };

      // The issue text the gate last validated. Every later round — a rejected-yield
      // reset or the incomplete hop — starts from this, never from the pre-run job.
      let liveJob = opts.job;
      let snapshot = snapshotFromJob(opts.job);

      const resetAfterRejectedYield = async () => {
        await deletePushedIssueBranch();
        // A half-deleted tree fails here, in `clearLeftoverWorktree`, before the next spawn.
        await addWorktreeFromDefault();
        await writeTaskFiles(liveJob);
      };

      const handleYield = async (rejectedOnce: boolean): Promise<ImplementResult | "continue" | "retry"> => {
        if (queue.length === 0) return "continue";
        const artifact = await readBlockedBy();
        if (!artifact.present) return "continue";
        const decision = validateYield(artifact.parsed, queue, owner, repo, issueNumber);
        if (decision.ok) return applyValidYield(decision.blocker);
        if (!rejectedOnce) return "retry";
        await deletePushedIssueBranch();
        return skipBlocked(BLOCKED_BY_REJECTED_STUCK);
      };

      let incompleteHopped = false;
      let prFileContents: string | null = null;
      let porcelain = "";
      for (;;) {
        const quotaSkip = await runEngine(
          incompleteHopped
            ? `Re-running OpenCode after incomplete implement for ${owner}/${repo}#${issueNumber}`
            : `Running OpenCode for ${owner}/${repo}#${issueNumber}`,
          "implement",
          queue.length > 0 ? IMPLEMENT_YIELD_PROMPT : undefined,
          incompleteHopped ? { hopFromIncomplete: true } : undefined
        );
        if (quotaSkip) return quotaSkip;
        // The chain had no runner left to hop to, so nothing ran this round: the
        // sentinels are already stripped, so re-gating would only re-handle an
        // issue edit and continue a session this worktree no longer has.
        if (hopDeclined) return skipIncomplete();

        const firstYield = await handleYield(false);
        if (firstYield === "retry") {
          log(`blocked-by rejected, implement ${owner}/${repo}#${issueNumber}`);
          await resetAfterRejectedYield();
          const quotaRetry = await runEngine(
            `Re-running OpenCode after blocked-by rejected for ${owner}/${repo}#${issueNumber}`,
            "implement",
            BLOCKED_BY_REJECTED_PROMPT
          );
          if (quotaRetry) return quotaRetry;
          const secondYield = await handleYield(true);
          if (secondYield === "retry") return skipBlocked(BLOCKED_BY_REJECTED_STUCK);
          if (secondYield !== "continue") return secondYield;
        } else if (firstYield !== "continue") {
          return firstYield;
        }

        let gate: ShipGate;
        try {
          gate = await gateShipAfterOpenCode({
            api: opts.api,
            owner,
            repo,
            issueNumber,
            botUsername: opts.botUsername,
            snapshot,
            continueOpenCode: async (issue) => {
              await writeTaskFiles(jobWithIssue(opts.job, issue));
              const quotaContinued = await runEngine(
                `Re-running OpenCode after issue change for ${owner}/${repo}#${issueNumber}`,
                "follow-up",
                queue.length > 0 ? IMPLEMENT_YIELD_PROMPT : IMPLEMENT_PROMPT,
                { continueSession: true }
              );
              if (quotaContinued) throw new Error(QUOTA_STUCK_TEXT);
            },
          });
        } catch (err) {
          if (isQuotaError(err)) {
            throwIfQuotaWait({
              err,
              model: opts.model,
              fallbackModel: opts.fallbackModel,
              chain: opts.chain,
              previousError: opts.previousError,
            });
            return skipClaimedWork(loop, QUOTA_STUCK_TEXT);
          }
          throw err;
        }
        if (gate.action === "skip") {
          return skipClaimedWork(loop, gate.reason, { detach: !gate.keepLocalWork });
        }
        liveJob = jobWithIssue(opts.job, gate.issue);
        snapshot = gate.snapshot;

        throwIfAborted(opts.abortSignal);
        prFileContents = await readPullRequestDescription(worktree);
        const validatedSkip = await readValidatedSkip(worktree);
        await stripSentinels(worktree, [PR_DESCRIPTION_FILE, SKIP_FILE, "JUMI_TASK.md", QUEUE_FILE, BLOCKED_BY_FILE]);
        porcelain = await worktreePorcelain(loop);
        if (!porcelain && (await commitsAheadOf(loop, `origin/${opts.job.defaultBranch}`)) <= 0) {
          if (validatedSkip) {
            await loop.stopHeartbeat();
            await diary(skipDiaryText(validatedSkip, [loop.auth.token]));
            await loop.stampTerminalClaim(opts.api);
            await loop.detachWorktree();
            return { status: "no-changes" };
          }
          if (!incompleteHopped) {
            // The chain owns whether a hop is possible; it answers `hopDeclined`
            // at the top of the next round when there is no runner left.
            incompleteHopped = true;
            await writeTaskFiles(liveJob);
            continue;
          }
          return skipIncomplete();
        }
        break;
      }

      if (branch === opts.job.defaultBranch) {
        throw new Error("refusing to commit on the default branch");
      }

      await commitIfDirty(loop, porcelain, `Implement #${issueNumber}: ${liveJob.title}`);
      throwIfAborted(opts.abortSignal);
      if (await tipTracksEngineScratch(loop.runConfiguredGit, { cwd: loop.worktree, env: loop.env })) {
        const reason = engineScratchTrackedReason(branch);
        await diary(reason);
        await loop.stopHeartbeat();
        await loop.stampTerminalClaim(opts.api);
        await loop.detachWorktree();
        return { status: "skipped", reason };
      }
      await pushClaimedBranch(loop, branch);
      throwIfAborted(opts.abortSignal);

      const pr = await opts.api.createPullRequest(owner, repo, {
        title: liveJob.title,
        body: wrapJumiPrBody(buildPullRequestBody(issueNumber, prFileContents, runner, [loop.auth.token])),
        head: branch,
        base: opts.job.defaultBranch,
      });
      await diary(`Opened ${pr.html_url}`);
      await loop.stopHeartbeat();
      await loop.forgetSerialized();
      await loop.detachWorktree();
      return { status: "pr", htmlUrl: pr.html_url, prNumber: pr.number };
    },
    async (err) => {
      runner = thrownRunner(err) ?? runner;
      if (isQuotaError(err)) {
        throwIfQuotaWait({
          err,
          model: opts.model,
          fallbackModel: opts.fallbackModel,
          chain: opts.chain,
          previousError: opts.previousError,
        });
        await diary(QUOTA_STUCK_TEXT).catch(() => undefined);
        await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
        await loop.stopHeartbeat();
        await loop.forgetSerialized().catch(() => undefined);
        await loop.detachWorktree();
        return;
      }
      await diary(
        redactGitSecrets(`Jumi failed: ${err instanceof Error ? err.message : String(err)}`, [loop.auth.token])
      ).catch(() => undefined);
      const errorHash = fingerprintError(err instanceof Error ? err.message : String(err));
      if (errorHash) {
        await appendStuckLatchFingerprint(latches, latchKey, { kind: "error", hash: errorHash }, now).catch(
          () => undefined
        );
      }
      await loop.stopHeartbeat();
      await loop.stampTerminalClaim(opts.api).catch(() => undefined);
      await loop.detachWorktree();
    }
  );
}

export async function cancelIssueWork(opts: {
  api: IssueApi;
  owner: string;
  repo: string;
  issueNumber: number;
  botUsername: string;
  home: string;
  pidAlive?: (pid: number) => boolean;
  killPid?: (pid: number) => void;
}): Promise<void> {
  const claimPath = claimFilePath(opts.home, opts.owner, opts.repo, opts.issueNumber);
  const claim = await readClaim(claimPath);
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const killPid = opts.killPid ?? ((pid: number) => process.kill(pid));
  if (claim && claim.pid > 0 && claim.pid !== process.pid && pidAlive(claim.pid)) {
    try {
      killPid(claim.pid);
    } catch {
      // Child may have already exited.
    }
  }
  await upsertWorkerComment(opts.api, opts.owner, opts.repo, opts.issueNumber, opts.botUsername, "stopped");
  await deleteClaim(claimPath);
}
