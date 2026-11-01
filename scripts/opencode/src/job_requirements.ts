import { readFile } from "node:fs/promises";
import type { IndependentReviewConfig, NamedRunner } from "./runners.ts";
import { isXaiModel } from "./xai_auth.ts";

export interface XaiRefusal {
  refused: boolean;
  reason?: string;
}

function hasStaticOpenCodeKey(env: Record<string, string | undefined> = process.env): boolean {
  const fileKey = env.OPENCODE_API_KEY_FILE?.trim();
  if (fileKey) return true;
  const envKey = env.OPENCODE_API_KEY?.trim();
  if (envKey) return true;
  const xaiKey = env.XAI_API_KEY?.trim();
  if (xaiKey) return true;
  return false;
}

function chainNeedsXaiOAuth(chain: readonly NamedRunner[]): string | undefined {
  const hit = chain.find((runner) => isXaiModel(runner.model));
  return hit ? `runner ${hit.name} uses ${hit.model}` : undefined;
}

function independentReviewNeedsXaiOAuth(policy: IndependentReviewConfig | undefined): string | undefined {
  if (!policy?.enabled) return undefined;
  for (const [family, members] of Object.entries(policy.groups)) {
    const hit = members.find((member) => isXaiModel(member.model));
    if (hit) return `independentReview group ${family} uses ${hit.type}/${hit.model}`;
  }
  return undefined;
}

function isXaiValue(value: unknown): boolean {
  return typeof value === "string" && isXaiModel(value.trim());
}

/**
 * An OpenCode resolved config uses xAI for its helper models when `small_model`
 * (or `smallModel`) names an `xai/*` model, or when a `compaction` model does.
 * The compaction model lives at `agents.compaction.model` (with a legacy
 * `agent.compaction.model` alias and a direct `compaction.model` form); the walk
 * below accepts any `model` key under a `compaction`/`agents`/`agent` ancestor
 * so a future nesting still fails closed instead of starting a job that dies
 * mid-run when OpenCode compacts.
 */
export function openCodeConfigUsesXai(config: unknown): boolean {
  let found = false;
  const walk = (value: unknown, ancestors: string[]): void => {
    if (found) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, ancestors);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if ((lower === "small_model" || lower === "smallmodel") && isXaiValue(entry)) {
        found = true;
        return;
      }
      if (lower === "model" && isXaiValue(entry)) {
        const scope = ancestors.map((part) => part.toLowerCase());
        if (scope.includes("compaction") || scope.includes("agents") || scope.includes("agent")) {
          found = true;
          return;
        }
      }
      if (lower === "compaction" && isXaiValue(entry)) {
        found = true;
        return;
      }
      walk(entry, [...ancestors, key]);
    }
  };
  walk(config, []);
  return found;
}

async function readLocalOpenCodeConfig(configPath: string | undefined): Promise<unknown | undefined> {
  if (!configPath) return undefined;
  try {
    const raw = await readFile(configPath, "utf8");
    if (!raw.trim()) return undefined;
    return JSON.parse(raw) as unknown;
  } catch (err) {
    // A missing file is not xAI usage; an unreadable or invalid file fails
    // closed below so a deployment that pins Grok cannot start blind.
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function fetchRemoteOpenCodeConfig(
  wellKnownUrl: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<unknown | undefined> {
  if (!wellKnownUrl) return undefined;
  const base = wellKnownUrl.replace(/\/+$/, "");
  const url = `${base}/.well-known/opencode`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`well-known config fetch failed (${response.status})`);
  const text = await response.text();
  if (!text.trim()) return undefined;
  return JSON.parse(text) as unknown;
}

export interface RefuseXaiOAuthInput {
  chain: readonly NamedRunner[];
  independentReview?: IndependentReviewConfig;
  /** Local OpenCode config file (`OPENCODE_CONFIG`). Undefined skips the local read. */
  opencodeConfigPath?: string;
  /** Remote well-known origin (`OPENCODE_WELLKNOWN_URL`). Undefined/disabled skips the fetch. */
  wellKnownUrl?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  readFileImpl?: (path: string) => Promise<unknown | undefined>;
  fetchRemoteImpl?: (url: string | undefined) => Promise<unknown | undefined>;
  logger?: (message: string) => void;
}

/**
 * One-shot jobs refuse to start when anything the job could run needs xAI
 * OAuth: a runner in the chain, a runner in the `independentReview` groups, or
 * an OpenCode runner whose resolved config (local file plus remote
 * well-known) uses an `xai/*` model for `small_model` or compaction. The
 * refresh path assumes a single long-lived owner, so a job pod with an empty
 * HOME would start and then fail mid-run when OpenCode compacts. Static keys
 * such as `OPENCODE_API_KEY_FILE` keep working.
 */
export async function refuseXaiOAuth(input: RefuseXaiOAuthInput): Promise<XaiRefusal> {
  if (hasStaticOpenCodeKey(input.env ?? process.env)) return { refused: false };
  const chainHit = chainNeedsXaiOAuth(input.chain);
  if (chainHit) return { refused: true, reason: `xAI OAuth refused: ${chainHit}` };
  const groupHit = independentReviewNeedsXaiOAuth(input.independentReview);
  if (groupHit) return { refused: true, reason: `xAI OAuth refused: ${groupHit}` };
  const hasOpenCodeRunner = input.chain.some((runner) => (runner.type ?? "opencode") === "opencode");
  if (!hasOpenCodeRunner) return { refused: false };
  let local: unknown | undefined;
  try {
    local = input.readFileImpl
      ? await input.readFileImpl(input.opencodeConfigPath ?? "")
      : await readLocalOpenCodeConfig(input.opencodeConfigPath);
  } catch (err) {
    return {
      refused: true,
      reason: `xAI OAuth refused: cannot read OpenCode config ${input.opencodeConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (local !== undefined && openCodeConfigUsesXai(local)) {
    return {
      refused: true,
      reason: `xAI OAuth refused: OpenCode config ${input.opencodeConfigPath} uses xai/* for small_model or compaction`,
    };
  }
  let remote: unknown | undefined;
  try {
    remote = input.fetchRemoteImpl
      ? await input.fetchRemoteImpl(input.wellKnownUrl)
      : await fetchRemoteOpenCodeConfig(input.wellKnownUrl, input.fetchImpl);
  } catch (err) {
    input.logger?.(
      `well-known config fetch failed, continuing without it: ${err instanceof Error ? err.message : String(err)}`
    );
    return { refused: false };
  }
  if (remote !== undefined && openCodeConfigUsesXai(remote)) {
    return {
      refused: true,
      reason: `xAI OAuth refused: well-known config ${input.wellKnownUrl} uses xai/* for small_model or compaction`,
    };
  }
  return { refused: false };
}
