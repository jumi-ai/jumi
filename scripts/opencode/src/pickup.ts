import { needsCiFollowUp } from "./ci.ts";
import { type ConflictResult, implementConflict, needsConflict } from "./conflict.ts";
import { type FollowUpResult, implementFollowUp, needsFollowUp } from "./followup.ts";
import { extractClosingIssueNumber, isInScopeJumiPR } from "./gitea_issues.ts";
import type { ImplementOptions } from "./implement.ts";
import type { Forge, IssueApi, Pull } from "./ports.ts";
import type { SkipLatchStore } from "./skip_latches.ts";
import type { IssueJob } from "./types.ts";

export type CloserWorkMode = "follow-up" | "conflict";

export function isJumiCloserForIssue(
  pr: Pull,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername: string
): boolean {
  return isInScopeJumiPR(pr, owner, repo, botUsername) && extractClosingIssueNumber(pr) === issueNumber;
}

export async function classifyCloserWork(opts: {
  api: IssueApi;
  owner: string;
  repo: string;
  pr: Pull;
  issueNumber: number;
  botUsername: string;
  home: string;
  maxFollowupRounds?: number;
  maxConflictRounds?: number;
  followupIgnoreLogins?: readonly string[];
  trustedSenderLogins?: readonly string[];
  skipLatches?: SkipLatchStore;
}): Promise<CloserWorkMode | undefined> {
  const followUp = await needsFollowUp({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    pr: opts.pr,
    issueNumber: opts.issueNumber,
    botUsername: opts.botUsername,
    home: opts.home,
    maxFollowupRounds: opts.maxFollowupRounds,
    followupIgnoreLogins: opts.followupIgnoreLogins,
    trustedSenderLogins: opts.trustedSenderLogins,
    skipLatches: opts.skipLatches,
  });
  const ci = await needsCiFollowUp({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    sha: opts.pr.head.sha,
    home: opts.home,
    issueNumber: opts.issueNumber,
    skipLatches: opts.skipLatches,
  });
  const conflict = await needsConflict({
    pr: opts.pr,
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: opts.issueNumber,
    botUsername: opts.botUsername,
    home: opts.home,
    maxConflictRounds: opts.maxConflictRounds,
    skipLatches: opts.skipLatches,
  });
  if (conflict && !(followUp || ci)) return "conflict";
  if (followUp || ci || conflict) return "follow-up";
  return undefined;
}

export async function runCloserWork(
  opts: ImplementOptions,
  pr: Pull
): Promise<FollowUpResult | ConflictResult | { status: "skipped"; reason: string }> {
  const mode = await classifyCloserWork({
    api: opts.api,
    owner: opts.job.owner,
    repo: opts.job.repo,
    pr,
    issueNumber: opts.job.issueNumber,
    botUsername: opts.botUsername,
    home: opts.home,
    maxFollowupRounds: opts.maxFollowupRounds,
    maxConflictRounds: opts.maxConflictRounds,
    followupIgnoreLogins: opts.followupIgnoreLogins,
    trustedSenderLogins: opts.trustedSenderLogins,
    skipLatches: opts.skipLatches,
  });
  if (!mode) return { status: "skipped", reason: `open PR already closes #${opts.job.issueNumber}` };
  const job: IssueJob = {
    ...opts.job,
    mode,
    prNumber: pr.number,
    headSha: pr.head.sha,
    trigger: opts.job.trigger ?? { event: "assigned", sender: "assign" },
  };
  const next = { ...opts, job };
  return mode === "conflict"
    ? implementConflict({ ...next, timeoutMs: opts.conflictTimeoutMs })
    : implementFollowUp({ ...next, timeoutMs: opts.followupTimeoutMs });
}

export async function conflictJobIfUnmergeable(
  api: Pick<Forge, "getPR">,
  job: IssueJob,
  prNumber: number,
  logger?: (message: string) => void
): Promise<IssueJob | undefined> {
  let pr: Pull;
  try {
    pr = await api.getPR(job.owner, job.repo, prNumber);
  } catch (err) {
    logger?.(`mergeable lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (pr.mergeable !== false) return undefined;
  return {
    ...job,
    mode: "conflict",
    prNumber: pr.number,
    headSha: pr.head.sha,
  };
}

export function pushedPrNumber(result: { status: string; prNumber?: number }): number | undefined {
  if (result.status !== "pr" && result.status !== "pushed") return undefined;
  return typeof result.prNumber === "number" ? result.prNumber : undefined;
}
