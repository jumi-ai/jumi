import { isIssuePickedUp, type PickupPolicy } from "./assignee.ts";
import { isJumiReviewContext } from "./ci.ts";
import {
  extractWorkingIssueNumber,
  type IssueApi,
  isAssignedForeignPR,
  isInScopeJumiPR,
  isWipOrDraft,
} from "./gitea_issues.ts";
import { loadRepoSettings } from "./repo_settings.ts";
import type { GiteaWorkflowJobPayload, IssueJob, IssueJobTrigger, ReviewJob } from "./types.ts";
import type { WebhookPolicy } from "./webhook.ts";
import { assertRepositoryPolicy } from "./webhook.ts";

export type CiWebhookPolicy = WebhookPolicy & PickupPolicy;

export type CiWebhookDecision =
  | { type: "enqueue"; jobs: Omit<IssueJob, "delivery" | "receivedAt">[] }
  | { type: "skip"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid webhook payload: missing ${name}`);
  return value;
}

export function parseWorkflowJobPayload(rawBody: Uint8Array): GiteaWorkflowJobPayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObject(parsed)) throw new Error("Invalid webhook payload: expected object");
  const repository = parsed.repository;
  if (!isObject(repository)) throw new Error("Invalid webhook payload: missing repository");
  requireString(repository.full_name, "repository.full_name");
  requireString(repository.default_branch, "repository.default_branch");
  requireString(repository.clone_url, "repository.clone_url");
  if (parsed.workflow_job != null && !isObject(parsed.workflow_job)) {
    throw new Error("Invalid webhook payload: missing workflow_job");
  }
  return parsed as unknown as GiteaWorkflowJobPayload;
}

function workflowJobSender(payload: GiteaWorkflowJobPayload): string {
  return payload.sender?.login || "workflow_job";
}

function workflowJobTrigger(payload: GiteaWorkflowJobPayload, sender: string): IssueJobTrigger {
  const id = payload.workflow_job?.id;
  if (typeof id === "number" && Number.isFinite(id)) {
    return { event: "workflow_job", sender, workflowJobId: id };
  }
  return { event: "workflow_job", sender };
}

function jobHeadMatches(
  prSha: string,
  prRef: string,
  job: { head_sha?: string; head_branch?: string } | undefined
): boolean {
  if (!job) return false;
  const sha = (job.head_sha ?? "").toLowerCase();
  const branch = job.head_branch ?? "";
  if (sha && sha === prSha.toLowerCase()) return true;
  if (branch && branch === prRef) return true;
  return false;
}

function isWorkflowJobCompleted(payload: GiteaWorkflowJobPayload): boolean {
  return payload.action === "completed" || payload.workflow_job?.status === "completed";
}

function workflowJobNotCompletedReason(payload: GiteaWorkflowJobPayload): string {
  const status = payload.workflow_job?.status || payload.action;
  return status ? `workflow_job ${status}` : "workflow_job not completed";
}

export async function shouldEnqueueWorkflowJobFollowUp(
  payload: GiteaWorkflowJobPayload,
  policy: CiWebhookPolicy,
  api: Pick<IssueApi, "listOpenPulls" | "getIssue">,
  logger?: (message: string) => void
): Promise<CiWebhookDecision> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = assertRepositoryPolicy(payload.repository, policy));
  } catch (err) {
    logger?.(`repository not allowed: ${err instanceof Error ? err.message : String(err)}`);
    return { type: "skip", reason: "repository not allowed" };
  }

  if (!isWorkflowJobCompleted(payload)) {
    return { type: "skip", reason: workflowJobNotCompletedReason(payload) };
  }

  const job = payload.workflow_job;
  if (!job || (!job.head_sha && !job.head_branch)) {
    return { type: "skip", reason: "not an in-scope jumi pull request" };
  }

  const pulls = await api.listOpenPulls(owner, repo);
  const jobs: Omit<IssueJob, "delivery" | "receivedAt">[] = [];
  const sender = workflowJobSender(payload);

  for (const pr of pulls) {
    if (!jobHeadMatches(pr.head.sha, pr.head.ref, job)) continue;
    if (isAssignedForeignPR(pr, owner, repo, policy.botUsername, policy)) {
      jobs.push({
        owner,
        repo,
        issueNumber: pr.number,
        action: payload.action || "completed",
        title: pr.title,
        body: pr.body ?? "",
        htmlUrl: pr.html_url,
        issueUpdatedAt: pr.updated_at,
        defaultBranch: payload.repository.default_branch,
        cloneUrl: payload.repository.clone_url,
        mode: "follow-up",
        prNumber: pr.number,
        headSha: pr.head.sha,
        trigger: workflowJobTrigger(payload, sender),
      });
      continue;
    }
    if (!isInScopeJumiPR(pr, owner, repo, policy.botUsername)) continue;
    const issueNumber = extractWorkingIssueNumber(pr);
    if (issueNumber === undefined) continue;
    try {
      const issue = await api.getIssue(owner, repo, issueNumber);
      if (issue.state !== "open" || !isIssuePickedUp(issue, policy)) continue;
      jobs.push({
        owner,
        repo,
        issueNumber,
        action: payload.action || "completed",
        title: issue.title,
        body: issue.body ?? "",
        htmlUrl: issue.html_url,
        issueUpdatedAt: issue.updated_at,
        defaultBranch: payload.repository.default_branch,
        cloneUrl: payload.repository.clone_url,
        mode: "follow-up",
        prNumber: pr.number,
        headSha: pr.head.sha,
        trigger: workflowJobTrigger(payload, sender),
      });
    } catch (err) {
      if (err instanceof Error && /→ 404\b/.test(err.message)) continue;
      throw err;
    }
  }

  if (jobs.length === 0) return { type: "skip", reason: "not an in-scope jumi pull request" };
  return { type: "enqueue", jobs };
}

export type CiReviewWebhookDecision =
  | { type: "enqueue"; jobs: Omit<ReviewJob, "delivery" | "receivedAt">[] }
  | { type: "skip"; reason: string };

type ReviewDraftsApi = Pick<IssueApi, "listOpenPulls"> & Partial<Pick<IssueApi, "getRepo" | "getRepoFile">>;

async function resolveReviewDrafts(
  api: ReviewDraftsApi | undefined,
  owner: string,
  repo: string,
  defaultBranch: string | undefined | null,
  opts: { reviewDrafts?: boolean } | undefined,
  logger?: (message: string) => void
): Promise<boolean> {
  if (opts?.reviewDrafts !== undefined) return opts.reviewDrafts === true;
  try {
    const getFile = (api as { getRepoFile?: unknown } | undefined)?.getRepoFile;
    let branch = (defaultBranch ?? "").trim();
    if (!branch) {
      const getRepo = (api as { getRepo?: unknown } | undefined)?.getRepo;
      if (typeof getRepo !== "function") return false;
      const info = await (getRepo as (o: string, r: string) => Promise<{ default_branch?: string }>).call(
        api,
        owner,
        repo
      );
      branch = info?.default_branch?.trim() ?? "";
    }
    if (!branch || typeof getFile !== "function") return false;
    const load = await loadRepoSettings(
      api as {
        getRepoFile(o: string, r: string, p: string, ref: string): Promise<{ found: boolean; content?: string }>;
      },
      owner,
      repo,
      branch
    );
    if (load.state !== "valid") return false;
    return load.reviewDrafts === true;
  } catch (err) {
    logger?.(
      `review drafts settings unreadable for ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

export async function shouldEnqueueWorkflowJobReview(
  payload: GiteaWorkflowJobPayload,
  policy: WebhookPolicy,
  api: Pick<IssueApi, "listOpenPulls">,
  logger?: (message: string) => void,
  opts?: { reviewDrafts?: boolean }
): Promise<CiReviewWebhookDecision> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = assertRepositoryPolicy(payload.repository, policy));
  } catch (err) {
    logger?.(`repository not allowed: ${err instanceof Error ? err.message : String(err)}`);
    return { type: "skip", reason: "repository not allowed" };
  }

  if (!isWorkflowJobCompleted(payload)) {
    return { type: "skip", reason: workflowJobNotCompletedReason(payload) };
  }

  const job = payload.workflow_job;
  if (!job || (!job.head_sha && !job.head_branch)) {
    return { type: "skip", reason: "no matching pull request" };
  }

  const reviewDrafts = await resolveReviewDrafts(api, owner, repo, payload.repository.default_branch, opts, logger);
  const pulls = await api.listOpenPulls(owner, repo);
  const jobs: Omit<ReviewJob, "delivery" | "receivedAt">[] = [];
  for (const pr of pulls) {
    if (!jobHeadMatches(pr.head.sha, pr.head.ref, job)) continue;
    if (pr.state !== "open" || pr.merged) continue;
    if (!reviewDrafts && isWipOrDraft(pr)) continue;
    if (!pr.head?.sha) continue;
    jobs.push({
      owner,
      repo,
      prNumber: pr.number,
      action: payload.action || "completed",
      headSha: pr.head.sha,
      prUpdatedAt: pr.updated_at,
    });
  }
  if (jobs.length === 0) return { type: "skip", reason: "no matching pull request" };
  return { type: "enqueue", jobs };
}

const FINISHED_CHECK_STATES = new Set([
  "success",
  "failure",
  "error",
  "warning",
  "neutral",
  "cancelled",
  "canceled",
  "skipped",
  "timed_out",
  "startup_failure",
  "action_required",
  "stale",
]);

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function siblingFinishSkip(context: string | undefined, state: string | undefined): string | undefined {
  if (isJumiReviewContext(context)) return "jumi review status";
  const normalized = (state ?? "").toLowerCase();
  if (!FINISHED_CHECK_STATES.has(normalized)) return normalized ? `status ${normalized}` : "status not completed";
  return undefined;
}

function readStatusRepository(
  parsed: Record<string, unknown>
): { full_name: string; html_url?: string; clone_url?: string } | undefined {
  const repository = parsed.repository;
  if (!isObject(repository)) return undefined;
  const fullName = stringField(repository.full_name);
  if (!fullName) return undefined;
  return {
    full_name: fullName,
    html_url: stringField(repository.html_url),
    clone_url: stringField(repository.clone_url),
  };
}

type SiblingCheckFinish = { sha: string; branch?: string; context?: string; state: string };

function parseStatusFinish(parsed: Record<string, unknown>): SiblingCheckFinish | { skip: string } {
  const sha = stringField(parsed.sha);
  if (!sha) return { skip: "malformed status payload" };
  const state = stringField(parsed.state) ?? stringField(parsed.status) ?? "";
  const context = stringField(parsed.context) ?? stringField(parsed.name);
  return { sha, context, state };
}

function parseCheckRunFinish(parsed: Record<string, unknown>): SiblingCheckFinish | { skip: string } {
  const action = stringField(parsed.action) ?? "";
  const run = parsed.check_run;
  if (!isObject(run)) return { skip: "malformed check_run payload" };
  const status = stringField(run.status) ?? "";
  if (action !== "completed" && status !== "completed") {
    return { skip: action ? `check_run ${action}` : "check_run not completed" };
  }
  const conclusion = stringField(run.conclusion);
  if (!conclusion) return { skip: "check_run not completed" };
  const sha = stringField(run.head_sha);
  if (!sha) return { skip: "malformed check_run payload" };
  const suite = isObject(run.check_suite) ? run.check_suite : undefined;
  return {
    sha,
    branch: suite ? stringField(suite.head_branch) : undefined,
    context: stringField(run.name),
    state: conclusion,
  };
}

export async function shouldEnqueueSiblingCheckReview(
  rawBody: Uint8Array,
  event: string,
  policy: WebhookPolicy,
  api: Pick<IssueApi, "listOpenPulls">,
  logger?: (message: string) => void,
  opts?: { reviewDrafts?: boolean }
): Promise<CiReviewWebhookDecision> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return { type: "skip", reason: "malformed status payload" };
  }
  if (!isObject(parsed)) return { type: "skip", reason: "malformed status payload" };
  const repository = readStatusRepository(parsed);
  if (!repository) return { type: "skip", reason: "malformed status payload" };

  const finish = event === "check_run" ? parseCheckRunFinish(parsed) : parseStatusFinish(parsed);
  if ("skip" in finish) return { type: "skip", reason: finish.skip };
  const early = siblingFinishSkip(finish.context, finish.state);
  if (early) return { type: "skip", reason: early };

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = assertRepositoryPolicy(repository, policy));
  } catch (err) {
    logger?.(`repository not allowed: ${err instanceof Error ? err.message : String(err)}`);
    return { type: "skip", reason: "repository not allowed" };
  }

  const reviewDrafts = await resolveReviewDrafts(api, owner, repo, undefined, opts, logger);
  const pulls = await api.listOpenPulls(owner, repo);
  const jobs: Omit<ReviewJob, "delivery" | "receivedAt">[] = [];
  for (const pr of pulls) {
    if (!jobHeadMatches(pr.head.sha, pr.head.ref, { head_sha: finish.sha, head_branch: finish.branch })) continue;
    if (pr.state !== "open" || pr.merged) continue;
    if (!reviewDrafts && isWipOrDraft(pr)) continue;
    if (!pr.head?.sha) continue;
    jobs.push({
      owner,
      repo,
      prNumber: pr.number,
      action: "completed",
      headSha: pr.head.sha,
      prUpdatedAt: pr.updated_at,
    });
  }
  if (jobs.length === 0) return { type: "skip", reason: "no matching pull request" };
  return { type: "enqueue", jobs };
}
