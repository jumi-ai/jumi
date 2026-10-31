import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { forgeRequestError } from "./forge_errors.ts";

const JWT_IAT_SKEW_SEC = 60;
const JWT_LIFETIME_SEC = 10 * 60;
export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_GIT_USERNAME = "x-access-token";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GithubTokenTarget = {
  owner?: string;
  repo?: string;
  installationId?: string;
};

export type GithubAppAuthOptions = {
  appId: string;
  privateKey: string;
  installationId?: string;
  apiUrl?: string;
  now?: () => number;
  fetchImpl?: FetchLike;
};

type CachedToken = {
  token: string;
  expiresAt: number;
};

function requireText(value: string | undefined, message: string): string {
  if (!value?.trim()) throw new Error(message);
  return value;
}

function parsePrivateKey(pem: string): KeyObject {
  requireText(pem, "Missing GitHub App private key");
  try {
    return createPrivateKey(pem);
  } catch {
    throw new Error("Invalid GitHub App private key");
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function installationIdText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

export function githubInstallationFromPayload(payload: unknown): {
  installationId?: string;
  owner?: string;
  repo?: string;
} {
  if (!isObject(payload)) return {};
  const installation = payload.installation;
  const installationId = isObject(installation) ? installationIdText(installation.id) : undefined;
  const repository = payload.repository;
  let owner: string | undefined;
  let repo: string | undefined;
  if (isObject(repository)) {
    if (typeof repository.full_name === "string") {
      const [fullOwner, fullRepo] = repository.full_name.split("/");
      if (fullOwner && fullRepo) {
        owner = fullOwner;
        repo = fullRepo;
      }
    }
    if (!owner || !repo) {
      const name = typeof repository.name === "string" ? repository.name : undefined;
      const ownerField = repository.owner;
      const ownerLogin =
        typeof ownerField === "string"
          ? ownerField
          : isObject(ownerField) && typeof ownerField.login === "string"
            ? ownerField.login
            : undefined;
      if (ownerLogin && name) {
        owner = ownerLogin;
        repo = name;
      }
    }
  }
  return { installationId, owner, repo };
}

export function createGithubAppJwt(opts: {
  appId: string;
  privateKey: string | KeyObject;
  now?: () => number;
}): string {
  const appId = requireText(typeof opts.appId === "string" ? opts.appId : "", "Missing GitHub App client ID");
  const key = typeof opts.privateKey === "string" ? parsePrivateKey(opts.privateKey) : opts.privateKey;
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iat: nowSec - JWT_IAT_SKEW_SEC,
    exp: nowSec + JWT_LIFETIME_SEC,
    iss: appId,
  })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
}

function readInstallationToken(body: string): CachedToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("GitHub installation token response is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GitHub installation token response is not JSON");
  }
  const token = (parsed as { token?: unknown }).token;
  const expiresAtRaw = (parsed as { expires_at?: unknown }).expires_at;
  if (typeof token !== "string" || !token) {
    throw new Error("GitHub installation token response is not JSON");
  }
  if (typeof expiresAtRaw !== "string") {
    throw new Error("GitHub installation token response is not JSON");
  }
  const expiresAt = Date.parse(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("GitHub installation token response is not JSON");
  }
  return { token, expiresAt };
}

function readRepositoryInstallationId(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("GitHub repository installation response is not JSON");
  }
  const id = installationIdText(isObject(parsed) ? parsed.id : undefined);
  if (!id) throw new Error("GitHub repository installation response is not JSON");
  return id;
}

export class GithubAppAuth {
  private readonly appId: string;
  private readonly key: KeyObject;
  private readonly defaultInstallationId: string | undefined;
  private readonly apiUrl: string;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly repoInstallations = new Map<string, string>();

  constructor(opts: GithubAppAuthOptions) {
    this.appId = requireText(opts.appId, "Missing GitHub App client ID");
    this.key = parsePrivateKey(opts.privateKey);
    this.defaultInstallationId = opts.installationId?.trim() || undefined;
    this.apiUrl = (opts.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, "");
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  createJwt(): string {
    return createGithubAppJwt({ appId: this.appId, privateKey: this.key, now: this.now });
  }

  rememberInstallation(installationId: string, owner?: string, repo?: string): void {
    const id = requireText(installationId, "Missing GitHub App installation ID");
    if (owner && repo) this.repoInstallations.set(repoKey(owner, repo), id);
  }

  rememberWebhookPayload(payload: unknown): void {
    const info = githubInstallationFromPayload(payload);
    if (info.installationId) this.rememberInstallation(info.installationId, info.owner, info.repo);
  }

  async getInstallationToken(target: GithubTokenTarget = {}): Promise<string> {
    const installationId = await this.resolveInstallationId(target);
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt > this.now()) return cached.token;
    return this.mintInstallationToken(installationId);
  }

  async refreshInstallationToken(target: GithubTokenTarget = {}): Promise<string> {
    const installationId = await this.resolveInstallationId(target);
    return this.mintInstallationToken(installationId);
  }

  private async resolveInstallationId(target: GithubTokenTarget): Promise<string> {
    const explicit = installationIdText(target.installationId);
    if (explicit) {
      this.rememberInstallation(explicit, target.owner, target.repo);
      return explicit;
    }
    if (target.owner && target.repo) {
      const cached = this.repoInstallations.get(repoKey(target.owner, target.repo));
      if (cached) return cached;
      const id = await this.fetchRepoInstallation(target.owner, target.repo);
      this.rememberInstallation(id, target.owner, target.repo);
      return id;
    }
    if (this.defaultInstallationId) return this.defaultInstallationId;
    throw new Error("Missing GitHub App installation ID");
  }

  private async fetchRepoInstallation(owner: string, repo: string): Promise<string> {
    const url = `${this.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`;
    const jwt = this.createJwt();
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
      },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw forgeRequestError({
        service: "GitHub API",
        method: "GET",
        url,
        status: res.status,
        body: text,
        secrets: [jwt],
      });
    }
    return readRepositoryInstallationId(text);
  }

  private async mintInstallationToken(installationId: string): Promise<string> {
    const url = `${this.apiUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
    const jwt = this.createJwt();
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
      },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw forgeRequestError({
        service: "GitHub API",
        method: "POST",
        url,
        status: res.status,
        body: text,
        secrets: [jwt],
      });
    }
    const minted = readInstallationToken(text);
    this.tokens.set(installationId, minted);
    return minted.token;
  }
}
