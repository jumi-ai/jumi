import { type SkipLatchKey, type SkipLatchStore, skipLatchesFor } from "./skip_latches.ts";

export interface CiRefreshRecord {
  baseSha: string;
  checkName: string;
}

export function parseCiRefreshes(value: unknown): CiRefreshRecord[] {
  if (!Array.isArray(value)) return [];
  const out: CiRefreshRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as { baseSha?: unknown; checkName?: unknown };
    if (typeof rec.baseSha === "string" && rec.baseSha && typeof rec.checkName === "string" && rec.checkName) {
      out.push({ baseSha: rec.baseSha.toLowerCase(), checkName: rec.checkName });
    }
  }
  return out;
}

function ciRefreshKey(baseSha: string, checkName: string): string {
  return `${baseSha.toLowerCase()}:${checkName}`;
}

export function isCiRefreshSpent(
  state: { ciRefreshes?: CiRefreshRecord[] },
  baseSha: string,
  checkName: string
): boolean {
  return (state.ciRefreshes ?? []).some(
    (entry) => entry.baseSha === baseSha.toLowerCase() && entry.checkName === checkName
  );
}

export function splitCiRefreshBudget(
  state: { ciRefreshes?: CiRefreshRecord[] },
  baseSha: string,
  checks: Array<{ name: string }>
): { toRefresh: Array<{ name: string }>; exhausted: Array<{ name: string }> } {
  const toRefresh: Array<{ name: string }> = [];
  const exhausted: Array<{ name: string }> = [];
  for (const check of checks) {
    if (isCiRefreshSpent(state, baseSha, check.name)) exhausted.push(check);
    else toRefresh.push(check);
  }
  return { toRefresh, exhausted };
}

export async function recordCiRefreshes(opts: {
  home: string;
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber: number;
  baseSha: string;
  checkNames: string[];
  now?: () => Date;
  skipLatches?: SkipLatchStore;
}): Promise<void> {
  const store = skipLatchesFor(opts);
  const key: SkipLatchKey = { owner: opts.owner, repo: opts.repo, issueNumber: opts.issueNumber };
  const current = (await store.get(key)).ci as
    | { prNumber?: unknown; handled?: unknown; flakeReruns?: unknown; ciRefreshes?: unknown }
    | undefined;
  const raw = (current ?? {}) as Record<string, unknown>;
  const seen = new Set(parseCiRefreshes(raw.ciRefreshes).map((entry) => ciRefreshKey(entry.baseSha, entry.checkName)));
  const next = [...parseCiRefreshes(raw.ciRefreshes)];
  for (const checkName of opts.checkNames) {
    const k = ciRefreshKey(opts.baseSha, checkName);
    if (seen.has(k)) continue;
    seen.add(k);
    next.push({ baseSha: opts.baseSha.toLowerCase(), checkName });
  }
  await store.put(key, {
    ci: {
      ...raw,
      prNumber: opts.prNumber,
      ciRefreshes: next,
      updatedAt: (opts.now?.() ?? new Date()).toISOString(),
    },
  });
}
