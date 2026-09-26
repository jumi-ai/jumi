import { isIssuePickedUp, type PickupPolicy } from "./assignee.ts";
import { MAX_FOLLOWUP_ROUNDS } from "./followup.ts";
import { extractClosingIssueNumber, isAssignedForeignPR, isJumiPrIdentity } from "./gitea_issues.ts";
import type { Pull, Repo, ReviewApi, Task } from "./ports.ts";
import type { EnqueueResult } from "./queue.ts";
import type { ReviewResult } from "./review.ts";
import type { ReviewJobRecord, ReviewJobStore } from "./review_jobs.ts";
import { rememberSitBestEffort } from "./router_sits.ts";
import { upsertStuckText } from "./stuck.ts";
import type { IssueJob } from "./types.ts";
import { parseReviewOutput, trailerSuggestionCount } from "./verdict.ts";

export const TOO_MANY_FOLLOWUP_ROUNDS = "stuck: too many follow-up rounds";

export function isCurrentHeadFailureTrailer(markdown: string | null | undefined): boolean {
  if (!markdown) return false;
  const parsed = parseReviewOutput(markdown);
  return !parsed.verdict.incomplete && parsed.verdict.state === "failure";
}

export function isLeftoverSimplificationTrailer(markdown: string | null | undefined): boolean {
  if (!markdown) return false;
  const parsed = parseReviewOutput(markdown);
  return (
    !parsed.verdict.incomplete &&
    parsed.verdict.state === "success" &&
    trailerSuggestionCount(parsed.verdict.description) > 0
  );
}

export function shouldHandoverFollowUp(opts: { published: ReviewResult; markdown?: string | null }): boolean {
  if (opts.published.status !== "posted" && opts.published.status !== "updated") return false;
  return isCurrentHeadFailureTrailer(opts.markdown) || isLeftoverSimplificationTrailer(opts.markdown);
}

function persistInsertSkipReason(markdown: string | null | undefined): string | undefined {
  if (!markdown) return "incomplete";
  const parsed = parseReviewOutput(markdown);
  if (parsed.verdict.incomplete) return "incomplete";
  if (parsed.verdict.state === "failure") return undefined;
  if (parsed.verdict.state === "success") {
    if (trailerSuggestionCount(parsed.verdict.description) > 0) return undefined;
    return "success trailer";
  }
  return "incomplete";
}

function followUpJobFrom(
  owner: string,
  repo: string,
  issue: Pick<Task, "number" | "title" | "body" | "html_url" | "updated_at">,
  pr: Pull,
  repository: Pick<Repo, "default_branch" | "clone_url">,
  delivery: string,
  triggerEvent: "review-failure" | "review-suggestions"
): IssueJob {
  return {
    delivery,
    owner,
    repo,
    issueNumber: issue.number,
    action: triggerEvent,
    title: issue.title,
    body: issue.body ?? "",
    htmlUrl: issue.html_url,
    issueUpdatedAt: issue.updated_at,
    defaultBranch: repository.default_branch,
    cloneUrl: repository.clone_url,
    receivedAt: new Date().toISOString(),
    mode: "follow-up",
    prNumber: pr.number,
    headSha: pr.head.sha,
    trigger: { event: triggerEvent, sender: "jumi" },
  };
}

export async function enqueueFollowUpFromReview(
  opts: {
    store: ReviewJobStore;
    api: Pick<
      ReviewApi,
      "getPR" | "getIssue" | "getRepo" | "findStickyIssueComment" | "createIssueComment" | "updateIssueComment"
    >;
    row: ReviewJobRecord;
    published: ReviewResult;
    markdown?: string | null;
    maxFollowupRounds?: number;
    logger?: (message: string) => void;
  } & PickupPolicy
): Promise<EnqueueResult | undefined> {
  const logSkip = (reason: string): undefined => {
    opts.logger?.(`persist-insert skipped: ${reason}`);
    return undefined;
  };

  if (opts.published.status !== "posted" && opts.published.status !== "updated") return undefined;
  const trailerSkip = persistInsertSkipReason(opts.markdown);
  if (trailerSkip) return logSkip(trailerSkip);

  const pr = await opts.api.getPR(opts.row.owner, opts.row.repo, opts.row.prNumber);
  if (pr.head.sha !== opts.row.headSha) return logSkip("head moved");

  const closer = extractClosingIssueNumber(pr);
  const foreign =
    closer === undefined &&
    isAssignedForeignPR(pr, opts.row.owner, opts.row.repo, opts.botUsername, opts) &&
    !isJumiPrIdentity(pr, opts.botUsername);
  if (closer === undefined && !foreign) {
    await rememberSitBestEffort(
      opts.store.sits,
      opts.row.owner,
      opts.row.repo,
      opts.row.prNumber,
      "no closing issue",
      opts.logger
    );
    return logSkip("no closer");
  }

  const issueNumber = closer ?? pr.number;
  const [issue, repo] = await Promise.all([
    foreign ? Promise.resolve(pr) : opts.api.getIssue(opts.row.owner, opts.row.repo, issueNumber),
    opts.api.getRepo(opts.row.owner, opts.row.repo),
  ]);
  if (!foreign && (issue.state !== "open" || !isIssuePickedUp(issue, opts))) {
    return logSkip("unassigned");
  }

  const followUpSucceeded = await opts.store.countSucceeded("follow-up", opts.row.owner, opts.row.repo, issueNumber);
  if (followUpSucceeded >= (opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS)) {
    await upsertStuckText(
      opts.api,
      opts.row.owner,
      opts.row.repo,
      pr.number,
      opts.botUsername,
      TOO_MANY_FOLLOWUP_ROUNDS
    );
    return logSkip("round cap");
  }

  const triggerEvent = isLeftoverSimplificationTrailer(opts.markdown) ? "review-suggestions" : "review-failure";
  return opts.store.enqueueIssue(
    followUpJobFrom(opts.row.owner, opts.row.repo, issue, pr, repo, `${triggerEvent}-${opts.row.id}`, triggerEvent)
  );
}
