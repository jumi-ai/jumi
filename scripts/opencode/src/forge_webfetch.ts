/**
 * Single source of truth for the forge host no Jumi child may webfetch.
 *
 * Every child that implements, follows up, or resolves conflicts holds a
 * write-capable git token through the credential helper. A child that can also
 * read the forge over HTTP can pull in issue/PR/Actions state the parent never
 * injected, and act on it. Containment is webfetch only: git push via the
 * credential helper stays allowed, and public upstream docs stay reachable.
 *
 * Prompt prose is a hint, not a control. The rules below are what the
 * binaries enforce: OpenCode through `OPENCODE_CONFIG_CONTENT`, Claude through
 * `--disallowedTools`, Antigravity through `permissions.deny` in
 * `settings.json`. Derive them here, not in another copy of prose.
 *
 * The host is per-spawn, not compile-time: the forge is configured, and the
 * GitHub factory hands the child `GIT_AUTH_HOST=github.com` with a write-capable
 * token, so baking in the homelab Gitea host would leave that factory open.
 */

/** Fallback for spawns that carry no `GIT_AUTH_HOST` (reviewer, tests). */
export const FORGE_DENY_DOMAIN = "kirmanak.stream";

export const PERMISSION_DENY_RE = /Permission denied:\s*\w+/i;

export function isPermissionDenyText(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  return PERMISSION_DENY_RE.test(text);
}

/**
 * The host the child must not reach, taken from the same env the git credential
 * helper authenticates against (`gitEnv` sets it from the configured forge URL).
 * The port is dropped: Claude `domain:` rules match the hostname, and the
 * OpenCode substring rule still covers `host:port` URLs without it.
 */
export function forgeDenyHost(extraEnv?: Record<string, string>): string {
  const host = extraEnv?.GIT_AUTH_HOST?.trim().toLowerCase();
  if (!host) return FORGE_DENY_DOMAIN;
  return host.replace(/:\d+$/, "");
}

/**
 * OpenCode webfetch matches the whole URL and is last-match, so the star allow
 * comes first and the denies win. Resource is the requested URL, `*` matches
 * across `/`: the host rule is a substring match, so it already covers
 * `api.<host>` and every path under it. GitHub code search is a forge read path
 * too. Array order is load-bearing.
 */
export interface ForgePermissionRule {
  action: "webfetch";
  resource: string;
  effect: "allow" | "ask" | "deny";
}

export function forgePermissions(host: string): ForgePermissionRule[] {
  return [
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "webfetch", resource: `*${host}*`, effect: "deny" },
    { action: "webfetch", resource: "*github.com/search*", effect: "deny" },
  ];
}

/** OpenCode reads this via `OPENCODE_CONFIG_CONTENT` as inline config. */
export function forgeOpenCodeConfigContent(host: string): string {
  return JSON.stringify({ permissions: forgePermissions(host) });
}

/**
 * Claude WebFetch rules match the hostname, so the apex and the subdomain
 * wildcard are both needed: `domain:*.host` does not cover `host` itself
 * (and `domain:host` does not cover `api.host`).
 * A deny at any level beats every allow, including `--allowedTools` and the
 * `user` settings source. Wildcards need Claude Code >= 2.1.172 (image: 2.1.280).
 */
export function claudeDisallowedTools(host: string): string {
  return [`WebFetch(domain:${host})`, `WebFetch(domain:*.${host})`].join(",");
}

/**
 * Antigravity `read_url(host)` matches the hostname and its subdomains, so one
 * apex rule covers `api.<host>` as well as the host itself. Deny outranks allow
 * and `--dangerously-skip-permissions`.
 */
export function agyReadUrlDeny(host: string): string {
  return `read_url(${host})`;
}
