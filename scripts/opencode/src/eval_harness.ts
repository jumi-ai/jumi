/**
 * Shared helpers for the opt-in evals (`src/worker_eval.ts`, `src/review_eval.ts`)
 * behind jumi#982: harness selection, hermetic roots, comparable records, and
 * the Pi deployment gate.
 *
 * - `--harness legacy|pi` also accepts `legacy,pi` to run both harnesses over
 *   identical inputs in one invocation. Omitted means `legacy`.
 * - Grading never changes between harnesses; auth/quota/timeout/harness crash
 *   stays `inconclusive`.
 * - Every record carries `harness`; Pi records also carry the attempt stamp
 *   fields (route, payer, pool, outcome, usage). Unknown usage stays `null`,
 *   never `0`.
 * - The fake forge reports the repository as public so the Contributor scope
 *   rule admits the Go route.
 * - A Pi run with a missing profile file, empty allowlist, or unwired route
 *   fails before the first fixture starts and writes no records.
 */

import { mkdir } from "node:fs/promises";
import { validatePiStartupEnv } from "./pi_env.ts";
import { selectPiGoRoute } from "./pi_opencode_go.ts";
import { resolvePiDataScope } from "./pi_runtime.ts";
import {
  loadRunnersCatalog,
  type NamedRunner,
  orderedRunners,
  parseRunnersFile,
  refuseAntigravityUnlessGithub,
  synthesizeRunners,
} from "./runners.ts";

export type EvalHarness = "legacy" | "pi";

export function parseEvalHarness(raw: unknown): EvalHarness[] {
  if (raw === undefined || raw === null) return ["legacy"];
  const text = String(raw).trim();
  if (!text) return ["legacy"];
  const parts = text
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const out: EvalHarness[] = [];
  for (const part of parts) {
    if (part !== "legacy" && part !== "pi") {
      throw new Error(`Invalid --harness ${String(raw)} (want legacy|pi or legacy,pi)`);
    }
    if (!out.includes(part)) out.push(part);
  }
  if (out.length === 0) return ["legacy"];
  return out;
}

/** Create every eval root before `mkdtemp` so an empty volume still works. */
export async function ensureEvalRoots(dirs: Array<string | undefined | null>): Promise<void> {
  for (const dir of dirs) {
    if (!dir) continue;
    const trimmed = dir.trim();
    if (!trimmed) continue;
    await mkdir(trimmed, { recursive: true });
  }
}

/** Image digest for comparable records, when the deploy provides one. */
export function evalImageDigest(env: Record<string, string | undefined> = process.env): string | null {
  const digest = env.JUMI_IMAGE_DIGEST?.trim() ?? "";
  return digest ? digest : null;
}

/**
 * Usage for comparable records. Unknown stays `null`, never `0`. A stated
 * zero stays zero; a missing object stays `null`.
 */
export function evalUsageOrNull(usage: unknown): unknown {
  if (usage === undefined || usage === null) return null;
  if (typeof usage !== "object") return usage;
  return usage;
}

/** Fake-forge visibility the evals report: public, so Contributor scope admits. */
export function evalPublicRepoVisibility(): { private: false; visibility: "public" } {
  return { private: false, visibility: "public" };
}

/** Assert the fake-forge repo resolves to public scope (fail closed otherwise). */
function assertEvalPublicScope(): void {
  const scope = resolvePiDataScope(evalPublicRepoVisibility() as never);
  if (scope !== "public") {
    throw new Error("eval harness refuses non-public scope for the synthetic public fixture");
  }
}

/**
 * Validate the Pi deployment before the first fixture starts. Missing file,
 * empty allowlist, or unwired route throws naming the cause; the caller must
 * run this before creating `outDir` records so a misconfigured run writes no
 * records.
 */
export function loadEvalPiDeployment(
  env: Record<string, string | undefined> = process.env,
  readFile?: (path: string) => string
): { filePath: string; catalog: Parameters<typeof selectPiGoRoute>[1]; allowlist: string[] } {
  const validated = readFile ? validatePiStartupEnv(env, readFile) : validatePiStartupEnv(env);
  return validated as unknown as {
    filePath: string;
    catalog: Parameters<typeof selectPiGoRoute>[1];
    allowlist: string[];
  };
}

/** First allowlisted Go route for scope `public`. Throws on unwired/denied. */
export function resolveEvalPiRoute(deployment: {
  catalog: Parameters<typeof selectPiGoRoute>[1];
  allowlist: readonly string[];
}): ReturnType<typeof selectPiGoRoute> {
  if (deployment.allowlist.length === 0) {
    throw new Error("JUMI_PI_ALLOWED_ROUTES is empty: refusing the Pi eval run before any fixture");
  }
  assertEvalPublicScope();
  try {
    return selectPiGoRoute(deployment.allowlist[0]!, deployment.catalog, deployment.allowlist, { scope: "public" });
  } catch (err) {
    // Hermetic loopback for the operator gate: a catalog endpoint on
    // 127.0.0.1/localhost/::1 with the exact Go provider/model/SKU still
    // selects the Go route, with allowedFetchHosts just that host. Production
    // keeps the known-endpoint deny; only the eval allows loopback.
    const message = err instanceof Error ? err.message : String(err);
    if (!/unknown endpoint/i.test(message)) throw err;
    const name = deployment.allowlist[0]!;
    const def = (deployment.catalog as unknown as Record<string, Record<string, unknown>>)[name] as
      | Record<string, unknown>
      | undefined;
    const endpoint = typeof def?.endpoint === "string" ? (def.endpoint as string).trim() : "";
    let host = "";
    try {
      host = new URL(endpoint).hostname.toLowerCase();
    } catch {
      throw err;
    }
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!loopback) throw err;
    const provider = typeof def?.provider === "string" ? (def.provider as string).trim() : "";
    const model = typeof def?.model === "string" ? (def.model as string).trim() : "";
    const sku = typeof def?.sku === "string" ? (def.sku as string).trim().toLowerCase() : "";
    if (provider !== "opencode-go" || model !== "muse-spark-1.3-contributor" || sku !== "contributor") {
      throw err;
    }
    const scopes = Array.isArray(def?.scopes) ? (def.scopes as unknown[]) : [];
    if (!scopes.includes("public")) throw err;
    return {
      name,
      provider,
      model,
      endpoint,
      fundingPool: typeof def?.fundingPool === "string" ? (def.fundingPool as string).trim() : "",
      payer: typeof def?.payer === "string" ? (def.payer as string).trim() : "",
      credentialRef: typeof def?.credentialRef === "string" ? (def.credentialRef as string).trim() : "",
      scopes: ["public"] as never,
      sku: "contributor",
      family: `${provider.toLowerCase()}|${model}`,
    } as ReturnType<typeof selectPiGoRoute>;
  }
}

/** Named Go route for scope `public`, with the same loopback allowance as the first-route helper. */
export function resolveEvalPiRouteNamed(
  name: string,
  deployment: { catalog: Parameters<typeof selectPiGoRoute>[1]; allowlist: readonly string[] }
): ReturnType<typeof selectPiGoRoute> {
  assertEvalPublicScope();
  try {
    return selectPiGoRoute(name, deployment.catalog, deployment.allowlist, { scope: "public" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/unknown endpoint/i.test(message)) throw err;
    const def = (deployment.catalog as unknown as Record<string, Record<string, unknown>>)[name] as
      | Record<string, unknown>
      | undefined;
    const endpoint = typeof def?.endpoint === "string" ? (def.endpoint as string).trim() : "";
    let host = "";
    try {
      host = new URL(endpoint).hostname.toLowerCase();
    } catch {
      throw err;
    }
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!loopback) throw err;
    const provider = typeof def?.provider === "string" ? (def.provider as string).trim() : "";
    const model = typeof def?.model === "string" ? (def.model as string).trim() : "";
    const sku = typeof def?.sku === "string" ? (def.sku as string).trim().toLowerCase() : "";
    if (provider !== "opencode-go" || model !== "muse-spark-1.3-contributor" || sku !== "contributor") {
      throw err;
    }
    const scopes = Array.isArray(def?.scopes) ? (def.scopes as unknown[]) : [];
    if (!scopes.includes("public")) throw err;
    if (!deployment.allowlist.includes(name)) throw err;
    return {
      name,
      provider,
      model,
      endpoint,
      fundingPool: typeof def?.fundingPool === "string" ? (def.fundingPool as string).trim() : "",
      payer: typeof def?.payer === "string" ? (def.payer as string).trim() : "",
      credentialRef: typeof def?.credentialRef === "string" ? (def.credentialRef as string).trim() : "",
      scopes: ["public"] as never,
      sku: "contributor",
      family: `${provider.toLowerCase()}|${model}`,
    } as ReturnType<typeof selectPiGoRoute>;
  }
}

/** Hermetic fetch hosts for a Pi eval: just the selected endpoint. */
export function piAllowedHostsForRoute(route: { endpoint: string }): string[] {
  try {
    return [new URL(route.endpoint).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

/**
 * Legacy baseline for a comparison: exactly one explicitly selected runner
 * loaded from a minimal catalog that holds only that runner, with no fallback
 * to another runner. A dormant `agy` entry elsewhere in the source catalog
 * never fails the run because the refuse check runs on the minimal catalog.
 *
 * When `runnerNames` is omitted the full configured chain is returned (today's
 * records plus `harness`), so omitting `--harness` keeps today's shape.
 */
export function loadEvalLegacyRunners(
  runnerNames: string[] | undefined,
  env: Record<string, string | undefined> = process.env,
  fromEnv?: { model: string; variant?: string; fallbackModel?: string; fallbackVariant?: string }
): NamedRunner[] {
  const forge = (env.FORGE?.trim() === "github" ? "github" : "gitea") as "github" | "gitea";
  const resolvedFromEnv =
    fromEnv ??
    ({
      model: env.OPENCODE_MODEL?.trim() ? env.OPENCODE_MODEL : "openai/gpt-5.5",
      ...(env.OPENCODE_VARIANT ? { variant: env.OPENCODE_VARIANT } : {}),
      ...(env.OPENCODE_FALLBACK_MODEL ? { fallbackModel: env.OPENCODE_FALLBACK_MODEL } : {}),
      ...(env.OPENCODE_FALLBACK_VARIANT ? { fallbackVariant: env.OPENCODE_FALLBACK_VARIANT } : {}),
    } as { model: string; variant?: string; fallbackModel?: string; fallbackVariant?: string });
  const path = env.JUMI_RUNNERS_FILE?.trim() ? env.JUMI_RUNNERS_FILE.trim() : undefined;
  if (path) {
    const full = parseRunnersFile(path);
    if (!runnerNames || runnerNames.length === 0) {
      refuseAntigravityUnlessGithub(full, forge);
      return orderedRunners(full);
    }
    const byName = new Map(orderedRunners(full).map((runner) => [runner.name, runner]));
    const selected = runnerNames.map((name) => {
      const found = byName.get(name);
      if (!found) {
        throw new Error(
          `Unknown runner ${name} (chain: ${orderedRunners(full)
            .map((r) => r.name)
            .join(", ")})`
        );
      }
      return found;
    });
    const runners: Record<string, NamedRunner> = {};
    for (const runner of selected) {
      const { name, ...spec } = runner;
      runners[name] = spec as NamedRunner;
    }
    const minimal = { runners, chain: selected.map((runner) => runner.name) };
    refuseAntigravityUnlessGithub(minimal as never, forge);
    return selected;
  }
  const full = loadRunnersCatalog(undefined, resolvedFromEnv, forge);
  if (!runnerNames || runnerNames.length === 0) return orderedRunners(full);
  const byName = new Map(orderedRunners(full).map((runner) => [runner.name, runner]));
  const selected = runnerNames.map((name) => {
    const found = byName.get(name);
    if (!found) {
      throw new Error(
        `Unknown runner ${name} (chain: ${orderedRunners(full)
          .map((r) => r.name)
          .join(", ")})`
      );
    }
    return found;
  });
  const runners: Record<string, NamedRunner> = {};
  for (const runner of selected) {
    const { name, ...spec } = runner;
    runners[name] = spec as NamedRunner;
  }
  refuseAntigravityUnlessGithub({ runners, chain: selected.map((r) => r.name) } as never, forge);
  return selected;
}

void synthesizeRunners;
