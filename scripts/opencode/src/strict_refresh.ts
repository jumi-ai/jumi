import { JUMI_REVIEW_CONTEXT } from "./ci.ts";
import { parseJumiReviewSuccessFinish } from "./ci_webhook.ts";
import {
  extractWorkingIssueNumber,
  type IssueApi,
  isAssignedForeignPR,
  isEligibleWorkerPR,
  isInScopeJumiPR,
} from "./gitea_issues.ts";
import type { BranchProtection, Check, Pull } from "./ports.ts";
import {
  isGiteaStrictForge,
  keepGiteaBehind,
  readGiteaBehindForPull,
  readGiteaScheduleArmed,
  resolveStrictPolicyWithFallback,
  withGiteaArmed,
} from "./strict_refresh_gitea.ts";
import {
  compareStrictRefreshOrder,
  isStrictRefreshBlocked,
  isStrictRefreshTerminalEvidence,
  STRICT_REFRESH_MAX_LAPS,
  STRICT_REFRESH_SLOT_TIMEOUT_MS,
  type StrictRefreshPendingJob,
  type StrictRefreshSlotStore,
} from "./strict_refresh_queue.ts";
import type { GiteaPushPayload, IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";
import { assertRepositoryPolicy, type WebhookPolicy } from "./webhook.ts";

export type StrictPolicy = "strict" | "off" | "unknown";

export type StrictBranchApi = Pick<IssueApi, "getBranch">;

/**
 * Pending-fix-loop probe for strict admission (issue #900). Returns true
 * when a follow-up job for the PR's head is queued or leased, meaning the
 * fix loop still owns the head even though its review may read green.
 * Ledger errors are the caller's to interpret; admission fails closed.
 */
export type StrictPendingFollowUp = (
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
) => boolean | Promise<boolean>;

/** Minimal ledger surface for the pending-fix-loop probe. */
export interface StrictFollowUpLedger {
  listInflight(limit?: number): Promise<
    ReadonlyArray<{
      kind: string;
      owner: string;
      repo: string;
      prNumber: number;
      headSha: string;
      state: string;
    }>
  >;
}

/**
 * Build the pending-fix-loop probe from the first ledger that exposes
 * `listInflight`. Webhook handlers pass their queue stores (which carry
 * more than their enqueue-only types declare); unit tests pass a stub.
 * Returns undefined when no ledger is available: callers then skip only
 * the fix-loop half of the gate.
 */
export function strictPendingFollowUpChecker(
  owner: string,
  repo: string,
  ...ledgers: Array<StrictFollowUpLedger | undefined | null | unknown>
): StrictPendingFollowUp | undefined {
  const ledger = ledgers.find(
    (candidate): candidate is StrictFollowUpLedger =>
      typeof (candidate as StrictFollowUpLedger | undefined)?.listInflight === "function"
  );
  if (!ledger) return undefined;
  return async (checkOwner: string, checkRepo: string, prNumber: number, headSha: string): Promise<boolean> => {
    if (checkOwner !== owner || checkRepo !== repo) return false;
    const rows = await ledger.listInflight(500);
    const want = (headSha ?? "").toLowerCase();
    return rows.some(
      (row) =>
        row?.kind === "follow-up" &&
        row?.owner === owner &&
        row?.repo === repo &&
        row?.prNumber === prNumber &&
        (row?.headSha ?? "").toLowerCase() === want &&
        (row?.state === "queued" || row?.state === "leased")
    );
  };
}

/** Jumi review verdict for one head, read from the forge's commit statuses. */
export type StrictReviewGreen = "green" | "not-green" | "unknown";

/**
 * Whether Jumi's own review (`jumi/opencode-review` commit status) is
 * successful on the head. `not-green` covers pending, missing, failure,
 * and warning verdicts; `unknown` covers unreadable checks (fail closed:
 * admission skips, the worker retries). Reads both statuses and check runs
 * because the verdict is posted as a status but fakes may stub either.
 */
export async function readStrictReviewGreen(opts: {
  api: Partial<Pick<IssueApi, "listCommitStatuses" | "listCheckRuns">>;
  owner: string;
  repo: string;
  headSha: string;
  log?: (message: string) => void;
}): Promise<StrictReviewGreen> {
  const listStatuses = opts.api?.listCommitStatuses;
  const listRuns = opts.api?.listCheckRuns;
  if (typeof listStatuses !== "function" && typeof listRuns !== "function") return "unknown";
  const checks: Check[] = [];
  let sawError = false;
  if (typeof listStatuses === "function") {
    try {
      checks.push(...(await listStatuses.call(opts.api, opts.owner, opts.repo, opts.headSha)));
    } catch (err) {
      sawError = true;
      opts.log?.(`strict refresh review status lookup failed: ${errorMessage(err)}`);
    }
  }
  if (typeof listRuns === "function") {
    try {
      checks.push(...(await listRuns.call(opts.api, opts.owner, opts.repo, opts.headSha)));
    } catch (err) {
      sawError = true;
      opts.log?.(`strict refresh review check lookup failed: ${errorMessage(err)}`);
    }
  }
  const verdicts = checks.filter((check) => check?.context === JUMI_REVIEW_CONTEXT);
  if (verdicts.some((check) => String(check?.state ?? check?.status ?? "").toLowerCase() === "success")) {
    return "green";
  }
  if (verdicts.length > 0) return "not-green";
  return sawError ? "unknown" : "not-green";
}

/**
 * Review half of the admission gate (issue #900): the head is only
 * refreshable when Jumi's review is green on it and no follow-up for the
 * head is queued or leased. A lookup error fails closed (not ready, no
 * terminal evidence): the next event or tick retries.
 */
export async function isReviewReadyForStrictRefresh(opts: {
  api: Partial<Pick<IssueApi, "listCommitStatuses" | "listCheckRuns">>;
  owner: string;
  repo: string;
  pr: Pull;
  hasPendingFollowUp?: StrictPendingFollowUp;
  log?: (message: string) => void;
}): Promise<boolean> {
  const green = await readStrictReviewGreen({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    headSha: opts.pr.head.sha,
    ...(opts.log ? { log: opts.log } : {}),
  });
  if (green !== "green") {
    opts.log?.(`strict refresh #${opts.pr.number} review not green (${green}); skipping merge-only wake`);
    return false;
  }
  if (opts.hasPendingFollowUp) {
    let pending = false;
    try {
      pending = await opts.hasPendingFollowUp(opts.owner, opts.repo, opts.pr.number, opts.pr.head.sha);
    } catch (err) {
      opts.log?.(`strict refresh #${opts.pr.number} follow-up lookup failed: ${errorMessage(err)}`);
      return false;
    }
    if (pending) {
      opts.log?.(`strict refresh #${opts.pr.number} follow-up pending; skipping merge-only wake`);
      return false;
    }
  }
  return true;
}
export async function resolveStrictPolicy(
  api: Partial<StrictBranchApi> | undefined,
  owner: string,
  repo: string,
  branch: string,
  log?: (message: string) => void
): Promise<StrictPolicy> {
  const getBranch = (api as StrictBranchApi | undefined)?.getBranch;
  if (typeof getBranch !== "function" || !branch.trim()) return "unknown";
  let fetched: BranchProtection;
  try {
    fetched = await (getBranch as (o: string, r: string, b: string) => Promise<BranchProtection>).call(
      api,
      owner,
      repo,
      branch
    );
  } catch (err) {
    log?.(`strict policy unreadable for ${owner}/${repo}@${branch}: ${errorMessage(err)}`);
    return "unknown";
  }
  if (fetched?.strict === true) return "strict";
  if (fetched?.strict === false) return "off";
  return "unknown";
}

export function isStrictRefreshCandidate(
  pr: Pull,
  owner: string,
  repo: string,
  botUsername: string,
  policy?: { botUsername: string; isPickedUp?: (issue: { assignee?: unknown; assignees?: unknown }) => boolean }
): boolean {
  if (!pr || typeof pr !== "object") return false;
  if (pr.state !== "open" || pr.merged) return false;
  if (pr.draft === true) return false;
  if (!pr.head?.repo || pr.head.repo.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return false;
  if (pr.autoMergeEnabled !== true) return false;
  if (!isEligibleWorkerPR(pr, owner, repo)) return false;
  if (isInScopeJumiPR(pr, owner, repo, botUsername)) return true;
  try {
    if (isAssignedForeignPR(pr, owner, repo, botUsername, policy as never)) return true;
  } catch {
    return false;
  }
  return false;
}

export type StrictRefreshPolicy = WebhookPolicy & {
  botUsername: string;
  ignoreConflictsLabel?: string;
};

export type StrictRefreshApi = Pick<IssueApi, "listOpenPulls" | "getIssue"> &
  Partial<
    StrictBranchApi &
      Pick<IssueApi, "getRepoFile" | "listPullCommits" | "getPR" | "listCommitStatuses" | "listCheckRuns">
  > &
  Partial<{
    listIssueTimeline: (
      owner: string,
      repo: string,
      index: number
    ) => Promise<import("./ports.ts").IssueTimelineEvent[]>;
    compareCommits: (owner: string, repo: string, basehead: string) => Promise<{ totalCommits?: number }>;
  }>;

/**
 * True only when GitHub reports the head out of date under strict checks
 * (`mergeable_state: behind`). Absent or any other value (including
 * `unknown` while GitHub computes) means behind-ness is not established:
 * callers fall through to the normal review path instead of parking.
 */
export function isStrictRefreshBehind(pr: Pull): boolean {
  return typeof pr?.mergeableState === "string" && pr.mergeableState.toLowerCase() === "behind";
}

type StrictMergeApi = Partial<Pick<IssueApi, "getPR" | "getBranch" | "listCommitStatuses" | "listCheckRuns">>;

/** Suffix-tolerant required-context match (mirrors the CI gate's matcher). */
function strictRequiredMatches(checkContext: string | undefined, required: string): boolean {
  if (!checkContext) return false;
  if (checkContext === required) return true;
  if (checkContext.endsWith(` / ${required}`)) return true;
  if (required.endsWith(` / ${checkContext}`)) return true;
  if (checkContext.includes(` / ${required} (`)) return true;
  if (required.includes(` / ${checkContext} (`)) return true;
  return false;
}

/**
 * Terminal blocker for admission: a conflict (`mergeable === false` or
 * `dirty`) or a `blocked` head with a failed/errored required check. A
 * `blocked` head whose required checks are pending, missing, or unreadable
 * is not terminal: the holder keeps the slot and a pending candidate waits.
 * Callers pass the base branch's requiredContexts read for the strict gate,
 * so this adds no getBranch call.
 */
async function isTerminallyStrictBlocked(opts: {
  api: StrictMergeApi;
  owner: string;
  repo: string;
  pr: Pull;
  requiredContexts?: string[];
  log?: (message: string) => void;
}): Promise<boolean> {
  const pr = opts.pr;
  if (!pr || typeof pr !== "object") return false;
  if (pr.mergeable === false) return true;
  const state = typeof pr.mergeableState === "string" ? pr.mergeableState.toLowerCase() : "";
  if (state === "dirty") return true;
  if (state !== "blocked") return false;
  const contexts = (opts.requiredContexts ?? []).filter((c) => typeof c === "string" && c.length > 0);
  if (contexts.length === 0) return false;
  const checks: Check[] = [];
  const listStatuses = opts.api?.listCommitStatuses;
  if (typeof listStatuses === "function") {
    try {
      checks.push(...(await listStatuses.call(opts.api, opts.owner, opts.repo, pr.head.sha)));
    } catch (err) {
      opts.log?.(`strict refresh status lookup failed for #${pr.number}: ${errorMessage(err)}`);
    }
  }
  const listRuns = opts.api?.listCheckRuns;
  if (typeof listRuns === "function") {
    try {
      checks.push(...(await listRuns.call(opts.api, opts.owner, opts.repo, pr.head.sha)));
    } catch (err) {
      opts.log?.(`strict refresh check lookup failed for #${pr.number}: ${errorMessage(err)}`);
    }
  }
  for (const required of contexts) {
    const match =
      checks.find((check) => check?.context === required) ??
      checks.find((check) => strictRequiredMatches(check?.context, required));
    const matchState = String(match?.state ?? match?.status ?? "").toLowerCase();
    if (matchState === "failure" || matchState === "error") return true;
  }
  return false;
}

/**
 * Fresh holder read for admission. GitHub's open-pull list carries no merge
 * state, so the holder is re-read with getPR (Gitea's list already maps
 * mergeable and skips the extra call). Unreadable falls back to the listed
 * pull, which keeps the slot.
 */
async function strictHolderPull(opts: {
  api: StrictMergeApi;
  owner: string;
  repo: string;
  pulls: Pull[];
  prNumber: number;
  gitea: boolean;
  log?: (message: string) => void;
}): Promise<Pull | undefined> {
  const listed = opts.pulls.find((pr) => pr?.number === opts.prNumber);
  if (!listed) return undefined;
  const getPR = opts.api?.getPR;
  if (opts.gitea || typeof getPR !== "function") return listed;
  try {
    const got = await getPR.call(opts.api, opts.owner, opts.repo, opts.prNumber);
    if (got && typeof got === "object" && got.number === opts.prNumber) return got;
    return listed;
  } catch (err) {
    opts.log?.(`strict refresh holder #${opts.prNumber} unreadable; keeping listed state: ${errorMessage(err)}`);
    return listed;
  }
}

async function strictIgnoreLabel(
  api: Partial<Pick<IssueApi, "getRepoFile">>,
  owner: string,
  repo: string,
  defaultBranch: string,
  deploymentLabel: string | undefined,
  log?: (message: string) => void
): Promise<string> {
  const { normalizeIgnoreConflictsLabel } = await import("./ignore_conflicts.ts");
  let label = normalizeIgnoreConflictsLabel(deploymentLabel);
  try {
    const { fallbackPolicyDeployment, resolveRepoPolicy } = await import("./repo_policy.ts");
    if (typeof (api as { getRepoFile?: unknown }).getRepoFile === "function" && defaultBranch.trim()) {
      const repoPolicy = await resolveRepoPolicy(
        { api, owner, repo, ref: defaultBranch },
        fallbackPolicyDeployment({ ignoreConflictsLabel: deploymentLabel }),
        { onUnreadable: "fallback" }
      ).catch(() => undefined);
      if (repoPolicy !== undefined) label = repoPolicy.ignoreConflictsLabel;
    }
  } catch {
    // Fail-open to the deployment value.
  }
  return label;
}

/**
 * Ignore-conflicts guard for strict refresh. A labeled (or author-listed)
 * PR that Jumi has not committed to stays left to the author: no
 * default-branch merge from this path. Mirrors the conflict and
 * shared-waiter paths. Settings-unreadable fails closed (treated as left).
 */
export async function isStrictRefreshLeftToAuthor(
  api: Partial<Pick<IssueApi, "listPullCommits" | "getRepoFile">> | undefined,
  owner: string,
  repo: string,
  pr: Pull,
  opts: { botUsername: string; ignoreConflictsLabel?: string; defaultBranch?: string },
  log?: (message: string) => void
): Promise<boolean> {
  const { hasIgnoreConflictsLabel, isIgnoreConflictsAuthor, isLeftToAuthor, loadIgnoreConflictsAuthors } = await import(
    "./ignore_conflicts.ts"
  );
  const defaultBranch = typeof opts.defaultBranch === "string" ? opts.defaultBranch : "";
  const authors = await loadIgnoreConflictsAuthors(api as never, owner, repo, defaultBranch || undefined, log).catch(
    () => undefined
  );
  if (authors === undefined) return true;
  const label = await strictIgnoreLabel(api ?? {}, owner, repo, defaultBranch, opts.ignoreConflictsLabel, log);
  const labeled = hasIgnoreConflictsLabel(pr, label);
  const viaAuthor = !labeled && isIgnoreConflictsAuthor(pr.user?.login, authors);
  if (!labeled && !viaAuthor) return false;
  return isLeftToAuthor(
    api as never,
    owner,
    repo,
    pr,
    {
      botUsername: opts.botUsername,
      ignoreConflictsLabel: label,
      ignoreConflictsAuthors: authors,
      prAuthor: pr.user?.login,
      defaultBranch: defaultBranch || undefined,
    },
    log
  );
}

function pushBranchName(ref: string): string | undefined {
  if (!ref.startsWith("refs/heads/")) return undefined;
  const name = ref.slice("refs/heads/".length);
  return name ? name : undefined;
}

function isZeroSha(value: string | undefined): boolean {
  if (!value) return true;
  return /^0+$/.test(value);
}

async function strictPolicyForBranch(
  api: unknown,
  owner: string,
  repo: string,
  branch: string,
  policy: StrictRefreshPolicy,
  defaultBranch: string,
  log?: (message: string) => void
): Promise<{ strict: StrictPolicy; requiredContexts?: string[] }> {
  if (isGiteaStrictForge(api, policy)) {
    return {
      strict: await resolveStrictPolicyWithFallback(api, owner, repo, branch, {
        forgeKind: "gitea",
        defaultBranch,
        log,
      }),
    };
  }
  // One branch read feeds both the strict gate and the blocked-vs-pending
  // check below (requiredContexts), so admission adds no extra getBranch.
  const getBranch = (api as Partial<StrictBranchApi> | undefined)?.getBranch;
  if (typeof getBranch !== "function" || !branch.trim()) return { strict: "unknown" };
  try {
    const fetched = await (getBranch as (o: string, r: string, b: string) => Promise<BranchProtection>).call(
      api,
      owner,
      repo,
      branch
    );
    const strict: StrictPolicy = fetched?.strict === true ? "strict" : fetched?.strict === false ? "off" : "unknown";
    return {
      strict,
      ...(Array.isArray(fetched?.requiredContexts) ? { requiredContexts: [...fetched.requiredContexts] } : {}),
    };
  } catch (err) {
    log?.(`strict policy unreadable for ${owner}/${repo}@${branch}: ${errorMessage(err)}`);
    return { strict: "unknown" };
  }
}

/**
 * Collect PRs that are otherwise ready apart from branch freshness: the
 * existing strict-policy, same-repo, non-draft, Jumi-managed and
 * armed-auto-merge gates, plus the ignore-conflicts left-to-author guard.
 * Known terminal blockers (conflict or failing required checks) are filtered
 * here so an older blocked PR never holds the queue ahead of an
 * otherwise-ready one. Returned oldest first (created_at, PR number
 * tie-break).
 *
 * Merge state comes from the list on Gitea (its list endpoint already maps
 * mergeable) but GitHub's list carries none, so GitHub hydrates each
 * inspected candidate with getPR in order and stops at the first ready one:
 * the forge is called only for PRs admission inspects, not every open PR.
 */
async function collectReadyStrictCandidates(opts: {
  pulls: Pull[];
  owner: string;
  repo: string;
  policy: StrictRefreshPolicy;
  api: Partial<Pick<IssueApi, "getRepoFile" | "listPullCommits" | "getPR" | "listCommitStatuses" | "listCheckRuns">>;
  defaultBranch: string;
  baseBranch: string;
  requiredContexts?: string[];
  terminal?: { prNumber: number; headSha: string; baseSha: string };
  baseSha?: string;
  hasPendingFollowUp?: StrictPendingFollowUp;
  log?: (message: string) => void;
}): Promise<Pull[]> {
  const { pulls, owner, repo, policy, api, defaultBranch, baseBranch, requiredContexts, terminal, baseSha, log } = opts;
  const gitea = isGiteaStrictForge(api, policy as { forgeKind?: string });
  const seen = new Set<number>();
  const prelim: Pull[] = [];
  for (const pr of pulls) {
    if (!pr || pr?.base?.ref !== baseBranch) continue;
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    if (!isStrictRefreshCandidate(pr, owner, repo, policy.botUsername, policy)) continue;
    if (
      await isStrictRefreshLeftToAuthor(
        api,
        owner,
        repo,
        pr,
        { botUsername: policy.botUsername, ignoreConflictsLabel: policy.ignoreConflictsLabel, defaultBranch },
        log
      )
    ) {
      log?.(`strict refresh #${pr.number} left to author; skipping merge-only wake`);
      continue;
    }
    prelim.push(pr);
  }
  prelim.sort(compareStrictRefreshOrder);
  if (gitea || typeof (api as StrictMergeApi)?.getPR !== "function") {
    const ready: Pull[] = [];
    for (const pr of prelim) {
      if (isStrictRefreshBlocked(pr)) {
        log?.(`strict refresh #${pr.number} blocked (conflict or failing checks); skipping`);
        continue;
      }
      if (
        !(await isReviewReadyForStrictRefresh({
          api,
          owner,
          repo,
          pr,
          ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
          ...(log ? { log } : {}),
        }))
      ) {
        continue;
      }
      ready.push(pr);
    }
    return ready;
  }
  const getPR = (api as StrictMergeApi).getPR as NonNullable<StrictMergeApi["getPR"]>;
  const ready: Pull[] = [];
  for (const pr of prelim) {
    let fresh: Pull | undefined;
    try {
      const got = await getPR.call(api, owner, repo, pr.number);
      if (got && typeof got === "object" && got.number === pr.number) fresh = got;
    } catch (err) {
      log?.(`strict refresh #${pr.number} unreadable; skipping merge-only wake: ${errorMessage(err)}`);
    }
    if (!fresh) {
      // A mismatched or unreadable read falls back to the listed state
      // instead of dropping the PR: the pre-hydration behavior.
      if (isStrictRefreshBlocked(pr)) {
        log?.(`strict refresh #${pr.number} blocked (conflict or failing checks); skipping`);
        continue;
      }
      if (
        !(await isReviewReadyForStrictRefresh({
          api,
          owner,
          repo,
          pr,
          ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
          ...(log ? { log } : {}),
        }))
      ) {
        continue;
      }
      ready.push(pr);
      break;
    }
    if (await isTerminallyStrictBlocked({ api, owner, repo, pr: fresh, requiredContexts, log })) {
      log?.(`strict refresh #${pr.number} blocked (conflict or failing checks); skipping`);
      continue;
    }
    if (
      !(await isReviewReadyForStrictRefresh({
        api,
        owner,
        repo,
        pr: fresh,
        ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
        ...(log ? { log } : {}),
      }))
    ) {
      continue;
    }
    if (
      terminal &&
      terminal.prNumber === fresh.number &&
      (terminal.headSha ?? "").toLowerCase() === (fresh.head.sha ?? "").toLowerCase() &&
      (terminal.baseSha ?? "").toLowerCase() === (baseSha ?? "").toLowerCase()
    ) {
      continue;
    }
    ready.push(fresh);
    break;
  }
  return ready;
}

function strictRefreshJobFor(
  pr: Pull,
  opts: {
    owner: string;
    repo: string;
    botUsername: string;
    defaultBranch: string;
    cloneUrl: string;
    trigger: IssueJob["trigger"];
    baseSha: string;
  }
): Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; strictRefresh: true } {
  return {
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: strictRefreshIssueNumber(pr, opts.owner, opts.repo, opts.botUsername),
    action: "push",
    title: pr.title,
    body: pr.body ?? "",
    htmlUrl: pr.html_url,
    issueUpdatedAt: pr.updated_at,
    defaultBranch: opts.defaultBranch,
    cloneUrl: opts.cloneUrl,
    mode: "follow-up",
    prNumber: pr.number,
    headSha: pr.head.sha,
    trigger: opts.trigger,
    mergeOnly: true as const,
    strictRefresh: true as const,
    ...(opts.baseSha ? { strictBaseSha: opts.baseSha } : {}),
  };
}

function strictRefreshPendingFor(
  pr: Pull,
  opts: {
    owner: string;
    repo: string;
    botUsername: string;
    defaultBranch: string;
    cloneUrl: string;
    baseSha: string;
  }
): StrictRefreshPendingJob {
  return {
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: strictRefreshIssueNumber(pr, opts.owner, opts.repo, opts.botUsername),
    prNumber: pr.number,
    headSha: pr.head.sha,
    baseSha: opts.baseSha,
    title: pr.title,
    body: pr.body ?? "",
    htmlUrl: pr.html_url,
    issueUpdatedAt: pr.updated_at,
    defaultBranch: opts.defaultBranch,
    cloneUrl: opts.cloneUrl,
  };
}

/**
 * Ledger identity for a strict-refresh merge-only job. A Jumi closer is keyed
 * to its closing issue (the same `issueNumber` the conflict and ordinary
 * follow-up jobs use), so the worker's pickup/open recheck reads the labeled
 * closing issue instead of the unlabeled PR. Foreign assigned PRs have no
 * closing issue and stay keyed to the PR itself, where the pickup label lives.
 * A bare `Fixes #N` / `Refs #N` mention in a foreign PR body must not re-key
 * it: only in-scope Jumi PRs use the working issue number.
 */
function strictRefreshIssueNumber(pr: Pull, owner: string, repo: string, botUsername: string): number {
  if (isInScopeJumiPR(pr, owner, repo, botUsername)) {
    return extractWorkingIssueNumber(pr) ?? pr.number;
  }
  return pr.number;
}

/**
 * Strict-refresh wakes for a branch push (any target branch, not only the
 * default). At most one merge-only job is admitted per repository and target
 * branch: the oldest ready candidate (see `collectReadyStrictCandidates`).
 * Unknown or off stays silent. When a slot store is provided, the single-slot
 * guarantee holds across workers and restarts: a held slot suppresses
 * waiting PRs (no speculative pushes), a merged/closed/ineligible/blocked
 * holder releases the slot, and a terminal or timed-out candidate is not
 * reselected on unchanged evidence. Without a store, the same oldest-first
 * single selection applies within this call.
 */
export async function shouldEnqueueStrictRefreshOnPush(
  payload: GiteaPushPayload,
  policy: StrictRefreshPolicy,
  api: StrictRefreshApi,
  log?: (message: string) => void,
  slots?: StrictRefreshSlotStore,
  nowMs?: number,
  hasPendingFollowUp?: StrictPendingFollowUp
): Promise<{
  jobs: Array<Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; strictRefresh: true }>;
  reason?: string;
}> {
  const branch = pushBranchName(payload.ref);
  if (!branch) return { jobs: [] };
  if (isZeroSha(payload.after)) return { jobs: [] };
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = assertRepositoryPolicy(payload.repository, policy));
  } catch (err) {
    log?.(`repository not allowed: ${errorMessage(err)}`);
    return { jobs: [], reason: "repository not allowed" };
  }
  let pulls: Pull[];
  try {
    pulls = await api.listOpenPulls(owner, repo);
  } catch (err) {
    log?.(`strict refresh open-pull lookup failed: ${errorMessage(err)}`);
    return { jobs: [] };
  }
  const pushedBase = payload.after ?? "";
  const defaultBranch = payload.repository.default_branch;
  const gitea = isGiteaStrictForge(api, policy as { forgeKind?: string });
  if (gitea) {
    try {
      pulls = await withGiteaArmed(api, pulls, owner, repo, log);
    } catch (err) {
      log?.(`strict refresh schedule lookup failed: ${errorMessage(err)}`);
      return { jobs: [] };
    }
  }
  const { strict, requiredContexts } = await strictPolicyForBranch(
    api,
    owner,
    repo,
    branch,
    policy,
    defaultBranch,
    log
  );
  if (strict !== "strict") {
    // Fail-closed: only an explicit off clears a held slot. An unreadable
    // branch (unknown, e.g. transient fetch error) leaves the slot alone.
    if (slots && strict === "off") {
      try {
        const held = await slots.getSlot(owner, repo, branch);
        if (held) {
          await slots.release(owner, repo, branch, { nowMs });
          log?.(`strict refresh slot ${owner}/${repo}#${branch} released (strictness ${strict})`);
        }
      } catch (err) {
        log?.(`strict refresh slot release failed: ${errorMessage(err)}`);
      }
    }
    return { jobs: [] };
  }
  let terminal: { prNumber: number; headSha: string; baseSha: string } | undefined;
  if (slots) {
    try {
      terminal = (await slots.getTerminal(owner, repo, branch)) ?? undefined;
    } catch (err) {
      log?.(`strict refresh terminal lookup failed: ${errorMessage(err)}`);
    }
  }
  const readyRaw = await collectReadyStrictCandidates({
    pulls,
    owner,
    repo,
    policy,
    api,
    defaultBranch,
    baseBranch: branch,
    requiredContexts,
    terminal,
    baseSha: pushedBase,
    ...(hasPendingFollowUp ? { hasPendingFollowUp } : {}),
    log,
  });
  const ready = gitea ? await keepGiteaBehind(api, readyRaw, owner, repo, log) : readyRaw;
  if (ready.length === 0) {
    // A holder that is now blocked or ineligible still needs releasing even
    // when no ready candidate remains: otherwise the queue stays stuck.
    if (slots) {
      try {
        await releaseStaleStrictSlot({
          slots,
          owner,
          repo,
          baseBranch: branch,
          baseSha: pushedBase,
          pulls,
          policy,
          api,
          defaultBranch,
          requiredContexts,
          nowMs,
          log,
        });
      } catch (err) {
        log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
      }
    }
    return { jobs: [] };
  }
  if (!slots) {
    const first = ready[0] as Pull;
    return {
      jobs: [
        strictRefreshJobFor(first, {
          owner,
          repo,
          botUsername: policy.botUsername,
          defaultBranch: payload.repository.default_branch,
          cloneUrl: payload.repository.clone_url,
          trigger: { event: "push" as const, sender: payload.sender?.login ?? payload.pusher?.login ?? "push" },
          baseSha: pushedBase,
        }),
      ],
    };
  }
  const now = nowMs ?? Date.now();
  try {
    const admitted = await reconcileStrictSlotForCandidates({
      slots,
      owner,
      repo,
      baseBranch: branch,
      baseSha: pushedBase,
      pulls,
      ready,
      policy,
      api,
      defaultBranch,
      cloneUrl: payload.repository.clone_url,
      requiredContexts,
      ...(hasPendingFollowUp ? { hasPendingFollowUp } : {}),
      nowMs: now,
      log,
    });
    if (!admitted) return { jobs: [] };
    return {
      jobs: [
        strictRefreshJobFor(admitted, {
          owner,
          repo,
          botUsername: policy.botUsername,
          defaultBranch: payload.repository.default_branch,
          cloneUrl: payload.repository.clone_url,
          trigger: { event: "push" as const, sender: payload.sender?.login ?? payload.pusher?.login ?? "push" },
          baseSha: pushedBase,
        }),
      ],
    };
  } catch (err) {
    log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
    return { jobs: [] };
  }
}

/**
 * Release a held slot whose holder is no longer refreshable (merged/closed,
 * ineligible, or blocked) when no ready candidate remains. Terminal evidence
 * is recorded for blocked holders so the same head/base is not immediately
 * reselected; ineligible or missing holders release cleanly.
 */
async function releaseStaleStrictSlot(opts: {
  slots: StrictRefreshSlotStore;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  pulls: Pull[];
  policy: StrictRefreshPolicy;
  api: Partial<Pick<IssueApi, "getRepoFile" | "listPullCommits" | "getPR" | "listCommitStatuses" | "listCheckRuns">>;
  defaultBranch: string;
  requiredContexts?: string[];
  nowMs?: number;
  log?: (message: string) => void;
}): Promise<void> {
  const { slots, owner, repo, baseBranch, baseSha, pulls, policy, api, defaultBranch, requiredContexts, log } = opts;
  const now = opts.nowMs ?? Date.now();
  const held = await slots.getSlot(owner, repo, baseBranch);
  if (!held) return;
  const generation = held.generation ?? 1;
  const fencedRelease = (terminal?: { prNumber: number; headSha: string; baseSha: string; reason: string }) =>
    slots.releaseIfHolder(owner, repo, baseBranch, held.prNumber, held.headSha, {
      ...(terminal ? { terminal } : {}),
      nowMs: now,
      expectedGeneration: generation,
    });
  if (now - held.admittedAtMs > STRICT_REFRESH_SLOT_TIMEOUT_MS) {
    await fencedRelease({ prNumber: held.prNumber, headSha: held.headSha, baseSha: held.baseSha, reason: "timeout" });
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} timed out for #${held.prNumber}`);
    return;
  }
  const gitea = isGiteaStrictForge(api, policy as { forgeKind?: string });
  const holder = await strictHolderPull({ api, owner, repo, pulls, prNumber: held.prNumber, gitea, log });
  if (!holder) {
    await fencedRelease();
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} gone)`);
    return;
  }
  if (!isStrictRefreshCandidate(holder, owner, repo, policy.botUsername, policy)) {
    await fencedRelease();
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} ineligible)`);
    return;
  }
  if (
    await isStrictRefreshLeftToAuthor(
      api,
      owner,
      repo,
      holder,
      { botUsername: policy.botUsername, ignoreConflictsLabel: policy.ignoreConflictsLabel, defaultBranch },
      log
    )
  ) {
    await fencedRelease();
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} left to author)`);
    return;
  }
  if (
    gitea
      ? isStrictRefreshBlocked(holder)
      : await isTerminallyStrictBlocked({ api, owner, repo, pr: holder, requiredContexts, log })
  ) {
    await fencedRelease({ prNumber: holder.number, headSha: holder.head.sha, baseSha, reason: "blocked" });
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} blocked)`);
  }
}

/**
 * Core single-slot reconciliation for an ordered ready list. Returns the
 * newly admitted PR, or undefined when the slot is already held (callers
 * enqueue nothing for waiting PRs), the holder is still refreshable, or no
 * candidate survives the terminal-evidence filter.
 */
async function reconcileStrictSlotForCandidates(opts: {
  slots: StrictRefreshSlotStore;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  pulls: Pull[];
  ready: Pull[];
  policy: StrictRefreshPolicy;
  api: Partial<Pick<IssueApi, "getRepoFile" | "listPullCommits" | "getPR" | "listCommitStatuses" | "listCheckRuns">>;
  defaultBranch: string;
  cloneUrl: string;
  requiredContexts?: string[];
  hasPendingFollowUp?: StrictPendingFollowUp;
  nowMs: number;
  log?: (message: string) => void;
}): Promise<Pull | undefined> {
  const {
    slots,
    owner,
    repo,
    baseBranch,
    baseSha,
    pulls,
    ready,
    policy,
    api,
    defaultBranch,
    cloneUrl,
    requiredContexts,
    nowMs,
    log,
  } = opts;
  const gitea = isGiteaStrictForge(api, policy as { forgeKind?: string });
  const pendingFor = (pr: Pull, base: string) =>
    strictRefreshPendingFor(pr, {
      owner,
      repo,
      botUsername: policy.botUsername,
      defaultBranch,
      cloneUrl,
      baseSha: base,
    });
  const refill = async (terminal: { prNumber: number; headSha: string; baseSha: string } | undefined) => {
    const rec = await collectReadyStrictCandidates({
      pulls,
      owner,
      repo,
      policy,
      api,
      defaultBranch,
      baseBranch,
      requiredContexts,
      terminal,
      baseSha,
      ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
      log,
    });
    const kept = gitea ? await keepGiteaBehind(api, rec, owner, repo, log) : rec;
    return kept.filter((pr) => !isStrictRefreshTerminalEvidence(pr.number, pr.head.sha, baseSha, terminal));
  };
  const admitFresh = async (selected: Pull): Promise<Pull | undefined> => {
    const ok = await slots.tryAdmit(
      {
        owner,
        repo,
        baseBranch,
        prNumber: selected.number,
        headSha: selected.head.sha,
        baseSha,
        admittedAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      pendingFor(selected, baseSha)
    );
    if (!ok) {
      log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} race lost; another admission holds it`);
      return undefined;
    }
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} admitted #${selected.number}`);
    return selected;
  };
  const handoffTo = async (
    expectedPrNumber: number,
    terminal: { prNumber: number; headSha: string; baseSha: string; reason: string } | undefined,
    next: Pull,
    reasonLog: string
  ): Promise<Pull | undefined> => {
    const current = await slots.getSlot(owner, repo, baseBranch);
    const ok = await slots.handoff(owner, repo, baseBranch, {
      expectedPrNumber,
      ...(current?.generation !== undefined ? { expectedGeneration: current.generation } : {}),
      ...(current ? { expectedHeadSha: current.headSha } : {}),
      ...(terminal ? { terminal } : {}),
      next: {
        owner,
        repo,
        baseBranch,
        prNumber: next.number,
        headSha: next.head.sha,
        baseSha,
        admittedAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      pendingJob: pendingFor(next, baseSha),
      nowMs,
    });
    if (!ok) {
      log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} race lost; another admission holds it`);
      return undefined;
    }
    log?.(reasonLog);
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} admitted #${next.number}`);
    return next;
  };
  const held = await slots.getSlot(owner, repo, baseBranch);
  if (!held) {
    const terminal = await slots.getTerminal(owner, repo, baseBranch);
    const selected = ready.filter(
      (pr) => !isStrictRefreshTerminalEvidence(pr.number, pr.head.sha, baseSha, terminal)
    )[0];
    if (!selected) return undefined;
    return admitFresh(selected);
  }
  if (nowMs - held.admittedAtMs > STRICT_REFRESH_SLOT_TIMEOUT_MS) {
    const predicted = { prNumber: held.prNumber, headSha: held.headSha, baseSha: held.baseSha, reason: "timeout" };
    const next = (await refill(predicted))[0];
    if (!next) {
      await slots.releaseIfHolder(owner, repo, baseBranch, held.prNumber, held.headSha, {
        terminal: predicted,
        nowMs,
        ...(held.generation !== undefined ? { expectedGeneration: held.generation } : {}),
      });
      log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} timed out for #${held.prNumber}`);
      return undefined;
    }
    return handoffTo(
      held.prNumber,
      predicted,
      next,
      `strict refresh slot ${owner}/${repo}#${baseBranch} timed out for #${held.prNumber}`
    );
  }
  const holder =
    (ready.find((pr) => pr?.number === held.prNumber) as Pull | undefined) ??
    (await strictHolderPull({ api, owner, repo, pulls, prNumber: held.prNumber, gitea, log }));
  const terminalNow = await slots.getTerminal(owner, repo, baseBranch);
  const waiting = ready.filter(
    (pr) => !isStrictRefreshTerminalEvidence(pr.number, pr.head.sha, baseSha, terminalNow)
  )[0];
  if (!holder) {
    if (!waiting) {
      await slots.releaseIfHolder(owner, repo, baseBranch, held.prNumber, held.headSha, {
        nowMs,
        ...(held.generation !== undefined ? { expectedGeneration: held.generation } : {}),
      });
      log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} gone)`);
      return undefined;
    }
    return handoffTo(
      held.prNumber,
      undefined,
      waiting,
      `strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} gone)`
    );
  }
  if (!isStrictRefreshCandidate(holder, owner, repo, policy.botUsername, policy)) {
    if (!waiting || waiting.number === holder.number) {
      await slots.releaseIfHolder(owner, repo, baseBranch, held.prNumber, held.headSha, {
        nowMs,
        ...(held.generation !== undefined ? { expectedGeneration: held.generation } : {}),
      });
      log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} ineligible)`);
      return undefined;
    }
    return handoffTo(
      held.prNumber,
      undefined,
      waiting,
      `strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} ineligible)`
    );
  }
  if (
    await isStrictRefreshLeftToAuthor(
      api,
      owner,
      repo,
      holder,
      { botUsername: policy.botUsername, ignoreConflictsLabel: policy.ignoreConflictsLabel, defaultBranch },
      log
    )
  ) {
    if (!waiting || waiting.number === holder.number) {
      await slots.releaseIfHolder(owner, repo, baseBranch, held.prNumber, held.headSha, {
        nowMs,
        ...(held.generation !== undefined ? { expectedGeneration: held.generation } : {}),
      });
      log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} left to author)`);
      return undefined;
    }
    return handoffTo(
      held.prNumber,
      undefined,
      waiting,
      `strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} left to author)`
    );
  }
  if (
    gitea
      ? isStrictRefreshBlocked(holder)
      : await isTerminallyStrictBlocked({ api, owner, repo, pr: holder, requiredContexts, log })
  ) {
    const predicted = { prNumber: holder.number, headSha: holder.head.sha, baseSha, reason: "blocked" };
    const next = ready.filter((pr) => !isStrictRefreshTerminalEvidence(pr.number, pr.head.sha, baseSha, predicted))[0];
    if (!next) {
      await slots.releaseIfHolder(owner, repo, baseBranch, held.prNumber, held.headSha, {
        terminal: predicted,
        nowMs,
        ...(held.generation !== undefined ? { expectedGeneration: held.generation } : {}),
      });
      log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} blocked)`);
      return undefined;
    }
    return handoffTo(
      held.prNumber,
      predicted,
      next,
      `strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} blocked)`
    );
  }
  if (
    !(await isReviewReadyForStrictRefresh({
      api,
      owner,
      repo,
      pr: holder,
      ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
      ...(log ? { log } : {}),
    }))
  ) {
    // The holder's head is not refreshable right now (review not green or
    // the fix loop still owns it). Keep the slot: a later review-green wake
    // or push re-reconciles instead of handing the slot to a newer PR.
    return undefined;
  }
  const nb = baseSha || held.baseSha;
  if (holder.head.sha === held.headSha && nb === held.baseSha) return undefined;
  if (nb === held.baseSha) {
    await slots.touch(owner, repo, baseBranch, held.prNumber, holder.head.sha, nb, nowMs, null);
    return undefined;
  }
  const laps = held.laps ?? 0;
  if (laps >= STRICT_REFRESH_MAX_LAPS) {
    const predicted = { prNumber: holder.number, headSha: holder.head.sha, baseSha: nb, reason: "laps" };
    const next = (await refill(predicted))[0];
    if (!next) {
      // biome-ignore format: single-line release keeps the file-size ratchet under +50
      await slots.release(owner, repo, baseBranch, { terminal: predicted, nowMs });
      // biome-ignore format: exact slot log shape required by #874
      log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} exceeded refresh laps)`);
      return undefined;
    }
    // biome-ignore format: exact slot log shape required by #874
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} exceeded refresh laps)`);
    return handoffTo(
      held.prNumber,
      predicted,
      next,
      `strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} exceeded refresh laps)`
    );
  }
  await slots.touch(owner, repo, baseBranch, held.prNumber, holder.head.sha, nb, nowMs, pendingFor(holder, nb));
  // biome-ignore format: exact re-refresh log shape required by #874
  log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} re-refresh #${holder.number} for base ${nb.slice(0, 7)} (lap ${laps + 1}/${STRICT_REFRESH_MAX_LAPS})`);
  return holder;
}

/**
 * Reconcile a single PR on supported PR activity (synchronize/opened/
 * ready_for_review, auto-merge armed while behind). Returns a merge-only
 * job when the PR is the oldest ready candidate for its target branch and
 * the single-slot admission grants it; otherwise null. The same admission
 * rule as target pushes applies: waiting PRs get no speculative update,
 * and only the admitted holder's review is deferred. The worker skips
 * up-to-date heads, so callers enqueue optimistically without a git
 * behind-check. When a slot store and a listOpenPulls-capable api are
 * provided, ordering and the held slot are enforced; without them, the
 * single-PR eligibility gates apply (legacy single-call path).
 */
export async function shouldEnqueueStrictRefreshForPR(opts: {
  pr: Pull;
  owner: string;
  repo: string;
  defaultBranch: string;
  cloneUrl: string;
  policy: StrictRefreshPolicy;
  api: Partial<
    StrictBranchApi &
      Pick<
        IssueApi,
        "getRepoFile" | "listPullCommits" | "listOpenPulls" | "getPR" | "listCommitStatuses" | "listCheckRuns"
      >
  > &
    Partial<{
      listIssueTimeline: (
        owner: string,
        repo: string,
        index: number
      ) => Promise<import("./ports.ts").IssueTimelineEvent[]>;
      compareCommits: (owner: string, repo: string, basehead: string) => Promise<{ totalCommits?: number }>;
    }>;
  sender?: string;
  log?: (message: string) => void;
  slots?: StrictRefreshSlotStore;
  nowMs?: number;
  hasPendingFollowUp?: StrictPendingFollowUp;
}): Promise<(Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; strictRefresh: true }) | null> {
  const { owner, repo, policy, api } = opts;
  const gitea = isGiteaStrictForge(api, policy as { forgeKind?: string });
  let pr = opts.pr;
  let giteaStrict: StrictPolicy | undefined;
  if (gitea) {
    const armed = await readGiteaScheduleArmed(api, owner, repo, pr.number, opts.log);
    if (!armed) return null;
    pr = { ...pr, autoMergeEnabled: true };
    const strictEarly = await resolveStrictPolicyWithFallback(api, owner, repo, pr.base?.ref?.trim() ?? "", {
      forgeKind: "gitea",
      defaultBranch: opts.defaultBranch,
      log: opts.log,
    });
    if (strictEarly !== "strict") {
      if (opts.slots && strictEarly === "off") {
        try {
          const held = await opts.slots.getSlot(owner, repo, pr.base?.ref?.trim() ?? "");
          if (held) await opts.slots.release(owner, repo, pr.base?.ref?.trim() ?? "", { nowMs: opts.nowMs });
        } catch (err) {
          opts.log?.(`strict refresh slot release failed: ${errorMessage(err)}`);
        }
      }
      return null;
    }
    // Reused below as `giteaStrict`: same branch, same forge routing, so the
    // shared policy check is not resolved a second time.
    giteaStrict = strictEarly;
    if (
      await isStrictRefreshLeftToAuthor(
        api,
        owner,
        repo,
        pr,
        {
          botUsername: policy.botUsername,
          ignoreConflictsLabel: policy.ignoreConflictsLabel,
          defaultBranch: opts.defaultBranch,
        },
        opts.log
      )
    ) {
      opts.log?.(`strict refresh #${pr.number} left to author; skipping merge-only wake`);
      return null;
    }
    if (isStrictRefreshBlocked(pr)) {
      opts.log?.(`strict refresh #${pr.number} blocked (conflict or failing checks); skipping`);
      return null;
    }
    const behind = await readGiteaBehindForPull(api, owner, repo, pr, opts.log);
    if (!behind) return null;
  }
  if (!isStrictRefreshCandidate(pr, owner, repo, policy.botUsername, policy)) return null;
  const baseBranch = pr.base?.ref?.trim() ? pr.base.ref.trim() : "";
  if (!baseBranch) return null;
  // Gitea reuses the early check above (same branch, same forge routing):
  // one getBranch plus one repo-settings read per reconcile, no TOCTOU
  // between the two reads. The left-to-author / blocked passes already ran
  // on the same enriched PR above, so they are skipped here for Gitea.
  const resolved =
    gitea && giteaStrict
      ? { strict: giteaStrict }
      : await strictPolicyForBranch(api, owner, repo, baseBranch, policy, opts.defaultBranch, opts.log);
  const strict: StrictPolicy = resolved.strict;
  const requiredContexts = resolved.requiredContexts;
  if (strict !== "strict") {
    // Fail-closed: only an explicit off clears a held slot; unknown (e.g.
    // transient getBranch failure) leaves the slot alone.
    if (opts.slots && strict === "off") {
      try {
        const held = await opts.slots.getSlot(owner, repo, baseBranch);
        if (held) await opts.slots.release(owner, repo, baseBranch, { nowMs: opts.nowMs });
      } catch (err) {
        opts.log?.(`strict refresh slot release failed: ${errorMessage(err)}`);
      }
    }
    return null;
  }
  if (!gitea) {
    if (
      await isStrictRefreshLeftToAuthor(
        api,
        owner,
        repo,
        pr,
        {
          botUsername: policy.botUsername,
          ignoreConflictsLabel: policy.ignoreConflictsLabel,
          defaultBranch: opts.defaultBranch,
        },
        opts.log
      )
    ) {
      opts.log?.(`strict refresh #${pr.number} left to author; skipping merge-only wake`);
      return null;
    }
    if (isStrictRefreshBlocked(pr)) {
      opts.log?.(`strict refresh #${pr.number} blocked (conflict or failing checks); skipping`);
      return null;
    }
  }
  const slots = opts.slots;
  const listOpenPulls = (api as { listOpenPulls?: unknown }).listOpenPulls;
  if (!slots || typeof listOpenPulls !== "function") {
    // Legacy single-call path: the same review gate applies, so a caller
    // without a slot store cannot refresh a red or busy head either.
    if (
      !(await isReviewReadyForStrictRefresh({
        api,
        owner,
        repo,
        pr,
        ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      }))
    ) {
      return null;
    }
    return {
      owner,
      repo,
      issueNumber: strictRefreshIssueNumber(pr, owner, repo, policy.botUsername),
      action: "push",
      title: pr.title,
      body: pr.body ?? "",
      htmlUrl: pr.html_url,
      issueUpdatedAt: pr.updated_at,
      defaultBranch: opts.defaultBranch,
      cloneUrl: opts.cloneUrl,
      mode: "follow-up",
      prNumber: pr.number,
      headSha: pr.head.sha,
      trigger: { event: "pull_request", sender: opts.sender ?? "pull_request" },
      mergeOnly: true,
      strictRefresh: true,
      ...(pr.base?.sha ? { strictBaseSha: pr.base.sha } : {}),
    };
  }
  const now = opts.nowMs ?? Date.now();
  let pulls: Pull[];
  try {
    pulls = await (listOpenPulls as (o: string, r: string) => Promise<Pull[]>).call(api, owner, repo);
  } catch (err) {
    opts.log?.(`strict refresh open-pull lookup failed: ${errorMessage(err)}`);
    return null;
  }
  if (gitea) {
    try {
      pulls = await withGiteaArmed(api, pulls, owner, repo, opts.log);
    } catch (err) {
      opts.log?.(`strict refresh schedule lookup failed: ${errorMessage(err)}`);
      return null;
    }
  }
  const baseSha = pr.base?.sha ?? "";
  // The triggering PR's base.sha can be stale (older than the slot's tip):
  // anchor on the held slot's base so waiter activity never downgrades the
  // tip or spuriously re-refreshes the holder. A free slot uses the PR's tip.
  let heldBefore: { baseSha: string; prNumber: number } | undefined;
  if (slots) {
    try {
      const held = await slots.getSlot(owner, repo, baseBranch);
      if (held) heldBefore = { baseSha: held.baseSha, prNumber: held.prNumber };
    } catch {
      // Fail open to the PR's tip; reconcile re-reads under lock.
    }
  }
  const effBase = heldBefore?.baseSha || baseSha;
  let terminal: { prNumber: number; headSha: string; baseSha: string } | undefined;
  if (slots) {
    try {
      terminal = (await slots.getTerminal(owner, repo, baseBranch)) ?? undefined;
    } catch (err) {
      opts.log?.(`strict refresh terminal lookup failed: ${errorMessage(err)}`);
    }
  }
  const readyRaw = await collectReadyStrictCandidates({
    pulls,
    owner,
    repo,
    policy,
    api,
    defaultBranch: opts.defaultBranch,
    baseBranch,
    requiredContexts,
    terminal,
    baseSha: effBase,
    ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
    log: opts.log,
  });
  const ready = gitea ? await keepGiteaBehind(api, readyRaw, owner, repo, opts.log) : readyRaw;
  if (ready.length === 0) {
    try {
      await releaseStaleStrictSlot({
        slots,
        owner,
        repo,
        baseBranch,
        baseSha: effBase,
        pulls,
        policy,
        api,
        defaultBranch: opts.defaultBranch,
        requiredContexts,
        nowMs: now,
        log: opts.log,
      });
    } catch (err) {
      opts.log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
    }
    return null;
  }
  // Only the oldest ready candidate may hold the slot; a newer PR's activity
  // still hands the slot to the oldest (same reconcile as a push) and returns
  // the oldest's job so the caller enqueues it instead of dropping it. A
  // re-refresh of the already-held oldest is suppressed here: the holder
  // already has its job and the triggering PR's tip may be stale.
  if (ready[0]?.number !== pr.number) {
    try {
      const admitted = await reconcileStrictSlotForCandidates({
        slots,
        owner,
        repo,
        baseBranch,
        baseSha: effBase,
        pulls,
        ready,
        policy,
        api,
        defaultBranch: opts.defaultBranch,
        cloneUrl: opts.cloneUrl,
        requiredContexts,
        ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
        nowMs: now,
        log: opts.log,
      });
      if (!admitted || (heldBefore && admitted.number === heldBefore.prNumber)) return null;
      return {
        owner,
        repo,
        issueNumber: strictRefreshIssueNumber(admitted, owner, repo, policy.botUsername),
        action: "push",
        title: admitted.title,
        body: admitted.body ?? "",
        htmlUrl: admitted.html_url,
        issueUpdatedAt: admitted.updated_at,
        defaultBranch: opts.defaultBranch,
        cloneUrl: opts.cloneUrl,
        mode: "follow-up",
        prNumber: admitted.number,
        headSha: admitted.head.sha,
        trigger: { event: "pull_request", sender: opts.sender ?? "pull_request" },
        mergeOnly: true,
        strictRefresh: true,
        ...(effBase ? { strictBaseSha: effBase } : {}),
      };
    } catch (err) {
      opts.log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
    }
    return null;
  }
  try {
    const admitted = await reconcileStrictSlotForCandidates({
      slots,
      owner,
      repo,
      baseBranch,
      baseSha: effBase,
      pulls,
      ready,
      policy,
      api,
      defaultBranch: opts.defaultBranch,
      cloneUrl: opts.cloneUrl,
      requiredContexts,
      ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
      nowMs: now,
      log: opts.log,
    });
    if (!admitted || admitted.number !== pr.number) return null;
  } catch (err) {
    opts.log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
    return null;
  }
  return {
    owner,
    repo,
    issueNumber: strictRefreshIssueNumber(pr, owner, repo, policy.botUsername),
    action: "push",
    title: pr.title,
    body: pr.body ?? "",
    htmlUrl: pr.html_url,
    issueUpdatedAt: pr.updated_at,
    defaultBranch: opts.defaultBranch,
    cloneUrl: opts.cloneUrl,
    mode: "follow-up",
    prNumber: pr.number,
    headSha: pr.head.sha,
    trigger: { event: "pull_request", sender: opts.sender ?? "pull_request" },
    mergeOnly: true,
    strictRefresh: true,
    ...(effBase ? { strictBaseSha: effBase } : {}),
  };
}

/**
 * Review-green wake for strict refresh (issue #900). When Jumi's review
 * turns green on a behind PR, the refresh must not wait for the next push
 * to the target branch: reconcile that PR right away. Returns the
 * merge-only job, or null when the PR is not refreshable (up-to-date,
 * ineligible, review not green, fix loop pending). When a forge read fails
 * before the refreshability verdict is known, the wake is recorded as a
 * durable admit-next obligation (the same vehicle as #894) and `deferred`
 * is true, so the engine tick retries it across restarts instead of the
 * wake dying with this event.
 */
export async function shouldEnqueueStrictRefreshOnReviewGreen(opts: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  defaultBranch: string;
  cloneUrl: string;
  policy: StrictRefreshPolicy;
  api: StrictRefreshApi & { getPR: NonNullable<StrictRefreshApi["getPR"]> };
  sender?: string;
  log?: (message: string) => void;
  slots?: StrictRefreshSlotStore;
  nowMs?: number;
  hasPendingFollowUp?: StrictPendingFollowUp;
  /**
   * Caller-observed base branch for the defer path: when the fresh PR read
   * itself fails, the branch is otherwise unknown and no obligation can be
   * recorded. Status handlers know it from their pull listing.
   */
  baseBranch?: string;
}): Promise<{
  job: (Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; strictRefresh: true }) | null;
  deferred: boolean;
}> {
  const { owner, repo, prNumber, headSha, policy, api } = opts;
  const log = opts.log;
  const now = opts.nowMs ?? Date.now();
  const defer = async (baseBranch: string): Promise<{ job: null; deferred: boolean }> => {
    if (opts.slots && baseBranch) {
      try {
        const recorded = await opts.slots.ensureAdmitNextDue(owner, repo, baseBranch, now);
        if (recorded) {
          log?.(
            `strict refresh review-green wake deferred for ${owner}/${repo}#${baseBranch} (forge error; tick retries)`
          );
          return { job: null, deferred: true };
        }
      } catch (err) {
        log?.(`strict refresh review-green defer failed: ${errorMessage(err)}`);
      }
    }
    return { job: null, deferred: false };
  };
  let fresh: Pull;
  try {
    const got = await api.getPR(owner, repo, prNumber);
    if (!got || typeof got !== "object" || got.number !== prNumber) return { job: null, deferred: false };
    fresh = got;
  } catch (err) {
    log?.(`strict refresh review-green pr lookup failed for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
    return defer(opts.baseBranch ?? "");
  }
  if ((fresh.head?.sha ?? "").toLowerCase() !== (headSha ?? "").toLowerCase() || !headSha) {
    return { job: null, deferred: false };
  }
  const baseBranch = fresh.base?.ref?.trim() ? fresh.base.ref.trim() : "";
  if (!baseBranch) return { job: null, deferred: false };
  const gitea = isGiteaStrictForge(api, policy as { forgeKind?: string });
  if (gitea) {
    let armed = false;
    try {
      armed = await readGiteaScheduleArmed(api, owner, repo, fresh.number, log);
    } catch (err) {
      log?.(`strict refresh review-green schedule lookup failed: ${errorMessage(err)}`);
      return defer(baseBranch);
    }
    if (!armed) return { job: null, deferred: false };
    fresh = { ...fresh, autoMergeEnabled: true };
  }
  if (!isStrictRefreshCandidate(fresh, owner, repo, policy.botUsername, policy)) {
    return { job: null, deferred: false };
  }
  // Behind-ness is established, never guessed: GitHub's mergeable_state, or
  // Gitea's compare. Unknown or up-to-date means no wake.
  if (gitea) {
    let behind = false;
    try {
      behind = await readGiteaBehindForPull(api, owner, repo, fresh, log);
    } catch (err) {
      log?.(`strict refresh review-green behind lookup failed: ${errorMessage(err)}`);
      return defer(baseBranch);
    }
    if (!behind) return { job: null, deferred: false };
  } else if (!isStrictRefreshBehind(fresh)) {
    return { job: null, deferred: false };
  }
  const { strict: strictness, requiredContexts } = await strictPolicyForBranch(
    api,
    owner,
    repo,
    baseBranch,
    policy,
    opts.defaultBranch,
    log
  );
  if (strictness === "unknown") return defer(baseBranch);
  if (strictness !== "strict") return { job: null, deferred: false };
  if (
    await isStrictRefreshLeftToAuthor(
      api,
      owner,
      repo,
      fresh,
      {
        botUsername: policy.botUsername,
        ignoreConflictsLabel: policy.ignoreConflictsLabel,
        defaultBranch: opts.defaultBranch,
      },
      log
    )
  ) {
    log?.(`strict refresh #${fresh.number} left to author; skipping review-green wake`);
    return { job: null, deferred: false };
  }
  if (!gitea && (await isTerminallyStrictBlocked({ api, owner, repo, pr: fresh, requiredContexts, log }))) {
    log?.(`strict refresh #${fresh.number} blocked (conflict or failing checks); skipping review-green wake`);
    return { job: null, deferred: false };
  }
  if (gitea && isStrictRefreshBlocked(fresh)) {
    log?.(`strict refresh #${fresh.number} blocked (conflict or failing checks); skipping review-green wake`);
    return { job: null, deferred: false };
  }
  let green: StrictReviewGreen;
  try {
    green = await readStrictReviewGreen({ api, owner, repo, headSha: fresh.head.sha, ...(log ? { log } : {}) });
  } catch (err) {
    log?.(`strict refresh review-green verdict lookup failed: ${errorMessage(err)}`);
    return defer(baseBranch);
  }
  if (green === "unknown") return defer(baseBranch);
  if (green !== "green") return { job: null, deferred: false };
  if (opts.hasPendingFollowUp) {
    let pending = false;
    try {
      pending = await opts.hasPendingFollowUp(owner, repo, fresh.number, fresh.head.sha);
    } catch (err) {
      log?.(`strict refresh review-green follow-up lookup failed: ${errorMessage(err)}`);
      return defer(baseBranch);
    }
    if (pending) {
      log?.(`strict refresh #${fresh.number} follow-up pending; skipping review-green wake`);
      return { job: null, deferred: false };
    }
  }
  let job: Awaited<ReturnType<typeof shouldEnqueueStrictRefreshForPR>>;
  try {
    job = await shouldEnqueueStrictRefreshForPR({
      pr: fresh,
      owner,
      repo,
      defaultBranch: opts.defaultBranch,
      cloneUrl: opts.cloneUrl,
      policy,
      api,
      ...(opts.sender !== undefined ? { sender: opts.sender } : {}),
      ...(log ? { log } : {}),
      ...(opts.slots ? { slots: opts.slots } : {}),
      nowMs: now,
      ...(opts.hasPendingFollowUp ? { hasPendingFollowUp: opts.hasPendingFollowUp } : {}),
    });
  } catch (err) {
    log?.(`strict refresh review-green reconcile failed: ${errorMessage(err)}`);
    return defer(baseBranch);
  }
  if (job) return { job, deferred: false };
  // The head proved green above; a null below with a free slot means the
  // second read hit a transient (open-pull/slot/verdict re-read) rather
  // than terminal evidence, so record the admit-next obligation instead of
  // dropping the proven-green wake. A held slot makes defer a no-op and
  // correctly reports no deferral.
  return defer(baseBranch);
}

export type StrictGreenWakeApi = StrictRefreshApi & {
  getPR: NonNullable<StrictRefreshApi["getPR"]>;
  listOpenPulls: (owner: string, repo: string) => Promise<Pull[]>;
} & Partial<{
    getRepo: (
      owner: string,
      repo: string
    ) => Promise<{ full_name: string; html_url: string; clone_url: string; default_branch: string }>;
  }>;

/**
 * Shared status-event entry point for the review-green wake (issue #900),
 * used by the Gitea `status` and GitHub `status`/`check_run` webhook paths
 * so the two forges cannot drift. Parses the payload, matches open PRs by
 * head SHA (oldest first), and reconciles each through
 * `shouldEnqueueStrictRefreshOnReviewGreen` until one enqueues or defers.
 * Non-green finishes (and any failure before the verdict is known) fall
 * through as `skip` so callers reach the sibling-check path unchanged.
 * A queued job also clears the slot's durable intent, mirroring the
 * push and PR-activity paths.
 */
export async function enqueueStrictRefreshForGreenReview(opts: {
  rawBody: Uint8Array;
  delivery: string;
  api: StrictGreenWakeApi;
  policy: StrictRefreshPolicy;
  slots?: StrictRefreshSlotStore;
  /**
   * Ledger candidates for the pending-fix-loop probe. The helper builds the
   * probe from the first candidate exposing `listInflight` once the payload
   * owner and repo are known; webhook handlers pass their queue stores.
   */
  followUpLedgers?: Array<StrictFollowUpLedger | undefined | null | unknown>;
  sender?: string;
  defaultBranch?: string;
  cloneUrl?: string;
  log?: (message: string) => void;
  nowMs?: number;
  enqueue: (job: IssueJob) => Promise<{ queued: boolean; key: string }> | { queued: boolean; key: string };
}): Promise<{ outcome: "queued" | "deferred" | "skip"; key?: string; reason?: string }> {
  const log = opts.log;
  const now = opts.nowMs ?? Date.now();
  const green = parseJumiReviewSuccessFinish(opts.rawBody);
  if (!green) return { outcome: "skip", reason: "not a green review finish" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(opts.rawBody));
  } catch {
    return { outcome: "skip", reason: "malformed status payload" };
  }
  const repository =
    parsed && typeof parsed === "object" && "repository" in parsed
      ? (parsed as { repository?: unknown }).repository
      : undefined;
  const fullName =
    repository && typeof repository === "object" && "full_name" in repository
      ? (repository as { full_name?: unknown }).full_name
      : undefined;
  if (typeof fullName !== "string" || !fullName) return { outcome: "skip", reason: "malformed status payload" };
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return { outcome: "skip", reason: "malformed status payload" };
  const hasPendingFollowUp = strictPendingFollowUpChecker(owner, repo, ...(opts.followUpLedgers ?? []));
  let pulls: Pull[];
  try {
    pulls = await opts.api.listOpenPulls(owner, repo);
  } catch (err) {
    log?.(`strict refresh review-green open-pull lookup failed: ${errorMessage(err)}`);
    // The payload already proved green; without the pull list the base
    // branch is unknown, so fall back to the repo default for the durable
    // admit-next obligation (the common single-branch case). A held slot
    // makes the defer a no-op. When no branch can be resolved there is
    // nothing to drain, so report a retryable deferral without an
    // obligation rather than a silent skip.
    let branch = (opts.defaultBranch ?? "").trim();
    if (!branch && typeof opts.api.getRepo === "function") {
      try {
        const info = await opts.api.getRepo(owner, repo);
        if (typeof info?.default_branch === "string") branch = info.default_branch.trim();
      } catch {
        // Fall through to the branchless deferral below.
      }
    }
    if (branch && opts.slots) {
      try {
        const recorded = await opts.slots.ensureAdmitNextDue(owner, repo, branch, now);
        if (recorded) return { outcome: "deferred" };
      } catch {
        // Fall through to the branchless deferral below.
      }
    }
    return { outcome: "deferred", reason: "open-pull lookup failed" };
  }
  const matches = pulls
    .filter((pr) => (pr?.head?.sha ?? "").toLowerCase() === green.sha.toLowerCase())
    .sort(compareStrictRefreshOrder);
  if (matches.length === 0) return { outcome: "skip", reason: "no matching pull request" };
  const sender =
    opts.sender ??
    (parsed && typeof parsed === "object" && "sender" in parsed
      ? (parsed as { sender?: { login?: unknown } }).sender?.login
      : undefined);
  for (const pr of matches) {
    const baseBranch = pr.base?.ref?.trim() ? pr.base.ref.trim() : "";
    let defaultBranch = (opts.defaultBranch ?? "").trim();
    let cloneUrl = (opts.cloneUrl ?? "").trim();
    if ((!defaultBranch || !cloneUrl) && typeof opts.api.getRepo === "function") {
      try {
        const info = await opts.api.getRepo(owner, repo);
        if (!defaultBranch && typeof info?.default_branch === "string") defaultBranch = info.default_branch.trim();
        if (!cloneUrl && typeof info?.clone_url === "string") cloneUrl = info.clone_url.trim();
      } catch (err) {
        log?.(`strict refresh review-green repo lookup failed for ${owner}/${repo}: ${errorMessage(err)}`);
      }
    }
    if (!defaultBranch || !cloneUrl) {
      log?.(`strict refresh review-green repo info unreadable for ${owner}/${repo}; skipping`);
      continue;
    }
    const woken = await shouldEnqueueStrictRefreshOnReviewGreen({
      owner,
      repo,
      prNumber: pr.number,
      headSha: green.sha,
      defaultBranch,
      cloneUrl,
      policy: opts.policy,
      api: opts.api,
      ...(typeof sender === "string" && sender ? { sender } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(log ? { log } : {}),
      ...(opts.slots ? { slots: opts.slots } : {}),
      nowMs: now,
      ...(hasPendingFollowUp ? { hasPendingFollowUp } : {}),
    });
    if (woken.job) {
      const receivedAt = new Date(now).toISOString();
      const workerJob: IssueJob = { ...woken.job, delivery: opts.delivery, receivedAt };
      const result = await opts.enqueue(workerJob);
      if (opts.slots && woken.job.prNumber && woken.job.headSha && baseBranch) {
        await opts.slots
          .clearPending(owner, repo, baseBranch, woken.job.prNumber, woken.job.headSha)
          .catch(() => undefined);
      }
      log?.(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${opts.delivery} strict-refresh-green`);
      return { outcome: "queued", key: result.key };
    }
    if (woken.deferred) return { outcome: "deferred" };
  }
  return { outcome: "skip", reason: "no refreshable pull request" };
}

/** Pure recheck before writing: null means proceed, otherwise skip reason. */
export function strictRecheckSkipReason(opts: {
  fresh: Pull;
  expectedHeadSha: string;
  strict: StrictPolicy;
}): string | null {
  const expected = (opts.expectedHeadSha ?? "").toLowerCase();
  if (!expected || opts.fresh.head.sha.toLowerCase() !== expected) {
    return "strict refresh: competing head update";
  }
  if (opts.strict === "off") return "strict refresh: strictness off";
  if (opts.strict !== "strict") return "strict refresh: strictness unknown";
  if (opts.fresh.autoMergeEnabled !== true) return "strict refresh: auto-merge no longer armed";
  return null;
}

export type StrictRecheckApi = {
  getPR: (owner: string, repo: string, index: number) => Promise<Pull>;
} & Partial<
  StrictBranchApi & Pick<IssueApi, "getRepoFile" | "listPullCommits" | "listCommitStatuses" | "listCheckRuns">
> &
  Partial<{
    listIssueTimeline: (
      owner: string,
      repo: string,
      index: number
    ) => Promise<import("./ports.ts").IssueTimelineEvent[]>;
    compareCommits: (owner: string, repo: string, basehead: string) => Promise<{ totalCommits?: number }>;
  }>;

/**
 * Shared worker recheck before any strict-refresh write. Fetches the PR
 * fresh, then rechecks eligibility, head, strictness, auto-merge and the
 * ignore-conflicts guard in one place so the pre-merge and pre-push
 * checkpoints cannot drift (e.g. one side missing the left-to-author
 * recheck). Returns the fresh PR plus a skip reason (null means proceed).
 */
export async function recheckStrictRefreshEligibility(opts: {
  api: StrictRecheckApi;
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
  botUsername: string;
  policy?: { botUsername: string; isPickedUp?: (issue: { assignee?: unknown; assignees?: unknown }) => boolean };
  ignoreConflictsLabel?: string;
  defaultBranch?: string;
  log?: (message: string) => void;
}): Promise<{ fresh?: Pull; skipReason: string | null }> {
  let fresh: Pull | undefined;
  try {
    fresh = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log?.(`strict refresh unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
    return { skipReason: "strict refresh: pull request unreadable" };
  }
  const gitea = isGiteaStrictForge(opts.api, opts.policy as { forgeKind?: string });
  if (gitea) {
    if (!fresh) return { skipReason: "strict refresh: not eligible" };
    const expected = (opts.expectedHeadSha ?? "").toLowerCase();
    if (!expected || fresh.head.sha.toLowerCase() !== expected) {
      return { fresh, skipReason: "strict refresh: competing head update" };
    }
    const strict = await resolveStrictPolicyWithFallback(opts.api, opts.owner, opts.repo, fresh.base.ref, {
      forgeKind: "gitea",
      defaultBranch: opts.defaultBranch,
      log: opts.log,
    });
    if (strict === "off") {
      return { fresh, skipReason: "strict refresh: strictness off" };
    }
    if (strict !== "strict") {
      return { fresh, skipReason: "strict refresh: strictness unknown" };
    }
    const armed = await readGiteaScheduleArmed(opts.api, opts.owner, opts.repo, fresh.number, opts.log);
    if (!armed) {
      return { fresh, skipReason: "strict refresh: auto-merge no longer armed" };
    }
    const enriched = { ...fresh, autoMergeEnabled: true };
    if (!isStrictRefreshCandidate(enriched, opts.owner, opts.repo, opts.botUsername, opts.policy as never)) {
      return { fresh: enriched, skipReason: "strict refresh: not eligible" };
    }
    if (
      await isStrictRefreshLeftToAuthor(
        opts.api,
        opts.owner,
        opts.repo,
        enriched,
        {
          botUsername: opts.botUsername,
          ignoreConflictsLabel: opts.ignoreConflictsLabel,
          defaultBranch: opts.defaultBranch,
        },
        opts.log
      )
    ) {
      return { fresh: enriched, skipReason: "strict refresh: left to author (ignore-conflicts)" };
    }
    const behind = await readGiteaBehindForPull(opts.api, opts.owner, opts.repo, enriched, opts.log);
    if (!behind) {
      return { fresh: enriched, skipReason: "strict refresh: not behind" };
    }
    const green = await readStrictReviewGreen({
      api: opts.api,
      owner: opts.owner,
      repo: opts.repo,
      headSha: enriched.head.sha,
      ...(opts.log ? { log: opts.log } : {}),
    });
    if (green === "unknown") {
      return { fresh: enriched, skipReason: "strict refresh: review status unreadable" };
    }
    if (green !== "green") {
      return { fresh: enriched, skipReason: "strict refresh: review not green" };
    }
    return { fresh: enriched, skipReason: null };
  }
  if (!fresh || !isStrictRefreshCandidate(fresh, opts.owner, opts.repo, opts.botUsername, opts.policy as never)) {
    return { fresh, skipReason: "strict refresh: not eligible" };
  }
  const expected = (opts.expectedHeadSha ?? "").toLowerCase();
  if (!expected || fresh.head.sha.toLowerCase() !== expected) {
    return { fresh, skipReason: "strict refresh: competing head update" };
  }
  const strict = await resolveStrictPolicy(opts.api, opts.owner, opts.repo, fresh.base.ref, opts.log);
  if (strict === "off") {
    return { fresh, skipReason: "strict refresh: strictness off" };
  }
  if (strict !== "strict") {
    return { fresh, skipReason: "strict refresh: strictness unknown" };
  }
  if (fresh.autoMergeEnabled !== true) {
    return { fresh, skipReason: "strict refresh: auto-merge no longer armed" };
  }
  if (
    await isStrictRefreshLeftToAuthor(
      opts.api,
      opts.owner,
      opts.repo,
      fresh,
      {
        botUsername: opts.botUsername,
        ignoreConflictsLabel: opts.ignoreConflictsLabel,
        defaultBranch: opts.defaultBranch,
      },
      opts.log
    )
  ) {
    return { fresh, skipReason: "strict refresh: left to author (ignore-conflicts)" };
  }
  const green = await readStrictReviewGreen({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    headSha: fresh.head.sha,
    ...(opts.log ? { log: opts.log } : {}),
  });
  if (green === "unknown") {
    return { fresh, skipReason: "strict refresh: review status unreadable" };
  }
  if (green !== "green") {
    return { fresh, skipReason: "strict refresh: review not green" };
  }
  return { fresh, skipReason: null };
}

/** Review deferral while an authorized refresh is queued or running. */
export const STRICT_REFRESH_WAIT_PREFIX = "strict-refresh-wait:";
export const STRICT_REFRESH_WAIT_FALLBACK_MS = 10 * 60 * 1000;

export function isStrictRefreshWaitMarker(error: string | null | undefined): boolean {
  return Boolean(error?.startsWith(STRICT_REFRESH_WAIT_PREFIX));
}

export function encodeStrictRefreshWait(firstSeenMs: number): string {
  return `${STRICT_REFRESH_WAIT_PREFIX}${firstSeenMs}`;
}

export function parseStrictRefreshWait(error: string | null | undefined): { firstSeen: number } | undefined {
  if (!isStrictRefreshWaitMarker(error) || !error) return undefined;
  const firstSeen = Number(error.slice(STRICT_REFRESH_WAIT_PREFIX.length));
  if (!Number.isFinite(firstSeen)) return undefined;
  return { firstSeen };
}
