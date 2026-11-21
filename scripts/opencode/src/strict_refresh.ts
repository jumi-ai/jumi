import { type IssueApi, isAssignedForeignPR, isEligibleWorkerPR, isInScopeJumiPR } from "./gitea_issues.ts";
import type { BranchProtection, Pull } from "./ports.ts";
import type { GiteaPushPayload, IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";
import { assertRepositoryPolicy, type WebhookPolicy } from "./webhook.ts";

export type StrictPolicy = "strict" | "off" | "unknown";

export type StrictBranchApi = Pick<IssueApi, "getBranch">;

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
  Partial<StrictBranchApi & Pick<IssueApi, "getRepoFile" | "listPullCommits">>;

/**
 * True only when GitHub reports the head out of date under strict checks
 * (`mergeable_state: behind`). Absent or any other value (including
 * `unknown` while GitHub computes) means behind-ness is not established:
 * callers fall through to the normal review path instead of parking.
 */
export function isStrictRefreshBehind(pr: Pull): boolean {
  return typeof pr?.mergeableState === "string" && pr.mergeableState.toLowerCase() === "behind";
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

async function strictForBranches(
  api: Partial<StrictBranchApi>,
  owner: string,
  repo: string,
  branches: string[],
  log?: (message: string) => void
): Promise<Map<string, StrictPolicy>> {
  const out = new Map<string, StrictPolicy>();
  for (const branch of branches) {
    if (out.has(branch)) continue;
    out.set(branch, await resolveStrictPolicy(api, owner, repo, branch, log));
  }
  return out;
}

/**
 * Strict-refresh wakes for a branch push (any target branch, not only the
 * default). Each open, non-draft, same-repo Jumi PR targeting the pushed
 * branch with auto-merge armed gets one merge-only job when the effective
 * GitHub rule for its target branch requires up-to-date branches. Unknown
 * or off stays silent. Callers deduplicate by head+base via the worker key;
 * the worker merges the latest tip it fetches so repeated pushes coalesce.
 */
export async function shouldEnqueueStrictRefreshOnPush(
  payload: GiteaPushPayload,
  policy: StrictRefreshPolicy,
  api: StrictRefreshApi,
  log?: (message: string) => void
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
  const candidates = pulls.filter(
    (pr) => pr?.base?.ref === branch && isStrictRefreshCandidate(pr, owner, repo, policy.botUsername, policy)
  );
  if (candidates.length === 0) return { jobs: [] };
  const strictByBranch = await strictForBranches(api, owner, repo, [branch], log);
  if (strictByBranch.get(branch) !== "strict") return { jobs: [] };
  const defaultBranch = payload.repository.default_branch;
  const seen = new Set<number>();
  const targets: Array<{
    prNumber: number;
    headSha: string;
    title: string;
    body: string;
    htmlUrl: string;
    issueUpdatedAt: string;
    baseSha: string;
  }> = [];
  for (const pr of candidates) {
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
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
    targets.push({
      prNumber: pr.number,
      headSha: pr.head.sha,
      title: pr.title,
      body: pr.body ?? "",
      htmlUrl: pr.html_url,
      issueUpdatedAt: pr.updated_at,
      baseSha: pushedBase,
    });
  }
  const jobs = targets.map((target) => ({
    owner,
    repo,
    issueNumber: target.prNumber,
    action: "push" as const,
    title: target.title,
    body: target.body,
    htmlUrl: target.htmlUrl,
    issueUpdatedAt: target.issueUpdatedAt,
    defaultBranch: payload.repository.default_branch,
    cloneUrl: payload.repository.clone_url,
    mode: "follow-up" as const,
    prNumber: target.prNumber,
    headSha: target.headSha,
    trigger: { event: "push" as const, sender: payload.sender?.login ?? payload.pusher?.login ?? "push" },
    mergeOnly: true as const,
    strictRefresh: true as const,
    ...(pushedBase ? { strictBaseSha: pushedBase } : {}),
  }));
  return { jobs };
}

/**
 * Reconcile a single PR on supported PR activity (synchronize/opened/
 * ready_for_review, auto-merge armed while behind). Returns a merge-only
 * job when the PR is a strict candidate and its target branch requires
 * up-to-date branches; otherwise null. The worker skips up-to-date heads,
 * so callers enqueue optimistically without a git behind-check.
 */
export async function shouldEnqueueStrictRefreshForPR(opts: {
  pr: Pull;
  owner: string;
  repo: string;
  defaultBranch: string;
  cloneUrl: string;
  policy: StrictRefreshPolicy;
  api: Partial<StrictBranchApi & Pick<IssueApi, "getRepoFile" | "listPullCommits">>;
  sender?: string;
  log?: (message: string) => void;
}): Promise<(Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; strictRefresh: true }) | null> {
  const { pr, owner, repo, policy, api } = opts;
  if (!isStrictRefreshCandidate(pr, owner, repo, policy.botUsername, policy)) return null;
  const baseBranch = pr.base?.ref?.trim() ? pr.base.ref.trim() : "";
  if (!baseBranch) return null;
  const strict = await resolveStrictPolicy(api, owner, repo, baseBranch, opts.log);
  if (strict !== "strict") return null;
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
  return {
    owner,
    repo,
    issueNumber: pr.number,
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
  if (opts.strict !== "strict") return "strict refresh: strictness off or unknown";
  if (opts.fresh.autoMergeEnabled !== true) return "strict refresh: auto-merge no longer armed";
  return null;
}

export type StrictRecheckApi = {
  getPR: (owner: string, repo: string, index: number) => Promise<Pull>;
} & Partial<StrictBranchApi & Pick<IssueApi, "getRepoFile" | "listPullCommits">>;

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
  if (!fresh || !isStrictRefreshCandidate(fresh, opts.owner, opts.repo, opts.botUsername, opts.policy as never)) {
    return { fresh, skipReason: "strict refresh: not eligible" };
  }
  const expected = (opts.expectedHeadSha ?? "").toLowerCase();
  if (!expected || fresh.head.sha.toLowerCase() !== expected) {
    return { fresh, skipReason: "strict refresh: competing head update" };
  }
  const strict = await resolveStrictPolicy(opts.api, opts.owner, opts.repo, fresh.base.ref, opts.log);
  if (strict !== "strict") {
    return { fresh, skipReason: "strict refresh: strictness off or unknown" };
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
