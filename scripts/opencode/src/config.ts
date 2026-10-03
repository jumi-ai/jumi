import { readFileSync, unlinkSync } from "node:fs";
import { type ForgeKind, parseForge } from "./forge.ts";
import { parseOpenCodeWellKnownUrl } from "./opencode_auth.ts";
import { loadRunnersCatalog, modelsFromCatalog, type RunnerConfig } from "./runners.ts";

export type JumiRole = "router" | "engine";

export interface ServiceConfig {
  host: string;
  port: number;
  forge: ForgeKind;
  giteaUrl: string;
  giteaToken: string;
  webhookSecret: string;
  githubWebhookSecret?: string;
  webhookAuthToken?: string;
  allowedOrgs: string[];
  allowedRepos: string[];
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
  botUsername: string;
  followupIgnoreLogins: string[];
  trustedSenderLogins: string[];
  model: string;
  variant?: string;
  fallbackModel?: string;
  fallbackVariant?: string;
  runners: Record<string, RunnerConfig>;
  chain: string[];
  opencodeConfig?: string;
  opencodeWellKnownUrl?: string;
  opencodeWellKnownKey: string;
  opencodeWellKnownToken: string;
  home: string;
  workdir: string;
  queueConcurrency: number;
  maxFiles: number;
  maxPatchBytes: number;
  maxOutputBytes: number;
  maxWebhookBytes: number;
  opencodeTimeoutMs: number;
  role: JumiRole;
  databaseUrl?: string;
  leaseMs: number;
  maxJobAttempts: number;
  maxFollowupRounds: number;
  maxIncompleteRetries: number;
  phoenixOtlpEndpoint?: string;
  boardPeerUrl?: string;
  boardPeerToken?: string;
}

type Env = Record<string, string | undefined>;

export const SECRET_ENV_KEYS = [
  "GITEA_BOT_TOKEN",
  "GITEA_WEBHOOK_SECRET",
  "GITEA_WEBHOOK_AUTH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "BOARD_PEER_TOKEN",
] as const;
export const SECRETS_FILE_ENV = "JUMI_SECRETS_FILE";
export const ENV_SCRUBBED_FLAG = "JUMI_ENV_SCRUBBED";

/** Drop forge secrets from the libc environment. Does not rewrite /proc/pid/environ. */
export function scrubSecretEnv(env: Env = process.env): void {
  for (const key of SECRET_ENV_KEYS) {
    delete env[key];
  }
}

function overlaySecretsFromFile(env: Env): Env {
  const path = env[SECRETS_FILE_ENV];
  if (!path) return env;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  try {
    unlinkSync(path);
  } catch {
    // Best-effort: the file is 0600 and lives on tmpfs.
  }
  const merged: Env = { ...env };
  for (const key of SECRET_ENV_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value) merged[key] = value;
  }
  delete merged[SECRETS_FILE_ENV];
  return merged;
}

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(env: Env, name: string, fallback?: string): string | undefined {
  return env[name] || fallback;
}

function intEnv(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${value}`);
  }
  return parsed;
}

function csvEnv(env: Env, name: string, fallback: string[] = []): string[] {
  const value = env[name];
  if (!value) return fallback;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

function requirePem(env: Env, name: string): string {
  const raw = requireEnv(env, name);
  const pem = raw.includes("\n") ? raw : raw.replace(/\\n/g, "\n");
  if (!PEM_BEGIN.test(pem) || !PEM_END.test(pem)) {
    throw new Error(`Invalid PEM for ${name}`);
  }
  return pem;
}

export type ForgeBind = {
  forge: ForgeKind;
  giteaUrl: string;
  giteaToken: string;
  webhookSecret: string;
  webhookAuthToken?: string;
  allowedOrgs: string[];
  allowedRepos: string[];
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
};

export const GITHUB_ENV = {
  appId: "GITHUB_APP_ID",
  appPrivateKey: "GITHUB_APP_PRIVATE_KEY",
  appInstallationId: "GITHUB_APP_INSTALLATION_ID",
  webhookSecret: "GITHUB_WEBHOOK_SECRET",
  url: "FORGE_URL",
  allowedOrgs: "GITHUB_ALLOWED_ORGS",
  allowedRepos: "GITHUB_ALLOWED_REPOS",
} as const;

export function loadForgeBind(env: Env, opts: { requireWebhookSecret: boolean }): ForgeBind {
  const forge = parseForge(env.FORGE);
  if (forge === "github") {
    const githubAppId = requireEnv(env, GITHUB_ENV.appId);
    const githubAppPrivateKey = requirePem(env, GITHUB_ENV.appPrivateKey);
    const githubAppInstallationId = optionalEnv(env, GITHUB_ENV.appInstallationId);
    const webhookSecret = opts.requireWebhookSecret
      ? requireEnv(env, GITHUB_ENV.webhookSecret)
      : (env[GITHUB_ENV.webhookSecret] ?? "");
    const giteaUrl = normalizeUrl(requireEnv(env, GITHUB_ENV.url));
    requireEnv(env, GITHUB_ENV.allowedOrgs);
    return {
      forge,
      giteaUrl,
      giteaToken: "",
      webhookSecret,
      allowedOrgs: csvEnv(env, GITHUB_ENV.allowedOrgs),
      allowedRepos: csvEnv(env, GITHUB_ENV.allowedRepos),
      githubAppId,
      githubAppPrivateKey,
      githubAppInstallationId,
    };
  }
  return {
    forge,
    giteaUrl: normalizeUrl(requireEnv(env, "GITEA_URL")),
    giteaToken: requireEnv(env, "GITEA_BOT_TOKEN"),
    webhookSecret: opts.requireWebhookSecret
      ? requireEnv(env, "GITEA_WEBHOOK_SECRET")
      : (env.GITEA_WEBHOOK_SECRET ?? ""),
    webhookAuthToken: optionalEnv(env, "GITEA_WEBHOOK_AUTH_TOKEN"),
    allowedOrgs: csvEnv(env, "GITEA_ALLOWED_ORGS", ["kirmanak"]),
    allowedRepos: csvEnv(env, "GITEA_ALLOWED_REPOS"),
  };
}

export function parseJumiRole(value: string | undefined): JumiRole {
  if (value === "router" || value === "engine") return value;
  if (!value) throw new Error("Missing required environment variable: JUMI_ROLE");
  throw new Error(`Invalid JUMI_ROLE: ${value}`);
}

const MAX_FOLLOWUP_ROUNDS_ENV = "MAX_FOLLOWUP_ROUNDS";
const MAX_INCOMPLETE_RETRIES_ENV = "MAX_INCOMPLETE_RETRIES";

export function loadConfig(env: Env = process.env): ServiceConfig {
  const resolved = overlaySecretsFromFile(env);
  const role = parseJumiRole(requireEnv(resolved, "JUMI_ROLE"));
  const opencodeTimeoutMs = intEnv(resolved, "OPENCODE_TIMEOUT_MS", 15 * 60 * 1000);
  const forgeBind = loadForgeBind(resolved, { requireWebhookSecret: role !== "engine" });
  const fromEnv = {
    model: optionalEnv(resolved, "OPENCODE_MODEL", "openai/gpt-5.5") ?? "openai/gpt-5.5",
    variant: optionalEnv(resolved, "OPENCODE_VARIANT"),
    fallbackModel: optionalEnv(resolved, "OPENCODE_FALLBACK_MODEL"),
    fallbackVariant: optionalEnv(resolved, "OPENCODE_FALLBACK_VARIANT"),
  };
  const runnersFile = optionalEnv(resolved, "JUMI_RUNNERS_FILE");
  const runnersCatalog = loadRunnersCatalog(runnersFile, fromEnv, forgeBind.forge);
  return {
    host: optionalEnv(resolved, "HOST", "0.0.0.0") ?? "0.0.0.0",
    port: intEnv(resolved, "PORT", 3000),
    ...forgeBind,
    githubWebhookSecret: resolved[GITHUB_ENV.webhookSecret] || undefined,
    botUsername: optionalEnv(resolved, "BOT_USERNAME", "jumi") ?? "jumi",
    followupIgnoreLogins: csvEnv(resolved, "FOLLOWUP_IGNORE_LOGINS"),
    trustedSenderLogins: csvEnv(resolved, "TRUSTED_SENDER_LOGINS"),
    ...(runnersFile ? modelsFromCatalog(runnersCatalog) : fromEnv),
    runners: runnersCatalog.runners,
    chain: runnersCatalog.chain,
    opencodeConfig: optionalEnv(resolved, "OPENCODE_CONFIG"),
    opencodeWellKnownUrl: parseOpenCodeWellKnownUrl(resolved.OPENCODE_WELLKNOWN_URL),
    opencodeWellKnownKey:
      optionalEnv(resolved, "OPENCODE_WELLKNOWN_KEY", "OPENCODE_WELLKNOWN_TOKEN") ?? "OPENCODE_WELLKNOWN_TOKEN",
    opencodeWellKnownToken: optionalEnv(resolved, "OPENCODE_WELLKNOWN_TOKEN", "unused") ?? "unused",
    home: optionalEnv(resolved, "HOME", "/data") ?? "/data",
    workdir: optionalEnv(resolved, "WORKDIR", "/work") ?? "/work",
    queueConcurrency: intEnv(resolved, "QUEUE_CONCURRENCY", 1),
    maxFiles: intEnv(resolved, "MAX_FILES", 100),
    maxPatchBytes: intEnv(resolved, "MAX_PATCH_BYTES", 500_000),
    maxOutputBytes: intEnv(resolved, "MAX_OUTPUT_BYTES", 80_000),
    maxWebhookBytes: intEnv(resolved, "MAX_WEBHOOK_BYTES", 1_048_576),
    opencodeTimeoutMs,
    role,
    databaseUrl: requireEnv(resolved, "DATABASE_URL"),
    leaseMs: intEnv(resolved, "LEASE_MS", opencodeTimeoutMs + 10 * 60 * 1000),
    maxJobAttempts: intEnv(resolved, "MAX_JOB_ATTEMPTS", 2),
    maxFollowupRounds: intEnv(resolved, MAX_FOLLOWUP_ROUNDS_ENV, 3),
    maxIncompleteRetries: intEnv(resolved, MAX_INCOMPLETE_RETRIES_ENV, 2),
    phoenixOtlpEndpoint: optionalEnv(resolved, "PHOENIX_OTLP_ENDPOINT"),
    boardPeerUrl: optionalEnv(resolved, "BOARD_PEER_URL"),
    boardPeerToken: optionalEnv(resolved, "BOARD_PEER_TOKEN"),
  };
}
