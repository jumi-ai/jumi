/**
 * Deployment-owned Pi profile catalog env (jumi#981).
 *
 * Pure startup validation: no Pi SDK imports, so a legacy process never
 * imports or initializes Pi. Both loaders (`config.ts`, `worker_config.ts`)
 * call `validatePiStartupEnv` when `JUMI_HARNESS_MODE=pi`; legacy mode never
 * calls it and never reads the file.
 */

import { readFileSync } from "node:fs";

/** Deployment-owned Pi profile catalog file. Unset in legacy mode (never read). */
export const PI_PROFILES_FILE_ENV = "JUMI_PI_PROFILES_FILE" as const;

/** Deployment-owned Pi route allowlist (CSV of profile names). */
export const PI_ALLOWED_ROUTES_ENV = "JUMI_PI_ALLOWED_ROUTES" as const;

/**
 * The only wired transport serves this exact shape. Source of truth for the
 * values is `src/pi_opencode_go.ts` (`PI_GO_PROVIDER_ID`, `PI_GO_MODEL_ID`,
 * `PI_GO_SKU`); they are repeated here so legacy startup validation stays
 * free of Pi imports.
 */
const WIRED_GO_PROVIDER = "opencode-go";
const WIRED_GO_MODEL = "muse-spark-1.3-contributor";
const WIRED_GO_SKU = "contributor";

export interface PiStartupProfile {
  provider: string;
  model: string;
  endpoint: string;
  fundingPool: string;
  payer: string;
  credentialRef: string;
  scopes: string[];
  sku?: string;
}

export type PiStartupCatalog = Record<string, PiStartupProfile>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse and shape-check one catalog file. Throws naming `source` (the env key
 * plus the file path) on unreadable, non-JSON, or misshapen content. Never
 * throws the file contents.
 */
export function parsePiProfilesText(text: string, source: string): PiStartupCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${source} is not valid JSON: ${reason.slice(0, 160)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must hold a JSON object of named profiles`);
  }
  const catalog: PiStartupCatalog = {};
  for (const [name, def] of Object.entries(parsed as Record<string, unknown>)) {
    const record = def as Record<string, unknown>;
    const scopes = Array.isArray(record?.scopes) ? record.scopes : [];
    const sku = record?.sku;
    if (
      !record ||
      typeof record !== "object" ||
      !isNonEmptyString(record.provider) ||
      !isNonEmptyString(record.model) ||
      !isNonEmptyString(record.endpoint) ||
      !isNonEmptyString(record.fundingPool) ||
      !isNonEmptyString(record.payer) ||
      !isNonEmptyString(record.credentialRef) ||
      scopes.length === 0 ||
      !scopes.every(isNonEmptyString)
    ) {
      throw new Error(
        `${source} profile ${JSON.stringify(name)} must name provider, model, endpoint, ` +
          `fundingPool, payer, credentialRef, and a non-empty scopes list`
      );
    }
    catalog[name] = {
      provider: (record.provider as string).trim(),
      model: (record.model as string).trim(),
      endpoint: (record.endpoint as string).trim(),
      fundingPool: (record.fundingPool as string).trim(),
      payer: (record.payer as string).trim(),
      credentialRef: (record.credentialRef as string).trim(),
      scopes: (scopes as string[]).map((scope) => scope.trim()),
      ...(isNonEmptyString(sku) ? { sku: sku.trim() } : {}),
    };
  }
  return catalog;
}

/** Parse the deployment allowlist (CSV). Unset or blank means no Pi route. */
export function parsePiAllowedRoutesEnv(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const name = part.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface PiStartupDeployment {
  filePath: string;
  catalog: PiStartupCatalog;
  allowlist: string[];
}

/**
 * Fail process start in pi mode naming the cause: unset profiles file,
 * unreadable or misshapen catalog, empty allowlist, unknown profile, or an
 * allowlisted route whose transport is not wired yet (only the OpenCode Go
 * route is wired; ChatGPT, Claude, and SuperGrok fail here, never skipped).
 */
export function validatePiStartupEnv(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8")
): PiStartupDeployment {
  const filePath = env[PI_PROFILES_FILE_ENV]?.trim();
  if (!filePath) {
    throw new Error(
      `${PI_PROFILES_FILE_ENV} is not set: JUMI_HARNESS_MODE=pi needs a deployment-owned ` +
        `Pi profile catalog file naming that key`
    );
  }
  const source = `${PI_PROFILES_FILE_ENV} (${filePath})`;
  let text: string;
  try {
    text = readFile(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${source} is unreadable: ${reason.slice(0, 160)}`);
  }
  const catalog = parsePiProfilesText(text, source);
  const allowlist = parsePiAllowedRoutesEnv(env[PI_ALLOWED_ROUTES_ENV]);
  if (allowlist.length === 0) {
    throw new Error(`${PI_ALLOWED_ROUTES_ENV} is empty: JUMI_HARNESS_MODE=pi needs at least one allowlisted Pi route`);
  }
  for (const name of allowlist) {
    const profile = catalog[name];
    if (!profile) {
      throw new Error(`${source} has no profile ${JSON.stringify(name)} named by ${PI_ALLOWED_ROUTES_ENV}`);
    }
    const wired =
      profile.provider === WIRED_GO_PROVIDER &&
      profile.model === WIRED_GO_MODEL &&
      (profile.sku ?? "").toLowerCase() === WIRED_GO_SKU;
    if (!wired) {
      throw new Error(
        `route not wired: ${JSON.stringify(name)} (provider ${JSON.stringify(profile.provider)}, ` +
          `model ${JSON.stringify(profile.model)}): only the OpenCode Go route is wired in pi mode`
      );
    }
  }
  return { filePath, catalog, allowlist };
}
