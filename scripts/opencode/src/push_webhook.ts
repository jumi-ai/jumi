import { isIssuePickedUp, type PickupPolicy } from "./assignee.ts";
import { extractWorkingIssueNumber, type IssueApi, isAssignedForeignPR, isInScopeJumiPR } from "./gitea_issues.ts";
import {
  hasIgnoreConflictsLabel,
  IGNORE_CONFLICTS_SETTINGS_UNREADABLE,
  ignoreConflictsReason,
  isIgnoreConflictsAuthor,
  isLeftToAuthor,
  leaveConflictsAuthorReason,
  loadIgnoreConflictsAuthors,
  normalizeIgnoreConflictsLabel,
} from "./ignore_conflicts.ts";
import type { Pull } from "./ports.ts";
import type { GiteaPushPayload, IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";
import { isObjectLike } from "./util/object.ts";
import type { WebhookPolicy } from "./webhook.ts";
import { assertRepositoryPolicy } from "./webhook.ts";

export type PushWebhookPolicy = WebhookPolicy &
  PickupPolicy & {
    ignoreConflictsLabel?: string;
  };

export type PushConflictApi = Pick<IssueApi, "listOpenPulls" | "getIssue"> &
  Partial<Pick<IssueApi, "listPullCommits" | "getRepoFile">>;

export type PushWebhookDecision =
  | { type: "enqueue"; jobs: Omit<IssueJob, "delivery" | "receivedAt">[] }
  | { type: "skip"; reason: string };

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid webhook payload: missing ${name}`);
  return value;
}

function isZeroSha(value: string | undefined): boolean {
  if (!value) return true;
  return /^0+$/.test(value);
}

export function parsePushPayload(rawBody: Uint8Array): GiteaPushPayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObjectLike(parsed)) throw new Error("Invalid webhook payload: expected object");
  const repository = parsed.repository;
  if (!isObjectLike(repository)) throw new Error("Invalid webhook payload: missing repository");
  requireString(parsed.ref, "ref");
  requireString(repository.full_name, "repository.full_name");
  requireString(repository.default_branch, "repository.default_branch");
  requireString(repository.clone_url, "repository.clone_url");
  return parsed as unknown as GiteaPushPayload;
}

function pushSender(payload: GiteaPushPayload): string {
  return payload.pusher?.login || payload.sender?.login || "push";
}

export async function shouldEnqueuePushConflicts(
  payload: GiteaPushPayload,
  policy: PushWebhookPolicy,
  api: PushConflictApi,
  logger?: (message: string) => void
): Promise<PushWebhookDecision> {
  const defaultRef = `refs/heads/${payload.repository.default_branch}`;
  if (!payload.ref.startsWith("refs/heads/")) {
    return { type: "skip", reason: "not a branch ref" };
  }
  if (isZeroSha(payload.after)) {
    return { type: "skip", reason: "deleted ref" };
  }
  if (payload.ref !== defaultRef) {
    return { type: "skip", reason: "not the default branch" };
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = assertRepositoryPolicy(payload.repository, policy));
  } catch (err) {
    logger?.(`repository not allowed: ${errorMessage(err)}`);
    return { type: "skip", reason: "repository not allowed" };
  }

  const pulls = await api.listOpenPulls(owner, repo);
  const jobs: Omit<IssueJob, "delivery" | "receivedAt">[] = [];
  const sender = pushSender(payload);
  const ignoreAuthors = await loadIgnoreConflictsAuthors(api, owner, repo, payload.repository.default_branch, logger);
  if (ignoreAuthors === undefined) return { type: "skip", reason: IGNORE_CONFLICTS_SETTINGS_UNREADABLE };
  // Repository `ignore_conflicts_label` overrides the deployment value.
  // Missing, invalid, or unreadable falls back to the deployment value.
  let ignoreLabel = normalizeIgnoreConflictsLabel(policy.ignoreConflictsLabel);
  try {
    const { fallbackPolicyDeployment, resolveRepoPolicy } = await import("./repo_policy.ts");
    if (typeof (api as { getRepoFile?: unknown }).getRepoFile === "function") {
      const repoPolicy = await resolveRepoPolicy(
        { api, owner, repo, ref: payload.repository.default_branch },
        fallbackPolicyDeployment({ ignoreConflictsLabel: policy.ignoreConflictsLabel }),
        { onUnreadable: "fallback" }
      ).catch(() => undefined);
      if (repoPolicy !== undefined) ignoreLabel = repoPolicy.ignoreConflictsLabel;
    }
  } catch {
    // Fail-open to the deployment value.
  }
  let ignoredByLabel = 0;
  let ignoredAuthor: string | undefined;

  async function leftToAuthor(pr: Pull): Promise<{ left: boolean; viaAuthor: boolean }> {
    const labeled = hasIgnoreConflictsLabel(pr, ignoreLabel);
    const viaAuthor = !labeled && isIgnoreConflictsAuthor(pr.user?.login, ignoreAuthors);
    if (!labeled && !viaAuthor) return { left: false, viaAuthor: false };
    const left = await isLeftToAuthor(
      api,
      owner,
      repo,
      pr,
      {
        botUsername: policy.botUsername,
        ignoreConflictsLabel: ignoreLabel,
        ignoreConflictsAuthors: ignoreAuthors,
        prAuthor: pr.user?.login,
        defaultBranch: payload.repository.default_branch,
      },
      logger
    );
    return { left, viaAuthor: left && viaAuthor };
  }

  for (const pr of pulls) {
    if (isAssignedForeignPR(pr, owner, repo, policy.botUsername, policy)) {
      const { left, viaAuthor } = await leftToAuthor(pr);
      if (left) {
        ignoredByLabel += 1;
        if (viaAuthor) ignoredAuthor = pr.user?.login;
        continue;
      }
      jobs.push({
        owner,
        repo,
        issueNumber: pr.number,
        action: "push",
        title: pr.title,
        body: pr.body ?? "",
        htmlUrl: pr.html_url,
        issueUpdatedAt: pr.updated_at,
        defaultBranch: payload.repository.default_branch,
        cloneUrl: payload.repository.clone_url,
        mode: "conflict",
        prNumber: pr.number,
        headSha: pr.head.sha,
        trigger: { event: "push", sender },
      });
      continue;
    }
    if (!isInScopeJumiPR(pr, owner, repo, policy.botUsername)) continue;
    const issueNumber = extractWorkingIssueNumber(pr);
    if (issueNumber === undefined) continue;
    try {
      const issue = await api.getIssue(owner, repo, issueNumber);
      if (issue.state !== "open" || !isIssuePickedUp(issue, policy)) continue;
      const { left, viaAuthor } = await leftToAuthor(pr);
      if (left) {
        ignoredByLabel += 1;
        if (viaAuthor) ignoredAuthor = pr.user?.login;
        continue;
      }
      jobs.push({
        owner,
        repo,
        issueNumber,
        action: "push",
        title: issue.title,
        body: issue.body ?? "",
        htmlUrl: issue.html_url,
        issueUpdatedAt: issue.updated_at,
        defaultBranch: payload.repository.default_branch,
        cloneUrl: payload.repository.clone_url,
        mode: "conflict",
        prNumber: pr.number,
        headSha: pr.head.sha,
        trigger: { event: "push", sender },
      });
    } catch (err) {
      if (err instanceof Error && /→ 404\b/.test(err.message)) continue;
      throw err;
    }
  }

  if (jobs.length === 0) {
    if (ignoredByLabel > 0) {
      if (ignoredAuthor) return { type: "skip", reason: leaveConflictsAuthorReason(ignoredAuthor) };
      return { type: "skip", reason: ignoreConflictsReason(ignoreLabel) };
    }
    return { type: "skip", reason: "no managed jumi PRs" };
  }
  return { type: "enqueue", jobs };
}

export type SharedWaiterMergeLedger = Pick<
  import("./review_jobs.ts").ReviewJobStore,
  "listSharedFailures" | "listWaitersForFirst"
>;

type SharedWaiterMergeApi = Pick<IssueApi, "listOpenPulls" | "getIssue"> & Partial<Pick<IssueApi, "getPR">>;

/**
 * Merge-only wakes for shared-failure waiters whose first just merged.
 * The default-branch push already lists open managed PRs; each waiter whose
 * recorded `waiterFor` first is now merged gets a follow-up that only brings
 * the branch up to date, pushes, and stops (never the feedback engine unless
 * the merge conflicts). Fail-open: without a ledger, with no recent shared
 * rows, or when the first is still open, returns no jobs.
 */
export async function shouldEnqueueSharedWaiterMerges(
  payload: GiteaPushPayload,
  policy: PushWebhookPolicy,
  api: SharedWaiterMergeApi,
  ledger: SharedWaiterMergeLedger | undefined,
  logger?: (message: string) => void
): Promise<Array<Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true }>> {
  if (!ledger) return [];
  const defaultRef = `refs/heads/${payload.repository.default_branch}`;
  if (payload.ref !== defaultRef || isZeroSha(payload.after)) return [];
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = assertRepositoryPolicy(payload.repository, policy));
  } catch (err) {
    logger?.(`repository not allowed: ${errorMessage(err)}`);
    return [];
  }
  let pulls: Pull[];
  try {
    pulls = await api.listOpenPulls(owner, repo);
  } catch (err) {
    logger?.(`shared waiter open-pull lookup failed: ${errorMessage(err)}`);
    return [];
  }
  const openByNumber = new Map<number, Pull>();
  for (const pr of pulls) {
    if (typeof pr?.number === "number") openByNumber.set(pr.number, pr);
  }
  const { SHARED_FAILURE_WINDOW_MS, buildWaiterMergeJobs } = await import("./shared_failure.ts");
  const nowMs = Date.now();
  let entries: import("./shared_failure.ts").SharedFailureLedgerEntry[];
  try {
    entries = await ledger.listSharedFailures(owner, repo, nowMs - SHARED_FAILURE_WINDOW_MS, nowMs);
  } catch (err) {
    logger?.(`shared waiter ledger lookup failed: ${errorMessage(err)}`);
    return [];
  }
  const firsts = new Set<number>();
  for (const entry of entries) {
    if (entry.waiterFor != null) firsts.add(entry.waiterFor);
  }
  const mergedFirsts = new Set<number>();
  const getPR = (api as { getPR?: (owner: string, repo: string, n: number) => Promise<Pull> }).getPR;
  for (const first of firsts) {
    if (openByNumber.has(first)) continue;
    if (typeof getPR !== "function") continue;
    try {
      const pr = await getPR.call(api, owner, repo, first);
      if (pr?.merged === true) mergedFirsts.add(first);
    } catch {
      // Missing first: not merged, leave for takeover on the next CI wake.
    }
  }
  if (mergedFirsts.size === 0) return [];
  const sender = pushSender(payload);
  const out: Array<Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true }> = [];
  for (const first of mergedFirsts) {
    let waiterNumbers: number[];
    try {
      waiterNumbers = await ledger.listWaitersForFirst(owner, repo, first, (prNumber) => openByNumber.has(prNumber));
    } catch (err) {
      logger?.(`shared waiter list failed for #${first}: ${errorMessage(err)}`);
      continue;
    }
    const targets = waiterNumbers.map((n) => openByNumber.get(n)).filter((pr): pr is Pull => Boolean(pr));
    const waiterTargets = targets.map((pr) => ({
      prNumber: pr.number,
      headSha: pr.head.sha,
      title: pr.title,
      body: pr.body ?? "",
      htmlUrl: pr.html_url,
      issueUpdatedAt: pr.updated_at,
    }));
    // Only managed PRs wake: foreign assigned PRs and in-scope Jumi closers.
    // Reuse the conflict path's scope checks without duplicating issue fetches:
    // foreign PRs use the PR itself, Jumi PRs need their closing issue.
    for (const pr of targets) {
      if (isAssignedForeignPR(pr, owner, repo, policy.botUsername, policy)) {
        const waiter = waiterTargets.find((item) => item.prNumber === pr.number);
        if (!waiter) continue;
        out.push(
          ...buildWaiterMergeJobs({
            owner,
            repo,
            defaultBranch: payload.repository.default_branch,
            cloneUrl: payload.repository.clone_url,
            waiters: [waiter],
            sender,
          })
        );
        continue;
      }
      if (!isInScopeJumiPR(pr, owner, repo, policy.botUsername)) continue;
      const issueNumber = extractWorkingIssueNumber(pr);
      if (issueNumber === undefined) continue;
      try {
        const issue = await api.getIssue(owner, repo, issueNumber);
        if (issue.state !== "open" || !isIssuePickedUp(issue, policy)) continue;
        out.push({
          owner,
          repo,
          issueNumber,
          action: "push",
          title: issue.title,
          body: issue.body ?? "",
          htmlUrl: issue.html_url,
          issueUpdatedAt: issue.updated_at,
          defaultBranch: payload.repository.default_branch,
          cloneUrl: payload.repository.clone_url,
          mode: "follow-up",
          prNumber: pr.number,
          headSha: pr.head.sha,
          trigger: { event: "push", sender },
          mergeOnly: true,
        });
      } catch (err) {
        if (err instanceof Error && /→ 404\b/.test(err.message)) continue;
        throw err;
      }
    }
  }
  return out;
}
