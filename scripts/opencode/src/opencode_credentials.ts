import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { defaultOpenCodeDbPath } from "./diagnostics.ts";
import { type AuthFile, durableAuthPath, readAuthFile, writeDurableAuth, XAI_PROVIDER_ID } from "./xai_auth.ts";

/**
 * OpenCode 2 keeps credentials in SQLite. `auth.json` stays Jumi's durable store
 * because the parent owns the xAI grant there and it is what a Retain volume
 * holds, so credentials cross the boundary in both directions here:
 *
 * - `opencode auth login` writes the SQLite store under HOME. The parent copies
 *   those rows into `auth.json`.
 * - A child gets a fresh per-run database, and a fresh database never reads
 *   `auth.json`: bootstrap marks every migration done, including the one that
 *   imports it. The parent re-arms that one migration, so OpenCode's own import
 *   loads the isolated file (well-known entries included) on the next start.
 */

const LEGACY_CREDENTIAL_MIGRATION = "20260805200742_import_legacy_credentials";

/** Cap on the bootstrap spawn; a healthy one takes a fraction of a second. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

interface CredentialRow {
  integration_id: string | null;
  value: string;
  time_updated: number;
}

function authEntry(raw: string): unknown {
  const value = JSON.parse(raw) as {
    type?: string;
    key?: string;
    refresh?: string;
    access?: string;
    expires?: number;
    metadata?: { accountID?: string; enterpriseUrl?: string };
  };
  if (value.type === "key") return { type: "api", key: value.key };
  if (value.type !== "oauth") return undefined;
  return {
    type: "oauth",
    refresh: value.refresh,
    access: value.access,
    expires: value.expires,
    ...(value.metadata?.accountID ? { accountId: value.metadata.accountID } : {}),
    ...(value.metadata?.enterpriseUrl ? { enterpriseUrl: value.metadata.enterpriseUrl } : {}),
  };
}

function readCredentialRows(dbPath: string): CredentialRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(
        "SELECT integration_id, value, time_updated FROM credential ORDER BY COALESCE(active, 0) DESC, time_updated DESC"
      )
      .all() as CredentialRow[];
  } finally {
    db.close();
  }
}

/**
 * Copy credentials from HOME's OpenCode 2 store into the durable auth file. A
 * row replaces an entry only when it is newer than the file: the parent rotates
 * the xAI grant on the file, so an older row is a token xAI already rotated
 * away from. Well-known origins are skipped, startup seeds those from config.
 *
 * Returns the integrations it wrote. An unreadable store is logged and adopts
 * nothing; a write that fails throws, so a device login can report it.
 */
export async function adoptOpenCodeDbCredentials(home: string, logger?: (message: string) => void): Promise<string[]> {
  const dbPath = defaultOpenCodeDbPath(home);
  if (!existsSync(dbPath)) return [];
  let rows: CredentialRow[];
  try {
    rows = readCredentialRows(dbPath);
  } catch {
    logger?.("OpenCode credential store is unreadable; nothing adopted");
    return [];
  }
  const path = await durableAuthPath(home);
  const auth: AuthFile = await readAuthFile(path);
  const fileUpdated = (await stat(path).catch(() => undefined))?.mtimeMs ?? 0;
  const seen = new Set<string>();
  const adopted: string[] = [];
  for (const row of rows) {
    const id = row.integration_id;
    if (!id || id.includes("://") || seen.has(id)) continue;
    seen.add(id);
    if (auth[id] !== undefined && row.time_updated <= fileUpdated) continue;
    const entry = authEntry(row.value);
    if (entry === undefined) continue;
    auth[id] = entry;
    adopted.push(id);
  }
  if (adopted.length === 0) return [];
  await writeDurableAuth(path, auth);
  logger?.(`adopted OpenCode credentials for ${adopted.join(", ")}`);
  return adopted;
}

/**
 * Make the next OpenCode 2 start on `dbPath` import the isolated `auth.json`.
 * Clearing the xAI row lets a resumed session pick up a token the parent
 * rotated: the import skips an integration that already has a credential, and a
 * stored credential outranks `XAI_API_KEY`. Other rows stay, the child may have
 * refreshed them. Best-effort like the seed itself: env-only auth still works.
 */
export async function armChildCredentialImport(opts: {
  dbPath: string;
  env: Record<string, string>;
  cwd: string;
  log: (message: string) => void;
}): Promise<void> {
  try {
    if (!existsSync(opts.dbPath)) {
      const proc = Bun.spawn(["opencode", "auth", "export", "--standalone"], {
        cwd: opts.cwd,
        env: opts.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const timer = setTimeout(() => proc.kill(), BOOTSTRAP_TIMEOUT_MS);
      await proc.exited.finally(() => clearTimeout(timer));
    }
    if (!existsSync(opts.dbPath)) {
      opts.log("OpenCode credential bootstrap left no database; the child has env auth only");
      return;
    }
    const db = new Database(opts.dbPath);
    try {
      db.run("DELETE FROM migration WHERE id = ?", [LEGACY_CREDENTIAL_MIGRATION]);
      db.run("DELETE FROM credential WHERE integration_id = ?", [XAI_PROVIDER_ID]);
    } finally {
      db.close();
    }
  } catch (err) {
    opts.log(`OpenCode credential bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
