import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { PullFile } from "./ports.ts";
import type { GitRunner } from "./workspace.ts";

/**
 * Repo-owned review rules: `REVIEW.md` at the root of the base branch the pull
 * request targets, at the base commit the review diffs against.
 *
 * A subheading that is only a comma-separated list of gitignore-style globs is
 * a path section and applies when a changed file matches one of them. Any other
 * heading is repo-wide and always applies. The parent pastes the applicable
 * sections into the review prompt so the child never has to discover the file.
 *
 * The base commit is the source on purpose: a PR that edits `REVIEW.md` is
 * reviewed under the base rules, and its diff to `REVIEW.md` is reviewed like
 * any other change. No base `REVIEW.md` means no repo rules, even when the
 * head adds one.
 */

export const REVIEW_MD = "REVIEW.md";
export const DEFAULT_MAX_REVIEW_MD_BYTES = 24_000;
/** Never pull more than this off disk, whatever the prompt budget. */
const MAX_REVIEW_MD_READ_BYTES = 1_048_576;

export interface ReviewMdSelection {
  /** Applicable sections, possibly cut to the byte budget. Empty means inject nothing. */
  text: string;
  truncated: boolean;
  /** Bytes of applicable text before truncation. */
  bytes: number;
  pathSections: number;
  matchedPathSections: number;
}

interface Section {
  heading?: string;
  globs?: RegExp[];
  lines: string[];
  children: Section[];
  level: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const GLOB_HINT = /[*?[/]|\.\w/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function segmentToRegExp(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "\\" && i + 1 < segment.length) {
      out += escapeRegExp(segment[++i]);
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = segment.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      let body = segment.slice(i + 1, close);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      out += `[${negate ? "^" : ""}${body.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else {
      out += escapeRegExp(ch);
    }
  }
  return out;
}

/** Compile one gitignore-style glob (no negation) to a matcher over repo-relative file paths. */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob;
  const dirOnly = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  const anchored = pattern.includes("/");
  pattern = pattern.replace(/^\/+/, "");
  const segments = pattern.split("/");
  let body = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      body += last ? ".*" : "(?:.*/)?";
      return;
    }
    body += segmentToRegExp(segment) + (last ? "" : "/");
  });
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A pattern that names a directory matches every file under it.
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(`${prefix}${body}${suffix}`);
}

/** Globs when the heading is only a comma-separated glob list, otherwise undefined (repo-wide). */
export function headingGlobs(heading: string): string[] | undefined {
  const tokens = heading.split(",").map((token) =>
    token
      .trim()
      .replace(/^`+|`+$/g, "")
      .trim()
  );
  if (tokens.length === 0) return undefined;
  for (const token of tokens) {
    if (!token || /\s/.test(token) || token.startsWith("!") || !GLOB_HINT.test(token)) return undefined;
  }
  return tokens;
}

function parseSections(text: string): Section {
  const root: Section = { lines: [], children: [], level: 0 };
  const stack: Section[] = [root];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const top = stack[stack.length - 1];
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
      top.lines.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      top.lines.push(line);
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (!heading) {
      top.lines.push(line);
      continue;
    }
    const level = heading[1].length;
    const title = (heading[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
    while (stack[stack.length - 1].level >= level) stack.pop();
    // A top-level heading is the file's title. As a path section it would take
    // every `##` section with it: `# REVIEW.md` would drop the whole file.
    const globs = level === 1 ? undefined : headingGlobs(title);
    // A repo-owned heading must never break the review: an invalid character
    // class (e.g. `## [z-a].ts`) fails to compile, so fall back to repo-wide.
    let compiled: RegExp[] | undefined;
    try {
      compiled = globs?.map(globToRegExp);
    } catch {
      compiled = undefined;
    }
    const section: Section = {
      heading: line,
      globs: compiled,
      lines: [],
      children: [],
      level,
    };
    stack[stack.length - 1].children.push(section);
    stack.push(section);
  }
  return root;
}

function renderSections(
  section: Section,
  files: string[],
  counts: { path: number; matched: number },
  out: string[]
): void {
  if (section.globs) {
    counts.path++;
    if (!files.some((file) => section.globs?.some((glob) => glob.test(file)))) return;
    counts.matched++;
  }
  if (section.heading !== undefined) out.push(section.heading);
  out.push(...section.lines);
  for (const child of section.children) renderSections(child, files, counts, out);
}

function truncateUtf8(text: string, maxBytes: number): string {
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return cut.replace(/�$/, "");
}

/** Pick the REVIEW.md sections that apply to these changed files. */
export function selectReviewMdSections(
  text: string,
  files: PullFile[],
  maxBytes = DEFAULT_MAX_REVIEW_MD_BYTES
): ReviewMdSelection {
  const paths = files.map((file) => file.filename.replaceAll("\\", "/").replace(/^\/+/, ""));
  const counts = { path: 0, matched: 0 };
  const out: string[] = [];
  renderSections(parseSections(text), paths, counts, out);
  const selected = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const bytes = Buffer.byteLength(selected, "utf8");
  const truncated = bytes > maxBytes;
  return {
    text: truncated ? truncateUtf8(selected, maxBytes).trimEnd() : selected,
    truncated,
    bytes,
    pathSections: counts.path,
    matchedPathSections: counts.matched,
  };
}

/**
 * Read `REVIEW.md` from the root of a workdir on disk. Missing,
 * non-regular (symlink, directory), or unreadable means undefined: inject nothing.
 * `truncated` is true when the file was larger than the read cap.
 * Reviews use `readReviewMdFromBase` instead; this stays for local reads.
 */
export async function readReviewMd(workdir: string): Promise<{ text: string; truncated: boolean } | undefined> {
  const path = join(workdir, REVIEW_MD);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return undefined;
    const handle = await open(path, "r");
    try {
      const size = Math.min(info.size, MAX_REVIEW_MD_READ_BYTES);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      const truncated = info.size > MAX_REVIEW_MD_READ_BYTES;
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return { text: truncated ? text.replace(/�$/, "") : text, truncated };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Read the workdir's REVIEW.md and select what applies. Undefined when there is nothing to inject. */
export async function loadReviewMdSections(
  workdir: string,
  files: PullFile[],
  maxBytes = DEFAULT_MAX_REVIEW_MD_BYTES
): Promise<ReviewMdSelection | undefined> {
  const file = await readReviewMd(workdir);
  if (!file) return undefined;
  // A malformed repo file must never fail the review: inject nothing instead.
  let selection: ReviewMdSelection;
  try {
    selection = selectReviewMdSections(file.text, files, maxBytes);
  } catch {
    return undefined;
  }
  if (!selection.text) return undefined;
  return file.truncated ? { ...selection, truncated: true } : selection;
}

/** Where to read the base branch's REVIEW.md from. Uses only read-only git. */
export interface ReviewMdBaseSource {
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Base commit the review diffs against (`pr.base.sha`). Must be a hex SHA. */
  baseRef: string;
}

/** A single `git ls-tree -l <ref> -- REVIEW.md` line, or undefined when it is not a plain blob entry. */
function parseLsTreeEntry(line: string): { mode: string; kind: string; size: number } | undefined {
  const match = /^(\d+) (\w+) [0-9a-f]+ +(\S+)\tREVIEW\.md$/.exec(line.trim());
  if (!match) return undefined;
  const size = Number(match[3]);
  if (!Number.isInteger(size) || size < 0) return undefined;
  return { mode: match[1], kind: match[2], size };
}

/**
 * Read `REVIEW.md` at the root of the base commit. Missing, non-regular
 * (symlink, submodule, directory), unreadable, or an invalid ref means
 * undefined: inject nothing. `truncated` is true when the blob was larger
 * than the read cap.
 *
 * Uses `git ls-tree` and `git show` only: both are read-only and leave the
 * checked-out worktree, the index, and the porcelain untouched.
 */
export async function readReviewMdFromBase(
  source: ReviewMdBaseSource
): Promise<{ text: string; truncated: boolean } | undefined> {
  if (!/^[0-9a-f]{7,40}$/i.test(source.baseRef)) return undefined;
  try {
    const listing = await source.git(["ls-tree", "-l", source.baseRef, "--", REVIEW_MD], {
      cwd: source.cwd,
      env: source.env,
    });
    const entry = parseLsTreeEntry(listing.trim().split("\n")[0] ?? "");
    if (entry?.kind !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) return undefined;
    const truncated = entry.size > MAX_REVIEW_MD_READ_BYTES;
    const raw = await source.git(["show", `${source.baseRef}:${REVIEW_MD}`], { cwd: source.cwd, env: source.env });
    if (Buffer.byteLength(raw, "utf8") <= MAX_REVIEW_MD_READ_BYTES) return { text: raw, truncated };
    return { text: truncateUtf8(raw, MAX_REVIEW_MD_READ_BYTES).replace(/�$/, ""), truncated: true };
  } catch {
    return undefined;
  }
}

/** Read the base's REVIEW.md and select what applies to these changed files. Undefined when nothing to inject. */
export async function loadReviewMdSectionsFromBase(
  source: ReviewMdBaseSource & { files: PullFile[]; maxBytes?: number }
): Promise<ReviewMdSelection | undefined> {
  const file = await readReviewMdFromBase(source);
  if (!file) return undefined;
  // A malformed repo file must never fail the review: inject nothing instead.
  let selection: ReviewMdSelection;
  try {
    selection = selectReviewMdSections(file.text, source.files, source.maxBytes ?? DEFAULT_MAX_REVIEW_MD_BYTES);
  } catch {
    return undefined;
  }
  if (!selection.text) return undefined;
  return file.truncated ? { ...selection, truncated: true } : selection;
}
