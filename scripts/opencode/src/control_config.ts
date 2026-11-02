import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { SECRET_ENV_KEYS, SECRETS_FILE_ENV } from "./config.ts";

export interface ControlDispatchRoleConfig {
  enabled: boolean;
  maxJobs?: number;
  templateFile?: string;
}

export interface ControlConfig {
  host: string;
  port: number;
  home: string;
  role: "control";
  secretName: string;
  secretNamespace: string;
  k8sApiUrl: string;
  k8sTokenFile: string;
  k8sCaFile: string;
  pollMs: number;
  databaseUrl?: string;
  jobNamespace: string;
  jobStartupTimeoutMs: number;
  dispatchPollMs: number;
  dispatchEngine: ControlDispatchRoleConfig;
  dispatchWorker: ControlDispatchRoleConfig;
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

function defaultK8sApiUrl(env: Env): string {
  if (env.CONTROL_K8S_API_URL) return env.CONTROL_K8S_API_URL.replace(/\/+$/, "");
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT?.trim();
  if (host && port) return `https://${host}:${port}`;
  if (host) return `https://${host}:443`;
  return "https://kubernetes.default.svc";
}

function defaultNamespace(): string {
  try {
    const raw = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8").trim();
    if (raw) return raw;
  } catch {
    // Local/dev without a service account: GitOps sets CONTROL_SECRET_NAMESPACE.
  }
  return "default";
}

function defaultK8sCaFile(tokenFile: string): string {
  return join(dirname(tokenFile), "ca.crt");
}

export function parseControlRole(value: string | undefined): "control" {
  if (value === "control") return "control";
  if (!value) throw new Error("Missing required environment variable: JUMI_ROLE");
  throw new Error(`Invalid JUMI_ROLE for control: ${value}`);
}

function isEnabledFlag(raw: string | undefined): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function parsePositiveIntOrUndefined(raw: string | undefined, name: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${raw}`);
  }
  return parsed;
}

export function loadControlConfig(env: Env = process.env): ControlConfig {
  const resolved = overlaySecretsFromFile(env);
  parseControlRole(requireEnv(resolved, "JUMI_ROLE"));
  const secretNamespace = optionalEnv(resolved, "CONTROL_SECRET_NAMESPACE", defaultNamespace()) ?? "default";
  // Every dispatch key is read unconditionally with a literal so the contract
  // scanner sees it even when dispatch is off; the missing-cap/template throw
  // below only fires when that role is enabled.
  const engineEnabled = isEnabledFlag(optionalEnv(resolved, "CONTROL_DISPATCH_ENGINE"));
  const workerEnabled = isEnabledFlag(optionalEnv(resolved, "CONTROL_DISPATCH_WORKER"));
  const engineMaxJobs = parsePositiveIntOrUndefined(
    optionalEnv(resolved, "CONTROL_ENGINE_MAX_JOBS"),
    "CONTROL_ENGINE_MAX_JOBS"
  );
  const workerMaxJobs = parsePositiveIntOrUndefined(
    optionalEnv(resolved, "CONTROL_WORKER_MAX_JOBS"),
    "CONTROL_WORKER_MAX_JOBS"
  );
  const engineTemplateFile = optionalEnv(resolved, "CONTROL_ENGINE_JOB_TEMPLATE_FILE");
  const workerTemplateFile = optionalEnv(resolved, "CONTROL_WORKER_JOB_TEMPLATE_FILE");
  if (engineEnabled) {
    if (engineMaxJobs == null) throw new Error("Missing required environment variable: CONTROL_ENGINE_MAX_JOBS");
    if (!engineTemplateFile) throw new Error("Missing required environment variable: CONTROL_ENGINE_JOB_TEMPLATE_FILE");
  }
  if (workerEnabled) {
    if (workerMaxJobs == null) throw new Error("Missing required environment variable: CONTROL_WORKER_MAX_JOBS");
    if (!workerTemplateFile) throw new Error("Missing required environment variable: CONTROL_WORKER_JOB_TEMPLATE_FILE");
  }
  const databaseUrl = optionalEnv(resolved, "DATABASE_URL");
  if ((engineEnabled || workerEnabled) && !databaseUrl) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }
  const k8sTokenFile =
    optionalEnv(resolved, "CONTROL_K8S_TOKEN_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token") ??
    "/var/run/secrets/kubernetes.io/serviceaccount/token";
  return {
    host: optionalEnv(resolved, "HOST", "0.0.0.0") ?? "0.0.0.0",
    port: intEnv(resolved, "PORT", 3000),
    home: optionalEnv(resolved, "HOME", "/data") ?? "/data",
    role: "control",
    secretName: optionalEnv(resolved, "CONTROL_SECRET_NAME", "codex-token") ?? "codex-token",
    secretNamespace,
    k8sApiUrl: defaultK8sApiUrl(resolved),
    k8sTokenFile,
    k8sCaFile:
      optionalEnv(resolved, "CONTROL_K8S_CA_FILE", defaultK8sCaFile(k8sTokenFile)) ?? defaultK8sCaFile(k8sTokenFile),
    pollMs: intEnv(resolved, "CONTROL_POLL_MS", 60_000),
    databaseUrl,
    jobNamespace: optionalEnv(resolved, "CONTROL_JOB_NAMESPACE", secretNamespace) ?? secretNamespace,
    jobStartupTimeoutMs: intEnv(resolved, "CONTROL_JOB_STARTUP_TIMEOUT_MS", 10 * 60 * 1000),
    dispatchPollMs: intEnv(resolved, "CONTROL_DISPATCH_POLL_MS", 10_000),
    dispatchEngine: {
      enabled: engineEnabled,
      ...(engineMaxJobs != null ? { maxJobs: engineMaxJobs } : {}),
      ...(engineTemplateFile ? { templateFile: engineTemplateFile } : {}),
    },
    dispatchWorker: {
      enabled: workerEnabled,
      ...(workerMaxJobs != null ? { maxJobs: workerMaxJobs } : {}),
      ...(workerTemplateFile ? { templateFile: workerTemplateFile } : {}),
    },
  };
}
