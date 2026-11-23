import { errorMessage } from "./util/error.ts";

/**
 * Live-forge snapshot for the requeue kick gate (#810). Set by the board's
 * requeue kick handler from `getPR`/`getRepo`; absent means unchecked. A
 * `notFound` PR, or a closed/merged PR, refuses the kick with a
 * `not-found`/`not-kickable` log instead of inserting a job.
 * `canonicalFullName` is the forge's canonical `owner/repo` for the repo:
 * when it differs from the terminal row, the new row uses it instead of the
 * stale terminal coordinates (transferred repo).
 */
export interface RequeueForgeSnapshot {
  notFound?: boolean;
  state?: string;
  merged?: boolean;
  canonicalFullName?: string;
}

/** Minimal forge surface for the requeue gate; both forges satisfy it. */
export interface RequeueGateForge {
  getPR(owner: string, repo: string, index: number): Promise<{ state: string; merged: boolean }>;
  getRepo?(owner: string, repo: string): Promise<{ default_branch?: string; full_name?: string }>;
}

/** Live-forge refusal for the requeue kick gate. Null means the snapshot allows the kick. */
export function requeueForgeRefusal(
  owner: string,
  repo: string,
  prNumber: number,
  forge: RequeueForgeSnapshot | undefined
): { code: "not-found" | "not-kickable"; why: string } | null {
  if (!forge) return null;
  if (forge.notFound) {
    return {
      code: "not-found",
      why: `No pull request for ${owner}/${repo}#${prNumber} (forge reports not found).`,
    };
  }
  if (forge.merged === true || (forge.state != null && forge.state !== "open")) {
    return {
      code: "not-kickable",
      why: "No kick: pull request is closed or merged; requeueing cannot reopen it. Reopen the pull to review again.",
    };
  }
  return null;
}

/** Canonical `owner/repo` from the forge's `full_name`, or null when absent/invalid. */
export function canonicalKickCoords(fullName: string | undefined): { owner: string; repo: string } | null {
  if (!fullName) return null;
  const trimmed = fullName.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const owner = trimmed.slice(0, slash).trim();
  const repo = trimmed.slice(slash + 1).trim();
  if (!owner || !repo || owner.includes("/") || repo.includes("/") || /\s/.test(owner) || /\s/.test(repo)) {
    return null;
  }
  return { owner, repo };
}

function isGoneForgeError(err: unknown): boolean {
  return err instanceof Error && (/→ 404\b/.test(err.message) || /→ 410\b/.test(err.message));
}

/**
 * Live-forge snapshot for the board's requeue kick handler. Undefined means
 * unchecked (no forge seam); `"unavailable"` means the forge could not be
 * read and nothing may be enqueued. A missing PR, or a closed/merged PR, is
 * returned as a refusal snapshot so `requeueKick` logs the refusal in the
 * kick log instead of inserting a job. The canonical `full_name` rides
 * along so a transferred repo inserts under the forge's coordinates.
 */
export async function fetchRequeueForgeSnapshot(
  forgeApi: RequeueGateForge | undefined,
  parsed: { owner: string; repo: string; number: number },
  logger: (message: string) => void,
  actor: string
): Promise<RequeueForgeSnapshot | undefined | "unavailable"> {
  if (!forgeApi) return undefined;
  let pr: { state: string; merged: boolean };
  try {
    pr = await forgeApi.getPR(parsed.owner, parsed.repo, parsed.number);
  } catch (err) {
    if (isGoneForgeError(err)) return { notFound: true };
    logger(
      `kick forge unavailable actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number}: ${errorMessage(err)}`
    );
    return "unavailable";
  }
  if (pr.merged || pr.state !== "open") return { state: pr.state, merged: pr.merged };
  if (!forgeApi.getRepo) return { state: pr.state, merged: pr.merged };
  try {
    const repo = await forgeApi.getRepo(parsed.owner, parsed.repo);
    const fullName = typeof repo?.full_name === "string" ? repo.full_name.trim() : "";
    if (fullName) return { state: pr.state, merged: pr.merged, canonicalFullName: fullName };
  } catch (err) {
    logger(
      `kick repo lookup failed actor=${actor} ${parsed.owner}/${parsed.repo}#${parsed.number}: ${errorMessage(err)}`
    );
  }
  return { state: pr.state, merged: pr.merged };
}
