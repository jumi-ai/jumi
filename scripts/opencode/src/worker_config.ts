import { GITHUB_ENV, loadForgeBind, overlaySecretsFromFile, SECRETS_DIR_ENV } from "./config.ts";
import type { ForgeKind } from "./forge.ts";
import { parseOpenCodeWellKnownUrl } from "./opencode_auth.ts";
import {
  type IndependentReviewConfig,
  loadRunnersCatalog,
  modelsFromCatalog,
  type RunnerConfig,
  type RunnerSelectionMode,
  resolveRunnerSelection,
} from "./runners.ts";

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
  ignoreConflictsLabel: string;
  blockingQuestionAuthors: string[];
  model: string;
  variant?: string;
  fallbackModel?: string;
  fallbackVariant?: string;
  runners: Record<string, RunnerConfig>;
  chain: string[];
  independentReview?: IndependentReviewConfig;
  runnerSelection: RunnerSelectionMode;
  opencodeConfig?: string;
  opencodeWellKnownUrl?: string;
  opencodeWellKnownKey: string;
  opencodeWellKnownToken: string;
  codexAuthFile?: string;
  home: string;
  workdir: string;
  gradleSeedHome?: string;
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

export function loadWorkerConfig(env: Env = process.env, opts: { requireWebhookSecret?: boolean } = {}): WorkerConfig {
  const resolved = overlaySecretsFromFile(env);
  // Owned by the image entrypoint (secrets tmpfs dir); read here so the
  // contract gate sees the optional key.
  void optionalEnv(resolved, SECRETS_DIR_ENV);
  const opencodeTimeoutMs = intEnv(resolved, "OPENCODE_TIMEOUT_MS", 4 * 60 * 60 * 1000);
  const fromEnv = {
    model: optionalEnv(resolved, "OPENCODE_MODEL", "openai/gpt-5.5") ?? "openai/gpt-5.5",
    variant: optionalEnv(resolved, "OPENCODE_VARIANT"),
    fallbackModel: optionalEnv(resolved, "OPENCODE_FALLBACK_MODEL"),
    fallbackVariant: optionalEnv(resolved, "OPENCODE_FALLBACK_VARIANT"),
  };
  const forgeBind = loadForgeBind(resolved, { requireWebhookSecret: opts.requireWebhookSecret ?? true });
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
    ignoreConflictsLabel: optionalEnv(resolved, "IGNORE_CONFLICTS_LABEL", "ignore-conflicts") ?? "ignore-conflicts",
    blockingQuestionAuthors: csvEnv(resolved, "REVIEW_BLOCKING_QUESTION_AUTHORS"),
    ...(runnersFile ? modelsFromCatalog(runnersCatalog) : fromEnv),
    runners: runnersCatalog.runners,
    chain: runnersCatalog.chain,
    ...(runnersCatalog.independentReview ? { independentReview: runnersCatalog.independentReview } : {}),
    runnerSelection: resolveRunnerSelection(runnersCatalog),
    opencodeConfig: optionalEnv(resolved, "OPENCODE_CONFIG"),
    opencodeWellKnownUrl: parseOpenCodeWellKnownUrl(resolved.OPENCODE_WELLKNOWN_URL),
    opencodeWellKnownKey:
      optionalEnv(resolved, "OPENCODE_WELLKNOWN_KEY", "OPENCODE_WELLKNOWN_TOKEN") ?? "OPENCODE_WELLKNOWN_TOKEN",
    opencodeWellKnownToken: optionalEnv(resolved, "OPENCODE_WELLKNOWN_TOKEN", "unused") ?? "unused",
    codexAuthFile: optionalEnv(resolved, "CODEX_AUTH_FILE"),
    home: optionalEnv(resolved, "HOME", "/data") ?? "/data",
    workdir: optionalEnv(resolved, "WORKDIR", "/work") ?? "/work",
    gradleSeedHome: optionalEnv(resolved, "GRADLE_SEED_HOME"),
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
