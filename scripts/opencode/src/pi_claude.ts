/**
 * Claude subscription inference for Pi (jumi#937).
 *
 * Pi owns history, tools, approvals and compaction. The unmodified,
 * operator-signed-in `claude -p` is inference only: it never runs tools.
 * This module is the Claude-specific production pin and the shared argv/env
 * contract the offline probe drives against the installed binary.
 *
 * Upstream grounding:
 * - Pi extension shape: https://github.com/earendil-works/pi-claude-code
 *   (`claude -p` per turn, Pi executes tools, subscription billing).
 * - Auth storage, precedence, `apiKeyHelper` re-runs, expiry and unattended
 *   sessions: https://code.claude.com/docs/en/authentication
 *
 * Disabled by default: selecting the route needs an explicit
 * `JUMI_PI_ALLOWED_ROUTES` entry for {@link PI_CLAUDE_ROUTE_NAME}.
 * Fresh-job delivery (empty `HOME`, one UID) cannot satisfy the official
 * login conditions or the #931 isolation fixture, so job mode stays blocked
 * (see {@link refusePiClaudeJobMode}).
 */

import type { PiProfileDefinition } from "./pi_profiles.ts";
import { CLAUDE_EFFORT_LEVELS } from "./runners.ts";

/** Pi route name. Allowlist it to opt in; unset means off. */
export const PI_CLAUDE_ROUTE_NAME = "pi-claude-opus-subscription" as const;
/** Subscription model operators check. */
export const PI_CLAUDE_MODEL = "claude-opus-5-5" as const;
/** Pi provider id for the Claude Code subscription extension shape. */
export const PI_CLAUDE_PROVIDER = "claude-code" as const;
/** Local helper endpoint: inference is a `claude -p` spawn, not HTTPS. */
export const PI_CLAUDE_ENDPOINT = "process://claude-code" as const;
/** Binary reused from the pinned image install (no third image). */
export const PI_CLAUDE_COMMAND = "claude" as const;
/** Pinned Claude CLI (mirrors `.gitea/tool-versions.env` CLAUDE_VERSION). */
export const PI_CLAUDE_PINNED_CLI = "2.1.332" as const;
/** Reviewed Pi SDK (mirrors `package.json` @earendil-works/pi-coding-agent). */
export const PI_CLAUDE_PINNED_PI = "1.6.1" as const;

/** Production profile: subscription payer, public scope only, no value. */
export const PI_CLAUDE_PROFILE: PiProfileDefinition = {
  provider: PI_CLAUDE_PROVIDER,
  model: PI_CLAUDE_MODEL,
  endpoint: PI_CLAUDE_ENDPOINT,
  fundingPool: "claude-subscription-pool",
  payer: "claude-subscription",
  credentialRef: "operator:claude-login (CLAUDE_CONFIG_DIR, no value)",
  scopes: ["public"],
};

export type PiClaudeFailureKind = "auth-expired" | "quota" | "cancelled" | "provider-failure";

/** Operator-only checks (no registration, sign-in, or spend happens here). */
export const PI_CLAUDE_OPERATOR_CHECKS: readonly string[] = [
  "Sign in with `claude auth login` in a browser and confirm `/status` names the subscription",
  "Smoke the subscription meter with `claude --model claude-opus-5-5 -p` and watch the 5-hour/weekly usage",
  "Extra Usage spends console balance and stays off unless you turn it on; subscription limits block as rate-limited",
  "Run `/logout` to revoke; an expired login stops instead of refreshing itself",
];

const AUTH_RE =
  /not logged in|please run \/login|authentication_failed|invalid_grant|login expired|login reached its time limit|oauth.+expired|expired.+oauth|CLAUDE_CODE_OAUTH_TOKEN.+expired|jwt refresh failed|signed out of claude/i;
const QUOTA_RE =
  /usage limit|rate limit|quota exceeded|too many requests|429|Go limit reached|FreeUsageLimitError|credit balance is too low|billing/i;
const CANCEL_RE = /AbortError|cancelled|The operation was aborted/i;

/** Classify one helper failure. Auth expiry stays distinct from quota and cancellation. */
export function classifyPiClaudeError(message: string | null | undefined): PiClaudeFailureKind {
  const text = message ?? "";
  if (!text) return "provider-failure";
  if (CANCEL_RE.test(text)) return "cancelled";
  if (AUTH_RE.test(text)) return "auth-expired";
  if (QUOTA_RE.test(text)) return "quota";
  return "provider-failure";
}

/** Per-turn token usage. Absent cache fields mean unknown, never zero. */
export interface PiClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Map a result usage payload to {@link PiClaudeUsage}. Cache fields are
 * carried only when the provider stated a number; otherwise they stay
 * absent (unknown). A missing usage block is missing, never zero.
 */
export function piClaudeUsageFromPayload(payload: unknown): PiClaudeUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const input = record.input_tokens ?? record.inputTokens;
  const output = record.output_tokens ?? record.outputTokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const out: PiClaudeUsage = { inputTokens: input, outputTokens: output };
  const cacheRead = record.cache_read_input_tokens ?? record.cacheReadTokens;
  const cacheWrite = record.cache_creation_input_tokens ?? record.cacheWriteTokens;
  if (typeof cacheRead === "number") out.cacheReadTokens = cacheRead;
  if (typeof cacheWrite === "number") out.cacheWriteTokens = cacheWrite;
  return out;
}

/** True only when the adapter reported usage. Missing is not zero. */
export function hasPiClaudeUsage(usage: PiClaudeUsage | undefined): boolean {
  return usage !== undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Validate an operator `--effort` level against the pinned binary's set. */
export function parsePiClaudeEffort(effort: string | undefined): string | undefined {
  if (effort === undefined || effort.trim() === "") return undefined;
  if (!CLAUDE_EFFORT_LEVELS.includes(effort)) {
    fail(`Invalid pi-claude effort ${JSON.stringify(effort)}: expected one of ${CLAUDE_EFFORT_LEVELS.join(", ")}`);
  }
  return effort;
}

/**
 * Production helper argv. Pi owns tools, so the helper gets none: `--tools ""`
 * removes built-ins, `--strict-mcp-config` with no `--mcp-config` drops every
 * MCP server (including claude.ai connectors), and `--disable-slash-commands`
 * drops skills and slash commands. `--no-session-persistence` keeps the helper
 * stateless per turn; Pi replays history and owns compaction. Never `--bare`:
 * bare mode skips subscription sign-in.
 */
export function buildPiClaudeArgv(opts: { model?: string; effort?: string } = {}): string[] {
  const model = opts.model?.trim() || PI_CLAUDE_MODEL;
  const effort = parsePiClaudeEffort(opts.effort);
  return [
    PI_CLAUDE_COMMAND,
    "-p",
    "--model",
    model,
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(effort ? ["--effort", effort] : []),
  ];
}

/** Env names that fail the spawn instead of being dropped (silent reroute). */
const PI_CLAUDE_REFUSED_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

const PI_CLAUDE_FORGE_ENV_RE =
  /^(GITEA_|GITHUB_APP_|GITHUB_WEBHOOK_|BOARD_.*TOKEN|GIT_AUTH_TOKEN|OPENCODE_API_KEY|XAI_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)/;

/**
 * Build the helper env from a scrubbed base. The operator login stays in
 * `HOME` (keychain / `.credentials.json` under `CLAUDE_CONFIG_DIR`); no
 * token is forwarded under any name, and proxy/Bedrock/Vertex/Foundry
 * overrides fail instead of silently rerouting helper egress.
 * `anthropicBaseUrl` is test-only (loopback stub); production omits it.
 */
export function buildPiClaudeEnv(
  home: string,
  baseEnv: Record<string, string | undefined> = process.env,
  opts: { anthropicBaseUrl?: string; path?: string; tmpdir?: string } = {}
): Record<string, string> {
  for (const name of PI_CLAUDE_REFUSED_ENV) {
    if ((baseEnv[name] ?? "").trim() !== "") fail(`pi-claude refused: ${name} is set`);
  }
  for (const name of Object.keys(baseEnv)) {
    if (PI_CLAUDE_FORGE_ENV_RE.test(name) && (baseEnv[name] ?? "").trim() !== "") {
      fail(`pi-claude refused: ${name} must not reach the helper`);
    }
  }
  if ((baseEnv.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim() !== "") {
    fail("pi-claude refused: CLAUDE_CODE_OAUTH_TOKEN must not reach the helper env (login lives in HOME)");
  }
  const env: Record<string, string> = {
    HOME: home,
    PATH: opts.path ?? baseEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: opts.tmpdir ?? baseEnv.TMPDIR ?? home,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_NONESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (opts.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = opts.anthropicBaseUrl;
  return env;
}

/** Fresh-job refusal: an empty `HOME` holds no grant and one UID cannot isolate one. */
export const PI_CLAUDE_JOB_BLOCKED_REASON =
  "pi-claude refused in one-shot jobs: empty HOME holds no Claude grant and the same UID cannot isolate a copied grant (see #931); use a standing pod with retained HOME" as const;

export interface PiClaudeJobRefusal {
  refused: boolean;
  reason?: string;
}

/**
 * Refuse the Claude subscription route in job mode when the deployment
 * allowlist names it. Disabled by default stays allowed-to-skip: an allowlist
 * without the route name is not a refusal.
 */
export function refusePiClaudeJobMode(allowlist: readonly string[]): PiClaudeJobRefusal {
  if (allowlist.includes(PI_CLAUDE_ROUTE_NAME)) {
    return { refused: true, reason: PI_CLAUDE_JOB_BLOCKED_REASON };
  }
  return { refused: false };
}
