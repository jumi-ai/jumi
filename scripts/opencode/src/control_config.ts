import { readFileSync, unlinkSync } from "node:fs";
import { SECRET_ENV_KEYS, SECRETS_FILE_ENV } from "./config.ts";

export interface ControlConfig {
  host: string;
  port: number;
  home: string;
  role: "control";
  secretName: string;
  secretNamespace: string;
  k8sApiUrl: string;
  k8sTokenFile: string;
  pollMs: number;
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

export function parseControlRole(value: string | undefined): "control" {
  if (value === "control") return "control";
  if (!value) throw new Error("Missing required environment variable: JUMI_ROLE");
  throw new Error(`Invalid JUMI_ROLE for control: ${value}`);
}

export function loadControlConfig(env: Env = process.env): ControlConfig {
  const resolved = overlaySecretsFromFile(env);
  parseControlRole(requireEnv(resolved, "JUMI_ROLE"));
  return {
    host: optionalEnv(resolved, "HOST", "0.0.0.0") ?? "0.0.0.0",
    port: intEnv(resolved, "PORT", 3000),
    home: optionalEnv(resolved, "HOME", "/data") ?? "/data",
    role: "control",
    secretName: optionalEnv(resolved, "CONTROL_SECRET_NAME", "codex-token") ?? "codex-token",
    secretNamespace: optionalEnv(resolved, "CONTROL_SECRET_NAMESPACE", defaultNamespace()) ?? "default",
    k8sApiUrl: defaultK8sApiUrl(resolved),
    k8sTokenFile:
      optionalEnv(resolved, "CONTROL_K8S_TOKEN_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token") ??
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    pollMs: intEnv(resolved, "CONTROL_POLL_MS", 60_000),
  };
}
