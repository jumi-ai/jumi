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
};

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
  api: Pick<IssueApi, "listOpenPulls" | "getIssue"> & Partial<StrictBranchApi & Pick<IssueApi, "getRepoFile">>,
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
  api: Partial<StrictBranchApi>;
  sender?: string;
  log?: (message: string) => void;
}): Promise<(Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; strictRefresh: true }) | null> {
  const { pr, owner, repo, policy, api } = opts;
  if (!isStrictRefreshCandidate(pr, owner, repo, policy.botUsername, policy)) return null;
  const baseBranch = pr.base?.ref?.trim() ? pr.base.ref.trim() : "";
  if (!baseBranch) return null;
  const strict = await resolveStrictPolicy(api, owner, repo, baseBranch, opts.log);
  if (strict !== "strict") return null;
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
