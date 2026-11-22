import type { IssueTimelineEvent, Pull } from "./ports.ts";
import { isStrictBranchRefreshEnabled } from "./repo_settings.ts";
import { errorMessage } from "./util/error.ts";

export type GiteaStrictPolicy = "strict" | "off" | "unknown";

const SCHEDULED = "pull_scheduled_merge";
const CANCELLED = "pull_cancel_scheduled_merge";

function timelineKind(entry: IssueTimelineEvent): string {
  const raw = typeof entry.type === "string" && entry.type ? entry.type : (entry.event ?? "");
  return raw.trim().toLowerCase();
}

/**
 * Pure schedule state from a Gitea issue timeline. The latest of
 * `pull_scheduled_merge` / `pull_cancel_scheduled_merge` wins; anything else
 * (including no schedule event) means not armed. Never re-arms: a later
 * cancel stays final.
 */
export function isGiteaScheduleArmed(events: IssueTimelineEvent[] | undefined | null): boolean {
  if (!Array.isArray(events)) return false;
  let armed = false;
  let seen = false;
  for (const entry of events) {
    const kind = timelineKind(entry);
    if (kind === SCHEDULED) {
      armed = true;
      seen = true;
    } else if (kind === CANCELLED) {
      armed = false;
      seen = true;
    }
  }
  return seen && armed;
}

type TimelineApi = {
  listIssueTimeline?: (owner: string, repo: string, index: number) => Promise<IssueTimelineEvent[]>;
};

/**
 * Armed auto-merge on Gitea comes from the latest schedule/cancel timeline
 * event. Unreadable (missing entrypoint or throw) means not armed, never
 * permission to update. Never schedules or re-arms from this path.
 */
export async function readGiteaScheduleArmed(
  api: unknown,
  owner: string,
  repo: string,
  prNumber: number,
  log?: (message: string) => void
): Promise<boolean> {
  const list = (api as TimelineApi | undefined)?.listIssueTimeline;
  if (typeof list !== "function") return false;
  try {
    const events = await (list as NonNullable<TimelineApi["listIssueTimeline"]>).call(api, owner, repo, prNumber);
    return isGiteaScheduleArmed(events);
  } catch (err) {
    log?.(`strict refresh schedule unreadable for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
    return false;
  }
}

type CompareApi = {
  compareCommits?: (owner: string, repo: string, basehead: string) => Promise<{ totalCommits?: number }>;
};

/**
 * Behind detection on Gitea uses the compare call
 * (`head...base`, `total_commits > 0`). Unreadable (missing entrypoint,
 * throw, or missing count) means not established, never permission to
 * update. Evaluated against the current base tip at call time.
 */
export async function readGiteaBehind(
  api: unknown,
  owner: string,
  repo: string,
  headSha: string,
  baseRef: string,
  log?: (message: string) => void
): Promise<boolean> {
  const compare = (api as CompareApi | undefined)?.compareCommits;
  if (typeof compare !== "function" || !headSha.trim() || !baseRef.trim()) return false;
  try {
    const result = await (compare as NonNullable<CompareApi["compareCommits"]>).call(
      api,
      owner,
      repo,
      `${headSha.trim()}...${baseRef.trim()}`
    );
    const total = (result as { totalCommits?: unknown } | undefined)?.totalCommits;
    return typeof total === "number" && total > 0;
  } catch (err) {
    log?.(`strict refresh compare unreadable for ${owner}/${repo}@${headSha}: ${errorMessage(err)}`);
    return false;
  }
}

export function readGiteaBehindForPull(
  api: unknown,
  owner: string,
  repo: string,
  pr: Pull,
  log?: (message: string) => void
): Promise<boolean> {
  return readGiteaBehind(api, owner, repo, pr.head.sha, pr.base.ref, log);
}

type RepoFileApi = {
  getRepoFile?: (
    owner: string,
    repo: string,
    path: string,
    ref: string
  ) => Promise<{ found: boolean; content?: string }>;
};

/**
 * Explicit `.jumi.yml` opt-in (`strict_branch_refresh: true`) read from the
 * default branch. Missing, invalid, or unreadable means no opt-in. GitHub
 * never reads this key.
 */
async function readStrictBranchRefreshOptIn(
  api: unknown,
  owner: string,
  repo: string,
  defaultBranch: string | undefined | null,
  log?: (message: string) => void
): Promise<boolean> {
  const ref = (defaultBranch ?? "").trim();
  const getRepoFile = (api as RepoFileApi | undefined)?.getRepoFile;
  if (!ref || typeof getRepoFile !== "function") return false;
  try {
    const { resolveRepoPolicy, fallbackPolicyDeployment } = await import("./repo_policy.ts");
    const resolved = await resolveRepoPolicy({ api: api as never, owner, repo, ref }, fallbackPolicyDeployment({}), {
      onUnreadable: "fallback",
    });
    if (resolved.status !== "ok") return false;
    return isStrictBranchRefreshEnabled(resolved.load);
  } catch (err) {
    log?.(`strict refresh settings unreadable for ${owner}/${repo}@${ref}: ${errorMessage(err)}`);
    return false;
  }
}

/** Forge kind for strict-refresh routing: explicit policy wins; unknown defaults to GitHub behavior. */
function detectStrictForgeKind(_api: unknown, policy: unknown): "github" | "gitea" | undefined {
  const raw =
    typeof (policy as { forgeKind?: unknown } | undefined)?.forgeKind === "string"
      ? (policy as { forgeKind: string }).forgeKind.trim().toLowerCase()
      : "";
  if (raw === "github" || raw === "gitea") return raw;
  return undefined;
}

/** True when strict-refresh must use the Gitea path (timeline + compare + opt-in). */
export function isGiteaStrictForge(api: unknown, policy: unknown): boolean {
  return detectStrictForgeKind(api, policy) === "gitea";
}

/**
 * Enrich Gitea pulls with schedule state: armed pulls get
 * `autoMergeEnabled: true`, everything else `false`, so the shared
 * candidate gates apply unchanged. Never schedules or re-arms.
 */
export async function withGiteaArmed(
  api: unknown,
  pulls: Pull[],
  owner: string,
  repo: string,
  log?: (message: string) => void
): Promise<Pull[]> {
  return Promise.all(
    pulls.map(async (pr) => {
      const armed = await readGiteaScheduleArmed(api, owner, repo, pr.number, log);
      return { ...pr, autoMergeEnabled: armed };
    })
  );
}

/** Keep only Gitea pulls whose head is behind the base (compare `total_commits > 0`). */
export async function keepGiteaBehind(
  api: unknown,
  pulls: Pull[],
  owner: string,
  repo: string,
  log?: (message: string) => void
): Promise<Pull[]> {
  const checks = await Promise.all(
    pulls.map(async (pr) => ({
      pr,
      behind: await readGiteaBehindForPull(api, owner, repo, pr, log),
    }))
  );
  return checks.filter((entry) => entry.behind).map((entry) => entry.pr);
}

/**
 * Policy source for Gitea: the readable forge rule wins (strict or off);
 * otherwise the `.jumi.yml` opt-in decides (true means strict, anything else
 * means unknown). Neither source means unknown, which keeps today's no-op.
 * Callers pass `forgeKind: "github"` to skip the file (GitHub behavior).
 */
export async function resolveStrictPolicyWithFallback(
  api: unknown,
  owner: string,
  repo: string,
  branch: string,
  opts: { forgeKind?: string; defaultBranch?: string | undefined | null; log?: (message: string) => void } = {}
): Promise<GiteaStrictPolicy> {
  const getBranch = (api as { getBranch?: unknown } | undefined)?.getBranch;
  if (typeof getBranch === "function" && branch.trim()) {
    try {
      const fetched = await (getBranch as (o: string, r: string, b: string) => Promise<{ strict?: unknown }>).call(
        api,
        owner,
        repo,
        branch
      );
      if ((fetched as { strict?: unknown })?.strict === true) return "strict";
      if ((fetched as { strict?: unknown })?.strict === false) return "off";
    } catch (err) {
      opts.log?.(`strict policy unreadable for ${owner}/${repo}@${branch}: ${errorMessage(err)}`);
    }
  } else if (typeof getBranch !== "function" || !branch.trim()) {
    // No readable branch: fall through to the opt-in below (Gitea) or unknown (GitHub).
  }
  if (opts.forgeKind === "github") return "unknown";
  const optIn = await readStrictBranchRefreshOptIn(api, owner, repo, opts.defaultBranch, opts.log);
  return optIn ? "strict" : "unknown";
}
