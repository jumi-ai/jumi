/**
 * Opt-in worker eval: run fixtures through the production implement path
 * with a fake forge and the real engine, then grade the outcome.
 *
 * Hermetic by construction:
 * - fixture repos live in `src/eval_fixtures/` (committed, synthetic);
 * - each run builds a local bare remote with real refs in an isolated temp dir;
 * - HOME is an isolated temp dir, the token is inert (`eval-inert-token`);
 * - the git runner maps only `https://eval.invalid` to the local bare and
 *   throws on any other host, so no network can be reached;
 * - the fake forge is in-memory (`src/forge_fake.ts`) and performs no fetch.
 *
 * Grades outcomes, never tool-call order: job result, published closing
 * keyword + remaining list, hidden checks run against the pushed commit the
 * agent never saw, and no `JUMI_*.md` in the pushed tree. Fixture, grader
 * and hidden checks are read from the base checkout before the run, never
 * from the branch under test. The eval case id never enters `JUMI_TASK.md`.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Engine, EngineFailedError } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import {
  type EvalHarness,
  ensureEvalRoots,
  evalImageDigest,
  evalPublicRepoVisibility,
  evalUsageOrNull,
  loadEvalLegacyRunners,
  loadEvalPiDeployment,
  parseEvalHarness,
  piAllowedHostsForRoute,
  resolveEvalPiRoute,
} from "./eval_harness.ts";
import { makeIssueApi } from "./forge_fake.ts";
import { closesIssuePattern, refsIssuePattern, visibleClosingText } from "./gitea_issues.ts";
import { implementIssue, jumiPrBodyRegion } from "./implement.ts";
import { buildPiAttemptStamp, normalizePiAttemptUsage } from "./pi_attempt.ts";
import { runPiHop } from "./pi_hop.ts";
import { createPiGoSessionDeps } from "./pi_runtime.ts";
import { runPiWorkerAttempt } from "./pi_worker.ts";
import type { IssueApi } from "./ports.ts";
import { isQuotaError, isQuotaText } from "./quota.ts";
import { formatRunnerStamp, type NamedRunner, runnerStamp } from "./runners.ts";
import { errorMessage } from "./util/error.ts";
import { WorkerResultStore } from "./worker_mcp.ts";
import { type GitRunner, runGit } from "./workspace.ts";

export const EVAL_INERT_HOST = "eval.invalid";
export const EVAL_GITEA_URL = "https://eval.invalid";
export const EVAL_TOKEN = "eval-inert-token";
export const EVAL_BOT_USERNAME = "jumi";

/** Deadline for each grading git subprocess; the owned group is killed on expiry. */
export const WORKER_EVAL_GRADING_GIT_TIMEOUT_MS = 30_000;
/** Deadline for the hidden check; expiry kills the process group and grades `fail`. */
export const WORKER_EVAL_HIDDEN_CHECK_TIMEOUT_MS = 60_000;
/** Grace between SIGTERM and SIGKILL when reaping a timed-out hidden check group. */
export const WORKER_EVAL_HIDDEN_CHECK_KILL_GRACE_MS = 2_000;

/** Minimal env for the hidden check and grading git: allowlist only, never the parent env. */
export function minimalWorkerEvalEnv(homeDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  env.HOME = homeDir;
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

function isSetsidOnPath(spawnPath: string | undefined): boolean {
  const pathValue = spawnPath ?? process.env.PATH ?? "";
  return pathValue.split(":").some((dir) => {
    if (!dir) return false;
    try {
      accessSync(`${dir}/setsid`, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

/** Grading git with the minimal env and a deadline; rejects on timeout or git failure. */
export async function runWorkerEvalGit(
  args: string[],
  cwd: string,
  homeDir: string,
  timeoutMs: number = WORKER_EVAL_GRADING_GIT_TIMEOUT_MS
): Promise<string> {
  const env = minimalWorkerEvalEnv(homeDir);
  const signal = AbortSignal.timeout(timeoutMs);
  // `runGit` with a signal spawns under `setsid` and kills the owned process
  // group on abort, so a hung helper cannot outlive the deadline.
  return (await runGit(args, { cwd, env, signal })).trim();
}

export interface WorkerHiddenCheckResult {
  code: number;
  output: string;
  timedOut: boolean;
}

/**
 * Run the hidden check with the minimal env and a deadline. On expiry the
 * whole process group gets SIGTERM (then SIGKILL after a grace) so a `sleep`
 * past the deadline dies and its pipes release; the caller grades the timeout
 * as `fail`. A spawn/startup failure throws for the caller to grade
 * `inconclusive` (verifier startup, never a model failure).
 */
export async function runWorkerHiddenCheck(
  scriptPath: string,
  workdir: string,
  homeDir: string,
  timeoutMs: number = WORKER_EVAL_HIDDEN_CHECK_TIMEOUT_MS
): Promise<WorkerHiddenCheckResult> {
  const env = minimalWorkerEvalEnv(homeDir);
  const useSetsid = isSetsidOnPath(env.PATH);
  const argv = useSetsid ? ["setsid", "sh", scriptPath, workdir] : ["sh", scriptPath, workdir];
  const proc = Bun.spawn(argv, {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  });
  const pgid = proc.pid;
  let timedOut = false;
  const killGroup = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      if (useSetsid) process.kill(-pgid, signal);
      else proc.kill(signal);
    } catch {
      // Already gone.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => {
      try {
        if (useSetsid && isGroupAlive(pgid)) process.kill(-pgid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, WORKER_EVAL_HIDDEN_CHECK_KILL_GRACE_MS).unref?.();
  }, timeoutMs);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      const output = `${out}\n${err}`.trim().slice(0, 4000) || `hidden check timed out after ${timeoutMs}ms`;
      return { code: 124, output, timedOut: true };
    }
    return { code, output: `${out}\n${err}`.trim().slice(0, 4000), timedOut: false };
  } finally {
    clearTimeout(timer);
    // Belt and suspenders: never leave the group behind.
    if (timedOut) {
      killGroup("SIGKILL");
      await proc.exited.catch(() => undefined);
    }
  }
}

export type WorkerEvalVerdict = "pass" | "fail" | "inconclusive";

export interface WorkerEvalRecord {
  fixture: string;
  harness: EvalHarness;
  runner: string;
  runnerStamp: string;
  trial: number;
  verdict: WorkerEvalVerdict;
  failedAssertions: string[];
  jobStatus: string;
  jobReason?: string;
  prNumber?: number | null;
  closingKeyword: "fixes" | "refs" | "none";
  remaining: string[];
  prBody: string;
  hiddenCheck: "pass" | "fail" | "skip";
  hiddenCheckOutput?: string;
  noSentinels: boolean;
  pushedSha?: string | null;
  baseSha: string;
  durationMs: number;
  usage: unknown;
  inconclusiveReason?: string;
  imageDigest: string | null;
  effectiveModel: string;
  route: string | null;
  payer: string | null;
  pool: string | null;
  outcome: string | null;
}

export interface WorkerEvalExpected {
  closingKeyword: "fixes" | "refs";
  minRemaining: number;
  /** Named unfinished items that must appear in the remaining-work list (case-insensitive substring). */
  remainingMustContain?: string[];
}

export interface LoadedWorkerEvalFixture {
  name: string;
  owner: string;
  repo: string;
  issueNumber: number;
  defaultBranch: string;
  title: string;
  body: string;
  hiddenCheck: string;
  dir: string;
  repoDir: string;
  expected?: WorkerEvalExpected;
}

function fixtureBaseDir(): string {
  return join(dirname(new URL(import.meta.url).pathname), "eval_fixtures");
}

export function parseWorkerEvalExpected(raw: unknown): WorkerEvalExpected | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as { closingKeyword?: unknown; minRemaining?: unknown; remainingMustContain?: unknown };
  if (record.closingKeyword !== "fixes" && record.closingKeyword !== "refs") return undefined;
  const minRemaining =
    typeof record.minRemaining === "number" && Number.isFinite(record.minRemaining) && record.minRemaining >= 0
      ? Math.floor(record.minRemaining)
      : 0;
  const remainingMustContain = Array.isArray(record.remainingMustContain)
    ? (record.remainingMustContain as unknown[])
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const expected: WorkerEvalExpected = { closingKeyword: record.closingKeyword, minRemaining };
  if (remainingMustContain.length > 0) expected.remainingMustContain = remainingMustContain;
  return expected;
}

export function workerEvalClosingFailures(
  closingKeyword: "fixes" | "refs" | "none",
  remaining: string[],
  expected?: WorkerEvalExpected
): string[] {
  if (!expected) {
    const failed: string[] = [];
    if (closingKeyword !== "fixes") failed.push("closing-keyword");
    if (remaining.length !== 0) failed.push("remaining-empty");
    return failed;
  }
  const failed: string[] = [];
  if (closingKeyword !== expected.closingKeyword) failed.push("closing-keyword");
  if (expected.minRemaining > 0 ? remaining.length < expected.minRemaining : remaining.length !== 0) {
    failed.push("remaining-empty");
  }
  // A bare count is not enough: the named unfinished item must show up in the
  // remaining-work list, so unrelated filler text still fails.
  const required = expected.remainingMustContain ?? [];
  if (required.length > 0) {
    const haystack = remaining.join("\n").toLowerCase();
    const missing = required.some((token) => !haystack.includes(token.toLowerCase()));
    if (missing && !failed.includes("remaining-empty")) failed.push("remaining-empty");
  }
  return failed;
}

export async function loadWorkerEvalFixture(name: string, baseDir?: string): Promise<LoadedWorkerEvalFixture> {
  const root = baseDir ?? fixtureBaseDir();
  const dir = join(root, name);
  const fixtureRaw = await readFile(join(dir, "fixture.json"), "utf8");
  const fixture = JSON.parse(fixtureRaw) as {
    name: string;
    owner: string;
    repo: string;
    issueNumber: number;
    defaultBranch: string;
    expected?: unknown;
  };
  const issueRaw = await readFile(join(dir, "issue.json"), "utf8");
  const issue = JSON.parse(issueRaw) as { title: string; body: string };
  const hiddenCheck = await readFile(join(dir, "hidden_check.sh"), "utf8");
  const expected = parseWorkerEvalExpected(fixture.expected);
  return {
    name: fixture.name,
    owner: fixture.owner,
    repo: fixture.repo,
    issueNumber: fixture.issueNumber,
    defaultBranch: fixture.defaultBranch,
    title: issue.title,
    body: issue.body,
    hiddenCheck,
    dir,
    repoDir: join(dir, "repo"),
    ...(expected ? { expected } : {}),
  };
}

export async function listWorkerEvalFixtures(baseDir?: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const root = baseDir ?? fixtureBaseDir();
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Git runner mapping only the inert eval host to a local bare; refuses any other network host. */
export function makeEvalGitRunner(localBarePath: string, inertCloneUrl?: string): GitRunner {
  return async (args, opts) => {
    const replaced = args.map((arg) => {
      if (typeof arg !== "string") return arg;
      if (inertCloneUrl && arg.includes(inertCloneUrl)) {
        return arg.split(inertCloneUrl).join(localBarePath);
      }
      if (arg.includes(EVAL_INERT_HOST)) {
        throw new Error(`worker eval refuses inert URL reaching network: ${arg}`);
      }
      return arg;
    });
    for (const arg of replaced) {
      const urls = typeof arg === "string" ? (arg.match(/https?:\/\/[^\s"'@]+/g) ?? []) : [];
      for (const url of urls) {
        let host = "";
        try {
          host = new URL(url).host;
        } catch {
          continue;
        }
        if (host && host !== EVAL_INERT_HOST) {
          throw new Error(`worker eval refuses network host: ${host}`);
        }
        if (url.startsWith("https://") || url.startsWith("http://")) {
          // After replacement no http(s) URL to the inert host should remain;
          // a leftover means the harness would hit the network.
          if (url.includes(EVAL_INERT_HOST)) {
            throw new Error(`worker eval refuses inert URL reaching network: ${url}`);
          }
        }
      }
    }
    // Allow file clones for the local bare; production denies file protocol.
    const allowed = replaced.map((arg) => (arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg));
    return runGit(allowed, opts);
  };
}

async function runPlainGit(args: string[], cwd: string, homeDir?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: minimalWorkerEvalEnv(homeDir ?? process.env.HOME ?? "/tmp") as Record<string, string>,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${(stdout + stderr).trim()}`);
  }
  return stdout.trim();
}

async function setupFixtureBare(
  fixture: LoadedWorkerEvalFixture,
  tmpRoot: string,
  homeDir: string
): Promise<{ barePath: string; baseSha: string }> {
  const barePath = join(tmpRoot, "remote.git");
  await mkdir(tmpRoot, { recursive: true });
  await runPlainGit(["init", "--bare", barePath], tmpRoot, homeDir);
  const seed = join(tmpRoot, "seed");
  await mkdir(seed, { recursive: true });
  await runPlainGit(["init"], seed, homeDir);
  await cp(fixture.repoDir, seed, { recursive: true });
  await runPlainGit(["add", "-A"], seed, homeDir);
  await runPlainGit(
    ["-c", "user.name=jumi", "-c", "user.email=jumi@localhost", "commit", "-m", "fixture base"],
    seed,
    homeDir
  );
  await runPlainGit(["branch", "-M", fixture.defaultBranch], seed, homeDir);
  await runPlainGit(["remote", "add", "origin", barePath], seed, homeDir);
  await runPlainGit(["push", "-u", "origin", fixture.defaultBranch], seed, homeDir);
  const baseSha = await runPlainGit(["rev-parse", "HEAD"], seed, homeDir);
  await rm(seed, { recursive: true, force: true });
  return { barePath, baseSha };
}

export function parseEvalClosingKeyword(prBody: string, issueNumber: number): "fixes" | "refs" | "none" {
  const region = jumiPrBodyRegion(prBody) ?? prBody;
  const visible = visibleClosingText(region);
  if (closesIssuePattern(issueNumber).test(visible)) return "fixes";
  if (refsIssuePattern(issueNumber).test(visible)) return "refs";
  return "none";
}

export function parseEvalRemaining(prBody: string): string[] {
  const region = jumiPrBodyRegion(prBody) ?? prBody;
  const match = /Remaining:\s*\n((?:\s*-\s*.*\n?)*)/.exec(region);
  if (!match) return [];
  return (match[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function isInconclusiveText(text: string): boolean {
  if (!text) return false;
  if (isQuotaText(text)) return true;
  const lower = text.toLowerCase();
  if (lower.includes("quota") || lower.includes("usage limit") || lower.includes("rate limit")) return true;
  if (
    lower.includes("auth") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("token")
  ) {
    // Only auth infrastructure, never a grading failure. A model answer that
    // mentions auth as leftover work is still a fail, not inconclusive, so
    // callers check the engine error path first; this is the fallback.
    return true;
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) return true;
  if (lower.includes("eval harness") || lower.includes("harness crash")) return true;
  return false;
}

export interface RunWorkerEvalCaseOptions {
  fixture: LoadedWorkerEvalFixture;
  runner: NamedRunner;
  trial: number;
  workdirRoot: string;
  homeRoot: string;
  tmpRoot: string;
  engine?: Engine;
  timeoutMs?: number;
  logger?: (message: string) => void;
  /** Deadline for the hidden check (default `WORKER_EVAL_HIDDEN_CHECK_TIMEOUT_MS`). */
  hiddenCheckTimeoutMs?: number;
  /** Deadline per grading git subprocess (default `WORKER_EVAL_GRADING_GIT_TIMEOUT_MS`). */
  gradingGitTimeoutMs?: number;
  /** Test hook: runs against the bare after the PR is recorded, before grading. */
  afterPr?: (ctx: { barePath: string; tmpDir: string }) => Promise<void>;
  harness?: EvalHarness;
  piDeployment?: { catalog: Parameters<typeof resolveEvalPiRoute>[0]["catalog"]; allowlist: string[] };
  piRouteName?: string;
  /** Test seam: Pi session deps (loopback model). Production builds the real Go session. */
  piSessionDepsFor?: (
    route: ReturnType<typeof resolveEvalPiRoute>,
    sessionId: string
  ) => Promise<{ modelRuntime: unknown; model: unknown }>;
  /** Test seam: scripted Pi invoke replacing the SDK session (writes files + store). */
  piInvoke?: (ctx: {
    workdir: string;
    store: WorkerResultStore;
    route: ReturnType<typeof resolveEvalPiRoute>;
    allowedFetchHosts: readonly string[];
  }) => Promise<{ usage?: unknown }>;
}

function workerEvalBaseRecord(
  opts: Pick<RunWorkerEvalCaseOptions, "fixture" | "runner" | "trial" | "harness">,
  stamp: string
): Omit<
  WorkerEvalRecord,
  | "durationMs"
  | "verdict"
  | "failedAssertions"
  | "jobStatus"
  | "closingKeyword"
  | "remaining"
  | "prBody"
  | "hiddenCheck"
  | "noSentinels"
  | "baseSha"
> {
  const harness = opts.harness ?? "legacy";
  return {
    fixture: opts.fixture.name,
    harness,
    runner: opts.runner.name,
    runnerStamp: stamp,
    trial: opts.trial,
    usage: null,
    imageDigest: evalImageDigest(),
    effectiveModel: opts.runner.model,
    route: opts.runner.name,
    payer: null,
    pool: null,
    outcome: null,
  };
}

export async function runWorkerEvalCase(opts: RunWorkerEvalCaseOptions): Promise<WorkerEvalRecord> {
  if ((opts.harness ?? "legacy") === "pi") return runWorkerEvalCasePi(opts);
  const log = opts.logger ?? (() => undefined);
  const started = Date.now();
  const finish = (partial: Omit<WorkerEvalRecord, "durationMs">): WorkerEvalRecord => ({
    ...partial,
    durationMs: Date.now() - started,
  });
  const stamp = formatRunnerStamp(runnerStamp(opts.runner));
  const baseRecord = {
    ...workerEvalBaseRecord(opts, stamp),
    baseSha: "unknown",
  };

  let homeDir = "";
  let workdir = "";
  let barePath = "";
  let baseSha = "unknown";
  try {
    await ensureEvalRoots([opts.homeRoot, opts.workdirRoot, opts.tmpRoot]);
    homeDir = await mkdtemp(join(opts.homeRoot, "eval-home-"));
    workdir = await mkdtemp(join(opts.workdirRoot, "eval-work-"));
    const tmp = await mkdtemp(join(opts.tmpRoot, "eval-tmp-"));
    const setup = await setupFixtureBare(opts.fixture, tmp, homeDir);
    barePath = setup.barePath;
    baseSha = setup.baseSha;
    const gradingGitTimeoutMs = opts.gradingGitTimeoutMs ?? WORKER_EVAL_GRADING_GIT_TIMEOUT_MS;
    const hiddenCheckTimeoutMs = opts.hiddenCheckTimeoutMs ?? WORKER_EVAL_HIDDEN_CHECK_TIMEOUT_MS;
    const gradeGit = (args: string[], cwd: string) => runWorkerEvalGit(args, cwd, homeDir, gradingGitTimeoutMs);

    const inconclusiveGitInfra = (detail: string) =>
      finish({
        ...baseRecord,
        baseSha,
        verdict: "inconclusive",
        failedAssertions: [],
        jobStatus: "pr",
        jobReason: detail,
        closingKeyword: "none",
        remaining: [],
        prBody: "",
        hiddenCheck: "skip",
        noSentinels: true,
        pushedSha: null,
        inconclusiveReason: detail,
      });

    // Hidden grader was read from the base checkout before the run.
    const hiddenCheck = opts.fixture.hiddenCheck;

    const inertCloneUrl = `https://${EVAL_INERT_HOST}/${opts.fixture.owner}/${opts.fixture.repo}.git`;
    const htmlUrl = `https://${EVAL_INERT_HOST}/${opts.fixture.owner}/${opts.fixture.repo}/issues/${opts.fixture.issueNumber}`;

    const pulls: Array<{
      number: number;
      title: string;
      body: string;
      head: string;
      base: string;
      headSha: string | null;
    }> = [];
    const baseApi = makeIssueApi();
    const evalApi = {
      ...baseApi,
      getIssue: async () => ({
        number: opts.fixture.issueNumber,
        title: opts.fixture.title,
        body: opts.fixture.body,
        state: "open" as const,
        html_url: htmlUrl,
        user: { login: "alice" },
        assignee: { login: EVAL_BOT_USERNAME },
        assignees: [{ login: EVAL_BOT_USERNAME }],
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }),
      getRepo: async () => ({
        name: opts.fixture.repo,
        full_name: `${opts.fixture.owner}/${opts.fixture.repo}`,
        html_url: `https://${EVAL_INERT_HOST}/${opts.fixture.owner}/${opts.fixture.repo}`,
        clone_url: inertCloneUrl,
        default_branch: opts.fixture.defaultBranch,
        owner: { login: opts.fixture.owner },
        // Synthetic fixtures are public, so the Contributor scope rule admits.
        private: evalPublicRepoVisibility().private,
        visibility: evalPublicRepoVisibility().visibility,
      }),
      listOpenPulls: async () => [],
      createPullRequest: async (
        _owner: string,
        _repo: string,
        pull: { title: string; body: string; head: string; base: string }
      ) => {
        const number = pulls.length + 1;
        // Record the PR head commit now: grading runs on this commit, never on
        // a later branch-list scan (a stray `jumi/issue-N-*` branch must not
        // change what is graded).
        let headSha: string | null = null;
        try {
          headSha = (await runWorkerEvalGit(["rev-parse", pull.head], barePath, homeDir)).trim() || null;
        } catch {
          headSha = null;
        }
        pulls.push({ number, title: pull.title, body: pull.body, head: pull.head, base: pull.base, headSha });
        return {
          number,
          title: pull.title,
          body: pull.body,
          state: "open" as const,
          html_url: `https://${EVAL_INERT_HOST}/${opts.fixture.owner}/${opts.fixture.repo}/pulls/${number}`,
          user: { login: EVAL_BOT_USERNAME },
          head: {
            ref: pull.head,
            sha: headSha ?? "unknown",
            repo: { full_name: `${opts.fixture.owner}/${opts.fixture.repo}` },
          },
          base: { ref: pull.base, sha: baseSha },
          merged: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      },
    } as unknown as IssueApi;

    const gitRunner = makeEvalGitRunner(barePath, inertCloneUrl);
    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const engine: Engine = opts.engine ?? registeredEngine;
      const result = await implementIssue({
        api: evalApi,
        job: {
          delivery: `eval-${opts.fixture.name}-${opts.runner.name}-t${opts.trial}`,
          owner: opts.fixture.owner,
          repo: opts.fixture.repo,
          issueNumber: opts.fixture.issueNumber,
          action: "assigned",
          title: opts.fixture.title,
          body: opts.fixture.body,
          htmlUrl,
          issueUpdatedAt: new Date().toISOString(),
          defaultBranch: opts.fixture.defaultBranch,
          cloneUrl: inertCloneUrl,
          receivedAt: new Date().toISOString(),
        },
        giteaUrl: EVAL_GITEA_URL,
        giteaToken: EVAL_TOKEN,
        botUsername: EVAL_BOT_USERNAME,
        model: opts.runner.model,
        ...("variant" in opts.runner && opts.runner.variant ? { variant: opts.runner.variant as string } : {}),
        ...("effort" in opts.runner && (opts.runner as { effort?: string }).effort
          ? { variant: (opts.runner as { effort?: string }).effort as string }
          : {}),
        chain: [opts.runner],
        home: homeDir,
        workdir,
        gitRunner,
        engine,
        timeoutMs: opts.timeoutMs,
        useClaim: false,
        verifyEnabled: false,
        logger: log,
      });

      const status = (result as { status: string }).status;
      const reason = (result as { reason?: string }).reason;
      if (status === "skipped" && typeof reason === "string" && (isQuotaText(reason) || isInconclusiveText(reason))) {
        return finish({
          ...baseRecord,
          baseSha,
          verdict: "inconclusive",
          failedAssertions: [],
          jobStatus: status,
          jobReason: reason,
          closingKeyword: "none",
          remaining: [],
          prBody: "",
          hiddenCheck: "skip",
          noSentinels: true,
          pushedSha: null,
          inconclusiveReason: reason,
        });
      }

      if (status !== "pr") {
        const failed = ["job-result-pr"];
        return finish({
          ...baseRecord,
          baseSha,
          verdict: "fail",
          failedAssertions: failed,
          jobStatus: status,
          ...(reason ? { jobReason: reason } : {}),
          closingKeyword: "none",
          remaining: [],
          prBody: "",
          hiddenCheck: "skip",
          noSentinels: true,
          pushedSha: null,
        });
      }

      const pr = pulls[pulls.length - 1];
      const prBody = pr?.body ?? "";
      const closingKeyword = parseEvalClosingKeyword(prBody, opts.fixture.issueNumber);
      const remaining = parseEvalRemaining(prBody);

      if (opts.afterPr) {
        await opts.afterPr({ barePath, tmpDir: tmp });
      }

      // Graded commit: the head the fake forge recorded when the PR opened.
      // Never a branch-list scan, so a stray branch changes nothing.
      const pushedSha: string | null = pr?.headSha ?? null;
      if (!pushedSha) {
        return inconclusiveGitInfra("eval git infrastructure: PR head SHA unavailable");
      }

      let hiddenCheckStatus: "pass" | "fail" | "skip" = "skip";
      let hiddenOutput = "";
      {
        const verifyDir = await mkdtemp(join(tmp, "verify-")).catch(() => null);
        if (!verifyDir) {
          return inconclusiveGitInfra("eval git infrastructure: verify checkout unavailable");
        }
        try {
          try {
            await gradeGit(["clone", barePath, verifyDir], tmp);
          } catch (err) {
            return inconclusiveGitInfra(`eval git infrastructure: clone failed: ${errorMessage(err)}`.slice(0, 500));
          }
          try {
            await gradeGit(["checkout", pushedSha], verifyDir);
          } catch (err) {
            return inconclusiveGitInfra(`eval git infrastructure: checkout failed: ${errorMessage(err)}`.slice(0, 500));
          }
          const scriptPath = join(verifyDir, ".eval-hidden.sh");
          try {
            await writeFile(scriptPath, hiddenCheck, "utf8");
          } catch (err) {
            return inconclusiveGitInfra(`eval verifier startup failed: ${errorMessage(err)}`.slice(0, 500));
          }
          let result: WorkerHiddenCheckResult;
          try {
            result = await runWorkerHiddenCheck(scriptPath, verifyDir, homeDir, hiddenCheckTimeoutMs);
          } catch (err) {
            return inconclusiveGitInfra(`eval verifier startup failed: ${errorMessage(err)}`.slice(0, 500));
          }
          hiddenOutput = result.output;
          // A deadline expiry kills the process group and grades `fail`: the
          // agent's change hung the verifier. Only startup/infra is inconclusive.
          hiddenCheckStatus = result.code === 0 && !result.timedOut ? "pass" : "fail";
          if (result.timedOut && !hiddenOutput) hiddenOutput = `hidden check timed out after ${hiddenCheckTimeoutMs}ms`;
        } finally {
          await rm(verifyDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      let noSentinels = true;
      {
        let listed: string;
        try {
          listed = await gradeGit(["ls-tree", "-r", "--name-only", pushedSha], barePath);
        } catch (err) {
          return inconclusiveGitInfra(`eval git infrastructure: ls-tree failed: ${errorMessage(err)}`.slice(0, 500));
        }
        const leaked = listed
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((path) => {
            const base = path.split("/").pop() ?? path;
            return base.startsWith("JUMI_") && base.endsWith(".md");
          });
        noSentinels = leaked.length === 0;
        if (!noSentinels) log(`eval sentinel leak: ${leaked.join(", ")}`);
      }

      const failedAssertions: string[] = workerEvalClosingFailures(closingKeyword, remaining, opts.fixture.expected);
      if (hiddenCheckStatus !== "pass") failedAssertions.push("hidden-check");
      if (!noSentinels) failedAssertions.push("no-sentinels");

      const usage = (result as { usage?: unknown }).usage;
      return finish({
        ...baseRecord,
        baseSha,
        verdict: failedAssertions.length === 0 ? "pass" : "fail",
        failedAssertions,
        jobStatus: status,
        prNumber: pr?.number ?? null,
        closingKeyword,
        remaining,
        prBody,
        hiddenCheck: hiddenCheckStatus,
        ...(hiddenOutput ? { hiddenCheckOutput: hiddenOutput } : {}),
        noSentinels,
        pushedSha,
        usage: evalUsageOrNull(usage),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  } catch (err) {
    const message = errorMessage(err);
    if (err instanceof EngineFailedError) {
      if (err.auth || isQuotaError(err) || isQuotaText(message)) {
        return finish({
          ...baseRecord,
          baseSha,
          verdict: "inconclusive",
          failedAssertions: [],
          jobStatus: "error",
          jobReason: message,
          closingKeyword: "none",
          remaining: [],
          prBody: "",
          hiddenCheck: "skip",
          noSentinels: true,
          pushedSha: null,
          inconclusiveReason: message,
        });
      }
    }
    if (isQuotaText(message) || isInconclusiveText(message)) {
      return finish({
        ...baseRecord,
        baseSha,
        verdict: "inconclusive",
        failedAssertions: [],
        jobStatus: "error",
        jobReason: message,
        closingKeyword: "none",
        remaining: [],
        prBody: "",
        hiddenCheck: "skip",
        noSentinels: true,
        pushedSha: null,
        inconclusiveReason: message,
      });
    }
    // Harness crashes are inconclusive, never fail.
    return finish({
      ...baseRecord,
      baseSha,
      verdict: "inconclusive",
      failedAssertions: [],
      jobStatus: "error",
      jobReason: message,
      closingKeyword: "none",
      remaining: [],
      prBody: "",
      hiddenCheck: "skip",
      noSentinels: true,
      pushedSha: null,
      inconclusiveReason: `harness crash: ${message}`,
    });
  }
}

export async function runWorkerEvalCasePi(opts: RunWorkerEvalCaseOptions): Promise<WorkerEvalRecord> {
  const log = opts.logger ?? (() => undefined);
  const started = Date.now();
  const finish = (partial: Omit<WorkerEvalRecord, "durationMs">): WorkerEvalRecord => ({
    ...partial,
    durationMs: Date.now() - started,
  });
  const deployment = opts.piDeployment ?? loadEvalPiDeployment();
  const { resolveEvalPiRouteNamed } = await import("./eval_harness.ts");
  const resolved = opts.piRouteName
    ? resolveEvalPiRouteNamed(opts.piRouteName, deployment)
    : resolveEvalPiRoute(deployment);
  const stampBase = formatRunnerStamp(runnerStamp(opts.runner));
  const baseRecord = {
    fixture: opts.fixture.name,
    harness: "pi" as const,
    runner: `pi:${resolved.name}`,
    runnerStamp: stampBase,
    trial: opts.trial,
    baseSha: "unknown",
    usage: null,
    imageDigest: evalImageDigest(),
    effectiveModel: resolved.model,
    route: resolved.name,
    payer: resolved.payer,
    pool: resolved.fundingPool,
    outcome: null as string | null,
  };
  const allowedFetchHosts = piAllowedHostsForRoute(resolved);

  const inconclusive = (reason: string, outcome: string, usage: unknown = null): WorkerEvalRecord =>
    finish({
      ...baseRecord,
      baseSha,
      verdict: "inconclusive",
      failedAssertions: [],
      jobStatus: "error",
      jobReason: reason,
      closingKeyword: "none",
      remaining: [],
      prBody: "",
      hiddenCheck: "skip",
      noSentinels: true,
      pushedSha: null,
      usage: evalUsageOrNull(usage),
      outcome,
      inconclusiveReason: reason,
    });

  let homeDir = "";
  let barePath = "";
  let baseSha = "unknown";
  try {
    await ensureEvalRoots([opts.homeRoot, opts.workdirRoot, opts.tmpRoot]);
    homeDir = await mkdtemp(join(opts.homeRoot, "eval-home-"));
    const tmp = await mkdtemp(join(opts.tmpRoot, "eval-tmp-"));
    const setup = await setupFixtureBare(opts.fixture, tmp, homeDir);
    barePath = setup.barePath;
    baseSha = setup.baseSha;
    const gradingGitTimeoutMs = opts.gradingGitTimeoutMs ?? WORKER_EVAL_GRADING_GIT_TIMEOUT_MS;
    const hiddenCheckTimeoutMs = opts.hiddenCheckTimeoutMs ?? WORKER_EVAL_HIDDEN_CHECK_TIMEOUT_MS;
    const gradeGit = (args: string[], cwd: string) => runWorkerEvalGit(args, cwd, homeDir, gradingGitTimeoutMs);
    const clonePath = join(tmp, "pi-clone");
    try {
      await gradeGit(["clone", barePath, clonePath], tmp);
    } catch (err) {
      return inconclusive(
        `eval git infrastructure: clone failed: ${errorMessage(err)}`.slice(0, 500),
        "provider-failure"
      );
    }
    const branch = `jumi/issue-${opts.fixture.issueNumber}-eval-t${opts.trial}`;
    try {
      await gradeGit(["checkout", "-B", branch], clonePath);
    } catch (err) {
      return inconclusive(
        `eval git infrastructure: checkout failed: ${errorMessage(err)}`.slice(0, 500),
        "provider-failure"
      );
    }

    const store = new WorkerResultStore();
    let piUsage: unknown = null;
    let piOutcome: string = "ok";
    try {
      if (opts.piInvoke) {
        const invoked = await opts.piInvoke({ workdir: clonePath, store, route: resolved, allowedFetchHosts });
        piUsage = invoked.usage ?? null;
      } else {
        const sessionId = `eval-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
        const deps = opts.piSessionDepsFor
          ? await opts.piSessionDepsFor(resolved, sessionId)
          : await createPiGoSessionDeps({ sessionId });
        const prompt =
          `Repository ${opts.fixture.owner}/${opts.fixture.repo}, issue #${opts.fixture.issueNumber}.\n` +
          `Issue title: ${opts.fixture.title}\nIssue body:\n${opts.fixture.body}\n` +
          `Implement the change in the worktree. Do not commit, push, or open pulls. Record results only through the jumi_* tools.`;
        const hop = await runPiHop({
          routes: [resolved.name],
          catalog: deployment.catalog,
          deploymentAllowlist: deployment.allowlist,
          scope: "public",
          role: "implement",
          lease: { isLeaseHeld: async () => true, isCancelled: async () => false, isWorktreeSafe: async () => true },
          invoke: async (invokedRoute, ctx) => {
            const perDeps = opts.piSessionDepsFor
              ? await opts.piSessionDepsFor(invokedRoute as never, ctx.sessionId)
              : { modelRuntime: deps.modelRuntime, model: deps.model };
            const seenStatuses: number[] = [];
            const outerFetch = globalThis.fetch;
            globalThis.fetch = (async (input: never, init: never) => {
              const response = await outerFetch(input, init);
              try {
                seenStatuses.push(response.status);
              } catch {}
              return response;
            }) as typeof fetch;
            try {
              const result = await runPiWorkerAttempt({
                workdir: clonePath,
                intent: "implement",
                prompt,
                store,
                modelRuntime: perDeps.modelRuntime,
                model: perDeps.model,
                allowedFetchHosts,
                timeoutMs: opts.timeoutMs,
                logger: log,
              });
              const { piSessionToAdapterResult } = await import("./pi_jobs.ts");
              return piSessionToAdapterResult(
                result.status === "complete" ? "complete" : "incomplete",
                result.reason,
                "pi worker session finished",
                seenStatuses
              );
            } finally {
              globalThis.fetch = outerFetch;
            }
          },
        });
        if (hop.status !== "ok" || !hop.result) {
          const kind = hop.result?.kind ?? "provider-failure";
          const reasonText = hop.result?.message ?? hop.reason ?? "provider failure";
          if (kind === "quota" || isQuotaText(reasonText)) {
            const normalized = normalizePiAttemptUsage(hop.result?.usage ?? null);
            const stamp = buildPiAttemptStamp({
              route: resolved,
              role: "implement",
              outcome: "quota",
              ...(normalized ? { usage: normalized } : {}),
            });
            return finish({
              ...baseRecord,
              baseSha,
              verdict: "inconclusive",
              failedAssertions: [],
              jobStatus: "error",
              jobReason: reasonText.slice(0, 500),
              closingKeyword: "none",
              remaining: [],
              prBody: "",
              hiddenCheck: "skip",
              noSentinels: true,
              pushedSha: null,
              usage: evalUsageOrNull(stamp.usage ?? null),
              outcome: "quota",
              inconclusiveReason: reasonText.slice(0, 500),
            });
          }
          if (/auth|unauthorized|forbidden|token/i.test(reasonText)) {
            return inconclusive(reasonText.slice(0, 500), "auth-expired");
          }
          if (/timeout|timed out|deadline/i.test(reasonText)) {
            return inconclusive(reasonText.slice(0, 500), "provider-failure");
          }
          return inconclusive(`harness crash: ${reasonText.slice(0, 500)}`, "provider-failure");
        }
        const normalized = normalizePiAttemptUsage(hop.result.usage ?? null);
        piUsage = normalized ?? null;
        piOutcome = hop.result.kind === "ok" ? "ok" : hop.result.kind;
      }
    } catch (err) {
      const message = errorMessage(err);
      if (isQuotaText(message)) return inconclusive(message.slice(0, 500), "quota", null);
      if (/auth|unauthorized|forbidden|token/i.test(message))
        return inconclusive(message.slice(0, 500), "auth-expired");
      if (/timeout|timed out|deadline/i.test(message)) return inconclusive(message.slice(0, 500), "provider-failure");
      return inconclusive(`harness crash: ${message}`.slice(0, 500), "provider-failure");
    }

    const prBody = store.getPrBody() ?? "";
    const skipReason = store.getSkipReason?.() ?? null;
    if (skipReason && (isQuotaText(skipReason) || isInconclusiveText(skipReason))) {
      return inconclusive(skipReason.slice(0, 500), "quota", piUsage);
    }
    let statusText: string;
    try {
      statusText = await gradeGit(["status", "--porcelain"], clonePath);
    } catch (err) {
      return inconclusive(
        `eval git infrastructure: status failed: ${errorMessage(err)}`.slice(0, 500),
        "provider-failure",
        piUsage
      );
    }
    if (!statusText.trim() && !prBody.trim()) {
      return finish({
        ...baseRecord,
        baseSha,
        verdict: "fail",
        failedAssertions: ["job-result-pr"],
        jobStatus: "no-changes",
        closingKeyword: "none",
        remaining: [],
        prBody: "",
        hiddenCheck: "skip",
        noSentinels: true,
        pushedSha: null,
        usage: evalUsageOrNull(piUsage),
        outcome: piOutcome,
      });
    }
    try {
      await gradeGit(["add", "-A"], clonePath);
      const again = await gradeGit(["status", "--porcelain"], clonePath);
      if (again.trim()) {
        await gradeGit(
          ["-c", "user.name=jumi", "-c", "user.email=jumi@localhost", "commit", "-m", "pi eval change"],
          clonePath
        );
      }
    } catch (err) {
      return inconclusive(
        `eval git infrastructure: commit failed: ${errorMessage(err)}`.slice(0, 500),
        "provider-failure",
        piUsage
      );
    }
    let pushedSha: string | null = null;
    try {
      await gradeGit(["push", "origin", `${branch}:${branch}`], clonePath);
      pushedSha = (await gradeGit(["rev-parse", branch], barePath)).trim() || null;
    } catch (err) {
      return inconclusive(
        `eval git infrastructure: push failed: ${errorMessage(err)}`.slice(0, 500),
        "provider-failure",
        piUsage
      );
    }
    if (!pushedSha) {
      return inconclusive("eval git infrastructure: PR head SHA unavailable", "provider-failure", piUsage);
    }
    if (opts.afterPr) {
      await opts.afterPr({ barePath, tmpDir: tmp });
    }

    const closingKeyword = parseEvalClosingKeyword(prBody, opts.fixture.issueNumber);
    const remaining = parseEvalRemaining(prBody);
    let hiddenCheckStatus: "pass" | "fail" | "skip" = "skip";
    let hiddenOutput = "";
    {
      const verifyDir = await mkdtemp(join(tmp, "verify-")).catch(() => null);
      if (!verifyDir)
        return inconclusive("eval git infrastructure: verify checkout unavailable", "provider-failure", piUsage);
      try {
        try {
          await gradeGit(["clone", barePath, verifyDir], tmp);
        } catch (err) {
          return inconclusive(
            `eval git infrastructure: clone failed: ${errorMessage(err)}`.slice(0, 500),
            "provider-failure",
            piUsage
          );
        }
        try {
          await gradeGit(["checkout", pushedSha], verifyDir);
        } catch (err) {
          return inconclusive(
            `eval git infrastructure: checkout failed: ${errorMessage(err)}`.slice(0, 500),
            "provider-failure",
            piUsage
          );
        }
        const scriptPath = join(verifyDir, ".eval-hidden.sh");
        try {
          await writeFile(scriptPath, opts.fixture.hiddenCheck, "utf8");
        } catch (err) {
          return inconclusive(
            `eval verifier startup failed: ${errorMessage(err)}`.slice(0, 500),
            "provider-failure",
            piUsage
          );
        }
        let result: WorkerHiddenCheckResult;
        try {
          result = await runWorkerHiddenCheck(scriptPath, verifyDir, homeDir, hiddenCheckTimeoutMs);
        } catch (err) {
          return inconclusive(
            `eval verifier startup failed: ${errorMessage(err)}`.slice(0, 500),
            "provider-failure",
            piUsage
          );
        }
        hiddenOutput = result.output;
        hiddenCheckStatus = result.code === 0 && !result.timedOut ? "pass" : "fail";
        if (result.timedOut && !hiddenOutput) hiddenOutput = `hidden check timed out after ${hiddenCheckTimeoutMs}ms`;
      } finally {
        await rm(verifyDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    let noSentinels = true;
    {
      let listed: string;
      try {
        listed = await gradeGit(["ls-tree", "-r", "--name-only", pushedSha], barePath);
      } catch (err) {
        return inconclusive(
          `eval git infrastructure: ls-tree failed: ${errorMessage(err)}`.slice(0, 500),
          "provider-failure",
          piUsage
        );
      }
      const leaked = listed
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((path) => {
          const base = path.split("/").pop() ?? path;
          return base.startsWith("JUMI_") && base.endsWith(".md");
        });
      noSentinels = leaked.length === 0;
    }
    const failedAssertions: string[] = workerEvalClosingFailures(closingKeyword, remaining, opts.fixture.expected);
    if (hiddenCheckStatus !== "pass") failedAssertions.push("hidden-check");
    if (!noSentinels) failedAssertions.push("no-sentinels");
    const normalizedUsage = normalizePiAttemptUsage((piUsage as never) ?? null);
    const stamp = buildPiAttemptStamp({
      route: resolved,
      role: "implement",
      outcome: (piOutcome as never) ?? "ok",
      ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    });
    return finish({
      ...baseRecord,
      baseSha,
      verdict: failedAssertions.length === 0 ? "pass" : "fail",
      failedAssertions,
      jobStatus: "pr",
      closingKeyword,
      remaining,
      prBody,
      hiddenCheck: hiddenCheckStatus,
      ...(hiddenOutput ? { hiddenCheckOutput: hiddenOutput } : {}),
      noSentinels,
      pushedSha,
      usage: evalUsageOrNull(stamp.usage ?? piUsage ?? null),
      outcome: stamp.outcome,
    });
  } catch (err) {
    const message = errorMessage(err);
    if (isQuotaText(message) || isInconclusiveText(message)) {
      return finish({
        ...baseRecord,
        baseSha,
        verdict: "inconclusive",
        failedAssertions: [],
        jobStatus: "error",
        jobReason: message,
        closingKeyword: "none",
        remaining: [],
        prBody: "",
        hiddenCheck: "skip",
        noSentinels: true,
        pushedSha: null,
        usage: null,
        outcome: "provider-failure",
        inconclusiveReason: message,
      });
    }
    return finish({
      ...baseRecord,
      baseSha,
      verdict: "inconclusive",
      failedAssertions: [],
      jobStatus: "error",
      jobReason: message,
      closingKeyword: "none",
      remaining: [],
      prBody: "",
      hiddenCheck: "skip",
      noSentinels: true,
      pushedSha: null,
      usage: null,
      outcome: "provider-failure",
      inconclusiveReason: `harness crash: ${message}`,
    });
  }
}

export interface RunWorkerEvalOptions {
  fixtures: LoadedWorkerEvalFixture[];
  runners: NamedRunner[];
  trials: number;
  outDir: string;
  workdirRoot: string;
  homeRoot: string;
  tmpRoot: string;
  engineForRunner?: (runner: NamedRunner) => Engine;
  timeoutMs?: number;
  logger?: (message: string) => void;
  harnesses?: EvalHarness[];
  piSessionDepsFor?: RunWorkerEvalCaseOptions["piSessionDepsFor"];
  piInvokeForRoute?: (routeName: string) => RunWorkerEvalCaseOptions["piInvoke"];
}

async function writeWorkerEvalRecords(
  outDir: string,
  preexisting: string[],
  lines: string[],
  runId: string
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `results-${runId}.jsonl`), `${lines.join("\n")}\n`);
  await writeFile(join(outDir, "results.jsonl"), `${[...preexisting, ...lines].join("\n")}\n`);
}

export async function runWorkerEval(opts: RunWorkerEvalOptions): Promise<WorkerEvalRecord[]> {
  await ensureEvalRoots([opts.outDir, opts.workdirRoot, opts.homeRoot, opts.tmpRoot]);
  const log = opts.logger ?? (() => undefined);
  const harnesses = opts.harnesses ?? ["legacy"];
  // Misconfigured Pi fails before the first fixture and writes no records.
  let piDeployment: { catalog: Parameters<typeof resolveEvalPiRoute>[0]["catalog"]; allowlist: string[] } | undefined;
  if (harnesses.includes("pi")) {
    piDeployment = loadEvalPiDeployment();
    resolveEvalPiRoute(piDeployment);
  }
  const records: WorkerEvalRecord[] = [];
  const lines: string[] = [];
  const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
  let preexisting: string[] = [];
  try {
    const current = await readFile(join(opts.outDir, "results.jsonl"), "utf8");
    preexisting = current.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    preexisting = [];
  }
  const flush = async () => {
    await writeWorkerEvalRecords(opts.outDir, preexisting, lines, runId);
  };
  for (const harness of harnesses) {
    for (const fixture of opts.fixtures) {
      for (const runner of opts.runners) {
        for (let trial = 1; trial <= opts.trials; trial++) {
          let record: WorkerEvalRecord;
          try {
            record = await runWorkerEvalCase({
              fixture,
              runner,
              trial,
              workdirRoot: opts.workdirRoot,
              homeRoot: opts.homeRoot,
              tmpRoot: opts.tmpRoot,
              ...(opts.engineForRunner ? { engine: opts.engineForRunner(runner) } : {}),
              ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
              logger: log,
              harness,
              ...(piDeployment ? { piDeployment } : {}),
              ...(opts.piSessionDepsFor ? { piSessionDepsFor: opts.piSessionDepsFor } : {}),
              ...(opts.piInvokeForRoute && harness === "pi" && piDeployment
                ? { piInvoke: opts.piInvokeForRoute(piDeployment.allowlist[0]!) }
                : {}),
            });
          } catch (err) {
            const message = errorMessage(err);
            record = {
              fixture: fixture.name,
              harness,
              runner: harness === "pi" && piDeployment ? `pi:${piDeployment.allowlist[0]}` : runner.name,
              runnerStamp: formatRunnerStamp(runnerStamp(runner)),
              trial,
              verdict: "inconclusive",
              failedAssertions: [],
              jobStatus: "error",
              jobReason: message,
              closingKeyword: "none",
              remaining: [],
              prBody: "",
              hiddenCheck: "skip",
              noSentinels: true,
              pushedSha: null,
              baseSha: "unknown",
              durationMs: 0,
              usage: null,
              imageDigest: evalImageDigest(),
              effectiveModel: runner.model,
              route: harness === "pi" && piDeployment ? piDeployment.allowlist[0]! : runner.name,
              payer: null,
              pool: null,
              outcome: "provider-failure",
              inconclusiveReason: `harness crash: ${message}`,
            };
          }
          records.push(record);
          lines.push(JSON.stringify(record));
          await flush();
        }
      }
    }
  }
  return records;
}

function printWorkerEvalHelp(): void {
  console.log(`jumi worker eval: run implement fixtures through the production implement path
without publishing. Operator-run only; nothing is scheduled.

Usage:
  bun run src/worker_eval.ts --out <output-dir> [--fixture <name>] [--runners <name1,name2>] [--trials <n>] [--harness legacy|pi|legacy,pi]

Fixtures are committed under src/eval_fixtures/. Each record in
<out>/results.jsonl carries fixture, harness (legacy|pi), runner, trial, verdict
(pass / fail / inconclusive), failed assertion names, the published closing
keyword and remaining list, hidden-check status, duration, image digest,
effective model, payer/route, wall time and usage (null when unknown).
Auth, quota, timeouts and harness crashes record inconclusive, never fail.
The legacy baseline runs exactly one explicitly selected runner (via --runners)
from a minimal catalog holding only that runner, with no fallback.
A Pi run needs JUMI_PI_PROFILES_FILE plus JUMI_PI_ALLOWED_ROUTES naming the
wired Go route; the fake forge reports the repo as public and allowedFetchHosts
is just that endpoint.
The first real-model runs are operator-run; no CI wiring in this change.`);
}

function parseWorkerEvalArgs(argv: string[]): {
  out?: string;
  fixture?: string;
  runners?: string[];
  trials: number;
  harness?: string;
  help: boolean;
} {
  let out: string | undefined;
  let fixture: string | undefined;
  let runners: string[] | undefined;
  let trials = 1;
  let harness: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--out" && i + 1 < argv.length) out = argv[++i];
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else if (arg === "--fixture" && i + 1 < argv.length) fixture = argv[++i];
    else if (arg.startsWith("--fixture=")) fixture = arg.slice("--fixture=".length);
    else if (arg === "--runners" && i + 1 < argv.length) {
      runners = argv[++i]
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--runners=")) {
      runners = arg
        .slice("--runners=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--trials" && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) trials = parsed;
    } else if (arg.startsWith("--trials=")) {
      const parsed = Number.parseInt(arg.slice("--trials=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) trials = parsed;
    } else if (arg === "--harness" && i + 1 < argv.length) harness = argv[++i];
    else if (arg.startsWith("--harness=")) harness = arg.slice("--harness=".length);
    else if (arg === "--") break;
  }
  return { out, fixture, runners, trials, harness, help };
}

function loadWorkerEvalCliRunners(runnerNames: string[] | undefined): NamedRunner[] {
  return loadEvalLegacyRunners(runnerNames);
}

async function main(): Promise<void> {
  const args = parseWorkerEvalArgs(process.argv.slice(2));
  if (args.help) {
    printWorkerEvalHelp();
    return;
  }
  if (!args.out) {
    printWorkerEvalHelp();
    throw new Error("Missing required --out");
  }
  const env = process.env as Record<string, string | undefined>;
  const allNames = await listWorkerEvalFixtures();
  const names = args.fixture ? [args.fixture] : allNames;
  const fixtures: LoadedWorkerEvalFixture[] = [];
  for (const name of names) {
    fixtures.push(await loadWorkerEvalFixture(name));
  }
  const runners = loadWorkerEvalCliRunners(args.runners);
  const harnesses = parseEvalHarness(args.harness);
  const workdirRoot = join(env.WORKDIR ?? "/work", "jumi-worker-eval");
  const homeRoot = env.HOME?.trim() ? env.HOME : "/data";
  const tmpRoot = process.env.TMPDIR?.trim() ? process.env.TMPDIR : tmpdir();
  await ensureEvalRoots([workdirRoot, join(homeRoot, "jumi-worker-eval-homes"), join(tmpRoot, "jumi-worker-eval")]);
  const records = await runWorkerEval({
    fixtures,
    runners,
    trials: args.trials,
    outDir: args.out,
    workdirRoot,
    homeRoot: join(homeRoot, "jumi-worker-eval-homes"),
    tmpRoot: join(tmpRoot, "jumi-worker-eval"),
    harnesses,
    logger: (message) => console.log(`[worker-eval] ${message}`),
  });
  const summary = records.map((r) => `${r.fixture}/${r.harness}/${r.runner}#${r.trial}:${r.verdict}`).join(" ");
  console.log(`[worker-eval] done: ${records.length} records -> ${args.out}/results.jsonl ${summary}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[worker-eval] ${errorMessage(err)}`);
    process.exit(1);
  });
}
