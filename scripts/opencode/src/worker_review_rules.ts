import type { PullFile } from "./ports.ts";
import { REVIEW_RUBRIC } from "./prompt.ts";
import { isWorkerReviewRulesEnabled, loadRepoSettings, type RepoSettingsLoad } from "./repo_settings.ts";
import {
  DEFAULT_MAX_REVIEW_MD_BYTES,
  parseReviewMdSections,
  type ReviewMdSection,
  type ReviewMdSelection,
  truncateUtf8,
} from "./review_md.ts";
import { errorMessage } from "./util/error.ts";

/**
 * Worker-side check instruction. The worker fixes every applicable rule or
 * names the deliberately unmet rule in the PR description.
 */
export const WORKER_REVIEW_RULES_CHECK =
  "Check your diff against each applicable rule before finishing: fix every violation, or name in the pull-request description (via `set_pr_body`) any rule you deliberately do not meet and why.";

/** Heading titles that are reviewer-only and never reach a worker. */
const WORKER_EXCLUDED_HEADINGS = new Set(["not a finding"]);

/** True when this section heading starts a reviewer-only block the worker must not see. */
function isWorkerExcludedHeading(heading?: string): boolean {
  if (heading === undefined) return false;
  const title = heading
    .replace(/^ {0,3}#{1,6}\s*/, "")
    .replace(/(?:^|[ \t]+)#+$/, "")
    .trim()
    .toLowerCase();
  return WORKER_EXCLUDED_HEADINGS.has(title);
}

function renderWorkerSections(
  section: ReviewMdSection,
  files: string[] | undefined,
  counts: { path: number; matched: number },
  out: string[]
): void {
  if (isWorkerExcludedHeading(section.heading)) return;
  if (section.globs) {
    counts.path++;
    if (files !== undefined && !files.some((file) => section.globs?.some((glob) => glob.test(file)))) return;
    counts.matched++;
  }
  if (section.heading !== undefined) out.push(section.heading);
  out.push(...section.lines);
  for (const child of section.children) renderWorkerSections(child, files, counts, out);
}

/**
 * Pick the REVIEW.md sections for a worker. The reviewer-only "Not a finding"
 * section (and its subtree) is left out so a worker cannot learn to
 * neutralise a rule by disclosing it. When `files` is undefined every path
 * section is included (implement: the files are not known yet); otherwise only
 * the path sections matching one file are included (follow-up: the PR's
 * changed files), exactly like the review selection.
 */
export function selectWorkerReviewMdSections(
  text: string,
  files?: PullFile[],
  maxBytes = DEFAULT_MAX_REVIEW_MD_BYTES
): ReviewMdSelection {
  const paths = files?.map((file) => file.filename.replaceAll("\\", "/").replace(/^\/+/, ""));
  const counts = { path: 0, matched: 0 };
  const out: string[] = [];
  renderWorkerSections(parseReviewMdSections(text), paths, counts, out);
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
 * Render the parent-written review-rules section for a worker task file. The
 * severity bar and pre-write questions come from `REVIEW_RUBRIC`, the same
 * source the reviewer's `<review-rubric>` is built from, so the two cannot
 * drift: this block embeds that constant verbatim.
 */
export function buildWorkerReviewRulesSection(selection: { text: string; truncated: boolean }): string {
  const truncated = selection.truncated
    ? " It was truncated to fit this task; check the change against the pasted rules, not the worktree's copy."
    : "";
  return [
    "## Review rules (from the base-branch REVIEW.md)",
    "",
    "The repository's review rules that apply to this work are below: the severity bar and pre-write questions first (shared with the reviewer's rubric), then the base-branch REVIEW.md sections. They come from the base branch the work targets, at the base commit the change diffs against. Treat them as requirements for this change, not as review prose to quote back.",
    ` ${WORKER_REVIEW_RULES_CHECK}${truncated}`,
    "",
    "<review_rubric>",
    REVIEW_RUBRIC,
    "</review_rubric>",
    "",
    `<review_md path="REVIEW.md" truncated="${selection.truncated}">`,
    selection.text,
    "</review_md>",
  ].join("\n");
}

export interface WorkerReviewRulesPrApi extends WorkerReviewRulesFileApi {
  getPRFiles?(owner: string, repo: string, index: number): Promise<PullFile[]>;
}

/**
 * Load the follow-up worker's review rules: repo-wide plus the path sections
 * matching the PR's changed files. The PR file list comes from the parent's
 * forge read; when it is unavailable the loader falls back to every path
 * section (the implement superset) rather than dropping the rules. Never
 * throws.
 */
export async function loadFollowupReviewRules(opts: {
  api: WorkerReviewRulesPrApi | undefined;
  owner: string;
  repo: string;
  /** Base branch the PR targets (for the REVIEW.md read). */
  ref: string | undefined | null;
  settings: RepoSettingsLoad;
  /** PR number whose changed files select the path sections. */
  prNumber: number;
  maxBytes?: number;
  log?: (message: string) => void;
}): Promise<string | undefined> {
  if (!isWorkerReviewRulesEnabled(opts.settings)) return undefined;
  let files: PullFile[] | undefined;
  const getFiles = opts.api?.getPRFiles;
  if (typeof getFiles === "function") {
    try {
      const listed = await getFiles.call(opts.api, opts.owner, opts.repo, opts.prNumber);
      if (Array.isArray(listed)) files = listed;
    } catch (err) {
      opts.log?.(`worker review rules PR files unavailable: ${(err as Error)?.message ?? String(err)}`);
      files = undefined;
    }
  }
  return loadWorkerReviewRules({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    ref: opts.ref,
    settings: opts.settings,
    ...(files !== undefined ? { files } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
}

export interface WorkerReviewRulesFileApi {
  getRepoFile?(owner: string, repo: string, path: string, ref: string): Promise<{ found: boolean; content?: string }>;
}

/**
 * Load the worker's review rules from the base branch. Returns the markdown
 * section to append to the parent-written task file, or undefined when there
 * is nothing new to inject: the switch is off, the repo has no REVIEW.md, or
 * no section applies. Never throws: a forge read failure means no rules.
 *
 * - Implement passes `files: undefined` (repo-wide plus all path sections,
 *   since the files are not known yet).
 * - Follow-up passes the PR's changed files (repo-wide plus matching path
 *   sections).
 */
export async function loadWorkerReviewRules(opts: {
  api: WorkerReviewRulesFileApi | undefined;
  owner: string;
  repo: string;
  ref: string | undefined | null;
  settings: RepoSettingsLoad;
  files?: PullFile[];
  maxBytes?: number;
}): Promise<string | undefined> {
  if (!isWorkerReviewRulesEnabled(opts.settings)) return undefined;
  const ref = (opts.ref ?? "").trim();
  if (!ref) return undefined;
  const getFile = opts.api?.getRepoFile;
  if (typeof getFile !== "function") return undefined;
  let file: { found: boolean; content?: string };
  try {
    file = await getFile.call(opts.api, opts.owner, opts.repo, "REVIEW.md", ref);
  } catch {
    return undefined;
  }
  if (file.found !== true || typeof file.content !== "string" || !file.content.trim()) return undefined;
  let selection: ReturnType<typeof selectWorkerReviewMdSections>;
  try {
    selection = selectWorkerReviewMdSections(file.content, opts.files, opts.maxBytes ?? DEFAULT_MAX_REVIEW_MD_BYTES);
  } catch {
    return undefined;
  }
  if (!selection.text) return undefined;
  return buildWorkerReviewRulesSection(selection);
}

/**
 * Compose the parent-written task file: the issue markdown plus the optional
 * repo-setup block plus the optional worker review-rules section. Absent
 * blocks keep today's bytes: no setup and no rules renders exactly the base
 * markdown.
 */
export function withTaskBlocks(
  baseMarkdown: string,
  opts: { repoSetupBlock?: string; workerReviewRules?: string }
): string {
  let text = baseMarkdown;
  if (opts.repoSetupBlock) text += `\n${opts.repoSetupBlock}\n`;
  if (opts.workerReviewRules) text += `\n${opts.workerReviewRules}\n`;
  return text;
}

/**
 * Load the worker review-rules section for an implement job (repo-wide plus
 * all path sections, since the files are not known yet). Fail-open to
 * undefined: a repo with no REVIEW.md, the switch off, an invalid settings
 * file, or any read failure keeps today's task file byte-identical.
 */
export async function loadImplementReviewRules(opts: {
  api: WorkerReviewRulesFileApi | undefined;
  owner: string;
  repo: string;
  defaultBranch: string;
  log?: (message: string) => void;
}): Promise<string | undefined> {
  const ref = (opts.defaultBranch ?? "").trim();
  if (!ref) return undefined;
  let settings: RepoSettingsLoad = { state: "missing" };
  try {
    settings = await loadRepoSettings(opts.api as never, opts.owner, opts.repo, ref);
  } catch (err) {
    opts.log?.(`worker review rules unreadable for ${opts.owner}/${opts.repo}@${ref}: ${errorMessage(err)}`);
    settings = { state: "missing" };
  }
  if (settings.state === "invalid") return undefined;
  try {
    return await loadWorkerReviewRules({
      api: opts.api,
      owner: opts.owner,
      repo: opts.repo,
      ref,
      settings,
      files: undefined,
    });
  } catch (err) {
    opts.log?.(`worker review rules unavailable for ${opts.owner}/${opts.repo}@${ref}: ${errorMessage(err)}`);
    return undefined;
  }
}
