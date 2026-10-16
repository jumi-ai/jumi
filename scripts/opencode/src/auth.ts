import { hostname } from "node:os";
import { EngineFailedError } from "./engine.ts";

export const AUTH_DEATH_REASON = "provider auth death";

/**
 * Verified provider-auth-death signals from the shipped runner CLIs:
 * - Claude Code error reference (https://code.claude.com/docs/en/errors):
 *   `Failed to authenticate: OAuth session expired and could not be refreshed`,
 *   `Failed to refresh OAuth token`, `OAuth token refresh failed`,
 *   `OAuth token revoked` / `OAuth token has expired`, `Login expired`,
 *   `API Error: 401 ...`, `Invalid authentication credentials`,
 *   structured `authentication_failed` / `authentication_error`.
 * - Codex CLI (openai/codex issues/logs): `Failed to refresh token: 401`,
 *   `Your session has ended. Please log in again.` (`refresh_token_invalidated`),
 *   `Your access token could not be refreshed because your refresh token was
 *   revoked`, `Your authentication token has been invalidated`
 *   (`token_invalidated` / `token_revoked`).
 * - Antigravity `agy` docs (antigravity.google/docs/cli headless +
 *   troubleshooting): headless `authentication required`, `Please sign in`,
 *   `You are not logged into Antigravity`, `failed to retrieve token`,
 *   `error getting token source` / `Failed to get OAuth token`.
 * - OpenCode providers (sst/opencode): `ProviderAuthError: Failed to
 *   authenticate with ...`, `Invalid API key`, `HTTP 401`.
 * Bare `401` / `unauthorized` / `expired` alone are deliberately NOT matched:
 * they appear in ordinary task errors.
 */
const AUTH_STDERR_RE =
  /invalid_grant|missing API key|API key not|invalid api key|not logged in|authentication_failed|authentication_error|failed to authenticate|oauth.+expired|expired.+oauth|oauth.+revoked|revoked.+oauth|token.+revoked|revoked.+token|token.+invalidated|invalidated.+token|refresh_token_invalidated|token_invalidated|token_revoked|failed to refresh (oauth )?token|oauth token refresh failed|access token could not be refreshed|refresh token was revoked|your session has ended|login expired|please run \/login|claude\.ai login (expired|was rejected)|oauth token (unavailable|refresh failed)|jwt refresh failed|signed out of claude|invalid authentication credentials|authentication fails|API Error:\s*401|401\s*Unauthorized|ProviderAuthError|failed to retrieve token|error getting token source|you are not logged into/i;

export function stripClaudeConfigWarning(text: string): string {
  if (!text) return text;
  const kept = text.split(/\r?\n/).filter((line) => {
    if (/claude configuration file not found/i.test(line)) return false;
    if (/backup/i.test(line) && /restor/i.test(line)) return false;
    if (/\.claude\.json/i.test(line) && /not found|missing|backup|restor/i.test(line)) return false;
    return true;
  });
  return kept.join("\n").trim();
}

export function looksLikeProviderAuthDeath(text: string): boolean {
  const signal = stripClaudeConfigWarning(text);
  if (!signal.trim()) return false;
  return AUTH_STDERR_RE.test(signal) || signal.includes(AUTH_DEATH_REASON);
}

export function providerAuthDeathMessage(host = hostname()): string {
  return `${host}: ${AUTH_DEATH_REASON}`;
}

export function isAuthFailure(err: unknown): boolean {
  if (err instanceof EngineFailedError) return err.auth === true;
  const text = err instanceof Error ? err.message : String(err);
  return looksLikeProviderAuthDeath(text);
}
