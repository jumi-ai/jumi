import type { ForgeKind } from "./forge.ts";
import { isJumiPrIdentity } from "./gitea_issues.ts";
import type { Forge, IssueApi } from "./ports.ts";
import { fallbackPolicyDeployment, resolveRepoPolicy } from "./repo_policy.ts";
import {
  DEFAULT_AUTOMERGE_LABEL,
  DEFAULT_NO_AUTOMERGE_LABEL,
  type RepoSettingsLoad,
} from "./repo_settings.ts";
import { errorMessage } from "./util/error.ts";

/**
 * Shared automerge label read/decision helpers (issue #837). The label-change
 * webhook handler (`automerge.ts`) and the cancellation-only reconcile
 * drainer both read through `evaluateAutomergeLabelState`, so the PR
 * re-read, the listed/enabled gate, policy resolution, and
 * `automergeLabelEventAction` have one home. Nothing here posts notes or
 * schedules; the drainer's `reconcileAutomergeCancellation` cancels only.
 */

export type AutomergeApi = Pick<
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
  Partial<Pick<Forge, "getPRFiles" | "getRepoFile" | "cancelAutoMerge" | "listIssueTimeline" | "listIssueComments">>;

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

function labelNameOf(label: string | { name?: string }): string {
  return typeof label === "string" ? label : (label.name ?? "");
}

export function hasLabelCaseInsensitive(labels: AutomergeLabelList | null | undefined, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  return (labels ?? []).some((label) => labelNameOf(label).trim().toLowerCase() === needle);
}

export function resolveLabelNames(settings: RepoSettingsLoad): {
  automergeLabel: string;
  noAutomergeLabel: string;
} {
  if (settings.state === "valid") {
    return { automergeLabel: settings.automergeLabel, noAutomergeLabel: settings.noAutomergeLabel };
  }
  return { automergeLabel: DEFAULT_AUTOMERGE_LABEL, noAutomergeLabel: DEFAULT_NO_AUTOMERGE_LABEL };
}

/**
 * PR's actual base branch ref, or undefined when missing. Safe against
 * partial PR shapes from webhook mailboxes and fakes.
 */
export function prBaseRefOf(pr: unknown): string | undefined {
  if (!pr || typeof pr !== "object") return undefined;
  const base = (pr as { base?: unknown }).base;
  if (!base || typeof base !== "object") return undefined;
  const ref = (base as { ref?: unknown }).ref;
  return typeof ref === "string" && ref.trim() ? ref.trim() : undefined;
}

export type CancelAutomergeOutcome = "removed" | "absent" | "unsupported" | "failed";

/**
 * Truthful cancel outcome for a schedule Jumi set earlier. Never throws.
 * Missing entrypoint -> `unsupported`; resolved `true` -> `removed`;
 * resolved `false` -> `absent`; anything else (older fakes resolving `void`)
 * -> `removed`; threw -> `failed` (logged, never rethrown).
 */
export async function cancelAutomergeScheduleOutcome(
  api: AutomergeApi,
  forgeKind: ForgeKind,
  owner: string,
  repo: string,
  prNumber: number,
  log: (message: string) => void
): Promise<CancelAutomergeOutcome> {
  void forgeKind;
  try {
    const cancel = api.cancelAutoMerge;
    if (typeof cancel !== "function") {
      log(`automerge cancel unsupported for ${owner}/${repo}#${prNumber}: forge does not expose cancellation`);
      return "unsupported";
    }
    const removed = await cancel.call(api, owner, repo, prNumber);
    if (removed === false) {
      log(`automerge cancelled for ${owner}/${repo}#${prNumber} (nothing to remove)`);
      return "absent";
    }
    // Older fakes resolve `void`: only an explicit `false` means "nothing
    // to remove"; anything else keeps the previous claim-a-cancel behaviour.
    log(`automerge cancelled for ${owner}/${repo}#${prNumber}`);
    return "removed";
  } catch (err) {
    // A missing schedule is the steady state; any other failure stays in the
    // server log and never fails the job.
    log(`automerge cancel failed for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
    return "failed";
  }
}

/**
 * Decide what a label webhook on a Jumi PR should do. Returns
 * `"schedule"` when the effective decision (labels included) wants a schedule
 * and `"cancel"` when it wants none. Both labels together want cancel plus
 * the conflict note. `no_automerge` alone wants a silent cancel. Callers
 * re-run the full gate via `scheduleAutomergeForPr` for `"schedule"`.
 */
function automergeLabelEventAction(
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
 * Shared read/decision part of the label-change path: re-read the PR, apply
 * the listed/enabled gate, resolve policy (`onUnreadable: "throw"`), and
 * compute `automergeLabelEventAction`. Posts no notes and never schedules;
 * the webhook handler adds notes/schedules on top, while the reconcile
 * drainer consumes the decision in cancellation-only mode.
 */
type AutomergeLabelDecision = "schedule" | "cancel" | "conflict-cancel" | "no-op" | "unreadable";

export interface AutomergeLabelEvaluation {
  decision: AutomergeLabelDecision;
  prLabels: AutomergeLabelList;
  prBaseBranch?: string;
  prUser?: { login?: string };
  prHeadRef?: string;
  settings?: RepoSettingsLoad;
  listed: boolean;
  enabled: boolean;
  closed: boolean;
  invalid: boolean;
}

export async function evaluateAutomergeLabelState(opts: {
  api: AutomergeApi;
  owner: string;
  repo: string;
  prNumber: number;
  baseBranch: string;
  prBaseBranch?: string;
  automergeRepos: readonly string[] | undefined;
  automergeEnabled?: boolean;
  trustedSenderLogins?: readonly string[];
  log?: (message: string) => void;
}): Promise<AutomergeLabelEvaluation> {
  const log = opts.log ?? (() => undefined);
  const listed = isAutomergeRepo(opts.owner, opts.repo, opts.automergeRepos);
  const enabled = opts.automergeEnabled ?? true;
  let prLabels: AutomergeLabelList = [];
  let prBaseBranch = opts.prBaseBranch?.trim() ? opts.prBaseBranch.trim() : undefined;
  let prUser: { login?: string } | undefined;
  let prHeadRef: string | undefined;
  try {
    const pr = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
    if (pr.merged || pr.state !== "open") {
      return {
        decision: "no-op",
        prLabels: ((pr as { labels?: AutomergeLabelList | null }).labels ?? []) as AutomergeLabelList,
        ...(prBaseBranch ? { prBaseBranch } : {}),
        ...(pr.user ? { prUser: { login: pr.user.login } } : {}),
        ...(typeof pr.head?.ref === "string" ? { prHeadRef: pr.head.ref } : {}),
        listed,
        enabled,
        closed: true,
        invalid: false,
      };
    }
    prLabels = ((pr as { labels?: AutomergeLabelList | null }).labels ?? []) as AutomergeLabelList;
    if (!prBaseBranch) prBaseBranch = prBaseRefOf(pr);
    if (pr.user) prUser = { login: pr.user.login };
    if (typeof pr.head?.ref === "string") prHeadRef = pr.head.ref;
  } catch (err) {
    log(`automerge label re-read failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
    return { decision: "unreadable", prLabels: [], listed, enabled, closed: false, invalid: false };
  }
  if (!listed || !enabled) {
    return {
      decision: "no-op",
      prLabels,
      ...(prBaseBranch ? { prBaseBranch } : {}),
      ...(prUser ? { prUser } : {}),
      ...(prHeadRef ? { prHeadRef } : {}),
      listed,
      enabled,
      closed: false,
      invalid: false,
    };
  }
  let settings: RepoSettingsLoad;
  try {
    settings = (
      await resolveRepoPolicy(
        { api: opts.api, owner: opts.owner, repo: opts.repo, ref: opts.baseBranch },
        fallbackPolicyDeployment({ trustedSenderLogins: opts.trustedSenderLogins }),
        { onUnreadable: "throw" }
      )
    ).load;
  } catch (err) {
    log(`automerge settings unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
    return {
      decision: "unreadable",
      prLabels,
      ...(prBaseBranch ? { prBaseBranch } : {}),
      ...(prUser ? { prUser } : {}),
      ...(prHeadRef ? { prHeadRef } : {}),
      listed,
      enabled,
      closed: false,
      invalid: false,
    };
  }
  if (settings.state === "invalid") {
    return {
      decision: "no-op",
      prLabels,
      ...(prBaseBranch ? { prBaseBranch } : {}),
      ...(prUser ? { prUser } : {}),
      ...(prHeadRef ? { prHeadRef } : {}),
      settings,
      listed,
      enabled,
      closed: false,
      invalid: true,
    };
  }
  const action = automergeLabelEventAction(prLabels, settings);
  return {
    decision: action.conflict ? "conflict-cancel" : action.action,
    prLabels,
    ...(prBaseBranch ? { prBaseBranch } : {}),
    ...(prUser ? { prUser } : {}),
    ...(prHeadRef ? { prHeadRef } : {}),
    settings,
    listed,
    enabled,
    closed: false,
    invalid: false,
  };
}

export type ReconcileAutomergeResult = "removed" | "absent" | "not-needed" | "unsupported" | "retry" | "lost";

/**
 * Cancellation-only read of the label-change decision for the reconcile
 * drainer. Re-reads the latest PR, applies the listed/enabled gate, resolves
 * policy, and cancels only when fresh state still requires it. Never posts
 * notes, never consults stored intent, and has no code path to
 * `scheduleAutomergeForPr` (scheduling stays with the webhook handler).
 *
 * `beforeCancel` fences a not-yet-dispatched cancel on live ownership: it
 * runs immediately before the cancel call, and a falsy answer forbids the
 * dispatch (`"lost"`) so a stale holder never cancels. The conflict case
 * cancels as the handler does but posts no note from the drainer.
 */
export async function reconcileAutomergeCancellation(opts: {
  api: Partial<AutomergeApi>;
  forgeKind: ForgeKind;
  owner: string;
  repo: string;
  prNumber: number;
  baseBranch?: string;
  automergeRepos: readonly string[] | undefined;
  automergeEnabled?: boolean;
  trustedSenderLogins?: readonly string[];
  botUsername: string;
  log?: (message: string) => void;
  /** Fence a not-yet-dispatched cancel on live ownership; falsy forbids it. */
  beforeCancel?: () => boolean | Promise<boolean>;
}): Promise<ReconcileAutomergeResult> {
  const log = opts.log ?? (() => undefined);
  const api = opts.api as AutomergeApi;
  if (typeof api.getPR !== "function" || typeof api.getRepo !== "function") {
    log(
      `automerge reconcile unsupported for ${opts.owner}/${opts.repo}#${opts.prNumber}: forge does not expose PR or repo reads`
    );
    return "unsupported";
  }
  let baseBranch = opts.baseBranch?.trim() ? opts.baseBranch.trim() : undefined;
  if (!baseBranch) {
    try {
      const info = await api.getRepo(opts.owner, opts.repo);
      baseBranch =
        typeof info.default_branch === "string" && info.default_branch.trim()
          ? info.default_branch.trim()
          : "main";
    } catch (err) {
      log(`automerge reconcile re-read failed for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
      return "retry";
    }
  }
  const evaluation = await evaluateAutomergeLabelState({
    api,
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.prNumber,
    baseBranch,
    automergeRepos: opts.automergeRepos,
    automergeEnabled: opts.automergeEnabled,
    trustedSenderLogins: opts.trustedSenderLogins,
    log,
  });
  if (evaluation.decision === "unreadable") return "retry";
  if (evaluation.closed) return "not-needed";
  if (
    !isJumiPrIdentity(
      {
        ...(evaluation.prUser ? { user: evaluation.prUser } : {}),
        ...(evaluation.prHeadRef ? { head: { ref: evaluation.prHeadRef } } : {}),
      },
      opts.botUsername
    )
  ) {
    return "not-needed";
  }
  if (!evaluation.listed || !evaluation.enabled) return "not-needed";
  if (evaluation.invalid) return "not-needed";
  if (evaluation.decision === "schedule" || evaluation.decision === "no-op") return "not-needed";
  const cancel = (api as Partial<Pick<Forge, "cancelAutoMerge">>).cancelAutoMerge;
  if (typeof cancel !== "function") {
    log(`automerge reconcile unsupported for ${opts.owner}/${opts.repo}#${opts.prNumber}: forge does not expose cancellation`);
    return "unsupported";
  }
  if (opts.beforeCancel) {
    const owned = await opts.beforeCancel();
    if (!owned) return "lost";
  }
  const outcome = await cancelAutomergeScheduleOutcome(
    api,
    opts.forgeKind,
    opts.owner,
    opts.repo,
    opts.prNumber,
    log
  );
  if (outcome === "removed") return "removed";
  if (outcome === "absent") return "absent";
  if (outcome === "unsupported") return "unsupported";
  return "retry";
}
