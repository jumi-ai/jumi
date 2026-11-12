import { upsertWorkerComment } from "./gitea_issues.ts";
import type { IssueApi, Task } from "./ports.ts";
import type { IssueJob } from "./types.ts";

export const ISSUE_CLOSED_NO_PR_COMMENT = "Not opening a PR because the issue was closed.";
export const ISSUE_CLOSED_CLOSER_COMMENT = "Closing this PR because the issue was closed.";
export const ISSUE_CHANGED_AGAIN_COMMENT =
  "Jumi skipped shipping: issue title or body changed again after a continue round.";

export type RecheckApi = Pick<
  IssueApi,
  "getIssue" | "closePullRequest" | "findStickyIssueComment" | "createIssueComment" | "updateIssueComment"
>;

export interface IssueSnapshot {
  title: string;
  body: string;
}

export type ShipGate =
  | { action: "ship"; snapshot: IssueSnapshot; issue: Task; continued: boolean }
  | { action: "skip"; reason: string; keepLocalWork: boolean };

export function snapshotFromIssue(issue: { title: string; body: string | null | undefined }): IssueSnapshot {
  return { title: issue.title, body: issue.body ?? "" };
}

export function snapshotFromJob(job: { title: string; body: string }): IssueSnapshot {
  return { title: job.title, body: job.body };
}

export function issueTextChanged(
  snapshot: IssueSnapshot,
  live: { title: string; body: string | null | undefined }
): boolean {
  return snapshot.title !== live.title || snapshot.body !== (live.body ?? "");
}

export function jobWithIssue(
  job: IssueJob,
  issue: { title: string; body: string | null | undefined; html_url: string; user?: { login?: string } | null }
): IssueJob {
  const next: IssueJob = { ...job, title: issue.title, body: issue.body ?? "", htmlUrl: issue.html_url };
  if (typeof issue.user?.login === "string" && issue.user.login.trim()) next.issueAuthor = issue.user.login.trim();
  return next;
}

export function skipRecheckComment(reason: string): string {
  return `Jumi skipped shipping: failed to re-check issue: ${reason}`;
}

async function sticky(
  api: RecheckApi,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername: string,
  body: string,
  closerPrNumber?: number
): Promise<void> {
  await upsertWorkerComment(api, owner, repo, issueNumber, botUsername, body, {
    index: closerPrNumber ?? issueNumber,
  });
}

export async function abandonShipBecauseIssueClosed(opts: {
  api: RecheckApi;
  owner: string;
  repo: string;
  issueNumber: number;
  botUsername: string;
  closerPrNumber?: number;
}): Promise<{ status: "skipped"; reason: "issue is closed" }> {
  if (opts.closerPrNumber !== undefined) {
    await opts.api.closePullRequest(opts.owner, opts.repo, opts.closerPrNumber);
    await sticky(
      opts.api,
      opts.owner,
      opts.repo,
      opts.issueNumber,
      opts.botUsername,
      ISSUE_CLOSED_CLOSER_COMMENT,
      opts.closerPrNumber
    );
  } else {
    await sticky(opts.api, opts.owner, opts.repo, opts.issueNumber, opts.botUsername, ISSUE_CLOSED_NO_PR_COMMENT);
  }
  return { status: "skipped", reason: "issue is closed" };
}

export async function gateShipAfterOpenCode(opts: {
  api: RecheckApi;
  owner: string;
  repo: string;
  issueNumber: number;
  botUsername: string;
  snapshot: IssueSnapshot;
  closerPrNumber?: number;
  continueOpenCode: (issue: Task) => Promise<void>;
}): Promise<ShipGate> {
  let snapshot = opts.snapshot;
  let continued = false;
  for (;;) {
    let issue: Task;
    try {
      issue = await opts.api.getIssue(opts.owner, opts.repo, opts.issueNumber);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await sticky(
        opts.api,
        opts.owner,
        opts.repo,
        opts.issueNumber,
        opts.botUsername,
        skipRecheckComment(reason),
        opts.closerPrNumber
      ).catch(() => undefined);
      return { action: "skip", reason: `failed to re-check issue: ${reason}`, keepLocalWork: true };
    }
    if (issue.state === "closed") {
      await abandonShipBecauseIssueClosed({
        api: opts.api,
        owner: opts.owner,
        repo: opts.repo,
        issueNumber: opts.issueNumber,
        botUsername: opts.botUsername,
        closerPrNumber: opts.closerPrNumber,
      });
      return { action: "skip", reason: "issue is closed", keepLocalWork: opts.closerPrNumber === undefined };
    }
    if (!issueTextChanged(snapshot, issue)) {
      return { action: "ship", snapshot, issue, continued };
    }
    if (continued) {
      await sticky(
        opts.api,
        opts.owner,
        opts.repo,
        opts.issueNumber,
        opts.botUsername,
        ISSUE_CHANGED_AGAIN_COMMENT,
        opts.closerPrNumber
      );
      return {
        action: "skip",
        reason: "issue title or body changed again after a continue round",
        keepLocalWork: true,
      };
    }
    continued = true;
    snapshot = snapshotFromIssue(issue);
    await opts.continueOpenCode(issue);
  }
}
