import { isIssuePickedUp, type PickupPolicy } from "./assignee.ts";
import type { Forge, Pull, Tracker } from "./ports.ts";
import { upsertStickyComment } from "./sticky_comment.ts";

export type { IssueApi, LinkedIssue, Tracker } from "./ports.ts";

export function workerMarker(owner: string, repo: string, issueNumber: number): string {
  return `<!-- jumi-worker:${owner}/${repo}#${issueNumber} -->`;
}

export function closesIssuePattern(issueNumber: number): RegExp {
  // Gitea DEFAULT_CLOSE_KEYWORDS: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved.
  return new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#${issueNumber}\b`, "i");
}

export function refsIssuePattern(issueNumber: number): RegExp {
  // Non-closing reference: `Refs #N` keeps the issue open after merge.
  return new RegExp(String.raw`\brefs?\s*:?\s*#${issueNumber}\b`, "i");
}

export const JUMI_ISSUE_BRANCH = /^jumi\/issue-(\d+)-/;

/** Default branch prefix for Jumi issue branches. */
export const DEFAULT_JUMI_BRANCH_PREFIX = "jumi";

function escapeBranchPrefix(prefix: string): string {
  return prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Branch pattern for one prefix: `<prefix>/issue-<N>-`. */
export function issueBranchPattern(prefix: string): RegExp {
  return new RegExp(`^${escapeBranchPrefix(prefix)}/issue-(\\d+)-`);
}

/**
 * Issue number from a branch ref. With no prefix (or `jumi`) only the
 * default `jumi/issue-<N>-` shape matches, preserving today's behavior. With
 * a custom prefix both `<prefix>/issue-<N>-` and the default shape match, so
 * PRs opened before a prefix change keep working.
 */
export function jumiIssueBranchNumber(ref: string | undefined, branchPrefix?: string): number | undefined {
  if (!ref) return undefined;
  const prefix = (branchPrefix ?? DEFAULT_JUMI_BRANCH_PREFIX).trim() || DEFAULT_JUMI_BRANCH_PREFIX;
  if (prefix !== DEFAULT_JUMI_BRANCH_PREFIX) {
    const custom = ref.match(issueBranchPattern(prefix));
    if (custom) return Number(custom[1]);
  }
  const match = ref.match(JUMI_ISSUE_BRANCH);
  if (!match) return undefined;
  return Number(match[1]);
}

export function pullRequestClosesIssue(
  pr: { title: string; body?: string | null; state?: string },
  issueNumber: number
): boolean {
  if (pr.state && pr.state !== "open") return false;
  const pattern = closesIssuePattern(issueNumber);
  return pattern.test(pr.title) || pattern.test(pr.body ?? "");
}

export function pullRequestRefsIssue(
  pr: { title: string; body?: string | null; state?: string },
  issueNumber: number
): boolean {
  if (pr.state && pr.state !== "open") return false;
  const pattern = refsIssuePattern(issueNumber);
  return pattern.test(pr.title) || pattern.test(pr.body ?? "");
}

/**
 * Whether a PR works on an issue through any signal: a closing keyword, a
 * non-closing `Refs #N` reference, or the issue branch. Used for dependency
 * blockers and queue candidates so `closing_keyword: refs` PRs are still
 * found after the body stops closing the issue.
 */
export function pullRequestWorkingOnIssue(
  pr: { title: string; body?: string | null; state?: string; head?: { ref?: string } },
  issueNumber: number,
  branchPrefix?: string
): boolean {
  if (pullRequestClosesIssue(pr, issueNumber)) return true;
  if (pullRequestRefsIssue(pr, issueNumber)) return true;
  return jumiIssueBranchNumber(pr.head?.ref, branchPrefix) === issueNumber;
}

export function extractRefsIssueNumber(pr: {
  title: string;
  body?: string | null;
  head?: { ref?: string };
}): number | undefined {
  const text = `${pr.title}\n${pr.body ?? ""}`;
  const pattern = /\brefs?\s*:?\s*#(\d+)\b/gi;
  const matches = [...text.matchAll(pattern)].map((match) => Number(match[1]));
  const fromRef = matches[0];
  if (fromRef === undefined || !Number.isFinite(fromRef)) return undefined;
  return fromRef;
}

export function extractClosingIssueNumbers(
  pr: {
    number?: number;
    title: string;
    body?: string | null;
    head?: { ref?: string };
  },
  branchPrefix?: string
): number[] {
  const text = `${pr.title}\n${pr.body ?? ""}`;
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi;
  const seen = new Set<number>();
  const result: number[] = [];

  const add = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    if (pr.number !== undefined && value === pr.number) return;
    if (seen.has(value)) return;
    seen.add(value);
    result.push(value);
  };

  for (const match of text.matchAll(pattern)) {
    add(Number(match[1]));
  }

  const fromBranch = jumiIssueBranchNumber(pr.head?.ref, branchPrefix);
  if (fromBranch !== undefined) add(fromBranch);

  return result;
}

export function extractClosingIssueNumber(
  pr: {
    title: string;
    body?: string | null;
    head?: { ref?: string };
  },
  branchPrefix?: string
): number | undefined {
  const text = `${pr.title}\n${pr.body ?? ""}`;
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi;
  const matches = [...text.matchAll(pattern)].map((match) => Number(match[1]));
  const fromBranch = jumiIssueBranchNumber(pr.head?.ref, branchPrefix);
  if (fromBranch !== undefined) {
    return matches.find((n) => n === fromBranch);
  }
  const fromClose = matches[0];
  if (fromClose === undefined || !Number.isFinite(fromClose)) return undefined;
  return fromClose;
}

export function extractWorkingIssueNumber(
  pr: {
    title: string;
    body?: string | null;
    head?: { ref?: string };
  },
  branchPrefix?: string
): number | undefined {
  // Which issue this PR works on, independent of whether merging closes it.
  // A `<prefix>/issue-N-` branch always means N, even when the body says
  // `Refs #N` or names no issue at all. Otherwise fall back to the closer,
  // then to a non-closing `Refs #N` reference so `closing_keyword: refs`
  // PRs are still mapped.
  const fromBranch = jumiIssueBranchNumber(pr.head?.ref, branchPrefix);
  if (fromBranch !== undefined) return fromBranch;
  const fromClose = extractClosingIssueNumber(pr, branchPrefix);
  if (fromClose !== undefined) return fromClose;
  return extractRefsIssueNumber(pr);
}

function loginEquals(login: string | undefined, botUsername: string): boolean {
  return typeof login === "string" && login.toLowerCase() === botUsername.toLowerCase();
}

export function isJumiPrIdentity(
  pr: { user?: { login?: string }; head?: { ref?: string } },
  botUsername: string,
  branchPrefix?: string
): boolean {
  if (loginEquals(pr.user?.login, botUsername)) return true;
  return jumiIssueBranchNumber(pr.head?.ref, branchPrefix) !== undefined;
}

export function isWipOrDraft(pr: { title: string; draft?: boolean }): boolean {
  if (pr.draft === true) return true;
  return pr.title.trim().toLowerCase().startsWith("wip:");
}

export function isEligibleWorkerPR(pr: Pull, owner: string, repo: string): boolean {
  if (pr.state !== "open" || pr.merged) return false;
  if (isWipOrDraft(pr)) return false;
  if (!pr.head?.repo || pr.head.repo.full_name !== `${owner}/${repo}`) return false;
  return true;
}

export function isInScopeJumiPR(
  pr: Pull,
  owner: string,
  repo: string,
  botUsername: string,
  branchPrefix?: string
): boolean {
  if (!isEligibleWorkerPR(pr, owner, repo)) return false;
  if (!isJumiPrIdentity(pr, botUsername, branchPrefix)) return false;
  return extractWorkingIssueNumber(pr, branchPrefix) !== undefined;
}

export function isForeignPrIdentity(
  pr: {
    title: string;
    body?: string | null;
    draft?: boolean;
    user?: { login?: string };
    head?: { ref?: string; repo?: { full_name: string } | null };
  },
  owner: string,
  repo: string,
  botUsername: string,
  branchPrefix?: string
): boolean {
  if (isWipOrDraft(pr)) return false;
  if (!pr.head?.repo || pr.head.repo.full_name !== `${owner}/${repo}`) return false;
  if (isJumiPrIdentity(pr, botUsername, branchPrefix) && extractWorkingIssueNumber(pr, branchPrefix) !== undefined)
    return false;
  return true;
}

export function isAssignedForeignPR(
  pr: Pull,
  owner: string,
  repo: string,
  botUsername: string,
  policy?: PickupPolicy,
  branchPrefix?: string
): boolean {
  if (!isEligibleWorkerPR(pr, owner, repo)) return false;
  if (!isForeignPrIdentity(pr, owner, repo, botUsername, branchPrefix)) return false;
  return isIssuePickedUp(pr, policy ?? { botUsername });
}

export async function findOpenClosingPullRequest(
  api: Pick<Forge, "listOpenPulls">,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername?: string,
  branchPrefix?: string
): Promise<Pull | undefined> {
  const pulls = await api.listOpenPulls(owner, repo);
  return pulls.find((pr) => {
    if (!pullRequestClosesIssue(pr, issueNumber)) return false;
    if (botUsername && !isJumiPrIdentity(pr, botUsername, branchPrefix)) return false;
    return true;
  });
}

export async function findOpenJumiClosingPullRequest(
  api: Pick<Forge, "listOpenPulls">,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername: string,
  branchPrefix?: string
): Promise<Pull | undefined> {
  const pulls = await api.listOpenPulls(owner, repo);
  return pulls.find(
    (pr) =>
      isInScopeJumiPR(pr, owner, repo, botUsername, branchPrefix) &&
      extractWorkingIssueNumber(pr, branchPrefix) === issueNumber
  );
}

export async function resolveWorkerPullRequest(
  api: Pick<Forge, "listOpenPulls">,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername: string,
  prNumber?: number,
  branchPrefix?: string
): Promise<Pull | undefined> {
  const pulls = await api.listOpenPulls(owner, repo);
  if (prNumber !== undefined) {
    const byNumber = pulls.find((pr) => pr.number === prNumber);
    if (byNumber) return byNumber;
  }
  return pulls.find(
    (pr) =>
      isInScopeJumiPR(pr, owner, repo, botUsername, branchPrefix) &&
      extractWorkingIssueNumber(pr, branchPrefix) === issueNumber
  );
}

export async function upsertWorkerComment(
  api: Pick<Tracker, "findStickyIssueComment" | "createIssueComment" | "updateIssueComment">,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername: string,
  body: string,
  opts?: { index?: number }
): Promise<void> {
  const marker = workerMarker(owner, repo, issueNumber);
  const index = opts?.index ?? issueNumber;
  await upsertStickyComment(api, owner, repo, index, botUsername, marker, body);
}
