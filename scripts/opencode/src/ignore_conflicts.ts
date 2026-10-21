import { hasLabel } from "./assignee.ts";
import { FORGE_COMMITTER_EMAIL, FORGE_COMMITTER_NAME } from "./forge.ts";
import type { PullCommit } from "./ports.ts";

export const DEFAULT_IGNORE_CONFLICTS_LABEL = "ignore-conflicts";

export function normalizeIgnoreConflictsLabel(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : DEFAULT_IGNORE_CONFLICTS_LABEL;
}

export function hasIgnoreConflictsLabel(
  pr: { labels?: Array<string | { name?: string }> | null },
  labelName: string | undefined | null
): boolean {
  return hasLabel(pr, normalizeIgnoreConflictsLabel(labelName ?? undefined));
}

export function ignoreConflictsReason(labelName: string | undefined | null): string {
  const label = normalizeIgnoreConflictsLabel(labelName ?? undefined);
  return `conflicted, left to author (label \`${label}\`)`;
}

export function isIgnoreConflictsSkipReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.trim().toLowerCase().startsWith("conflicted, left to author");
}

function equalsLower(left: string | undefined, right: string): boolean {
  if (!left) return false;
  return left.toLowerCase() === right.toLowerCase();
}

export interface JumiCommitExpectation {
  botUsername: string;
  extraNames?: readonly (string | undefined)[];
  extraEmails?: readonly (string | undefined)[];
}

function expectedNames(expectation: JumiCommitExpectation): string[] {
  const names = [FORGE_COMMITTER_NAME, expectation.botUsername, ...(expectation.extraNames ?? [])];
  return names.filter((name): name is string => typeof name === "string" && name.trim() !== "");
}

function expectedEmails(expectation: JumiCommitExpectation): string[] {
  const emails = [FORGE_COMMITTER_EMAIL, ...(expectation.extraEmails ?? [])];
  return emails.filter((email): email is string => typeof email === "string" && email.trim() !== "");
}

export function isJumiCommitIdentity(
  identity: { name?: string; email?: string; login?: string } | undefined,
  expectation: JumiCommitExpectation
): boolean {
  if (!identity) return false;
  const bot = expectation.botUsername.toLowerCase();
  if (identity.login && identity.login.toLowerCase() === bot) return true;
  for (const name of expectedNames(expectation)) {
    if (equalsLower(identity.name, name)) return true;
    if (equalsLower(identity.login, name)) return true;
  }
  for (const email of expectedEmails(expectation)) {
    if (equalsLower(identity.email, email)) return true;
  }
  return false;
}

export function isJumiCommit(commit: PullCommit, expectation: JumiCommitExpectation): boolean {
  return isJumiCommitIdentity(commit.author, expectation) || isJumiCommitIdentity(commit.committer, expectation);
}

export function hasJumiCommit(
  commits: readonly PullCommit[] | undefined | null,
  expectation: JumiCommitExpectation
): boolean {
  if (!commits) return false;
  return commits.some((commit) => isJumiCommit(commit, expectation));
}

export async function hasJumiCommitOnPull(
  api: { listPullCommits?: (owner: string, repo: string, index: number) => Promise<PullCommit[]> } | undefined,
  owner: string,
  repo: string,
  prNumber: number,
  expectation: JumiCommitExpectation,
  logger?: (message: string) => void
): Promise<boolean | undefined> {
  if (!api?.listPullCommits) return undefined;
  try {
    const commits = await api.listPullCommits(owner, repo, prNumber);
    return hasJumiCommit(commits, expectation);
  } catch (err) {
    logger?.(
      `ignore-conflicts lookup failed for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

export async function isLeftToAuthor(
  api: { listPullCommits?: (owner: string, repo: string, index: number) => Promise<PullCommit[]> } | undefined,
  owner: string,
  repo: string,
  pr: { number: number; labels?: Array<string | { name?: string }> | null },
  opts: {
    botUsername: string;
    ignoreConflictsLabel?: string;
    extraNames?: readonly (string | undefined)[];
    extraEmails?: readonly (string | undefined)[];
  },
  logger?: (message: string) => void
): Promise<boolean> {
  if (!hasIgnoreConflictsLabel(pr, opts.ignoreConflictsLabel)) return false;
  const committed = await hasJumiCommitOnPull(
    api,
    owner,
    repo,
    pr.number,
    { botUsername: opts.botUsername, extraNames: opts.extraNames, extraEmails: opts.extraEmails },
    logger
  );
  if (committed === undefined) {
    // Without commit history we cannot prove Jumi stayed out: fail open to
    // resolving, except when the caller has no commit API at all (push and
    // older test doubles), where leaving to the author avoids wasted work.
    return !api?.listPullCommits;
  }
  return !committed;
}
