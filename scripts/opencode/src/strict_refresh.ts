import { type IssueApi, isAssignedForeignPR, isEligibleWorkerPR, isInScopeJumiPR } from "./gitea_issues.ts";
import type { BranchProtection, Pull } from "./ports.ts";
import {
  isGiteaStrictForge,
  keepGiteaBehind,
  readGiteaBehindForPull,
  readGiteaScheduleArmed,
  resolveStrictPolicyWithFallback,
  withGiteaArmed,
} from "./strict_refresh_gitea.ts";
import {
  compareStrictRefreshOrder,
  isStrictRefreshBlocked,
  isStrictRefreshTerminalEvidence,
  STRICT_REFRESH_SLOT_TIMEOUT_MS,
  type StrictRefreshSlotStore,
} from "./strict_refresh_queue.ts";
import type { GiteaPushPayload, IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";
import { assertRepositoryPolicy, type WebhookPolicy } from "./webhook.ts";

export type StrictPolicy = "strict" | "off" | "unknown";

export type StrictBranchApi = Pick<IssueApi, "getBranch">;

export async function resolveStrictPolicy(
  api: Partial<StrictBranchApi> | undefined,
  owner: string,
  repo: string,
  branch: string,
  log?: (message: string) => void
): Promise<StrictPolicy> {
  const getBranch = (api as StrictBranchApi | undefined)?.getBranch;
  if (typeof getBranch !== "function" || !branch.trim()) return "unknown";
  let fetched: BranchProtection;
  try {
    fetched = await (getBranch as (o: string, r: string, b: string) => Promise<BranchProtection>).call(
      api,
      owner,
      repo,
      branch
    );
  } catch (err) {
    log?.(`strict policy unreadable for ${owner}/${repo}@${branch}: ${errorMessage(err)}`);
    return "unknown";
  }
  if (fetched?.strict === true) return "strict";
  if (fetched?.strict === false) return "off";
  return "unknown";
}

export function isStrictRefreshCandidate(
  pr: Pull,
  owner: string,
  repo: string,
  botUsername: string,
  policy?: { botUsername: string; isPickedUp?: (issue: { assignee?: unknown; assignees?: unknown }) => boolean }
): boolean {
  if (!pr || typeof pr !== "object") return false;
  if (pr.state !== "open" || pr.merged) return false;
  if (pr.draft === true) return false;
  if (!pr.head?.repo || pr.head.repo.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return false;
  if (pr.autoMergeEnabled !== true) return false;
  if (!isEligibleWorkerPR(pr, owner, repo)) return false;
  if (isInScopeJumiPR(pr, owner, repo, botUsername)) return true;
  try {
    if (isAssignedForeignPR(pr, owner, repo, botUsername, policy as never)) return true;
  } catch {
    return false;
  }
  return false;
}

export type StrictRefreshPolicy = WebhookPolicy & {
  botUsername: string;
  ignoreConflictsLabel?: string;
};

export type StrictRefreshApi = Pick<IssueApi, "listOpenPulls" | "getIssue"> &
  Partial<StrictBranchApi & Pick<IssueApi, "getRepoFile" | "listPullCommits">> &
  Partial<{
    listIssueTimeline: (
      owner: string,
      repo: string,
      index: number
    ) => Promise<import("./ports.ts").IssueTimelineEvent[]>;
    compareCommits: (owner: string, repo: string, basehead: string) => Promise<{ totalCommits?: number }>;
  }>;

/**
 * True only when GitHub reports the head out of date under strict checks
 * (`mergeable_state: behind`). Absent or any other value (including
 * `unknown` while GitHub computes) means behind-ness is not established:
 * callers fall through to the normal review path instead of parking.
 */
export function isStrictRefreshBehind(pr: Pull): boolean {
  return typeof pr?.mergeableState === "string" && pr.mergeableState.toLowerCase() === "behind";
}

async function strictIgnoreLabel(
  api: Partial<Pick<IssueApi, "getRepoFile">>,
  owner: string,
  repo: string,
  defaultBranch: string,
  deploymentLabel: string | undefined,
  log?: (message: string) => void
): Promise<string> {
  const { normalizeIgnoreConflictsLabel } = await import("./ignore_conflicts.ts");
  let label = normalizeIgnoreConflictsLabel(deploymentLabel);
  try {
    const { fallbackPolicyDeployment, resolveRepoPolicy } = await import("./repo_policy.ts");
    if (typeof (api as { getRepoFile?: unknown }).getRepoFile === "function" && defaultBranch.trim()) {
      const repoPolicy = await resolveRepoPolicy(
        { api, owner, repo, ref: defaultBranch },
        fallbackPolicyDeployment({ ignoreConflictsLabel: deploymentLabel }),
        { onUnreadable: "fallback" }
      ).catch(() => undefined);
      if (repoPolicy !== undefined) label = repoPolicy.ignoreConflictsLabel;
    }
  } catch {
    // Fail-open to the deployment value.
  }
  return label;
}

/**
 * Ignore-conflicts guard for strict refresh. A labeled (or author-listed)
 * PR that Jumi has not committed to stays left to the author: no
 * default-branch merge from this path. Mirrors the conflict and
 * shared-waiter paths. Settings-unreadable fails closed (treated as left).
 */
export async function isStrictRefreshLeftToAuthor(
  api: Partial<Pick<IssueApi, "listPullCommits" | "getRepoFile">> | undefined,
  owner: string,
  repo: string,
  pr: Pull,
  opts: { botUsername: string; ignoreConflictsLabel?: string; defaultBranch?: string },
  log?: (message: string) => void
): Promise<boolean> {
  const { hasIgnoreConflictsLabel, isIgnoreConflictsAuthor, isLeftToAuthor, loadIgnoreConflictsAuthors } = await import(
    "./ignore_conflicts.ts"
  );
  const defaultBranch = typeof opts.defaultBranch === "string" ? opts.defaultBranch : "";
  const authors = await loadIgnoreConflictsAuthors(api as never, owner, repo, defaultBranch || undefined, log).catch(
    () => undefined
  );
  if (authors === undefined) return true;
  const label = await strictIgnoreLabel(api ?? {}, owner, repo, defaultBranch, opts.ignoreConflictsLabel, log);
  const labeled = hasIgnoreConflictsLabel(pr, label);
  const viaAuthor = !labeled && isIgnoreConflictsAuthor(pr.user?.login, authors);
  if (!labeled && !viaAuthor) return false;
  return isLeftToAuthor(
    api as never,
    owner,
    repo,
    pr,
    {
      botUsername: opts.botUsername,
      ignoreConflictsLabel: label,
      ignoreConflictsAuthors: authors,
      prAuthor: pr.user?.login,
      defaultBranch: defaultBranch || undefined,
    },
    log
  );
}

function pushBranchName(ref: string): string | undefined {
  if (!ref.startsWith("refs/heads/")) return undefined;
  const name = ref.slice("refs/heads/".length);
  return name ? name : undefined;
}

function isZeroSha(value: string | undefined): boolean {
  if (!value) return true;
  return /^0+$/.test(value);
}

async function strictForBranches(
  api: Partial<StrictBranchApi>,
  owner: string,
  repo: string,
  branches: string[],
  log?: (message: string) => void
): Promise<Map<string, StrictPolicy>> {
  const out = new Map<string, StrictPolicy>();
  for (const branch of branches) {
    if (out.has(branch)) continue;
    out.set(branch, await resolveStrictPolicy(api, owner, repo, branch, log));
  }
  return out;
}

async function strictPolicyForBranch(
  api: unknown,
  owner: string,
  repo: string,
  branch: string,
  policy: StrictRefreshPolicy,
  defaultBranch: string,
  log?: (message: string) => void
): Promise<StrictPolicy> {
  if (isGiteaStrictForge(api, policy)) {
    return resolveStrictPolicyWithFallback(api, owner, repo, branch, {
      forgeKind: "gitea",
      defaultBranch,
      log,
    });
  }
  const byBranch = await strictForBranches(api as Partial<StrictBranchApi>, owner, repo, [branch], log);
  return byBranch.get(branch) ?? "unknown";
}

/**
 * Collect PRs that are otherwise ready apart from branch freshness: the
 * existing strict-policy, same-repo, non-draft, Jumi-managed and
 * armed-auto-merge gates, plus the ignore-conflicts left-to-author guard.
 * Known blockers (conflict or blocked mergeability) are filtered here so an
 * older blocked PR never holds the queue ahead of an otherwise-ready one.
 * Returned oldest first (created_at, PR number tie-break).
 */
async function collectReadyStrictCandidates(opts: {
  pulls: Pull[];
  owner: string;
  repo: string;
  policy: StrictRefreshPolicy;
  api: Partial<Pick<IssueApi, "getRepoFile" | "listPullCommits">>;
  defaultBranch: string;
  baseBranch: string;
  log?: (message: string) => void;
}): Promise<Pull[]> {
  const { pulls, owner, repo, policy, api, defaultBranch, baseBranch, log } = opts;
  const seen = new Set<number>();
  const ready: Pull[] = [];
  for (const pr of pulls) {
    if (!pr || pr?.base?.ref !== baseBranch) continue;
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    if (!isStrictRefreshCandidate(pr, owner, repo, policy.botUsername, policy)) continue;
    if (
      await isStrictRefreshLeftToAuthor(
        api,
        owner,
        repo,
        pr,
        { botUsername: policy.botUsername, ignoreConflictsLabel: policy.ignoreConflictsLabel, defaultBranch },
        log
      )
    ) {
      log?.(`strict refresh #${pr.number} left to author; skipping merge-only wake`);
      continue;
    }
    if (isStrictRefreshBlocked(pr)) {
      log?.(`strict refresh #${pr.number} blocked (conflict or failing checks); skipping`);
      continue;
    }
    ready.push(pr);
  }
  ready.sort(compareStrictRefreshOrder);
  return ready;
}

function strictRefreshJobFor(
  pr: Pull,
  opts: {
    owner: string;
    repo: string;
    defaultBranch: string;
    cloneUrl: string;
    trigger: IssueJob["trigger"];
    baseSha: string;
  }
): Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; strictRefresh: true } {
  return {
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: pr.number,
    action: "push",
    title: pr.title,
    body: pr.body ?? "",
    htmlUrl: pr.html_url,
    issueUpdatedAt: pr.updated_at,
    defaultBranch: opts.defaultBranch,
    cloneUrl: opts.cloneUrl,
    mode: "follow-up",
    prNumber: pr.number,
    headSha: pr.head.sha,
    trigger: opts.trigger,
    mergeOnly: true as const,
    strictRefresh: true as const,
    ...(opts.baseSha ? { strictBaseSha: opts.baseSha } : {}),
  };
}

/**
 * Strict-refresh wakes for a branch push (any target branch, not only the
 * default). At most one merge-only job is admitted per repository and target
 * branch: the oldest ready candidate (see `collectReadyStrictCandidates`).
 * Unknown or off stays silent. When a slot store is provided, the single-slot
 * guarantee holds across workers and restarts: a held slot suppresses
 * waiting PRs (no speculative pushes), a merged/closed/ineligible/blocked
 * holder releases the slot, and a terminal or timed-out candidate is not
 * reselected on unchanged evidence. Without a store, the same oldest-first
 * single selection applies within this call.
 */
export async function shouldEnqueueStrictRefreshOnPush(
  payload: GiteaPushPayload,
  policy: StrictRefreshPolicy,
  api: StrictRefreshApi,
  log?: (message: string) => void,
  slots?: StrictRefreshSlotStore,
  nowMs?: number
): Promise<{
  jobs: Array<Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; strictRefresh: true }>;
  reason?: string;
}> {
  const branch = pushBranchName(payload.ref);
  if (!branch) return { jobs: [] };
  if (isZeroSha(payload.after)) return { jobs: [] };
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = assertRepositoryPolicy(payload.repository, policy));
  } catch (err) {
    log?.(`repository not allowed: ${errorMessage(err)}`);
    return { jobs: [], reason: "repository not allowed" };
  }
  let pulls: Pull[];
  try {
    pulls = await api.listOpenPulls(owner, repo);
  } catch (err) {
    log?.(`strict refresh open-pull lookup failed: ${errorMessage(err)}`);
    return { jobs: [] };
  }
  const pushedBase = payload.after ?? "";
  const defaultBranch = payload.repository.default_branch;
  const gitea = isGiteaStrictForge(api, policy as { forgeKind?: string });
  if (gitea) {
    try {
      pulls = await withGiteaArmed(api, pulls, owner, repo, log);
    } catch (err) {
      log?.(`strict refresh schedule lookup failed: ${errorMessage(err)}`);
      return { jobs: [] };
    }
  }
  const strict = await strictPolicyForBranch(api, owner, repo, branch, policy, defaultBranch, log);
  if (strict !== "strict") {
    // Fail-closed: only an explicit off clears a held slot. An unreadable
    // branch (unknown, e.g. transient fetch error) leaves the slot alone.
    if (slots && strict === "off") {
      try {
        const held = await slots.getSlot(owner, repo, branch);
        if (held) {
          await slots.release(owner, repo, branch, { nowMs });
          log?.(`strict refresh slot ${owner}/${repo}#${branch} released (strictness ${strict})`);
        }
      } catch (err) {
        log?.(`strict refresh slot release failed: ${errorMessage(err)}`);
      }
    }
    return { jobs: [] };
  }
  const readyRaw = await collectReadyStrictCandidates({
    pulls,
    owner,
    repo,
    policy,
    api,
    defaultBranch,
    baseBranch: branch,
    log,
  });
  const ready = gitea ? await keepGiteaBehind(api, readyRaw, owner, repo, log) : readyRaw;
  if (ready.length === 0) {
    // A holder that is now blocked or ineligible still needs releasing even
    // when no ready candidate remains: otherwise the queue stays stuck.
    if (slots) {
      try {
        await releaseStaleStrictSlot({
          slots,
          owner,
          repo,
          baseBranch: branch,
          baseSha: pushedBase,
          pulls,
          policy,
          api,
          defaultBranch,
          nowMs,
          log,
        });
      } catch (err) {
        log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
      }
    }
    return { jobs: [] };
  }
  if (!slots) {
    const first = ready[0] as Pull;
    return {
      jobs: [
        strictRefreshJobFor(first, {
          owner,
          repo,
          defaultBranch: payload.repository.default_branch,
          cloneUrl: payload.repository.clone_url,
          trigger: { event: "push" as const, sender: payload.sender?.login ?? payload.pusher?.login ?? "push" },
          baseSha: pushedBase,
        }),
      ],
    };
  }
  const now = nowMs ?? Date.now();
  try {
    const admitted = await reconcileStrictSlotForCandidates({
      slots,
      owner,
      repo,
      baseBranch: branch,
      baseSha: pushedBase,
      pulls,
      ready,
      policy,
      api,
      defaultBranch,
      nowMs: now,
      log,
    });
    if (!admitted) return { jobs: [] };
    return {
      jobs: [
        strictRefreshJobFor(admitted, {
          owner,
          repo,
          defaultBranch: payload.repository.default_branch,
          cloneUrl: payload.repository.clone_url,
          trigger: { event: "push" as const, sender: payload.sender?.login ?? payload.pusher?.login ?? "push" },
          baseSha: pushedBase,
        }),
      ],
    };
  } catch (err) {
    log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
    return { jobs: [] };
  }
}

/**
 * Release a held slot whose holder is no longer refreshable (merged/closed,
 * ineligible, or blocked) when no ready candidate remains. Terminal evidence
 * is recorded for blocked holders so the same head/base is not immediately
 * reselected; ineligible or missing holders release cleanly.
 */
async function releaseStaleStrictSlot(opts: {
  slots: StrictRefreshSlotStore;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  pulls: Pull[];
  policy: StrictRefreshPolicy;
  api: Partial<Pick<IssueApi, "getRepoFile" | "listPullCommits">>;
  defaultBranch: string;
  nowMs?: number;
  log?: (message: string) => void;
}): Promise<void> {
  const { slots, owner, repo, baseBranch, baseSha, pulls, policy, api, defaultBranch, log } = opts;
  const now = opts.nowMs ?? Date.now();
  const held = await slots.getSlot(owner, repo, baseBranch);
  if (!held) return;
  if (now - held.admittedAtMs > STRICT_REFRESH_SLOT_TIMEOUT_MS) {
    await slots.release(owner, repo, baseBranch, {
      terminal: { prNumber: held.prNumber, headSha: held.headSha, baseSha: held.baseSha, reason: "timeout" },
      nowMs: now,
    });
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} timed out for #${held.prNumber}`);
    return;
  }
  const holder = pulls.find((pr) => pr?.number === held.prNumber);
  if (!holder) {
    await slots.release(owner, repo, baseBranch, { nowMs: now });
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} gone)`);
    return;
  }
  if (!isStrictRefreshCandidate(holder, owner, repo, policy.botUsername, policy)) {
    await slots.release(owner, repo, baseBranch, { nowMs: now });
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} ineligible)`);
    return;
  }
  if (
    await isStrictRefreshLeftToAuthor(
      api,
      owner,
      repo,
      holder,
      { botUsername: policy.botUsername, ignoreConflictsLabel: policy.ignoreConflictsLabel, defaultBranch },
      log
    )
  ) {
    await slots.release(owner, repo, baseBranch, { nowMs: now });
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} left to author)`);
    return;
  }
  if (isStrictRefreshBlocked(holder)) {
    await slots.release(owner, repo, baseBranch, {
      terminal: { prNumber: holder.number, headSha: holder.head.sha, baseSha, reason: "blocked" },
      nowMs: now,
    });
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} blocked)`);
  }
}

/**
 * Core single-slot reconciliation for an ordered ready list. Returns the
 * newly admitted PR, or undefined when the slot is already held (callers
 * enqueue nothing for waiting PRs), the holder is still refreshable, or no
 * candidate survives the terminal-evidence filter.
 */
async function reconcileStrictSlotForCandidates(opts: {
  slots: StrictRefreshSlotStore;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  pulls: Pull[];
  ready: Pull[];
  policy: StrictRefreshPolicy;
  api: Partial<Pick<IssueApi, "getRepoFile" | "listPullCommits">>;
  defaultBranch: string;
  nowMs: number;
  log?: (message: string) => void;
}): Promise<Pull | undefined> {
  const { slots, owner, repo, baseBranch, baseSha, pulls, ready, policy, api, defaultBranch, nowMs, log } = opts;
  const held = await slots.getSlot(owner, repo, baseBranch);
  if (held) {
    if (nowMs - held.admittedAtMs > STRICT_REFRESH_SLOT_TIMEOUT_MS) {
      await slots.release(owner, repo, baseBranch, {
        terminal: { prNumber: held.prNumber, headSha: held.headSha, baseSha: held.baseSha, reason: "timeout" },
        nowMs,
      });
      log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} timed out for #${held.prNumber}`);
    } else {
      const holder = pulls.find((pr) => pr?.number === held.prNumber);
      if (!holder) {
        await slots.release(owner, repo, baseBranch, { nowMs });
        log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} gone)`);
      } else if (!isStrictRefreshCandidate(holder, owner, repo, policy.botUsername, policy)) {
        await slots.release(owner, repo, baseBranch, { nowMs });
        log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} ineligible)`);
      } else if (
        await isStrictRefreshLeftToAuthor(
          api,
          owner,
          repo,
          holder,
          { botUsername: policy.botUsername, ignoreConflictsLabel: policy.ignoreConflictsLabel, defaultBranch },
          log
        )
      ) {
        await slots.release(owner, repo, baseBranch, { nowMs });
        log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} left to author)`);
      } else if (isStrictRefreshBlocked(holder)) {
        await slots.release(owner, repo, baseBranch, {
          terminal: { prNumber: holder.number, headSha: holder.head.sha, baseSha, reason: "blocked" },
          nowMs,
        });
        log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} released (holder #${held.prNumber} blocked)`);
      } else {
        // Slot held and refreshable: external head/base moves only update
        // the observed tip, never start a second refresh. Duplicate or
        // out-of-order events stay deduplicated here.
        if (holder.head.sha !== held.headSha || baseSha !== held.baseSha) {
          await slots.touch(owner, repo, baseBranch, held.prNumber, holder.head.sha, baseSha || held.baseSha, nowMs);
        }
        return undefined;
      }
    }
  }
  const terminal = await slots.getTerminal(owner, repo, baseBranch);
  const eligible = ready.filter((pr) => !isStrictRefreshTerminalEvidence(pr.number, pr.head.sha, baseSha, terminal));
  const selected = eligible[0];
  if (!selected) return undefined;
  const admitted = await slots.tryAdmit({
    owner,
    repo,
    baseBranch,
    prNumber: selected.number,
    headSha: selected.head.sha,
    baseSha,
    admittedAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  if (!admitted) {
    log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} race lost; another admission holds it`);
    return undefined;
  }
  log?.(`strict refresh slot ${owner}/${repo}#${baseBranch} admitted #${selected.number}`);
  return selected;
}

/**
 * Reconcile a single PR on supported PR activity (synchronize/opened/
 * ready_for_review, auto-merge armed while behind). Returns a merge-only
 * job when the PR is the oldest ready candidate for its target branch and
 * the single-slot admission grants it; otherwise null. The same admission
 * rule as target pushes applies: waiting PRs get no speculative update,
 * and only the admitted holder's review is deferred. The worker skips
 * up-to-date heads, so callers enqueue optimistically without a git
 * behind-check. When a slot store and a listOpenPulls-capable api are
 * provided, ordering and the held slot are enforced; without them, the
 * single-PR eligibility gates apply (legacy single-call path).
 */
export async function shouldEnqueueStrictRefreshForPR(opts: {
  pr: Pull;
  owner: string;
  repo: string;
  defaultBranch: string;
  cloneUrl: string;
  policy: StrictRefreshPolicy;
  api: Partial<StrictBranchApi & Pick<IssueApi, "getRepoFile" | "listPullCommits" | "listOpenPulls">> &
    Partial<{
      listIssueTimeline: (
        owner: string,
        repo: string,
        index: number
      ) => Promise<import("./ports.ts").IssueTimelineEvent[]>;
      compareCommits: (owner: string, repo: string, basehead: string) => Promise<{ totalCommits?: number }>;
    }>;
  sender?: string;
  log?: (message: string) => void;
  slots?: StrictRefreshSlotStore;
  nowMs?: number;
}): Promise<(Omit<IssueJob, "delivery" | "receivedAt"> & { mergeOnly: true; strictRefresh: true }) | null> {
  const { owner, repo, policy, api } = opts;
  const gitea = isGiteaStrictForge(api, policy as { forgeKind?: string });
  let pr = opts.pr;
  if (gitea) {
    const armed = await readGiteaScheduleArmed(api, owner, repo, pr.number, opts.log);
    if (!armed) return null;
    pr = { ...pr, autoMergeEnabled: true };
    const strictEarly = await resolveStrictPolicyWithFallback(api, owner, repo, pr.base?.ref?.trim() ?? "", {
      forgeKind: "gitea",
      defaultBranch: opts.defaultBranch,
      log: opts.log,
    });
    if (strictEarly !== "strict") {
      if (opts.slots && strictEarly === "off") {
        try {
          const held = await opts.slots.getSlot(owner, repo, pr.base?.ref?.trim() ?? "");
          if (held) await opts.slots.release(owner, repo, pr.base?.ref?.trim() ?? "", { nowMs: opts.nowMs });
        } catch (err) {
          opts.log?.(`strict refresh slot release failed: ${errorMessage(err)}`);
        }
      }
      return null;
    }
    if (
      await isStrictRefreshLeftToAuthor(
        api,
        owner,
        repo,
        pr,
        {
          botUsername: policy.botUsername,
          ignoreConflictsLabel: policy.ignoreConflictsLabel,
          defaultBranch: opts.defaultBranch,
        },
        opts.log
      )
    ) {
      opts.log?.(`strict refresh #${pr.number} left to author; skipping merge-only wake`);
      return null;
    }
    if (isStrictRefreshBlocked(pr)) {
      opts.log?.(`strict refresh #${pr.number} blocked (conflict or failing checks); skipping`);
      return null;
    }
    const behind = await readGiteaBehindForPull(api, owner, repo, pr, opts.log);
    if (!behind) return null;
  }
  if (!isStrictRefreshCandidate(pr, owner, repo, policy.botUsername, policy)) return null;
  const baseBranch = pr.base?.ref?.trim() ? pr.base.ref.trim() : "";
  if (!baseBranch) return null;
  const strict = await strictPolicyForBranch(api, owner, repo, baseBranch, policy, opts.defaultBranch, opts.log);
  if (strict !== "strict") {
    // Fail-closed: only an explicit off clears a held slot; unknown (e.g.
    // transient getBranch failure) leaves the slot alone.
    if (opts.slots && strict === "off") {
      try {
        const held = await opts.slots.getSlot(owner, repo, baseBranch);
        if (held) await opts.slots.release(owner, repo, baseBranch, { nowMs: opts.nowMs });
      } catch (err) {
        opts.log?.(`strict refresh slot release failed: ${errorMessage(err)}`);
      }
    }
    return null;
  }
  if (
    await isStrictRefreshLeftToAuthor(
      api,
      owner,
      repo,
      pr,
      {
        botUsername: policy.botUsername,
        ignoreConflictsLabel: policy.ignoreConflictsLabel,
        defaultBranch: opts.defaultBranch,
      },
      opts.log
    )
  ) {
    opts.log?.(`strict refresh #${pr.number} left to author; skipping merge-only wake`);
    return null;
  }
  if (isStrictRefreshBlocked(pr)) {
    opts.log?.(`strict refresh #${pr.number} blocked (conflict or failing checks); skipping`);
    return null;
  }
  const slots = opts.slots;
  const listOpenPulls = (api as { listOpenPulls?: unknown }).listOpenPulls;
  if (!slots || typeof listOpenPulls !== "function") {
    return {
      owner,
      repo,
      issueNumber: pr.number,
      action: "push",
      title: pr.title,
      body: pr.body ?? "",
      htmlUrl: pr.html_url,
      issueUpdatedAt: pr.updated_at,
      defaultBranch: opts.defaultBranch,
      cloneUrl: opts.cloneUrl,
      mode: "follow-up",
      prNumber: pr.number,
      headSha: pr.head.sha,
      trigger: { event: "pull_request", sender: opts.sender ?? "pull_request" },
      mergeOnly: true,
      strictRefresh: true,
      ...(pr.base?.sha ? { strictBaseSha: pr.base.sha } : {}),
    };
  }
  const now = opts.nowMs ?? Date.now();
  let pulls: Pull[];
  try {
    pulls = await (listOpenPulls as (o: string, r: string) => Promise<Pull[]>).call(api, owner, repo);
  } catch (err) {
    opts.log?.(`strict refresh open-pull lookup failed: ${errorMessage(err)}`);
    return null;
  }
  if (gitea) {
    try {
      pulls = await withGiteaArmed(api, pulls, owner, repo, opts.log);
    } catch (err) {
      opts.log?.(`strict refresh schedule lookup failed: ${errorMessage(err)}`);
      return null;
    }
  }
  const baseSha = pr.base?.sha ?? "";
  const readyRaw = await collectReadyStrictCandidates({
    pulls,
    owner,
    repo,
    policy,
    api,
    defaultBranch: opts.defaultBranch,
    baseBranch,
    log: opts.log,
  });
  const ready = gitea ? await keepGiteaBehind(api, readyRaw, owner, repo, opts.log) : readyRaw;
  if (ready.length === 0) {
    try {
      await releaseStaleStrictSlot({
        slots,
        owner,
        repo,
        baseBranch,
        baseSha,
        pulls,
        policy,
        api,
        defaultBranch: opts.defaultBranch,
        nowMs: now,
        log: opts.log,
      });
    } catch (err) {
      opts.log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
    }
    return null;
  }
  // Only the oldest ready candidate may hold the slot; a newer or blocked
  // PR activity never preempts the holder.
  if (ready[0]?.number !== pr.number) {
    try {
      await reconcileStrictSlotForCandidates({
        slots,
        owner,
        repo,
        baseBranch,
        baseSha,
        pulls,
        ready,
        policy,
        api,
        defaultBranch: opts.defaultBranch,
        nowMs: now,
        log: opts.log,
      });
    } catch (err) {
      opts.log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
    }
    return null;
  }
  try {
    const admitted = await reconcileStrictSlotForCandidates({
      slots,
      owner,
      repo,
      baseBranch,
      baseSha,
      pulls,
      ready,
      policy,
      api,
      defaultBranch: opts.defaultBranch,
      nowMs: now,
      log: opts.log,
    });
    if (!admitted || admitted.number !== pr.number) return null;
  } catch (err) {
    opts.log?.(`strict refresh slot reconcile failed: ${errorMessage(err)}`);
    return null;
  }
  return {
    owner,
    repo,
    issueNumber: pr.number,
    action: "push",
    title: pr.title,
    body: pr.body ?? "",
    htmlUrl: pr.html_url,
    issueUpdatedAt: pr.updated_at,
    defaultBranch: opts.defaultBranch,
    cloneUrl: opts.cloneUrl,
    mode: "follow-up",
    prNumber: pr.number,
    headSha: pr.head.sha,
    trigger: { event: "pull_request", sender: opts.sender ?? "pull_request" },
    mergeOnly: true,
    strictRefresh: true,
    ...(pr.base?.sha ? { strictBaseSha: pr.base.sha } : {}),
  };
}

/** Pure recheck before writing: null means proceed, otherwise skip reason. */
export function strictRecheckSkipReason(opts: {
  fresh: Pull;
  expectedHeadSha: string;
  strict: StrictPolicy;
}): string | null {
  const expected = (opts.expectedHeadSha ?? "").toLowerCase();
  if (!expected || opts.fresh.head.sha.toLowerCase() !== expected) {
    return "strict refresh: competing head update";
  }
  if (opts.strict !== "strict") return "strict refresh: strictness off or unknown";
  if (opts.fresh.autoMergeEnabled !== true) return "strict refresh: auto-merge no longer armed";
  return null;
}

export type StrictRecheckApi = {
  getPR: (owner: string, repo: string, index: number) => Promise<Pull>;
} & Partial<StrictBranchApi & Pick<IssueApi, "getRepoFile" | "listPullCommits">> &
  Partial<{
    listIssueTimeline: (
      owner: string,
      repo: string,
      index: number
    ) => Promise<import("./ports.ts").IssueTimelineEvent[]>;
    compareCommits: (owner: string, repo: string, basehead: string) => Promise<{ totalCommits?: number }>;
  }>;

/**
 * Shared worker recheck before any strict-refresh write. Fetches the PR
 * fresh, then rechecks eligibility, head, strictness, auto-merge and the
 * ignore-conflicts guard in one place so the pre-merge and pre-push
 * checkpoints cannot drift (e.g. one side missing the left-to-author
 * recheck). Returns the fresh PR plus a skip reason (null means proceed).
 */
export async function recheckStrictRefreshEligibility(opts: {
  api: StrictRecheckApi;
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
  botUsername: string;
  policy?: { botUsername: string; isPickedUp?: (issue: { assignee?: unknown; assignees?: unknown }) => boolean };
  ignoreConflictsLabel?: string;
  defaultBranch?: string;
  log?: (message: string) => void;
}): Promise<{ fresh?: Pull; skipReason: string | null }> {
  let fresh: Pull | undefined;
  try {
    fresh = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log?.(`strict refresh unreadable for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${errorMessage(err)}`);
    return { skipReason: "strict refresh: pull request unreadable" };
  }
  const gitea = isGiteaStrictForge(opts.api, opts.policy as { forgeKind?: string });
  if (gitea) {
    if (!fresh) return { skipReason: "strict refresh: not eligible" };
    const expected = (opts.expectedHeadSha ?? "").toLowerCase();
    if (!expected || fresh.head.sha.toLowerCase() !== expected) {
      return { fresh, skipReason: "strict refresh: competing head update" };
    }
    const strict = await resolveStrictPolicyWithFallback(opts.api, opts.owner, opts.repo, fresh.base.ref, {
      forgeKind: "gitea",
      defaultBranch: opts.defaultBranch,
      log: opts.log,
    });
    if (strict !== "strict") {
      return { fresh, skipReason: "strict refresh: strictness off or unknown" };
    }
    const armed = await readGiteaScheduleArmed(opts.api, opts.owner, opts.repo, fresh.number, opts.log);
    if (!armed) {
      return { fresh, skipReason: "strict refresh: auto-merge no longer armed" };
    }
    const enriched = { ...fresh, autoMergeEnabled: true };
    if (!isStrictRefreshCandidate(enriched, opts.owner, opts.repo, opts.botUsername, opts.policy as never)) {
      return { fresh: enriched, skipReason: "strict refresh: not eligible" };
    }
    if (
      await isStrictRefreshLeftToAuthor(
        opts.api,
        opts.owner,
        opts.repo,
        enriched,
        {
          botUsername: opts.botUsername,
          ignoreConflictsLabel: opts.ignoreConflictsLabel,
          defaultBranch: opts.defaultBranch,
        },
        opts.log
      )
    ) {
      return { fresh: enriched, skipReason: "strict refresh: left to author (ignore-conflicts)" };
    }
    const behind = await readGiteaBehindForPull(opts.api, opts.owner, opts.repo, enriched, opts.log);
    if (!behind) {
      return { fresh: enriched, skipReason: "strict refresh: not behind" };
    }
    return { fresh: enriched, skipReason: null };
  }
  if (!fresh || !isStrictRefreshCandidate(fresh, opts.owner, opts.repo, opts.botUsername, opts.policy as never)) {
    return { fresh, skipReason: "strict refresh: not eligible" };
  }
  const expected = (opts.expectedHeadSha ?? "").toLowerCase();
  if (!expected || fresh.head.sha.toLowerCase() !== expected) {
    return { fresh, skipReason: "strict refresh: competing head update" };
  }
  const strict = await resolveStrictPolicy(opts.api, opts.owner, opts.repo, fresh.base.ref, opts.log);
  if (strict !== "strict") {
    return { fresh, skipReason: "strict refresh: strictness off or unknown" };
  }
  if (fresh.autoMergeEnabled !== true) {
    return { fresh, skipReason: "strict refresh: auto-merge no longer armed" };
  }
  if (
    await isStrictRefreshLeftToAuthor(
      opts.api,
      opts.owner,
      opts.repo,
      fresh,
      {
        botUsername: opts.botUsername,
        ignoreConflictsLabel: opts.ignoreConflictsLabel,
        defaultBranch: opts.defaultBranch,
      },
      opts.log
    )
  ) {
    return { fresh, skipReason: "strict refresh: left to author (ignore-conflicts)" };
  }
  return { fresh, skipReason: null };
}

/** Review deferral while an authorized refresh is queued or running. */
export const STRICT_REFRESH_WAIT_PREFIX = "strict-refresh-wait:";
export const STRICT_REFRESH_WAIT_FALLBACK_MS = 10 * 60 * 1000;

export function isStrictRefreshWaitMarker(error: string | null | undefined): boolean {
  return Boolean(error?.startsWith(STRICT_REFRESH_WAIT_PREFIX));
}

export function encodeStrictRefreshWait(firstSeenMs: number): string {
  return `${STRICT_REFRESH_WAIT_PREFIX}${firstSeenMs}`;
}

export function parseStrictRefreshWait(error: string | null | undefined): { firstSeen: number } | undefined {
  if (!isStrictRefreshWaitMarker(error) || !error) return undefined;
  const firstSeen = Number(error.slice(STRICT_REFRESH_WAIT_PREFIX.length));
  if (!Number.isFinite(firstSeen)) return undefined;
  return { firstSeen };
}
