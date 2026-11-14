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

const REFS_PHRASES = "refs?|part of|progress towards?|related to";

export function refsIssuePattern(issueNumber: number): RegExp {
  // Non-closing reference: `Refs #N` (and common equivalents like
  // `Part of #N`) keeps the issue open after merge.
  return new RegExp(String.raw`\b(?:${REFS_PHRASES})\s*:?\s*#${issueNumber}\b`, "i");
}

/**
 * Ranges of PR text GitHub never treats as a close directive: fenced code
 * blocks (``` / ~~~), inline code spans (`...`), and quoted lines (`>` or
 * HTML-escaped `&gt;`). Closing keywords only count in the remaining visible
 * text, so Jumi's idea of "this PR closes N" matches the forge on merge.
 */
function closingIgnoredRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const add = (start: number, end: number) => {
    if (end > start) ranges.push({ start, end });
  };
  const overlaps = (start: number, end: number): boolean =>
    ranges.some((range) => start < range.end && end > range.start);
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)/g)) {
    const start = match.index ?? 0;
    add(start, start + match[0].length);
  }
  for (const match of text.matchAll(/~~~[\s\S]*?(?:~~~|$)/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!overlaps(start, end)) add(start, end);
  }
  // Quoted lines: `>` or `&gt;` after optional whitespace. Checked before
  // inline spans so a backtick inside a quote stays ignored as a quote.
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(">") || trimmed.toLowerCase().startsWith("&gt;")) {
      add(offset, offset + line.length);
    }
    offset += line.length + 1;
  }
  for (const match of text.matchAll(/`+[^`\n]*?`+/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!overlaps(start, end)) add(start, end);
  }
  return ranges;
}

function isIgnoredAt(ranges: Array<{ start: number; end: number }>, index: number, length: number): boolean {
  const end = index + length;
  return ranges.some((range) => index < range.end && end > range.start);
}

/**
 * PR text with forge-ignored ranges blanked (newlines preserved), so a
 * closing-keyword regex only sees what the forge would act on. Exported for
 * the PR-body builder, which must rewrite only visible references.
 */
export function visibleClosingText(text: string): string {
  const ranges = closingIgnoredRanges(text);
  if (ranges.length === 0) return text;
  const chars = [...text];
  for (const range of ranges) {
    for (let i = range.start; i < range.end && i < chars.length; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

/** Whether `index` (a regex match start) sits in visible closing text. */
export function isVisibleClosingMatch(text: string, index: number, length: number): boolean {
  return !isIgnoredAt(closingIgnoredRanges(text), index, length);
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
  // Titles and bodies only close when the keyword is visible: code spans,
  // fenced blocks, and quotes never close on the forge.
  return pattern.test(visibleClosingText(pr.title)) || pattern.test(visibleClosingText(pr.body ?? ""));
}

export function pullRequestRefsIssue(
  pr: { title: string; body?: string | null; state?: string },
  issueNumber: number
): boolean {
  if (pr.state && pr.state !== "open") return false;
  const pattern = refsIssuePattern(issueNumber);
  return pattern.test(visibleClosingText(pr.title)) || pattern.test(visibleClosingText(pr.body ?? ""));
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
  const text = visibleClosingText(`${pr.title}\n${pr.body ?? ""}`);
  const pattern = new RegExp(String.raw`\b(?:${REFS_PHRASES})\s*:?\s*#(\d+)\b`, "gi");
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
  const text = visibleClosingText(`${pr.title}\n${pr.body ?? ""}`);
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
  const text = visibleClosingText(`${pr.title}\n${pr.body ?? ""}`);
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
