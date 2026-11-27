/**
 * Pi production runtime for the OpenCode Go route (jumi#981).
 *
 * Glues the deployment-owned Pi configuration (profile catalog file plus
 * route allowlist) to the existing Pi building blocks: the route chain is
 * the `JUMI_PI_ALLOWED_ROUTES` order capped at `PI_HOP_MAX_ROUTES` and driven
 * by `runPiHop`, a repository may narrow it (never add to it), data scope
 * comes from the forge's repository visibility read at job time, and the Go
 * key comes from the existing `resolvePiGoApiKey` (no new secret).
 *
 * Only this module (plus `src/pi_jobs.ts`) imports the Pi SDK on the
 * production path. Legacy mode never imports this module: the loaders fail
 * pi startup through the import-free `src/pi_env.ts` instead.
 */

import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { validatePiStartupEnv } from "./pi_env.ts";
import { PI_HOP_MAX_ROUTES } from "./pi_hop.ts";
import {
  createPiGoSessionId,
  PI_GO_BASE_URL,
  PI_GO_MODEL_ID,
  PI_GO_PROVIDER_ID,
  piGoMissingKeyMessage,
  resolvePiGoApiKey,
  withPiGoTransport,
} from "./pi_opencode_go.ts";
import { narrowPiRoutesWithRepo, type PiDataScope, type PiProfileCatalog } from "./pi_profiles.ts";
import type { Repo } from "./ports.ts";

export interface PiDeployment {
  mode: "legacy" | "pi";
  catalog: PiProfileCatalog;
  allowlist: string[];
}

/**
 * Resolve the deployment-owned Pi configuration. Legacy mode returns an
 * empty catalog without reading any file or touching credentials. Pi mode
 * reuses the startup validation (unset file, empty allowlist, or unwired
 * route fails naming the cause) so the tick fails the same way start does.
 */
export function loadPiDeployment(
  env: Record<string, string | undefined> = process.env,
  readFile?: (path: string) => string
): PiDeployment {
  if ((env.JUMI_HARNESS_MODE ?? "").trim() === "pi") {
    const validated = readFile ? validatePiStartupEnv(env, readFile) : validatePiStartupEnv(env);
    return {
      mode: "pi",
      catalog: validated.catalog as unknown as PiProfileCatalog,
      allowlist: validated.allowlist,
    };
  }
  return { mode: "legacy", catalog: {}, allowlist: [] };
}

/**
 * The route chain for one job: the deployment allowlist order, optionally
 * narrowed by the repository (never widened), capped at `PI_HOP_MAX_ROUTES`.
 */
export function piChainForJob(deployment: Pick<PiDeployment, "allowlist">, repoAllowed?: readonly string[]): string[] {
  return narrowPiRoutesWithRepo(deployment.allowlist, repoAllowed).slice(0, PI_HOP_MAX_ROUTES);
}

/**
 * Data scope from the forge's repository visibility, read at job time on
 * both forges. `private: true`, any `visibility` other than `public` (for
 * example GitHub `internal`), or a missing/unreadable record means
 * `private`. Private work never reaches a Contributor route.
 */
export function resolvePiDataScope(repo: Pick<Repo, "private" | "visibility"> | null | undefined): PiDataScope {
  if (!repo || typeof repo !== "object") return "private";
  if (repo.private === true) return "private";
  const visibility = typeof repo.visibility === "string" ? repo.visibility.trim().toLowerCase() : "";
  if (visibility && visibility !== "public") return "private";
  if (repo.private === false && !visibility) return "public";
  if (repo.private === false && visibility === "public") return "public";
  // Fail closed: no usable visibility signal means private.
  return "private";
}

/**
 * Read the repository visibility and map it to a Pi data scope. A failed
 * read means `private` (fail closed); the caller records the failure in the
 * refusal reason but never sends a request to the provider.
 */
export async function piScopeForRepo(
  getRepo: (owner: string, repo: string) => Promise<Pick<Repo, "private" | "visibility">>,
  owner: string,
  repo: string
): Promise<{ scope: PiDataScope; visibilityFailed: boolean }> {
  try {
    const info = await getRepo(owner, repo);
    return { scope: resolvePiDataScope(info), visibilityFailed: false };
  } catch {
    return { scope: "private", visibilityFailed: true };
  }
}

export interface PiGoSessionDeps {
  modelRuntime: unknown;
  model: unknown;
  sessionId: string;
  apiKey: string;
  allowedFetchHosts: readonly string[];
}

/**
 * Build one Go inference session: fresh static key (`OPENCODE_API_KEY_FILE`
 * re-read wins over `OPENCODE_API_KEY`), opaque conversation id, and a
 * `ModelRuntime` with the `opencode-go` provider wrapped so every request
 * carries the Go routing header plus the actual-agent identity. Missing key
 * fails closed as provider auth death before any fetch; the key never
 * appears in the error text.
 */
export async function createPiGoSessionDeps(opts: {
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  sessionId?: string;
}): Promise<PiGoSessionDeps> {
  const env = opts.env ?? process.env;
  const resolved = resolvePiGoApiKey(env, opts.readFile);
  if (!resolved.key) {
    throw new Error(piGoMissingKeyMessage(resolved.filePath, resolved.fileError));
  }
  const sessionId = opts.sessionId ?? createPiGoSessionId();
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false } as never);
  const provider = withPiGoTransport(opencodeGoProvider());
  (runtime as unknown as { registerNativeProvider: (provider: unknown) => void }).registerNativeProvider(provider);
  const model = (runtime as unknown as { getModel: (provider: string, model: string) => unknown }).getModel(
    PI_GO_PROVIDER_ID,
    PI_GO_MODEL_ID
  );
  if (!model) {
    throw new Error(`refusing the OpenCode Go request: model ${PI_GO_PROVIDER_ID}/${PI_GO_MODEL_ID} is not registered`);
  }
  // The freshly re-read file key wins without mutating the process env: a
  // rotation applies to the next session with no restart, and concurrent jobs
  // never see each other's key.
  await (runtime as unknown as { setRuntimeApiKey: (provider: string, key: string) => Promise<void> }).setRuntimeApiKey(
    PI_GO_PROVIDER_ID,
    resolved.key
  );
  const hosts = new Set<string>();
  for (const base of [PI_GO_BASE_URL]) {
    try {
      hosts.add(new URL(base).hostname.toLowerCase());
    } catch {
      // Base URL is a deployment constant; ignore a parse failure here.
    }
  }
  return { modelRuntime: runtime, model, sessionId, apiKey: resolved.key, allowedFetchHosts: [...hosts] };
}
