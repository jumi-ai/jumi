import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_OPENCODE_WELLKNOWN_URL = "https://kirmanak.stream";
export const OPENCODE_WELLKNOWN_DISABLED = "disabled";

export interface OpenCodeWellKnownAuthOptions {
  home: string;
  xdgDataHome?: string;
  url?: string;
  key: string;
  token: string;
  logger?: (message: string) => void;
}

export function parseOpenCodeWellKnownUrl(value: string | undefined): string | undefined {
  const raw = value?.trim() ?? "";
  if (!raw) return DEFAULT_OPENCODE_WELLKNOWN_URL;
  if (raw === OPENCODE_WELLKNOWN_DISABLED) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid OPENCODE_WELLKNOWN_URL: ${raw}`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error(`Invalid OPENCODE_WELLKNOWN_URL: ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

type AuthFile = Record<string, unknown>;

export function opencodeAuthPath(home: string, xdgDataHome?: string): string {
  const dataHome = xdgDataHome || join(home, ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

async function readAuthFile(path: string): Promise<AuthFile> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`OpenCode auth file must contain a JSON object: ${path}`);
    }
    return parsed as AuthFile;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeAuthFile(path: string, auth: AuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

function isWellKnownEntry(value: unknown): boolean {
  return (
    !!value && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "wellknown"
  );
}

function wellKnownCredential(value: unknown): { key: unknown; token: unknown } | undefined {
  if (!isWellKnownEntry(value)) return undefined;
  const entry = value as { key?: unknown; token?: unknown };
  return { key: entry.key, token: entry.token };
}

export async function ensureOpenCodeWellKnownAuth(options: OpenCodeWellKnownAuthOptions): Promise<string | undefined> {
  const url = options.url === OPENCODE_WELLKNOWN_DISABLED ? undefined : options.url;
  // A job pod starts with an empty HOME: creating it here keeps the seed from
  // failing start when nothing else has touched the volume yet.
  await mkdir(options.home, { recursive: true }).catch(() => undefined);
  const path = opencodeAuthPath(options.home, options.xdgDataHome);
  const auth = await readAuthFile(path);
  let changed = false;

  if (isWellKnownEntry(auth[OPENCODE_WELLKNOWN_DISABLED])) {
    delete auth[OPENCODE_WELLKNOWN_DISABLED];
    changed = true;
    options.logger?.(`removed OpenCode well-known auth for ${OPENCODE_WELLKNOWN_DISABLED} at ${path}`);
  }

  if (!url) {
    if (changed) await writeAuthFile(path, auth);
    else options.logger?.("OpenCode well-known auth disabled");
    return undefined;
  }

  const existing = wellKnownCredential(auth[url]);
  if (existing === undefined || existing.key !== options.key || existing.token !== options.token) {
    const created = auth[url] === undefined;
    auth[url] = {
      type: "wellknown",
      key: options.key,
      token: options.token,
    };
    changed = true;
    options.logger?.(
      created
        ? `seeded OpenCode well-known auth for ${url} at ${path}`
        : `updated OpenCode well-known auth for ${url} at ${path}`
    );
  } else {
    options.logger?.(`OpenCode well-known auth for ${url} already present at ${path}`);
  }

  if (changed) await writeAuthFile(path, auth);
  else await chmod(path, 0o600).catch(() => undefined);
  return path;
}
