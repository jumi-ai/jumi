/**
 * Access policy for the parent-held git credential proxy (`child_git_proxy.ts`).
 *
 * `read-write` (the default) forwards every git smart-HTTP path scoped to the
 * claimed repo. `read-only` serves authenticated fetch/clone — GET/HEAD on
 * read paths plus POST to `git-upload-pack` — and refuses every push endpoint
 * with 404 without contacting upstream or sending the credential.
 */

export type ChildGitProxyAccess = "read-write" | "read-only";

export function normalizedScope(owner?: string, repo?: string): { o: string; r: string } | undefined {
  const o = owner?.trim();
  const r = repo?.trim().replace(/\.git$/, "");
  if (!o || !r || o.includes("/") || r.includes("/") || o === "." || r === "." || o === ".." || r === "..") {
    return undefined;
  }
  return { o, r };
}

/**
 * Git smart-HTTP suffixes the proxy forwards, scoped to the claimed repo.
 * Both the `.git` and the bare (`/owner/repo/...`, which Gitea also serves)
 * bases require the same suffix: `info/refs` (ref advertisement),
 * `HEAD`, `objects/...` (dumb-HTTP object reads), and the two RPC endpoints.
 * Anything else — the repo root, `/issues`, `/pulls/...`, `/raw/...`,
 * `/archive/...` — is the forge web UI, not git, and gets 404 without ever
 * seeing the token.
 */
function gitSuffixAllowed(remainder: string): boolean {
  if (remainder === "info/refs") return true;
  if (remainder === "HEAD") return true;
  if (remainder === "git-upload-pack" || remainder === "git-receive-pack") return true;
  if (remainder.startsWith("objects/") && remainder.length > "objects/".length) return true;
  return false;
}

/**
 * Remainder of `pathname` after the claimed `/owner/repo(.git)/` base, or
 * `undefined` when the path is not a proxy-served git path. Forge-API and
 * attachment denials and the fail-closed unscoped refusal live here so both
 * the path check and the method/query-aware request check share them.
 */
function scopedRemainder(pathname: string, owner?: string, repo?: string): string | undefined {
  if (pathname.includes("\0") || pathname.includes("..")) return undefined;
  // Explicit forge-API denials first so an unknown-scope proxy still refuses them.
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/attachments" ||
    pathname.startsWith("/attachments/")
  ) {
    return undefined;
  }
  const scope = normalizedScope(owner, repo);
  // Fail closed without a valid scope: an unscoped proxy serves nothing, so a
  // missing owner/repo can never turn the parent token into a forge-wide git
  // reader. `startChildGitProxy` also refuses to start unscoped.
  if (!scope) return undefined;
  const { o, r } = scope;
  const gitBase = `/${o}/${r}.git/`;
  const bareBase = `/${o}/${r}/`;
  let remainder: string | undefined;
  if (pathname.startsWith(gitBase)) {
    remainder = pathname.slice(gitBase.length);
  } else if (pathname.startsWith(bareBase)) {
    remainder = pathname.slice(bareBase.length);
    // `/o/r/.git/...` is not a git smart-HTTP endpoint (the endpoint is
    // `/o/r/HEAD`, not `/o/r/.git/HEAD`), so it stays denied.
    if (remainder === ".git" || remainder.startsWith(".git/")) return undefined;
  } else {
    return undefined;
  }
  if (!remainder) return undefined;
  return remainder;
}

function pathAllowed(pathname: string, owner?: string, repo?: string): boolean {
  const remainder = scopedRemainder(pathname, owner, repo);
  if (remainder === undefined) return false;
  return gitSuffixAllowed(remainder);
}

export function isGitPathAllowed(pathname: string, owner?: string, repo?: string): boolean {
  return pathAllowed(pathname, owner, repo);
}

/**
 * Method- and query-aware gate for the proxy. `read-write` (the default)
 * keeps the path-only behavior: any method on an allowed git path is
 * forwarded. `read-only` additionally refuses everything that could move a
 * ref: only GET/HEAD on read paths (`info/refs` advertisement, `HEAD`,
 * `objects/...`) and POST to `git-upload-pack` are allowed. In particular
 * `git-receive-pack` (any method) and its `info/refs` advertisement are
 * refused, and an `info/refs` service query must name exactly `git-upload-pack`
 * — a second, empty, or different service value is refused.
 */
export function isGitRequestAllowed(
  pathname: string,
  search: string,
  method: string,
  owner?: string,
  repo?: string,
  access: ChildGitProxyAccess = "read-write"
): boolean {
  if (!pathAllowed(pathname, owner, repo)) return false;
  if (access !== "read-only") return true;
  const remainder = scopedRemainder(pathname, owner, repo);
  if (remainder === undefined || !gitSuffixAllowed(remainder)) return false;
  const upper = method.toUpperCase();
  if (remainder === "git-receive-pack") return false;
  if (remainder === "info/refs") {
    if (upper !== "GET" && upper !== "HEAD") return false;
    let services: string[];
    try {
      const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
      services = params.getAll("service");
    } catch {
      return false;
    }
    if (services.length === 0) return true;
    return services.length === 1 && services[0] === "git-upload-pack";
  }
  if (remainder === "git-upload-pack") {
    return upper === "POST";
  }
  // `HEAD` and `objects/...`: dumb-HTTP reads only.
  return upper === "GET" || upper === "HEAD";
}
