import { isForgeRequestError } from "./forge_errors.ts";
import { redactGitSecrets } from "./workspace.ts";

/**
 * Sticky comments must not carry the request error. Logs still print
 * `err.message`: status plus a short body, with the parent token already removed.
 */
export function stickyFailureDetail(err: unknown, secrets: readonly (string | undefined)[] = []): string {
  if (isForgeRequestError(err)) return "forge API request failed";
  const message = err instanceof Error ? err.message : String(err);
  return redactGitSecrets(message, secrets);
}
