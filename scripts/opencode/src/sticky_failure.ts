import { isForgeRequestError } from "./forge_errors.ts";
import { redactGitSecrets } from "./workspace.ts";

/**
 * Sticky comments must not carry the request error. Logs still print
 * `err.message`: status plus a short body, with the parent token already removed.
 *
 * The failure names the runners that were tried and whether a hop was
 * attempted, so a provider outage does not look like a single-runner failure.
 */
export function stickyFailureDetail(err: unknown, secrets: readonly (string | undefined)[] = []): string {
  if (isForgeRequestError(err)) return "forge API request failed";
  const message = err instanceof Error ? err.message : String(err);
  const detail = redactGitSecrets(message, secrets);
  const suffix = describeTriedRunnersSuffix(err);
  return suffix ? `${detail} ${suffix}` : detail;
}

function stampShort(stamp: { type: string; model: string }): string {
  return `${stamp.type}:${stamp.model}`;
}

/**
 * `(tried a->b; hop attempted)` suffix for failure surfaces. Uses the engine
 * chain's narrowed contributors when present (clean-hop exclusions already
 * applied), falling back to the single attached runner.
 */
export function describeTriedRunnersSuffix(err: unknown): string {
  if (err === null || typeof err !== "object") return "";
  const rec = err as {
    runner?: { type: string; model: string };
    contributors?: unknown;
    chainIndex?: unknown;
    hopRefused?: unknown;
  };
  const contributors = Array.isArray(rec.contributors)
    ? (rec.contributors as Array<{ type: string; model: string }>)
    : [];
  const tried = contributors.length > 0 ? contributors : rec.runner ? [rec.runner] : [];
  if (tried.length === 0) return "";
  const names = [...new Set(tried.map(stampShort))];
  const hopped = tried.length > 1 || (typeof rec.chainIndex === "number" && rec.chainIndex > 0);
  const refused = rec.hopRefused === true;
  const hopText = hopped ? "hop attempted" : refused ? "hop refused" : "no hop";
  return `(tried ${names.join("->")}; ${hopText})`;
}
