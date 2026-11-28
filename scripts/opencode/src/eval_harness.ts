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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePiStartupEnv } from "./pi_env.ts";
import { selectPiGoRoute } from "./pi_opencode_go.ts";
import { resolvePiDataScope } from "./pi_runtime.ts";
import {
  loadRunnersCatalog,
  type NamedRunner,
  orderedRunners,
  parseRunnersFile,
  refuseAntigravityUnlessGithub,
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
    return tryLoopbackGoRoute(deployment.allowlist[0]!, deployment.catalog, deployment.allowlist, err);
  }
}

/**
 * Hermetic loopback allowance shared by both route resolvers: a catalog
 * endpoint on 127.0.0.1/localhost/::1 with the exact Go provider/model/SKU
 * still selects the Go route, with allowedFetchHosts just that host.
 * Production keeps the known-endpoint deny; only the eval allows loopback.
 */
function tryLoopbackGoRoute(
  name: string,
  catalog: Parameters<typeof selectPiGoRoute>[1],
  allowlist: readonly string[],
  err: unknown
): ReturnType<typeof selectPiGoRoute> {
  const message = err instanceof Error ? err.message : String(err);
  if (!/unknown endpoint/i.test(message)) throw err;
  const def = (catalog as unknown as Record<string, Record<string, unknown>>)[name] as
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
  if (!allowlist.includes(name)) throw err;
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

/** Named Go route for scope `public`, with the same loopback allowance as the first-route helper. */
export function resolveEvalPiRouteNamed(
  name: string,
  deployment: { catalog: Parameters<typeof selectPiGoRoute>[1]; allowlist: readonly string[] }
): ReturnType<typeof selectPiGoRoute> {
  assertEvalPublicScope();
  try {
    return selectPiGoRoute(name, deployment.catalog, deployment.allowlist, { scope: "public" });
  } catch (err) {
    return tryLoopbackGoRoute(name, deployment.catalog, deployment.allowlist, err);
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

// --- Hard spend budget (shared by `worker_eval` and `review_eval`) ---

/**
 * List prices for `muse-spark-1.3-contributor`, USD per 1M tokens.
 * Source: https://opencode.ai/data/meta/muse-spark-1-3-contributor (read
 * 2026-11-28): $0.10 / 1M input, $0.20 / 1M output. No cached-input rate is
 * published there for this estimate, so cached input counts at the full
 * input price. Output includes reasoning, so reasoning counts at the output
 * price.
 */
export const EVAL_SPEND_INPUT_USD_PER_M = 0.1;
export const EVAL_SPEND_OUTPUT_USD_PER_M = 0.2;

/** Where one eval record's `spendUsd` came from. */
export type EvalSpendSource = "allowance" | "list-estimate" | "unknown";

/** `inconclusiveReason` for runs never started because the budget was reached. */
export const EVAL_BUDGET_EXHAUSTED_REASON = "budget-exhausted" as const;
/** `inconclusiveReason` when no run can be priced, so the budget is unenforceable. */
export const EVAL_BUDGET_UNMEASURABLE_REASON = "budget-unmeasurable" as const;

function cleanSpendNumber(value: unknown): number | undefined {
  if (typeof value === "bigint") value = Number(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    value = Number(trimmed);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function cleanTokenCell(value: unknown): number | undefined {
  const num = cleanSpendNumber(value);
  if (num === undefined) return undefined;
  return Math.floor(num);
}

function allowanceFromObject(obj: Record<string, unknown>): number | undefined {
  const direct = cleanSpendNumber(obj.allowanceUsd ?? obj.allowance);
  if (direct !== undefined) return direct;
  const opencode = obj.opencode;
  if (opencode && typeof opencode === "object") {
    const nested = cleanSpendNumber((opencode as Record<string, unknown>).allowance);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Provider's own figure: `opencode.allowance` (Go only: dollars of the
 * monthly limit) per https://opencode.ai/docs/console/api/inference (read
 * 2026-11-28). Also accepts a top-level `allowance`/`allowanceUsd` so the
 * scripted `piInvoke` seam and future transports can carry it without
 * mimicking the full response envelope.
 */
export function evalAllowanceUsdFrom(usage: unknown, allowanceUsd?: unknown): number | undefined {
  const explicit = cleanSpendNumber(allowanceUsd);
  if (explicit !== undefined) return explicit;
  if (!usage || typeof usage !== "object") return undefined;
  if (usage instanceof Map) {
    for (const value of usage.values()) {
      if (value && typeof value === "object") {
        const found = allowanceFromObject(value as Record<string, unknown>);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const top = allowanceFromObject(record);
  if (top !== undefined) return top;
  for (const key of ["usage", "tokens", "opencodeUsage"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !(nested instanceof Map)) {
      const found = allowanceFromObject(nested as Record<string, unknown>);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function firstTokenCell(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const found = cleanTokenCell(obj[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function tokenCellsFromObject(obj: Record<string, unknown>): {
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
} {
  const out: { input?: number; cached?: number; output?: number; reasoning?: number } = {};
  const input = firstTokenCell(obj, ["inputTokens", "input", "prompt_tokens", "input_tokens", "tokens_input"]);
  if (input !== undefined) out.input = input;
  const cached = firstTokenCell(obj, [
    "cachedInputTokens",
    "cached_input",
    "cache_read_input_tokens",
    "cache_read",
    "tokens_cache_read",
  ]);
  if (cached !== undefined) out.cached = cached;
  const output = firstTokenCell(obj, ["outputTokens", "output", "completion_tokens", "output_tokens", "tokens_output"]);
  if (output !== undefined) out.output = output;
  const reasoning = firstTokenCell(obj, ["reasoningTokens", "reasoning", "thinking_tokens", "tokens_reasoning"]);
  if (reasoning !== undefined) out.reasoning = reasoning;
  const nestedKeys = ["opencode", "tokens", "usage"] as const;
  for (const key of nestedKeys) {
    const nested = obj[key];
    if (!nested || typeof nested !== "object" || nested instanceof Map) continue;
    const rec = nested as Record<string, unknown>;
    // `opencode.tokens` uses short names (`input`, `output`, `reasoning`,
    // `cache_read`, ...); the generic lists above already cover them.
    if (out.input === undefined) {
      const v = firstTokenCell(rec, ["input", "inputTokens", "prompt_tokens", "input_tokens"]);
      if (v !== undefined) out.input = v;
    }
    if (out.cached === undefined) {
      const v = firstTokenCell(rec, ["cache_read", "cached_input", "cachedInputTokens", "cache_read_input_tokens"]);
      if (v !== undefined) out.cached = v;
    }
    if (out.output === undefined) {
      const v = firstTokenCell(rec, ["output", "outputTokens", "completion_tokens", "output_tokens"]);
      if (v !== undefined) out.output = v;
    }
    if (out.reasoning === undefined) {
      const v = firstTokenCell(rec, ["reasoning", "reasoningTokens", "thinking_tokens"]);
      if (v !== undefined) out.reasoning = v;
    }
  }
  return out;
}

/**
 * Conservative token estimate in USD: `(input + cached) / 1M * input price +
 * (output + reasoning) / 1M * output price`. Cached input counts at the full
 * input price; reasoning counts at the output price (output includes
 * reasoning, so this never undercounts when a provider reports both).
 * Returns `undefined` when the usage states no token cell at all (unknown,
 * never zero): a stated zero stays measurable with spend `0`.
 */
export function evalListEstimateUsdFrom(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  let input = 0;
  let cached = 0;
  let output = 0;
  let reasoning = 0;
  let seen = false;
  const add = (cells: { input?: number; cached?: number; output?: number; reasoning?: number }) => {
    if (cells.input !== undefined) {
      seen = true;
      input += cells.input;
    }
    if (cells.cached !== undefined) {
      seen = true;
      cached += cells.cached;
    }
    if (cells.output !== undefined) {
      seen = true;
      output += cells.output;
    }
    if (cells.reasoning !== undefined) {
      seen = true;
      reasoning += cells.reasoning;
    }
  };
  if (usage instanceof Map) {
    for (const value of usage.values()) {
      if (!value || typeof value !== "object") continue;
      add(tokenCellsFromObject(value as Record<string, unknown>));
    }
  } else {
    add(tokenCellsFromObject(usage as Record<string, unknown>));
  }
  if (!seen) return undefined;
  return (
    ((input + cached) / 1_000_000) * EVAL_SPEND_INPUT_USD_PER_M +
    ((output + reasoning) / 1_000_000) * EVAL_SPEND_OUTPUT_USD_PER_M
  );
}

/**
 * Spend for one finished run, in priority order: the provider's own
 * `opencode.allowance` figure, else the conservative list-price estimate,
 * else unmeasurable (`spendUsd: null`). An explicit `allowanceUsd` (for
 * example from the scripted `piInvoke` seam) wins over anything in `usage`.
 */
export function evalSpendForRun(input: { usage?: unknown; allowanceUsd?: unknown }): {
  spendUsd: number | null;
  spendSource: EvalSpendSource;
} {
  const allowance = evalAllowanceUsdFrom(input.usage, input.allowanceUsd);
  if (allowance !== undefined) return { spendUsd: allowance, spendSource: "allowance" };
  const estimate = evalListEstimateUsdFrom(input.usage);
  if (estimate !== undefined) return { spendUsd: estimate, spendSource: "list-estimate" };
  return { spendUsd: null, spendSource: "unknown" };
}

/** Parse `--budget-usd <n>`: finite and > 0, else throw (never silently drop a cap). */
export function parseEvalBudgetUsd(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!text) throw new Error("Missing --budget-usd <n>");
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --budget-usd ${String(raw)} (want a number > 0)`);
  return value;
}

/** Spend carried in from a previous eval via `--spend-file`. Missing/unreadable is `0`, never a throw. */
export async function readEvalSpendFile(path: string | undefined | null): Promise<number> {
  if (!path || !path.trim()) return 0;
  try {
    const text = (await readFile(path.trim(), "utf8")).trim();
    if (!text) return 0;
    const value = Number(text.split(/\s+/)[0]);
    if (!Number.isFinite(value) || value < 0) return 0;
    return value;
  } catch {
    return 0;
  }
}

/** Persist the running total so the next eval in the night shares the budget. */
export async function writeEvalSpendFile(path: string | undefined | null, totalUsd: number): Promise<void> {
  if (!path || !path.trim()) return;
  const target = path.trim();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${totalUsd}\n`, "utf8");
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
