import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Kubernetes cluster CA for `control` HTTPS calls.
 *
 * The API server (`https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT`)
 * serves a certificate signed by the cluster CA at
 * `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`. Plain `fetch`
 * without that CA fails with `self signed certificate in certificate chain`,
 * which is what the first real `control` deploy hit on every Secret publish
 * and every dispatch Job call.
 *
 * The CA is read once per path and successful reads are cached: unlike the
 * projected service-account token it does not rotate on a short budget, and
 * every K8s call in the process should share the same trust bundle. Misses
 * (absent/unreadable/empty file) are not cached, so a late service-account
 * mount is retried on the next call instead of pinning plain `fetch`.
 */

export type K8sFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `ca.crt` next to the service-account token file. */
export function defaultK8sCaFile(tokenFile: string): string {
  return join(dirname(tokenFile), "ca.crt");
}

const caCache = new Map<string, Promise<string | undefined>>();

export function resetK8sCaCacheForTests(): void {
  caCache.clear();
}

/** Read the cluster CA once per path. Missing/unreadable file means no custom CA. */
export async function readK8sCa(caFile: string | undefined): Promise<string | undefined> {
  if (!caFile) return undefined;
  const cached = caCache.get(caFile);
  if (cached) return cached;
  try {
    const text = (await readFile(caFile, "utf8")).trim();
    const ca = text || undefined;
    if (ca) caCache.set(caFile, Promise.resolve(ca));
    return ca;
  } catch {
    return undefined;
  }
}

export type K8sFetchInit = RequestInit & { tls?: { ca?: string | Buffer | Array<string | Buffer> } };

/**
 * Wrap a fetch implementation so every call trusts the cluster CA via Bun's
 * `fetch(url, { tls: { ca } })`. Without a CA the implementation is returned
 * unchanged. Never sets `rejectUnauthorized: false` / `NODE_TLS_REJECT_UNAUTHORIZED`.
 */
export function withK8sCa(fetchImpl: K8sFetchLike, ca: string | undefined): K8sFetchLike {
  if (!ca) return fetchImpl;
  return (input, init) => fetchImpl(input, { ...(init ?? {}), tls: { ca } } as unknown as RequestInit);
}
