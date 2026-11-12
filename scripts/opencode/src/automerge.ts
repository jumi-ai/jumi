import { JUMI_REVIEW_CONTEXT } from "./ci.ts";
import type { ClaimedLoop } from "./claimed_worktree.ts";
import { pushClaimedBranch } from "./claimed_worktree.ts";
import type { ForgeKind } from "./forge.ts";
import type { Forge, IssueApi } from "./ports.ts";
import { loadRepoSettings, prTouchesRepoSettings, REPO_SETTINGS_PATH, type RepoSettingsLoad } from "./repo_settings.ts";
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

function unrestoredInvalidSettingsNote(error: string): string {
  return (
    `Jumi did not restore auto-merge on this pull request: the repository settings file ` +
    `\`${REPO_SETTINGS_PATH}\` is invalid: ${error} A person needs to merge once reviews and CI are green.`
  );
}

/** Best-effort cancel of a schedule Jumi set earlier. Never throws. */
async function cancelAutomergeSchedule(
  api: AutomergeApi,
  forgeKind: ForgeKind,
  owner: string,
  repo: string,
  prNumber: number,
  log: (message: string) => void
): Promise<void> {
  void forgeKind;
  try {
    const cancel = api.cancelAutoMerge;
    if (typeof cancel !== "function") return;
    await cancel.call(api, owner, repo, prNumber);
    log(`automerge cancelled for ${owner}/${repo}#${prNumber} (settings file in pull)`);
  } catch (err) {
    // A missing schedule is the steady state; any other failure stays in the
    // server log and never fails the job.
    log(
      `automerge cancel failed for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function prIncludesSettingsFile(
  api: AutomergeApi,
  owner: string,
  repo: string,
  prNumber: number,
  log: (message: string) => void
): Promise<boolean> {
  try {
    const listFiles = api.getPRFiles;
    if (typeof listFiles !== "function") return false;
    const files = await listFiles.call(api, owner, repo, prNumber);
    return prTouchesRepoSettings(files);
  } catch (err) {
    log(
      `automerge pull files unreadable for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * Schedule the forge's native auto-merge on a pull request Jumi opened.
 * Two switches are required: the deployer list must allow the repository
 * and the default-branch settings file must turn auto-merge on. A missing
 * file or `automerge: false` schedules nothing with no note. An invalid
 * file schedules nothing and the note names the parser's error. A pull
 * request that changes the settings file is never scheduled.
 * Fail-closed: any unreadable gate or refused schedule leaves the pull open
 * and posts one sticky note on the pull request. Never throws.
 */
export async function scheduleAutomergeForPr(input: ScheduleAutomergeInput): Promise<{ scheduled: boolean }> {
  const log = input.log ?? (() => undefined);
  const forge = input.forgeKind;
  if (!isAutomergeRepo(input.owner, input.repo, input.automergeRepos)) return { scheduled: false };

  if (await prIncludesSettingsFile(input.api, input.owner, input.repo, input.prNumber, log)) {
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

  let gateOk = false;
  try {
    const getBranch = input.api.getBranch;
    if (typeof getBranch !== "function") throw new Error("branch requirements are not readable");
    const branch = await getBranch.call(input.api, input.owner, input.repo, input.baseBranch);
    gateOk = branch.enableStatusCheck === true && (branch.requiredContexts ?? []).includes(JUMI_REVIEW_CONTEXT);
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
 * Restoring re-checks the default-branch settings file: an invalid file
 * posts the parser's error, and anything but `automerge: true` restores
 * nothing.
 */
export async function ensureAutomergeAfterPush(input: RestoreAutomergeInput): Promise<void> {
  const log = input.log ?? (() => undefined);
  const noteApi = input.api as AutomergeApi;
  if (!isAutomergeRepo(input.owner, input.repo, input.automergeRepos)) return;
  if (await prIncludesSettingsFile(noteApi, input.owner, input.repo, input.prNumber, log)) {
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
  if (!input.wasScheduled) return;
  if (input.forgeKind !== "github") return;
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
  if (current.autoMergeEnabled === true) return;
  let mergeMethod = "MERGE";
  let defaultBranch = "main";
  try {
    const repo = await input.api.getRepo(input.owner, input.repo);
    if (repo.allowAutoMerge === false) return;
    mergeMethod = githubMergeMethodForRepo(repo) ?? "MERGE";
    if (repo.default_branch) defaultBranch = repo.default_branch;
  } catch {
    return;
  }
  try {
    const settings = await loadRepoSettings(noteApi, input.owner, input.repo, defaultBranch);
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
    if (settings.state !== "valid" || settings.automerge !== true) return;
  } catch (err) {
    log(
      `automerge settings unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
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
