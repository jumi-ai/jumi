import { hasLabel } from "./assignee.ts";
import { forgeCommitterEmail, forgeCommitterName } from "./forge.ts";
import { isListedLogin } from "./permissions.ts";
import type { PullCommit } from "./ports.ts";

export const DEFAULT_IGNORE_CONFLICTS_LABEL = "ignore-conflicts";

/** Skip reason when the settings file cannot be read: fail closed, deny the merge. */
export const IGNORE_CONFLICTS_SETTINGS_UNREADABLE = "ignore-conflicts settings unreadable";

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

export function isIgnoreConflictsAuthor(
  login: string | undefined | null,
  authors: readonly string[] | undefined | null
): boolean {
  return isListedLogin(login, authors ?? undefined);
}

export function leaveConflictsAuthorReason(authorLogin: string | undefined | null): string {
  const who = typeof authorLogin === "string" && authorLogin.trim() ? authorLogin.trim() : "listed author";
  return `conflicted, left to author (author \`${who}\`)`;
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
  const names = [forgeCommitterName(), expectation.botUsername, ...(expectation.extraNames ?? [])];
  return names.filter((name): name is string => typeof name === "string" && name.trim() !== "");
}

function expectedEmails(expectation: JumiCommitExpectation): string[] {
  const emails = [forgeCommitterEmail(), ...(expectation.extraEmails ?? [])];
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
  api:
    | {
        listPullCommits?: (owner: string, repo: string, index: number) => Promise<PullCommit[]>;
        getRepoFile?: (
          owner: string,
          repo: string,
          path: string,
          ref: string
        ) => Promise<{ found: boolean; content?: string }>;
      }
    | undefined,
  owner: string,
  repo: string,
  pr: {
    number: number;
    labels?: Array<string | { name?: string }> | null;
    user?: { login?: string } | null;
  },
  opts: {
    botUsername: string;
    ignoreConflictsLabel?: string;
    extraNames?: readonly (string | undefined)[];
    extraEmails?: readonly (string | undefined)[];
    /** Pre-loaded `ignore_conflicts_authors` list. When absent and `defaultBranch` is given, loaded best-effort. */
    ignoreConflictsAuthors?: readonly string[] | undefined;
    /** Author login override; defaults to `pr.user.login`. */
    prAuthor?: string | undefined | null;
    /** Default branch to load the settings file from when `ignoreConflictsAuthors` is absent. */
    defaultBranch?: string | undefined | null;
  },
  logger?: (message: string) => void
): Promise<boolean> {
  const labeled = hasIgnoreConflictsLabel(pr, opts.ignoreConflictsLabel);
  let authors = opts.ignoreConflictsAuthors;
  if (authors === undefined && typeof opts.defaultBranch === "string" && opts.defaultBranch.trim()) {
    authors = await loadIgnoreConflictsAuthors(api, owner, repo, opts.defaultBranch, logger);
    if (authors === undefined) return true;
  }
  const authorLogin = opts.prAuthor ?? pr.user?.login;
  const authorListed = isIgnoreConflictsAuthor(authorLogin, authors);
  if (!labeled && !authorListed) return false;
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
    if (!api?.listPullCommits) {
      logger?.(
        `ignore-conflicts lookup unavailable for ${owner}/${repo}#${pr.number}: no listPullCommits; leaving to author`
      );
      return true;
    }
    return false;
  }
  return !committed;
}

/**
 * Best-effort load of the `ignore_conflicts_authors` list from the
 * default-branch settings file. Missing, invalid, or file-API-less resolves to
 * an empty list (no leave): an invalid file never leaves conflicts to anyone.
 * A read that fails for another reason resolves to `undefined` so callers can
 * fail closed (deny the merge) instead of treating the error as not-listed.
 */
export async function loadIgnoreConflictsAuthors(
  api:
    | {
        getRepoFile?: (
          owner: string,
          repo: string,
          path: string,
          ref: string
        ) => Promise<{ found: boolean; content?: string }>;
      }
    | undefined,
  owner: string,
  repo: string,
  defaultBranch: string | undefined | null,
  logger?: (message: string) => void
): Promise<string[] | undefined> {
  try {
    if (!api || typeof api.getRepoFile !== "function") return [];
    if (typeof defaultBranch !== "string" || !defaultBranch.trim()) return [];
    const { loadRepoSettings } = await import("./repo_settings.ts");
    const loaded = await loadRepoSettings(api, owner, repo, defaultBranch.trim());
    if (loaded.state !== "valid") return [];
    return [...(loaded.ignoreConflictsAuthors ?? [])];
  } catch (err) {
    logger?.(
      `ignore-conflicts authors unreadable for ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}
