/**
 * Opt-in review eval: run paired fixtures through the production review path
 * for the named runner, without publishing.
 *
 * Hermetic by construction, mirroring `src/worker_eval.ts`:
 * - fixture repos live in `src/eval_fixtures/` (committed, synthetic);
 * - each half builds a local git checkout with real base/head commits in an
 *   isolated temp dir (no bare remote, no clone of a forge);
 * - HOME is an isolated temp dir; no forge client is constructed and no
 *   network host is contacted;
 * - repository data comes from the fixture, never from a forge.
 *
 * Live-contract by construction:
 * - the prompt is built with the same `buildPROpenedPrompt` builder the live
 *   reviewer uses, with `REVIEW.md` sections selected from the base commit via
 *   `loadReviewMdSectionsFromBase` and base-branch `AGENTS.md`/`CLAUDE.md`
 *   plus skills staged via `stageBaseReviewInstructions` (the head never
 *   configures its reviewer);
 * - the verdict contract is always `required` (resolved per attempt from the
 *   runner, then pinned to `required`): findings and the verdict are recorded
 *   only through the parent-owned review MCP server (`ReviewVerdictStore`
 *   behind `startReviewMcpServer`); a `JUMI_REVIEW.md` file in the worktree
 *   never publishes and a file-only result is incomplete, the same as the
 *   live `required` path. The fixture path never runs the legacy contract.
 *
 * Grading (per half, never tool-call order):
 * - defective: failing store verdict, plus at least one blocking (bug/risk)
 *   finding inside a listed anchor whose text names the concrete failure
 *   (every `mustContain` token present, case-insensitive);
 * - repaired: success store verdict with no blocking findings (non-blocking
 *   suggestions and questions are fine);
 * - both halves: the tree is clean (only the ignored `JUMI_REVIEW.md`
 *   artifact may remain) and every question that mentions a maintainer parses
 *   as a `maintainer:` hold.
 *
 * Records share the worker-eval envelope (`fixture`, `runner`,
 * `runnerStamp`, `trial`, `verdict`, `failedAssertions`, `durationMs`,
 * `usage`, `inconclusiveReason`) and the same `inconclusive` rules: auth,
 * quota, timeouts, and harness crashes record `inconclusive`, never `fail`.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isEngineTempPath, porcelainPaths } from "./claimed_worktree.ts";
import { type Engine, EngineFailedError, throwIfEngineFailed } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import { ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { buildPROpenedPrompt } from "./prompt.ts";
import { isQuotaError, isQuotaText } from "./quota.ts";
import { readStagedBaseFile, stageBaseReviewInstructions } from "./review_base.ts";
import { randomReviewMcpToken, startReviewMcpServer } from "./review_mcp.ts";
import { loadReviewMdSectionsFromBase } from "./review_md.ts";
import { resolveReviewVerdictContract } from "./review_verdict_contract.ts";
import { isMaintainerStoreFinding, type ReviewMcpFindingRecord, ReviewVerdictStore } from "./review_verdict_store.ts";
import { formatRunnerStamp, loadRunnersCatalog, type NamedRunner, orderedRunners, runnerStamp } from "./runners.ts";
import { errorMessage } from "./util/error.ts";
import { runGit } from "./workspace.ts";

export const REVIEW_EVAL_REVIEW_MCP_NAME = "jumi-review";
export const REVIEW_EVAL_CONTRACT = "required" as const;
/** Neutral commit messages: identical for both halves so `git log` never leaks the half. */
export const REVIEW_EVAL_BASE_COMMIT_MESSAGE = "fixture base";
export const REVIEW_EVAL_HEAD_COMMIT_MESSAGE = "fixture change";
/** Neutral branch for the base ref: no half name anywhere the model can read. */
export const REVIEW_EVAL_TARGET_BRANCH = "jumi/target";

/** Minimal env for grading git: allowlist only, so no parent credential leaks in. */
export function minimalReviewEvalGitEnv(homeDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  env.HOME = homeDir ?? process.env.HOME ?? "/tmp";
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

export type ReviewEvalHalf = "defective" | "repaired";
export type ReviewEvalVerdict = "pass" | "fail" | "inconclusive";

export interface ReviewEvalAnchor {
  path: string;
  start: number;
  end: number;
}

export interface ReviewEvalRecord {
  fixture: string;
  half: ReviewEvalHalf;
  runner: string;
  runnerStamp: string;
  trial: number;
  verdict: ReviewEvalVerdict;
  failedAssertions: string[];
  reviewState: "success" | "failure" | "incomplete" | "skip";
  findingsCount: number;
  blockingCount: number;
  rawMarkdown: string;
  contract: typeof REVIEW_EVAL_CONTRACT;
  treeClean: boolean;
  maintainerHolds: boolean;
  baseSha: string;
  headSha: string;
  durationMs: number;
  usage?: unknown;
  inconclusiveReason?: string;
  jobReason?: string;
}

export interface LoadedReviewEvalFixture {
  name: string;
  owner: string;
  repo: string;
  prNumber: number;
  defaultBranch: string;
  title: string;
  body: string;
  author: string;
  anchors: ReviewEvalAnchor[];
  mustContain: string[];
  paraphrases: ReviewEvalParaphrase[];
  note?: string;
  dir: string;
  repoDir: string;
  defectiveDir: string;
  repairedDir: string;
}

function fixtureBaseDir(): string {
  return join(dirname(new URL(import.meta.url).pathname), "eval_fixtures");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface ReviewEvalParaphrase {
  title: string;
  body: string;
}

function asParaphrases(value: unknown): ReviewEvalParaphrase[] {
  if (!Array.isArray(value)) return [];
  const out: ReviewEvalParaphrase[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { title?: unknown; body?: unknown };
    if (typeof record.title !== "string" || typeof record.body !== "string") continue;
    if (!record.title.trim() && !record.body.trim()) continue;
    out.push({ title: record.title, body: record.body });
  }
  return out;
}

export async function loadReviewEvalFixture(name: string, baseDir?: string): Promise<LoadedReviewEvalFixture> {
  const root = baseDir ?? fixtureBaseDir();
  const dir = join(root, name);
  const fixture = await readJson(join(dir, "fixture.json"));
  const pr = await readJson(join(dir, "pr.json"));
  const review = (await readJson(join(dir, "review.json"))) as {
    defective?: { anchors?: ReviewEvalAnchor[]; mustContain?: string[]; note?: string; paraphrases?: unknown };
  };
  const defective = review.defective ?? {};
  const anchors = Array.isArray(defective.anchors) ? (defective.anchors as ReviewEvalAnchor[]) : [];
  const mustContain = Array.isArray(defective.mustContain) ? (defective.mustContain as string[]) : [];
  const paraphrases = asParaphrases(defective.paraphrases);
  return {
    name: asString(fixture.name) || name,
    owner: asString(fixture.owner) || "eval",
    repo: asString(fixture.repo) || "demo",
    prNumber: typeof fixture.prNumber === "number" ? fixture.prNumber : 7,
    defaultBranch: asString(fixture.defaultBranch) || "main",
    title: asString(pr.title) || "Fixture change",
    body: asString(pr.body) || "",
    author: asString(pr.author) || "alice",
    anchors,
    mustContain,
    paraphrases,
    ...(typeof defective.note === "string" && defective.note ? { note: defective.note } : {}),
    dir,
    repoDir: join(dir, "repo"),
    defectiveDir: join(dir, "defective"),
    repairedDir: join(dir, "repaired"),
  };
}

export async function listReviewEvalFixtures(baseDir?: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const root = baseDir ?? fixtureBaseDir();
  const entries = await readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(root, entry.name, "review.json"), "utf8");
      out.push(entry.name);
    } catch {
      // Not a review fixture (e.g. a worker-only fixture): skip.
    }
  }
  return out.sort();
}

async function runPlainGit(args: string[], cwd: string, homeDir?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: minimalReviewEvalGitEnv(homeDir) as Record<string, string>,
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

function gitEnv(homeDir?: string): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: homeDir ?? process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

interface EvalPullFile {
  filename: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

function patchStatus(patch: string): EvalPullFile["status"] {
  const header = patch.split("\n@@", 1)[0] ?? "";
  if (/^new file mode /m.test(header)) return "added";
  if (/^deleted file mode /m.test(header)) return "deleted";
  return "modified";
}

async function buildPullFiles(
  workdir: string,
  baseSha: string,
  headSha: string,
  homeDir?: string
): Promise<EvalPullFile[]> {
  const env = gitEnv(homeDir);
  const numstat = await runPlainGit(
    ["diff", "--no-color", "--no-ext-diff", "--no-renames", "--numstat", "-z", baseSha, headSha],
    workdir,
    homeDir
  );
  const entries: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const record of numstat.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record.replace(/^\n+/, ""));
    if (!match) continue;
    entries.push({
      path: match[3] ?? "",
      additions: match[1] === "-" ? 0 : Number.parseInt(match[1] ?? "0", 10),
      deletions: match[2] === "-" ? 0 : Number.parseInt(match[2] ?? "0", 10),
    });
  }
  const files: EvalPullFile[] = [];
  for (const entry of entries) {
    let patch: string | undefined;
    try {
      const raw = await runGit(
        ["diff", "--no-color", "--no-ext-diff", "--no-renames", baseSha, headSha, "--", `:(literal)${entry.path}`],
        {
          cwd: workdir,
          env,
        }
      );
      const trimmed = raw.trimEnd();
      if (trimmed) patch = trimmed;
    } catch {
      patch = undefined;
    }
    files.push({
      filename: entry.path,
      status: patch ? patchStatus(patch) : "modified",
      additions: entry.additions,
      deletions: entry.deletions,
      changes: entry.additions + entry.deletions,
      ...(patch ? { patch } : {}),
    });
  }
  return files;
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
    return true;
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) return true;
  if (lower.includes("eval harness") || lower.includes("harness crash")) return true;
  return false;
}

function findingInAnchors(finding: { path?: string; line?: number }, anchors: ReviewEvalAnchor[]): boolean {
  if (!finding.path || finding.line == null) return false;
  return anchors.some(
    (anchor) =>
      anchor.path === finding.path && finding.line != null && finding.line >= anchor.start && finding.line <= anchor.end
  );
}

/**
 * Every question that mentions a maintainer must publish as a maintainer
 * hold: the store counts it as `maintainerQuestion`. Checked against the
 * store with the same predicate production publishes from, so a non-question
 * severity that mentions "maintainer" in prose stays a pass here exactly as
 * it publishes with no hold live.
 */
function maintainerHoldsForFindings(
  findings: ReadonlyArray<Pick<ReviewMcpFindingRecord, "severity" | "title" | "body">>
): boolean {
  for (const finding of findings) {
    if (finding.severity !== "question") continue;
    const text = `${finding.title ?? ""}\n${finding.body ?? ""}`;
    if (/maintainer/i.test(text) && !isMaintainerStoreFinding(finding)) return false;
  }
  return true;
}

function porcelainTreeClean(porcelain: string): boolean {
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const paths = porcelainPaths(line);
    let allowed = true;
    for (const path of paths) {
      if (path === "JUMI_REVIEW.md" || path === "JUMI_TASK.md") continue;
      if (isEngineTempPath(path)) continue;
      // Untracked python bytecode never fails a live review either.
      if (path.split("/").includes("__pycache__") || path.endsWith(".pyc")) {
        if (line.startsWith("??")) continue;
      }
      allowed = false;
    }
    if (!allowed) return false;
  }
  return true;
}

export interface RunReviewEvalCaseOptions {
  fixture: LoadedReviewEvalFixture;
  half: ReviewEvalHalf;
  runner: NamedRunner;
  trial: number;
  workdirRoot: string;
  homeRoot: string;
  engine?: Engine;
  timeoutMs?: number;
  logger?: (message: string) => void;
}

export async function runReviewEvalCase(opts: RunReviewEvalCaseOptions): Promise<ReviewEvalRecord> {
  const log = opts.logger ?? (() => undefined);
  const started = Date.now();
  const stamp = formatRunnerStamp(runnerStamp(opts.runner));
  const finish = (partial: Omit<ReviewEvalRecord, "durationMs">): ReviewEvalRecord => ({
    ...partial,
    durationMs: Date.now() - started,
  });
  const baseRecord = {
    fixture: opts.fixture.name,
    half: opts.half,
    runner: opts.runner.name,
    runnerStamp: stamp,
    trial: opts.trial,
    contract: REVIEW_EVAL_CONTRACT,
    baseSha: "unknown",
    headSha: "unknown",
  } as const;

  let homeDir = "";
  let workdir = "";
  try {
    homeDir = await mkdtemp(join(opts.homeRoot, "review-eval-home-"));
    workdir = await mkdtemp(join(opts.workdirRoot, "review-eval-work-"));

    // Checkout: base from `repo/`, head by overlaying the half dir. Both are
    // real commits so base reads (`git show <base>:REVIEW.md`) see the base.
    // Commit messages and branch names are neutral and identical for both
    // halves: nothing the model can read (git log, branches) leaks the half.
    await runPlainGit(["init"], workdir, homeDir);
    await runPlainGit(["config", "user.name", "jumi"], workdir, homeDir);
    await runPlainGit(["config", "user.email", "jumi@localhost"], workdir, homeDir);
    await cp(opts.fixture.repoDir, workdir, { recursive: true });
    await runPlainGit(["add", "-A"], workdir, homeDir);
    await runPlainGit(["commit", "-m", REVIEW_EVAL_BASE_COMMIT_MESSAGE], workdir, homeDir);
    const baseSha = await runPlainGit(["rev-parse", "HEAD"], workdir, homeDir);
    const halfDir = opts.half === "defective" ? opts.fixture.defectiveDir : opts.fixture.repairedDir;
    await cp(halfDir, workdir, { recursive: true });
    await runPlainGit(["add", "-A"], workdir, homeDir);
    const headStatus = await runPlainGit(["status", "--porcelain"], workdir, homeDir);
    if (headStatus.trim()) {
      await runPlainGit(["commit", "-m", REVIEW_EVAL_HEAD_COMMIT_MESSAGE], workdir, homeDir);
    }
    const headSha = await runPlainGit(["rev-parse", "HEAD"], workdir, homeDir);
    await runPlainGit(["branch", "--force", REVIEW_EVAL_TARGET_BRANCH, baseSha], workdir, homeDir);

    const prFiles = await buildPullFiles(workdir, baseSha, headSha, homeDir);
    const env = gitEnv(homeDir);

    // Same REVIEW.md selection as production: sections from the base commit.
    const reviewMd = await loadReviewMdSectionsFromBase({
      git: (args, runOpts) => runGit(args, { cwd: runOpts.cwd, env: runOpts.env }),
      cwd: workdir,
      env,
      baseRef: baseSha,
      files: prFiles.map((file) => ({
        filename: file.filename,
        status:
          file.status === "added"
            ? ("added" as const)
            : file.status === "deleted"
              ? ("deleted" as const)
              : ("modified" as const),
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        ...(file.patch ? { patch: file.patch } : {}),
      })),
    });

    // Same base-branch instructions as production: AGENTS.md/CLAUDE.md plus
    // skills, staged outside the tracked checkout. The head never configures
    // its reviewer.
    const baseInstructionsDir = join(workdir, ".jumi-tmp", "base-instructions");
    let baseInstructions: { text: string; truncated: boolean } | undefined;
    try {
      await stageBaseReviewInstructions(
        {
          git: (args, runOpts) => runGit(args, { cwd: runOpts.cwd, env: runOpts.env }),
          cwd: workdir,
          env,
          baseRef: baseSha,
        },
        baseInstructionsDir,
        {}
      );
      const parts: string[] = [];
      for (const name of ["AGENTS.md", "CLAUDE.md"] as const) {
        const text = await readStagedBaseFile(baseInstructionsDir, name);
        if (text?.trim()) parts.push(text.trim());
      }
      if (parts.length > 0) baseInstructions = { text: parts.join("\n\n"), truncated: false };
    } catch (err) {
      log(`base instructions unavailable: ${errorMessage(err)}`);
    }

    const repo = {
      name: opts.fixture.repo,
      full_name: `${opts.fixture.owner}/${opts.fixture.repo}`,
      html_url: `https://eval.invalid/${opts.fixture.owner}/${opts.fixture.repo}`,
      clone_url: `https://eval.invalid/${opts.fixture.owner}/${opts.fixture.repo}.git`,
      default_branch: opts.fixture.defaultBranch,
      owner: { login: opts.fixture.owner },
    };
    const pr = {
      number: opts.fixture.prNumber,
      title: opts.fixture.title,
      body: opts.fixture.body,
      state: "open" as const,
      html_url: `https://eval.invalid/${opts.fixture.owner}/${opts.fixture.repo}/pulls/${opts.fixture.prNumber}`,
      user: { login: opts.fixture.author },
      head: {
        ref: `jumi/pr-${opts.fixture.prNumber}`,
        sha: headSha,
        repo: { full_name: `${opts.fixture.owner}/${opts.fixture.repo}` },
      },
      base: { ref: opts.fixture.defaultBranch, sha: baseSha },
      merged: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const prompt = buildPROpenedPrompt({
      repo,
      pr,
      prFiles: prFiles.map((file) => ({
        filename: file.filename,
        status: file.status === "added" || file.status === "deleted" ? file.status : "modified",
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        ...(file.patch ? { patch: file.patch } : {}),
      })),
      ...(reviewMd ? { reviewMd: { text: reviewMd.text, truncated: reviewMd.truncated } } : {}),
      ...(baseInstructions ? { baseInstructions } : {}),
      runnerType: opts.runner.type,
    });

    // Per-attempt contract, pinned to required the way production pins it
    // for every pinned runner type. A failure never reselects: the attempt
    // keeps the contract it started with.
    const selected = resolveReviewVerdictContract({ runnerType: opts.runner.type, explicit: REVIEW_EVAL_CONTRACT });
    if (selected !== REVIEW_EVAL_CONTRACT) {
      throw new Error(`review eval refuses non-required contract: ${selected}`);
    }

    const verdictStore = new ReviewVerdictStore({
      changedFiles: prFiles.map((file) => ({ filename: file.filename, ...(file.patch ? { patch: file.patch } : {}) })),
    });
    const reviewMcpToken = randomReviewMcpToken();
    const reviewMcpServer = await startReviewMcpServer({ store: verdictStore, token: reviewMcpToken });
    try {
      await ensureEngineScratchIgnored(workdir);
      // The legacy file artifact never publishes in required mode. Clear a
      // stale file so it cannot count as this run's output, and never read
      // it afterwards: the store wins by construction.
      await rm(join(workdir, "JUMI_REVIEW.md"), { recursive: true, force: true }).catch(() => undefined);
      await writeFile(join(workdir, "JUMI_TASK.md"), prompt, "utf8");

      const previousHome = process.env.HOME;
      let capturedUsage: unknown;
      process.env.HOME = homeDir;
      try {
        const engine: Engine = opts.engine ?? registeredEngine;
        const result = await engine({
          type: opts.runner.type,
          model: opts.runner.model,
          ...("variant" in opts.runner && opts.runner.variant ? { variant: opts.runner.variant as string } : {}),
          ...("effort" in opts.runner && (opts.runner as { effort?: string }).effort
            ? { effort: (opts.runner as { effort?: string }).effort as string }
            : {}),
          workdir,
          home: homeDir,
          sanitizeEnv: true,
          timeoutMs: opts.timeoutMs,
          // Neutral label: the half name appears nowhere the model can read
          // (the fixture name is identical for both halves, so it leaks nothing
          // about defective vs repaired).
          reviewLabel: `review-eval:${opts.fixture.name}:${opts.runner.name}`,
          logger: log,
          trace: { kind: "review", owner: opts.fixture.owner, repo: opts.fixture.repo, sha: headSha },
          baseInstructionsDir,
          reviewMcp: { url: reviewMcpServer.url, token: reviewMcpToken },
          verdictContract: REVIEW_EVAL_CONTRACT,
        });
        if (result.status === "stuck" && typeof result.message === "string" && isQuotaText(result.message)) {
          throw new Error(result.message);
        }
        throwIfEngineFailed(result);
        capturedUsage = (result as { usage?: unknown }).usage;
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }

      await rm(join(workdir, "JUMI_TASK.md"), { recursive: true, force: true }).catch(() => undefined);

      // Post-run inspection is fail-closed: a HEAD read or a status read that
      // fails grades `inconclusive` with its own reason instead of
      // substituting the expected SHA or an empty status (which would read a
      // broken worktree as "reviewer did not touch the tree").
      let headAfter: string | null = null;
      try {
        headAfter = await runPlainGit(["rev-parse", "HEAD"], workdir, homeDir);
      } catch (err) {
        const reason = `post-run HEAD read failed: ${errorMessage(err)}`.slice(0, 500);
        return finish({
          ...baseRecord,
          baseSha,
          headSha,
          verdict: "inconclusive",
          failedAssertions: [],
          reviewState: "skip",
          findingsCount: 0,
          blockingCount: 0,
          rawMarkdown: "",
          treeClean: false,
          maintainerHolds: true,
          inconclusiveReason: reason,
          jobReason: reason,
        });
      }
      let porcelain: string | null = null;
      try {
        porcelain = await runPlainGit(["status", "--porcelain"], workdir, homeDir);
      } catch (err) {
        const reason = `post-run status failed: ${errorMessage(err)}`.slice(0, 500);
        return finish({
          ...baseRecord,
          baseSha,
          headSha,
          verdict: "inconclusive",
          failedAssertions: [],
          reviewState: "skip",
          findingsCount: 0,
          blockingCount: 0,
          rawMarkdown: "",
          treeClean: false,
          maintainerHolds: true,
          inconclusiveReason: reason,
          jobReason: reason,
        });
      }
      const headUnchanged = (headAfter ?? "").trim().toLowerCase() === headSha.toLowerCase();
      const treeClean = headUnchanged && porcelainTreeClean(porcelain ?? "");

      const storedVerdict = verdictStore.getVerdict();
      const findings = verdictStore.listFindings();
      const markdown = verdictStore.toMarkdown();
      const reviewState = storedVerdict?.state ?? "incomplete";
      const blockingCount = findings.filter(
        (finding) => finding.severity === "bug" || finding.severity === "risk"
      ).length;
      const maintainerHolds = maintainerHoldsForFindings(findings);
      const failedAssertions: string[] = [];

      if (!headUnchanged) failedAssertions.push("head-unchanged");
      if (!treeClean) failedAssertions.push("tree-clean");
      if (!maintainerHolds) failedAssertions.push("maintainer-holds");

      if (opts.half === "defective") {
        if (reviewState !== "failure") failedAssertions.push("defective-verdict");
        const blocking = findings.filter((finding) => finding.severity === "bug" || finding.severity === "risk");
        const anchored = blocking.filter((finding) => findingInAnchors(finding, opts.fixture.anchors));
        if (anchored.length === 0) failedAssertions.push("defect-anchor");
        const named = anchored.filter((finding) => {
          const text = `${finding.title ?? ""}\n${finding.body ?? ""}`.toLowerCase();
          return opts.fixture.mustContain.every((token) => text.includes(token.toLowerCase()));
        });
        if (named.length === 0) failedAssertions.push("defect-text");
      } else {
        if (reviewState !== "success") failedAssertions.push("repaired-verdict");
        if (blockingCount > 0) failedAssertions.push("repaired-blocking");
      }

      // In required mode a missing verdict or a failure verdict with no
      // actionable blocking finding is incomplete, mirroring the live
      // publisher: never publish the legacy file.
      if (reviewState === "incomplete") {
        if (!failedAssertions.includes("defective-verdict") && !failedAssertions.includes("repaired-verdict")) {
          failedAssertions.push(opts.half === "defective" ? "defective-verdict" : "repaired-verdict");
        }
      }
      if (reviewState === "failure" && blockingCount === 0) {
        if (opts.half === "defective" && !failedAssertions.includes("defect-anchor")) {
          failedAssertions.push("defect-anchor");
        }
      }

      const usage: unknown = capturedUsage;
      return finish({
        ...baseRecord,
        baseSha,
        headSha,
        verdict: failedAssertions.length === 0 ? "pass" : "fail",
        failedAssertions,
        reviewState,
        findingsCount: findings.length,
        blockingCount,
        rawMarkdown: markdown,
        treeClean,
        maintainerHolds,
        ...(usage !== undefined ? { usage } : {}),
      });
    } finally {
      verdictStore.close();
      reviewMcpServer.close();
    }
  } catch (err) {
    const message = errorMessage(err);
    if (err instanceof EngineFailedError) {
      if (err.auth || isQuotaError(err) || isQuotaText(message)) {
        return finish({
          ...baseRecord,
          verdict: "inconclusive",
          failedAssertions: [],
          reviewState: "skip",
          findingsCount: 0,
          blockingCount: 0,
          rawMarkdown: "",
          treeClean: true,
          maintainerHolds: true,
          inconclusiveReason: message,
          jobReason: message,
        });
      }
    }
    if (isQuotaText(message) || isInconclusiveText(message)) {
      return finish({
        ...baseRecord,
        verdict: "inconclusive",
        failedAssertions: [],
        reviewState: "skip",
        findingsCount: 0,
        blockingCount: 0,
        rawMarkdown: "",
        treeClean: true,
        maintainerHolds: true,
        inconclusiveReason: message,
        jobReason: message,
      });
    }
    return finish({
      ...baseRecord,
      verdict: "inconclusive",
      failedAssertions: [],
      reviewState: "skip",
      findingsCount: 0,
      blockingCount: 0,
      rawMarkdown: "",
      treeClean: true,
      maintainerHolds: true,
      inconclusiveReason: `harness crash: ${message}`,
      jobReason: message,
    });
  }
}

export interface RunReviewEvalOptions {
  fixtures: LoadedReviewEvalFixture[];
  halves: ReviewEvalHalf[];
  runners: NamedRunner[];
  trials: number;
  outDir: string;
  workdirRoot: string;
  homeRoot: string;
  engineForRunner?: (runner: NamedRunner) => Engine;
  timeoutMs?: number;
  logger?: (message: string) => void;
}

export async function runReviewEval(opts: RunReviewEvalOptions): Promise<ReviewEvalRecord[]> {
  await mkdir(opts.outDir, { recursive: true });
  const log = opts.logger ?? (() => undefined);
  const records: ReviewEvalRecord[] = [];
  const lines: string[] = [];
  const flush = async () => {
    await writeFile(join(opts.outDir, "results.jsonl"), `${lines.join("\n")}\n`);
  };
  for (const fixture of opts.fixtures) {
    for (const half of opts.halves) {
      for (const runner of opts.runners) {
        for (let trial = 1; trial <= opts.trials; trial++) {
          let record: ReviewEvalRecord;
          try {
            record = await runReviewEvalCase({
              fixture,
              half,
              runner,
              trial,
              workdirRoot: opts.workdirRoot,
              homeRoot: opts.homeRoot,
              ...(opts.engineForRunner ? { engine: opts.engineForRunner(runner) } : {}),
              ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
              logger: log,
            });
          } catch (err) {
            const message = errorMessage(err);
            record = {
              fixture: fixture.name,
              half,
              runner: runner.name,
              runnerStamp: formatRunnerStamp(runnerStamp(runner)),
              trial,
              verdict: "inconclusive",
              failedAssertions: [],
              reviewState: "skip",
              findingsCount: 0,
              blockingCount: 0,
              rawMarkdown: "",
              contract: REVIEW_EVAL_CONTRACT,
              treeClean: true,
              maintainerHolds: true,
              baseSha: "unknown",
              headSha: "unknown",
              durationMs: 0,
              inconclusiveReason: `harness crash: ${message}`,
              jobReason: message,
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

function printReviewEvalHelp(): void {
  console.log(`jumi review eval: run paired review fixtures through the production review path
without publishing. Operator-run only; nothing is scheduled.

Usage:
  bun run src/review_eval.ts --out <output-dir> [--fixture <name>] [--half defective|repaired] [--runners <name1,name2>] [--trials <n>]

Fixtures are committed under src/eval_fixtures/<name>/. Each record in
<out>/results.jsonl carries fixture, half, runner, trial, verdict
(pass / fail / inconclusive), failed assertion names, the recorded review
state (success / failure), finding counts, the required-contract marker,
tree-clean and maintainer-hold checks, and duration. Auth, quota,
timeouts and harness crashes record inconclusive, never fail.
The first real-model runs are operator-run; no CI wiring in this change.`);
}

function parseReviewEvalArgs(argv: string[]): {
  out?: string;
  fixture?: string;
  half?: ReviewEvalHalf;
  runners?: string[];
  trials: number;
  help: boolean;
} {
  let out: string | undefined;
  let fixture: string | undefined;
  let half: ReviewEvalHalf | undefined;
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
    else if (arg === "--half" && i + 1 < argv.length) {
      const value = argv[++i];
      if (value === "defective" || value === "repaired") half = value;
      else throw new Error(`Invalid --half ${value} (want defective|repaired)`);
    } else if (arg.startsWith("--half=")) {
      const value = arg.slice("--half=".length);
      if (value === "defective" || value === "repaired") half = value;
      else throw new Error(`Invalid --half ${value} (want defective|repaired)`);
    } else if (arg === "--runners" && i + 1 < argv.length) {
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
  return { out, fixture, runners, trials, help, ...(half ? { half } : {}) };
}

function loadReviewEvalCliRunners(runnerNames: string[] | undefined): NamedRunner[] {
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
  const args = parseReviewEvalArgs(process.argv.slice(2));
  if (args.help) {
    printReviewEvalHelp();
    return;
  }
  if (!args.out) {
    printReviewEvalHelp();
    throw new Error("Missing required --out");
  }
  const env = process.env as Record<string, string | undefined>;
  const allNames = await listReviewEvalFixtures();
  const names = args.fixture ? [args.fixture] : allNames;
  const fixtures: LoadedReviewEvalFixture[] = [];
  for (const name of names) {
    fixtures.push(await loadReviewEvalFixture(name));
  }
  const runners = loadReviewEvalCliRunners(args.runners);
  const halves: ReviewEvalHalf[] = args.half ? [args.half] : ["defective", "repaired"];
  const workdirRoot = join(env.WORKDIR ?? "/work", "jumi-review-eval");
  const homeRoot = env.HOME?.trim() ? env.HOME : "/data";
  const records = await runReviewEval({
    fixtures,
    halves,
    runners,
    trials: args.trials,
    outDir: args.out,
    workdirRoot,
    homeRoot: join(homeRoot, "jumi-review-eval-homes"),
    logger: (message) => console.log(`[review-eval] ${message}`),
  });
  const summary = records.map((r) => `${r.fixture}/${r.half}/${r.runner}#${r.trial}:${r.verdict}`).join(" ");
  console.log(`[review-eval] done: ${records.length} records -> ${args.out}/results.jsonl ${summary}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[review-eval] ${errorMessage(err)}`);
    process.exit(1);
  });
}
