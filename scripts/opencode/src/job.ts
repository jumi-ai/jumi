import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, type ServiceConfig, scrubSecretEnv } from "./config.ts";
import { createForge } from "./forge.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { refuseXaiOAuth } from "./job_requirements.ts";
import { ensureOpenCodeWellKnownAuth } from "./opencode_auth.ts";
import type { ReviewApi } from "./review.ts";
import {
  type JobKind,
  openPgReviewJobStoreForJob,
  type ReviewJobRecord,
  type ReviewJobStore,
  type RoleGateRole,
} from "./review_jobs.ts";
import { patchActiveRunUsageTiming } from "./run_usage.ts";
import { orderedRunners } from "./runners.ts";
import { processEngineTick, type RunReviewJobExtras } from "./server.ts";
import { installProcessShutdown, trackInFlightLease } from "./shutdown.ts";
import { processWorkerTick, type RunWorkerJobExtras } from "./worker.ts";
import type { WorkerConfig } from "./worker_config.ts";
import { loadWorkerConfig } from "./worker_config.ts";
import type { checkoutPullRequestWorkspace } from "./workspace.ts";

export const JOB_ID_ENV = "JUMI_JOB_ID";

export function parseJobId(value: string | undefined): number {
  const raw = (value ?? "").trim();
  if (!raw) throw new Error(`Missing required environment variable: ${JOB_ID_ENV}`);
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid ${JOB_ID_ENV}: ${raw}`);
  return id;
}

function roleForKind(kind: JobKind): RoleGateRole {
  return kind === "review" ? "engine" : "worker";
}

function oneShotLeasedBy(role: RoleGateRole): string {
  return `job-${role}-${process.pid}-${crypto.randomUUID()}`;
}

function proxyStoreForOneShot(
  real: ReviewJobStore,
  jobId: number,
  kind: JobKind,
  lastReason: { reason?: string }
): ReviewJobStore {
  const customLease = async (
    leasedBy: string,
    leaseMs: number,
    now = new Date(),
    kinds?: readonly JobKind[]
  ): Promise<ReviewJobRecord | undefined> => {
    if (kinds && kinds.length > 0 && !kinds.includes(kind)) {
      lastReason.reason = `row ${jobId} kind ${kind} not in requested kinds`;
      return undefined;
    }
    const res = await real.leaseJobById(jobId, leasedBy, leaseMs, now);
    if (res.leased) return res.row;
    lastReason.reason = res.reason;
    return undefined;
  };
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "lease") return customLease;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReviewJobStore;
}

export interface OneShotRunOptions {
  store: ReviewJobStore;
  jobId: number;
  engineConfig: ServiceConfig;
  workerConfig: WorkerConfig;
  api: ReviewApi & IssueApi;
  logger?: (message: string) => void;
  abortSignal?: AbortSignal;
  leasedBy?: string;
  engineExtras?: RunReviewJobExtras;
  workerExtras?: RunWorkerJobExtras;
  fetchImpl?: typeof fetch;
}

export interface OneShotResult {
  exitCode: 0 | 1 | 2;
  reason: string;
}

function logDefault(message: string) {
  console.log(`[job] ${message}`);
}

/**
 * Full-clone checkout for one-shot reviews: no `_review-mirrors` cache, no
 * `--reference`. Every job pod starts empty, so the clone is the full history.
 * Times the clone for the per-run ledger data.
 */
export async function oneShotWorkspacePreparer(
  opts: {
    workdir: string;
    repo: { owner: { login: string }; name: string; full_name: string; clone_url: string };
    pr: { number: number; head: { sha: string; ref: string }; base: { sha: string; ref: string } };
    giteaUrl: string;
    username: string;
    token: string;
    logger?: (message: string) => void;
  },
  timing: { cloneSeconds?: number }
): Promise<void> {
  const start = Date.now();
  const workspace = await import("./workspace.ts");
  const configArgs = workspace.gitConfigArgs();
  const auth = { giteaUrl: opts.giteaUrl, username: opts.username, token: opts.token };
  const env = workspace.gitEnv(auth);
  const runConfiguredGit = (args: string[], runOpts: { cwd: string; env: Record<string, string | undefined> }) =>
    workspace.runGit([...configArgs, ...args], runOpts);
  const cloneUrl = workspace.validateCloneUrl(opts.repo.clone_url, opts.giteaUrl);
  const parent = dirname(opts.workdir);
  await mkdir(parent, { recursive: true });
  await rm(opts.workdir, { recursive: true, force: true });
  opts.logger?.(`Cloning ${opts.repo.full_name} (one-shot full clone)`);
  await runConfiguredGit(["clone", workspace.gitRemoteUrl(cloneUrl, auth), opts.workdir], { cwd: parent, env });
  await runConfiguredGit(
    ["fetch", "origin", `+refs/heads/${opts.pr.base.ref}:refs/remotes/origin/${opts.pr.base.ref}`],
    {
      cwd: opts.workdir,
      env,
    }
  );
  await runConfiguredGit(["branch", "--force", "jumi/target", opts.pr.base.sha], { cwd: opts.workdir, env });
  try {
    await runConfiguredGit(
      ["fetch", "origin", `+refs/pull/${opts.pr.number}/head:refs/remotes/origin/pr/${opts.pr.number}/head`],
      {
        cwd: opts.workdir,
        env,
      }
    );
  } catch {
    await runConfiguredGit(
      ["fetch", "origin", `+refs/heads/${opts.pr.head.ref}:refs/remotes/origin/${opts.pr.head.ref}`],
      {
        cwd: opts.workdir,
        env,
      }
    );
  }
  await runConfiguredGit(["checkout", "--force", "-B", `jumi/pr-${opts.pr.number}`, opts.pr.head.sha], {
    cwd: opts.workdir,
    env,
  });
  timing.cloneSeconds = (Date.now() - start) / 1000;
  patchActiveRunUsageTiming({ cloneSeconds: timing.cloneSeconds });
  opts.logger?.(`one-shot clone took ${timing.cloneSeconds.toFixed(2)}s`);
}

export async function runOneShotJob(options: OneShotRunOptions): Promise<OneShotResult> {
  const log = options.logger ?? logDefault;
  let row: ReviewJobRecord | undefined;
  try {
    row = await options.store.get(options.jobId);
  } catch (err) {
    log(`ledger unreachable getting row ${options.jobId}: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, reason: "ledger unreachable" };
  }
  if (!row) {
    log(`row ${options.jobId} not found, exiting 0`);
    return { exitCode: 0, reason: "row not found" };
  }
  const kind = row.kind;
  const role = roleForKind(kind);
  const config = kind === "review" ? options.engineConfig : options.workerConfig;
  const chain = orderedRunners(config);
  const opencodeConfigPath = (config as { opencodeConfig?: string }).opencodeConfig;
  const wellKnownUrl = (config as { opencodeWellKnownUrl?: string }).opencodeWellKnownUrl;
  const refusal = await refuseXaiOAuth({
    chain,
    independentReview: (config as { independentReview?: import("./runners.ts").IndependentReviewConfig })
      .independentReview,
    opencodeConfigPath,
    wellKnownUrl,
    fetchImpl: options.fetchImpl,
    logger: log,
  });
  if (refusal.refused) {
    log(refusal.reason ?? "xAI OAuth refused");
    return { exitCode: 2, reason: refusal.reason ?? "xAI OAuth refused" };
  }

  const leasedBy = options.leasedBy ?? oneShotLeasedBy(role);
  const lastReason: { reason?: string } = {};
  const proxy = proxyStoreForOneShot(options.store, options.jobId, kind, lastReason);

  if (kind === "review") {
    const timing: { cloneSeconds?: number } = {};
    const wrappedPreparer = async (preparerOpts: Parameters<typeof checkoutPullRequestWorkspace>[0]) => {
      if (options.engineExtras?.workspacePreparer) {
        const start = Date.now();
        await options.engineExtras.workspacePreparer(preparerOpts);
        timing.cloneSeconds = (Date.now() - start) / 1000;
        patchActiveRunUsageTiming({ cloneSeconds: timing.cloneSeconds });
        return;
      }
      await oneShotWorkspacePreparer(
        {
          workdir: preparerOpts.workdir,
          repo: preparerOpts.repo,
          pr: preparerOpts.pr,
          giteaUrl: preparerOpts.giteaUrl,
          username: preparerOpts.username,
          token: preparerOpts.token,
          logger: preparerOpts.logger,
        },
        timing
      );
    };
    try {
      const result = await processEngineTick(
        proxy,
        options.engineConfig,
        options.api,
        leasedBy,
        {
          ...options.engineExtras,
          abortSignal: options.abortSignal ?? options.engineExtras?.abortSignal,
          workspacePreparer: wrappedPreparer,
        },
        log
      );
      if (result === "idle") {
        log(lastReason.reason ?? "row could not be leased, exiting 0");
        return { exitCode: 0, reason: lastReason.reason ?? "idle" };
      }
      return { exitCode: 0, reason: "processed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`one-shot review failed: ${message}`);
      return { exitCode: 1, reason: message };
    }
  }

  try {
    const { standingPodRuntime } = await import("./runtime.ts");
    const realRuntime = options.workerExtras?.runtime ?? standingPodRuntime;
    const wrappedRuntime = {
      ...realRuntime,
      ensureBareCache: async (loop: never, ensureOpts: never) => {
        // One-shot pods start empty: no shared bare cache is added. The local
        // cache (if any) lives in this pod's emptyDir only. Time it for the
        // per-run data even though it starts empty.
        const start = Date.now();
        await (realRuntime.ensureBareCache as (l: never, o: never) => Promise<void>)(loop, ensureOpts);
        patchActiveRunUsageTiming({ cloneSeconds: (Date.now() - start) / 1000 });
      },
      attachIssueWorktree: async (loop: never, attachOpts: never) => {
        const start = Date.now();
        try {
          return await (realRuntime.attachIssueWorktree as unknown as (l: never, o: never) => Promise<never>)(
            loop,
            attachOpts
          );
        } finally {
          patchActiveRunUsageTiming({ cloneSeconds: (Date.now() - start) / 1000 });
        }
      },
    };
    const result = await processWorkerTick(
      proxy,
      options.workerConfig,
      options.api,
      leasedBy,
      {
        ...options.workerExtras,
        abortSignal: options.abortSignal ?? options.workerExtras?.abortSignal,
        runtime: wrappedRuntime as never,
      },
      log
    );
    if (result === "idle") {
      log(lastReason.reason ?? "row could not be leased, exiting 0");
      return { exitCode: 0, reason: lastReason.reason ?? "idle" };
    }
    return { exitCode: 0, reason: "processed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`one-shot worker failed: ${message}`);
    return { exitCode: 1, reason: message };
  }
}

async function main(): Promise<void> {
  const logger = (message: string) => console.log(`[job] ${message}`);
  let jobId: number;
  let databaseUrl: string;
  try {
    jobId = parseJobId(process.env[JOB_ID_ENV]);
    databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");
  } catch (err) {
    console.error(`[job] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  scrubSecretEnv();
  const shutdown = new AbortController();
  installProcessShutdown(shutdown, logger);

  let store: ReviewJobStore;
  try {
    store = await openPgReviewJobStoreForJob(databaseUrl!);
  } catch (err) {
    console.error(`[job] ledger unreachable: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // No HTTP, no probes, no reclaim, no migration (job-mode opener above never
  // migrates). No xAI grant adoption or file sibling cleanup: HOME is empty.
  // Long-running mode stays as it is.
  let engineConfig: ServiceConfig;
  let workerConfig: WorkerConfig;
  try {
    engineConfig = loadConfig({ ...process.env, JUMI_ROLE: "engine" });
    workerConfig = loadWorkerConfig();
  } catch (err) {
    console.error(`[job] bad config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    await ensureOpenCodeWellKnownAuth({
      home: engineConfig.home,
      url: engineConfig.opencodeWellKnownUrl,
      key: engineConfig.opencodeWellKnownKey,
      token: engineConfig.opencodeWellKnownToken,
      logger,
    });
  } catch (err) {
    console.error(`[job] well-known auth failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const api = createForge(engineConfig);
  const abort = new AbortController();
  const onShutdownAbort = () => abort.abort();
  if (shutdown.signal.aborted) onShutdownAbort();
  else shutdown.signal.addEventListener("abort", onShutdownAbort, { once: true });

  // Ordered shutdown for the one-shot pod: abort, wait for the child to stop,
  // then release the lease (the tick owns the release after its await), then
  // exit 0 so the Job does not look dead. The shared `installProcessShutdown`
  // above only aborts; the wait+release happen inside the tick.
  const untrack = trackInFlightLease(
    async () => {
      // Safety net only: the tick already released after its awaited child.
    },
    { abort: onShutdownAbort, wait: async () => undefined }
  );

  let result: OneShotResult;
  try {
    result = await runOneShotJob({
      store,
      jobId: jobId!,
      engineConfig,
      workerConfig,
      api: api as unknown as ReviewApi & IssueApi,
      logger,
      abortSignal: abort.signal,
    });
  } catch (err) {
    console.error(`[job] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    untrack();
  }

  if (result.exitCode === 0) {
    logger(`${result.reason}`);
    process.exit(0);
  }
  console.error(`[job] ${result.reason}`);
  process.exit(result.exitCode);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[job] Fatal error:", err);
    process.exit(1);
  });
}
