import {
  type AutomergeApi,
  type AutomergeLabelList,
  cancelAutomergeScheduleOutcome,
  evaluateAutomergeLabelState,
  hasLabelCaseInsensitive,
  isAutomergeRepo,
  prBaseRefOf,
  resolveLabelNames,
} from "./automerge_decision.ts";
import { branchRequiresReviewCheck, JUMI_REVIEW_CONTEXT } from "./ci.ts";
import type { ClaimedLoop } from "./claimed_worktree.ts";
import { pushClaimedBranch } from "./claimed_worktree.ts";
import type { ForgeKind } from "./forge.ts";
import { forgeCapabilities } from "./forge_capabilities.ts";
import { senderCanSteer } from "./permissions.ts";
import type { Forge, IssueTimelineEvent } from "./ports.ts";
import { fallbackPolicyDeployment, resolveRepoPolicy } from "./repo_policy.ts";
import {
  compileReviewExcludePatterns,
  DEFAULT_AUTOMERGE_LABEL,
  DEFAULT_NO_AUTOMERGE_LABEL,
  effectiveTrustedSenderLogins,
  partitionReviewExcludedFiles,
  prTouchesRepoSettings,
  REPO_SETTINGS_PATH,
  type RepoSettingsLoad,
  repoMode,
} from "./repo_settings.ts";
import { upsertStickyComment } from "./sticky_comment.ts";
import { errorMessage } from "./util/error.ts";

export type { AutomergeLabelList } from "./automerge_decision.ts";
// Re-exported so existing `automerge.ts` import sites (tests, review
// suggestions) keep working after the read/decision split.
export { cancelAutomergeScheduleOutcome, isAutomergeRepo } from "./automerge_decision.ts";

const AUTOMERGE_REPOS_ENV = "JUMI_AUTOMERGE_REPOS";
const AUTOMERGE_ENABLED_ENV = "JUMI_AUTOMERGE_ENABLED";
export const AUTOMERGE_NOTE_MARKER = "<!-- jumi-automerge -->";
/** Stable marker inside the automerge sticky body: the forge refused the schedule at open. */
export const AUTOMERGE_REFUSED_MARKER = "<!-- jumi-automerge:refused -->";

function hasAutomergeRefusedMarker(body: unknown): boolean {
  return typeof body === "string" && body.includes(AUTOMERGE_REFUSED_MARKER);
}

/**
 * Public note when the forge refuses a schedule. Carries only the HTTP
 * status and the forge's `message` field (no URL or token) plus a second
 * hidden marker so a later Jumi push can tell "refused" apart from a
 * person-cancelled or never-wanted schedule.
 */
function automergeRefusedNote(detail?: string, retryAfterPush = true): string {
  const reason = detail ? ` but the forge refused (${detail})` : " but the forge refused";
  const retry = retryAfterPush
    ? "Jumi tries again after its next push or its next follow-up round (for example after a maintainer reply); otherwise a person merges once reviews and CI are green."
    : "A person needs to merge once reviews and CI are green.";
  return `Jumi tried to schedule auto-merge on this pull request${reason}. ${retry}\n${AUTOMERGE_REFUSED_MARKER}`;
}

/** Short sticky replacing the refused note once a later schedule succeeds. */
function automergeScheduledNote(): string {
  return `Auto-merge is now scheduled.`;
}

/**
 * Short `status: message` excerpt from a forge refusal error. Parses the
 * `→ <status>: <body>` shape `forgeRequestError` produces and lifts the
 * JSON `message` field; never includes the request URL or any token.
 */
function forgeRefusalDetail(err: unknown): string | undefined {
  const msg = errorMessage(err);
  const match = /→ (\d+)\s*:/.exec(msg);
  if (!match?.[1]) return undefined;
  const status = match[1];
  const after = msg.slice((match.index ?? 0) + match[0].length).trim();
  let extracted: string | undefined;
  if (after.startsWith("{")) {
    const cleaned = after.endsWith("…") ? after.slice(0, -1).trim() : after;
    try {
      const parsed = JSON.parse(cleaned) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        extracted = parsed.message.trim().replace(/\s+/g, " ");
      }
    } catch {
      // Fall through to the regex below (truncated bodies).
    }
  }
  if (!extracted) {
    const messageMatch = /"message"\s*:\s*"([^"]{1,200})/.exec(after);
    if (messageMatch?.[1]) extracted = messageMatch[1].trim().replace(/\s+/g, " ");
  }
  if (extracted) {
    const short = extracted.length > 200 ? `${extracted.slice(0, 200).trim()}…` : extracted;
    return `${status}: ${short}`;
  }
  const excerpt = after.replace(/\s+/g, " ").trim();
  if (excerpt) {
    const short = excerpt.length > 200 ? `${excerpt.slice(0, 200).trim()}…` : excerpt;
    return `${status}: ${short}`;
  }
  return status;
}

/**
 * Whether the PR's automerge sticky currently holds the refused-schedule
 * note. Reads `listIssueComments` (the sticky finder only returns an id)
 * and requires both the sticky marker and the refused marker; a missing
 * list entrypoint or an unreadable thread means "no retry", preserving the
 * person-cancelled guarantee.
 */
async function hasRefusedAutomergeNote(
  api: AutomergeApi,
  owner: string,
  repo: string,
  prNumber: number,
  botUsername: string,
  log: (message: string) => void
): Promise<boolean> {
  try {
    const list = (api as Partial<Pick<Forge, "listIssueComments">>).listIssueComments;
    if (typeof list !== "function") return false;
    const comments = await list.call(api, owner, repo, prNumber);
    if (!Array.isArray(comments)) return false;
    return comments.some((comment) => {
      const body = (comment as { body?: unknown }).body;
      if (!hasAutomergeRefusedMarker(body)) return false;
      if (typeof body !== "string" || !body.includes(AUTOMERGE_NOTE_MARKER)) return false;
      const login = (comment as { user?: { login?: string } }).user?.login;
      // Fail closed like findStickyIssueComment: a missing or foreign author
      // never counts as Jumi's own refused note.
      return typeof login === "string" && login.trim() !== "" && login.toLowerCase() === botUsername.toLowerCase();
    });
  } catch (err) {
    log(`automerge refused note unreadable for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Whether a (possibly partial) webhook forge client has every method the
 * label-change path requires. Missing methods fail closed with
 * `{action:"none"}`, the same result as the old `try/catch` around a
 * missing method. Both adapters and the shared forge fake satisfy the full
 * port; a partial mailbox fails here instead of throwing later.
 */
function isFullAutomergeApi(api: Partial<AutomergeApi>): api is AutomergeApi {
  return (
    typeof api.getPR === "function" &&
    typeof api.getRepo === "function" &&
    typeof api.findStickyIssueComment === "function" &&
    typeof api.createIssueComment === "function" &&
    typeof api.updateIssueComment === "function" &&
    typeof api.getIssue === "function" &&
    typeof api.getCollaboratorPermission === "function"
  );
}

export function githubMergeMethodForRepo(repo: {
  allowMergeCommit?: boolean;
  allowSquashMerge?: boolean;
  allowRebaseMerge?: boolean;
}): "MERGE" | "SQUASH" | "REBASE" | undefined {
  // Single implementation lives in the capability table
  // (`forge_capabilities.ts`); this stays as a compatibility wrapper.
  const fallback = forgeCapabilities("github").mergePolicy.defaultMethod(repo);
  return fallback.ok ? (fallback.mergeMethod as "MERGE" | "SQUASH" | "REBASE") : undefined;
}

function automergeMethodNotAllowedNote(method: string): string {
  return (
    `Jumi did not schedule auto-merge on this pull request: the repository does not allow \`${method}\` merges. ` +
    `A person needs to merge once reviews and CI are green.`
  );
}

function unrestoredMethodNotAllowedNote(method: string): string {
  return (
    `Jumi did not restore auto-merge on this pull request: the repository does not allow \`${method}\` merges. ` +
    `A person needs to merge once reviews and CI are green.`
  );
}

/**
 * Configured GitHub merge method. A `false` allow flag refuses the method
 * (no fallback); an unknown flag (older forge, fakes) trusts the setting.
 * A Gitea-only value resolves `undefined` (never scheduled on GitHub).
 */
function githubMergeMethodForConfiguredRepo(
  repo: { allowMergeCommit?: boolean; allowSquashMerge?: boolean; allowRebaseMerge?: boolean },
  method: string
): "MERGE" | "SQUASH" | "REBASE" | undefined {
  // Compatibility wrapper; the table policy holds the implementation.
  return forgeCapabilities("github").mergePolicy.methodForConfiguredRepo(repo, method) as
    | "MERGE"
    | "SQUASH"
    | "REBASE"
    | undefined;
}

/**
 * Configured Gitea merge style. A `false` allow flag refuses the method
 * (no fallback); an unknown flag (older forge, fakes) trusts the setting.
 */
function giteaMergeMethodForConfiguredRepo(
  repo: {
    allowMergeCommits?: boolean;
    allowSquashMerge?: boolean;
    allowRebase?: boolean;
    allowRebaseExplicit?: boolean;
    allowFastForwardOnlyMerge?: boolean;
  },
  method: string
): string | undefined {
  // Compatibility wrapper; the table policy holds the implementation.
  return forgeCapabilities("gitea").mergePolicy.methodForConfiguredRepo(repo, method);
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
  /**
   * Branch that sources Jumi settings (the repository default branch).
   * Required-check validation never uses this ref; it uses the PR's actual
   * base branch (`prBaseBranch` when supplied, else the PR's `base.ref`).
   */
  baseBranch: string;
  /**
   * PR's actual base branch for required-check validation. When supplied it
   * wins; otherwise the PR's `base.ref` is read. An unreadable or missing
   * base fails closed without falling back to `baseBranch`.
   */
  prBaseBranch?: string;
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

function touchedSettingsNote(): string {
  return (
    `Jumi did not schedule auto-merge on this pull request because it changes the repository settings file ` +
    `\`${REPO_SETTINGS_PATH}\`. Turning auto-merge on, and every later settings change, takes a person's merge.`
  );
}

function invalidSettingsNote(error: string): string {
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
const MAX_LISTED_EXCLUDED_FILES = 10;

/**
 * Shared truncated backtick list for left-out files: names up to
 * `MAX_LISTED_EXCLUDED_FILES`, then "and N more". Same format as the
 * review's left-out note (`review.ts`).
 */
function formatExcludedFileList(excludedFiles: readonly string[]): string {
  const names = [...new Set(excludedFiles)];
  const shown = names.slice(0, MAX_LISTED_EXCLUDED_FILES);
  const quoted = shown.map((name) => `\`${name}\``).join(", ");
  return names.length > shown.length ? `${quoted} and ${names.length - shown.length} more` : quoted;
}

function excludedFilesNote(excludedFiles: readonly string[]): string {
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

function automergeDisabledNote(): string {
  return (
    `Jumi did not schedule auto-merge on this pull request because auto-merge is turned off ` +
    `for this Jumi deployment (\`JUMI_AUTOMERGE_ENABLED\` is off). The deployer needs to change that; ` +
    `until then a person needs to merge once reviews and CI are green.`
  );
}

function automergeRepoNotListedNote(): string {
  return (
    `Jumi did not schedule auto-merge on this pull request because this repository is not listed ` +
    `for auto-merge on this Jumi deployment (\`JUMI_AUTOMERGE_REPOS\` does not allow it). ` +
    `The deployer needs to change that; until then a person needs to merge once reviews and CI are green.`
  );
}

function automergeConflictNote(automergeLabel: string, noAutomergeLabel: string): string {
  return (
    `Jumi did not schedule auto-merge on this pull request because it carries both ` +
    `\`${automergeLabel}\` and \`${noAutomergeLabel}\`. Remove one of them; a person needs to merge once reviews and CI are green.`
  );
}

function automergeUntrustedNote(automergeLabel: string, adder: string | undefined): string {
  const who = adder && adder.trim() ? `@${adder.trim()}` : "its labeller";
  return (
    `Jumi did not schedule auto-merge on this pull request: the \`${automergeLabel}\` label was added by ` +
    `${who}, who may not turn auto-merge on. A person with write access needs to add the label, or a person needs to merge once reviews and CI are green.`
  );
}

function automergeLabellerUnreadableNote(automergeLabel: string): string {
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

function unrestoredGateClosedNote(baseBranch: string): string {
  return (
    `Jumi did not restore auto-merge on this pull request: the base branch \`${baseBranch}\` does not require the ` +
    `\`${JUMI_REVIEW_CONTEXT}\` check. A person needs to merge once reviews and CI are green.`
  );
}

function unrestoredGateUnreadableNote(): string {
  return (
    `Jumi did not restore auto-merge on this pull request: the base branch requirements could not be read. ` +
    `A person needs to merge once reviews and CI are green.`
  );
}

/**
 * Shared required-check gate: whether a branch requires Jumi's review check.
 * Returns `"open"` when the branch requires the check, `"closed"` when it
 * does not, and `"unreadable"` when the branch cannot be read. Both the
 * schedule gate and the restore re-arm read through here so the predicate
 * has one edit site; callers map the outcome onto their own note wording
 * ("did not schedule" vs "did not restore").
 */
type ReviewGateState = "open" | "closed" | "unreadable";

async function readReviewGate(
  api: AutomergeApi,
  owner: string,
  repo: string,
  branch: string,
  prNumber: number,
  log: (message: string) => void
): Promise<ReviewGateState> {
  try {
    const getBranch = api.getBranch;
    if (typeof getBranch !== "function") throw new Error("branch requirements are not readable");
    const fetched = await getBranch.call(api, owner, repo, branch);
    if (!branchRequiresReviewCheck(fetched)) {
      log(`automerge gate closed for ${owner}/${repo}#${prNumber}: review check not required`);
      return "closed";
    }
    return "open";
  } catch (err) {
    log(`automerge gate unreadable for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
    return "unreadable";
  }
}

export function hasAutomergeLabel(labels: AutomergeLabelList | null | undefined, name: string): boolean {
  return hasLabelCaseInsensitive(labels, name);
}

export function resolveAutomergeLabelNames(settings: RepoSettingsLoad): {
  automergeLabel: string;
  noAutomergeLabel: string;
} {
  return resolveLabelNames(settings);
}

/**
 * Shared "will this PR auto-merge?" opt-in answer used by both the schedule
 * path and the review suggestion hold. `true` means the repository opted in
 * through its default-branch file (`automerge: true`) or through an admitted
 * `automerge` label on the PR; `no-automerge` present (or both labels
 * together) always means `false`, and an invalid file never opts in. The
 * caller resolves `labelAdmitted` with `isAutomergeLabelAdmitted` (the same
 * labeller trust check and custom label names); absent labels keep the file
 * answer. Deployment switches, modes, and other schedule gates stay with
 * their callers.
 */
export function isAutomergeOptedIn(
  settings: RepoSettingsLoad,
  labels: AutomergeLabelList | null | undefined,
  labelAdmitted: boolean
): boolean {
  if (settings.state === "invalid") return false;
  const names = resolveLabelNames(settings);
  if (hasLabelCaseInsensitive(labels, names.noAutomergeLabel)) return false;
  if (hasLabelCaseInsensitive(labels, names.automergeLabel)) return labelAdmitted;
  return settings.state === "valid" && settings.automerge === true;
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
async function findLabelAdder(
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
    log(`automerge sender check failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
    return { admitted: false, adder, unreadable: true };
  }
}

/** Compatibility wrapper for the nine non-handler call sites: `true` only for `removed`. */
async function cancelAutomergeSchedule(
  api: AutomergeApi,
  forgeKind: ForgeKind,
  owner: string,
  repo: string,
  prNumber: number,
  log: (message: string) => void
): Promise<boolean> {
  return (await cancelAutomergeScheduleOutcome(api, forgeKind, owner, repo, prNumber, log)) === "removed";
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
  let effectiveTrusted = effectiveTrustedSenderLogins(input.trustedSenderLogins, { state: "missing" });
  try {
    const policy = await resolveRepoPolicy(
      { api, owner: input.owner, repo: input.repo, ref: input.baseBranch },
      fallbackPolicyDeployment({ trustedSenderLogins: input.trustedSenderLogins }),
      { onUnreadable: "throw" }
    );
    if (policy.status === "ok") {
      names = { automergeLabel: policy.automergeLabel, noAutomergeLabel: policy.noAutomergeLabel };
    }
    effectiveTrusted = policy.trustedSenderLogins;
  } catch (err) {
    log(`automerge settings unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${errorMessage(err)}`);
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
      trustedSenderLogins: effectiveTrusted,
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
    log(`automerge pull files unreadable for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
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
    log(`automerge pull unreadable for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
    return undefined;
  }
}

/**
 * PR labels plus the PR's actual base branch for required-check validation.
 * Prefers the caller's pre-fetched labels and explicit `prBaseBranch`; when
 * either is missing the PR is read once. Resolves `undefined` labels when the
 * PR cannot be read, and `undefined` base when the base ref is missing, so
 * callers fail closed without falling back to the settings (default-branch)
 * ref.
 */
async function loadPrLabelsAndBase(
  api: AutomergeApi,
  owner: string,
  repo: string,
  prNumber: number,
  prLabels: AutomergeLabelList | null | undefined,
  prBaseBranch: string | undefined,
  log: (message: string) => void
): Promise<{ labels: AutomergeLabelList | undefined; baseRef: string | undefined }> {
  const explicitBase = prBaseBranch?.trim() ? prBaseBranch.trim() : undefined;
  if (prLabels !== undefined && prLabels !== null) {
    if (explicitBase) return { labels: prLabels, baseRef: explicitBase };
    try {
      const pr = await api.getPR(owner, repo, prNumber);
      return { labels: prLabels, baseRef: prBaseRefOf(pr) };
    } catch (err) {
      log(`automerge pull unreadable for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
      return { labels: prLabels, baseRef: undefined };
    }
  }
  try {
    const pr = await api.getPR(owner, repo, prNumber);
    return {
      labels: (pr.labels ?? []) as AutomergeLabelList,
      baseRef: explicitBase ?? prBaseRefOf(pr),
    };
  } catch (err) {
    log(`automerge pull unreadable for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
    return { labels: undefined, baseRef: explicitBase };
  }
}

/**
 * Whether the repository opted in, for the deployment-blocked note path.
 * Opt-in is a valid default-branch file with `automerge: true`, or an
 * admitted `automerge` label on the PR (the copy from the worked issue
 * carries its verdict via `copiedTrusted`/`issueNumber`). `no-automerge`
 * present means opted out even when the file is on. Missing/`false`/invalid
 * files alone never opt in. Unreadable PRs fail closed with the generic
 * unreadable note so callers stay silent otherwise.
 */
async function maybeNoteDeploymentBlocked(opts: {
  api: AutomergeApi;
  owner: string;
  repo: string;
  prNumber: number;
  baseBranch: string;
  botUsername: string;
  trustedSenderLogins?: readonly string[];
  issueNumber?: number;
  copiedTrusted?: boolean;
  prLabelsPrefetch?: AutomergeLabelList | null;
  log: (message: string) => void;
  gate: "disabled" | "not-listed";
}): Promise<{ posted: boolean }> {
  const { api, owner, repo, prNumber, baseBranch, botUsername, log, gate } = opts;
  const policy = await resolveRepoPolicy(
    { api, owner, repo, ref: baseBranch },
    fallbackPolicyDeployment({ trustedSenderLogins: opts.trustedSenderLogins }),
    { onUnreadable: "fallback" }
  ).catch(() => undefined);
  const settings: RepoSettingsLoad | undefined = policy?.load;
  const names =
    policy !== undefined && policy.status === "ok"
      ? { automergeLabel: policy.automergeLabel, noAutomergeLabel: policy.noAutomergeLabel }
      : { automergeLabel: DEFAULT_AUTOMERGE_LABEL, noAutomergeLabel: DEFAULT_NO_AUTOMERGE_LABEL };
  const labels = await loadPrLabels(api, owner, repo, prNumber, opts.prLabelsPrefetch, log);
  if (labels === undefined) {
    log(`automerge pull unreadable for ${owner}/${repo}#${prNumber}: failing closed`);
    await postAutomergeNote(
      api,
      owner,
      repo,
      prNumber,
      botUsername,
      `Jumi did not schedule auto-merge on this pull request: the pull request could not be read. A person needs to merge once reviews and CI are green.`
    );
    return { posted: true };
  }
  if (hasLabelCaseInsensitive(labels, names.noAutomergeLabel)) return { posted: false };
  if (settings?.state === "valid" && settings.automerge === true) {
    if (gate === "not-listed") {
      log(`automerge skipped for ${owner}/${repo}#${prNumber}: repository not in deployment allowlist`);
      await postAutomergeNote(api, owner, repo, prNumber, botUsername, automergeRepoNotListedNote());
    } else {
      log(`automerge skipped for ${owner}/${repo}#${prNumber}: deployment switch off`);
      await postAutomergeNote(api, owner, repo, prNumber, botUsername, automergeDisabledNote());
    }
    return { posted: true };
  }
  if (!hasLabelCaseInsensitive(labels, names.automergeLabel)) return { posted: false };
  const effectiveTrusted =
    policy !== undefined
      ? policy.trustedSenderLogins
      : effectiveTrustedSenderLogins(opts.trustedSenderLogins, { state: "missing" });
  const verdict = await isAutomergeLabelAdmitted({
    api,
    owner,
    repo,
    prNumber,
    issueNumber: opts.issueNumber,
    automergeLabel: names.automergeLabel,
    botUsername,
    trustedSenderLogins: effectiveTrusted,
    copiedTrusted: opts.copiedTrusted,
    log,
  });
  if (!verdict.admitted) return { posted: false };
  if (gate === "not-listed") {
    log(`automerge skipped for ${owner}/${repo}#${prNumber}: repository not in deployment allowlist`);
    await postAutomergeNote(api, owner, repo, prNumber, botUsername, automergeRepoNotListedNote());
  } else {
    log(`automerge skipped for ${owner}/${repo}#${prNumber}: deployment switch off`);
    await postAutomergeNote(api, owner, repo, prNumber, botUsername, automergeDisabledNote());
  }
  return { posted: true };
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

  // Deployment gates first. When the repository opted in (valid file with
  // `automerge: true`, or an admitted `automerge` label on the PR carrying
  // the worked issue's verdict) but the deployment blocks, post one sticky
  // note saying the deployer has to act. Otherwise stay silent as today:
  // no file, `automerge: false`, or `no-automerge` never notes.
  if (!isAutomergeRepo(input.owner, input.repo, input.automergeRepos) || !enabled) {
    const gate = !isAutomergeRepo(input.owner, input.repo, input.automergeRepos) ? "not-listed" : "disabled";
    await maybeNoteDeploymentBlocked({
      api,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      baseBranch: input.baseBranch,
      botUsername: input.botUsername,
      trustedSenderLogins: input.trustedSenderLogins,
      issueNumber: input.issueNumber,
      copiedTrusted: input.copiedAutomergeTrusted,
      prLabelsPrefetch: input.prLabels,
      log,
      gate,
    });
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
    settings = (
      await resolveRepoPolicy(
        { api, owner: input.owner, repo: input.repo, ref: input.baseBranch },
        fallbackPolicyDeployment({ trustedSenderLogins: input.trustedSenderLogins }),
        { onUnreadable: "throw" }
      )
    ).load;
  } catch (err) {
    log(`automerge settings unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${errorMessage(err)}`);
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
  const { labels: prLabels, baseRef: prBaseRef } = await loadPrLabelsAndBase(
    api,
    input.owner,
    input.repo,
    input.prNumber,
    input.prLabels,
    input.prBaseBranch,
    log
  );
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
  const gateBranch = prBaseRef?.trim() ? prBaseRef.trim() : undefined;
  if (!gateBranch) {
    log(`automerge gate unreadable for ${input.owner}/${input.repo}#${input.prNumber}: PR base unreadable`);
    await postAutomergeNote(
      api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      `Jumi did not schedule auto-merge on this pull request: the base branch requirements could not be read. A person needs to merge once reviews and CI are green.`
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
    // Repository `trusted_senders` narrows the deployment list (intersection,
    // never widening): the same settings read that named the labels supplies
    // the effective trust list.
    const effectiveTrusted = effectiveTrustedSenderLogins(input.trustedSenderLogins, settings);
    const verdict = await isAutomergeLabelAdmitted({
      api,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      issueNumber: input.issueNumber,
      automergeLabel: names.automergeLabel,
      botUsername: input.botUsername,
      trustedSenderLogins: effectiveTrusted,
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
  if (!isAutomergeOptedIn(settings, prLabels, forcedByLabel)) {
    log(
      `automerge skipped for ${input.owner}/${input.repo}#${input.prNumber}: no automerge label on PR and file does not opt in`
    );
    return { scheduled: false };
  }
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
    gateBranch,
    input.botUsername,
    log,
    settings
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
    log(`automerge schedule failed for ${input.owner}/${input.repo}#${input.prNumber}: ${errorMessage(err)}`);
    // Only the Gitea cancel-only branch retries the refused schedule after
    // Jumi's next push; on forges with a readable schedule state (GitHub) the
    // note must not promise a push retry that never runs.
    const retryAfterPush = !forgeCapabilities(input.forgeKind).supportsAutoMergeRestore;
    await postAutomergeNote(
      api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      automergeRefusedNote(forgeRefusalDetail(err), retryAfterPush)
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
  log: (message: string) => void,
  settings: RepoSettingsLoad
): Promise<{ ok: true; mergeMethod: string } | { ok: false; note: string }> {
  void botUsername;
  const gateState = await readReviewGate(api, owner, repo, baseBranch, prNumber, log);
  if (gateState === "closed") {
    return {
      ok: false,
      note:
        `Jumi did not schedule auto-merge on this pull request: the base branch \`${baseBranch}\` does not require the ` +
        `\`${JUMI_REVIEW_CONTEXT}\` check. A person needs to merge once reviews and CI are green.`,
    };
  }
  if (gateState === "unreadable") {
    return {
      ok: false,
      note: `Jumi did not schedule auto-merge on this pull request: the base branch requirements could not be read. A person needs to merge once reviews and CI are green.`,
    };
  }

  try {
    const repoInfo = await api.getRepo(owner, repo);
    const policy = forgeCapabilities(forge).mergePolicy;
    const configured = settings.state === "valid" ? settings.automergeMethod : undefined;
    if (configured !== undefined) {
      if (policy.isAutoMergeDisabled(repoInfo)) {
        return {
          ok: false,
          note: `Jumi did not schedule auto-merge on this pull request: auto-merge is disabled on this repository. A person needs to merge once reviews and CI are green.`,
        };
      }
      const method = policy.methodForConfiguredRepo(repoInfo, configured);
      if (!method) {
        return { ok: false, note: automergeMethodNotAllowedNote(configured) };
      }
      return { ok: true, mergeMethod: method };
    }
    if (policy.isAutoMergeDisabled(repoInfo)) {
      return {
        ok: false,
        note: `Jumi did not schedule auto-merge on this pull request: auto-merge is disabled on this repository. A person needs to merge once reviews and CI are green.`,
      };
    }
    const fallback = policy.defaultMethod(repoInfo);
    if (!fallback.ok) {
      if (fallback.reason === "no-method") {
        return {
          ok: false,
          note: `Jumi did not schedule auto-merge on this pull request: the repository allows no merge method. A person needs to merge once reviews and CI are green.`,
        };
      }
      return {
        ok: false,
        note: `Jumi did not schedule auto-merge on this pull request: the repository's default merge style is unknown. A person needs to merge once reviews and CI are green.`,
      };
    }
    return { ok: true, mergeMethod: fallback.mergeMethod };
  } catch (err) {
    log(`automerge repo unreadable for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
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
async function copyIssueAutomergeLabelsToPr(opts: {
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
    log(`automerge issue labels unreadable for ${opts.owner}/${opts.repo}#${opts.issueNumber}: ${errorMessage(err)}`);
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
      log(`automerge label copy failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
      return false;
    }
  };
  let copiedAutomerge = false;
  let copiedNoAutomerge = false;
  if (wantAutomerge) copiedAutomerge = await copyOne(opts.automergeLabel);
  if (wantNoAutomerge) copiedNoAutomerge = await copyOne(opts.noAutomergeLabel);
  if (wantAutomerge && !copiedAutomerge) {
    log(
      `automerge label copy incomplete for ${opts.owner}/${opts.repo}#${opts.prNumber}: issue #${opts.issueNumber} has \`${opts.automergeLabel}\` but the PR was not labeled`
    );
  }
  if (wantNoAutomerge && !copiedNoAutomerge) {
    log(
      `automerge label copy incomplete for ${opts.owner}/${opts.repo}#${opts.prNumber}: issue #${opts.issueNumber} has \`${opts.noAutomergeLabel}\` but the PR was not labeled`
    );
  }
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
 * Input for retrying a refused auto-merge schedule. The schedule at open was
 * refused but Jumi's own sticky says so: a later push — or a later follow-up
 * round with no push — may have made the PR mergeable, so run the full gate
 * again. Any other sticky (or none) keeps today's behaviour, so a
 * person-cancelled schedule is still left alone.
 */
export interface RetryRefusedAutomergeInput {
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
  /**
   * Branch that sources Jumi settings (the repository default branch). Read
   * from the repository when absent.
   */
  baseBranch?: string;
  /** Pre-fetched PR labels (avoids an extra getPR when the caller already has them). */
  prLabels?: AutomergeLabelList | null;
  /** PR's actual base branch for required-check validation. Read from the PR when absent. */
  prBaseBranch?: string;
  log?: (message: string) => void;
}

/**
 * Retry a refused auto-merge schedule: when the PR's automerge sticky still
 * holds Jumi's own refused-schedule note (bot-authored, both markers), run
 * the full `scheduleAutomergeForPr` gate — PR labels, default-branch
 * settings, the PR's actual base for required checks, `issueNumber` for the
 * labeller fallback — and upsert the scheduled note on success. Only the
 * refused-note state triggers a schedule. Never throws; failures stay
 * silent. Shared by the post-push restore and the no-changes follow-up
 * branch so a round makes at most one schedule call.
 */
export async function retryRefusedAutomergeSchedule(
  input: RetryRefusedAutomergeInput
): Promise<{ scheduled: boolean }> {
  const log = input.log ?? (() => undefined);
  try {
    const enabled = input.automergeEnabled ?? true;
    if (!enabled) return { scheduled: false };
    if (!isAutomergeRepo(input.owner, input.repo, input.automergeRepos)) return { scheduled: false };
    if (!(await hasRefusedAutomergeNote(input.api, input.owner, input.repo, input.prNumber, input.botUsername, log))) {
      return { scheduled: false };
    }
    let baseBranch = input.baseBranch?.trim() ? input.baseBranch.trim() : undefined;
    if (!baseBranch) {
      try {
        const info = await input.api.getRepo(input.owner, input.repo);
        baseBranch =
          typeof info.default_branch === "string" && info.default_branch.trim() ? info.default_branch.trim() : "main";
      } catch (err) {
        log(`automerge repo unreadable for ${input.owner}/${input.repo}: ${errorMessage(err)}`);
        return { scheduled: false };
      }
    }
    let prLabels: AutomergeLabelList | undefined =
      input.prLabels === undefined || input.prLabels === null ? undefined : input.prLabels;
    let prBaseBranch: string | undefined = input.prBaseBranch?.trim() ? input.prBaseBranch.trim() : undefined;
    if (prLabels === undefined || prBaseBranch === undefined) {
      try {
        const pr = await input.api.getPR(input.owner, input.repo, input.prNumber);
        if (prLabels === undefined) {
          prLabels = ((pr as { labels?: AutomergeLabelList | null }).labels ?? []) as AutomergeLabelList;
        }
        if (prBaseBranch === undefined) prBaseBranch = prBaseRefOf(pr);
      } catch (err) {
        log(`automerge re-read failed for ${input.owner}/${input.repo}#${input.prNumber}: ${errorMessage(err)}`);
        return { scheduled: false };
      }
    }
    const result = await scheduleAutomergeForPr({
      api: input.api,
      forgeKind: input.forgeKind,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      // Settings come from the default branch; required-check validation
      // uses the PR's actual base branch (`prBaseBranch`, no fallback).
      baseBranch,
      ...(prBaseBranch ? { prBaseBranch } : {}),
      automergeRepos: input.automergeRepos,
      botUsername: input.botUsername,
      automergeEnabled: input.automergeEnabled,
      trustedSenderLogins: input.trustedSenderLogins,
      issueNumber: input.issueNumber,
      prLabels,
      log,
    });
    if (result.scheduled) {
      await postAutomergeNote(
        input.api,
        input.owner,
        input.repo,
        input.prNumber,
        input.botUsername,
        automergeScheduledNote()
      );
    }
    return result;
  } catch (err) {
    log(`automerge refused retry failed for ${input.owner}/${input.repo}#${input.prNumber}: ${errorMessage(err)}`);
    return { scheduled: false };
  }
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
  if (forgeCapabilities(input.forgeKind).readableAutoMergeSchedule && !input.wasScheduled) return;
  const files = await loadPrFiles(noteApi, input.owner, input.repo, input.prNumber, log);
  // Unreadable pull files fail closed: neither cancel nor restore.
  if (files === undefined) return;
  if (prTouchesRepoSettings(files)) {
    if (forgeCapabilities(input.forgeKind).readableAutoMergeSchedule) {
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
  if (!forgeCapabilities(input.forgeKind).supportsAutoMergeRestore) {
    // Gitea never restores, but a push that brings a left-out file — or a
    // `no_automerge`/conflict label state — into the pull still cancels a
    // schedule Jumi set earlier. Like the settings file, the cancel result
    // drives the note (conflict still names itself). One repo+settings read
    // serves both the excluded and the label checks.
    let prLabels: AutomergeLabelList = [];
    let prBaseBranch: string | undefined;
    try {
      const pr = await noteApi.getPR(input.owner, input.repo, input.prNumber);
      prLabels = ((pr as { labels?: AutomergeLabelList | null }).labels ?? []) as AutomergeLabelList;
      prBaseBranch = prBaseRefOf(pr);
    } catch (err) {
      log(`automerge re-read failed for ${input.owner}/${input.repo}#${input.prNumber}: ${errorMessage(err)}`);
      return;
    }
    let defaultBranch = "main";
    try {
      const info = await noteApi.getRepo(input.owner, input.repo);
      if (typeof info.default_branch === "string" && info.default_branch) defaultBranch = info.default_branch;
    } catch (err) {
      log(`automerge repo unreadable for ${input.owner}/${input.repo}: ${errorMessage(err)}`);
      return;
    }
    let settings: RepoSettingsLoad | undefined;
    try {
      settings = (
        await resolveRepoPolicy(
          { api: noteApi, owner: input.owner, repo: input.repo, ref: defaultBranch },
          fallbackPolicyDeployment({ trustedSenderLogins: input.trustedSenderLogins }),
          { onUnreadable: "throw" }
        )
      ).load;
    } catch (err) {
      log(`automerge settings unreadable for ${input.owner}/${input.repo}: ${errorMessage(err)}`);
      return;
    }
    if (settings.state === "invalid") return;
    const names = resolveLabelNames(settings);
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
      return;
    }
    // The schedule at open was refused but Jumi's own sticky says so: this
    // push may have made the PR mergeable, so run the full gate again.
    // Any other sticky (or none) keeps today's behaviour, so a
    // person-cancelled schedule is still left alone.
    await retryRefusedAutomergeSchedule({
      api: noteApi,
      forgeKind: input.forgeKind,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      automergeRepos: input.automergeRepos,
      botUsername: input.botUsername,
      automergeEnabled: input.automergeEnabled,
      trustedSenderLogins: input.trustedSenderLogins,
      issueNumber: input.issueNumber,
      baseBranch: defaultBranch,
      prLabels,
      ...(prBaseBranch ? { prBaseBranch } : {}),
      log,
    });
    return;
  }
  let current: { merged?: boolean; state?: string; autoMergeEnabled?: boolean; labels?: AutomergeLabelList | null };
  try {
    current = await input.api.getPR(input.owner, input.repo, input.prNumber);
  } catch (err) {
    log(`automerge re-read failed for ${input.owner}/${input.repo}#${input.prNumber}: ${errorMessage(err)}`);
    return;
  }
  if (current.merged || current.state !== "open") return;
  let fetchedRepo: Awaited<ReturnType<AutomergeApi["getRepo"]>>;
  try {
    fetchedRepo = await input.api.getRepo(input.owner, input.repo);
    if (forgeCapabilities(input.forgeKind).mergePolicy.isAutoMergeDisabled(fetchedRepo)) return;
  } catch {
    return;
  }
  const defaultBranch =
    typeof fetchedRepo.default_branch === "string" && fetchedRepo.default_branch ? fetchedRepo.default_branch : "main";
  let settings: RepoSettingsLoad;
  try {
    settings = (
      await resolveRepoPolicy(
        { api: noteApi, owner: input.owner, repo: input.repo, ref: defaultBranch },
        fallbackPolicyDeployment({ trustedSenderLogins: input.trustedSenderLogins }),
        { onUnreadable: "throw" }
      )
    ).load;
  } catch (err) {
    log(`automerge settings unreadable for ${input.owner}/${input.repo}#${input.prNumber}: ${errorMessage(err)}`);
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
      trustedSenderLogins: effectiveTrustedSenderLogins(input.trustedSenderLogins, settings),
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
  // Re-arm validates against the PR's actual base branch, never the default
  // branch that sourced settings. An unreadable base fails closed without
  // falling back to the default branch's rules.
  {
    const gateBranch = prBaseRefOf(current);
    if (!gateBranch) {
      log(`automerge gate unreadable for ${input.owner}/${input.repo}#${input.prNumber}: PR base unreadable`);
      await postAutomergeNote(
        noteApi,
        input.owner,
        input.repo,
        input.prNumber,
        input.botUsername,
        unrestoredGateUnreadableNote()
      );
      return;
    }
    const gateState = await readReviewGate(noteApi, input.owner, input.repo, gateBranch, input.prNumber, log);
    if (gateState === "closed") {
      await postAutomergeNote(
        noteApi,
        input.owner,
        input.repo,
        input.prNumber,
        input.botUsername,
        unrestoredGateClosedNote(gateBranch)
      );
      return;
    }
    if (gateState === "unreadable") {
      await postAutomergeNote(
        noteApi,
        input.owner,
        input.repo,
        input.prNumber,
        input.botUsername,
        unrestoredGateUnreadableNote()
      );
      return;
    }
  }
  let mergeMethod: string;
  {
    const policy = forgeCapabilities(input.forgeKind).mergePolicy;
    const configured = settings.state === "valid" ? settings.automergeMethod : undefined;
    if (configured !== undefined) {
      const resolved = policy.methodForConfiguredRepo(fetchedRepo, configured);
      if (!resolved) {
        await postAutomergeNote(
          noteApi,
          input.owner,
          input.repo,
          input.prNumber,
          input.botUsername,
          unrestoredMethodNotAllowedNote(configured)
        );
        return;
      }
      mergeMethod = resolved;
    } else {
      const fallback = policy.defaultMethod(fetchedRepo);
      mergeMethod = fallback.ok ? fallback.mergeMethod : "MERGE";
    }
  }
  try {
    const schedule = input.api.scheduleAutoMerge;
    if (typeof schedule !== "function") return;
    await schedule.call(input.api, input.owner, input.repo, input.prNumber, { mergeMethod });
    log(`automerge restored for ${input.owner}/${input.repo}#${input.prNumber} (${mergeMethod})`);
  } catch (err) {
    log(`automerge restore failed for ${input.owner}/${input.repo}#${input.prNumber}: ${errorMessage(err)}`);
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
  if (!forgeCapabilities(forgeKind).readableAutoMergeSchedule) return false;
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
 * React to adding or removing either override label on an open Jumi PR:
 * re-run every gate (schedule) or cancel the schedule. Only PRs Jumi opened
 * reach here; takeovers and handoffs are filtered by the caller. The bot's
 * own copy event is ignored by the caller. Never throws.
 */
export async function handleAutomergeLabelChange(opts: {
  api: Partial<AutomergeApi>;
  forgeKind: ForgeKind;
  owner: string;
  repo: string;
  prNumber: number;
  /**
   * Branch that sources Jumi settings (the repository default branch).
   * Required-check validation uses the PR's actual base branch read from the
   * PR, never this ref.
   */
  baseBranch: string;
  /** Explicit PR base for required-check validation; read from the PR when absent. */
  prBaseBranch?: string;
  automergeRepos: readonly string[] | undefined;
  automergeEnabled?: boolean;
  trustedSenderLogins?: readonly string[];
  botUsername: string;
  issueNumber?: number;
  log?: (message: string) => void;
}): Promise<{
  action:
    | "scheduled"
    | "cancelled"
    | "cancel-unsupported"
    | "cancel-failed"
    | "deployment-blocked"
    | "unreadable"
    | "none";
}> {
  const log = opts.log ?? (() => undefined);
  const api = opts.api;
  // Fail-closed when the caller holds a partial forge client (webhook
  // mailbox): missing required methods mean no schedule, same as the
  // `try/catch` around a missing method returning `none` today.
  if (!isFullAutomergeApi(api)) {
    log(
      `automerge label change skipped for ${opts.owner}/${opts.repo}#${opts.prNumber}: forge client missing required methods`
    );
    return { action: "none" };
  }
  const evaluation = await evaluateAutomergeLabelState({
    api,
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.prNumber,
    baseBranch: opts.baseBranch,
    ...(opts.prBaseBranch?.trim() ? { prBaseBranch: opts.prBaseBranch.trim() } : {}),
    automergeRepos: opts.automergeRepos,
    automergeEnabled: opts.automergeEnabled,
    trustedSenderLogins: opts.trustedSenderLogins,
    log,
  });
  if (evaluation.decision === "unreadable") return { action: "unreadable" };
  if (evaluation.closed) return { action: "none" };
  const prLabels = evaluation.prLabels;
  const prBaseBranch = evaluation.prBaseBranch;
  if (!evaluation.listed || !evaluation.enabled) {
    // Mirror the open-time deployment-blocked path: when the repository opted
    // in (file on, or an admitted `automerge` label) but the deployment
    // blocks, leave one sticky note saying the deployer has to act.
    const gate = !evaluation.listed ? ("not-listed" as const) : ("disabled" as const);
    const res = await maybeNoteDeploymentBlocked({
      api,
      owner: opts.owner,
      repo: opts.repo,
      prNumber: opts.prNumber,
      baseBranch: opts.baseBranch,
      botUsername: opts.botUsername,
      trustedSenderLogins: opts.trustedSenderLogins,
      issueNumber: opts.issueNumber,
      prLabelsPrefetch: prLabels,
      log,
      gate,
    });
    return { action: res.posted ? "deployment-blocked" : "none" };
  }
  const settings = evaluation.settings;
  if (evaluation.invalid || !settings || settings.state === "invalid") {
    const detail = settings?.state === "invalid" ? settings.error : "invalid";
    await postAutomergeNote(api, opts.owner, opts.repo, opts.prNumber, opts.botUsername, invalidSettingsNote(detail));
    return { action: "none" };
  }
  const names = resolveLabelNames(settings);
  if (evaluation.decision === "conflict-cancel") {
    const outcome = await cancelAutomergeScheduleOutcome(
      api,
      opts.forgeKind,
      opts.owner,
      opts.repo,
      opts.prNumber,
      log
    );
    await postAutomergeNote(
      api,
      opts.owner,
      opts.repo,
      opts.prNumber,
      opts.botUsername,
      automergeConflictNote(names.automergeLabel, names.noAutomergeLabel)
    );
    return {
      action: outcome === "failed" ? "cancel-failed" : outcome === "unsupported" ? "cancel-unsupported" : "cancelled",
    };
  }
  if (evaluation.decision === "cancel") {
    // No-automerge label, or the label was removed and the file does not opt in:
    // cancel anything scheduled.
    const outcome = await cancelAutomergeScheduleOutcome(
      api,
      opts.forgeKind,
      opts.owner,
      opts.repo,
      opts.prNumber,
      log
    );
    return {
      action: outcome === "failed" ? "cancel-failed" : outcome === "unsupported" ? "cancel-unsupported" : "cancelled",
    };
  }
  const hadRefused = await hasRefusedAutomergeNote(api, opts.owner, opts.repo, opts.prNumber, opts.botUsername, log);
  const result = await scheduleAutomergeForPr({
    api,
    forgeKind: opts.forgeKind,
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.prNumber,
    baseBranch: opts.baseBranch,
    ...(prBaseBranch ? { prBaseBranch } : {}),
    automergeRepos: opts.automergeRepos,
    botUsername: opts.botUsername,
    automergeEnabled: opts.automergeEnabled,
    trustedSenderLogins: opts.trustedSenderLogins,
    issueNumber: opts.issueNumber,
    prLabels,
    log,
  });
  if (result.scheduled && hadRefused) {
    await postAutomergeNote(api, opts.owner, opts.repo, opts.prNumber, opts.botUsername, automergeScheduledNote());
  }
  return { action: result.scheduled ? "scheduled" : "none" };
}
