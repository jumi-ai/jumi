import { isJumiPullReviewWriteup, isJumiReviewSticky, lastCheckTrailer, parseReviewedCommitSha } from "./followup.ts";
import type { Comment, InlineComment, PullFile, PullReview } from "./ports.ts";
import { reviewFindingLines } from "./verdict.ts";
import type { GitRunner } from "./workspace.ts";

const REVIEW_MARKER = "<!-- jumi-review:";
const SHA_RE = /^[0-9a-f]{7,40}$/i;
export const MAX_DELTA_COMMITS = 200;

/** The latest Jumi review on this pull: the SHA it covered and its finding lines. */
export interface PreviousReview {
  sha: string;
  findings: string[];
}

/** A later review: previous findings plus what changed since the reviewed SHA. */
export interface ReviewDelta {
  previousSha: string;
  findings: string[];
  commits: string[];
  files: PullFile[];
}

function loginEquals(left: string | undefined, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

/**
 * True when Jumi closed the thread itself, which it does once a finding is
 * gone. A thread someone else resolved still counts: resolving it does not fix
 * the code. GitHub's GraphQL types `resolvedBy` as a User, so a thread an App
 * resolved may come back with no resolver; a resolved thread with no named
 * resolver is therefore taken as Jumi's. Where GraphQL does name the App, it
 * has no REST `[bot]` suffix, so compare without it.
 */
function isResolvedByBot(inline: InlineComment, botUsername: string): boolean {
  const slug = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");
  const resolver = inline.resolver?.login;
  if (!resolver) return inline.resolved === true;
  return slug(resolver) === slug(botUsername);
}

/** Forge timestamps can carry a UTC offset, so compare instants, not strings. */
function timeOf(at: string): number {
  const time = Date.parse(at);
  return Number.isNaN(time) ? 0 : time;
}

function stripMarker(body: string, marker: string): string {
  return body.split(marker).join("").replace(/\s+/g, " ").trim();
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}

/** Bot-authored issue comments that carry a Jumi review (the sticky essay). */
export function isJumiReviewComment(comment: { body?: string | null; user?: { login?: string } }, botUsername: string) {
  return loginEquals(comment.user?.login, botUsername) && (comment.body ?? "").includes(REVIEW_MARKER);
}

/**
 * Pick the newest Jumi review on this pull. A sticky carries its findings in the
 * body. A pull review posts them as inline comments, and later reviews only add
 * new ones, so the Jumi inlines that Jumi has not resolved are the current
 * findings.
 */
export function findPreviousReview(opts: {
  comments: readonly Comment[];
  reviews: readonly PullReview[];
  inlines: readonly InlineComment[];
  botUsername: string;
  marker: string;
}): PreviousReview | undefined {
  type Candidate = { sha: string; at: string; body: string; pull: boolean };
  const candidates: Candidate[] = [];
  for (const comment of opts.comments) {
    const body = comment.body ?? "";
    if (!body.includes(opts.marker) || !isJumiReviewSticky(comment, opts.botUsername)) continue;
    const sha = parseReviewedCommitSha(body);
    if (sha) candidates.push({ sha, at: comment.updated_at || comment.created_at || "", body, pull: false });
  }
  for (const review of opts.reviews) {
    const body = review.body ?? review.content ?? "";
    if (review.dismissed || !body.includes(opts.marker)) continue;
    if (!isJumiPullReviewWriteup(review, opts.botUsername)) continue;
    const sha = parseReviewedCommitSha(body) ?? review.commit_id;
    if (!sha) continue;
    candidates.push({ sha, at: review.submitted_at ?? review.updated_at ?? review.created_at ?? "", body, pull: true });
  }
  const latest = candidates.sort((a, b) => timeOf(a.at) - timeOf(b.at)).at(-1);
  if (!latest) return undefined;

  const findings = reviewFindingLines(latest.body);
  if (latest.pull) {
    for (const inline of opts.inlines) {
      if (!loginEquals(inline.user?.login, opts.botUsername)) continue;
      if (isResolvedByBot(inline, opts.botUsername)) continue;
      const body = inline.body ?? "";
      if (!inline.path || !body.includes(opts.marker)) continue;
      const text = stripMarker(body, opts.marker);
      if (!text) continue;
      findings.push(inline.new_position ? `${inline.path}:${inline.new_position}: ${text}` : `${inline.path}: ${text}`);
    }
  }
  // A failed review with no finding lines (unfinished) has nothing to carry
  // forward, so the next run is a first review.
  if (findings.length === 0 && lastCheckTrailer(latest.body)?.state === "failure") return undefined;
  return { sha: latest.sha, findings: dedupe(findings) };
}

function parseNumstat(output: string): Array<{ path: string; additions: number; deletions: number }> {
  const out: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const record of output.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record.replace(/^\n+/, ""));
    if (!match) continue;
    out.push({
      path: match[3],
      additions: match[1] === "-" ? 0 : Number.parseInt(match[1], 10),
      deletions: match[2] === "-" ? 0 : Number.parseInt(match[2], 10),
    });
  }
  return out;
}

function statusFromPatch(patch: string): PullFile["status"] {
  const header = patch.split("\n@@", 1)[0];
  if (/^new file mode /m.test(header)) return "added";
  if (/^deleted file mode /m.test(header)) return "deleted";
  return "modified";
}

/**
 * Build the delta for a later review, or undefined for a first review: the
 * previous SHA is missing, malformed, equal to the head, or not an ancestor.
 * Only files the pull still changes are kept, so a base merge does not pull in
 * unrelated patches. Files past `maxFiles` are listed without a patch, since
 * the caller drops them anyway.
 */
export async function loadReviewDelta(opts: {
  previous: PreviousReview;
  headSha: string;
  pullFiles: readonly PullFile[];
  maxFiles?: number;
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  log?: (message: string) => void;
}): Promise<ReviewDelta | undefined> {
  const sha = opts.previous.sha.trim();
  if (!SHA_RE.test(sha)) return undefined;
  const head = opts.headSha.toLowerCase();
  if (head === sha.toLowerCase() || head.startsWith(sha.toLowerCase())) return undefined;
  const run = (args: string[]) => opts.git(args, { cwd: opts.cwd, env: opts.env });
  try {
    await run(["merge-base", "--is-ancestor", sha, "HEAD"]);
  } catch (err) {
    opts.log?.(`previous reviewed commit ${sha} is not an ancestor of HEAD; full review: ${String(err)}`);
    return undefined;
  }

  try {
    const commits = (await run(["log", "--no-color", "--no-decorate", "--format=%h %s", `${sha}..HEAD`]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const pullNames = new Set(opts.pullFiles.map((file) => file.filename));
    const touched = parseNumstat(
      await run(["diff", "--no-color", "--no-ext-diff", "--no-renames", "--numstat", "-z", sha, "HEAD"])
    ).filter((entry) => pullNames.has(entry.path));
    const files: PullFile[] = [];
    const maxFiles = opts.maxFiles ?? touched.length;
    for (const [index, entry] of touched.entries()) {
      const patch =
        index < maxFiles
          ? await run([
              "diff",
              "--no-color",
              "--no-ext-diff",
              "--no-renames",
              sha,
              "HEAD",
              "--",
              `:(literal)${entry.path}`,
            ])
          : "";
      files.push({
        filename: entry.path,
        status: statusFromPatch(patch),
        additions: entry.additions,
        deletions: entry.deletions,
        changes: entry.additions + entry.deletions,
        ...(patch.trim() ? { patch: patch.trimEnd() } : {}),
      });
    }
    return {
      previousSha: sha,
      findings: opts.previous.findings,
      commits:
        commits.length > MAX_DELTA_COMMITS
          ? [...commits.slice(0, MAX_DELTA_COMMITS), `... ${commits.length - MAX_DELTA_COMMITS} more commits`]
          : commits,
      files,
    };
  } catch (err) {
    opts.log?.(`delta since ${sha} unavailable; full review: ${String(err)}`);
    return undefined;
  }
}
