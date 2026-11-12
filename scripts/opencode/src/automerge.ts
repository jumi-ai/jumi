import { JUMI_REVIEW_CONTEXT } from "./ci.ts";
import type { ForgeKind } from "./forge.ts";
import type { IssueApi } from "./ports.ts";

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
>;

/** Deployment-level per-repository opt-in, same `owner/repo` CSV style as the allowlists. */
export function isAutomergeRepo(owner: string, repo: string, list: readonly string[] | undefined): boolean {
  if (!list || list.length === 0) return false;
  const wanted = `${owner}/${repo}`.toLowerCase();
  return list.some((entry) => entry.trim().toLowerCase() === wanted);
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

function firstLine(text: string, maxChars = 300): string {
  const line = text.split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

function failureDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = firstLine(raw.replace(/→ \d+\b.*?:\s*/, ""));
  return line || "unknown error";
}

async function postAutomergeNote(
  api: AutomergeApi,
  owner: string,
  repo: string,
  prNumber: number,
  botUsername: string,
  body: string
): Promise<void> {
  const text = `${AUTOMERGE_NOTE_MARKER}\n${body}`;
  try {
    const existing = await api.findStickyIssueComment(owner, repo, prNumber, botUsername, AUTOMERGE_NOTE_MARKER);
    if (existing) {
      await api.updateIssueComment(owner, repo, existing.id, text);
      return;
    }
    await api.createIssueComment(owner, repo, prNumber, text);
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

/**
 * Schedule the forge's native auto-merge on a pull request Jumi opened.
 * Fail-closed: any unreadable gate or refused schedule leaves the pull open
 * and posts one sticky note on the pull request. Never throws.
 */
export async function scheduleAutomergeForPr(input: ScheduleAutomergeInput): Promise<{ scheduled: boolean }> {
  const log = input.log ?? (() => undefined);
  const forge = input.forgeKind;
  if (!isAutomergeRepo(input.owner, input.repo, input.automergeRepos)) return { scheduled: false };

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
      `Jumi tried to schedule auto-merge on this pull request but the forge refused (${failureDetail(err)}). A person needs to merge once reviews and CI are green.`
    );
    return { scheduled: false };
  }
}

export interface RestoreAutomergeInput {
  api: Pick<AutomergeApi, "getRepo" | "getPR" | "scheduleAutoMerge">;
  forgeKind: ForgeKind;
  owner: string;
  repo: string;
  prNumber: number;
  /** Schedule state read just before Jumi's push. Absent (person-cancelled or never scheduled) stays absent. */
  wasScheduled: boolean;
  automergeRepos: readonly string[] | undefined;
  log?: (message: string) => void;
}

/**
 * Keep the schedule across a follow-up or conflict push. Restores the
 * schedule only when it was present just before Jumi's push and the forge
 * dropped it; a person-cancelled (or never scheduled) pull is left alone.
 * Only GitHub exposes a readable schedule state, and only there are extra
 * forge calls made. Never throws; restore failures stay silent (no retry loop).
 */
export async function ensureAutomergeAfterPush(input: RestoreAutomergeInput): Promise<void> {
  const log = input.log ?? (() => undefined);
  if (!isAutomergeRepo(input.owner, input.repo, input.automergeRepos)) return;
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
  try {
    const repo = await input.api.getRepo(input.owner, input.repo);
    if (repo.allowAutoMerge === false) return;
    mergeMethod = githubMergeMethodForRepo(repo) ?? "MERGE";
  } catch {
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
