import {
  baseConclusionForCheckName,
  checksFromActionJobs,
  isJumiReviewContext,
  latestStatuses,
  mergeForgeAndLiveChecks,
} from "./ci.ts";
import type { Check, Forge } from "./ports.ts";
import { errorMessage } from "./util/error.ts";

type BaseCiApi = Pick<Forge, "listCommitStatuses" | "listCheckRuns" | "listActionJobs">;

export interface BaseCheckResult {
  name: string;
  conclusion: string;
}

export interface BaseCiComparison {
  sha: string;
  results: BaseCheckResult[];
  lookupFailed?: boolean;
}

/**
 * Same-name check conclusions on the PR's base commit. A `success` conclusion
 * means the check is green on base, so a head failure of the same check is
 * attributable to the PR and never "pre-existing". Never throws: a missing
 * SHA returns undefined and a throwing list call degrades to `lookupFailed`,
 * both of which keep today's fail-open behaviour.
 */
export async function inspectBaseCi(opts: {
  api: BaseCiApi;
  owner: string;
  repo: string;
  baseSha: string;
  log?: (message: string) => void;
}): Promise<BaseCiComparison | undefined> {
  const sha = (opts.baseSha ?? "").trim();
  if (!sha) return undefined;
  let lookupFailed = false;
  const note = (err: unknown) => {
    lookupFailed = true;
    opts.log?.(`base CI lookup failed for ${opts.owner}/${opts.repo}@${sha}: ${errorMessage(err)}`);
  };
  let statuses: Check[] = [];
  try {
    statuses = await opts.api.listCommitStatuses(opts.owner, opts.repo, sha);
  } catch (err) {
    statuses = [];
    note(err);
  }
  let checkRuns: Check[] = [];
  try {
    checkRuns = await opts.api.listCheckRuns(opts.owner, opts.repo, sha);
  } catch (err) {
    checkRuns = [];
    note(err);
  }
  const fromForge = latestStatuses([...statuses, ...checkRuns]).filter(
    (status) => !isJumiReviewContext(status.context)
  );
  let live: Check[] = [];
  try {
    const jobs = await opts.api.listActionJobs(opts.owner, opts.repo, { headSha: sha });
    live = checksFromActionJobs(jobs, sha);
  } catch (err) {
    live = [];
    note(err);
  }
  const others = mergeForgeAndLiveChecks(fromForge, live, sha);
  const results: BaseCheckResult[] = [];
  for (const status of others) {
    const name = status.context ?? "";
    if (!name) continue;
    results.push({ name, conclusion: status.state ?? status.status ?? "unknown" });
  }
  return { sha, results, ...(lookupFailed ? { lookupFailed: true as const } : {}) };
}

/** Green on base (`success`) for one check name, with workflow/job alias matching. */
export function isBaseGreen(results: readonly BaseCheckResult[], checkName: string): boolean {
  return baseConclusionForCheckName(results, checkName) === "success";
}

/**
 * Head failures attributable to the PR: unhandled checks that are green on
 * the base commit. Empty when the base is unknown or its lookup failed, so
 * callers keep today's pre-existing/shared-failure handling in those cases.
 */
export function attributableToPr(
  unhandled: ReadonlyArray<{ name: string }>,
  base: BaseCiComparison | { results: BaseCheckResult[]; lookupFailed?: boolean } | undefined
): string[] {
  if (!base || base.lookupFailed) return [];
  return unhandled.map((check) => check.name).filter((name) => isBaseGreen(base.results, name));
}

/** `buildCiMarkdown` input from an inspection carrying base fields. */
export function baseForMarkdown(ci: {
  baseSha?: string;
  baseResults?: BaseCheckResult[];
  baseLookupFailed?: boolean;
}): BaseCiComparison | undefined {
  if (!ci.baseSha) return undefined;
  return {
    sha: ci.baseSha,
    results: ci.baseResults ?? [],
    ...(ci.baseLookupFailed ? { lookupFailed: true as const } : {}),
  };
}
