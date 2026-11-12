import { byteLength } from "./diagnostics.ts";
import type { GitRunner } from "./workspace.ts";

/**
 * Recent fix history of the files a pull touches, collected parent-side from
 * the target branch. The reviewer gets no new git permissions: this runs in
 * the parent checkout (`jumi/target`) before the prompt is built, and the
 * selection is pasted as untrusted repository history.
 */

/** About 8 commits: newest first, file-scoped to the pull's changed files. */
export const MAX_RECENT_HISTORY_COMMITS = 8;
/** About 2 KiB of text: keeps the block cheap, including for Renovate PRs. */
export const MAX_RECENT_HISTORY_BYTES = 2 * 1024;
/** Stable target ref the checkout prepares; the base branch history lives here. */
export const RECENT_HISTORY_REF = "jumi/target";

export interface RecentHistoryCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  /** True when the subject or body reads as a fix, hotfix, or revert. */
  isFix: boolean;
}

export interface RecentHistorySelection {
  /** Formatted lines, already capped to the byte budget. Empty means inject nothing. */
  text: string;
  truncated: boolean;
  /** Bytes of formatted text before truncation. */
  bytes: number;
  /** Commits that survived selection, newest first. */
  commits: RecentHistoryCommit[];
}

const FIX_RE = /\b(fix|fixes|fixed|fixing|hotfix|hot-fix|bugfix|bug-fix|revert|reverts|reverted|reverting)\b/i;

/** True when the subject or body reads as a fix, hotfix, or revert. */
export function isFixLikeCommit(subject: string, body = ""): boolean {
  return FIX_RE.test(subject) || FIX_RE.test(body);
}

function truncateUtf8(text: string, maxBytes: number): string {
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return cut.replace(/\uFFFD$/, "");
}

/** Separator between fields (`%x00`) and records (`%x1e`) in the git log format. */
const FIELD_SEP = "\x00";
const RECORD_SEP = "\x1e";

function formatCommitLine(commit: RecentHistoryCommit): string {
  const subject = commit.subject.trim() || "(no subject)";
  const marker = commit.isFix ? " [fix]" : "";
  return `${commit.shortSha}${marker} ${subject}`;
}

/** Format commits as one line each, newest first, with `[fix]` marks. */
export function formatRecentHistoryLines(commits: RecentHistoryCommit[]): string {
  return commits.map(formatCommitLine).join("\n").trim();
}

/** Cap formatted commits to the byte budget, keeping the newest entries. */
export function selectRecentHistory(
  commits: RecentHistoryCommit[],
  maxBytes: number = MAX_RECENT_HISTORY_BYTES
): RecentHistorySelection {
  const kept = commits.slice(0, MAX_RECENT_HISTORY_COMMITS);
  const full = formatRecentHistoryLines(kept);
  const bytes = byteLength(full);
  const truncated = bytes > maxBytes;
  return {
    text: truncated ? truncateUtf8(full, maxBytes).trimEnd() : full,
    truncated,
    bytes,
    commits: kept,
  };
}

/** Split the NUL/RS-separated `git log --format` output into commits. */
export function parseRecentHistoryLog(output: string): RecentHistoryCommit[] {
  const commits: RecentHistoryCommit[] = [];
  for (const record of output.split(RECORD_SEP)) {
    const trimmed = record.replace(/^[\r\n]+/, "").trim();
    if (!trimmed) continue;
    const [sha = "", shortSha = "", subject = "", body = ""] = trimmed.split(FIELD_SEP);
    if (!sha.trim()) continue;
    const cleanSubject = subject.trim();
    const cleanBody = body.trim();
    commits.push({
      sha: sha.trim(),
      shortSha: (shortSha.trim() || sha.trim().slice(0, 7)).trim(),
      subject: cleanSubject,
      body: cleanBody,
      isFix: isFixLikeCommit(cleanSubject, cleanBody),
    });
  }
  return commits;
}

/**
 * Collect the latest target-branch commits that touched the pull's files.
 * Returns undefined when there is nothing to inject: no files, no history,
 * or a checkout without enough history (shallow, missing ref). Never throws:
 * the caller logs one line and reviews without the block.
 */
export async function collectRecentHistory(opts: {
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  files: readonly string[];
  ref?: string;
  maxCommits?: number;
  maxBytes?: number;
  log?: (message: string) => void;
}): Promise<RecentHistorySelection | undefined> {
  const names = [...new Set((opts.files ?? []).map((file) => file.trim()).filter(Boolean))];
  if (names.length === 0) return undefined;
  const ref = opts.ref ?? RECENT_HISTORY_REF;
  const maxCommits = opts.maxCommits ?? MAX_RECENT_HISTORY_COMMITS;
  const maxBytes = opts.maxBytes ?? MAX_RECENT_HISTORY_BYTES;
  let output: string;
  try {
    output = await opts.git(
      [
        "log",
        "--no-color",
        "--no-decorate",
        "--format=%H%x00%h%x00%s%x00%b%x1e",
        "-n",
        String(maxCommits),
        ref,
        "--",
        ...names,
      ],
      { cwd: opts.cwd, env: opts.env }
    );
  } catch (err) {
    opts.log?.(`recent history unavailable: ${err instanceof Error ? err.message : String(err)}`.split("\n")[0]);
    return undefined;
  }
  let commits: RecentHistoryCommit[];
  try {
    commits = parseRecentHistoryLog(output).slice(0, maxCommits);
  } catch (err) {
    opts.log?.(`recent history unavailable: ${err instanceof Error ? err.message : String(err)}`.split("\n")[0]);
    return undefined;
  }
  if (commits.length === 0) {
    opts.log?.("recent history unavailable: no target-branch commits touch these files");
    return undefined;
  }
  const selection = selectRecentHistory(commits, maxBytes);
  if (!selection.text) {
    opts.log?.("recent history unavailable: no target-branch commits touch these files");
    return undefined;
  }
  return selection;
}
