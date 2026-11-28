/**
 * Nightly release gate (jumi#1006).
 *
 * Push workflows build, probe, and push `sha-<SHA>` candidates but never
 * promote. This module holds the testable half of the nightly workflow; the
 * YAML in `.github/workflows/jumi-nightly-release.yml` just calls it:
 *
 * - HEAD already released → no-op.
 * - Both candidate digests must exist and be probed for HEAD, and the baked
 *   version labels must match `release.ts next-version`. Otherwise
 *   `inconclusive`.
 * - Real-model Pi evals (`worker_eval.ts`, then `review_eval.ts`) run inside
 *   the tested candidate images with `--harness pi --trials 3` over all
 *   shipped fixtures and both review halves.
 * - A fixture × half case passes when at least 2 of its 3 trials pass. The
 *   night passes only when every case passes and no record is inconclusive
 *   (that includes `budget-exhausted` / `budget-unmeasurable`).
 * - Pass → tag plus promote both images to the tested digests. Fail or
 *   inconclusive → no tag, no promotion, job fails.
 * - A rolling `release-blocked` issue carries only structured fields (never
 *   model output, transcripts, or record free text).
 */

import { readFileSync } from "node:fs";

export const NIGHTLY_PI_ROUTE_NAME = "pi-contributor" as const;
export const NIGHTLY_PI_PROVIDER = "opencode-go" as const;
export const NIGHTLY_PI_MODEL = "muse-spark-1.3-contributor" as const;
export const NIGHTLY_PI_SKU = "contributor" as const;
export const NIGHTLY_PI_ENDPOINT = "https://opencode.ai/inference/go" as const;

/** Wired OpenCode Go Contributor profile the nightly evals run under (public scope). */
export const NIGHTLY_PI_PROFILE = {
  provider: NIGHTLY_PI_PROVIDER,
  model: NIGHTLY_PI_MODEL,
  endpoint: NIGHTLY_PI_ENDPOINT,
  fundingPool: "go-subscription",
  payer: "go-subscription",
  credentialRef: "env:JUMI_PI_GO_KEY",
  scopes: ["public"],
  sku: NIGHTLY_PI_SKU,
} as const;

/** Default budget (USD) when the `EVAL_BUDGET_USD` repo variable is unset. */
export const NIGHTLY_EVAL_BUDGET_DEFAULT = 1;

/** Catalog file content the nightly workflow writes for `JUMI_PI_PROFILES_FILE`. */
export function defaultNightlyPiCatalog(): Record<string, typeof NIGHTLY_PI_PROFILE> {
  return { [NIGHTLY_PI_ROUTE_NAME]: NIGHTLY_PI_PROFILE };
}

/** Budget for `--budget-usd` from the `EVAL_BUDGET_USD` repo variable (default 1). */
export function nightlyBudgetFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.EVAL_BUDGET_USD?.trim() ?? "";
  if (!raw) return NIGHTLY_EVAL_BUDGET_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid EVAL_BUDGET_USD ${JSON.stringify(raw)} (want a number > 0)`);
  }
  return value;
}

export type NightlyOutcome = "pass" | "fail" | "inconclusive";

export type NightlyReasonCategory =
  | "all-pass"
  | "head-released"
  | "missing-candidate"
  | "version-mismatch"
  | "case-failed"
  | "inconclusive-record"
  | "missing-case"
  | "budget-exhausted"
  | "budget-unmeasurable";

export interface NightlyCandidate {
  digest: string;
  version: string;
  revision: string;
}

/** Minimal trial shape shared by worker and review eval records. */
export interface GateRecord {
  caseKey: string;
  trial: number;
  verdict: "pass" | "fail" | "inconclusive";
  inconclusiveReason?: string;
}

export interface CaseResult {
  caseKey: string;
  passes: number;
  total: number;
  passed: boolean;
}

export interface GateEvaluation {
  outcome: NightlyOutcome;
  reasonCategory: NightlyReasonCategory;
  cases: CaseResult[];
}

/** Case key for one fixture × half: `worker/<fixture>/single`, `review/<fixture>/<half>`. */
export function evalCaseKey(evalKind: "worker" | "review", fixture: string, half?: string): string {
  const kind = evalKind === "worker" ? "worker" : "review";
  const name = fixture.trim();
  const part = kind === "worker" ? "single" : (half ?? "").trim() || "unknown";
  return `${kind}/${name}/${part}`;
}

/** Normalize worker eval rows (no halves) into gate records. */
export function workerRecordsToGate(
  rows: Array<{ fixture: string; trial: number; verdict: GateRecord["verdict"]; inconclusiveReason?: string }>,
): GateRecord[] {
  return rows.map((row) => ({
    caseKey: evalCaseKey("worker", row.fixture),
    trial: row.trial,
    verdict: row.verdict,
    ...(row.inconclusiveReason ? { inconclusiveReason: row.inconclusiveReason } : {}),
  }));
}

/** Normalize review eval rows (defective + repaired halves) into gate records. */
export function reviewRecordsToGate(
  rows: Array<{
    fixture: string;
    half: string;
    trial: number;
    verdict: GateRecord["verdict"];
    inconclusiveReason?: string;
  }>,
): GateRecord[] {
  return rows.map((row) => ({
    caseKey: evalCaseKey("review", row.fixture, row.half),
    trial: row.trial,
    verdict: row.verdict,
    ...(row.inconclusiveReason ? { inconclusiveReason: row.inconclusiveReason } : {}),
  }));
}

/** HEAD is already released when the latest tag peels to the same commit. */
export function isHeadReleased(headSha: string, latestTagSha: string | null): boolean {
  if (!latestTagSha) return false;
  return headSha.trim().toLowerCase() === latestTagSha.trim().toLowerCase();
}

/** Map one inconclusive reason to its budget category (or a generic eval reason). */
export function categorizeInconclusive(reason: string | undefined): NightlyReasonCategory {
  const text = (reason ?? "").toLowerCase();
  if (text.includes("budget-exhausted")) return "budget-exhausted";
  if (text.includes("budget-unmeasurable")) return "budget-unmeasurable";
  return "inconclusive-record";
}

export function checkCandidates(opts: {
  headSha: string;
  expectedVersion: string;
  reviewer: NightlyCandidate | null;
  worker: NightlyCandidate | null;
}): { ok: true } | { ok: false; reason: NightlyReasonCategory; detail: string } {
  const head = opts.headSha.trim().toLowerCase();
  const want = opts.expectedVersion.trim();
  for (const [name, candidate] of [
    ["reviewer", opts.reviewer],
    ["worker", opts.worker],
  ] as const) {
    if (!candidate || !candidate.digest.trim() || !candidate.version.trim() || !candidate.revision.trim()) {
      return { ok: false, reason: "missing-candidate", detail: `missing ${name} candidate for ${head}` };
    }
    if (candidate.version.trim() !== want) {
      return {
        ok: false,
        reason: "version-mismatch",
        detail: `${name} candidate version ${candidate.version.trim()} != expected ${want}`,
      };
    }
    if (candidate.revision.trim().toLowerCase() !== head) {
      return {
        ok: false,
        reason: "version-mismatch",
        detail: `${name} candidate revision ${candidate.revision.trim()} != HEAD ${head}`,
      };
    }
  }
  return { ok: true };
}

/** Group trials by case key, sorted by trial for determinism. */
export function groupGateRecords(records: GateRecord[]): Map<string, GateRecord[]> {
  const groups = new Map<string, GateRecord[]>();
  for (const record of records) {
    const list = groups.get(record.caseKey) ?? [];
    list.push(record);
    groups.set(record.caseKey, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.trial - b.trial);
  return groups;
}

/** One case passes when at least 2 of exactly 3 trials pass. */
export function casePasses(trials: GateRecord[]): { passes: number; total: number; passed: boolean } {
  const passes = trials.filter((trial) => trial.verdict === "pass").length;
  return { passes, total: trials.length, passed: trials.length === 3 && passes >= 2 };
}

/**
 * Gate over normalized eval records. Any `inconclusive` verdict holds the
 * release (budget-exhausted and budget-unmeasurable included). When
 * `expectedCases` is given, a missing case is inconclusive, never a pass.
 */
export function evaluateGate(records: GateRecord[], expectedCases?: readonly string[]): GateEvaluation {
  const groups = groupGateRecords(records);
  if (expectedCases) {
    const missing = expectedCases.filter((key) => !groups.has(key));
    if (missing.length > 0) {
      const cases = [...groups.entries()].map(([caseKey, trials]) => {
        const { passes, total, passed } = casePasses(trials);
        return { caseKey, passes, total, passed };
      });
      for (const key of missing) cases.push({ caseKey: key, passes: 0, total: 0, passed: false });
      cases.sort((a, b) => (a.caseKey < b.caseKey ? -1 : 1));
      return { outcome: "inconclusive", reasonCategory: "missing-case", cases };
    }
  }
  const cases: CaseResult[] = [...groups.entries()].map(([caseKey, trials]) => {
    const { passes, total, passed } = casePasses(trials);
    return { caseKey, passes, total, passed };
  });
  cases.sort((a, b) => (a.caseKey < b.caseKey ? -1 : 1));
  const inconclusive = records.find((record) => record.verdict === "inconclusive");
  if (inconclusive) {
    return { outcome: "inconclusive", reasonCategory: categorizeInconclusive(inconclusive.inconclusiveReason), cases };
  }
  if (cases.length === 0) return { outcome: "inconclusive", reasonCategory: "missing-case", cases };
  if (cases.some((entry) => !entry.passed)) return { outcome: "fail", reasonCategory: "case-failed", cases };
  return { outcome: "pass", reasonCategory: "all-pass", cases };
}

/** Fail and inconclusive leave tags untouched; only a pass tags and promotes. */
export function shouldTagAndPromote(outcome: NightlyOutcome): boolean {
  return outcome === "pass";
}

export interface FailingCase {
  caseKey: string;
  passes: number;
  total: number;
}

/**
 * Structured issue body only: outcome, reason, version, commit range, tested
 * digests, per-case pass counts, and the run link. Never carries model
 * output, transcripts, or record free text (no assertions, markdown, spend,
 * usage, or reasons beyond the category).
 */
export function buildReleaseBlockedBody(opts: {
  outcome: Exclude<NightlyOutcome, "pass">;
  reasonCategory: NightlyReasonCategory;
  version: string;
  headSha: string;
  baseTag: string | null;
  reviewerDigest: string;
  workerDigest: string;
  failingCases: FailingCase[];
  runUrl: string;
}): string {
  const lines = [
    `outcome: ${opts.outcome}`,
    `reason: ${opts.reasonCategory}`,
    `version: ${opts.version}`,
    `head: ${opts.headSha.trim().toLowerCase()}`,
    `range: ${opts.baseTag ?? "(none)"}..${opts.headSha.trim().toLowerCase()}`,
    `reviewer-digest: ${opts.reviewerDigest.trim()}`,
    `worker-digest: ${opts.workerDigest.trim()}`,
    `run: ${opts.runUrl.trim()}`,
    "cases:",
  ];
  const sorted = [...opts.failingCases].sort((a, b) => (a.caseKey < b.caseKey ? -1 : 1));
  if (sorted.length === 0) lines.push("- none");
  for (const entry of sorted) lines.push(`- ${entry.caseKey}: ${entry.passes}/${entry.total} passed`);
  return `${lines.join("\n")}\n`;
}

/** Parse the structured body back (round-trip check; free text never appears). */
export function parseReleaseBlockedBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = /^(outcome|reason|version|head|range|reviewer-digest|worker-digest|run):\s*(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

/** Labels per outcome: fail is picked up by Jumi (`jumi` + `no-automerge`); inconclusive is maintainer-only. */
export function labelsForOutcome(outcome: NightlyOutcome): string[] {
  if (outcome === "fail") return ["release-blocked", "jumi", "no-automerge"];
  if (outcome === "inconclusive") return ["release-blocked"];
  return [];
}

/** Rolling-issue action: one open `release-blocked` issue at a time. */
export function decideIssueAction(opts: {
  outcome: NightlyOutcome;
  existingOpen: boolean;
}): "open" | "comment" | "close" | "none" {
  if (opts.outcome === "pass") return opts.existingOpen ? "close" : "none";
  return opts.existingOpen ? "comment" : "open";
}

/** Commit-status description carrying both digests plus the baked version. */
export function candidateStatusDescription(opts: {
  reviewerDigest: string;
  workerDigest: string;
  version: string;
}): string {
  return `reviewer=${opts.reviewerDigest.trim()} worker=${opts.workerDigest.trim()} version=${opts.version.trim()}`;
}

/** Parse a `jumi/candidate` status description back into digests and version. */
export function parseCandidateStatusDescription(
  description: string,
): { reviewerDigest: string; workerDigest: string; version: string } | null {
  const reviewer = /reviewer=(\S+)/.exec(description)?.[1] ?? "";
  const worker = /worker=(\S+)/.exec(description)?.[1] ?? "";
  const version = /version=(\S+)/.exec(description)?.[1] ?? "";
  if (!reviewer || !worker || !version) return null;
  return { reviewerDigest: reviewer, workerDigest: worker, version };
}

/** Which workflow files reference the `release` environment (nightly + manual only). */
export function workflowsReferencingReleaseEnv(files: Record<string, string>): string[] {
  const names: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    if (/environment\s*:\s*['"]?release['"]?/.test(text)) names.push(name);
  }
  return names.sort();
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jumi",
  };
}

export interface GitHubIssueRef {
  number: number;
  state: string;
}

/** Open `release-blocked` issues for this repo (rolling issue: at most one). */
export async function findOpenReleaseBlockedIssues(opts: {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: FetchImpl;
}): Promise<GitHubIssueRef[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const url =
    `${base}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}` +
    `/issues?state=open&labels=release-blocked&per_page=100`;
  const res = await fetchImpl(url, { headers: githubHeaders(opts.token) });
  const text = await res.text().catch(() => "");
  if (res.status !== 200) throw new Error(`GitHub API GET issues → ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as Array<{ number?: number; state?: string }>;
  return parsed
    .filter((issue) => typeof issue.number === "number")
    .map((issue) => ({ number: issue.number as number, state: issue.state ?? "open" }));
}

/** Latest GitHub release tag name (null when no release exists yet). */
export async function getLatestReleaseTag(opts: {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: FetchImpl;
}): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const url =
    `${base}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}` + `/releases/latest`;
  const res = await fetchImpl(url, { headers: githubHeaders(opts.token) });
  if (res.status === 404) return null;
  const text = await res.text().catch(() => "");
  if (res.status !== 200) throw new Error(`GitHub API GET releases/latest → ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { tag_name?: string };
  return typeof parsed.tag_name === "string" && parsed.tag_name ? parsed.tag_name : null;
}

/** Combined commit status states for one SHA, keyed by context. */
export async function getCommitStatusStates(opts: {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  sha: string;
  fetchImpl?: FetchImpl;
}): Promise<Array<{ context: string; state: string; description: string }>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const url =
    `${base}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}` +
    `/commits/${encodeURIComponent(opts.sha)}/status`;
  const res = await fetchImpl(url, { headers: githubHeaders(opts.token) });
  const text = await res.text().catch(() => "");
  if (res.status !== 200) throw new Error(`GitHub API GET commit status → ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { statuses?: Array<{ context?: string; state?: string; description?: string }> };
  return (parsed.statuses ?? []).map((status) => ({
    context: status.context ?? "",
    state: status.state ?? "",
    description: status.description ?? "",
  }));
}

/** Open the rolling `release-blocked` issue with structured fields only. */
export async function createReleaseBlockedIssue(opts: {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  fetchImpl?: FetchImpl;
}): Promise<{ number: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const url = `${base}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/issues`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({ title: opts.title, body: opts.body, labels: opts.labels }),
  });
  const text = await res.text().catch(() => "");
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`GitHub API POST issues → ${res.status}: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text) as { number?: number };
  if (typeof parsed.number !== "number") throw new Error("GitHub API POST issues did not return a number");
  return { number: parsed.number };
}

/** Comment on the open rolling issue (later failing nights comment instead of opening). */
export async function commentReleaseBlockedIssue(opts: {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  fetchImpl?: FetchImpl;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const url =
    `${base}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}` +
    `/issues/${opts.issueNumber}/comments`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({ body: opts.body }),
  });
  const text = await res.text().catch(() => "");
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`GitHub API POST issue comment → ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** Close the rolling issue when the next passing night ships the release. */
export async function closeReleaseBlockedIssue(opts: {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  fetchImpl?: FetchImpl;
}): Promise<void> {
  await commentReleaseBlockedIssue(opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const url =
    `${base}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}` +
    `/issues/${opts.issueNumber}`;
  const res = await fetchImpl(url, {
    method: "PATCH",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({ state: "closed" }),
  });
  const text = await res.text().catch(() => "");
  if (res.status !== 200) throw new Error(`GitHub API PATCH issue → ${res.status}: ${text.slice(0, 200)}`);
}

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "help";
  if (command === "budget") {
    process.stdout.write(`${nightlyBudgetFromEnv()}\n`);
    return;
  }
  if (command === "pi-catalog") {
    process.stdout.write(`${JSON.stringify(defaultNightlyPiCatalog(), null, 2)}\n`);
    return;
  }
  if (command === "is-head-released") {
    const head = args[1] ?? process.env.GITHUB_SHA ?? "";
    const tag = args[2] ?? process.env.LATEST_TAG_SHA ?? "";
    if (!head) throw new Error("is-head-released needs <head-sha> (or GITHUB_SHA)");
    process.stdout.write(`${isHeadReleased(head, tag || null) ? "yes" : "no"}\n`);
    return;
  }
  if (command === "check-candidates") {
    const get = (flag: string): string => {
      const idx = args.indexOf(flag);
      if (idx < 0 || idx + 1 >= args.length) throw new Error(`check-candidates needs ${flag} <value>`);
      return args[idx + 1];
    };
    const checked = checkCandidates({
      headSha: get("--head-sha"),
      expectedVersion: get("--expected-version"),
      reviewer: {
        digest: get("--reviewer-digest"),
        version: get("--reviewer-version"),
        revision: get("--reviewer-revision"),
      },
      worker: {
        digest: get("--worker-digest"),
        version: get("--worker-version"),
        revision: get("--worker-revision"),
      },
    });
    if (!checked.ok) {
      process.stderr.write(`${checked.reason}: ${checked.detail}\n`);
      process.exit(2);
    }
    process.stdout.write("ok\n");
    return;
  }
  if (command === "evaluate") {
    const idx = args.indexOf("--results");
    if (idx < 0 || idx + 1 >= args.length) throw new Error("evaluate needs --results <jsonl> [--expected <csv>]");
    const text = readFileSync(args[idx + 1], "utf8");
    const records: GateRecord[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed) as {
        caseKey?: string;
        verdict?: string;
        trial?: number;
        inconclusiveReason?: string;
      };
      if (!parsed.caseKey || (parsed.verdict !== "pass" && parsed.verdict !== "fail" && parsed.verdict !== "inconclusive")) {
        throw new Error("evaluate results need {caseKey, verdict: pass|fail|inconclusive, trial}");
      }
      records.push({
        caseKey: parsed.caseKey,
        trial: typeof parsed.trial === "number" ? parsed.trial : 0,
        verdict: parsed.verdict,
        ...(parsed.inconclusiveReason ? { inconclusiveReason: parsed.inconclusiveReason } : {}),
      });
    }
    const expectedIdx = args.indexOf("--expected");
    const expected =
      expectedIdx >= 0 && expectedIdx + 1 < args.length
        ? args[expectedIdx + 1].split(",").map((part) => part.trim()).filter(Boolean)
        : undefined;
    const result = evaluateGate(records, expected);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.outcome === "pass" ? 0 : 1);
    return;
  }
  if (command === "labels") {
    const outcome = args[1] as NightlyOutcome;
    if (outcome !== "pass" && outcome !== "fail" && outcome !== "inconclusive") {
      throw new Error("labels needs <pass|fail|inconclusive>");
    }
    for (const label of labelsForOutcome(outcome)) process.stdout.write(`${label}\n`);
    return;
  }
  if (command === "issue-action") {
    const outcome = args[1] as NightlyOutcome;
    const existing = args[2] === "open";
    if (outcome !== "pass" && outcome !== "fail" && outcome !== "inconclusive") {
      throw new Error("issue-action needs <pass|fail|inconclusive> <open|absent>");
    }
    process.stdout.write(`${decideIssueAction({ outcome, existingOpen: existing })}\n`);
    return;
  }
  process.stdout.write(
    "usage: nightly_release.ts <budget|pi-catalog|is-head-released|check-candidates|evaluate|labels|issue-action>\n",
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
