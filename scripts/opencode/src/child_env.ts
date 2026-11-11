/**
 * Explicit credential inventory for worker/review child processes.
 *
 * The sanitized env builders in `git.ts` (opencode), `claude.ts`, `codex.ts`,
 * and `agy.ts` start from a minimal base and copy only allowlisted
 * `extraEnv` keys. Everything else — including every forge token — must be
 * absent. This module is the single list the audit test checks each runner
 * against.
 */

/** Forge / webhook / git-push credentials that must never reach any child. */
export const CHILD_FORBIDDEN_KEYS = [
  "GITEA_BOT_TOKEN",
  "GITEA_WEBHOOK_SECRET",
  "GITEA_WEBHOOK_AUTH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_ID",
  "GITHUB_WEBHOOK_SECRET",
  "BOARD_PEER_TOKEN",
  "GIT_AUTH_TOKEN",
  "GIT_AUTH_URL",
  "JUMI_SECRETS_FILE",
] as const;

/** Prefixes that must never reach any child (covers GITEA_* / GITHUB_APP_* families). */
export const CHILD_FORBIDDEN_PREFIXES = ["GITEA_", "GITHUB_APP_", "GITHUB_WEBHOOK_"] as const;

/**
 * Provider credentials a child may still hold. Each is an accepted risk
 * documented in the README threat model: a prompt-injected child with shell
 * access can exfiltrate its own env to any host it can reach (egress is
 * unrestricted in the reference deployment), so these keys are reachable by
 * the model but never by the forge. They are allowlisted explicitly so a new
 * credential cannot slip in unnoticed.
 */
export const CHILD_PROVIDER_ALLOWLIST = [
  "OPENCODE_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "XAI_API_KEY",
] as const;

function isForbiddenKey(key: string): boolean {
  if ((CHILD_FORBIDDEN_KEYS as readonly string[]).includes(key)) return true;
  return CHILD_FORBIDDEN_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isProviderKey(key: string): boolean {
  return (CHILD_PROVIDER_ALLOWLIST as readonly string[]).includes(key);
}

export interface ChildEnvAudit {
  forbidden: string[];
  /** Provider keys present that are not on the explicit allowlist. */
  unlistedCredentials: string[];
  provider: string[];
}

const CREDENTIAL_HINT = /(TOKEN|KEY|SECRET|AUTH)/i;

/**
 * Audit one built child env. Fails when any forbidden forge key is present,
 * or when a credential-looking key is present that is neither a known
 * non-secret (GIT_AUTH_HOST/USERNAME, *_URL, *_DIR, etc.) nor on the
 * provider allowlist.
 */
export function auditChildEnv(env: Record<string, string>): ChildEnvAudit {
  const forbidden = Object.keys(env).filter(isForbiddenKey);
  const provider = Object.keys(env).filter(isProviderKey);
  const unlistedCredentials = Object.keys(env).filter((key) => {
    if (isForbiddenKey(key) || isProviderKey(key)) return false;
    if (!CREDENTIAL_HINT.test(key)) return false;
    return true;
  });
  return { forbidden, unlistedCredentials, provider };
}

/** Values the parent redacts from child output and published prose (git token only). */
export function gitSecretsFromEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  if (env.GIT_AUTH_TOKEN) out.push(env.GIT_AUTH_TOKEN);
  return out;
}
