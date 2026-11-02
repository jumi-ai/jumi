import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Published token-only Codex auth.
 *
 * When the deployment names a published file through `CODEX_AUTH_FILE`, every
 * Codex spawn (including resume) points `$HOME/.codex/auth.json` at it with a
 * symlink before spawning. `$HOME/.codex` stays writable for sessions and
 * sqlite; only the file is read-only (the Kubernetes Secret volume). Codex
 * re-reads that path after a 401, so a rotated token reaches a running job.
 *
 * The published document never carries a refresh token: a refresh token in
 * that file is an error, because running on it could attempt a refresh race.
 * Before each spawn the token's `exp` must cover the run budget plus the
 * binary's 5-minute proactive refresh window plus clock margin, or the run
 * fails as auth so the chain hops to the next runner.
 */

export const CODEX_AUTH_FILE_ENV = "CODEX_AUTH_FILE";

/**
 * The binary proactively refreshes when the access token expires within 5
 * minutes (proved by `src/codex_token_probe.ts` against the pinned binary).
 * The parent must not leave a child inside that window.
 */
export const CODEX_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Clock margin between this pod and the token issuer on top of the skew. */
export const CODEX_CLOCK_MARGIN_MS = 60_000;

/**
 * Retained Codex auth location.
 *
 * The Codex runner child (`src/codex.ts`) spawns with `HOME` from its run
 * options and always deletes `CODEX_HOME`/`XDG_CONFIG_HOME` from the child
 * env, so the credential lands at `$HOME/.codex/auth.json`. Device login
 * runs with that same `HOME` and no `CODEX_HOME` override, so this path is
 * the one both sides use.
 */

export function codexAuthPath(home: string): string {
  return join(home, ".codex", "auth.json");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Whether a Codex ChatGPT credential is present.
 *
 * Presence only: this never calls the provider and never refreshes. A ChatGPT
 * device login persists OAuth tokens (`tokens` with `access_token` /
 * `refresh_token` / `id_token`, or those fields flattened at the top level).
 * A bare `OPENAI_API_KEY` entry is usage-based access, not a ChatGPT
 * credential, so it counts as missing here.
 */
export function hasCodexChatGptCredential(auth: unknown): boolean {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  const rec = auth as Record<string, unknown>;
  const tokens = rec.tokens;
  if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
    const t = tokens as Record<string, unknown>;
    if (nonEmptyString(t.access_token) || nonEmptyString(t.refresh_token) || nonEmptyString(t.id_token)) return true;
  }
  if (nonEmptyString(rec.access_token) || nonEmptyString(rec.refresh_token) || nonEmptyString(rec.id_token)) {
    return true;
  }
  return false;
}

export async function isCodexChatGptPresent(
  home: string,
  env: Record<string, string | undefined> = process.env
): Promise<boolean> {
  const published = codexPublishedAuthPath(env);
  if (published) {
    let raw: string;
    try {
      raw = await readFile(published, "utf8");
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false;
      throw err;
    }
    if (!raw.trim()) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return false;
    }
    return hasCodexChatGptCredential(parsed);
  }
  let raw: string;
  try {
    raw = await readFile(codexAuthPath(home), "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false;
    throw err;
  }
  if (!raw.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  return hasCodexChatGptCredential(parsed);
}

/** Optional published file the deployment names via `CODEX_AUTH_FILE`. Unset or empty means local mode. */
export function codexPublishedAuthPath(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env[CODEX_AUTH_FILE_ENV]?.trim();
  return raw ? raw : undefined;
}

/** The run budget a published token must cover: the job timeout plus refresh skew plus clock margin. */
export function codexJobBudgetMs(timeoutMs: number | undefined): number {
  const job = timeoutMs && timeoutMs > 0 ? timeoutMs : 0;
  return job + CODEX_REFRESH_SKEW_MS + CODEX_CLOCK_MARGIN_MS;
}

function publishedJwtExpiryMs(token: string | undefined): number | undefined {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { exp?: unknown };
    if (typeof claims?.exp !== "number" || !Number.isFinite(claims.exp)) return undefined;
    return claims.exp * 1000;
  } catch {
    return undefined;
  }
}

/** `exp` of a published access token in ms. Undefined when it is not a readable JWT. */
export function codexPublishedAccessExpiryMs(token: string | undefined): number | undefined {
  return publishedJwtExpiryMs(token);
}

/**
 * Why a parsed published document cannot run, or undefined when it can.
 * A refresh token in the file is an error (never run where a refresh race is
 * possible); anything unreadable or too short for the budget is malformed or
 * expired. Callers classify every reason as auth so the chain hops.
 */
export function publishedAuthFailureReason(auth: unknown, budgetMs: number, nowMs: number): string | undefined {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return "malformed";
  const rec = auth as Record<string, unknown>;
  const tokens = rec.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return "malformed";
  const t = tokens as Record<string, unknown>;
  if (typeof t.refresh_token !== "string") return "malformed";
  if (t.refresh_token !== "") return "refresh token present";
  if (!nonEmptyString(t.access_token)) return "malformed";
  if (!nonEmptyString(t.id_token)) return "malformed";
  const exp = publishedJwtExpiryMs(t.access_token as string);
  if (exp == null) return "malformed";
  if (exp <= nowMs) return "expired";
  if (exp - nowMs < budgetMs) return "too short for budget";
  return undefined;
}

export interface EnsureCodexPublishedAuthOptions {
  home: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * Validate the published token-only file and symlink it into place.
 * Returns local mode when `CODEX_AUTH_FILE` is unset. Otherwise reads the
 * published file, refuses a refresh token or an `exp` that does not cover the
 * run budget, and points `$HOME/.codex/auth.json` at it with a symlink before
 * the spawn (including resume). `$HOME/.codex` stays writable; only the file
 * is read-only. Throws on any failure; callers classify it as auth.
 */
export async function ensureCodexPublishedAuth(opts: EnsureCodexPublishedAuthOptions): Promise<{
  mode: "local" | "published";
  publishedPath?: string;
}> {
  const env = opts.env ?? process.env;
  const published = codexPublishedAuthPath(env);
  if (!published) return { mode: "local" };
  const now = opts.now?.() ?? Date.now();
  const budgetMs = codexJobBudgetMs(opts.timeoutMs);
  let raw: string;
  try {
    raw = await readFile(published, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      throw new Error(`Codex published auth file is missing: ${published}`);
    }
    throw new Error(
      `Codex published auth file is unreadable: ${published}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!raw.trim()) throw new Error(`Codex published auth file is malformed: ${published}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Codex published auth file is malformed: ${published}`);
  }
  const reason = publishedAuthFailureReason(parsed, budgetMs, now);
  if (reason) {
    throw new Error(`Codex published auth file cannot run (${reason}): ${published}`);
  }
  const dest = codexAuthPath(opts.home);
  await mkdir(dirname(dest), { recursive: true });
  await rm(dest, { force: true });
  await symlink(published, dest);
  return { mode: "published", publishedPath: published };
}
