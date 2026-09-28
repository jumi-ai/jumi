import { access, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildCiMarkdown, CI_LOG_FILE, inspectCi } from "./ci.ts";
import { conflictStatePath } from "./claim.ts";
import {
  beginClaimedWorktree,
  commitIfDirty,
  ENGINE_TEMP_DIR,
  inspectRemoteContainsDefault,
  isClaimedEarlyResult,
  openClaimedLoop,
  pushClaimedBranch,
  recheckAssignedAndOpen,
  removeTree,
  runClaimedLoop,
  STAGE_ALL_ARGS,
  skipClaimedWork,
  stripSentinels,
  throwIfAborted,
  withoutEngineTempPorcelain,
  worktreePorcelain,
} from "./claimed_worktree.ts";
import { type EngineRunOptions, runEngineStamped, throwIfEngineFailed, thrownRunner } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import { FORGE_COMMITTER_EMAIL, FORGE_COMMITTER_NAME } from "./forge.ts";
import { isEligibleWorkerPR, resolveWorkerPullRequest, upsertWorkerComment } from "./gitea_issues.ts";
import { buildTaskMarkdown, type HelmRunner, type ImplementOptions, type OpenCodeRunner } from "./implement.ts";
import { gateShipAfterOpenCode, jobWithIssue, type ShipGate, snapshotFromJob } from "./issue_recheck.ts";
import type { Pull } from "./ports.ts";
import { isQuotaError, isQuotaText, QUOTA_STUCK_TEXT } from "./quota.ts";
import { throwIfQuotaWait } from "./quota_wait.ts";
import { appendRunnerStamp, type RunnerStamp } from "./runners.ts";
import { standingPodRuntime } from "./runtime.ts";
import { type SkipLatchKey, type SkipLatchStore, skipLatchesFor, skipLatchStoreFromPath } from "./skip_latches.ts";
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
import { type GitRunner, redactGitSecrets, workerOpenCodeChildEnv } from "./workspace.ts";

export { CONFLICT_PROMPT } from "./git.ts";

export const CONFLICT_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_CONFLICT_ROUNDS = 3;

const GENERATED_LOCKS = new Set(["Chart.lock", "requirements.lock"]);

export type ConflictResult =
  | { status: "pushed"; prNumber: number; htmlUrl: string }
  | { status: "up-to-date" }
  | { status: "stuck" }
  | { status: "skipped"; reason: string }
  | { status: "cancelled" };

export interface ConflictState {
  prNumber: number;
  round: number;
  lastHeadSha: string;
  lastBaseSha: string;
  updatedAt: string;
}

export type MergeDefaultStatus = "up-to-date" | "merged" | "stuck";

export interface MergeDefaultResult {
  status: MergeDefaultStatus;
  headSha: string;
  baseSha: string;
  openCodeRan: boolean;
  conflicted: boolean;
  /** Set when a runner resolved the conflict; the one that actually ran. */
  runner?: RunnerStamp;
}

export interface MergeDefaultIntoWorktreeOpts {
  git: GitRunner;
  env: Record<string, string | undefined>;
  worktree: string;
  defaultBranch: string;
  headRef: string;
  job: IssueJob;
  pr: Pull;
  model: string;
  variant?: string;
  home: string;
  sanitizeOpenCodeEnv?: boolean;
  extraEnv: Record<string, string>;
  maxOutputBytes?: number;
  timeoutMs?: number;
  openCodeRunner: OpenCodeRunner;
  helmRunner?: HelmRunner;
  logger?: (message: string) => void;
  abortSignal?: AbortSignal;
  onPid?: (pid: number) => void | Promise<void>;
  ciMarkdown?: string;
  jobId?: string;
  skipCleanMerge?: boolean;
  /** Called with the runner that ran, before any engine failure is thrown. */
  onRunner?: (runner: RunnerStamp) => void;
}

function logDefault(message: string) {
  console.log(`[conflict] ${message}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function emptyConflictState(): ConflictState {
  return { prNumber: 0, round: 0, lastHeadSha: "", lastBaseSha: "", updatedAt: "" };
}

export { conflictStatePath };

export function parseConflictState(parsed: unknown): ConflictState {
  if (!parsed || typeof parsed !== "object") return emptyConflictState();
  const state = parsed as ConflictState;
  return {
    prNumber: typeof state.prNumber === "number" ? state.prNumber : 0,
    round: typeof state.round === "number" ? state.round : 0,
    lastHeadSha: typeof state.lastHeadSha === "string" ? state.lastHeadSha : "",
    lastBaseSha: typeof state.lastBaseSha === "string" ? state.lastBaseSha : "",
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
  };
}

export async function readConflictLatch(store: SkipLatchStore, key: SkipLatchKey): Promise<ConflictState> {
  return parseConflictState((await store.get(key)).conflict);
}

export async function writeConflictLatch(
  store: SkipLatchStore,
  key: SkipLatchKey,
  state: ConflictState
): Promise<void> {
  await store.put(key, { conflict: state });
}

export async function readConflictState(path: string): Promise<ConflictState> {
  const latch = skipLatchStoreFromPath(path);
  if (!latch) return emptyConflictState();
  return readConflictLatch(latch.store, latch.key);
}

export async function writeConflictState(path: string, state: ConflictState): Promise<void> {
  const latch = skipLatchStoreFromPath(path);
  if (!latch) return;
  await writeConflictLatch(latch.store, latch.key, state);
}

export async function needsConflict(opts: {
  pr: Pull;
  owner: string;
  repo: string;
  issueNumber: number;
  botUsername: string;
  home: string;
  maxConflictRounds?: number;
  skipLatches?: SkipLatchStore;
}): Promise<boolean> {
  if (!isEligibleWorkerPR(opts.pr, opts.owner, opts.repo)) return false;
  if (opts.pr.mergeable !== false) return false;
  const state = await readConflictLatch(skipLatchesFor(opts), {
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: opts.issueNumber,
  });
  if (state.round >= (opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS)) return false;
  if (
    state.lastHeadSha &&
    state.lastBaseSha &&
    state.lastHeadSha === opts.pr.head.sha &&
    state.lastBaseSha === opts.pr.base.sha
  ) {
    return false;
  }
  return true;
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function gitLines(
  git: GitRunner,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> }
): Promise<string[]> {
  try {
    return splitLines(await git(args, opts));
  } catch {
    return [];
  }
}

async function unmergedPaths(
  git: GitRunner,
  worktree: string,
  env: Record<string, string | undefined>
): Promise<string[]> {
  return gitLines(git, ["diff", "--name-only", "--diff-filter=U"], { cwd: worktree, env });
}

async function markerPaths(
  git: GitRunner,
  worktree: string,
  env: Record<string, string | undefined>
): Promise<string[]> {
  return gitLines(git, ["grep", "-l", "^<<<<<<<"], { cwd: worktree, env });
}

function isGeneratedLock(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return GENERATED_LOCKS.has(base);
}

async function runHelm(args: string[], opts: { cwd: string }): Promise<string> {
  const proc = Bun.spawn(["helm", ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`helm ${args.join(" ")} failed with exit code ${exitCode}${details ? `:\n${details}` : ""}`);
  }
  return stdout.trim();
}

function helmAvailable(injected?: HelmRunner): boolean {
  if (injected) return true;
  return typeof Bun.which === "function" && Boolean(Bun.which("helm"));
}

async function regenerateLock(
  git: GitRunner,
  env: Record<string, string | undefined>,
  worktree: string,
  lockPath: string,
  helm: HelmRunner | undefined
): Promise<void> {
  const absLock = join(worktree, lockPath);
  await rm(absLock, { force: true });
  const chartDirRel = dirname(lockPath);
  const chartDir = join(worktree, chartDirRel);
  if (!(await pathExists(join(chartDir, "Chart.yaml"))) || !helmAvailable(helm)) return;
  const runner = helm ?? runHelm;
  await runner(["dependency", "update"], { cwd: chartDir });
  if (await pathExists(absLock)) {
    await git(["add", "--", lockPath], { cwd: worktree, env }).catch(() => undefined);
  }
  const vendorRel = join(chartDirRel, "charts");
  await git(["add", "-u", "--", vendorRel], { cwd: worktree, env }).catch(() => undefined);
}

async function buildConflictMarkdown(opts: {
  git: GitRunner;
  env: Record<string, string | undefined>;
  worktree: string;
  pr: Pull;
  headSha: string;
  headRef: string;
  defaultBranch: string;
  baseSha: string;
  conflicted: string[];
}): Promise<string> {
  let diff = "";
  try {
    diff = await opts.git(["diff"], { cwd: opts.worktree, env: opts.env });
  } catch {
    diff = "";
  }
  return [
    `# Merge conflict`,
    ``,
    `PR: ${opts.pr.html_url}`,
    `Number: ${opts.pr.number}`,
    `Head SHA: ${opts.headSha}`,
    `Head ref: ${opts.headRef}`,
    `Default branch: ${opts.defaultBranch}`,
    `Default SHA: ${opts.baseSha}`,
    ``,
    `## Conflicted paths`,
    ``,
    ...opts.conflicted.map((path) => `- ${path}`),
    ``,
    `## Diff`,
    ``,
    "```",
    diff,
    "```",
    ``,
  ].join("\n");
}

async function gitOk(
  git: GitRunner,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> }
): Promise<boolean> {
  try {
    await git(args, opts);
    return true;
  } catch {
    return false;
  }
}

async function commitMerge(
  git: GitRunner,
  env: Record<string, string | undefined>,
  worktree: string,
  defaultBranch: string,
  headRef: string
): Promise<void> {
  const commitEnv = {
    ...env,
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? FORGE_COMMITTER_NAME,
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? FORGE_COMMITTER_EMAIL,
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME ?? FORGE_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL ?? FORGE_COMMITTER_EMAIL,
  };
  await git(["commit", "-m", `Merge ${defaultBranch} into ${headRef}`], { cwd: worktree, env: commitEnv });
}

async function commitMergeIfNeeded(
  git: GitRunner,
  env: Record<string, string | undefined>,
  worktree: string,
  defaultBranch: string,
  headRef: string
): Promise<void> {
  const originDefault = `origin/${defaultBranch}`;
  const mergeInProgress = await gitOk(git, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: worktree, env });
  const dirty = Boolean(withoutEngineTempPorcelain(await git(["status", "--porcelain"], { cwd: worktree, env })));
  if (mergeInProgress || dirty) {
    try {
      await commitMerge(git, env, worktree, defaultBranch, headRef);
    } catch (err) {
      if (await gitOk(git, ["merge-base", "--is-ancestor", originDefault, "HEAD"], { cwd: worktree, env })) {
        return;
      }
      throw err;
    }
    return;
  }
  if (await gitOk(git, ["merge-base", "--is-ancestor", originDefault, "HEAD"], { cwd: worktree, env })) {
    return;
  }
  throw new Error(`merge of ${defaultBranch} into ${headRef} did not complete`);
}

export async function mergeDefaultIntoWorktree(opts: MergeDefaultIntoWorktreeOpts): Promise<MergeDefaultResult> {
  const log = opts.logger ?? logDefault;
  const git = opts.git;
  const { worktree, env, defaultBranch, headRef } = opts;
  const originDefault = `origin/${defaultBranch}`;

  throwIfAborted(opts.abortSignal);
  await git(["fetch", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], {
    cwd: worktree,
    env,
  });
  await git(["fetch", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`], {
    cwd: worktree,
    env,
  }).catch(() => undefined);

  const headSha = (await git(["rev-parse", "HEAD"], { cwd: worktree, env })).trim();
  const baseSha = (await git(["rev-parse", originDefault], { cwd: worktree, env })).trim();

  try {
    await git(["merge-base", "--is-ancestor", originDefault, "HEAD"], { cwd: worktree, env });
    return { status: "up-to-date", headSha, baseSha, openCodeRan: false, conflicted: false };
  } catch {
    // Default is not an ancestor; merge.
  }

  throwIfAborted(opts.abortSignal);
  let conflicted = false;
  try {
    await git(["merge", "--no-ff", "--no-commit", originDefault], { cwd: worktree, env });
  } catch (err) {
    const unmerged = await unmergedPaths(git, worktree, env);
    if (unmerged.length === 0) throw err;
    conflicted = true;
    try {
      for (const path of unmerged) {
        if (!isGeneratedLock(path)) continue;
        await regenerateLock(git, env, worktree, path, opts.helmRunner);
      }
    } catch (regenErr) {
      log(`Failed to regenerate generated lock: ${regenErr instanceof Error ? regenErr.message : String(regenErr)}`);
      return { status: "stuck", headSha, baseSha, openCodeRan: false, conflicted: true };
    }
  }

  let remaining = [
    ...new Set([...(await unmergedPaths(git, worktree, env)), ...(await markerPaths(git, worktree, env))]),
  ];
  const leftoverLocks = remaining.filter(isGeneratedLock);
  remaining = remaining.filter((path) => !isGeneratedLock(path));
  let openCodeRan = false;
  let runner: RunnerStamp | undefined;
  if (leftoverLocks.length > 0) {
    return { status: "stuck", headSha, baseSha, openCodeRan: false, conflicted: true };
  }
  if (opts.skipCleanMerge && remaining.length === 0 && !conflicted) {
    if (await gitOk(git, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: worktree, env })) {
      await git(["merge", "--abort"], { cwd: worktree, env }).catch(() => undefined);
    }
    return { status: "up-to-date", headSha, baseSha, openCodeRan: false, conflicted: false };
  }
  if (remaining.length > 0) {
    throwIfAborted(opts.abortSignal);
    await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(opts.job));
    await writeFile(
      join(worktree, "JUMI_CONFLICT.md"),
      await buildConflictMarkdown({
        git,
        env,
        worktree,
        pr: opts.pr,
        headSha,
        headRef,
        defaultBranch,
        baseSha,
        conflicted: remaining,
      })
    );
    if (opts.ciMarkdown) await writeFile(join(worktree, CI_LOG_FILE), opts.ciMarkdown);
    log(`Running OpenCode conflict resolution for ${opts.job.owner}/${opts.job.repo}#${opts.job.issueNumber}`);
    openCodeRan = true;
    const runOpts: EngineRunOptions = {
      model: opts.model,
      variant: opts.variant,
      workdir: worktree,
      home: opts.home,
      sanitizeEnv: opts.sanitizeOpenCodeEnv ?? true,
      extraEnv: opts.extraEnv,
      timeoutMs: opts.timeoutMs ?? CONFLICT_TIMEOUT_MS,
      maxOutputBytes: opts.maxOutputBytes,
      reviewLabel: `${opts.job.owner}/${opts.job.repo}#${opts.job.issueNumber}`,
      trace: {
        kind: "conflict",
        owner: opts.job.owner,
        repo: opts.job.repo,
        sha: headSha,
        jobId: opts.jobId ?? opts.job.delivery,
      },
      logger: log,
      abortSignal: opts.abortSignal,
      onPid: opts.onPid,
    };
    const engineResult = await runEngineStamped(opts.openCodeRunner, runOpts, (r) => {
      runner = r;
      opts.onRunner?.(r);
    });
    throwIfEngineFailed(engineResult);
    await rm(join(worktree, "JUMI_TASK.md"), { force: true });
    await rm(join(worktree, "JUMI_CONFLICT.md"), { force: true });
    await rm(join(worktree, CI_LOG_FILE), { force: true });
    await removeTree(join(worktree, ENGINE_TEMP_DIR)).catch(() => undefined);
    await git([...STAGE_ALL_ARGS], { cwd: worktree, env }).catch(() => undefined);
    remaining = await markerPaths(git, worktree, env);
    if (remaining.length > 0) {
      return { status: "stuck", headSha, baseSha, openCodeRan, conflicted: true, runner };
    }
  }

  throwIfAborted(opts.abortSignal);
  if (conflicted || openCodeRan) {
    await git([...STAGE_ALL_ARGS], { cwd: worktree, env }).catch(() => undefined);
  }
  await commitMergeIfNeeded(git, env, worktree, defaultBranch, headRef);
  return { status: "merged", headSha, baseSha, openCodeRan, conflicted, ...(runner ? { runner } : {}) };
}

export function shouldIncrementRound(result: MergeDefaultResult): boolean {
  return result.openCodeRan || result.conflicted || result.status === "stuck";
}

export async function implementConflict(opts: ImplementOptions): Promise<ConflictResult> {
  const log = opts.logger ?? logDefault;
  const maxConflictRounds = opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS;
  const timeoutMs = opts.timeoutMs ?? CONFLICT_TIMEOUT_MS;
  const claimed = await beginClaimedWorktree({
    ...opts,
    fallbackEngine: registeredEngine,
    forgetTerminal: true,
  });
  if (isClaimedEarlyResult(claimed)) return claimed;
  const { owner, repo, issueNumber, worktree, sanitizeEnv, engine, now, forgetClaim, claim } = claimed;
  const latches = skipLatchesFor(opts);
  const latchKey = { owner, repo, issueNumber };

  // The runner behind the latest spawn; after a hop this is the one that ran.
  let runner: RunnerStamp | undefined;
  const sticky = (body: string, index: number) =>
    upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, appendRunnerStamp(body, runner), {
      index,
    });

  const assigned = await recheckAssignedAndOpen(claimed, opts);
  if (assigned) return assigned;

  const pr = await resolveWorkerPullRequest(opts.api, owner, repo, issueNumber, opts.botUsername, opts.job.prNumber);
  if (!pr || !isEligibleWorkerPR(pr, owner, repo)) {
    await forgetClaim();
    return { status: "skipped", reason: "no open jumi closing PR" };
  }

  const branch = pr.head.ref;
  claim.branch = branch;
  if (!branch || branch === opts.job.defaultBranch) {
    await forgetClaim();
    return { status: "skipped", reason: "refusing to merge on the default branch" };
  }

  const state = await readConflictLatch(latches, latchKey);
  if (state.round >= maxConflictRounds) {
    await sticky("stuck: cannot resolve conflicts", pr.number);
    await forgetClaim();
    return { status: "stuck" };
  }
  const stuckState = await readStuckLatch(latches, latchKey);
  if (isQuotaStuck(stuckState)) {
    await sticky(QUOTA_STUCK_TEXT, pr.number);
    await forgetClaim();
    return { status: "stuck" };
  }
  const stuckReason = evaluateStuck(stuckState.fingerprints);
  if (stuckReason) {
    await sticky(stuckComment(stuckReason), pr.number);
    await forgetClaim();
    return { status: "stuck" };
  }

  const loop = openClaimedLoop(claimed, opts);

  const recordAttempt = async (headSha: string, baseSha: string, increment: boolean) => {
    await writeConflictLatch(latches, latchKey, {
      prNumber: pr.number,
      round: increment ? state.round + 1 : state.round,
      lastHeadSha: headSha,
      lastBaseSha: baseSha,
      updatedAt: now().toISOString(),
    });
  };

  let attemptedHeadSha = "";
  let attemptedBaseSha = "";
  let mergeDefaultThrew = false;

  return runClaimedLoop(
    loop,
    opts.abortSignal,
    async () => {
      const runtime = opts.runtime ?? standingPodRuntime;
      await runtime.ensureBareCache(loop, {
        cloneUrl: opts.job.cloneUrl,
        giteaUrl: opts.giteaUrl,
        abortSignal: opts.abortSignal,
        log,
      });
      const attached = await runtime.attachPrWorktree(loop, {
        branch,
        defaultBranch: opts.job.defaultBranch,
        abortSignal: opts.abortSignal,
        log,
      });
      if (isClaimedEarlyResult(attached)) return attached;
      const { headSha, baseSha } = attached;
      attemptedHeadSha = headSha;
      attemptedBaseSha = baseSha;
      await loop.stampHeadSha(headSha);

      if (state.lastHeadSha && state.lastBaseSha && state.lastHeadSha === headSha && state.lastBaseSha === baseSha) {
        return skipClaimedWork(loop, "same head and base already attempted");
      }

      const currentIssue = await opts.api.getIssue(owner, repo, issueNumber);
      const taskJob: IssueJob = {
        ...opts.job,
        title: currentIssue.title,
        body: currentIssue.body ?? "",
        htmlUrl: currentIssue.html_url,
      };
      let ciMarkdown: string | undefined;
      try {
        const ci = await inspectCi({
          api: opts.api,
          owner,
          repo,
          sha: pr.head.sha,
          home: opts.home,
          issueNumber,
          skipLatches: latches,
        });
        if (ci.failed.length) ciMarkdown = buildCiMarkdown({ sha: pr.head.sha, checks: ci.failed });
      } catch (err) {
        log(
          `CI inspect failed for ${owner}/${repo}#${issueNumber}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      let mergeResult: MergeDefaultResult;
      try {
        mergeResult = await mergeDefaultIntoWorktree({
          git: loop.runConfiguredGit,
          env: loop.env,
          worktree,
          defaultBranch: opts.job.defaultBranch,
          headRef: branch,
          skipCleanMerge: true,
          job: taskJob,
          pr,
          model: opts.model,
          variant: opts.variant,
          home: opts.home,
          sanitizeOpenCodeEnv: sanitizeEnv,
          extraEnv: workerOpenCodeChildEnv(loop.auth, worktree),
          maxOutputBytes: opts.maxOutputBytes,
          timeoutMs,
          openCodeRunner: engine,
          helmRunner: opts.helmRunner,
          logger: log,
          abortSignal: opts.abortSignal,
          ciMarkdown,
          jobId: opts.jobId ?? opts.job.delivery,
          onPid: loop.engineOnPid(opts.onPid),
          onRunner: (r) => {
            runner = r;
          },
        });
      } catch (err: unknown) {
        if (isQuotaError(err)) {
          throwIfQuotaWait({
            err,
            model: opts.model,
            fallbackModel: opts.fallbackModel,
            chain: opts.chain,
            previousError: opts.previousError,
          });
          await sticky(QUOTA_STUCK_TEXT, pr.number);
          await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
          await loop.stopHeartbeat();
          await loop.forgetSerialized().catch(() => undefined);
          await loop.detachWorktree();
          return { status: "stuck" };
        }
        mergeDefaultThrew = true;
        throw err;
      }

      runner = mergeResult.runner;
      if (mergeResult.status === "up-to-date") {
        await loop.stopHeartbeat();
        await loop.forgetSerialized();
        await loop.detachWorktree();
        return { status: "up-to-date" };
      }

      if (mergeResult.status === "stuck") {
        await sticky("stuck: cannot resolve conflicts", pr.number);
        await recordAttempt(mergeResult.headSha, mergeResult.baseSha, shouldIncrementRound(mergeResult));
        await loop.stopHeartbeat();
        await loop.forgetSerialized();
        await loop.detachWorktree();
        return { status: "stuck" };
      }

      let gate: ShipGate;
      try {
        gate = await gateShipAfterOpenCode({
          api: opts.api,
          owner,
          repo,
          issueNumber,
          botUsername: opts.botUsername,
          snapshot: snapshotFromJob(taskJob),
          closerPrNumber: pr.number,
          continueOpenCode: async (issue) => {
            throwIfAborted(opts.abortSignal);
            await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(jobWithIssue(taskJob, issue)));
            log(`Re-running OpenCode after issue change for ${owner}/${repo}#${issueNumber}`);
            const continuedOpts: EngineRunOptions = {
              model: opts.model,
              variant: opts.variant,
              workdir: worktree,
              home: opts.home,
              sanitizeEnv,
              extraEnv: workerOpenCodeChildEnv(loop.auth, worktree),
              timeoutMs,
              maxOutputBytes: opts.maxOutputBytes,
              reviewLabel: `${owner}/${repo}#${issueNumber}`,
              continueSession: true,
              trace: {
                kind: "follow-up",
                owner,
                repo,
                sha: mergeResult.headSha,
                jobId: opts.jobId ?? opts.job.delivery,
              },
              logger: log,
              abortSignal: opts.abortSignal,
              onPid: loop.engineOnPid(opts.onPid),
            };
            runner = undefined;
            const runtime = opts.runtime ?? standingPodRuntime;
            const continued = await runtime.runRuntimeEngine(loop, engine, continuedOpts, (r) => {
              runner = r;
            });
            // Gate on the message so a future non-quota `stuck` producer does
            // not set the human-clear quota flag.
            if (continued.status === "stuck" && isQuotaText(continued.message)) {
              throwIfQuotaWait({
                result: continued,
                model: opts.model,
                fallbackModel: opts.fallbackModel,
                chain: opts.chain,
                previousError: opts.previousError,
              });
              await sticky(QUOTA_STUCK_TEXT, pr.number);
              await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
              throw new Error(QUOTA_STUCK_TEXT);
            }
            throwIfEngineFailed(continued);
            await stripSentinels(worktree, ["JUMI_PR.md", "JUMI_TASK.md"]);
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
          await loop.stopHeartbeat();
          await loop.forgetSerialized().catch(() => undefined);
          await loop.detachWorktree();
          return { status: "stuck" };
        }
        throw err;
      }
      if (gate.action === "skip") {
        return skipClaimedWork(loop, gate.reason, { detach: !gate.keepLocalWork });
      }
      if (gate.continued) {
        await stripSentinels(worktree, ["JUMI_PR.md", "JUMI_TASK.md"]);
        await commitIfDirty(loop, await worktreePorcelain(loop), `Implement #${issueNumber}: ${gate.snapshot.title}`);
      }

      try {
        await pushClaimedBranch(loop, branch);
      } catch (err) {
        if (await inspectRemoteContainsDefault(loop, branch, opts.job.defaultBranch)) {
          return skipClaimedWork(loop, "remote already contains default");
        }
        throw err;
      }
      throwIfAborted(opts.abortSignal);

      await sticky(`Pushed merge of ${opts.job.defaultBranch}.`, pr.number);
      await recordAttempt(mergeResult.headSha, mergeResult.baseSha, shouldIncrementRound(mergeResult));
      await loop.stopHeartbeat();
      await loop.forgetSerialized();
      await loop.detachWorktree();
      return { status: "pushed", prNumber: pr.number, htmlUrl: pr.html_url };
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
        await sticky(QUOTA_STUCK_TEXT, pr.number).catch(() => undefined);
        await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
        await loop.stopHeartbeat();
        await loop.forgetSerialized().catch(() => undefined);
        await loop.detachWorktree();
        return;
      }
      await sticky(
        redactGitSecrets(`Jumi failed: ${err instanceof Error ? err.message : String(err)}`, [loop.auth.token]),
        pr.number
      ).catch(() => undefined);
      const errorHash = fingerprintError(err instanceof Error ? err.message : String(err));
      if (errorHash) {
        await appendStuckLatchFingerprint(latches, latchKey, { kind: "error", hash: errorHash }, now).catch(
          () => undefined
        );
      }
      if (mergeDefaultThrew && attemptedHeadSha && attemptedBaseSha) {
        await recordAttempt(attemptedHeadSha, attemptedBaseSha, true).catch(() => undefined);
      }
      await loop.stopHeartbeat();
      await loop.forgetSerialized().catch(() => undefined);
      await loop.detachWorktree();
    }
  );
}
