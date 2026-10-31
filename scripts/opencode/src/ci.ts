import { createHash } from "node:crypto";
import type { ActionJob, Check, CheckState, Forge } from "./ports.ts";
import { type SkipLatchKey, type SkipLatchStore, skipLatchesFor, skipLatchStoreFromPath } from "./skip_latches.ts";

type CiApi = Pick<Forge, "listCommitStatuses" | "listCheckRuns" | "listActionJobs" | "getActionJobLogs">;

export const JUMI_REVIEW_CONTEXT = "jumi/opencode-review";
export const CI_LOG_FILE = "JUMI_CI.md";
export const CI_LOG_MAX_BYTES = 64 * 1024;
export const CI_LOG_MIN_BYTES = 32 * 1024;
export const CI_LOG_CONTEXT_LINES = 80;

export interface CiHandledCheck {
  sha: string;
  checkName: string;
  logHash: string;
}

export interface CiFollowUpState {
  prNumber: number;
  handled: CiHandledCheck[];
  updatedAt: string;
}

export interface FailedCheck {
  name: string;
  state: Extract<CheckState, "failure" | "error">;
  description: string;
  targetUrl?: string;
  jobId?: number;
  capped: string;
  logHash: string;
  flake?: string;
}

export interface CiInspection {
  sha: string;
  pending: boolean;
  failed: FailedCheck[];
  unhandled: FailedCheck[];
  empty: boolean;
  /** A forge list call threw, so `empty` / `pending` / `failed` may be incomplete. */
  lookupFailed?: boolean;
}

export const CI_PENDING_REASON = "CI still pending";
export const CI_FAILED_REASON = "CI failed";
export const CI_LOOKUP_FAILED_REASON = "CI lookup failed";
/** Lists succeeded and no sibling check exists yet. Waits on the lookup budget, then reviews. */
export const CI_ABSENT_REASON = "CI not started";
/** Posted and prompted once the lookup budget expires with still no checks. */
export const CI_ABSENT_NOTE = "This repository has no CI checks on this head.";
/** Growing waits before a review whose CI lookup keeps failing is given up. */
export const CI_LOOKUP_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const CI_LOOKUP_MAX_ATTEMPTS = 8;
export const CI_LOOKUP_BUDGET_MS = 10 * 60 * 1000;
export const CI_LOOKUP_RETRY_PREFIX = "ci-lookup-retry:";

/** Non-terminal review skips that wait for a later sibling-check wake. */
export function isCiWaitSkipReason(reason: string | null | undefined): boolean {
  return (
    reason === CI_PENDING_REASON ||
    reason === CI_FAILED_REASON ||
    reason === CI_LOOKUP_FAILED_REASON ||
    reason === CI_ABSENT_REASON
  );
}

export function isCiLookupRetryMarker(error: string | null | undefined): boolean {
  return Boolean(error?.startsWith(CI_LOOKUP_RETRY_PREFIX));
}

export function parseCiLookupMarker(
  error: string | null | undefined
): { count: number; firstFailAt: number } | undefined {
  if (!isCiLookupRetryMarker(error) || !error) return undefined;
  const parts = error.slice(CI_LOOKUP_RETRY_PREFIX.length).split(":");
  const count = Number(parts[0]);
  const firstFailAt = Number(parts[1]);
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(firstFailAt)) return undefined;
  return { count, firstFailAt };
}

export function encodeCiLookupMarker(count: number, firstFailAt: number): string {
  return `${CI_LOOKUP_RETRY_PREFIX}${count}:${firstFailAt}`;
}

export function ciLookupBackoffMs(count: number): number {
  const index = Math.min(Math.max(count, 1), CI_LOOKUP_BACKOFF_MS.length) - 1;
  return CI_LOOKUP_BACKOFF_MS[index] ?? 300_000;
}

export type CiLookupDecision =
  | { action: "requeue"; count: number; firstFailAt: number; backoffMs: number; marker: string }
  | { action: "exhaust"; reason: string };

export function decideCiLookupRetry(prevError: string | null | undefined, nowMs: number): CiLookupDecision {
  const prev = parseCiLookupMarker(prevError);
  const count = (prev?.count ?? 0) + 1;
  const firstFailAt = prev?.firstFailAt ?? nowMs;
  if (count >= CI_LOOKUP_MAX_ATTEMPTS || nowMs - firstFailAt >= CI_LOOKUP_BUDGET_MS) {
    return { action: "exhaust", reason: CI_LOOKUP_FAILED_REASON };
  }
  return {
    action: "requeue",
    count,
    firstFailAt,
    backoffMs: ciLookupBackoffMs(count),
    marker: encodeCiLookupMarker(count, firstFailAt),
  };
}

const PENDING_JOB_STATUS = new Set([
  "queued",
  "waiting",
  "in_progress",
  "running",
  "requested",
  "pending",
  "unknown",
  "blocked",
  "action_required",
]);
const FAILED_JOB_RESULT = new Set(["failure", "error", "timed_out", "startup_failure"]);

const UNPACK_NOISE =
  /^(Unpacking |Selecting previously unselected |Preparing to unpack |Setting up |Processing triggers for |Get:\d|Hit:\d|Ign:\d|Fetched \d|Reading package lists|Building dependency tree| {2}inflating:| {2}creating: |Extracting |Unzipping )/i;

function emptyInspection(sha: string): CiInspection {
  return { sha, pending: false, failed: [], unhandled: [], empty: true };
}

export function actionJobCheckState(job: ActionJob): CheckState | undefined {
  const status = (job.status ?? "").toLowerCase();
  const conclusion = (job.conclusion ?? "").toLowerCase();
  if (PENDING_JOB_STATUS.has(status)) return "pending";
  const result = conclusion || status;
  if (!result) return undefined;
  if (FAILED_JOB_RESULT.has(result)) return result === "error" ? "error" : "failure";
  if (PENDING_JOB_STATUS.has(result)) return "pending";
  return "success";
}

function checksFromActionJobs(jobs: ActionJob[], sha: string): Check[] {
  const needle = sha.toLowerCase();
  const checks: Check[] = [];
  for (const job of jobs) {
    if ((job.head_sha ?? "").toLowerCase() !== needle) continue;
    const state = actionJobCheckState(job);
    if (!state) continue;
    checks.push({
      id: job.id,
      context: job.name || `job-${job.id}`,
      state,
      status: state,
      jobId: job.id,
      target_url: job.html_url,
    });
  }
  return checks;
}

export function reviewSkipReasonForCi(ci: CiInspection): string | undefined {
  if (ci.pending) return CI_PENDING_REASON;
  if (ci.failed.length > 0) return CI_FAILED_REASON;
  // A thrown list hides checks. Rows from the calls that worked are not a green bill, and not "no CI".
  if (ci.lookupFailed) return CI_LOOKUP_FAILED_REASON;
  if (ci.empty) return CI_ABSENT_REASON;
  return undefined;
}

export function commitStatusState(status: Check): CheckState | undefined {
  return status.state ?? status.status;
}

export function isJumiReviewContext(context: string | undefined): boolean {
  return (context ?? "") === JUMI_REVIEW_CONTEXT;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function latestStatuses(statuses: Check[]): Check[] {
  const byContext = new Map<string, Check>();
  for (const status of statuses) {
    const context = status.context ?? "";
    if (!context) continue;
    const prev = byContext.get(context);
    if (!prev) {
      byContext.set(context, status);
      continue;
    }
    const prevId = typeof prev.id === "number" ? prev.id : 0;
    const nextId = typeof status.id === "number" ? status.id : 0;
    if (nextId > prevId) {
      byContext.set(context, status);
      continue;
    }
    if (nextId === prevId) {
      const prevTs = Date.parse(prev.updated_at ?? prev.created_at ?? "") || 0;
      const nextTs = Date.parse(status.updated_at ?? status.created_at ?? "") || 0;
      if (nextTs >= prevTs) byContext.set(context, status);
    }
  }
  return [...byContext.values()];
}

export function dropUnpackNoise(log: string): string {
  return log
    .split(/\r?\n/)
    .filter((line) => !UNPACK_NOISE.test(line))
    .join("\n");
}

function trimToBytes(text: string, maxBytes: number, keepTail: boolean): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const slice = keepTail ? bytes.subarray(bytes.byteLength - maxBytes) : bytes.subarray(0, maxBytes);
  return new TextDecoder().decode(slice);
}

export function capFailedJobLog(log: string): string {
  const cleaned = dropUnpackNoise(log);
  const lines = cleaned.split(/\r?\n/);
  let errorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("##[error]")) {
      errorIdx = i;
      break;
    }
  }
  const half = Math.floor(CI_LOG_CONTEXT_LINES / 2);
  let start: number;
  let end: number;
  if (errorIdx < 0) {
    start = Math.max(0, lines.length - CI_LOG_CONTEXT_LINES);
    end = lines.length;
  } else {
    start = Math.max(0, errorIdx - half);
    end = Math.min(lines.length, errorIdx + half + 1);
  }
  let window = lines.slice(start, end);
  let text = window.join("\n");
  if (new TextEncoder().encode(text).byteLength < CI_LOG_MIN_BYTES && (start > 0 || end < lines.length)) {
    const extra = Math.ceil((CI_LOG_MIN_BYTES - new TextEncoder().encode(text).byteLength) / 80);
    start = Math.max(0, start - extra);
    end = Math.min(lines.length, end + extra);
    window = lines.slice(start, end);
    text = window.join("\n");
  }
  return trimToBytes(text, CI_LOG_MAX_BYTES, true);
}

export function infraFlakeReason(log: string): string | undefined {
  if (
    /140\.82\.\d+\.\d+/.test(log) &&
    (/timeout/i.test(log) ||
      /timed out/i.test(log) ||
      /unreachable/i.test(log) ||
      /Failed to connect/i.test(log) ||
      /Could not resolve host/i.test(log) ||
      /Connection timed out/i.test(log))
  ) {
    return "GitHub 140.82 checkout/cache timeout or unreachable";
  }
  if (
    (/values\.schema\.json/i.test(log) || /remote.?schema/i.test(log)) &&
    (/timeout/i.test(log) || /\b429\b/.test(log) || /Too Many Requests/i.test(log))
  ) {
    return "Helm remote-schema timeout/429";
  }
  if (/Invalid cross-device link/i.test(log) && /dpkg/i.test(log)) {
    return "GARM Invalid cross-device link on dpkg";
  }
  if (
    /\b(tofu|terraform)\b/i.test(log) &&
    (/state lock/i.test(log) || /Error acquiring the state lock/i.test(log) || /s3.*lock/i.test(log))
  ) {
    return "tofu S3 state lock";
  }
  if (/toomanyrequests/i.test(log) && /rate limit/i.test(log)) {
    return "Docker Hub unauthenticated pull rate limit";
  }
  return undefined;
}

function stripGiteaLogTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, "").trimStart();
}

const FAIL_OR_ERROR_LINE =
  /^(?:\(fail\)|##\[error\]|Error:|fatal:|dpkg:|Error response from daemon:|ERROR:|helm:|Failed to connect\b|Could not resolve host\b|(?:tofu|terraform)\b|reading manifest\b)/;

function failOrErrorEvidence(capped: string): string {
  return capped
    .split(/\r?\n/)
    .map(stripGiteaLogTimestamp)
    .filter((line) => !line.startsWith("(pass)") && FAIL_OR_ERROR_LINE.test(line))
    .join("\n");
}

export function classifyInfraFlake(capped: string): string | undefined {
  const evidence = failOrErrorEvidence(capped);
  if (!evidence) return undefined;
  return infraFlakeReason(evidence);
}

export function jobMatchesCheck(job: ActionJob, checkName: string, sha: string): boolean {
  if ((job.head_sha ?? "").toLowerCase() !== sha.toLowerCase()) return false;
  const name = job.name ?? "";
  if (!name) return false;
  if (checkName === name) return true;
  if (checkName.includes(` / ${name} (`)) return true;
  return checkName.endsWith(` / ${name}`);
}

function jobIdFromTargetUrl(targetUrl: string | undefined): number | undefined {
  if (!targetUrl) return undefined;
  const match =
    /\/actions\/(?:runs\/\d+\/)?jobs?\/(\d+)(?:\/|$)/.exec(targetUrl) ?? /\/checks\/(\d+)(?:\/|$)/.exec(targetUrl);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : undefined;
}

export function parseCiState(parsed: unknown): CiFollowUpState {
  if (!parsed || typeof parsed !== "object") return emptyCiState();
  const state = parsed as CiFollowUpState;
  return {
    prNumber: typeof state.prNumber === "number" ? state.prNumber : 0,
    handled: parseHandled(state.handled),
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
  };
}

export async function readCiLatch(store: SkipLatchStore, key: SkipLatchKey): Promise<CiFollowUpState> {
  return parseCiState((await store.get(key)).ci);
}

export async function writeCiLatch(store: SkipLatchStore, key: SkipLatchKey, state: CiFollowUpState): Promise<void> {
  await store.put(key, { ci: state });
}

export async function readCiState(path: string): Promise<CiFollowUpState> {
  const latch = skipLatchStoreFromPath(path);
  if (!latch) return emptyCiState();
  return readCiLatch(latch.store, latch.key);
}

function emptyCiState(): CiFollowUpState {
  return { prNumber: 0, handled: [], updatedAt: "" };
}

function parseHandled(value: unknown): CiHandledCheck[] {
  if (!Array.isArray(value)) return [];
  const out: CiHandledCheck[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as { sha?: unknown; checkName?: unknown; logHash?: unknown };
    if (typeof rec.sha === "string" && rec.sha && typeof rec.checkName === "string" && rec.checkName) {
      out.push({
        sha: rec.sha.toLowerCase(),
        checkName: rec.checkName,
        logHash: typeof rec.logHash === "string" ? rec.logHash : "",
      });
    }
  }
  return out;
}

export async function writeCiState(path: string, state: CiFollowUpState): Promise<void> {
  const latch = skipLatchStoreFromPath(path);
  if (!latch) return;
  await writeCiLatch(latch.store, latch.key, state);
}

function handledKey(sha: string, checkName: string): string {
  return `${sha.toLowerCase()}:${checkName}`;
}

export function isCheckHandled(state: CiFollowUpState, sha: string, checkName: string, logHash: string): boolean {
  return state.handled.some(
    (entry) =>
      entry.sha === sha.toLowerCase() && entry.checkName === checkName && entry.logHash === logHash && logHash !== ""
  );
}

export async function recordCiHandled(opts: {
  home: string;
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber: number;
  sha: string;
  checks: FailedCheck[];
  now?: () => Date;
  skipLatches?: SkipLatchStore;
}): Promise<void> {
  const store = skipLatchesFor(opts);
  const key = { owner: opts.owner, repo: opts.repo, issueNumber: opts.issueNumber };
  const state = await readCiLatch(store, key);
  const byKey = new Map(state.handled.map((entry) => [handledKey(entry.sha, entry.checkName), entry]));
  for (const check of opts.checks) {
    byKey.set(handledKey(opts.sha, check.name), {
      sha: opts.sha.toLowerCase(),
      checkName: check.name,
      logHash: check.logHash,
    });
  }
  await writeCiLatch(store, key, {
    prNumber: opts.prNumber,
    handled: [...byKey.values()],
    updatedAt: (opts.now?.() ?? new Date()).toISOString(),
  });
}

export function buildCiMarkdown(opts: { sha: string; checks: FailedCheck[] }): string {
  const sections = [
    `# Failed CI`,
    ``,
    `Head SHA: ${opts.sha}`,
    ``,
    `Parent-injected Gitea Actions log tail. Do not call tea, the forge API, or fetch Actions yourself.`,
    ``,
  ];
  const encoder = new TextEncoder();
  let used = encoder.encode(sections.join("\n")).byteLength;
  for (const check of opts.checks) {
    const header = `## ${check.name}\n\nState: ${check.state}${check.flake ? `\nInfra flake: ${check.flake}` : ""}\n`;
    const remaining = CI_LOG_MAX_BYTES - used - encoder.encode(header).byteLength - 2;
    if (remaining <= 0) break;
    const body = trimToBytes(check.capped, remaining, true);
    sections.push(header + body, "");
    used = encoder.encode(sections.join("\n")).byteLength;
    if (used >= CI_LOG_MAX_BYTES) break;
  }
  return trimToBytes(sections.join("\n"), CI_LOG_MAX_BYTES, false);
}

function uniqueFlakeReasons(checks: FailedCheck[]): string[] {
  return [...new Set(checks.map((check) => check.flake).filter((value): value is string => Boolean(value)))];
}

export function flakeSkipReason(checks: FailedCheck[]): string {
  return `CI infra flake: ${uniqueFlakeReasons(checks).join("; ")}`;
}

export function flakeComment(checks: FailedCheck[]): string {
  const names = checks.map((check) => check.name).join(", ");
  return `CI looks like an infra flake (${uniqueFlakeReasons(checks).join("; ")}) on ${names}. A human needs to rerun.`;
}

async function logsForCheck(
  api: CiApi,
  owner: string,
  repo: string,
  sha: string,
  status: Check,
  jobs: ActionJob[]
): Promise<{ text: string; jobId?: number }> {
  const name = status.context ?? "";
  const jobId =
    status.jobId ?? jobIdFromTargetUrl(status.target_url) ?? jobs.find((job) => jobMatchesCheck(job, name, sha))?.id;
  if (jobId === undefined) {
    const fallback = [status.description, status.target_url].filter(Boolean).join("\n");
    return { text: fallback };
  }
  try {
    const text = await api.getActionJobLogs(owner, repo, jobId);
    return { text, jobId };
  } catch {
    const fallback = [status.description, status.target_url].filter(Boolean).join("\n");
    return { text: fallback, jobId };
  }
}

export async function inspectCi(opts: {
  api: CiApi;
  owner: string;
  repo: string;
  sha: string;
  home: string;
  issueNumber: number;
  skipLatches?: SkipLatchStore;
  log?: (message: string) => void;
}): Promise<CiInspection> {
  if (!opts.sha) return emptyInspection(opts.sha);
  let lookupFailed = false;
  const noteLookupFailure = (err: unknown) => {
    lookupFailed = true;
    const message = err instanceof Error ? err.message : String(err);
    opts.log?.(`CI lookup failed for ${opts.owner}/${opts.repo}#${opts.issueNumber}: ${message}`);
  };
  let statuses: Check[] = [];
  try {
    statuses = await opts.api.listCommitStatuses(opts.owner, opts.repo, opts.sha);
  } catch (err) {
    statuses = [];
    noteLookupFailure(err);
  }
  let checkRuns: Check[] = [];
  try {
    checkRuns = await opts.api.listCheckRuns(opts.owner, opts.repo, opts.sha);
  } catch (err) {
    checkRuns = [];
    noteLookupFailure(err);
  }
  const fromForge = latestStatuses([...statuses, ...checkRuns]).filter(
    (status) => !isJumiReviewContext(status.context)
  );
  let live: Check[] = [];
  try {
    live = checksFromActionJobs(await opts.api.listActionJobs(opts.owner, opts.repo, { headSha: opts.sha }), opts.sha);
  } catch (err) {
    live = [];
    noteLookupFailure(err);
  }
  const sawShaJobs = fromForge.length > 0 || live.length > 0;
  // Live Action jobs are fresher than forge rows (status / check-run lag), so a matching live job's state wins.
  const matchedLive = new Set<Check>();
  const merged = fromForge.map((forge) => {
    const matches = live.filter((check) => {
      const job = { id: check.jobId ?? 0, name: check.context ?? "", head_sha: opts.sha };
      return jobMatchesCheck(job, forge.context ?? "", opts.sha);
    });
    if (matches.length === 0) return forge;
    for (const check of matches) matchedLive.add(check);
    const latest = matches.reduce((a, b) => ((b.jobId ?? 0) > (a.jobId ?? 0) ? b : a));
    const state = commitStatusState(latest);
    return { ...forge, state, status: state };
  });
  const others = latestStatuses([...merged, ...live.filter((check) => !matchedLive.has(check))]).filter(
    (status) => !isJumiReviewContext(status.context)
  );
  const pending = others.some((status) => commitStatusState(status) === "pending");
  const red = others.filter((status) => {
    const state = commitStatusState(status);
    return state === "failure" || state === "error";
  });
  if (red.length === 0) {
    return { sha: opts.sha, pending, failed: [], unhandled: [], empty: !sawShaJobs, lookupFailed };
  }

  let jobs: ActionJob[] = [];
  try {
    jobs = await opts.api.listActionJobs(opts.owner, opts.repo, { status: "failure", headSha: opts.sha });
  } catch {
    jobs = [];
  }

  const ciState = await readCiLatch(skipLatchesFor(opts), {
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: opts.issueNumber,
  });
  const failed: FailedCheck[] = [];
  for (const status of red) {
    const name = status.context ?? "unknown";
    const state = commitStatusState(status) === "error" ? "error" : "failure";
    const { text, jobId } = await logsForCheck(opts.api, opts.owner, opts.repo, opts.sha, status, jobs);
    const capped = capFailedJobLog(text);
    const logHash = hashText(capped);
    failed.push({
      name,
      state,
      description: status.description ?? "",
      targetUrl: status.target_url,
      jobId,
      capped,
      logHash,
      flake: classifyInfraFlake(capped),
    });
  }
  const unhandled = failed.filter((check) => !isCheckHandled(ciState, opts.sha, check.name, check.logHash));
  return { sha: opts.sha, pending, failed, unhandled, empty: false, lookupFailed };
}

export async function needsCiFollowUp(opts: {
  api: CiApi;
  owner: string;
  repo: string;
  sha: string;
  home: string;
  issueNumber: number;
  skipLatches?: SkipLatchStore;
}): Promise<boolean> {
  try {
    const inspection = await inspectCi(opts);
    if (inspection.pending) return false;
    return inspection.unhandled.length > 0;
  } catch {
    return false;
  }
}
