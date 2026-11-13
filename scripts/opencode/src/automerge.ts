import { branchRequiresReviewCheck, JUMI_REVIEW_CONTEXT } from "./ci.ts";
import type { ClaimedLoop } from "./claimed_worktree.ts";
import { pushClaimedBranch } from "./claimed_worktree.ts";
import type { ForgeKind } from "./forge.ts";
import { senderCanSteer } from "./permissions.ts";
import type { Forge, IssueApi, IssueTimelineEvent } from "./ports.ts";
import {
  compileReviewExcludePatterns,
  DEFAULT_AUTOMERGE_LABEL,
  DEFAULT_NO_AUTOMERGE_LABEL,
  loadRepoSettings,
  partitionReviewExcludedFiles,
  prTouchesRepoSettings,
  REPO_SETTINGS_PATH,
  type RepoSettingsLoad,
  repoMode,
} from "./repo_settings.ts";
import { upsertStickyComment } from "./sticky_comment.ts";

export const AUTOMERGE_REPOS_ENV = "JUMI_AUTOMERGE_REPOS";
export const AUTOMERGE_ENABLED_ENV = "JUMI_AUTOMERGE_ENABLED";
export const AUTOMERGE_NOTE_MARKER = "<!-- jumi-automerge -->";

export { DEFAULT_AUTOMERGE_LABEL, DEFAULT_NO_AUTOMERGE_LABEL };

type AutomergeApi = Pick<
  IssueApi,
  | "getRepo"
  | "getPR"
  | "getBranch"
  | "scheduleAutoMerge"
  | "findStickyIssueComment"
  | "createIssueComment"
  | "updateIssueComment"
  | "getIssue"
  | "addIssueLabel"
  | "getCollaboratorPermission"
> &
  Partial<Pick<Forge, "getPRFiles" | "getRepoFile" | "cancelAutoMerge" | "listIssueTimeline">>;

export type AutomergeLabelList = ReadonlyArray<string | { name?: string }>;

/**
 * Deployment-level auto-merge opt-in, same CSV style as the allowlists.
 * Besides `owner/repo` entries it accepts a whole-owner entry (`owner`, also
 * written `owner/*`) and an every-repository entry (`*`, also written with a
 * slash-star suffix). Matching is case-insensitive; blank entries are ignored.
 *
 * An unset or empty list allows every repository: the repository's own
 * `.jumi.yml` alone decides. A non-empty list narrows further exactly as
 * before (deprecated `JUMI_AUTOMERGE_REPOS`).
 */
export function isAutomergeRepo(owner: string, repo: string, list: readonly string[] | undefined): boolean {
  if (!list || list.length === 0) return true;
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
  /** Global kill switch. Unset defaults to on. Off never schedules; labels do nothing. */
  automergeEnabled?: boolean;
  trustedSenderLogins?: readonly string[];
  /** Working issue number for the Jumi PR (fallback labeller lookup + label copy). */
  issueNumber?: number;
  /** Pre-fetched PR labels (avoids an extra getPR when the caller already has them). */
  prLabels?: AutomergeLabelList | null;
  /**
   * Verdict for a just-copied `automerge` label: Jumi's own copy onto the PR
   * carries the issue labeller's verdict and must not be re-judged as the bot.
   * When set, the PR history lookup is skipped for the copied label.
   */
  copiedAutomergeTrusted?: boolean;
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

export function automergeDisabledNote(): string {
  return (
    `Jumi did not schedule auto-merge on this pull request because auto-merge is turned off ` +
    `for this Jumi deployment (\`JUMI_AUTOMERGE_ENABLED\` is off). A person needs to merge once reviews and CI are green.`
  );
}

export function automergeConflictNote(automergeLabel: string, noAutomergeLabel: string): string {
  return (
    `Jumi did not schedule auto-merge on this pull request because it carries both ` +
    `\`${automergeLabel}\` and \`${noAutomergeLabel}\`. Remove one of them; a person needs to merge once reviews and CI are green.`
  );
}

export function automergeUntrustedNote(automergeLabel: string, adder: string | undefined): string {
  const who = adder && adder.trim() ? `@${adder.trim()}` : "its labeller";
  return (
    `Jumi did not schedule auto-merge on this pull request: the \`${automergeLabel}\` label was added by ` +
    `${who}, who may not turn auto-merge on. A person with write access needs to add the label, or a person needs to merge once reviews and CI are green.`
  );
}

export function automergeLabellerUnreadableNote(automergeLabel: string): string {
  return (
    `Jumi did not schedule auto-merge on this pull request: the \`${automergeLabel}\` label history could not be read, ` +
    `so the labeller could not be checked. A person needs to merge once reviews and CI are green.`
  );
}

function unrestoredInvalidSettingsNote(error: string): string {
  return (
    `Jumi did not restore auto-merge on this pull request: the repository settings file ` +
    `\`${REPO_SETTINGS_PATH}\` is invalid: ${error} A person needs to merge once reviews and CI are green.`
  );
}

function labelNameOf(label: string | { name?: string }): string {
  return typeof label === "string" ? label : (label.name ?? "");
}

function hasLabelCaseInsensitive(labels: AutomergeLabelList | null | undefined, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  return (labels ?? []).some((label) => labelNameOf(label).trim().toLowerCase() === needle);
}

function resolveLabelNames(settings: RepoSettingsLoad): { automergeLabel: string; noAutomergeLabel: string } {
  if (settings.state === "valid") {
    return { automergeLabel: settings.automergeLabel, noAutomergeLabel: settings.noAutomergeLabel };
  }
  return { automergeLabel: DEFAULT_AUTOMERGE_LABEL, noAutomergeLabel: DEFAULT_NO_AUTOMERGE_LABEL };
}

function timelineLabelName(entry: IssueTimelineEvent): string {
  const label = entry.label;
  if (typeof label === "string") return label;
  return label?.name ?? "";
}

function timelineActorLogin(entry: IssueTimelineEvent): string | undefined {
  const actor = entry.actor;
  if (typeof actor === "string" && actor.trim()) return actor.trim();
  if (actor && typeof actor === "object" && typeof actor.login === "string" && actor.login.trim()) {
    return actor.login.trim();
  }
  const user = entry.user;
  if (user && typeof user === "object" && typeof user.login === "string" && user.login.trim()) {
    return user.login.trim();
  }
  return undefined;
}

function timelineEventKind(entry: IssueTimelineEvent): string {
  return (entry.event ?? entry.type ?? "").trim().toLowerCase();
}

function isLabeledKind(kind: string): boolean {
  return kind === "labeled" || kind === "label" || kind === "add_label" || kind === "labelled";
}

function isUnlabeledKind(kind: string): boolean {
  return kind === "unlabeled" || kind === "unlabel" || kind === "remove_label" || kind === "unlabelled";
}

/**
 * Most recent actor that added `labelName` according to the forge timeline.
 * Returns `{unreadable:true}` when the history cannot be read (missing
 * entrypoint, throw, or non-list), `{adder:undefined}` when no labeled event
 * names that label. The last event for the label wins: a trailing unlabeled
 * event means the label is gone, so there is no adder.
 */
export async function findLabelAdder(
  api: Pick<AutomergeApi, "listIssueTimeline">,
  owner: string,
  repo: string,
  index: number,
  labelName: string
): Promise<{ adder?: string } | { unreadable: true }> {
  const list = api.listIssueTimeline;
  if (typeof list !== "function") return { unreadable: true };
  let events: IssueTimelineEvent[];
  try {
    events = await list.call(api, owner, repo, index);
  } catch {
    return { unreadable: true };
  }
  if (!Array.isArray(events)) return { unreadable: true };
  const needle = labelName.trim().toLowerCase();
  let adder: string | undefined;
  let present = false;
  for (const entry of events) {
    if (!entry || typeof entry !== "object") continue;
    if (timelineLabelName(entry).trim().toLowerCase() !== needle) continue;
    const kind = timelineEventKind(entry);
    if (isUnlabeledKind(kind)) {
      present = false;
      adder = undefined;
      continue;
    }
    if (isLabeledKind(kind) || kind === "") {
      // Entries without a kind (some fakes) still name the label; treat as labeled.
      const login = timelineActorLogin(entry);
      present = true;
      adder = login;
    }
  }
  if (!present) return {};
  return { adder };
}

/**
 * Whether the `automerge` label on a PR counts. `no_automerge` is honoured
 * whoever added it (safe direction). `automerge` only counts when the person
 * who added it passes the same sender check a handover needs today
 * (`TRUSTED_SENDER_LOGINS` when set, write access otherwise). Fail closed:
 * an unreadable history or an untrusted labeller never schedules.
 */
export async function isAutomergeLabelAdmitted(opts: {
  api: Pick<AutomergeApi, "listIssueTimeline" | "getCollaboratorPermission">;
  owner: string;
  repo: string;
  prNumber: number;
  issueNumber?: number;
  automergeLabel: string;
  botUsername: string;
  trustedSenderLogins?: readonly string[];
  copiedTrusted?: boolean;
  log?: (message: string) => void;
}): Promise<{ admitted: boolean; adder?: string; unreadable?: boolean }> {
  const log = opts.log ?? (() => undefined);
  if (opts.copiedTrusted !== undefined) {
    log(
      `automerge label verdict carried from issue ${opts.owner}/${opts.repo}#${opts.issueNumber ?? "?"} (trusted=${opts.copiedTrusted})`
    );
    return opts.copiedTrusted ? { admitted: true } : { admitted: false, adder: opts.botUsername };
  }
  const found = await findLabelAdder(opts.api, opts.owner, opts.repo, opts.prNumber, opts.automergeLabel);
  if ("unreadable" in found) {
    log(`automerge labeller unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: timeline unreadable`);
    return { admitted: false, unreadable: true };
  }
  let adder = found.adder;
  if (adder && adder.toLowerCase() === opts.botUsername.toLowerCase() && opts.issueNumber !== undefined) {
    // Jumi's own copy onto the PR carries the issue labeller's verdict.
    const issueFound = await findLabelAdder(opts.api, opts.owner, opts.repo, opts.issueNumber, opts.automergeLabel);
    if ("unreadable" in issueFound) {
      log(
        `automerge labeller unreadable for ${opts.owner}/${opts.repo}#${opts.issueNumber} (issue copy): timeline unreadable`
      );
      return { admitted: false, unreadable: true };
    }
    adder = issueFound.adder;
    if (!adder) {
      log(`automerge labeller unreadable for ${opts.owner}/${opts.repo}#${opts.issueNumber}: no labeled event`);
      return { admitted: false, unreadable: true };
    }
  }
  if (!adder) {
    log(`automerge labeller unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: no labeled event`);
    return { admitted: false, unreadable: true };
  }
  try {
    const api = opts.api as Partial<Pick<Forge, "getCollaboratorPermission">>;
    const admitted = await senderCanSteer(api, opts.owner, opts.repo, adder, opts.trustedSenderLogins);
    return admitted ? { admitted: true, adder } : { admitted: false, adder };
  } catch (err) {
    log(
      `automerge sender check failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { admitted: false, adder, unreadable: true };
  }
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
 * Copy whichever per-PR override label is present on the worked issue onto
 * the freshly opened PR, then run the normal schedule path. The copy carries
 * the issue labeller's verdict so it is not re-judged as the bot. Never throws.
 */
export async function scheduleAutomergeForNewPr(
  input: ScheduleAutomergeInput & { issueNumber: number }
): Promise<{ scheduled: boolean }> {
  const log = input.log ?? (() => undefined);
  const api = input.api as AutomergeApi;
  let names = { automergeLabel: DEFAULT_AUTOMERGE_LABEL, noAutomergeLabel: DEFAULT_NO_AUTOMERGE_LABEL };
  try {
    const settings = await loadRepoSettings(api, input.owner, input.repo, input.baseBranch);
    if (settings.state === "valid") {
      names = { automergeLabel: settings.automergeLabel, noAutomergeLabel: settings.noAutomergeLabel };
    }
  } catch (err) {
    log(
      `automerge settings unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let copiedTrusted: boolean | undefined;
  try {
    const copied = await copyIssueAutomergeLabelsToPr({
      api,
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      automergeLabel: names.automergeLabel,
      noAutomergeLabel: names.noAutomergeLabel,
      botUsername: input.botUsername,
      trustedSenderLogins: input.trustedSenderLogins,
      log,
    });
    if (copied.copiedAutomerge && copied.copiedAutomergeTrusted !== undefined) {
      copiedTrusted = copied.copiedAutomergeTrusted;
    }
  } catch {
    // Copy failures only log inside; scheduling still runs on PR labels.
  }
  return scheduleAutomergeForPr({
    ...input,
    ...(copiedTrusted !== undefined ? { copiedAutomergeTrusted: copiedTrusted } : {}),
  });
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
 * Current PR labels. Prefers the caller's pre-fetched list; otherwise reads
 * the PR once. Resolves `undefined` when the PR cannot be read, so callers
 * fail closed where labels decide.
 */
async function loadPrLabels(
  api: AutomergeApi,
  owner: string,
  repo: string,
  prNumber: number,
  prLabels: AutomergeLabelList | null | undefined,
  log: (message: string) => void
): Promise<AutomergeLabelList | undefined> {
  if (prLabels !== undefined && prLabels !== null) return prLabels;
  try {
    const pr = await api.getPR(owner, repo, prNumber);
    return (pr.labels ?? []) as AutomergeLabelList;
  } catch (err) {
    log(
      `automerge pull unreadable for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/**
 * Schedule the forge's native auto-merge on a pull request Jumi opened.
 * Two switches are required: the deployment must allow auto-merge
 * (`JUMI_AUTOMERGE_ENABLED`, default on; `JUMI_AUTOMERGE_REPOS` still narrows
 * when set) and the default-branch settings file must turn auto-merge on —
 * unless a per-PR override label decides instead:
 * `no_automerge_label` (default `no-automerge`) opts one PR out whoever added
 * it, and an admitted `automerge_label` (default `automerge`) opts one PR in
 * even when the file says off. Both labels together never schedule.
 * A missing file or `automerge: false` schedules nothing with no note. An invalid
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
  const enabled = input.automergeEnabled ?? true;
  const api = input.api as AutomergeApi;

  // Deployment narrowing first: a non-empty list still narrows exactly as today.
  if (!isAutomergeRepo(input.owner, input.repo, input.automergeRepos)) return { scheduled: false };

  // Disabled deployment: labels do nothing except the automerge-label note.
  if (!enabled) {
    const labels = await loadPrLabels(api, input.owner, input.repo, input.prNumber, input.prLabels, log);
    if (labels === undefined) {
      log(`automerge pull unreadable for ${input.owner}/${input.repo}#${input.prNumber}: failing closed`);
      await postAutomergeNote(
        api,
        input.owner,
        input.repo,
        input.prNumber,
        input.botUsername,
        `Jumi did not schedule auto-merge on this pull request: the pull request could not be read. A person needs to merge once reviews and CI are green.`
      );
      return { scheduled: false };
    }
    let names = { automergeLabel: DEFAULT_AUTOMERGE_LABEL, noAutomergeLabel: DEFAULT_NO_AUTOMERGE_LABEL };
    try {
      const settings = await loadRepoSettings(api, input.owner, input.repo, input.baseBranch);
      if (settings.state === "valid") {
        names = { automergeLabel: settings.automergeLabel, noAutomergeLabel: settings.noAutomergeLabel };
      }
    } catch {
      // Best-effort: default label names still drive the disabled note.
    }
    if (hasLabelCaseInsensitive(labels, names.automergeLabel)) {
      log(`automerge skipped for ${input.owner}/${input.repo}#${input.prNumber}: deployment switch off`);
      await postAutomergeNote(api, input.owner, input.repo, input.prNumber, input.botUsername, automergeDisabledNote());
    }
    return { scheduled: false };
  }

  const files = await loadPrFiles(api, input.owner, input.repo, input.prNumber, log);
  if (files === undefined) {
    log(`automerge pull files unreadable for ${input.owner}/${input.repo}#${input.prNumber}: failing closed`);
    await postAutomergeNote(
      api,
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
    await postAutomergeNote(api, input.owner, input.repo, input.prNumber, input.botUsername, touchedSettingsNote());
    return { scheduled: false };
  }

  let settings: RepoSettingsLoad;
  try {
    settings = await loadRepoSettings(api, input.owner, input.repo, input.baseBranch);
  } catch (err) {
    log(
      `automerge settings unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    await postAutomergeNote(
      api,
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
      api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      invalidSettingsNote(settings.error)
    );
    return { scheduled: false };
  }
  const names = resolveLabelNames(settings);
  const prLabels = await loadPrLabels(api, input.owner, input.repo, input.prNumber, input.prLabels, log);
  if (prLabels === undefined) {
    log(`automerge pull unreadable for ${input.owner}/${input.repo}#${input.prNumber}: failing closed`);
    await postAutomergeNote(
      api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      `Jumi did not schedule auto-merge on this pull request: the pull request could not be read. A person needs to merge once reviews and CI are green.`
    );
    return { scheduled: false };
  }
  const hasNoAutomerge = hasLabelCaseInsensitive(prLabels, names.noAutomergeLabel);
  const hasAutomerge = hasLabelCaseInsensitive(prLabels, names.automergeLabel);
  if (hasNoAutomerge && hasAutomerge) {
    log(`automerge skipped for ${input.owner}/${input.repo}#${input.prNumber}: conflicting override labels`);
    await postAutomergeNote(
      api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      automergeConflictNote(names.automergeLabel, names.noAutomergeLabel)
    );
    return { scheduled: false };
  }
  if (hasNoAutomerge) {
    log(
      `automerge skipped for ${input.owner}/${input.repo}#${input.prNumber}: ${names.noAutomergeLabel} label present`
    );
    return { scheduled: false };
  }
  let forcedByLabel = false;
  if (hasAutomerge) {
    const verdict = await isAutomergeLabelAdmitted({
      api,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      issueNumber: input.issueNumber,
      automergeLabel: names.automergeLabel,
      botUsername: input.botUsername,
      trustedSenderLogins: input.trustedSenderLogins,
      copiedTrusted: input.copiedAutomergeTrusted,
      log,
    });
    if (!verdict.admitted) {
      if (verdict.unreadable) {
        log(`automerge labeller unreadable for ${input.owner}/${input.repo}#${input.prNumber}: failing closed`);
        await postAutomergeNote(
          api,
          input.owner,
          input.repo,
          input.prNumber,
          input.botUsername,
          automergeLabellerUnreadableNote(names.automergeLabel)
        );
      } else {
        log(
          `automerge skipped for ${input.owner}/${input.repo}#${input.prNumber}: ${names.automergeLabel} labeller not admitted`
        );
        await postAutomergeNote(
          api,
          input.owner,
          input.repo,
          input.prNumber,
          input.botUsername,
          automergeUntrustedNote(names.automergeLabel, verdict.adder)
        );
      }
      return { scheduled: false };
    }
    forcedByLabel = true;
  }
  if (!forcedByLabel && (settings.state !== "valid" || settings.automerge !== true)) return { scheduled: false };
  // Restricted repository modes never schedule: review-only and off keep the
  // pull open for a person without a note (off posts nothing at all).
  if (repoMode(settings) !== "full") {
    log(
      `automerge skipped for ${input.owner}/${input.repo}#${input.prNumber}: repository mode is ${repoMode(settings)}`
    );
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
      api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      excludedFilesNote(excluded)
    );
    return { scheduled: false };
  }

  const gate = await checkAutomergeGates(
    api,
    forge,
    input.owner,
    input.repo,
    input.prNumber,
    input.baseBranch,
    input.botUsername,
    log
  );
  if (!gate.ok) {
    await postAutomergeNote(api, input.owner, input.repo, input.prNumber, input.botUsername, gate.note);
    return { scheduled: false };
  }

  try {
    const schedule = api.scheduleAutoMerge;
    if (typeof schedule !== "function") throw new Error("the forge does not expose auto-merge scheduling");
    await schedule.call(api, input.owner, input.repo, input.prNumber, { mergeMethod: gate.mergeMethod });
    log(`automerge scheduled for ${input.owner}/${input.repo}#${input.prNumber} (${gate.mergeMethod})`);
    return { scheduled: true };
  } catch (err) {
    log(
      `automerge schedule failed for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    await postAutomergeNote(
      api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      `Jumi tried to schedule auto-merge on this pull request but the forge refused. A person needs to merge once reviews and CI are green.`
    );
    return { scheduled: false };
  }
}

async function checkAutomergeGates(
  api: AutomergeApi,
  forge: ForgeKind,
  owner: string,
  repo: string,
  prNumber: number,
  baseBranch: string,
  botUsername: string,
  log: (message: string) => void
): Promise<{ ok: true; mergeMethod: string } | { ok: false; note: string }> {
  void botUsername;
  let gateOk = false;
  try {
    const getBranch = api.getBranch;
    if (typeof getBranch !== "function") throw new Error("branch requirements are not readable");
    const branch = await getBranch.call(api, owner, repo, baseBranch);
    gateOk = branchRequiresReviewCheck(branch);
    if (!gateOk) {
      log(`automerge gate closed for ${owner}/${repo}#${prNumber}: review check not required`);
      return {
        ok: false,
        note:
          `Jumi did not schedule auto-merge on this pull request: the base branch \`${baseBranch}\` does not require the ` +
          `\`${JUMI_REVIEW_CONTEXT}\` check. A person needs to merge once reviews and CI are green.`,
      };
    }
  } catch (err) {
    log(
      `automerge gate unreadable for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return {
      ok: false,
      note: `Jumi did not schedule auto-merge on this pull request: the base branch requirements could not be read. A person needs to merge once reviews and CI are green.`,
    };
  }

  try {
    const repoInfo = await api.getRepo(owner, repo);
    if (forge === "github") {
      if (repoInfo.allowAutoMerge === false) {
        return {
          ok: false,
          note: `Jumi did not schedule auto-merge on this pull request: auto-merge is disabled on this repository. A person needs to merge once reviews and CI are green.`,
        };
      }
      const method = githubMergeMethodForRepo(repoInfo);
      if (!method) {
        return {
          ok: false,
          note: `Jumi did not schedule auto-merge on this pull request: the repository allows no merge method. A person needs to merge once reviews and CI are green.`,
        };
      }
      return { ok: true, mergeMethod: method };
    }
    const style = repoInfo.defaultMergeStyle || "merge";
    if (!GITEA_MERGE_STYLES.has(style)) {
      return {
        ok: false,
        note: `Jumi did not schedule auto-merge on this pull request: the repository's default merge style is unknown. A person needs to merge once reviews and CI are green.`,
      };
    }
    return { ok: true, mergeMethod: style };
  } catch (err) {
    log(
      `automerge repo unreadable for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return {
      ok: false,
      note: `Jumi did not schedule auto-merge on this pull request: the repository merge settings could not be read. A person needs to merge once reviews and CI are green.`,
    };
  }
}

/**
 * Copy whichever per-PR override label is present on the worked issue onto
 * the freshly opened PR, so the decision is visible on the PR. From then on
 * the PR's labels decide. Returns which labels were copied and, for a copied
 * `automerge` label, whether its issue labeller passes the sender check (the
 * copy carries that verdict and must not be re-judged as the bot).
 *
 * Never throws: copy failures only log.
 */
export async function copyIssueAutomergeLabelsToPr(opts: {
  api: AutomergeApi;
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber: number;
  automergeLabel: string;
  noAutomergeLabel: string;
  botUsername: string;
  trustedSenderLogins?: readonly string[];
  log?: (message: string) => void;
}): Promise<{ copiedAutomerge: boolean; copiedNoAutomerge: boolean; copiedAutomergeTrusted?: boolean }> {
  const log = opts.log ?? (() => undefined);
  const getIssue = opts.api.getIssue;
  const addLabel = opts.api.addIssueLabel;
  if (typeof getIssue !== "function" || typeof addLabel !== "function")
    return { copiedAutomerge: false, copiedNoAutomerge: false };
  let issueLabels: AutomergeLabelList;
  try {
    const issue = await getIssue.call(opts.api, opts.owner, opts.repo, opts.issueNumber);
    issueLabels = (issue.labels ?? []) as AutomergeLabelList;
  } catch (err) {
    log(
      `automerge issue labels unreadable for ${opts.owner}/${opts.repo}#${opts.issueNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { copiedAutomerge: false, copiedNoAutomerge: false };
  }
  const wantAutomerge = hasLabelCaseInsensitive(issueLabels, opts.automergeLabel);
  const wantNoAutomerge = hasLabelCaseInsensitive(issueLabels, opts.noAutomergeLabel);
  if (!wantAutomerge && !wantNoAutomerge) return { copiedAutomerge: false, copiedNoAutomerge: false };
  let copiedAutomergeTrusted: boolean | undefined;
  if (wantAutomerge) {
    const found = await findLabelAdder(opts.api, opts.owner, opts.repo, opts.issueNumber, opts.automergeLabel);
    if (!("unreadable" in found) && found.adder) {
      try {
        copiedAutomergeTrusted = await senderCanSteer(
          opts.api as Partial<Pick<Forge, "getCollaboratorPermission">>,
          opts.owner,
          opts.repo,
          found.adder,
          opts.trustedSenderLogins
        );
      } catch {
        copiedAutomergeTrusted = false;
      }
    } else {
      // Unreadable issue history: the schedule path fails closed with its own
      // note, so the copy still lands and the verdict stays undefined.
      copiedAutomergeTrusted = undefined;
    }
  }
  const copyOne = async (label: string): Promise<boolean> => {
    try {
      await addLabel.call(opts.api, opts.owner, opts.repo, opts.prNumber, label);
      log(`automerge copied label \`${label}\` from issue #${opts.issueNumber} to PR #${opts.prNumber}`);
      return true;
    } catch (err) {
      log(
        `automerge label copy failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  };
  let copiedAutomerge = false;
  let copiedNoAutomerge = false;
  if (wantAutomerge) copiedAutomerge = await copyOne(opts.automergeLabel);
  if (wantNoAutomerge) copiedNoAutomerge = await copyOne(opts.noAutomergeLabel);
  return {
    copiedAutomerge,
    copiedNoAutomerge,
    ...(copiedAutomerge && copiedAutomergeTrusted !== undefined ? { copiedAutomergeTrusted } : {}),
  };
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
  automergeEnabled?: boolean;
  trustedSenderLogins?: readonly string[];
  issueNumber?: number;
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
 * Restoring re-checks the default-branch settings file and the PR override
 * labels: an invalid file posts the parser's error, both labels together
 * cancel with a conflict note, `no_automerge` cancels silently, and anything
 * but `automerge: true` (or an admitted `automerge` label) restores nothing.
 */
export async function ensureAutomergeAfterPush(input: RestoreAutomergeInput): Promise<void> {
  const log = input.log ?? (() => undefined);
  const noteApi = input.api as AutomergeApi;
  const enabled = input.automergeEnabled ?? true;
  if (!enabled) return;
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
    // Gitea never restores, but a push that brings a left-out file — or a
    // `no_automerge`/conflict label state — into the pull still cancels a
    // schedule Jumi set earlier. Like the settings file, the cancel result
    // drives the note (conflict still names itself). One repo+settings read
    // serves both the excluded and the label checks.
    let prLabels: AutomergeLabelList = [];
    try {
      const pr = await noteApi.getPR(input.owner, input.repo, input.prNumber);
      prLabels = ((pr as { labels?: AutomergeLabelList | null }).labels ?? []) as AutomergeLabelList;
    } catch (err) {
      log(
        `automerge re-read failed for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    let defaultBranch = "main";
    try {
      const info = await noteApi.getRepo(input.owner, input.repo);
      if (typeof info.default_branch === "string" && info.default_branch) defaultBranch = info.default_branch;
    } catch (err) {
      log(
        `automerge repo unreadable for ${input.owner}/${input.repo}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    let settings: RepoSettingsLoad | undefined;
    try {
      settings = await loadRepoSettings(noteApi, input.owner, input.repo, defaultBranch);
    } catch (err) {
      log(
        `automerge settings unreadable for ${input.owner}/${input.repo}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (settings.state !== "valid") return;
    const names = { automergeLabel: settings.automergeLabel, noAutomergeLabel: settings.noAutomergeLabel };
    const excluded = excludedFilenames(files, settings);
    if (excluded.length > 0) {
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
    const hasNo = hasLabelCaseInsensitive(prLabels, names.noAutomergeLabel);
    const hasYes = hasLabelCaseInsensitive(prLabels, names.automergeLabel);
    if (hasNo && hasYes) {
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
          automergeConflictNote(names.automergeLabel, names.noAutomergeLabel)
        );
      }
      return;
    }
    if (hasNo) {
      await cancelAutomergeSchedule(noteApi, input.forgeKind, input.owner, input.repo, input.prNumber, log);
    }
    return;
  }
  let current: { merged?: boolean; state?: string; autoMergeEnabled?: boolean; labels?: AutomergeLabelList | null };
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
  const names = resolveLabelNames(settings);
  const prLabels = ((current as { labels?: AutomergeLabelList | null }).labels ?? []) as AutomergeLabelList;
  const hasNo = hasLabelCaseInsensitive(prLabels, names.noAutomergeLabel);
  const hasYes = hasLabelCaseInsensitive(prLabels, names.automergeLabel);
  if (hasNo && hasYes) {
    log(`automerge cancelled for ${input.owner}/${input.repo}#${input.prNumber}: conflicting override labels`);
    await cancelAutomergeSchedule(noteApi, input.forgeKind, input.owner, input.repo, input.prNumber, log);
    await postAutomergeNote(
      noteApi,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      automergeConflictNote(names.automergeLabel, names.noAutomergeLabel)
    );
    return;
  }
  if (hasNo) {
    log(
      `automerge cancelled for ${input.owner}/${input.repo}#${input.prNumber}: ${names.noAutomergeLabel} label present`
    );
    await cancelAutomergeSchedule(noteApi, input.forgeKind, input.owner, input.repo, input.prNumber, log);
    return;
  }
  let forcedByLabel = false;
  if (hasYes) {
    const verdict = await isAutomergeLabelAdmitted({
      api: noteApi,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      issueNumber: input.issueNumber,
      automergeLabel: names.automergeLabel,
      botUsername: input.botUsername,
      trustedSenderLogins: input.trustedSenderLogins,
      log,
    });
    if (!verdict.admitted) {
      if (verdict.unreadable) {
        await postAutomergeNote(
          noteApi,
          input.owner,
          input.repo,
          input.prNumber,
          input.botUsername,
          automergeLabellerUnreadableNote(names.automergeLabel)
        );
      } else {
        await postAutomergeNote(
          noteApi,
          input.owner,
          input.repo,
          input.prNumber,
          input.botUsername,
          automergeUntrustedNote(names.automergeLabel, verdict.adder)
        );
      }
      await cancelAutomergeSchedule(noteApi, input.forgeKind, input.owner, input.repo, input.prNumber, log);
      return;
    }
    forcedByLabel = true;
  }
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
  if (!forcedByLabel && settings.automerge !== true) return;
  // Restricted repository modes never restore: the pull stays open for a
  // person. Silent like a missing/off file, so off mode posts nothing.
  if (repoMode(settings) !== "full") {
    log(
      `automerge not restored for ${input.owner}/${input.repo}#${input.prNumber}: repository mode is ${repoMode(settings)}`
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
  automergeEnabled?: boolean;
  trustedSenderLogins?: readonly string[];
  issueNumber?: number;
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
    automergeEnabled: input.automergeEnabled,
    trustedSenderLogins: input.trustedSenderLogins,
    issueNumber: input.issueNumber,
    log: input.log,
  });
}

/**
 * Decide what a label webhook on a Jumi PR should do. Returns
 * `"schedule"` when the effective decision (labels included) wants a schedule
 * and `"cancel"` when it wants none. Both labels together want cancel plus
 * the conflict note. `no_automerge` alone wants a silent cancel. Callers
 * re-run the full gate via `scheduleAutomergeForPr` for `"schedule"`.
 */
export function automergeLabelEventAction(
  labels: AutomergeLabelList | null | undefined,
  settings: RepoSettingsLoad
): { action: "schedule" | "cancel"; conflict: boolean } {
  const names = resolveLabelNames(settings);
  const hasNo = hasLabelCaseInsensitive(labels, names.noAutomergeLabel);
  const hasYes = hasLabelCaseInsensitive(labels, names.automergeLabel);
  if (hasNo && hasYes) return { action: "cancel", conflict: true };
  if (hasNo) return { action: "cancel", conflict: false };
  if (hasYes) return { action: "schedule", conflict: false };
  return settings.state === "valid" && settings.automerge === true
    ? { action: "schedule", conflict: false }
    : { action: "cancel", conflict: false };
}

/**
 * React to adding or removing either override label on an open Jumi PR:
 * re-run every gate (schedule) or cancel the schedule. Only PRs Jumi opened
 * reach here; takeovers and handoffs are filtered by the caller. The bot's
 * own copy event is ignored by the caller. Never throws.
 */
export async function handleAutomergeLabelChange(opts: {
  api: AutomergeApi;
  forgeKind: ForgeKind;
  owner: string;
  repo: string;
  prNumber: number;
  baseBranch: string;
  automergeRepos: readonly string[] | undefined;
  automergeEnabled?: boolean;
  trustedSenderLogins?: readonly string[];
  botUsername: string;
  issueNumber?: number;
  log?: (message: string) => void;
}): Promise<{ action: "scheduled" | "cancelled" | "none" }> {
  const log = opts.log ?? (() => undefined);
  if (!isAutomergeRepo(opts.owner, opts.repo, opts.automergeRepos)) return { action: "none" };
  let prLabels: AutomergeLabelList = [];
  try {
    const pr = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
    if (pr.merged || pr.state !== "open") return { action: "none" };
    prLabels = ((pr as { labels?: AutomergeLabelList | null }).labels ?? []) as AutomergeLabelList;
  } catch (err) {
    log(
      `automerge label re-read failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { action: "none" };
  }
  const enabled = opts.automergeEnabled ?? true;
  if (!enabled) {
    // Mirror the open-time disabled branch in scheduleAutomergeForPr: when the
    // PR carries the (possibly custom) automerge label while the deployment
    // switch is off, leave one sticky disabled note.
    let names = { automergeLabel: DEFAULT_AUTOMERGE_LABEL, noAutomergeLabel: DEFAULT_NO_AUTOMERGE_LABEL };
    try {
      const settings = await loadRepoSettings(opts.api, opts.owner, opts.repo, opts.baseBranch);
      if (settings.state === "valid") {
        names = { automergeLabel: settings.automergeLabel, noAutomergeLabel: settings.noAutomergeLabel };
      }
    } catch {
      // Best-effort: default label names still drive the disabled note.
    }
    if (hasLabelCaseInsensitive(prLabels, names.automergeLabel)) {
      log(`automerge skipped for ${opts.owner}/${opts.repo}#${opts.prNumber}: deployment switch off`);
      await postAutomergeNote(
        opts.api,
        opts.owner,
        opts.repo,
        opts.prNumber,
        opts.botUsername,
        automergeDisabledNote()
      );
      return { action: "cancelled" };
    }
    return { action: "none" };
  }
  let settings: RepoSettingsLoad;
  try {
    settings = await loadRepoSettings(opts.api, opts.owner, opts.repo, opts.baseBranch);
  } catch (err) {
    log(
      `automerge settings unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { action: "none" };
  }
  if (settings.state === "invalid") {
    await postAutomergeNote(
      opts.api,
      opts.owner,
      opts.repo,
      opts.prNumber,
      opts.botUsername,
      invalidSettingsNote(settings.error)
    );
    return { action: "none" };
  }
  const names = resolveLabelNames(settings);
  const decision = automergeLabelEventAction(prLabels, settings);
  if (decision.conflict) {
    await cancelAutomergeSchedule(opts.api, opts.forgeKind, opts.owner, opts.repo, opts.prNumber, log);
    await postAutomergeNote(
      opts.api,
      opts.owner,
      opts.repo,
      opts.prNumber,
      opts.botUsername,
      automergeConflictNote(names.automergeLabel, names.noAutomergeLabel)
    );
    return { action: "cancelled" };
  }
  if (decision.action === "cancel") {
    // No-automerge label, or the label was removed and the file does not opt in:
    // cancel anything scheduled.
    await cancelAutomergeSchedule(opts.api, opts.forgeKind, opts.owner, opts.repo, opts.prNumber, log);
    return { action: "cancelled" };
  }
  const result = await scheduleAutomergeForPr({
    api: opts.api,
    forgeKind: opts.forgeKind,
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.prNumber,
    baseBranch: opts.baseBranch,
    automergeRepos: opts.automergeRepos,
    botUsername: opts.botUsername,
    automergeEnabled: opts.automergeEnabled,
    trustedSenderLogins: opts.trustedSenderLogins,
    issueNumber: opts.issueNumber,
    prLabels,
    log,
  });
  return { action: result.scheduled ? "scheduled" : "none" };
}
