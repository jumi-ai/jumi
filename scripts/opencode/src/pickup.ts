import { type ConflictResult, implementConflict } from "./conflict.ts";
import { type FollowUpResult, implementFollowUp } from "./followup.ts";
import { extractWorkingIssueNumber, isInScopeJumiPR } from "./gitea_issues.ts";
import {
  hasIgnoreConflictsLabel,
  hasJumiCommitOnPull,
  IGNORE_CONFLICTS_SETTINGS_UNREADABLE,
  isIgnoreConflictsAuthor,
  loadIgnoreConflictsAuthors,
} from "./ignore_conflicts.ts";
import type { ImplementOptions } from "./implement.ts";
import type { Forge, IssueApi, Pull } from "./ports.ts";
import { classify } from "./pr_decision.ts";
import { buildCloserSnapshot } from "./pr_snapshot.ts";
import type { SkipLatchStore } from "./skip_latches.ts";
import type { IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";

export type CloserWorkMode = "follow-up" | "conflict";

export function isJumiCloserForIssue(
  pr: Pull,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername: string,
  branchPrefix?: string
): boolean {
  return (
    isInScopeJumiPR(pr, owner, repo, botUsername, branchPrefix) &&
    extractWorkingIssueNumber(pr, branchPrefix) === issueNumber
  );
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
  blockingQuestionAuthors?: readonly string[];
  skipLatches?: SkipLatchStore;
  ignoreConflictsLabel?: string;
  ignoreConflictsAuthors?: readonly string[];
  /** Default-branch name for the per-repository `.jumi.yml` policy. */
  defaultBranch?: string;
}): Promise<CloserWorkMode | undefined> {
  const built = await buildCloserSnapshot(
    {
      owner: opts.owner,
      repo: opts.repo,
      pr: opts.pr,
      issueNumber: opts.issueNumber,
      botUsername: opts.botUsername,
      home: opts.home,
      ...(opts.maxFollowupRounds !== undefined ? { maxFollowupRounds: opts.maxFollowupRounds } : {}),
      ...(opts.maxConflictRounds !== undefined ? { maxConflictRounds: opts.maxConflictRounds } : {}),
      ...(opts.followupIgnoreLogins !== undefined ? { followupIgnoreLogins: opts.followupIgnoreLogins } : {}),
      ...(opts.trustedSenderLogins !== undefined ? { trustedSenderLogins: opts.trustedSenderLogins } : {}),
      ...(opts.blockingQuestionAuthors !== undefined ? { blockingQuestionAuthors: opts.blockingQuestionAuthors } : {}),
      ...(opts.skipLatches !== undefined ? { skipLatches: opts.skipLatches } : {}),
      ...(opts.ignoreConflictsLabel !== undefined ? { ignoreConflictsLabel: opts.ignoreConflictsLabel } : {}),
      ...(opts.ignoreConflictsAuthors !== undefined ? { ignoreConflictsAuthors: opts.ignoreConflictsAuthors } : {}),
      ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
    },
    { api: opts.api }
  );
  if (built.ignoreAuthorsUnreadable) return undefined;
  return classify(built.snapshot).mode;
}

export async function runCloserWork(
  opts: ImplementOptions,
  pr: Pull
): Promise<FollowUpResult | ConflictResult | { status: "skipped"; reason: string }> {
  const branch = opts.job.defaultBranch;
  const built = await buildCloserSnapshot(
    {
      owner: opts.job.owner,
      repo: opts.job.repo,
      pr,
      issueNumber: opts.job.issueNumber,
      botUsername: opts.botUsername,
      home: opts.home,
      ...(opts.maxFollowupRounds !== undefined ? { maxFollowupRounds: opts.maxFollowupRounds } : {}),
      ...(opts.maxConflictRounds !== undefined ? { maxConflictRounds: opts.maxConflictRounds } : {}),
      ...(opts.followupIgnoreLogins !== undefined ? { followupIgnoreLogins: opts.followupIgnoreLogins } : {}),
      ...(opts.trustedSenderLogins !== undefined ? { trustedSenderLogins: opts.trustedSenderLogins } : {}),
      ...(opts.blockingQuestionAuthors !== undefined ? { blockingQuestionAuthors: opts.blockingQuestionAuthors } : {}),
      ...(opts.skipLatches !== undefined ? { skipLatches: opts.skipLatches } : {}),
      ...(opts.ignoreConflictsLabel !== undefined ? { ignoreConflictsLabel: opts.ignoreConflictsLabel } : {}),
      ...(branch ? { defaultBranch: branch } : {}),
    },
    { api: opts.api }
  );
  if (built.ignoreAuthorsUnreadable) {
    return { status: "skipped", reason: IGNORE_CONFLICTS_SETTINGS_UNREADABLE };
  }
  const mode = classify(built.snapshot).mode;
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
  api: Pick<Forge, "getPR"> & Partial<Pick<Forge, "listPullCommits" | "getRepoFile">>,
  job: IssueJob,
  prNumber: number,
  logger?: (message: string) => void,
  opts?: {
    botUsername?: string;
    ignoreConflictsLabel?: string;
    ignoreConflictsAuthors?: readonly string[];
  }
): Promise<IssueJob | undefined> {
  let pr: Pull;
  try {
    pr = await api.getPR(job.owner, job.repo, prNumber);
  } catch (err) {
    logger?.(`mergeable lookup failed: ${errorMessage(err)}`);
    return undefined;
  }
  // A merged or closed pull needs no conflict work: follow-up already ends
  // quietly on "no open jumi closing PR".
  if (pr.merged || pr.state !== "open") return undefined;
  if (pr.mergeable !== false) return undefined;
  let authors = opts?.ignoreConflictsAuthors;
  if (authors === undefined) {
    authors = await loadIgnoreConflictsAuthors(api, job.owner, job.repo, job.defaultBranch, logger);
    if (authors === undefined) return undefined;
  }
  let effectiveIgnoreLabel = opts?.ignoreConflictsLabel;
  try {
    if (job.defaultBranch?.trim() && typeof (api as { getRepoFile?: unknown }).getRepoFile === "function") {
      const { fallbackPolicyDeployment, resolveRepoPolicy } = await import("./repo_policy.ts");
      const policy = await resolveRepoPolicy(
        { api, owner: job.owner, repo: job.repo, ref: job.defaultBranch.trim() },
        fallbackPolicyDeployment({ ignoreConflictsLabel: opts?.ignoreConflictsLabel }),
        { onUnreadable: "fallback" }
      ).catch(() => undefined);
      if (policy !== undefined) effectiveIgnoreLabel = policy.ignoreConflictsLabel;
    }
  } catch {
    // Fail-open to the deployment value.
  }
  const labeled = opts?.botUsername ? hasIgnoreConflictsLabel(pr, effectiveIgnoreLabel) : false;
  if (opts?.botUsername && (labeled || isIgnoreConflictsAuthor(pr.user?.login, authors))) {
    const committed = await hasJumiCommitOnPull(
      api,
      job.owner,
      job.repo,
      pr.number,
      { botUsername: opts.botUsername },
      logger
    );
    if (committed === false) return undefined;
    if (committed === undefined && !api.listPullCommits) return undefined;
  }
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
