import { readFileSync, unlinkSync } from "node:fs";
import { GITHUB_ENV, loadForgeBind, SECRET_ENV_KEYS, SECRETS_FILE_ENV } from "./config.ts";
import { type ForgeKind, parseForge } from "./forge.ts";
import { parseOpenCodeWellKnownUrl } from "./opencode_auth.ts";
import { type IndependentReviewConfig, loadRunnersCatalog, modelsFromCatalog, type RunnerConfig } from "./runners.ts";

export interface WorkerConfig {
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
  independentReview?: IndependentReviewConfig;
  opencodeConfig?: string;
  opencodeWellKnownUrl?: string;
  opencodeWellKnownKey: string;
  opencodeWellKnownToken: string;
  home: string;
  workdir: string;
  queueConcurrency: number;
  maxOutputBytes: number;
  maxWebhookBytes: number;
  opencodeTimeoutMs: number;
  followupTimeoutMs: number;
  conflictTimeoutMs: number;
  maxFollowupRounds: number;
  maxConflictRounds: number;
  databaseUrl?: string;
  leaseMs: number;
  maxJobAttempts: number;
  phoenixOtlpEndpoint?: string;
}

type Env = Record<string, string | undefined>;

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

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const resolved = overlaySecretsFromFile(env);
  const opencodeTimeoutMs = intEnv(resolved, "OPENCODE_TIMEOUT_MS", 4 * 60 * 60 * 1000);
  const fromEnv = {
    model: optionalEnv(resolved, "OPENCODE_MODEL", "openai/gpt-5.5") ?? "openai/gpt-5.5",
    variant: optionalEnv(resolved, "OPENCODE_VARIANT"),
    fallbackModel: optionalEnv(resolved, "OPENCODE_FALLBACK_MODEL"),
    fallbackVariant: optionalEnv(resolved, "OPENCODE_FALLBACK_VARIANT"),
  };
  const forge = parseForge(resolved.FORGE);
  const runnersFile = optionalEnv(resolved, "JUMI_RUNNERS_FILE");
  const runnersCatalog = loadRunnersCatalog(runnersFile, fromEnv, forge);
  const forgeBind =
    forge === "github"
      ? loadForgeBind(resolved, { requireWebhookSecret: true })
      : {
          forge,
          giteaUrl: normalizeUrl(requireEnv(resolved, "GITEA_URL")),
          giteaToken: requireEnv(resolved, "GITEA_BOT_TOKEN"),
          webhookSecret: requireEnv(resolved, "GITEA_WEBHOOK_SECRET"),
          webhookAuthToken: optionalEnv(resolved, "GITEA_WEBHOOK_AUTH_TOKEN"),
          allowedOrgs: csvEnv(resolved, "GITEA_ALLOWED_ORGS", ["kirmanak"]),
          allowedRepos: csvEnv(resolved, "GITEA_ALLOWED_REPOS"),
        };
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
    ...(runnersCatalog.independentReview ? { independentReview: runnersCatalog.independentReview } : {}),
    opencodeConfig: optionalEnv(resolved, "OPENCODE_CONFIG"),
    opencodeWellKnownUrl: parseOpenCodeWellKnownUrl(resolved.OPENCODE_WELLKNOWN_URL),
    opencodeWellKnownKey:
      optionalEnv(resolved, "OPENCODE_WELLKNOWN_KEY", "OPENCODE_WELLKNOWN_TOKEN") ?? "OPENCODE_WELLKNOWN_TOKEN",
    opencodeWellKnownToken: optionalEnv(resolved, "OPENCODE_WELLKNOWN_TOKEN", "unused") ?? "unused",
    home: optionalEnv(resolved, "HOME", "/data") ?? "/data",
    workdir: optionalEnv(resolved, "WORKDIR", "/work") ?? "/work",
    queueConcurrency: intEnv(resolved, "QUEUE_CONCURRENCY", 1),
    maxOutputBytes: intEnv(resolved, "MAX_OUTPUT_BYTES", 80_000),
    maxWebhookBytes: intEnv(resolved, "MAX_WEBHOOK_BYTES", 1_048_576),
    opencodeTimeoutMs,
    followupTimeoutMs: intEnv(resolved, "FOLLOWUP_TIMEOUT_MS", 60 * 60 * 1000),
    conflictTimeoutMs: intEnv(resolved, "CONFLICT_TIMEOUT_MS", 60 * 60 * 1000),
    maxFollowupRounds: intEnv(resolved, "MAX_FOLLOWUP_ROUNDS", 3),
    maxConflictRounds: intEnv(resolved, "MAX_CONFLICT_ROUNDS", 3),
    databaseUrl: optionalEnv(resolved, "DATABASE_URL"),
    leaseMs: intEnv(resolved, "LEASE_MS", opencodeTimeoutMs + 10 * 60 * 1000),
    maxJobAttempts: intEnv(resolved, "MAX_JOB_ATTEMPTS", 2),
    phoenixOtlpEndpoint: optionalEnv(resolved, "PHOENIX_OTLP_ENDPOINT"),
  };
}
