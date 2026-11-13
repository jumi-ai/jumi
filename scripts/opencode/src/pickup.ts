import { needsCiFollowUp } from "./ci.ts";
import { type ConflictResult, implementConflict, needsConflict } from "./conflict.ts";
import { type FollowUpResult, implementFollowUp, needsFollowUp } from "./followup.ts";
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
  return isInScopeJumiPR(pr, owner, repo, botUsername) && extractWorkingIssueNumber(pr) === issueNumber;
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
  let ignoreAuthors = opts.ignoreConflictsAuthors;
  if (ignoreAuthors === undefined) {
    const branch =
      opts.defaultBranch ??
      (await opts.api
        .getRepo(opts.owner, opts.repo)
        .then((r) => r.default_branch)
        .catch(() => undefined));
    ignoreAuthors = await loadIgnoreConflictsAuthors(opts.api, opts.owner, opts.repo, branch);
    if (ignoreAuthors === undefined) return undefined;
  }
  const followUp = await needsFollowUp({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    pr: opts.pr,
    issueNumber: opts.issueNumber,
    botUsername: opts.botUsername,
    home: opts.home,
    maxFollowupRounds: opts.maxFollowupRounds,
    maxConflictRounds: opts.maxConflictRounds,
    followupIgnoreLogins: opts.followupIgnoreLogins,
    trustedSenderLogins: opts.trustedSenderLogins,
    blockingQuestionAuthors: opts.blockingQuestionAuthors,
    skipLatches: opts.skipLatches,
    ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
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
  const authorListed = isIgnoreConflictsAuthor(opts.pr.user?.login, ignoreAuthors);
  let hasJumiCommit: boolean | undefined;
  if (!followUp && !ci && (hasIgnoreConflictsLabel(opts.pr, opts.ignoreConflictsLabel) || authorListed)) {
    hasJumiCommit = await hasJumiCommitOnPull(opts.api, opts.owner, opts.repo, opts.pr.number, {
      botUsername: opts.botUsername,
    });
  }
  const conflict = await needsConflict({
    pr: opts.pr,
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: opts.issueNumber,
    botUsername: opts.botUsername,
    home: opts.home,
    maxConflictRounds: opts.maxConflictRounds,
    maxFollowupRounds: opts.maxFollowupRounds,
    skipLatches: opts.skipLatches,
    ignoreConflictsLabel: opts.ignoreConflictsLabel,
    ignoreConflictsAuthors: ignoreAuthors,
    ...(hasJumiCommit !== undefined ? { hasJumiCommit } : {}),
    ...(opts.defaultBranch
      ? {
          defaultBranch: opts.defaultBranch,
          ...(typeof (opts.api as { getRepoFile?: unknown }).getRepoFile === "function"
            ? {
                getRepoFile: (
                  opts.api as {
                    getRepoFile: (
                      owner: string,
                      repo: string,
                      path: string,
                      ref: string
                    ) => Promise<{ found: boolean; content?: string }>;
                  }
                ).getRepoFile.bind(opts.api),
              }
            : {}),
        }
      : {}),
  });
  if (conflict && !(followUp || ci)) return "conflict";
  if (followUp || ci || conflict) return "follow-up";
  return undefined;
}

export async function runCloserWork(
  opts: ImplementOptions,
  pr: Pull
): Promise<FollowUpResult | ConflictResult | { status: "skipped"; reason: string }> {
  const branch = opts.job.defaultBranch;
  const ignoreAuthors = await loadIgnoreConflictsAuthors(opts.api, opts.job.owner, opts.job.repo, branch);
  if (ignoreAuthors === undefined) {
    return { status: "skipped", reason: IGNORE_CONFLICTS_SETTINGS_UNREADABLE };
  }
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
    blockingQuestionAuthors: opts.blockingQuestionAuthors,
    skipLatches: opts.skipLatches,
    ignoreConflictsLabel: opts.ignoreConflictsLabel,
    ignoreConflictsAuthors: ignoreAuthors,
    defaultBranch: branch,
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
    logger?.(`mergeable lookup failed: ${err instanceof Error ? err.message : String(err)}`);
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
  const labeled = opts?.botUsername ? hasIgnoreConflictsLabel(pr, opts.ignoreConflictsLabel) : false;
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
