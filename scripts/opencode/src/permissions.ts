import type { CollaboratorPermission } from "./ports.ts";

export type { CollaboratorPermission };

export type PermissionApi = {
  getCollaboratorPermission(owner: string, repo: string, username: string): Promise<CollaboratorPermission>;
  /** GitHub only: the permissions an App's installations hold, e.g. `{ contents: "write" }`. */
  getAppPermissions?(slug: string): Promise<Record<string, string> | undefined>;
};

/**
 * Same write-or-stronger bar for people and Apps.
 * Gitea reports `admin` / `write` / `read`.
 * GitHub reports `admin` / `maintain` / `write` / `triage` / `read`.
 * Fail-closed: anything else (including triage/read/none/unknown) is not write.
 */
const WRITE_PERMISSIONS = new Set(["write", "admin", "owner"]);
const WRITE_ROLE_NAMES = new Set(["write", "admin", "owner", "maintain", "push"]);

export function hasWritePermission(permission: string | undefined, roleName?: string | undefined): boolean {
  const perm = (permission ?? "").toLowerCase();
  if (WRITE_PERMISSIONS.has(perm)) return true;
  const role = (roleName ?? "").toLowerCase();
  if (WRITE_ROLE_NAMES.has(role)) return true;
  return false;
}

export function hasWriteAccessFromPermission(info: CollaboratorPermission | undefined): boolean {
  if (!info) return false;
  return hasWritePermission(info.permission, info.role_name);
}

export function normalizePermission(permission: string | undefined | null): string {
  if (typeof permission !== "string" || !permission.trim()) return "none";
  return permission.trim().toLowerCase();
}

function loginKey(login: string | undefined | null): string | undefined {
  if (typeof login !== "string") return undefined;
  const trimmed = login.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

function permissionFromResult(result: CollaboratorPermission | undefined | null): string | undefined {
  if (result == null) return undefined;
  if (typeof result.permission === "string" && result.permission.trim()) return result.permission;
  if (typeof result.role_name === "string" && result.role_name.trim()) return result.role_name;
  return undefined;
}

export interface ResolvePermissionsResult {
  /** Raw forge permission per lowercased login, fail-closed `"none"` on any lookup failure. */
  detail: Map<string, string>;
  /** Can push, per login, using the same bar as follow-up (`canPush`). */
  writes: Map<string, boolean>;
  /** Distinct logins queried. */
  lookups: number;
  /** Lookups that failed (including unavailable API); detail holds `"none"` for each. */
  failures: number;
  /** First forge error message (truncated), for server-side warning logs. Not for the prompt. */
  sampleError?: string;
}

/**
 * Raw permission strings per login, lowercased. Fail-closed entries are `"none"`.
 * Counts per-login failures so callers can warn when a systemic forge denial
 * demotes every writer to discussion instead of looking like a thread with no writers.
 */
export async function resolvePermissions(
  api: Partial<PermissionApi> | undefined,
  owner: string,
  repo: string,
  logins: Iterable<string | undefined | null>
): Promise<ResolvePermissionsResult> {
  const distinct = new Map<string, string>();
  for (const login of logins) {
    const key = loginKey(login);
    if (!key) continue;
    if (!distinct.has(key) && typeof login === "string" && login.trim()) {
      distinct.set(key, login.trim());
    }
  }
  const out = new Map<string, string>();
  const writes = new Map<string, boolean>();
  if (typeof api?.getCollaboratorPermission !== "function") {
    for (const key of distinct.keys()) {
      out.set(key, "none");
      writes.set(key, false);
    }
    return {
      detail: out,
      writes,
      lookups: distinct.size,
      failures: distinct.size,
      ...(distinct.size > 0 ? { sampleError: "collaborator permission API unavailable" } : {}),
    };
  }
  const errors: string[] = [];
  await Promise.all(
    [...distinct.entries()].map(async ([key, login]) => {
      const access = await pushAccess(api, owner, repo, login);
      if (access.error !== undefined) errors.push(access.error);
      out.set(key, access.permission);
      writes.set(key, access.push);
    })
  );
  return {
    detail: out,
    writes,
    lookups: distinct.size,
    failures: errors.length,
    ...(errors.length > 0 && errors[0] ? { sampleError: errors[0].slice(0, 240) } : {}),
  };
}

/** `renovate[bot]` → `renovate`. GitHub Apps act as `<slug>[bot]`; plain users return undefined. */
export function appSlugFromLogin(login: string | undefined | null): string | undefined {
  if (typeof login !== "string") return undefined;
  const match = /^(.+)\[bot\]$/i.exec(login.trim());
  return match?.[1] || undefined;
}

interface PushAccess {
  /** Raw forge permission, lowercased; `"write"` for an App whose installation can push. */
  permission: string;
  push: boolean;
  /** Collaborator lookup failure that the App check did not overrule. */
  error?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Collaborator permission `none` (or a 404) is not a no for a GitHub App: GitHub
 * reports no collaborator permission for Apps that push branches onto the repo,
 * Renovate among them. The App acts on this repository, so its installation
 * covers it; `contents: write` on that installation is push.
 */
async function appCanPush(api: Partial<PermissionApi>, login: string): Promise<boolean> {
  const slug = appSlugFromLogin(login);
  if (!slug || typeof api.getAppPermissions !== "function") return false;
  try {
    const permissions = await api.getAppPermissions(slug);
    return (permissions?.contents ?? "").toLowerCase() === "write";
  } catch {
    return false;
  }
}

async function pushAccess(
  api: Partial<PermissionApi> | undefined,
  owner: string,
  repo: string,
  login: string
): Promise<PushAccess> {
  if (!api || typeof api.getCollaboratorPermission !== "function") {
    return { permission: "none", push: false, error: "collaborator permission API unavailable" };
  }
  let permission = "none";
  let error: string | undefined;
  try {
    const result = await api.getCollaboratorPermission(owner, repo, login);
    permission = normalizePermission(permissionFromResult(result));
    if (hasWriteAccessFromPermission(result)) return { permission, push: true };
  } catch (err) {
    error = errorText(err);
  }
  if (await appCanPush(api, login)) return { permission: "write", push: true };
  return { permission, push: false, ...(error !== undefined ? { error } : {}) };
}

/**
 * Fail-closed push check. A person needs write, admin, or owner (or a
 * maintain/push role). A GitHub App whose installation can write contents
 * counts even when the collaborator lookup says none. Any other lookup
 * failure, missing method, or unknown permission is false.
 */
export async function canPush(
  api: Partial<PermissionApi> | undefined,
  owner: string,
  repo: string,
  login: string | undefined
): Promise<boolean> {
  if (typeof login !== "string" || !login.trim()) return false;
  return (await pushAccess(api, owner, repo, login.trim())).push;
}

/**
 * A pull's author can push to the base repository. A head branch that already
 * lives on the base repository is proof. A fork head is not, so fall back to
 * the author's own push access.
 */
export async function pullAuthorCanPush(
  api: Partial<PermissionApi> | undefined,
  owner: string,
  repo: string,
  pr: { user?: { login?: string } | null; head?: { repo?: { full_name?: string } | null } | null }
): Promise<boolean> {
  const headRepo = pr.head?.repo?.full_name;
  if (typeof headRepo === "string" && headRepo.toLowerCase() === `${owner}/${repo}`.toLowerCase()) return true;
  return canPush(api, owner, repo, pr.user?.login ?? undefined);
}

/**
 * Batch push check with per-round caching. Fail-closed: logins that cannot
 * be confirmed to push are absent from the returned set.
 */
export async function trustedPushLogins(
  api: Partial<PermissionApi> | undefined,
  owner: string,
  repo: string,
  logins: readonly (string | undefined)[]
): Promise<Set<string>> {
  const trusted = new Set<string>();
  const seen = new Set<string>();
  const pending: Array<Promise<void>> = [];
  for (const raw of logins) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(
      (async () => {
        if (await canPush(api, owner, repo, raw)) trusted.add(key);
      })()
    );
  }
  await Promise.all(pending);
  return trusted;
}
