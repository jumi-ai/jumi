import type { IssueJob } from "./types.ts";

/** Which tracker owns the work, the stable id it owns, and a URL a human can open. */
export interface TrackerRef {
  tracker: string;
  id: string;
  url: string;
}

export interface BriefTracker {
  kind: string;
  postBriefComment?(ref: TrackerRef, body: string): Promise<void>;
}

export const MISSING_REPOSITORY_COMMENT = "Please add a single `Repository: owner/repo` line.";

const REPO_SEGMENT = "[A-Za-z0-9_.-]+";
const REPOSITORY_LINE_RE = new RegExp(`^\\s*Repository:\\s*(${REPO_SEGMENT})\\/(${REPO_SEGMENT})\\s*$`, "gim");

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepositoryLines(body: string | null | undefined): RepoRef[] {
  if (!body) return [];
  const seen = new Map<string, RepoRef>();
  REPOSITORY_LINE_RE.lastIndex = 0;
  for (const match of body.matchAll(REPOSITORY_LINE_RE)) {
    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo) continue;
    const key = `${owner}/${repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, { owner, repo });
  }
  return [...seen.values()];
}

/**
 * True when `cloneUrl` names `owner/repo` (last two path segments, optional
 * `.git` suffix). The external brief's `Repository:` line overrides the
 * enqueued owner/repo, but the enqueued clone URL is what gets cloned, so a
 * mismatch must refuse before the engine starts rather than clone one repo
 * and open the pull on another.
 */
export function cloneUrlTargetsRepo(cloneUrl: string | null | undefined, owner: string, repo: string): boolean {
  if (!cloneUrl) return false;
  let path: string;
  try {
    path = new URL(cloneUrl).pathname;
  } catch {
    return false;
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return false;
  const repoSegment = segments[segments.length - 1]?.replace(/\.git$/i, "") ?? "";
  const ownerSegment = segments[segments.length - 2] ?? "";
  return ownerSegment.toLowerCase() === owner.toLowerCase() && repoSegment.toLowerCase() === repo.toLowerCase();
}

export function isExternalIssueJob(job: { tracker?: string | null; trackerId?: string | null }): boolean {
  const tracker = (job.tracker ?? "").trim();
  if (!tracker) return false;
  if (!(job.trackerId ?? "").trim()) return false;
  const lower = tracker.toLowerCase();
  return lower !== "gitea" && lower !== "github";
}

export function trackerRefOfJob(job: IssueJob): TrackerRef {
  if (job.tracker && job.trackerId) {
    return {
      tracker: job.tracker,
      id: job.trackerId,
      url: job.trackerUrl ?? job.htmlUrl,
    };
  }
  return {
    tracker: job.tracker ?? "gitea",
    id: String(job.issueNumber),
    url: job.htmlUrl,
  };
}

function slugify(value: string): string {
  const slug =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  return slug;
}

function sanitizeBranchSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "brief";
}

export function externalBranchName(tracker: string, id: string, title: string): string {
  return `jumi/${sanitizeBranchSegment(tracker)}-${sanitizeBranchSegment(id)}-${slugify(title)}`;
}

export function buildExternalPullRequestBody(
  fileContents: string | null | undefined,
  trackerUrl: string,
  runnerStamp?: string
): string {
  const prose = (fileContents ?? "").replaceAll("\0", "").trim();
  const lines: string[] = [];
  if (prose) lines.push(prose);
  else lines.push("Implements the tracked brief.");
  if (trackerUrl) lines.push(trackerUrl);
  let body = lines.join("\n\n");
  if (runnerStamp) body = `${body}\n\n${runnerStamp}`;
  if (body.length > 8000) body = body.slice(0, 8000);
  return body;
}

export function makeExternalIssueJob(opts: {
  tracker: string;
  trackerId: string;
  trackerUrl: string;
  title: string;
  body: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  cloneUrl: string;
  action?: string;
  delivery?: string;
  receivedAt?: string;
  issueUpdatedAt?: string;
}): IssueJob {
  const now = new Date().toISOString();
  return {
    delivery: opts.delivery ?? `external-${opts.tracker}-${opts.trackerId}`,
    owner: opts.owner,
    repo: opts.repo,
    // 0 marks "not a forge issue number": the stable id lives in trackerId.
    issueNumber: 0,
    action: opts.action ?? "assigned",
    title: opts.title,
    body: opts.body,
    htmlUrl: opts.trackerUrl,
    issueUpdatedAt: opts.issueUpdatedAt ?? now,
    defaultBranch: opts.defaultBranch,
    cloneUrl: opts.cloneUrl,
    receivedAt: opts.receivedAt ?? now,
    tracker: opts.tracker,
    trackerId: opts.trackerId,
    trackerUrl: opts.trackerUrl,
  };
}
