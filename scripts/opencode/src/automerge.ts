import { branchRequiresReviewCheck, JUMI_REVIEW_CONTEXT } from "./ci.ts";
import type { ClaimedLoop } from "./claimed_worktree.ts";
import { pushClaimedBranch } from "./claimed_worktree.ts";
import type { ForgeKind } from "./forge.ts";
import type { Forge, IssueApi } from "./ports.ts";
import {
  compileReviewExcludePatterns,
  loadRepoSettings,
  partitionReviewExcludedFiles,
  prTouchesRepoSettings,
  REPO_SETTINGS_PATH,
  type RepoSettingsLoad,
  repoMode,
} from "./repo_settings.ts";
import { upsertStickyComment } from "./sticky_comment.ts";

export const AUTOMERGE_REPOS_ENV = "JUMI_AUTOMERGE_REPOS";
export const AUTOMERGE_NOTE_MARKER = "<!-- jumi-automerge -->";

type AutomergeApi = Pick<
  IssueApi,
  | "getRepo"
  | "getPR"
  | "getBranch"
  | "scheduleAutoMerge"
  | "findStickyIssueComment"
  | "createIssueComment"
  | "updateIssueComment"
> &
  Partial<Pick<Forge, "getPRFiles" | "getRepoFile" | "cancelAutoMerge">>;

/**
 * Deployment-level auto-merge opt-in, same CSV style as the allowlists.
 * Besides `owner/repo` entries it accepts a whole-owner entry (`owner`, also
 * written `owner/*`) and an every-repository entry (`*`, also written with a
 * slash-star suffix). Matching is case-insensitive; blank entries are ignored.
 */
export function isAutomergeRepo(owner: string, repo: string, list: readonly string[] | undefined): boolean {
  if (!list || list.length === 0) return false;
  const wantedOwner = owner.trim().toLowerCase();
  const wantedRepo = repo.trim().toLowerCase();
  const wanted = `${wantedOwner}/${wantedRepo}`;
  for (const raw of list) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*" || entry === "*/*") return true;
    if (entry.endsWith("/*")) {
      const prefix = entry.slice(0, -2);
      if (prefix === "*" || prefix === wantedOwner) return true;
      continue;
    }
    if (!entry.includes("/")) {
      if (entry === wantedOwner) return true;
      continue;
    }
    if (entry === wanted) return true;
  }
  return false;
}

const GITEA_MERGE_STYLES = new Set(["merge", "rebase", "rebase-merge", "squash", "fast-forward-only"]);

export function githubMergeMethodForRepo(repo: {
  allowMergeCommit?: boolean;
  allowSquashMerge?: boolean;
  allowRebaseMerge?: boolean;
}): "MERGE" | "SQUASH" | "REBASE" | undefined {
  if (repo.allowMergeCommit === true) return "MERGE";
  if (repo.allowSquashMerge === true) return "SQUASH";
  if (repo.allowRebaseMerge === true) return "REBASE";
  if (repo.allowMergeCommit === false && repo.allowSquashMerge === false && repo.allowRebaseMerge === false) {
    return undefined;
  }
  // Unknown (fakes, older forges): the GitHub default is MERGE.
  return "MERGE";
}

async function postAutomergeNote(
  api: AutomergeApi,
  owner: string,
  repo: string,
  prNumber: number,
  botUsername: string,
  body: string
): Promise<void> {
  try {
    await upsertStickyComment(api, owner, repo, prNumber, botUsername, AUTOMERGE_NOTE_MARKER, body);
  } catch {
    // A failed schedule must not fail the job, and neither may its note.
  }
}

export interface ScheduleAutomergeInput {
  api: AutomergeApi;
  forgeKind: ForgeKind;
  owner: string;
  repo: string;
  prNumber: number;
  baseBranch: string;
  automergeRepos: readonly string[] | undefined;
  botUsername: string;
  log?: (message: string) => void;
}

export function touchedSettingsNote(): string {
  return (
    `Jumi did not schedule auto-merge on this pull request because it changes the repository settings file ` +
    `\`${REPO_SETTINGS_PATH}\`. Turning auto-merge on, and every later settings change, takes a person's merge.`
  );
}

export function invalidSettingsNote(error: string): string {
  return (
    `Jumi did not schedule auto-merge on this pull request: the repository settings file ` +
    `\`${REPO_SETTINGS_PATH}\` is invalid: ${error} A person needs to merge once reviews and CI are green.`
  );
}

function cancelledSettingsNote(): string {
  return (
    `Jumi cancelled the auto-merge schedule on this pull request because it changes the repository settings file ` +
    `\`${REPO_SETTINGS_PATH}\`. Turning auto-merge on, and every later settings change, takes a person's merge.`
  );
}

/** Max left-out files named in the auto-merge note; longer lists name the count. Mirrors the review's left-out note. */
export const MAX_LISTED_EXCLUDED_FILES = 10;

/**
 * Shared truncated backtick list for left-out files: names up to
 * `MAX_LISTED_EXCLUDED_FILES`, then "and N more". Same format as the
 * review's left-out note (`review.ts`).
 */
export function formatExcludedFileList(excludedFiles: readonly string[]): string {
  const names = [...new Set(excludedFiles)];
  const shown = names.slice(0, MAX_LISTED_EXCLUDED_FILES);
  const quoted = shown.map((name) => `\`${name}\``).join(", ");
  return names.length > shown.length ? `${quoted} and ${names.length - shown.length} more` : quoted;
}

export function excludedFilesNote(excludedFiles: readonly string[]): string {
  const names = [...new Set(excludedFiles)];
  const total = names.length;
  const tail = formatExcludedFileList(names);
  const filesWord = total === 1 ? "file" : "files";
  const verb = total === 1 ? "is" : "are";
  return (
    `Jumi did not schedule auto-merge on this pull request because ${total} changed ${filesWord} ${verb} ` +
    `left out of review per \`.jumi.yml\` \`review_exclude\` (patches not read): ${tail}. ` +
    `A green review does not cover ${total === 1 ? "this file" : "these files"}; a person needs to merge once reviews and CI are green.`
  );
}

function cancelledExcludedFilesNote(excludedFiles: readonly string[]): string {
  const names = [...new Set(excludedFiles)];
  const total = names.length;
  const tail = formatExcludedFileList(names);
  const filesWord = total === 1 ? "file" : "files";
  const verb = total === 1 ? "is" : "are";
  return (
    `Jumi cancelled the auto-merge schedule on this pull request because ${total} changed ${filesWord} ${verb} ` +
    `left out of review per \`.jumi.yml\` \`review_exclude\` (patches not read): ${tail}. ` +
    `A green review does not cover ${total === 1 ? "this file" : "these files"}; a person needs to merge once reviews and CI are green.`
  );
}

function unrestoredInvalidSettingsNote(error: string): string {
  return (
    `Jumi did not restore auto-merge on this pull request: the repository settings file ` +
    `\`${REPO_SETTINGS_PATH}\` is invalid: ${error} A person needs to merge once reviews and CI are green.`
  );
}

/** Best-effort cancel of a schedule Jumi set earlier. Never throws. Resolves
 * `true` when a schedule was removed; `false` (missing cancel entrypoint,
 * nothing to remove, or a failed cancel) keeps Gitea silent, where the
 * schedule state is unreadable. */
async function cancelAutomergeSchedule(
  api: AutomergeApi,
  forgeKind: ForgeKind,
  owner: string,
  repo: string,
  prNumber: number,
  log: (message: string) => void
): Promise<boolean> {
  void forgeKind;
  try {
    const cancel = api.cancelAutoMerge;
    if (typeof cancel !== "function") return false;
    const removed = await cancel.call(api, owner, repo, prNumber);
    log(`automerge cancelled for ${owner}/${repo}#${prNumber} (settings file in pull)`);
    // Older fakes resolve `void`: only an explicit `false` means "nothing
    // to remove"; anything else keeps the previous claim-a-cancel behaviour.
    return removed !== false;
  } catch (err) {
    // A missing schedule is the steady state; any other failure stays in the
    // server log and never fails the job.
    log(
      `automerge cancel failed for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * Changed files of the pull. Resolves `undefined` when the pull file list
 * is unreadable, so callers fail closed; a missing list entrypoint resolves
 * `[]` (no check possible).
 */
async function loadPrFiles(
  api: AutomergeApi,
  owner: string,
  repo: string,
  prNumber: number,
  log: (message: string) => void
): Promise<Array<{ filename: string }> | undefined> {
  try {
    const listFiles = api.getPRFiles;
    if (typeof listFiles !== "function") return [];
    return await listFiles.call(api, owner, repo, prNumber);
  } catch (err) {
    log(
      `automerge pull files unreadable for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/**
 * Repository-relative paths left out of the review per the loaded
 * default-branch settings. Missing, invalid, unreadable (handled by the
 * caller), or empty means no exclusions. The settings file itself is never
 * left out.
 */
function excludedFilenames(files: ReadonlyArray<{ filename: string }>, settings: RepoSettingsLoad): string[] {
  if (settings.state !== "valid" || settings.reviewExclude.length === 0) return [];
  const compiled = compileReviewExcludePatterns(settings.reviewExclude);
  if (compiled.length === 0) return [];
  return partitionReviewExcludedFiles(files, compiled).excluded.map((file) => file.filename);
}

/**
 * Schedule the forge's native auto-merge on a pull request Jumi opened.
 * Two switches are required: the deployer list must allow the repository
 * and the default-branch settings file must turn auto-merge on. A missing
 * file or `automerge: false` schedules nothing with no note. An invalid
 * file schedules nothing and the note names the parser's error. A pull
 * request that changes the settings file is never scheduled, and neither is
 * a pull with a file left out of review per the default-branch
 * `review_exclude` patterns: a left-out change can merge unread, so a person
 * merges.
 * Fail-closed: any unreadable gate or refused schedule leaves the pull open
 * and posts one sticky note on the pull request. Never throws.
 */
export async function scheduleAutomergeForPr(input: ScheduleAutomergeInput): Promise<{ scheduled: boolean }> {
  const log = input.log ?? (() => undefined);
  const forge = input.forgeKind;
  if (!isAutomergeRepo(input.owner, input.repo, input.automergeRepos)) return { scheduled: false };

  const files = await loadPrFiles(input.api, input.owner, input.repo, input.prNumber, log);
  if (files === undefined) {
    log(`automerge pull files unreadable for ${input.owner}/${input.repo}#${input.prNumber}: failing closed`);
    await postAutomergeNote(
      input.api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      `Jumi did not schedule auto-merge on this pull request: the pull request files could not be read. A person needs to merge once reviews and CI are green.`
    );
    return { scheduled: false };
  }
  if (prTouchesRepoSettings(files)) {
    log(`automerge skipped for ${input.owner}/${input.repo}#${input.prNumber}: pull changes ${REPO_SETTINGS_PATH}`);
    await postAutomergeNote(
      input.api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      touchedSettingsNote()
    );
    return { scheduled: false };
  }

  let settings: RepoSettingsLoad;
  try {
    settings = await loadRepoSettings(input.api, input.owner, input.repo, input.baseBranch);
  } catch (err) {
    log(
      `automerge settings unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    await postAutomergeNote(
      input.api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      `Jumi did not schedule auto-merge on this pull request: the repository settings file could not be read. A person needs to merge once reviews and CI are green.`
    );
    return { scheduled: false };
  }
  if (settings.state === "invalid") {
    log(`automerge settings invalid for ${input.owner}/${input.repo}#${input.prNumber}: ${settings.error}`);
    await postAutomergeNote(
      input.api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      invalidSettingsNote(settings.error)
    );
    return { scheduled: false };
  }
  if (settings.state !== "valid" || settings.automerge !== true) return { scheduled: false };
  // Restricted repository modes never schedule: review-only and off keep the
  // pull open for a person without a note (off posts nothing at all).
  if (repoMode(settings) !== "full") {
    log(`automerge skipped for ${input.owner}/${input.repo}#${input.prNumber}: repository mode is ${settings.mode}`);
    return { scheduled: false };
  }
  // A left-out change can merge unread: a pull with a file the review does
  // not cover never schedules. A person merges.
  const excluded = excludedFilenames(files, settings);
  if (excluded.length > 0) {
    log(
      `automerge skipped for ${input.owner}/${input.repo}#${input.prNumber}: ${excluded.length} file(s) left out of review`
    );
    await postAutomergeNote(
      input.api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      excludedFilesNote(excluded)
    );
    return { scheduled: false };
  }

  let gateOk = false;
  try {
    const getBranch = input.api.getBranch;
    if (typeof getBranch !== "function") throw new Error("branch requirements are not readable");
    const branch = await getBranch.call(input.api, input.owner, input.repo, input.baseBranch);
    gateOk = branchRequiresReviewCheck(branch);
    if (!gateOk) {
      log(`automerge gate closed for ${input.owner}/${input.repo}#${input.prNumber}: review check not required`);
      await postAutomergeNote(
        input.api,
        input.owner,
        input.repo,
        input.prNumber,
        input.botUsername,
        `Jumi did not schedule auto-merge on this pull request: the base branch \`${input.baseBranch}\` does not require the \`${JUMI_REVIEW_CONTEXT}\` check. A person needs to merge once reviews and CI are green.`
      );
      return { scheduled: false };
    }
  } catch (err) {
    log(
      `automerge gate unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    await postAutomergeNote(
      input.api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      `Jumi did not schedule auto-merge on this pull request: the base branch requirements could not be read. A person needs to merge once reviews and CI are green.`
    );
    return { scheduled: false };
  }

  let mergeMethod: string;
  try {
    const repo = await input.api.getRepo(input.owner, input.repo);
    if (forge === "github") {
      if (repo.allowAutoMerge === false) {
        await postAutomergeNote(
          input.api,
          input.owner,
          input.repo,
          input.prNumber,
          input.botUsername,
          `Jumi did not schedule auto-merge on this pull request: auto-merge is disabled on this repository. A person needs to merge once reviews and CI are green.`
        );
        return { scheduled: false };
      }
      const method = githubMergeMethodForRepo(repo);
      if (!method) {
        await postAutomergeNote(
          input.api,
          input.owner,
          input.repo,
          input.prNumber,
          input.botUsername,
          `Jumi did not schedule auto-merge on this pull request: the repository allows no merge method. A person needs to merge once reviews and CI are green.`
        );
        return { scheduled: false };
      }
      mergeMethod = method;
    } else {
      const style = repo.defaultMergeStyle || "merge";
      if (!GITEA_MERGE_STYLES.has(style)) {
        await postAutomergeNote(
          input.api,
          input.owner,
          input.repo,
          input.prNumber,
          input.botUsername,
          `Jumi did not schedule auto-merge on this pull request: the repository's default merge style is unknown. A person needs to merge once reviews and CI are green.`
        );
        return { scheduled: false };
      }
      mergeMethod = style;
    }
  } catch (err) {
    log(
      `automerge repo unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    await postAutomergeNote(
      input.api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      `Jumi did not schedule auto-merge on this pull request: the repository merge settings could not be read. A person needs to merge once reviews and CI are green.`
    );
    return { scheduled: false };
  }

  try {
    const schedule = input.api.scheduleAutoMerge;
    if (typeof schedule !== "function") throw new Error("the forge does not expose auto-merge scheduling");
    await schedule.call(input.api, input.owner, input.repo, input.prNumber, { mergeMethod });
    log(`automerge scheduled for ${input.owner}/${input.repo}#${input.prNumber} (${mergeMethod})`);
    return { scheduled: true };
  } catch (err) {
    log(
      `automerge schedule failed for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    await postAutomergeNote(
      input.api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      `Jumi tried to schedule auto-merge on this pull request but the forge refused. A person needs to merge once reviews and CI are green.`
    );
    return { scheduled: false };
  }
}

export interface RestoreAutomergeInput {
  api: AutomergeApi;
  forgeKind: ForgeKind;
  owner: string;
  repo: string;
  prNumber: number;
  /** Schedule state read just before Jumi's push. Absent (person-cancelled or never scheduled) stays absent. */
  wasScheduled: boolean;
  automergeRepos: readonly string[] | undefined;
  botUsername: string;
  log?: (message: string) => void;
}

/**
 * Keep the schedule across a follow-up or conflict push. Restores the
 * schedule only when it was present just before Jumi's push and the forge
 * dropped it; a person-cancelled (or never scheduled) pull is left alone.
 * Only GitHub exposes a readable schedule state, and only there are extra
 * forge calls made. Never throws; restore failures stay silent (no retry loop).
 *
 * A pull that now changes the repository settings file is never restored:
 * Jumi cancels the schedule it set earlier and posts one note saying why.
 * A pull with a file left out of review per the default-branch
 * `review_exclude` patterns is never restored either: Jumi cancels the
 * schedule it set earlier and posts one note naming the files. A later push
 * that removes those files does not re-schedule; a person merges.
 * Restoring re-checks the default-branch settings file: an invalid file
 * posts the parser's error, and anything but `automerge: true` restores
 * nothing.
 */
export async function ensureAutomergeAfterPush(input: RestoreAutomergeInput): Promise<void> {
  const log = input.log ?? (() => undefined);
  const noteApi = input.api as AutomergeApi;
  if (!isAutomergeRepo(input.owner, input.repo, input.automergeRepos)) return;
  // GitHub exposes a readable schedule state: a pull that never had a
  // schedule (person-cancelled or never scheduled) stays silent without any
  // further forge calls.
  if (input.forgeKind === "github" && !input.wasScheduled) return;
  const files = await loadPrFiles(noteApi, input.owner, input.repo, input.prNumber, log);
  // Unreadable pull files fail closed: neither cancel nor restore.
  if (files === undefined) return;
  if (prTouchesRepoSettings(files)) {
    if (input.forgeKind === "github") {
      await cancelAutomergeSchedule(noteApi, input.forgeKind, input.owner, input.repo, input.prNumber, log);
      await postAutomergeNote(
        noteApi,
        input.owner,
        input.repo,
        input.prNumber,
        input.botUsername,
        cancelledSettingsNote()
      );
      return;
    }
    // Gitea has no readable schedule state (`wasScheduled` is always
    // false), so the cancel result drives the note: only claim a
    // cancellation when a schedule was actually removed.
    const cancelled = await cancelAutomergeSchedule(
      noteApi,
      input.forgeKind,
      input.owner,
      input.repo,
      input.prNumber,
      log
    );
    if (cancelled) {
      await postAutomergeNote(
        noteApi,
        input.owner,
        input.repo,
        input.prNumber,
        input.botUsername,
        cancelledSettingsNote()
      );
    }
    return;
  }
  if (input.forgeKind !== "github") {
    // Gitea never restores, but a push that brings a left-out file into the
    // pull still cancels a schedule Jumi set earlier. Like the settings
    // file, the cancel result drives the note.
    const excluded = await loadGiteaExcludedFilenames(noteApi, input.owner, input.repo, files, log);
    if (excluded.length === 0) return;
    const cancelled = await cancelAutomergeSchedule(
      noteApi,
      input.forgeKind,
      input.owner,
      input.repo,
      input.prNumber,
      log
    );
    if (cancelled) {
      await postAutomergeNote(
        noteApi,
        input.owner,
        input.repo,
        input.prNumber,
        input.botUsername,
        cancelledExcludedFilesNote(excluded)
      );
    }
    return;
  }
  let current: { merged?: boolean; state?: string; autoMergeEnabled?: boolean };
  try {
    current = await input.api.getPR(input.owner, input.repo, input.prNumber);
  } catch (err) {
    log(
      `automerge re-read failed for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (current.merged || current.state !== "open") return;
  let fetchedRepo: Awaited<ReturnType<AutomergeApi["getRepo"]>>;
  try {
    fetchedRepo = await input.api.getRepo(input.owner, input.repo);
    if (fetchedRepo.allowAutoMerge === false) return;
  } catch {
    return;
  }
  const defaultBranch =
    typeof fetchedRepo.default_branch === "string" && fetchedRepo.default_branch ? fetchedRepo.default_branch : "main";
  let settings: RepoSettingsLoad;
  try {
    settings = await loadRepoSettings(noteApi, input.owner, input.repo, defaultBranch);
  } catch (err) {
    log(
      `automerge settings unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (settings.state === "invalid") {
    log(`automerge settings invalid for ${input.owner}/${input.repo}#${input.prNumber}: ${settings.error}`);
    await postAutomergeNote(
      noteApi,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      unrestoredInvalidSettingsNote(settings.error)
    );
    return;
  }
  if (settings.state !== "valid") return;
  // A push that brings a left-out file into an already scheduled pull
  // cancels the schedule Jumi set earlier. Checked before the kept-schedule
  // fast path so a kept schedule is still cancelled; a later push that
  // removes those files sees `wasScheduled: false` and stays silent, so a
  // person merges.
  const excluded = excludedFilenames(files, settings);
  if (excluded.length > 0) {
    log(
      `automerge cancelled for ${input.owner}/${input.repo}#${input.prNumber}: ${excluded.length} file(s) left out of review`
    );
    await cancelAutomergeSchedule(noteApi, input.forgeKind, input.owner, input.repo, input.prNumber, log);
    await postAutomergeNote(
      noteApi,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      cancelledExcludedFilesNote(excluded)
    );
    return;
  }
  if (settings.automerge !== true) return;
  // Restricted repository modes never restore: the pull stays open for a
  // person. Silent like a missing/off file, so off mode posts nothing.
  if (repoMode(settings) !== "full") {
    log(
      `automerge not restored for ${input.owner}/${input.repo}#${input.prNumber}: repository mode is ${settings.mode}`
    );
    return;
  }
  if (current.autoMergeEnabled === true) return;
  const mergeMethod = githubMergeMethodForRepo(fetchedRepo) ?? "MERGE";
  try {
    const schedule = input.api.scheduleAutoMerge;
    if (typeof schedule !== "function") return;
    await schedule.call(input.api, input.owner, input.repo, input.prNumber, { mergeMethod });
    log(`automerge restored for ${input.owner}/${input.repo}#${input.prNumber} (${mergeMethod})`);
  } catch (err) {
    log(
      `automerge restore failed for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Left-out filenames for the Gitea push path. Missing, invalid,
 * unreadable, or empty means no exclusions: the pull is left alone instead
 * of failing. Never throws.
 */
async function loadGiteaExcludedFilenames(
  api: AutomergeApi,
  owner: string,
  repo: string,
  files: ReadonlyArray<{ filename: string }>,
  log: (message: string) => void
): Promise<string[]> {
  let defaultBranch = "main";
  try {
    const info = await api.getRepo(owner, repo);
    if (typeof info.default_branch === "string" && info.default_branch) defaultBranch = info.default_branch;
  } catch (err) {
    log(`automerge repo unreadable for ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  let settings: RepoSettingsLoad;
  try {
    settings = await loadRepoSettings(api, owner, repo, defaultBranch);
  } catch (err) {
    log(`automerge settings unreadable for ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  return excludedFilenames(files, settings);
}

/** Schedule state read just before a push (GitHub only; Gitea has no readable state). */
export async function readAutomergeScheduled(
  api: Pick<AutomergeApi, "getPR">,
  forgeKind: ForgeKind,
  owner: string,
  repo: string,
  prNumber: number,
  automergeRepos: readonly string[] | undefined
): Promise<boolean> {
  if (!isAutomergeRepo(owner, repo, automergeRepos)) return false;
  if (forgeKind !== "github") return false;
  try {
    const pr = await api.getPR(owner, repo, prNumber);
    if (pr.merged || pr.state !== "open") return false;
    return pr.autoMergeEnabled === true;
  } catch {
    return false;
  }
}

export interface PushWithAutomergeRestoreInput {
  api: AutomergeApi;
  forgeKind: ForgeKind;
  owner: string;
  repo: string;
  prNumber: number;
  automergeRepos: readonly string[] | undefined;
  botUsername: string;
  log?: (message: string) => void;
}

/**
 * Read the schedule state, push the claimed branch, then restore the
 * schedule when the forge dropped it. Person-cancelled stays cancelled.
 * A push that brings the settings file into the pull cancels the schedule
 * Jumi set earlier instead. Shared by the follow-up and conflict flows so
 * the restore logic has one home.
 */
export async function pushClaimedBranchWithAutomergeRestore(
  loop: ClaimedLoop,
  branch: string,
  input: PushWithAutomergeRestoreInput
): Promise<void> {
  const wasScheduled = await readAutomergeScheduled(
    input.api,
    input.forgeKind,
    input.owner,
    input.repo,
    input.prNumber,
    input.automergeRepos
  );
  await pushClaimedBranch(loop, branch);
  await ensureAutomergeAfterPush({
    api: input.api,
    forgeKind: input.forgeKind,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    wasScheduled,
    automergeRepos: input.automergeRepos,
    botUsername: input.botUsername,
    log: input.log,
  });
}
