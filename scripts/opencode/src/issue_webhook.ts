import { isAssignedToBot, isIssuePickedUp, isPullRequestIssue, type PickupPolicy } from "./assignee.ts";
import { DEPENDENCY_GRAPH_CAP } from "./dependencies.ts";
import { extractClosingIssueNumbers, isAssignedForeignPR, isForeignPrIdentity } from "./gitea_issues.ts";
import type { LinkedIssue, Pull, Repo, Task } from "./ports.ts";
import type { GiteaIssuePayload, GiteaPRPayload, IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";
import { isObjectLike } from "./util/object.ts";
import type { WebhookPolicy } from "./webhook.ts";
import { assertRepositoryPolicy } from "./webhook.ts";

const ENQUEUE_ACTIONS = new Set(["assigned", "opened", "reopened"]);

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid webhook payload: missing ${name}`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid webhook payload: missing ${name}`);
  }
  return value;
}

export function parseIssuesPayload(rawBody: Uint8Array): GiteaIssuePayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObjectLike(parsed)) throw new Error("Invalid webhook payload: expected object");
  const repository = parsed.repository;
  const issue = parsed.issue;
  if (!isObjectLike(repository)) throw new Error("Invalid webhook payload: missing repository");
  if (!isObjectLike(issue)) throw new Error("Invalid webhook payload: missing issue");
  requireString(parsed.action, "action");
  requireString(repository.full_name, "repository.full_name");
  requireNumber(issue.number, "issue.number");
  requireString(issue.title, "issue.title");
  requireString(issue.html_url, "issue.html_url");
  requireString(issue.updated_at, "issue.updated_at");
  return parsed as unknown as GiteaIssuePayload;
}

export type IssueWebhookPolicy = WebhookPolicy & PickupPolicy;

export type IssueWebhookDecision =
  | { type: "enqueue"; job: Omit<IssueJob, "delivery" | "receivedAt"> }
  | { type: "cancel"; owner: string; repo: string; issueNumber: number }
  | { type: "skip"; reason: string };

export function issueJobFrom(
  owner: string,
  repo: string,
  issue: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    updated_at: string;
    user?: { login?: string } | null;
  },
  repository: { default_branch: string; clone_url: string },
  action: string
): Omit<IssueJob, "delivery" | "receivedAt"> {
  return {
    owner,
    repo,
    issueNumber: issue.number,
    action,
    title: issue.title,
    body: issue.body ?? "",
    htmlUrl: issue.html_url,
    issueUpdatedAt: issue.updated_at,
    defaultBranch: repository.default_branch,
    cloneUrl: repository.clone_url,
    ...(typeof issue.user?.login === "string" && issue.user.login.trim()
      ? { issueAuthor: issue.user.login.trim() }
      : {}),
  };
}

export function shouldEnqueueIssue(payload: GiteaIssuePayload, policy: IssueWebhookPolicy): IssueWebhookDecision {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);

  if (isPullRequestIssue(payload.issue)) {
    return { type: "skip", reason: "pull request issue" };
  }

  if (payload.action === "unassigned") {
    if (!isAssignedToBot(payload.issue, policy.botUsername)) {
      return { type: "cancel", owner, repo, issueNumber: payload.issue.number };
    }
    return { type: "skip", reason: "bot still assigned" };
  }

  if (!ENQUEUE_ACTIONS.has(payload.action)) {
    return { type: "skip", reason: `unsupported action ${payload.action}` };
  }

  if (!isAssignedToBot(payload.issue, policy.botUsername)) {
    return { type: "skip", reason: "not assigned to bot" };
  }

  return {
    type: "enqueue",
    job: issueJobFrom(owner, repo, payload.issue, payload.repository, payload.action),
  };
}

const WAKE_ACTIONS = new Set(["closed", "reopened"]);
export const PULL_WAIT_CLEAR_ACTIONS = new Set(["closed", "merged", "unassigned"]);

export function isDependencyWakeAction(action: string): boolean {
  return WAKE_ACTIONS.has(action);
}

export function isPullWaitClearAction(action: string | undefined): boolean {
  return typeof action === "string" && PULL_WAIT_CLEAR_ACTIONS.has(action);
}

type BlockApi = {
  listIssueBlocks(owner: string, repo: string, index: number): Promise<LinkedIssue[]>;
  getIssue(owner: string, repo: string, index: number): Promise<Task>;
  getRepo?(owner: string, repo: string): Promise<Repo>;
};

type RepoRef = { default_branch: string; clone_url: string; full_name: string; html_url?: string };

export type BlockEligibilityApi = Pick<BlockApi, "getIssue" | "getRepo">;

export type BlockEligibilityContext = {
  owner: string;
  repo: string;
  repository: RepoRef;
  action: string;
  policy: IssueWebhookPolicy;
  api: BlockEligibilityApi;
};

export async function enqueueEligibleBlockedIssue(
  row: Pick<LinkedIssue, "owner" | "repo" | "number">,
  opts: BlockEligibilityContext
): Promise<Omit<IssueJob, "delivery" | "receivedAt"> | undefined> {
  let issue: Task;
  try {
    issue = await opts.api.getIssue(row.owner, row.repo, row.number);
  } catch {
    return undefined;
  }
  if (isPullRequestIssue(issue) || issue.state !== "open") return undefined;
  if (!isIssuePickedUp(issue, opts.policy)) return undefined;

  let cloneRepo: { default_branch: string; clone_url: string };
  if (row.owner === opts.owner && row.repo === opts.repo) {
    cloneRepo = opts.repository;
  } else if (opts.api.getRepo) {
    try {
      const fetched = await opts.api.getRepo(row.owner, row.repo);
      try {
        assertRepositoryPolicy(fetched, opts.policy);
      } catch {
        return undefined;
      }
      cloneRepo = fetched;
    } catch {
      return undefined;
    }
  } else {
    return undefined;
  }

  return issueJobFrom(row.owner, row.repo, issue, cloneRepo, opts.action);
}

export const DEPENDENCY_REMOVE_ACTIONS = new Set(["blocked_by_removed", "blocking_removed"]);

export function isDependencyRemoveAction(action: string | undefined): boolean {
  return typeof action === "string" && DEPENDENCY_REMOVE_ACTIONS.has(action);
}

export type IssueDependenciesRef = {
  action: string;
  blockedOwner: string;
  blockedRepo: string;
  blockedNumber: number;
  triggerOwner: string;
  triggerRepo: string;
  triggerRepository: RepoRef;
  blockedDefaultBranch?: string;
};

function requireRepoRef(value: unknown, name: string): RepoRef {
  if (!isObjectLike(value)) throw new Error(`Invalid webhook payload: missing ${name}`);
  requireString(value.full_name, `${name}.full_name`);
  requireString(value.default_branch, `${name}.default_branch`);
  requireString(value.clone_url, `${name}.clone_url`);
  return value as unknown as RepoRef;
}

function splitFullName(fullName: string, name: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid webhook payload: missing ${name}`);
  return { owner, repo };
}

export function parseIssueDependenciesPayload(rawBody: Uint8Array): IssueDependenciesRef {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObjectLike(parsed)) throw new Error("Invalid webhook payload: expected object");
  const action = parsed.action;
  if (typeof action !== "string" || !action) throw new Error("Invalid webhook payload: missing action");
  if (!isDependencyRemoveAction(action)) throw new Error(`Invalid webhook payload: unsupported action ${action}`);
  const repository = requireRepoRef(parsed.repository, "repository");
  const { owner: triggerOwner, repo: triggerRepo } = splitFullName(repository.full_name, "repository.full_name");
  const blockedIssue = parsed.blocked_issue;
  if (!isObjectLike(blockedIssue)) throw new Error("Invalid webhook payload: missing blocked_issue");
  const blockedNumber = requireNumber(blockedIssue.number, "blocked_issue.number");
  if (action === "blocked_by_removed") {
    const { owner, repo } = splitFullName(repository.full_name, "repository.full_name");
    return {
      action,
      blockedOwner: owner,
      blockedRepo: repo,
      blockedNumber,
      triggerOwner,
      triggerRepo,
      triggerRepository: repository,
    };
  }
  const blockedRepoValue = parsed.blocked_issue_repo;
  if (!isObjectLike(blockedRepoValue)) throw new Error("Invalid webhook payload: missing blocked_issue_repo");
  requireString(blockedRepoValue.full_name, "blocked_issue_repo.full_name");
  const { owner, repo } = splitFullName(
    blockedRepoValue.full_name as unknown as string,
    "blocked_issue_repo.full_name"
  );
  const branch =
    typeof blockedRepoValue.default_branch === "string" && blockedRepoValue.default_branch
      ? (blockedRepoValue.default_branch as string)
      : undefined;
  return {
    action,
    blockedOwner: owner,
    blockedRepo: repo,
    blockedNumber,
    triggerOwner,
    triggerRepo,
    triggerRepository: repository,
    ...(branch ? { blockedDefaultBranch: branch } : {}),
  };
}

function issueKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

export async function blockedIssueJobsFrom(
  owner: string,
  repo: string,
  number: number,
  repository: RepoRef,
  action: string,
  policy: IssueWebhookPolicy,
  api: BlockApi
): Promise<Omit<IssueJob, "delivery" | "receivedAt">[]> {
  const jobs: Omit<IssueJob, "delivery" | "receivedAt">[] = [];
  const seen = new Set<string>();
  const stack = new Set<string>();

  const context: BlockEligibilityContext = { owner, repo, repository, action, policy, api };

  const walk = async (curOwner: string, curRepo: string, index: number): Promise<void> => {
    const key = issueKey(curOwner, curRepo, index);
    if (stack.has(key)) return;
    if (seen.has(key)) return;
    if (seen.size >= DEPENDENCY_GRAPH_CAP) return;
    seen.add(key);
    stack.add(key);

    const blocked = await api.listIssueBlocks(curOwner, curRepo, index);
    for (const row of blocked) {
      const rowKey = issueKey(row.owner, row.repo, row.number);
      if (stack.has(rowKey) || seen.has(rowKey)) continue;
      try {
        assertRepositoryPolicy({ full_name: `${row.owner}/${row.repo}`, html_url: row.html_url }, policy);
      } catch {
        continue;
      }
      const job = await enqueueEligibleBlockedIssue(row, context);
      if (job) jobs.push(job);
      await walk(row.owner, row.repo, row.number);
    }
    stack.delete(key);
  };

  await walk(owner, repo, number);
  return jobs;
}

export async function blockedIssueJobsToEnqueue(
  payload: GiteaIssuePayload,
  policy: IssueWebhookPolicy,
  api: BlockApi
): Promise<Omit<IssueJob, "delivery" | "receivedAt">[]> {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);
  return blockedIssueJobsFrom(owner, repo, payload.issue.number, payload.repository, payload.action, policy, api);
}

export async function assignedIssueJobsToEnqueue(
  owner: string,
  repo: string,
  repository: { default_branch: string; clone_url: string },
  action: string,
  policy: IssueWebhookPolicy,
  api: {
    listRepoIssues(
      owner: string,
      repo: string,
      opts?: { state?: "open" | "closed" | "all"; type?: "issues" | "pulls"; assignedBy?: string }
    ): Promise<LinkedIssue[]>;
    getIssue(owner: string, repo: string, index: number): Promise<Task>;
  },
  exclude: ReadonlySet<number> = new Set()
): Promise<Omit<IssueJob, "delivery" | "receivedAt">[]> {
  const listed = await api.listRepoIssues(owner, repo, {
    state: "open",
    type: "issues",
    ...(policy.isPickedUp ? {} : { assignedBy: policy.botUsername }),
  });
  const jobs: Omit<IssueJob, "delivery" | "receivedAt">[] = [];
  const seen = new Set<number>();
  for (const row of listed) {
    if (row.owner !== owner || row.repo !== repo) continue;
    if (exclude.has(row.number) || seen.has(row.number)) continue;
    seen.add(row.number);
    let issue: Task;
    try {
      issue = await api.getIssue(owner, repo, row.number);
    } catch {
      continue;
    }
    if (isPullRequestIssue(issue) || issue.state !== "open") continue;
    if (!isIssuePickedUp(issue, policy)) continue;
    jobs.push(issueJobFrom(owner, repo, issue, repository, action));
  }
  return jobs;
}

function jobKey(job: Omit<IssueJob, "delivery" | "receivedAt">): string {
  return `${job.owner}/${job.repo}#${job.issueNumber}`;
}

function shouldWakeAssignedIssues(
  payload: GiteaPRPayload,
  owner: string,
  repo: string,
  policy: IssueWebhookPolicy
): boolean {
  const pr = payload.pull_request;
  const action = payload.action;
  const botUsername = policy.botUsername;
  if (!isForeignPrIdentity(pr, owner, repo, botUsername)) return false;
  if (action === "unassigned") {
    if (payload.assignee != null) {
      return isAssignedToBot({ assignee: payload.assignee }, botUsername);
    }
    return !isAssignedToBot(pr, botUsername);
  }
  if (action !== "closed" && action !== "merged") return false;
  return isIssuePickedUp(pr, policy);
}

export async function pullWaitClearJobsToEnqueue(
  payload: GiteaPRPayload,
  policy: IssueWebhookPolicy,
  api: {
    listOpenPulls(owner: string, repo: string): Promise<Pull[]>;
    getIssue(owner: string, repo: string, index: number): Promise<Task>;
    listIssueBlocks?(owner: string, repo: string, index: number): Promise<LinkedIssue[]>;
    listRepoIssues?(
      owner: string,
      repo: string,
      opts?: { state?: "open" | "closed" | "all"; type?: "issues" | "pulls"; assignedBy?: string }
    ): Promise<LinkedIssue[]>;
    getRepo?(owner: string, repo: string): Promise<Repo>;
  },
  logger?: (message: string) => void
): Promise<Omit<IssueJob, "delivery" | "receivedAt">[]> {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);
  const pr = payload.pull_request;
  const jobs: Omit<IssueJob, "delivery" | "receivedAt">[] = [];
  const seen = new Set<string>();
  const add = (job: Omit<IssueJob, "delivery" | "receivedAt">) => {
    const key = jobKey(job);
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push(job);
  };

  let blocksError: unknown;
  if ((payload.action === "closed" || payload.action === "merged") && api.listIssueBlocks) {
    try {
      const numbers = new Set<number>([pr.number, ...extractClosingIssueNumbers(pr)]);
      for (const number of numbers) {
        const woken = await blockedIssueJobsFrom(owner, repo, number, payload.repository, payload.action, policy, {
          listIssueBlocks: api.listIssueBlocks,
          getIssue: api.getIssue,
          getRepo: api.getRepo,
        });
        for (const job of woken) add(job);
      }
    } catch (err) {
      blocksError = err;
      logger?.(`failed to list issue blocks: ${errorMessage(err)}`);
    }
  }

  if (api.listRepoIssues && shouldWakeAssignedIssues(payload, owner, repo, policy)) {
    const pulls = await api.listOpenPulls(owner, repo);
    const remainingLock = pulls.some(
      (open) => open.number !== pr.number && isAssignedForeignPR(open, owner, repo, policy.botUsername, policy)
    );
    if (!remainingLock) {
      const assigned = await assignedIssueJobsToEnqueue(
        owner,
        repo,
        payload.repository,
        payload.action,
        policy,
        { listRepoIssues: api.listRepoIssues, getIssue: api.getIssue },
        new Set([pr.number])
      );
      for (const job of assigned) add(job);
    }
  }

  if (blocksError && jobs.length === 0) throw blocksError;
  return jobs;
}
