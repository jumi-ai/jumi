/**
 * Credential selection for runner catalog entries.
 *
 * A Claude catalog entry authenticates with the Claude subscription token
 * (`CLAUDE_CODE_OAUTH_TOKEN`, today's behavior) unless it declares API-key
 * auth: `auth: "api-key"` plus `authEnv` naming the parent environment
 * variable that holds the Anthropic Console API key. The key value never
 * appears in the catalog file; the child receives it as `ANTHROPIC_API_KEY`.
 *
 * The field names are deliberately harness-neutral so other runner types can
 * adopt the same idea later. Today only `type: claude` accepts `"api-key"`.
 */

export const CLAUDE_CODE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";

/** Catalog `auth` value that keeps today's subscription-token behavior. */
export const RUNNER_AUTH_SUBSCRIPTION = "subscription" as const;
/** Catalog `auth` value that bills the run to an Anthropic Console API key. */
export const RUNNER_AUTH_API_KEY = "api-key" as const;

export type RunnerAuthMode = typeof RUNNER_AUTH_SUBSCRIPTION | typeof RUNNER_AUTH_API_KEY;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parent variable names must be real env names, never empty or malformed. */
export function isValidEnvName(value: string): boolean {
  return ENV_NAME_RE.test(value);
}

/**
 * Resolve the API key for one spawn from the parent environment. Returns
 * undefined when the variable is unset or blank (the caller treats that as
 * "no usable credentials" and hops, never as a hard failure). Never throws,
 * never logs the value.
 */
export function resolveClaudeApiKey(
  authEnv: string | undefined,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (!authEnv) return undefined;
  const raw = env[authEnv];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export interface RunnerAuthFields {
  auth?: string | undefined;
  authEnv?: string | undefined;
}

/**
 * Distinct non-empty API key values named by `api-key` entries in `chain`.
 * Lets the parent redact the key from prose it publishes (diary, board,
 * issue and PR text) without ever writing the value to a catalog file.
 */
export function claudeApiKeySecrets(
  chain: readonly RunnerAuthFields[] | undefined,
  env: Record<string, string | undefined> = process.env
): string[] {
  if (!chain) return [];
  const names = new Set<string>();
  for (const entry of chain) {
    if (entry?.auth === RUNNER_AUTH_API_KEY && typeof entry.authEnv === "string" && entry.authEnv) {
      names.add(entry.authEnv);
    }
  }
  const out: string[] = [];
  for (const name of names) {
    const value = resolveClaudeApiKey(name, env);
    if (value) out.push(value);
  }
  return out;
}

/**
 * Distinct parent variable names that hold API keys for `api-key` entries in
 * `chain`. Spawns strip these names from every child env so the variable
 * never leaks into a child under its own name.
 */
export function claudeApiKeyVarNames(chain: readonly RunnerAuthFields[] | undefined): string[] {
  if (!chain) return [];
  const names = new Set<string>();
  for (const entry of chain) {
    if (entry?.auth === RUNNER_AUTH_API_KEY && typeof entry.authEnv === "string" && entry.authEnv) {
      names.add(entry.authEnv);
    }
  }
  return [...names];
}
