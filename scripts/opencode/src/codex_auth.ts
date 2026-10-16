import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

export async function isCodexChatGptPresent(home: string): Promise<boolean> {
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
