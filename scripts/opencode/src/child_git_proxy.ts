/**
 * Parent-held git credential proxy for worker children.
 *
 * A worker child used to receive `GIT_AUTH_TOKEN` in its environment so its
 * `git` could push. The same token authenticates the forge web UI and
 * `/api/v1`, so a prompt-injected `curl`/`urllib` built from
 * `$GIT_AUTH_USERNAME:$GIT_AUTH_TOKEN` could read and act on forge state the
 * parent never injected (`forge_webfetch.ts` only constrains WebFetch).
 *
 * Mechanism now: the parent keeps the token in process memory and serves a
 * loopback proxy for the duration of one engine spawn. The child env carries
 * no token — only `GIT_AUTH_HOST` (for the webfetch deny), `GIT_AUTH_USERNAME`
 * (non-secret), and `GIT_CONFIG_*` `url.<proxy>.insteadOf` rewrites so the
 * child's `git` talks to `http://127.0.0.1:<port>/` instead of the forge
 * directly. The proxy injects `Authorization: Basic` and forwards only git
 * smart-HTTP paths scoped to the claimed `owner/repo`; everything else
 * (`/api/v1/...`, `/attachments/...`, other repos) gets 404 without ever
 * seeing the token.
 *
 * The child and the proxy share a UID, so this is not a filesystem boundary:
 * it is a "what the child holds cannot authenticate" boundary. The child knows
 * the proxy URL but the proxy never reveals the token — it only performs
 * authenticated git requests on the child's behalf, and only for allowed paths.
 * A direct request to the forge built from anything the child can read has no
 * credentials and gets 401/403/404 from the forge itself.
 */

export interface ChildGitProxy {
  url: string;
  close(): Promise<void>;
}

export interface ChildGitProxyOptions {
  forgeUrl: string;
  username: string;
  token: string;
  owner?: string;
  repo?: string;
}

function normalizedBase(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  let path = url.pathname;
  if (!path.endsWith("/")) path += "/";
  url.pathname = path;
  return url.toString();
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

export function proxyAllowPrefixes(owner?: string, repo?: string): string[] {
  if (!owner || !repo) return [];
  const o = owner.trim();
  const r = repo.trim().replace(/\.git$/, "");
  if (!o || !r || o.includes("/") || r.includes("/") || o === "." || r === ".") return [];
  return [`/${o}/${r}.git/`, `/${o}/${r}.git`, `/${o}/${r}/`, `/${o}/${r}`];
}

function pathAllowed(pathname: string, owner?: string, repo?: string): boolean {
  if (pathname.includes("\0") || pathname.includes("..")) return false;
  // Explicit forge-API denials first so an unknown-scope proxy still refuses them.
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/attachments" ||
    pathname.startsWith("/attachments/")
  ) {
    return false;
  }
  const prefixes = proxyAllowPrefixes(owner, repo);
  if (prefixes.length > 0) {
    return prefixes.some((prefix) =>
      prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
  }
  // No scope (reviewer-style spawn without owner/repo): allow only git paths,
  // still never the API or attachments.
  return pathname.includes(".git/");
}

export function isGitPathAllowed(pathname: string, owner?: string, repo?: string): boolean {
  return pathAllowed(pathname, owner, repo);
}

const HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

export async function startChildGitProxy(opts: ChildGitProxyOptions): Promise<ChildGitProxy> {
  const forgeBase = normalizedBase(opts.forgeUrl);
  const forgeOrigin = new URL(forgeBase).origin;
  const forgePath = new URL(forgeBase).pathname.replace(/\/$/, "");
  const basic = `Basic ${Buffer.from(`${opts.username}:${opts.token}`).toString("base64")}`;
  const owner = opts.owner?.trim() || undefined;
  const repo = opts.repo?.trim().replace(/\.git$/, "") || undefined;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request): Promise<Response> {
      let targetPath: string;
      try {
        const incoming = new URL(req.url);
        if (!pathAllowed(incoming.pathname, owner, repo)) {
          return new Response("not found", { status: 404 });
        }
        targetPath = `${forgePath}${incoming.pathname}${incoming.search}`;
      } catch {
        return new Response("not found", { status: 404 });
      }
      const target = `${stripTrailingSlash(forgeOrigin)}${targetPath}`;
      const headers = new Headers();
      for (const [key, value] of req.headers) {
        if (HOP_HEADERS.has(key.toLowerCase())) continue;
        if (key.toLowerCase() === "host") continue;
        if (key.toLowerCase() === "authorization") continue;
        headers.set(key, value);
      }
      headers.set("authorization", basic);
      let body: ArrayBuffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        try {
          body = await req.arrayBuffer();
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
      let upstream: Response;
      try {
        upstream = await fetch(target, { method: req.method, headers, body: body as BodyInit | undefined });
      } catch {
        return new Response("bad gateway", { status: 502 });
      }
      const outHeaders = new Headers();
      for (const [key, value] of upstream.headers) {
        if (HOP_HEADERS.has(key.toLowerCase())) continue;
        outHeaders.set(key, value);
      }
      const outBody = await upstream.arrayBuffer().catch(() => undefined);
      return new Response(outBody, { status: upstream.status, headers: outHeaders });
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  return {
    url,
    async close(): Promise<void> {
      server.stop();
    },
  };
}

/**
 * `GIT_CONFIG_*` entries rewriting the forge origin(s) to the loopback proxy.
 * No credentials appear here — only the proxy URL, which cannot authenticate
 * without the parent-held token.
 */
export function childProxyGitConfigEntries(
  proxyUrl: string,
  opts: { forgeUrl: string; forgeHost: string }
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const origins = new Set<string>();
  try {
    origins.add(normalizedBase(opts.forgeUrl));
  } catch {
    // Fall through to host-derived origins below.
  }
  const host = opts.forgeHost.trim().toLowerCase().replace(/:\d+$/, "");
  if (host && !host.includes("/") && !host.includes("..")) {
    origins.add(`https://${opts.forgeHost.trim()}/`);
    origins.add(`http://${opts.forgeHost.trim()}/`);
  }
  for (const origin of origins) {
    entries.push([`url.${proxyUrl}.insteadOf`, origin]);
  }
  entries.push(["core.symlinks", "false"]);
  return entries;
}

export function childProxyGitConfigEnv(
  proxyUrl: string,
  opts: { forgeUrl: string; forgeHost: string }
): Record<string, string> {
  const entries = childProxyGitConfigEntries(proxyUrl, opts);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * Parent-side extraEnv keys that must never reach the child process. The token
 * would authenticate the forge API; the URL is only needed to start the proxy;
 * `GIT_CONFIG_*` from `workerOpenCodeChildEnv` carries the old
 * credential-helper shell function referencing `$GIT_AUTH_TOKEN` and is
 * replaced by the proxy `insteadOf` entries.
 */
export function isChildStrippedKey(key: string): boolean {
  if (key === "GIT_AUTH_TOKEN" || key === "GIT_AUTH_URL") return true;
  if (key === "GIT_CONFIG_COUNT") return true;
  if (/^GIT_CONFIG_KEY_\d+$/.test(key)) return true;
  if (/^GIT_CONFIG_VALUE_\d+$/.test(key)) return true;
  return false;
}

export interface ChildProxyRequest {
  forgeUrl: string;
  forgeHost: string;
  username: string;
  token: string;
  owner?: string;
  repo?: string;
}

/** When the spawn carries a write-capable git token, the parent must proxy it. */
export function childProxyRequestFrom(
  extraEnv?: Record<string, string>,
  trace?: { owner?: string; repo?: string }
): ChildProxyRequest | undefined {
  const token = extraEnv?.GIT_AUTH_TOKEN?.trim();
  const host = extraEnv?.GIT_AUTH_HOST?.trim();
  if (!token || !host) return undefined;
  const username = extraEnv?.GIT_AUTH_USERNAME?.trim() || "git";
  const forgeUrl = extraEnv?.GIT_AUTH_URL?.trim() || `https://${host}/`;
  try {
    void new URL(forgeUrl);
  } catch {
    return undefined;
  }
  return {
    forgeUrl,
    forgeHost: host,
    username,
    token,
    owner: trace?.owner?.trim() || undefined,
    repo: trace?.repo?.trim()?.replace(/\.git$/, "") || undefined,
  };
}
