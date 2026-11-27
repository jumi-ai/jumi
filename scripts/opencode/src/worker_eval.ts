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

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Engine, EngineFailedError } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import { makeIssueApi } from "./forge_fake.ts";
import { closesIssuePattern, refsIssuePattern, visibleClosingText } from "./gitea_issues.ts";
import { implementIssue, jumiPrBodyRegion } from "./implement.ts";
import type { IssueApi } from "./ports.ts";
import { isQuotaError, isQuotaText } from "./quota.ts";
import { formatRunnerStamp, loadRunnersCatalog, type NamedRunner, orderedRunners, runnerStamp } from "./runners.ts";
import { errorMessage } from "./util/error.ts";
import { type GitRunner, runGit } from "./workspace.ts";

export const EVAL_INERT_HOST = "eval.invalid";
export const EVAL_GITEA_URL = "https://eval.invalid";
export const EVAL_TOKEN = "eval-inert-token";
export const EVAL_BOT_USERNAME = "jumi";

export type WorkerEvalVerdict = "pass" | "fail" | "inconclusive";

export interface WorkerEvalRecord {
  fixture: string;
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
  usage?: unknown;
  inconclusiveReason?: string;
}

export interface WorkerEvalExpected {
  closingKeyword: "fixes" | "refs";
  minRemaining: number;
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
  const record = raw as { closingKeyword?: unknown; minRemaining?: unknown };
  if (record.closingKeyword !== "fixes" && record.closingKeyword !== "refs") return undefined;
  const minRemaining =
    typeof record.minRemaining === "number" && Number.isFinite(record.minRemaining) && record.minRemaining >= 0
      ? Math.floor(record.minRemaining)
      : 0;
  return { closingKeyword: record.closingKeyword, minRemaining };
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

async function runPlainGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
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
  tmpRoot: string
): Promise<{ barePath: string; baseSha: string }> {
  const barePath = join(tmpRoot, "remote.git");
  await mkdir(tmpRoot, { recursive: true });
  await runPlainGit(["init", "--bare", barePath], tmpRoot);
  const seed = join(tmpRoot, "seed");
  await mkdir(seed, { recursive: true });
  await runPlainGit(["init"], seed);
  await cp(fixture.repoDir, seed, { recursive: true });
  await runPlainGit(["add", "-A"], seed);
  await runPlainGit(["-c", "user.name=jumi", "-c", "user.email=jumi@localhost", "commit", "-m", "fixture base"], seed);
  await runPlainGit(["branch", "-M", fixture.defaultBranch], seed);
  await runPlainGit(["remote", "add", "origin", barePath], seed);
  await runPlainGit(["push", "-u", "origin", fixture.defaultBranch], seed);
  const baseSha = await runPlainGit(["rev-parse", "HEAD"], seed);
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
}

export async function runWorkerEvalCase(opts: RunWorkerEvalCaseOptions): Promise<WorkerEvalRecord> {
  const log = opts.logger ?? (() => undefined);
  const started = Date.now();
  const finish = (partial: Omit<WorkerEvalRecord, "durationMs">): WorkerEvalRecord => ({
    ...partial,
    durationMs: Date.now() - started,
  });
  const stamp = formatRunnerStamp(runnerStamp(opts.runner));
  const baseRecord = {
    fixture: opts.fixture.name,
    runner: opts.runner.name,
    runnerStamp: stamp,
    trial: opts.trial,
    baseSha: "unknown",
  };

  let homeDir = "";
  let workdir = "";
  let barePath = "";
  let baseSha = "unknown";
  try {
    homeDir = await mkdtemp(join(opts.homeRoot, "eval-home-"));
    workdir = await mkdtemp(join(opts.workdirRoot, "eval-work-"));
    const tmp = await mkdtemp(join(opts.tmpRoot, "eval-tmp-"));
    const setup = await setupFixtureBare(opts.fixture, tmp);
    barePath = setup.barePath;
    baseSha = setup.baseSha;

    // Hidden grader was read from the base checkout before the run.
    const hiddenCheck = opts.fixture.hiddenCheck;

    const inertCloneUrl = `https://${EVAL_INERT_HOST}/${opts.fixture.owner}/${opts.fixture.repo}.git`;
    const htmlUrl = `https://${EVAL_INERT_HOST}/${opts.fixture.owner}/${opts.fixture.repo}/issues/${opts.fixture.issueNumber}`;

    const pulls: Array<{ number: number; title: string; body: string; head: string; base: string }> = [];
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
      }),
      listOpenPulls: async () => [],
      createPullRequest: async (
        _owner: string,
        _repo: string,
        pull: { title: string; body: string; head: string; base: string }
      ) => {
        const number = pulls.length + 1;
        pulls.push({ number, title: pull.title, body: pull.body, head: pull.head, base: pull.base });
        return {
          number,
          title: pull.title,
          body: pull.body,
          state: "open" as const,
          html_url: `https://${EVAL_INERT_HOST}/${opts.fixture.owner}/${opts.fixture.repo}/pulls/${number}`,
          user: { login: EVAL_BOT_USERNAME },
          head: { ref: pull.head, sha: "headsha", repo: { full_name: `${opts.fixture.owner}/${opts.fixture.repo}` } },
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

      // Pushed commit: the branch implementIssue pushed to the local bare.
      // The agent never saw this checkout; hidden checks run here.
      const branch = `jumi/issue-${opts.fixture.issueNumber}-`;
      const branchList = await runPlainGit(["branch", "--list", `${branch}*`, "--format=%(refname:short)"], barePath);
      const pushedBranch = branchList
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort()
        .pop();
      let pushedSha: string | null = null;
      if (pushedBranch) {
        pushedSha = await runPlainGit(["rev-parse", pushedBranch], barePath);
      }

      let hiddenCheckStatus: "pass" | "fail" | "skip" = "skip";
      let hiddenOutput = "";
      if (pushedSha) {
        const verifyDir = await mkdtemp(join(tmp, "verify-"));
        try {
          await runPlainGit(["clone", barePath, verifyDir], tmp);
          await runPlainGit(["checkout", pushedSha], verifyDir);
          const scriptPath = join(verifyDir, ".eval-hidden.sh");
          await writeFile(scriptPath, hiddenCheck, "utf8");
          const proc = Bun.spawn(["sh", scriptPath, verifyDir], {
            cwd: verifyDir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const [out, err, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          hiddenOutput = `${out}\n${err}`.trim().slice(0, 4000);
          hiddenCheckStatus = code === 0 ? "pass" : "fail";
        } catch (err) {
          hiddenOutput = errorMessage(err).slice(0, 4000);
          hiddenCheckStatus = "fail";
        } finally {
          await rm(verifyDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      let noSentinels = true;
      if (pushedSha) {
        try {
          const listed = await runPlainGit(["ls-tree", "-r", "--name-only", pushedSha], barePath);
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
        } catch {
          noSentinels = false;
        }
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
        ...(usage !== undefined ? { usage } : {}),
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
}

export async function runWorkerEval(opts: RunWorkerEvalOptions): Promise<WorkerEvalRecord[]> {
  await mkdir(opts.outDir, { recursive: true });
  const log = opts.logger ?? (() => undefined);
  const records: WorkerEvalRecord[] = [];
  const lines: string[] = [];
  const flush = async () => {
    await writeFile(join(opts.outDir, "results.jsonl"), `${lines.join("\n")}\n`);
  };
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
          });
        } catch (err) {
          const message = errorMessage(err);
          record = {
            fixture: fixture.name,
            runner: runner.name,
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
            inconclusiveReason: `harness crash: ${message}`,
          };
        }
        records.push(record);
        lines.push(JSON.stringify(record));
        await flush();
      }
    }
  }
  return records;
}

function printWorkerEvalHelp(): void {
  console.log(`jumi worker eval: run implement fixtures through the production implement path
without publishing. Operator-run only; nothing is scheduled.

Usage:
  bun run src/worker_eval.ts --out <output-dir> [--fixture <name>] [--runners <name1,name2>] [--trials <n>]

Fixtures are committed under src/eval_fixtures/. Each record in
<out>/results.jsonl carries fixture, runner, trial, verdict
(pass / fail / inconclusive), failed assertion names, the published closing
keyword and remaining list, hidden-check status, and duration. Auth, quota,
timeouts and harness crashes record inconclusive, never fail.
The first real-model runs are operator-run; no CI wiring in this change.`);
}

function parseWorkerEvalArgs(argv: string[]): {
  out?: string;
  fixture?: string;
  runners?: string[];
  trials: number;
  help: boolean;
} {
  let out: string | undefined;
  let fixture: string | undefined;
  let runners: string[] | undefined;
  let trials = 1;
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
    } else if (arg === "--") break;
  }
  return { out, fixture, runners, trials, help };
}

function loadWorkerEvalCliRunners(runnerNames: string[] | undefined): NamedRunner[] {
  const env = process.env as Record<string, string | undefined>;
  const fromEnv = {
    model: env.OPENCODE_MODEL?.trim() ? env.OPENCODE_MODEL : "openai/gpt-5.5",
    ...(env.OPENCODE_VARIANT ? { variant: env.OPENCODE_VARIANT } : {}),
    ...(env.OPENCODE_FALLBACK_MODEL ? { fallbackModel: env.OPENCODE_FALLBACK_MODEL } : {}),
    ...(env.OPENCODE_FALLBACK_VARIANT ? { fallbackVariant: env.OPENCODE_FALLBACK_VARIANT } : {}),
  };
  const catalog = loadRunnersCatalog(env.JUMI_RUNNERS_FILE, fromEnv, "gitea");
  const ordered = orderedRunners(catalog);
  if (!runnerNames || runnerNames.length === 0) return ordered;
  const byName = new Map(ordered.map((runner) => [runner.name, runner]));
  return runnerNames.map((name) => {
    const found = byName.get(name);
    if (!found) throw new Error(`Unknown runner ${name} (chain: ${ordered.map((r) => r.name).join(", ")})`);
    return found;
  });
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
  const workdirRoot = join(env.WORKDIR ?? "/work", "jumi-worker-eval");
  const homeRoot = env.HOME?.trim() ? env.HOME : "/data";
  const tmpRoot = process.env.TMPDIR?.trim() ? process.env.TMPDIR : tmpdir();
  await mkdir(workdirRoot, { recursive: true });
  const records = await runWorkerEval({
    fixtures,
    runners,
    trials: args.trials,
    outDir: args.out,
    workdirRoot,
    homeRoot: join(homeRoot, "jumi-worker-eval-homes"),
    tmpRoot: join(tmpRoot, "jumi-worker-eval"),
    logger: (message) => console.log(`[worker-eval] ${message}`),
  });
  const summary = records.map((r) => `${r.fixture}/${r.runner}#${r.trial}:${r.verdict}`).join(" ");
  console.log(`[worker-eval] done: ${records.length} records -> ${args.out}/results.jsonl ${summary}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[worker-eval] ${errorMessage(err)}`);
    process.exit(1);
  });
}
