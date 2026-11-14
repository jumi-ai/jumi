import { GiteaAPI } from "./api.ts";
import { GithubAPI } from "./github_api.ts";
import { GithubAppAuth } from "./github_auth.ts";
import type { Forge, Tracker } from "./ports.ts";

export type { Forge, Tracker } from "./ports.ts";

export type ForgeKind = "gitea" | "github";

export const DEFAULT_FORGE_COMMITTER_NAME = "jumi";
export const DEFAULT_FORGE_COMMITTER_EMAIL = "jumi@localhost";
export const FORGE_COMMITTER_NAME = DEFAULT_FORGE_COMMITTER_NAME;
export const FORGE_COMMITTER_EMAIL = DEFAULT_FORGE_COMMITTER_EMAIL;

export function forgeCommitterName(env: Record<string, string | undefined> = process.env): string {
  return env.JUMI_GIT_NAME?.trim() || DEFAULT_FORGE_COMMITTER_NAME;
}

export function forgeCommitterEmail(env: Record<string, string | undefined> = process.env): string {
  return env.JUMI_GIT_EMAIL?.trim() || DEFAULT_FORGE_COMMITTER_EMAIL;
}

export function parseForge(value: string | undefined): ForgeKind {
  if (!value || value === "gitea") return "gitea";
  if (value === "github") return "github";
  throw new Error(`Invalid FORGE: ${value}`);
}

export function createGiteaForge(serverUrl: string, token: string): Tracker & Forge {
  return new GiteaAPI(serverUrl, token);
}

export function createGithubForge(config: {
  token?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}): Tracker & Forge {
  if (config.githubAppId && config.githubAppPrivateKey) {
    return new GithubAPI({
      auth: new GithubAppAuth({
        appId: config.githubAppId,
        privateKey: config.githubAppPrivateKey,
        installationId: config.githubAppInstallationId,
      }),
    });
  }
  if (config.token) return new GithubAPI({ token: config.token });
  throw new Error("GitHub credentials are missing");
}

export function createForge(config: {
  forge?: ForgeKind;
  giteaUrl: string;
  giteaToken: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}): Tracker & Forge {
  const forge = config.forge ?? "gitea";
  switch (forge) {
    case "gitea":
      return createGiteaForge(config.giteaUrl, config.giteaToken);
    case "github":
      return createGithubForge({
        token: config.giteaToken,
        githubAppId: config.githubAppId,
        githubAppPrivateKey: config.githubAppPrivateKey,
        githubAppInstallationId: config.githubAppInstallationId,
      });
    default: {
      const _exhaustive: never = forge;
      throw new Error(`Invalid FORGE: ${_exhaustive}`);
    }
  }
}
