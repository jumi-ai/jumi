import { hasLabel, isAssignedToBot, isIssuePickedUp, isPullRequestIssue, type PickupPolicy } from "./assignee.ts";
import {
  extractClosingIssueNumber,
  type IssueApi,
  isEligibleWorkerPR,
  isInScopeJumiPR,
  isJumiPrIdentity,
  isWipOrDraft,
} from "./gitea_issues.ts";
import { hasTrustedSenders, type PermissionApi, senderCanSteer } from "./permissions.ts";
import type { GiteaIssue, GiteaIssueCommentPayload, GiteaPR, GiteaPRPayload, GiteaRepo, IssueJob } from "./types.ts";
import type { WebhookPolicy } from "./webhook.ts";
import { assertRepositoryPolicy } from "./webhook.ts";

export type FollowUpWebhookPolicy = WebhookPolicy &
  PickupPolicy & {
    followupIgnoreLogins?: readonly string[];
    trustedSenderLogins?: readonly string[];
  };

export const SENDER_CANNOT_PUSH = "sender lacks write access";
export const SENDER_NOT_TRUSTED = "sender not on trusted list";

export type FollowUpWebhookDecision =
  | { type: "enqueue"; job: Omit<IssueJob, "delivery" | "receivedAt"> }
  | { type: "skip"; reason: string };

export type PullAssignWebhookDecision =
  | FollowUpWebhookDecision
  | { type: "cancel"; owner: string; repo: string; issueNumber: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

function loginEquals(login: string | undefined, botUsername: string): boolean {
  return typeof login === "string" && login.toLowerCase() === botUsername.toLowerCase();
}

export function loginInList(login: string | undefined, logins: readonly string[] | undefined): boolean {
  if (typeof login !== "string" || !login) return false;
  const needle = login.toLowerCase();
  for (const item of logins ?? []) {
    if (item.toLowerCase() === needle) return true;
  }
  return false;
}

export function isPullThread(issue: GiteaIssue): boolean {
  return isPullRequestIssue(issue) || issue.is_pull === true;
}

export function isJumiWorkerBody(body: string | null | undefined): boolean {
  return (body ?? "").includes("<!-- jumi-worker:");
}

export function isJumiInternalBody(body: string | null | undefined): boolean {
  return /<!--\s*jumi-/.test(body ?? "");
}

export function parseIssueCommentPayload(rawBody: Uint8Array): GiteaIssueCommentPayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObject(parsed)) throw new Error("Invalid webhook payload: expected object");
  const repository = parsed.repository;
  const issue = parsed.issue;
  const comment = parsed.comment;
  if (!isObject(repository)) throw new Error("Invalid webhook payload: missing repository");
  if (!isObject(issue)) throw new Error("Invalid webhook payload: missing issue");
  if (!isObject(comment)) throw new Error("Invalid webhook payload: missing comment");
  requireString(parsed.action, "action");
  requireString(repository.full_name, "repository.full_name");
  requireNumber(issue.number, "issue.number");
  requireString(issue.title, "issue.title");
  requireString(issue.html_url, "issue.html_url");
  requireNumber(comment.id, "comment.id");
  if (parsed.pull_request != null) {
    const pr = parsed.pull_request;
    if (!isObject(pr)) throw new Error("Invalid webhook payload: missing pull_request");
    requireNumber(pr.number, "pull_request.number");
    if (!isObject(pr.head)) throw new Error("Invalid webhook payload: missing pull_request.head");
  }
  return parsed as unknown as GiteaIssueCommentPayload;
}

export function parsePullRejectedPayload(rawBody: Uint8Array): GiteaPRPayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObject(parsed)) throw new Error("Invalid webhook payload: expected object");
  const repository = parsed.repository;
  const pr = parsed.pull_request;
  if (!isObject(repository)) throw new Error("Invalid webhook payload: missing repository");
  if (!isObject(pr)) throw new Error("Invalid webhook payload: missing pull_request");
  requireString(repository.full_name, "repository.full_name");
  requireNumber(pr.number, "pull_request.number");
  if (typeof parsed.action !== "string" || !parsed.action) parsed.action = "reviewed";
  return parsed as unknown as GiteaPRPayload;
}

export function prFromCommentIssue(issue: GiteaIssue, repository: GiteaRepo): GiteaPR {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    user: issue.user,
    assignee: issue.assignee,
    assignees: issue.assignees,
    head: {
      label: "",
      ref: "",
      sha: "",
      repo: repository,
      repo_id: repository.id,
    },
    base: {
      label: repository.default_branch,
      ref: repository.default_branch,
      sha: "",
      repo: repository,
      repo_id: repository.id,
    },
    merged: issue.pull_request?.merged === true,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: issue.pull_request?.html_url ?? issue.html_url,
    draft: issue.pull_request?.draft,
  };
}

export function followUpIssueNumber(
  pr: GiteaPR,
  issue: GiteaIssue | undefined,
  botUsername: string,
  policy?: PickupPolicy
): number | undefined {
  const pickup = policy ?? { botUsername };
  if (isJumiPrIdentity(pr, botUsername)) {
    const closer = extractClosingIssueNumber(pr);
    if (closer !== undefined) return closer;
  }
  if (issue && isIssuePickedUp(issue, pickup)) return pr.number;
  if (isIssuePickedUp(pr, pickup)) return pr.number;
  return undefined;
}

export function followUpSkipReason(
  pr: GiteaPR,
  issue: GiteaIssue | undefined,
  owner: string,
  repo: string,
  botUsername: string,
  policy?: PickupPolicy
): string | undefined {
  const pickup = policy ?? { botUsername };
  if (pr.state !== "open" || pr.merged) return "pull request not open";
  if (isWipOrDraft(pr)) return "draft or WIP pull request";
  if (pr.head?.repo && pr.head.repo.full_name !== `${owner}/${repo}`) return "fork pull request";

  const closer = isJumiPrIdentity(pr, botUsername) ? extractClosingIssueNumber(pr) : undefined;
  if (closer !== undefined) {
    if (issue) {
      if (issue.number !== closer) return "closing issue mismatch";
      if (issue.state !== "open") return "issue not open";
      if (!isIssuePickedUp(issue, pickup)) return pickup.isPickedUp ? "not labeled jumi" : "not assigned to bot";
    }
    if (pr.head?.repo && !isInScopeJumiPR(pr, owner, repo, botUsername) && pr.head.ref) {
      return "not an in-scope jumi pull request";
    }
    return undefined;
  }

  const assignedOnIssue = Boolean(issue && isIssuePickedUp(issue, pickup) && issue.number === pr.number);
  const assignedOnPr = isIssuePickedUp(pr, pickup);
  if (!assignedOnIssue && !assignedOnPr) {
    if (!isJumiPrIdentity(pr, botUsername)) return "not a jumi pull request";
    return "no closing issue";
  }
  if (issue && issue.state !== "open") return "issue not open";
  if (pr.head?.ref && !isEligibleWorkerPR(pr, owner, repo) && pr.head.repo) {
    return "fork pull request";
  }
  return undefined;
}

function followUpJob(
  owner: string,
  repo: string,
  issueNumber: number,
  pr: GiteaPR,
  repository: GiteaRepo,
  action: string,
  trigger: IssueJob["trigger"],
  issue?: GiteaIssue
): Omit<IssueJob, "delivery" | "receivedAt"> {
  return {
    owner,
    repo,
    issueNumber,
    action,
    title: issue?.title ?? pr.title,
    body: issue?.body ?? pr.body ?? "",
    htmlUrl: issue?.html_url ?? pr.html_url,
    issueUpdatedAt: issue?.updated_at ?? pr.updated_at,
    defaultBranch: repository.default_branch,
    cloneUrl: repository.clone_url,
    mode: "follow-up",
    prNumber: pr.number,
    headSha: pr.head?.sha || undefined,
    trigger,
  };
}

export function shouldEnqueueIssueCommentFollowUp(
  payload: GiteaIssueCommentPayload,
  policy: FollowUpWebhookPolicy,
  eventName: string,
  closingIssue?: GiteaIssue
): FollowUpWebhookDecision {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);

  if (!isPullThread(payload.issue)) {
    return { type: "skip", reason: "not a pull request comment" };
  }
  if (payload.action !== "created") {
    return { type: "skip", reason: `unsupported action ${payload.action}` };
  }
  if (loginEquals(payload.sender?.login, policy.botUsername)) {
    return { type: "skip", reason: "sender is bot" };
  }
  if (loginInList(payload.sender?.login, policy.followupIgnoreLogins)) {
    return { type: "skip", reason: "sender ignored" };
  }
  const body = payload.comment.body ?? "";
  if (!body.trim()) return { type: "skip", reason: "empty comment body" };
  if (isJumiInternalBody(body)) return { type: "skip", reason: "jumi internal comment" };

  const embedded = payload.pull_request;
  const pr =
    embedded && typeof embedded.head?.ref === "string" && embedded.head.ref
      ? embedded
      : prFromCommentIssue(payload.issue, payload.repository);
  const issueNumber = followUpIssueNumber(pr, closingIssue ?? payload.issue, policy.botUsername, policy);
  if (issueNumber === undefined) {
    if (!isJumiPrIdentity(pr, policy.botUsername)) return { type: "skip", reason: "not a jumi pull request" };
    return { type: "skip", reason: "no closing issue" };
  }

  const skipIssue =
    isJumiPrIdentity(pr, policy.botUsername) && extractClosingIssueNumber(pr) !== undefined
      ? closingIssue
      : (closingIssue ?? payload.issue);
  const skip = followUpSkipReason(pr, skipIssue, owner, repo, policy.botUsername, policy);
  if (skip) return { type: "skip", reason: skip };

  return {
    type: "enqueue",
    job: followUpJob(
      owner,
      repo,
      issueNumber,
      pr,
      payload.repository,
      payload.action,
      {
        event: eventName,
        commentId: payload.comment.id,
        sender: payload.sender.login,
      },
      closingIssue ?? (issueNumber === pr.number ? payload.issue : undefined)
    ),
  };
}

export function shouldEnqueuePullRejectedFollowUp(
  payload: GiteaPRPayload,
  policy: FollowUpWebhookPolicy,
  eventName: string,
  closingIssue?: GiteaIssue
): FollowUpWebhookDecision {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);

  if (loginEquals(payload.sender?.login, policy.botUsername)) {
    return { type: "skip", reason: "sender is bot" };
  }
  if (loginInList(payload.sender?.login, policy.followupIgnoreLogins)) {
    return { type: "skip", reason: "sender ignored" };
  }
  const reviewBody = payload.review?.content ?? payload.review?.body ?? "";
  if (!reviewBody.trim()) return { type: "skip", reason: "empty comment body" };

  const pr = payload.pull_request;
  const issueNumber = followUpIssueNumber(pr, closingIssue, policy.botUsername, policy);
  if (issueNumber === undefined) {
    if (!isJumiPrIdentity(pr, policy.botUsername)) return { type: "skip", reason: "not a jumi pull request" };
    return { type: "skip", reason: "no closing issue" };
  }

  const skip = followUpSkipReason(pr, closingIssue, owner, repo, policy.botUsername, policy);
  if (skip) return { type: "skip", reason: skip };

  return {
    type: "enqueue",
    job: followUpJob(
      owner,
      repo,
      issueNumber,
      pr,
      payload.repository,
      payload.action || "reviewed",
      {
        event: eventName,
        reviewId: payload.review?.id,
        body: payload.review?.content ?? payload.review?.body ?? undefined,
        sender: payload.sender.login,
      },
      closingIssue
    ),
  };
}

/**
 * Filter an event's own wake by its sender. Fail-closed: unless the sender may
 * steer (`senderCanSteer`: on the operator's trusted list when one is set,
 * otherwise the forge push check), the enqueue becomes a skip. Skips and
 * cancels pass through, so pickup rules and the bot/ignore-login skips stay as
 * they are: trust is necessary, not sufficient. Scope checks run first so
 * out-of-scope events never cost a forge round-trip and keep their scope skip
 * reason.
 */
export async function requireSenderPush<D extends { type: string }>(
  decision: D,
  api: Partial<PermissionApi> | undefined,
  sender: string | undefined,
  trustedSenderLogins?: readonly string[]
): Promise<D | { type: "skip"; reason: string }> {
  if (decision.type !== "enqueue") return decision;
  const { owner, repo } = (decision as unknown as { job: { owner: string; repo: string } }).job;
  if (await senderCanSteer(api, owner, repo, sender, trustedSenderLogins)) return decision;
  return { type: "skip", reason: hasTrustedSenders(trustedSenderLogins) ? SENDER_NOT_TRUSTED : SENDER_CANNOT_PUSH };
}

/** Push-gated wake for issue/PR comments. */
export async function shouldEnqueueIssueCommentFollowUpWithTrust(
  payload: GiteaIssueCommentPayload,
  policy: FollowUpWebhookPolicy,
  eventName: string,
  closingIssue?: GiteaIssue,
  api?: Partial<PermissionApi>
): Promise<FollowUpWebhookDecision> {
  const scope = shouldEnqueueIssueCommentFollowUp(payload, policy, eventName, closingIssue);
  return requireSenderPush(scope, api, payload.sender?.login, policy.trustedSenderLogins);
}

/** Push-gated wake for request-changes / review rejections. Same bar as comments. */
export async function shouldEnqueuePullRejectedFollowUpWithTrust(
  payload: GiteaPRPayload,
  policy: FollowUpWebhookPolicy,
  eventName: string,
  closingIssue?: GiteaIssue,
  api?: Partial<PermissionApi>
): Promise<FollowUpWebhookDecision> {
  const scope = shouldEnqueuePullRejectedFollowUp(payload, policy, eventName, closingIssue);
  return requireSenderPush(scope, api, payload.sender?.login, policy.trustedSenderLogins);
}

export async function shouldEnqueuePullAssign(
  payload: GiteaPRPayload,
  policy: FollowUpWebhookPolicy,
  api?: Pick<IssueApi, "getIssue">,
  logger?: (message: string) => void
): Promise<PullAssignWebhookDecision> {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);
  const pr = payload.pull_request;

  if (payload.action === "unassigned") {
    if (!isAssignedToBot(pr, policy.botUsername)) {
      return { type: "cancel", owner, repo, issueNumber: pr.number };
    }
    return { type: "skip", reason: "bot still assigned" };
  }

  if (payload.action !== "assigned") {
    return { type: "skip", reason: `unsupported action ${payload.action}` };
  }

  if (!isAssignedToBot(pr, policy.botUsername)) {
    return { type: "skip", reason: "not assigned to bot" };
  }

  const skip = followUpSkipReason(pr, undefined, owner, repo, policy.botUsername, policy);
  if (skip) return { type: "skip", reason: skip };

  const closer = extractClosingIssueNumber(pr);
  if (closer !== undefined) {
    if (!api) return { type: "skip", reason: "failed to load issue" };
    try {
      const issue = await api.getIssue(owner, repo, closer);
      if (issue.state === "open" && isAssignedToBot(issue, policy.botUsername)) {
        return { type: "skip", reason: "closing issue already assigned" };
      }
    } catch (err) {
      logger?.(`failed to load issue: ${err instanceof Error ? err.message : String(err)}`);
      return {
        type: "skip",
        reason: "failed to load issue",
      };
    }
  }

  return {
    type: "enqueue",
    job: followUpJob(owner, repo, pr.number, pr, payload.repository, payload.action, {
      event: "pull_request_assign",
      sender: payload.sender.login,
    }),
  };
}

function payloadJumiLabel(label: GiteaPRPayload["label"]): boolean {
  if (label == null) return false;
  return hasLabel({ labels: [label] }, "jumi");
}

function prWithEventLabel(pr: GiteaPR, label: GiteaPRPayload["label"]): GiteaPR {
  if (label == null) return pr;
  return { ...pr, labels: [...(pr.labels ?? []), label] };
}

export async function shouldEnqueuePullLabel(
  payload: GiteaPRPayload,
  policy: FollowUpWebhookPolicy,
  api?: Pick<IssueApi, "getIssue">,
  logger?: (message: string) => void
): Promise<PullAssignWebhookDecision> {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);
  const pr = prWithEventLabel(payload.pull_request, payload.label);

  if (payload.action === "unlabeled") {
    if (!payloadJumiLabel(payload.label)) return { type: "skip", reason: "unlabeled other label" };
    return { type: "cancel", owner, repo, issueNumber: pr.number };
  }

  if (payload.action !== "labeled") {
    return { type: "skip", reason: `unsupported action ${payload.action}` };
  }

  if (loginEquals(payload.sender?.login, policy.botUsername)) {
    return { type: "skip", reason: "sender is bot" };
  }
  if (!payloadJumiLabel(payload.label)) return { type: "skip", reason: "labeled other label" };

  const skip = followUpSkipReason(pr, undefined, owner, repo, policy.botUsername, policy);
  if (skip) return { type: "skip", reason: skip };

  const closer = extractClosingIssueNumber(pr);
  if (closer !== undefined) {
    if (!api) return { type: "skip", reason: "failed to load issue" };
    try {
      const issue = await api.getIssue(owner, repo, closer);
      if (issue.state === "open" && isIssuePickedUp(issue, policy)) {
        return { type: "skip", reason: "closing issue already assigned" };
      }
    } catch (err) {
      logger?.(`failed to load issue: ${err instanceof Error ? err.message : String(err)}`);
      return {
        type: "skip",
        reason: "failed to load issue",
      };
    }
  }

  return {
    type: "enqueue",
    job: followUpJob(owner, repo, pr.number, pr, payload.repository, payload.action, {
      event: "labeled",
      sender: payload.sender.login,
    }),
  };
}
