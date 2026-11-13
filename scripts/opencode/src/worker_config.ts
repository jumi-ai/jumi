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
  automergeRepos: string[];
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
  /** Deployer maxima for repository timeouts. Unset, each maximum is the deployment timeout for that kind, so a repository can only shorten. */
  opencodeTimeoutMaxMs: number;
  followupTimeoutMaxMs: number;
  conflictTimeoutMaxMs: number;
  maxFollowupRounds: number;
  maxConflictRounds: number;
  databaseUrl?: string;
  leaseMs: number;
  maxJobAttempts: number;
  phoenixOtlpEndpoint?: string;
  checkpointEnabled: boolean;
  checkpointIntervalMs: number;
  checkpointMaxAgeMs: number;
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

function checkpointBit(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean for JUMI_CHECKPOINT_ENABLED: ${value}`);
}

function checkpointInterval(resolved: Env): number {
  const raw = resolved.JUMI_CHECKPOINT_INTERVAL_MS;
  if (raw === undefined || raw === "") return 300_000;
  if (raw.trim() === "0") return 0;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for JUMI_CHECKPOINT_INTERVAL_MS: ${raw}`);
  }
  return parsed;
}

function checkpointMaxAge(resolved: Env): number {
  const raw = resolved.JUMI_CHECKPOINT_MAX_AGE_MS;
  if (raw === undefined || raw === "") return 7 * 24 * 60 * 60 * 1000;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for JUMI_CHECKPOINT_MAX_AGE_MS: ${raw}`);
  }
  return parsed;
}

function checkpointFromEnv(
  resolved: Env
): Pick<WorkerConfig, "checkpointEnabled" | "checkpointIntervalMs" | "checkpointMaxAgeMs"> {
  const enabled = checkpointBit(resolved.JUMI_CHECKPOINT_ENABLED, true);
  const intervalMs = checkpointInterval(resolved);
  const maxAgeMs = checkpointMaxAge(resolved);
  if (!enabled || intervalMs === 0)
    return { checkpointEnabled: false, checkpointIntervalMs: intervalMs, checkpointMaxAgeMs: maxAgeMs };
  return { checkpointEnabled: true, checkpointIntervalMs: intervalMs, checkpointMaxAgeMs: maxAgeMs };
}

export function loadWorkerConfig(env: Env = process.env, opts: { requireWebhookSecret?: boolean } = {}): WorkerConfig {
  const resolved = overlaySecretsFromFile(env);
  // Owned by the image entrypoint (secrets tmpfs dir); read here so the
  // contract gate sees the optional key.
  void optionalEnv(resolved, SECRETS_DIR_ENV);
  const opencodeTimeoutMs = intEnv(resolved, "OPENCODE_TIMEOUT_MS", 4 * 60 * 60 * 1000);
  const followupTimeoutMs = intEnv(resolved, "FOLLOWUP_TIMEOUT_MS", 60 * 60 * 1000);
  const conflictTimeoutMs = intEnv(resolved, "CONFLICT_TIMEOUT_MS", 60 * 60 * 1000);
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
    automergeRepos: csvEnv(resolved, "JUMI_AUTOMERGE_REPOS"),
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
    followupTimeoutMs,
    conflictTimeoutMs,
    opencodeTimeoutMaxMs: intEnv(resolved, "OPENCODE_TIMEOUT_MAX_MS", opencodeTimeoutMs),
    followupTimeoutMaxMs: intEnv(resolved, "FOLLOWUP_TIMEOUT_MAX_MS", followupTimeoutMs),
    conflictTimeoutMaxMs: intEnv(resolved, "CONFLICT_TIMEOUT_MAX_MS", conflictTimeoutMs),
    maxFollowupRounds: intEnv(resolved, "MAX_FOLLOWUP_ROUNDS", 3),
    maxConflictRounds: intEnv(resolved, "MAX_CONFLICT_ROUNDS", 3),
    databaseUrl: optionalEnv(resolved, "DATABASE_URL"),
    leaseMs: intEnv(resolved, "LEASE_MS", opencodeTimeoutMs + 10 * 60 * 1000),
    maxJobAttempts: intEnv(resolved, "MAX_JOB_ATTEMPTS", 2),
    phoenixOtlpEndpoint: optionalEnv(resolved, "PHOENIX_OTLP_ENDPOINT"),
    ...checkpointFromEnv(resolved),
  };
}
