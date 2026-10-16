import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import {
  AUTH_DEATH_REASON,
  isAuthFailure,
  looksLikeProviderAuthDeath,
  providerAuthDeathMessage,
  stripClaudeConfigWarning,
} from "../src/auth.ts";
import { EngineFailedError } from "../src/engine.ts";

describe("looksLikeProviderAuthDeath", () => {
  test("matches refresh-grant rejection and missing provider key", () => {
    expect(looksLikeProviderAuthDeath('oauth: {"error":"invalid_grant"}')).toBe(true);
    expect(looksLikeProviderAuthDeath("missing API key")).toBe(true);
    expect(looksLikeProviderAuthDeath("API key not found for provider xai")).toBe(true);
    expect(looksLikeProviderAuthDeath(providerAuthDeathMessage())).toBe(true);
  });

  test("matches expired or unrefreshable OAuth sessions and provider 401s", () => {
    // Claude Code error reference: expired OAuth session in print mode.
    expect(looksLikeProviderAuthDeath("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe(
      true
    );
    // Claude Code error reference: refresh lock / refresh failure.
    expect(
      looksLikeProviderAuthDeath("Failed to refresh OAuth token: another Claude Code process is refreshing it")
    ).toBe(true);
    expect(looksLikeProviderAuthDeath("OAuth token refresh failed — run /login to re-authenticate")).toBe(true);
    // Claude Code error reference: revoked / expired tokens and 401s.
    expect(looksLikeProviderAuthDeath("Failed to authenticate: OAuth token revoked")).toBe(true);
    expect(looksLikeProviderAuthDeath("API Error: 401 OAuth token has expired")).toBe(true);
    expect(looksLikeProviderAuthDeath("Login expired · Please run /login")).toBe(true);
    expect(looksLikeProviderAuthDeath("API Error: 401 Invalid authentication credentials")).toBe(true);
    // Codex CLI: refresh rejection and invalidated tokens.
    expect(looksLikeProviderAuthDeath("Failed to refresh token: 401 Unauthorized")).toBe(true);
    expect(looksLikeProviderAuthDeath("Your session has ended. Please log in again.")).toBe(true);
    expect(
      looksLikeProviderAuthDeath("Your access token could not be refreshed because your refresh token was revoked.")
    ).toBe(true);
    expect(looksLikeProviderAuthDeath("Your authentication token has been invalidated. code: token_invalidated")).toBe(
      true
    );
    // Antigravity agy CLI: headless auth and keyring token failures.
    expect(looksLikeProviderAuthDeath("You are not logged into Antigravity.")).toBe(true);
    expect(looksLikeProviderAuthDeath("Error: failed to retrieve token: secret keyring is locked")).toBe(true);
    expect(looksLikeProviderAuthDeath("Failed to get OAuth token: error getting token source")).toBe(true);
    // OpenCode providers: auth error and invalid keys.
    expect(looksLikeProviderAuthDeath("ProviderAuthError: Failed to authenticate with openai")).toBe(true);
    expect(looksLikeProviderAuthDeath("HTTP 401: Invalid API key.")).toBe(true);
  });

  test("does not match quota, unavailable, or spawn", () => {
    expect(looksLikeProviderAuthDeath("429 rate limit exceeded")).toBe(false);
    expect(looksLikeProviderAuthDeath("model not found")).toBe(false);
    expect(looksLikeProviderAuthDeath("EACCES: mkdir '/data/.local/state'")).toBe(false);
    expect(looksLikeProviderAuthDeath("spawn opencode ENOENT")).toBe(false);
  });

  test("does not match bare 401, unauthorized, or expired task text", () => {
    expect(looksLikeProviderAuthDeath("request failed with status 401")).toBe(false);
    expect(looksLikeProviderAuthDeath("operation unauthorized by policy")).toBe(false);
    expect(looksLikeProviderAuthDeath("session expired while waiting for tool")).toBe(false);
    expect(looksLikeProviderAuthDeath("You've hit your session limit")).toBe(false);
  });

  test("ignores the Claude config-file warning when classifying auth", () => {
    const warning = "Claude configuration file not found at: /data/.claude.json\nRestoring configuration from backup";
    expect(looksLikeProviderAuthDeath(warning)).toBe(false);
    expect(stripClaudeConfigWarning(warning)).toBe("");
    const combined = `${warning}\nFailed to authenticate: OAuth session expired and could not be refreshed`;
    expect(looksLikeProviderAuthDeath(combined)).toBe(true);
  });
});

describe("providerAuthDeathMessage", () => {
  test("is a short hostname line", () => {
    const message = providerAuthDeathMessage();
    expect(message).toBe(`${hostname()}: ${AUTH_DEATH_REASON}`);
    expect(message).toContain("auth");
    expect(new TextEncoder().encode(message).byteLength).toBeLessThan(140);
  });
});

describe("isAuthFailure", () => {
  test("uses EngineFailedError.auth and stderr heuristics", () => {
    expect(isAuthFailure(new EngineFailedError(providerAuthDeathMessage(), false, { auth: true }))).toBe(true);
    expect(isAuthFailure(new EngineFailedError("missing API key", true))).toBe(false);
    expect(isAuthFailure(new EngineFailedError("EACCES: mkdir", true))).toBe(false);
    expect(isAuthFailure(new Error("invalid_grant"))).toBe(true);
    expect(isAuthFailure(new Error("cannot save result for job 1"))).toBe(false);
  });
});
