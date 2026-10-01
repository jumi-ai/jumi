import type { CollaboratorPermission } from "./ports.ts";

export type { CollaboratorPermission };

export type PermissionApi = {
  getCollaboratorPermission(owner: string, repo: string, username: string): Promise<CollaboratorPermission>;
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

/**
 * Besides the legacy flat `permission` / `role_name`, a
 * `user.permissions.push === true` from the collaborator lookup is push: it
 * is the user's effective grant, including team grants, even when the flat
 * mode is `read`/`none`.
 */
export function hasWriteAccessFromPermission(info: CollaboratorPermission | undefined): boolean {
  if (!info) return false;
  if (hasWritePermission(info.permission, info.role_name)) return true;
  return info.user?.permissions?.push === true;
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

interface PushAccess {
  /** Raw forge permission, lowercased. */
  permission: string;
  push: boolean;
  /** Collaborator lookup failure. */
  error?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The collaborator lookup is the only check scoped to the login asked about,
 * for people and GitHub Apps alike. There is deliberately no App fallback:
 * `GET /apps/{slug}` reports what an App requests and only when the factory
 * can read that record, and `GET /repos/{owner}/{repo}/installation` reports
 * the factory App's own grant, which would admit every `[bot]` login.
 */
async function pushAccess(
  api: Partial<PermissionApi> | undefined,
  owner: string,
  repo: string,
  login: string
): Promise<PushAccess> {
  if (!api || typeof api.getCollaboratorPermission !== "function") {
    return { permission: "none", push: false, error: "collaborator permission API unavailable" };
  }
  try {
    const result = await api.getCollaboratorPermission(owner, repo, login);
    const permission = normalizePermission(permissionFromResult(result));
    return { permission, push: hasWriteAccessFromPermission(result) };
  } catch (err) {
    return { permission: "none", push: false, error: errorText(err) };
  }
}

/**
 * Fail-closed push check, the same for people and Apps: write, admin, or
 * owner (or a maintain/push role, or an effective `push: true` grant). Any
 * lookup failure, missing method, or unknown permission is false.
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
 * lives on the base repository is proof. A fork head is not: only the
 * collaborator lookup counts there, never a webhook payload hint.
 */
export async function pullAuthorCanPush(
  api: Partial<PermissionApi> | undefined,
  owner: string,
  repo: string,
  pr: { user?: { login?: string } | null; head?: { repo?: { full_name?: string } | null } | null }
): Promise<boolean> {
  const headRepo = pr.head?.repo?.full_name;
  if (typeof headRepo === "string" && headRepo.toLowerCase() === `${owner}/${repo}`.toLowerCase()) return true;
  const login = pr.user?.login;
  if (typeof login !== "string" || !login.trim()) return false;
  if (!api || typeof api.getCollaboratorPermission !== "function") return false;
  try {
    return hasWriteAccessFromPermission(await api.getCollaboratorPermission(owner, repo, login.trim()));
  } catch {
    return false;
  }
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
