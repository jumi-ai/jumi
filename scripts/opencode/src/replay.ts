import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CI_ABSENT_NOTE, type CiCheckSummary, inspectCi, reviewSkipReasonForCi } from "./ci.ts";
import { type Engine, type EngineRunOptions, throwIfEngineFailed } from "./engine.ts";
import { registeredEngine } from "./engine_dispatch.ts";
import { ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { hasResumableSession, withEngineChain } from "./fallback.ts";
import { createForge, type ForgeKind, parseForge } from "./forge.ts";
import { extractClosingIssueNumbers } from "./gitea_issues.ts";
import { resolvePermissions } from "./permissions.ts";
import type { Comment, InlineComment, Pull, PullFile, PullReview, Repo, ReviewApi, Task } from "./ports.ts";
import {
  buildIncompleteWritePrompt,
  buildNoFindingsWritePrompt,
  buildNoTrailerWritePrompt,
  buildPROpenedPrompt,
} from "./prompt.ts";
import { isQuotaError, isQuotaText, QUOTA_STUCK_TEXT } from "./quota.ts";
import { DEFAULT_MAX_THREAD_BYTES, fitReviewThread, mapReviewThread } from "./review_context.ts";
import { findPreviousReview, loadReviewDelta } from "./review_delta.ts";
import { DEFAULT_MAX_REVIEW_MD_BYTES, loadReviewMdSections } from "./review_md.ts";
import { formatRunnerStamp, loadRunnersCatalog, type NamedRunner, orderedRunners, runnerStamp } from "./runners.ts";
import { hasPublishedFindings, keepReviewFindingLines, parseReviewFindings, parseReviewOutput } from "./verdict.ts";
import {
  checkoutPullRequestWorkspace,
  type GitAuthResolver,
  type GitRunner,
  gitConfigArgs,
  gitEnv,
  gitRemoteUrl,
  runGit,
  validateCloneUrl,
} from "./workspace.ts";

/**
 * One-shot replay of past reviews on chosen runners, without any forge write.
 *
 * Input is a case file (JSON) plus runner names. Each case names the forge,
 * owner/repo, and either a PR number or a pinned base SHA plus head SHA, with
 * an optional note. For each case and runner the mode runs the normal review
 * prompt (same prompt builder, skills, REVIEW.md selection, and runner
 * settings the live reviewer would use) on the pinned base and head, and
 * writes one record per case and runner to a local output directory as JSONL
 * plus the raw review text.
 *
 * Scoring stays outside Jumi: an operator compares the records to the expected
 * defects.
 *
 * Guarantees, enforced in code rather than in the prompt:
 * - No forge write: the replay API type only exposes reads, and the runtime
 *   guard throws on any write method. A read-only token is enough.
 * - Quota: a quota hit records a skip and moves on. Never sleeps for hours.
 * - Runs where reviews run: `bun run src/replay.ts` works in the existing
 *   reviewer image, so a Kubernetes Job can run it. No new service.
 */

export class ReplayWriteBlockedError extends Error {
  constructor(method: string) {
    super(`replay refuses forge write: ${method}`);
    this.name = "ReplayWriteBlockedError";
  }
}

/** Forge writes the replay path must never reach. */
export const REPLAY_WRITE_METHODS = [
  "createIssueComment",
  "updateIssueComment",
  "createPullReview",
  "submitPullReview",
  "resolvePullComment",
  "unresolvePullComment",
  "dismissPullReview",
  "createCommitStatus",
] as const;

export type ReplayWriteMethod = (typeof REPLAY_WRITE_METHODS)[number];

/** Reads the replay path may use. Writes are absent by construction. */
export type ReplayReadApi = Pick<
  ReviewApi,
  | "getRepo"
  | "getPR"
  | "getPRFiles"
  | "listIssueComments"
  | "findStickyIssueComment"
  | "listPullReviewComments"
  | "listPullReviews"
  | "listCommitStatuses"
  | "listCheckRuns"
  | "listActionJobs"
  | "getActionJobLogs"
  | "getCollaboratorPermission"
  | "getAppPermissions"
  | "getIssue"
>;

const WRITE_METHOD_SET = new Set<string>(REPLAY_WRITE_METHODS);

/** Wrap a full forge client so any write attempt throws instead of publishing. */
export function makeReplayReadOnly(api: ReviewApi): ReplayReadApi {
  const read: ReplayReadApi = {
    getRepo: api.getRepo.bind(api),
    getPR: api.getPR.bind(api),
    getPRFiles: api.getPRFiles.bind(api),
    listIssueComments: api.listIssueComments.bind(api),
    findStickyIssueComment: api.findStickyIssueComment?.bind(api) as ReplayReadApi["findStickyIssueComment"],
    listPullReviewComments: api.listPullReviewComments.bind(api),
    listPullReviews: api.listPullReviews.bind(api),
    listCommitStatuses: api.listCommitStatuses.bind(api),
    listCheckRuns: api.listCheckRuns.bind(api),
    listActionJobs: api.listActionJobs.bind(api),
    getActionJobLogs: api.getActionJobLogs.bind(api),
    getCollaboratorPermission: api.getCollaboratorPermission.bind(api),
    ...(api.getAppPermissions ? { getAppPermissions: api.getAppPermissions.bind(api) } : {}),
    getIssue: api.getIssue.bind(api),
  };
  return new Proxy(read, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && WRITE_METHOD_SET.has(prop)) {
        return () => {
          throw new ReplayWriteBlockedError(prop);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export interface ReplayCase {
  id: string;
  forge?: string;
  owner: string;
  repo: string;
  prNumber?: number;
  baseSha?: string;
  headSha?: string;
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid replay case file: ${message}`);
}

function parseCase(value: unknown, index: number): ReplayCase {
  if (!isRecord(value)) fail(`cases[${index}] must be an object`);
  const raw = value as Record<string, unknown>;
  const owner = typeof raw.owner === "string" ? raw.owner.trim() : "";
  const repo = typeof raw.repo === "string" ? raw.repo.trim() : "";
  if (!owner || owner.includes("/") || owner === "." || owner === "..") fail(`cases[${index}] missing owner`);
  if (!repo || repo.includes("/") || repo === "." || repo === "..") fail(`cases[${index}] missing repo`);
  const prRaw = raw.prNumber ?? raw.pr ?? raw.number;
  let prNumber: number | undefined;
  if (prRaw != null) {
    const n = typeof prRaw === "string" && prRaw.trim() !== "" ? Number(prRaw) : (prRaw as number);
    if (!Number.isInteger(n) || (n as number) <= 0) fail(`cases[${index}] invalid prNumber`);
    prNumber = n as number;
  }
  const baseRaw = raw.baseSha ?? raw.base;
  const headRaw = raw.headSha ?? raw.head;
  let baseSha: string | undefined;
  let headSha: string | undefined;
  if (baseRaw != null || headRaw != null) {
    if (typeof baseRaw !== "string" || !SHA_RE.test(baseRaw.trim())) fail(`cases[${index}] invalid baseSha`);
    if (typeof headRaw !== "string" || !SHA_RE.test(headRaw.trim())) fail(`cases[${index}] invalid headSha`);
    baseSha = baseRaw.trim().toLowerCase();
    headSha = headRaw.trim().toLowerCase();
  }
  if (prNumber == null && (baseSha == null || headSha == null)) {
    fail(`cases[${index}] needs either prNumber or baseSha plus headSha`);
  }
  const idRaw = raw.id ?? raw.caseId ?? raw.name;
  const id =
    typeof idRaw === "string" && idRaw.trim() ? idRaw.trim() : prNumber != null ? `pr-${prNumber}` : `case-${index}`;
  const forge = typeof raw.forge === "string" && raw.forge.trim() ? raw.forge.trim().toLowerCase() : undefined;
  if (forge && forge !== "gitea" && forge !== "github") fail(`cases[${index}] invalid forge ${forge}`);
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note : undefined;
  const parsed: ReplayCase = { id, owner, repo, ...(forge ? { forge } : {}) };
  if (prNumber != null) parsed.prNumber = prNumber;
  if (baseSha) parsed.baseSha = baseSha;
  if (headSha) parsed.headSha = headSha;
  if (note) parsed.note = note;
  return parsed;
}

/**
 * Parse a case file: either `{ "cases": [...] }` or a bare array. Each case
 * names owner/repo plus either prNumber or baseSha plus headSha.
 */
export function parseReplayCases(raw: unknown): ReplayCase[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.cases) ? raw.cases : null;
  if (!list) fail("expected an array or { cases: [...] }");
  if (list.length === 0) fail("no cases");
  return list.map((entry, index) => parseCase(entry, index));
}

export function parseReplayCaseFileText(text: string): ReplayCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseReplayCases(parsed);
}

export type ReplayVerdict = "success" | "failure" | "skip";

export interface ReplayRecord {
  caseId: string;
  forge: string;
  owner: string;
  repo: string;
  prNumber: number | null;
  baseSha: string;
  headSha: string;
  note?: string;
  runner: string;
  runnerStamp: string;
  verdict: ReplayVerdict;
  findings: string;
  findingsCount: number;
  rawMarkdown: string;
  durationMs: number;
  skipReason?: string;
  quota?: boolean;
}

export interface ReplayWorkspacePreparerOptions {
  workdir: string;
  repo: Repo;
  pr: Pull;
  giteaUrl: string;
  username: string;
  token: string;
  logger?: (message: string) => void;
}

export type ReplayWorkspacePreparer = (opts: ReplayWorkspacePreparerOptions) => Promise<void>;

export interface RunReplayCaseOptions {
  api: ReplayReadApi;
  reviewCase: ReplayCase;
  runner: NamedRunner;
  workdirRoot: string;
  engine?: Engine;
  gitRunner?: GitRunner;
  workspacePreparer?: ReplayWorkspacePreparer;
  gitAuthResolver?: GitAuthResolver;
  createWorkspace?: (root: string) => Promise<string>;
  giteaUrl: string;
  giteaToken: string;
  botUsername: string;
  forgeKind?: string;
  blockingQuestionAuthors?: readonly string[];
  home?: string;
  maxFiles?: number;
  maxPatchBytes?: number;
  maxThreadBytes?: number;
  maxReviewMdBytes?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  maxIncompleteRetries?: number;
  logger?: (message: string) => void;
}

const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_PATCH_BYTES = 500_000;
const DEFAULT_MAX_OUTPUT_BYTES = 80_000;
const DEFAULT_MAX_INCOMPLETE_RETRIES = 2;

function logDefault(message: string): void {
  console.log(`[replay] ${message}`);
}

function skipReasonForPrState(pr: Pull): string | undefined {
  if (pr.state !== "open") return `PR is ${pr.state}`;
  if (pr.merged) return "PR is already merged";
  if (/^\s*(wip|\[wip\])/i.test(pr.title)) return "PR title disables review";
  return undefined;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function prepareReplayFiles(
  files: PullFile[],
  maxFiles: number,
  maxPatchBytes: number
): { files: PullFile[]; notes: string[] } {
  const notes: string[] = [];
  const selected = files.slice(0, maxFiles);
  if (files.length > selected.length) {
    notes.push(`Only the first ${selected.length} of ${files.length} changed files are included.`);
  }
  let remaining = maxPatchBytes;
  const prepared = selected.map((file) => {
    if (!file.patch) return file;
    const bytes = byteLength(file.patch);
    if (bytes <= remaining) {
      remaining -= bytes;
      return file;
    }
    if (remaining <= 0) {
      notes.push(`Patch for ${file.filename} was omitted because the patch budget was exhausted.`);
      return { ...file, patch: undefined };
    }
    const truncated = new TextDecoder().decode(new TextEncoder().encode(file.patch).slice(0, remaining));
    notes.push(`Patch for ${file.filename} was truncated to fit the patch budget.`);
    remaining = 0;
    return { ...file, patch: `${truncated}\n[patch truncated]` };
  });
  return { files: prepared, notes };
}

interface ReplayGitFiles {
  files: PullFile[];
}

function parseNumstat(output: string): Array<{ path: string; additions: number; deletions: number }> {
  const out: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const record of output.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record.replace(/^\n+/, ""));
    if (!match) continue;
    out.push({
      path: match[3],
      additions: match[1] === "-" ? 0 : Number.parseInt(match[1], 10),
      deletions: match[2] === "-" ? 0 : Number.parseInt(match[2], 10),
    });
  }
  return out;
}

function statusFromPatch(patch: string): PullFile["status"] {
  const header = patch.split("\n@@", 1)[0];
  if (/^new file mode /m.test(header)) return "added";
  if (/^deleted file mode /m.test(header)) return "deleted";
  return "modified";
}

async function filesViaGit(opts: {
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  baseSha: string;
  headSha: string;
  maxFiles: number;
  maxPatchBytes: number;
}): Promise<ReplayGitFiles> {
  const run = (args: string[]) => opts.git(args, { cwd: opts.cwd, env: opts.env });
  const numstat = await run([
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--numstat",
    "-z",
    opts.baseSha,
    opts.headSha,
  ]);
  const entries = parseNumstat(numstat);
  const files: PullFile[] = [];
  let remaining = opts.maxPatchBytes;
  const capped = entries.slice(0, opts.maxFiles);
  for (const entry of capped) {
    let patch: string | undefined;
    try {
      const raw = await run([
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        opts.baseSha,
        opts.headSha,
        "--",
        `:(literal)${entry.path}`,
      ]);
      const trimmed = raw.trimEnd();
      if (trimmed && byteLength(trimmed) <= remaining) {
        patch = trimmed;
        remaining -= byteLength(trimmed);
      } else if (trimmed) {
        patch = undefined;
      }
    } catch {
      patch = undefined;
    }
    files.push({
      filename: entry.path,
      status: patch ? statusFromPatch(patch) : "modified",
      additions: entry.additions,
      deletions: entry.deletions,
      changes: entry.additions + entry.deletions,
      ...(patch ? { patch } : {}),
    });
  }
  return { files };
}

function assertSha(value: string, label: string): string {
  if (!SHA_RE.test(value)) throw new Error(`Invalid ${label} SHA: ${value}`);
  return value.toLowerCase();
}

async function checkoutReplayShas(opts: {
  workdir: string;
  repo: Repo;
  baseSha: string;
  headSha: string;
  giteaUrl: string;
  username: string;
  token: string;
  logger?: (message: string) => void;
}): Promise<void> {
  const configArgs = gitConfigArgs();
  const auth = { giteaUrl: opts.giteaUrl, username: opts.username, token: opts.token };
  const env = gitEnv(auth);
  const run = (args: string[], cwd: string) => runGit([...configArgs, ...args], { cwd, env });
  const baseSha = assertSha(opts.baseSha, "replay base");
  const headSha = assertSha(opts.headSha, "replay head");
  const cloneUrl = validateCloneUrl(opts.repo.clone_url, opts.giteaUrl);
  const parent = dirname(opts.workdir);
  await mkdir(parent, { recursive: true });
  await rm(opts.workdir, { recursive: true, force: true });
  opts.logger?.(`Cloning ${opts.repo.full_name} for replay`);
  await run(["clone", gitRemoteUrl(cloneUrl, auth), opts.workdir], parent);
  await run(["branch", "--force", "jumi/target", baseSha], opts.workdir);
  await run(["checkout", "--force", "-B", "jumi/pr-replay", headSha], opts.workdir);
  const checkedOut = (await run(["rev-parse", "HEAD"], opts.workdir)).trim();
  if (checkedOut.toLowerCase() !== headSha)
    throw new Error(`Checked out ${checkedOut}, expected replay head ${headSha}`);
  const checkedOutBase = (await run(["rev-parse", "jumi/target"], opts.workdir)).trim();
  if (checkedOutBase.toLowerCase() !== baseSha) {
    throw new Error(`Target ref jumi/target is ${checkedOutBase}, expected ${baseSha}`);
  }
  await ensureEngineScratchIgnored(opts.workdir);
}

type ReplayArtifactRead = { status: "ok"; content: string } | { status: "missing" } | { status: "too_large" };

async function readReplayArtifact(workdir: string, maxOutputBytes: number): Promise<ReplayArtifactRead> {
  const path = join(workdir, "JUMI_REVIEW.md");
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { status: "missing" };
    if (info.size > maxOutputBytes) return { status: "too_large" };
    return { status: "ok", content: await readFile(path, "utf8") };
  } catch {
    return { status: "missing" };
  }
}

function sanitizeFileSegment(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return clean || "case";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function quotaSkip(reason: string): string {
  return isQuotaText(reason) ? QUOTA_STUCK_TEXT : reason;
}

export async function runReplayCase(opts: RunReplayCaseOptions): Promise<ReplayRecord> {
  const log = opts.logger ?? logDefault;
  const started = Date.now();
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxPatchBytes = opts.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxThreadBytes = opts.maxThreadBytes ?? DEFAULT_MAX_THREAD_BYTES;
  const maxReviewMdBytes = opts.maxReviewMdBytes ?? DEFAULT_MAX_REVIEW_MD_BYTES;
  const maxIncompleteRetries = opts.maxIncompleteRetries ?? DEFAULT_MAX_INCOMPLETE_RETRIES;
  const reviewCase = opts.reviewCase;
  const runner = opts.runner;
  const stamp = formatRunnerStamp(runnerStamp(runner));
  const finish = (partial: Omit<ReplayRecord, "durationMs">): ReplayRecord => ({
    ...partial,
    durationMs: Date.now() - started,
  });

  const repo = await opts.api.getRepo(reviewCase.owner, reviewCase.repo);
  let pr: Pull | null = null;
  if (reviewCase.prNumber != null) {
    pr = await opts.api.getPR(reviewCase.owner, reviewCase.repo, reviewCase.prNumber);
  }
  if (pr) {
    const stateSkip = skipReasonForPrState(pr);
    if (stateSkip) {
      return finish({
        caseId: reviewCase.id,
        forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
        owner: reviewCase.owner,
        repo: reviewCase.repo,
        prNumber: pr.number,
        baseSha: reviewCase.baseSha ?? pr.base.sha.toLowerCase(),
        headSha: reviewCase.headSha ?? pr.head.sha.toLowerCase(),
        ...(reviewCase.note ? { note: reviewCase.note } : {}),
        runner: runner.name,
        runnerStamp: stamp,
        verdict: "skip",
        findings: "",
        findingsCount: 0,
        rawMarkdown: "",
        skipReason: stateSkip,
      });
    }
  }

  const baseSha = (reviewCase.baseSha ?? pr?.base.sha ?? "").toLowerCase();
  const headSha = (reviewCase.headSha ?? pr?.head.sha ?? "").toLowerCase();
  if (!SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) {
    return finish({
      caseId: reviewCase.id,
      forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
      owner: reviewCase.owner,
      repo: reviewCase.repo,
      prNumber: pr?.number ?? reviewCase.prNumber ?? null,
      baseSha: baseSha || "unknown",
      headSha: headSha || "unknown",
      ...(reviewCase.note ? { note: reviewCase.note } : {}),
      runner: runner.name,
      runnerStamp: stamp,
      verdict: "skip",
      findings: "",
      findingsCount: 0,
      rawMarkdown: "",
      skipReason: "Incomplete review: missing base or head SHA",
    });
  }

  const effectivePr: Pull = pr
    ? {
        ...pr,
        head: { ...pr.head, sha: headSha },
        base: { ...pr.base, sha: baseSha },
      }
    : {
        number: 0,
        title: `Replay ${reviewCase.id}`,
        body: reviewCase.note ?? "",
        state: "open",
        html_url: "",
        user: { login: opts.botUsername },
        head: { ref: headSha, sha: headSha, repo: { full_name: `${reviewCase.owner}/${reviewCase.repo}` } },
        base: { ref: baseSha, sha: baseSha },
        merged: false,
        created_at: "",
        updated_at: "",
      };

  // CI is a read-only inspection. Pending/red/failed lookups record a skip and
  // never start the engine, mirroring the live reviewer's cheap skip. Never a
  // wait or retry: the record owns the skip reason.
  try {
    const ci = await inspectCi({
      api: opts.api,
      owner: reviewCase.owner,
      repo: reviewCase.repo,
      sha: headSha,
      home: opts.home ?? "",
      issueNumber: effectivePr.number,
      log,
    });
    const ciSkip = reviewSkipReasonForCi(ci);
    if (ciSkip) {
      return finish({
        caseId: reviewCase.id,
        forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
        owner: reviewCase.owner,
        repo: reviewCase.repo,
        prNumber: pr?.number ?? reviewCase.prNumber ?? null,
        baseSha,
        headSha,
        ...(reviewCase.note ? { note: reviewCase.note } : {}),
        runner: runner.name,
        runnerStamp: stamp,
        verdict: "skip",
        findings: "",
        findingsCount: 0,
        rawMarkdown: "",
        skipReason: ciSkip,
      });
    }
  } catch (err) {
    log(`replay CI inspect failed for ${reviewCase.id}: ${errorMessage(err)}`);
  }

  const workdir = opts.createWorkspace
    ? await opts.createWorkspace(opts.workdirRoot)
    : await mkdtemp(join(opts.workdirRoot, `jumi-replay-${sanitizeFileSegment(reviewCase.id)}-`));

  try {
    const gitAuth = opts.gitAuthResolver
      ? await opts.gitAuthResolver()
      : { giteaUrl: opts.giteaUrl, username: opts.botUsername, token: opts.giteaToken };
    const preparer = opts.workspacePreparer;
    if (preparer) {
      await preparer({
        workdir,
        repo,
        pr: effectivePr,
        giteaUrl: gitAuth.giteaUrl,
        username: gitAuth.username,
        token: gitAuth.token,
        logger: log,
      });
    } else if (pr) {
      await checkoutPullRequestWorkspace({
        workdir,
        repo,
        pr: effectivePr,
        giteaUrl: gitAuth.giteaUrl,
        username: gitAuth.username,
        token: gitAuth.token,
        logger: log,
      });
    } else {
      await checkoutReplayShas({
        workdir,
        repo,
        baseSha,
        headSha,
        giteaUrl: gitAuth.giteaUrl,
        username: gitAuth.username,
        token: gitAuth.token,
        logger: log,
      });
    }

    let prFiles: PullFile[] = [];
    if (pr) {
      prFiles = await opts.api.getPRFiles(reviewCase.owner, reviewCase.repo, pr.number);
    } else {
      const git = opts.gitRunner ?? runGit;
      const env: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        GIT_TERMINAL_PROMPT: "0",
      };
      const computed = await filesViaGit({ git, cwd: workdir, env, baseSha, headSha, maxFiles, maxPatchBytes });
      prFiles = computed.files;
    }

    const { files, notes: fileNotes } = prepareReplayFiles(prFiles, maxFiles, maxPatchBytes);
    const notes: string[] = [...fileNotes];
    let ciChecks: CiCheckSummary[] | undefined;
    try {
      const ci = await inspectCi({
        api: opts.api,
        owner: reviewCase.owner,
        repo: reviewCase.repo,
        sha: headSha,
        home: opts.home ?? "",
        issueNumber: effectivePr.number,
        log,
      });
      if (ci.checks.length > 0) ciChecks = ci.checks;
    } catch {
      // Prompt without CI block; the earlier skip already handled red/pending.
    }

    let prComments: Comment[] = [];
    let prReviews: PullReview[] = [];
    let prInlines: InlineComment[] = [];
    const linkedIssues: Array<{ issue: Task; comments: Comment[] }> = [];
    if (pr) {
      const [comments, reviews, inlines] = await Promise.all([
        opts.api.listIssueComments(reviewCase.owner, reviewCase.repo, pr.number).catch(() => [] as Comment[]),
        opts.api.listPullReviews(reviewCase.owner, reviewCase.repo, pr.number).catch(() => [] as PullReview[]),
        opts.api
          .listPullReviewComments(reviewCase.owner, reviewCase.repo, pr.number)
          .catch(() => [] as InlineComment[]),
      ]);
      prComments = comments;
      prReviews = reviews;
      prInlines = inlines;
      const ids = extractClosingIssueNumbers(effectivePr);
      for (const id of ids) {
        try {
          const [issue, issueComments] = await Promise.all([
            opts.api.getIssue(reviewCase.owner, reviewCase.repo, id),
            opts.api.listIssueComments(reviewCase.owner, reviewCase.repo, id),
          ]);
          linkedIssues.push({ issue, comments: issueComments });
        } catch (err) {
          notes.push(`Failed to load linked issue #${id}: ${errorMessage(err)}`);
        }
      }
      // No-CI note mirrors the live path when the lookup found no checks.
      try {
        const ci = await inspectCi({
          api: opts.api,
          owner: reviewCase.owner,
          repo: reviewCase.repo,
          sha: headSha,
          home: opts.home ?? "",
          issueNumber: effectivePr.number,
          log,
        });
        if (ci.empty && !ci.lookupFailed)
          notes.push(`${CI_ABSENT_NOTE} Mention it in the review. It is not a finding.`);
      } catch {
        // Best-effort note only.
      }
    } else if (reviewCase.note) {
      notes.push(reviewCase.note);
    } else if (effectivePr.body) {
      notes.push(effectivePr.body);
    }

    const botLower = opts.botUsername.trim().toLowerCase();
    const threadReviews = prReviews.filter((review) => (review.user?.login ?? "").toLowerCase() !== botLower);
    const threadInlines = prInlines.filter((comment) => (comment.user?.login ?? "").toLowerCase() !== botLower);
    const logins: Array<string | undefined> = [];
    for (const comment of prComments) logins.push(comment.user?.login);
    for (const linked of linkedIssues) {
      for (const comment of linked.comments) logins.push(comment.user?.login);
    }
    for (const review of threadReviews) logins.push(review.user?.login);
    for (const comment of threadInlines) {
      logins.push(comment.user?.login);
      if (comment.resolver?.login) logins.push(comment.resolver.login);
    }
    const resolved = await resolvePermissions(opts.api, reviewCase.owner, reviewCase.repo, logins);
    const thread = mapReviewThread({
      prComments,
      linkedIssues,
      pullReviews: threadReviews,
      reviewComments: threadInlines,
      permissions: resolved.writes,
      permissionDetail: resolved.detail,
    });
    const fitted = fitReviewThread(thread, maxThreadBytes);
    if (fitted.truncated) {
      notes.push(`Thread context truncated to maxThreadBytes (dropped ${fitted.droppedCommentBodies} comment bodies).`);
    }

    // Later-review delta only for PR cases with a previous Jumi review.
    let delta: Awaited<ReturnType<typeof loadReviewDelta>>;
    if (pr) {
      const previous = findPreviousReview({
        comments: prComments,
        reviews: prReviews,
        inlines: prInlines,
        botUsername: opts.botUsername,
        marker: `<!-- jumi-review:${reviewCase.owner}/${reviewCase.repo}#${pr.number} -->`,
      });
      if (previous) {
        const git = opts.gitRunner ?? runGit;
        const env: Record<string, string | undefined> = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          GIT_TERMINAL_PROMPT: "0",
        };
        const loaded = await loadReviewDelta({
          previous,
          headSha,
          pullFiles: prFiles,
          maxFiles,
          git,
          cwd: workdir,
          env,
          log,
        });
        if (loaded) delta = loaded;
      }
    }

    const reviewMd = await loadReviewMdSections(workdir, prFiles, maxReviewMdBytes);
    const prompt = buildPROpenedPrompt({
      repo,
      pr: effectivePr,
      prFiles: files,
      reviewNotes: notes,
      ...(ciChecks ? { ciResults: { headSha, checks: ciChecks } } : {}),
      thread: fitted.thread,
      ...(delta ? { delta } : {}),
      ...(reviewMd ? { reviewMd } : {}),
      blockingQuestions: (opts.blockingQuestionAuthors ?? []).some(
        (entry) => entry.trim().toLowerCase() === (effectivePr.user?.login ?? "").trim().toLowerCase()
      ),
    });

    const git = opts.gitRunner ?? runGit;
    const gitCmdEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      GIT_TERMINAL_PROMPT: "0",
    };

    const engine: Engine =
      opts.engine ??
      withEngineChain(registeredEngine, {
        chain: [runner],
        logger: log,
      });

    const runOnce = async (extra?: { prompt: string; continueSession: boolean }) => {
      await writeFile(join(workdir, "JUMI_TASK.md"), extra?.prompt ?? prompt);
      await ensureEngineScratchIgnored(workdir);
      const runOpts: EngineRunOptions = {
        type: runner.type,
        model: runner.model,
        ...(runner.type === "opencode"
          ? { variant: (runner as { variant?: string }).variant }
          : { effort: (runner as { effort?: string }).effort }),
        workdir,
        home: opts.home,
        sanitizeEnv: true,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes,
        reviewLabel: `replay:${reviewCase.id}:${runner.name}`,
        logger: log,
        ...(extra?.continueSession ? { continueSession: true } : {}),
        trace: {
          kind: "review",
          owner: reviewCase.owner,
          repo: reviewCase.repo,
          sha: headSha,
        },
      };
      const result = await engine(runOpts);
      // Quota is a recorded skip in replay, never a wait or retry.
      if (result.status === "stuck" && isQuotaText(result.message)) {
        throw new Error(QUOTA_STUCK_TEXT);
      }
      if (result.status !== "ok") {
        try {
          throwIfEngineFailed(result);
        } catch (err) {
          if (isQuotaError(err)) throw new Error(QUOTA_STUCK_TEXT);
          throw err;
        }
      }
      return result;
    };

    await rm(join(workdir, "JUMI_REVIEW.md"), { recursive: true, force: true }).catch(() => undefined);
    try {
      await runOnce();
    } catch (err) {
      const message = errorMessage(err);
      if (isQuotaText(message) || isQuotaError(err)) {
        return finish({
          caseId: reviewCase.id,
          forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
          owner: reviewCase.owner,
          repo: reviewCase.repo,
          prNumber: pr?.number ?? reviewCase.prNumber ?? null,
          baseSha,
          headSha,
          ...(reviewCase.note ? { note: reviewCase.note } : {}),
          runner: runner.name,
          runnerStamp: stamp,
          verdict: "skip",
          findings: "",
          findingsCount: 0,
          rawMarkdown: "",
          skipReason: QUOTA_STUCK_TEXT,
          quota: true,
        });
      }
      return finish({
        caseId: reviewCase.id,
        forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
        owner: reviewCase.owner,
        repo: reviewCase.repo,
        prNumber: pr?.number ?? reviewCase.prNumber ?? null,
        baseSha,
        headSha,
        ...(reviewCase.note ? { note: reviewCase.note } : {}),
        runner: runner.name,
        runnerStamp: stamp,
        verdict: "skip",
        findings: "",
        findingsCount: 0,
        rawMarkdown: "",
        skipReason: quotaSkip(message),
      });
    }

    let extrasUsed = 0;
    let lastStdout = "";
    while (true) {
      const headAfter = await git(["rev-parse", "HEAD"], { cwd: workdir, env: gitCmdEnv })
        .then((out) => out.trim().toLowerCase())
        .catch(() => headSha);
      if (headAfter !== headSha.toLowerCase()) {
        return finish({
          caseId: reviewCase.id,
          forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
          owner: reviewCase.owner,
          repo: reviewCase.repo,
          prNumber: pr?.number ?? reviewCase.prNumber ?? null,
          baseSha,
          headSha,
          ...(reviewCase.note ? { note: reviewCase.note } : {}),
          runner: runner.name,
          runnerStamp: stamp,
          verdict: "skip",
          findings: "",
          findingsCount: 0,
          rawMarkdown: "",
          skipReason: "Incomplete review: HEAD moved",
        });
      }
      const artifact = await readReplayArtifact(workdir, maxOutputBytes);
      if (artifact.status === "too_large") {
        return finish({
          caseId: reviewCase.id,
          forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
          owner: reviewCase.owner,
          repo: reviewCase.repo,
          prNumber: pr?.number ?? reviewCase.prNumber ?? null,
          baseSha,
          headSha,
          ...(reviewCase.note ? { note: reviewCase.note } : {}),
          runner: runner.name,
          runnerStamp: stamp,
          verdict: "skip",
          findings: "",
          findingsCount: 0,
          rawMarkdown: "",
          skipReason: "Incomplete review: output too large",
        });
      }
      if (artifact.status === "ok" && artifact.content.trim()) {
        const parsed = parseReviewOutput(artifact.content);
        if (parsed.verdict.incomplete) {
          if (extrasUsed >= maxIncompleteRetries) {
            return finish({
              caseId: reviewCase.id,
              forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
              owner: reviewCase.owner,
              repo: reviewCase.repo,
              prNumber: pr?.number ?? reviewCase.prNumber ?? null,
              baseSha,
              headSha,
              ...(reviewCase.note ? { note: reviewCase.note } : {}),
              runner: runner.name,
              runnerStamp: stamp,
              verdict: "skip",
              findings: "",
              findingsCount: 0,
              rawMarkdown: artifact.content,
              skipReason: "Incomplete review: no check verdict",
            });
          }
          extrasUsed++;
          await rm(join(workdir, "JUMI_REVIEW.md"), { recursive: true, force: true }).catch(() => undefined);
          const continued = await hasResumableSession(workdir);
          try {
            await runOnce({
              prompt: buildNoTrailerWritePrompt(continued ? undefined : artifact.content),
              continueSession: continued,
            });
          } catch (err) {
            const message = errorMessage(err);
            return finish({
              caseId: reviewCase.id,
              forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
              owner: reviewCase.owner,
              repo: reviewCase.repo,
              prNumber: pr?.number ?? reviewCase.prNumber ?? null,
              baseSha,
              headSha,
              ...(reviewCase.note ? { note: reviewCase.note } : {}),
              runner: runner.name,
              runnerStamp: stamp,
              verdict: "skip",
              findings: "",
              findingsCount: 0,
              rawMarkdown: artifact.content,
              skipReason: quotaSkip(message),
              ...(isQuotaText(message) ? { quota: true } : {}),
            });
          }
          continue;
        }
        // A failure trailer with no published findings is incomplete, mirroring
        // the live publisher: the trailer reason is not a finding.
        if (parsed.verdict.state === "failure" && !hasPublishedFindings(parsed.comment)) {
          if (extrasUsed >= maxIncompleteRetries) {
            return finish({
              caseId: reviewCase.id,
              forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
              owner: reviewCase.owner,
              repo: reviewCase.repo,
              prNumber: pr?.number ?? reviewCase.prNumber ?? null,
              baseSha,
              headSha,
              ...(reviewCase.note ? { note: reviewCase.note } : {}),
              runner: runner.name,
              runnerStamp: stamp,
              verdict: "skip",
              findings: "",
              findingsCount: 0,
              rawMarkdown: artifact.content,
              skipReason: "Incomplete review: no findings",
            });
          }
          extrasUsed++;
          await rm(join(workdir, "JUMI_REVIEW.md"), { recursive: true, force: true }).catch(() => undefined);
          const continued = await hasResumableSession(workdir);
          try {
            await runOnce({
              prompt: buildNoFindingsWritePrompt(continued ? undefined : artifact.content),
              continueSession: continued,
            });
          } catch (err) {
            const message = errorMessage(err);
            return finish({
              caseId: reviewCase.id,
              forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
              owner: reviewCase.owner,
              repo: reviewCase.repo,
              prNumber: pr?.number ?? reviewCase.prNumber ?? null,
              baseSha,
              headSha,
              ...(reviewCase.note ? { note: reviewCase.note } : {}),
              runner: runner.name,
              runnerStamp: stamp,
              verdict: "skip",
              findings: "",
              findingsCount: 0,
              rawMarkdown: artifact.content,
              skipReason: quotaSkip(message),
              ...(isQuotaText(message) ? { quota: true } : {}),
            });
          }
          continue;
        }
        const findings = keepReviewFindingLines(parsed.comment);
        const count = parseReviewFindings(parsed.comment).length;
        return finish({
          caseId: reviewCase.id,
          forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
          owner: reviewCase.owner,
          repo: reviewCase.repo,
          prNumber: pr?.number ?? reviewCase.prNumber ?? null,
          baseSha,
          headSha,
          ...(reviewCase.note ? { note: reviewCase.note } : {}),
          runner: runner.name,
          runnerStamp: stamp,
          verdict: parsed.verdict.state,
          findings,
          findingsCount: count,
          rawMarkdown: artifact.content,
        });
      }
      if (extrasUsed >= maxIncompleteRetries) {
        return finish({
          caseId: reviewCase.id,
          forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
          owner: reviewCase.owner,
          repo: reviewCase.repo,
          prNumber: pr?.number ?? reviewCase.prNumber ?? null,
          baseSha,
          headSha,
          ...(reviewCase.note ? { note: reviewCase.note } : {}),
          runner: runner.name,
          runnerStamp: stamp,
          verdict: "skip",
          findings: "",
          findingsCount: 0,
          rawMarkdown: "",
          skipReason: "Incomplete review: no output",
        });
      }
      extrasUsed++;
      await rm(join(workdir, "JUMI_REVIEW.md"), { recursive: true, force: true }).catch(() => undefined);
      const continued = await hasResumableSession(workdir);
      try {
        const result = await runOnce({
          prompt: buildIncompleteWritePrompt(continued ? undefined : lastStdout),
          continueSession: continued,
        });
        lastStdout = result.stdout ?? "";
      } catch (err) {
        const message = errorMessage(err);
        return finish({
          caseId: reviewCase.id,
          forge: reviewCase.forge ?? opts.forgeKind ?? "gitea",
          owner: reviewCase.owner,
          repo: reviewCase.repo,
          prNumber: pr?.number ?? reviewCase.prNumber ?? null,
          baseSha,
          headSha,
          ...(reviewCase.note ? { note: reviewCase.note } : {}),
          runner: runner.name,
          runnerStamp: stamp,
          verdict: "skip",
          findings: "",
          findingsCount: 0,
          rawMarkdown: "",
          skipReason: quotaSkip(message),
          ...(isQuotaText(message) ? { quota: true } : {}),
        });
      }
    }
  } finally {
    await rm(join(workdir, "JUMI_REVIEW.md"), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(workdir, "JUMI_TASK.md"), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(workdir, ".jumi-tmp"), { recursive: true, force: true }).catch(() => undefined);
    if (!opts.createWorkspace) {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export interface RunReplayOptions extends Omit<RunReplayCaseOptions, "api" | "reviewCase" | "runner" | "workdirRoot"> {
  api: ReplayReadApi;
  cases: ReplayCase[];
  runners: NamedRunner[];
  outDir: string;
  workdirRoot: string;
  engineForRunner?: (runner: NamedRunner) => Engine;
}

export async function runReplay(opts: RunReplayOptions): Promise<ReplayRecord[]> {
  await mkdir(opts.outDir, { recursive: true });
  const records: ReplayRecord[] = [];
  const lines: string[] = [];
  for (const reviewCase of opts.cases) {
    for (const runner of opts.runners) {
      const record = await runReplayCase({
        ...opts,
        api: opts.api,
        reviewCase,
        runner,
        workdirRoot: opts.workdirRoot,
        ...(opts.engineForRunner ? { engine: opts.engineForRunner(runner) } : {}),
      });
      records.push(record);
      lines.push(JSON.stringify(record));
      const rawName = `${sanitizeFileSegment(record.caseId)}.${sanitizeFileSegment(record.runner)}.md`;
      await writeFile(join(opts.outDir, rawName), record.rawMarkdown);
    }
  }
  await writeFile(join(opts.outDir, "results.jsonl"), `${lines.join("\n")}\n`);
  return records;
}

interface ReplayCliConfig {
  forge: ForgeKind;
  giteaUrl: string;
  giteaToken: string;
  botUsername: string;
  blockingQuestionAuthors: string[];
  runners: NamedRunner[];
  home: string;
  workdir: string;
  maxFiles: number;
  maxPatchBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

function envOr(value: string | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

function intEnvOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function csvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function loadReplayCliConfig(runnerNames: string[] | undefined): ReplayCliConfig {
  const env = process.env as Record<string, string | undefined>;
  const forge = parseForge(env.FORGE);
  const giteaUrl = (env.GITEA_URL ?? env.FORGE_URL ?? "").replace(/\/+$/, "");
  if (!giteaUrl) throw new Error("Missing GITEA_URL (or FORGE_URL for FORGE=github)");
  const giteaToken = env.GITEA_BOT_TOKEN ?? env.GITHUB_TOKEN ?? "";
  if (!giteaToken) throw new Error("Missing GITEA_BOT_TOKEN (read-only token is enough for replay)");
  const fromEnv = {
    model: envOr(env.OPENCODE_MODEL, "openai/gpt-5.5"),
    ...(env.OPENCODE_VARIANT ? { variant: env.OPENCODE_VARIANT } : {}),
    ...(env.OPENCODE_FALLBACK_MODEL ? { fallbackModel: env.OPENCODE_FALLBACK_MODEL } : {}),
    ...(env.OPENCODE_FALLBACK_VARIANT ? { fallbackVariant: env.OPENCODE_FALLBACK_VARIANT } : {}),
  };
  const catalog = loadRunnersCatalog(env.JUMI_RUNNERS_FILE, fromEnv, forge);
  const ordered = orderedRunners(catalog);
  let runners = ordered;
  if (runnerNames && runnerNames.length > 0) {
    const byName = new Map(ordered.map((runner) => [runner.name, runner]));
    runners = runnerNames.map((name) => {
      const found = byName.get(name);
      if (!found) throw new Error(`Unknown runner ${name} (chain: ${ordered.map((r) => r.name).join(", ")})`);
      return found;
    });
  }
  return {
    forge,
    giteaUrl,
    giteaToken,
    botUsername: envOr(env.BOT_USERNAME, "jumi"),
    blockingQuestionAuthors: csvEnv(env.REVIEW_BLOCKING_QUESTION_AUTHORS),
    runners,
    home: envOr(env.HOME, "/data"),
    workdir: envOr(env.WORKDIR, "/work"),
    maxFiles: intEnvOr(env.MAX_FILES, DEFAULT_MAX_FILES),
    maxPatchBytes: intEnvOr(env.MAX_PATCH_BYTES, DEFAULT_MAX_PATCH_BYTES),
    maxOutputBytes: intEnvOr(env.MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES),
    timeoutMs: intEnvOr(env.OPENCODE_TIMEOUT_MS, 15 * 60 * 1000),
  };
}

function printReplayHelp(): void {
  console.log(`jumi replay: run past reviews on chosen runners without publishing

Usage:
  bun run src/replay.ts --cases <case-file.json> --out <output-dir> [--runners <name1,name2>]

Case file (never commit it; it may name private repositories):
  { "cases": [{ "id": "fix-123", "owner": "acme", "repo": "api", "prNumber": 123 }] }
  [{ "id": "sha-case", "owner": "acme", "repo": "api",
     "baseSha": "<base>", "headSha": "<head>", "note": "optional" }]

Each case names owner/repo plus either prNumber or baseSha plus headSha.
Runners default to the configured review chain; --runners picks a subset.
Output is <out>/results.jsonl plus one <case>.<runner>.md raw review per record.
No forge writes: a read-only token is enough. Quota records a skip, never waits.`);
}

function parseReplayArgs(argv: string[]): { cases?: string; out?: string; runners?: string[]; help: boolean } {
  let cases: string | undefined;
  let out: string | undefined;
  let runners: string[] | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--cases" && i + 1 < argv.length) cases = argv[++i];
    else if (arg.startsWith("--cases=")) cases = arg.slice("--cases=".length);
    else if (arg === "--out" && i + 1 < argv.length) out = argv[++i];
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else if (arg === "--runners" && i + 1 < argv.length) {
      runners = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--runners=")) {
      runners = arg
        .slice("--runners=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--") break;
  }
  return { cases, out, runners, help };
}

async function main(): Promise<void> {
  const args = parseReplayArgs(process.argv.slice(2));
  if (args.help) {
    printReplayHelp();
    return;
  }
  if (!args.cases || !args.out) {
    printReplayHelp();
    throw new Error("Missing required --cases and --out");
  }
  const config = loadReplayCliConfig(args.runners);
  const text = await readFile(args.cases, "utf8");
  const cases = parseReplayCaseFileText(text);
  const mismatched = cases.filter((entry) => entry.forge && entry.forge !== config.forge);
  if (mismatched.length > 0) {
    throw new Error(`Case forge ${mismatched[0].forge} does not match FORGE=${config.forge}`);
  }
  const fullApi = createForge({
    forge: config.forge,
    giteaUrl: config.giteaUrl,
    giteaToken: config.giteaToken,
  });
  const api = makeReplayReadOnly(fullApi as unknown as ReviewApi);
  const workdirRoot = join(config.workdir, "jumi-replay");
  await mkdir(workdirRoot, { recursive: true });
  const records = await runReplay({
    api,
    cases,
    runners: config.runners,
    outDir: args.out,
    workdirRoot,
    giteaUrl: config.giteaUrl,
    giteaToken: config.giteaToken,
    botUsername: config.botUsername,
    forgeKind: config.forge,
    blockingQuestionAuthors: config.blockingQuestionAuthors,
    home: config.home,
    maxFiles: config.maxFiles,
    maxPatchBytes: config.maxPatchBytes,
    maxOutputBytes: config.maxOutputBytes,
    timeoutMs: config.timeoutMs,
    logger: logDefault,
  });
  const verdicts = records.map((r) => `${r.caseId}/${r.runner}:${r.verdict}`).join(" ");
  logDefault(`replay done: ${records.length} records -> ${args.out}/results.jsonl ${verdicts}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[replay] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
