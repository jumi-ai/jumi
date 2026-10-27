import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ATTACHMENTS_DIR } from "./engine_scratch.ts";

export { ATTACHMENTS_DIR };
export const ATTACHMENTS_MANIFEST = "JUMI_ATTACHMENTS.md";
const ATTACHMENTS_EXCLUDE = `${ATTACHMENTS_DIR}/`;

/** Caps keep one issue from exhausting the worktree or the child context. */
export const MAX_ATTACHMENT_FILES = 10;
export const MAX_ATTACHMENT_BYTES_PER_FILE = 2 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;

export interface ForgeAttachment {
  id?: number;
  uuid?: string;
  name: string;
  size: number;
  browser_download_url: string;
}

export interface AttachmentRecord {
  name: string;
  size: number;
  sha256?: string;
  url: string;
  staged: boolean;
  reason?: string;
  source?: string;
}

export interface AttachmentApi {
  listIssueAttachments?(owner: string, repo: string, index: number): Promise<ForgeAttachment[]>;
  listIssueCommentAttachments?(owner: string, repo: string, commentId: number): Promise<ForgeAttachment[]>;
  downloadAttachmentBytes?(url: string): Promise<Uint8Array>;
  listIssueComments?(owner: string, repo: string, index: number): Promise<Array<{ id: number; body: string }>>;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err != null && "code" in err && (err as { code?: string }).code === "ENOENT";
}

function sanitizeBase(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 128);
  const trimmed = cleaned.replace(/^[._]+/, "").replace(/[. ]+$/, "");
  return trimmed || "attachment";
}

export function sanitizeAttachmentName(raw: string, used: Set<string>): string {
  const name = sanitizeBase(raw);
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `attachment-${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "unknown bytes";
  return `${n} bytes`;
}

/**
 * GitHub has no issue-asset list API: user-attachment links only appear as
 * markdown URLs in the issue/PR body. Extract them so the parent can attempt
 * a credentialed download, or record them as unsupported.
 *
 * Documented limitation: when the forge offers no list/download API for these
 * URLs, they are listed in the manifest as NOT STAGED with the reason
 * `github user-attachments not supported`.
 */
export function extractBodyAttachmentUrls(bodies: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /https?:\/\/[^\s)"'\]]*user-attachments[^\s)"'\]]*/g,
    /https?:\/\/[^\s)"'\]]*\/attachments\/[^\s)"'\]]*/g,
  ];
  for (const body of bodies) {
    if (!body) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of body.matchAll(pattern)) {
        const url = match[0].replace(/[.,;]+$/, "");
        if (url && !seen.has(url)) {
          seen.add(url);
          out.push(url);
        }
      }
    }
  }
  return out;
}

function pickBodyUrl(bodies: readonly (string | null | undefined)[], fallback: string, keys: string[]): string {
  for (const body of bodies) {
    if (!body) continue;
    const idx = body.indexOf(fallback);
    if (idx >= 0) return fallback;
    for (const key of keys) {
      if (!key) continue;
      const at = body.indexOf(key);
      if (at < 0) continue;
      const urlMatch = /https?:\/\/[^\s)"'\]]+/.exec(body.slice(Math.max(0, at - 200), at + 300));
      if (urlMatch) return urlMatch[0];
    }
  }
  return fallback;
}

export function buildAttachmentsMarkdown(records: AttachmentRecord[], sources: string[]): string {
  const lines: string[] = [];
  lines.push("# Issue attachments");
  lines.push("");
  lines.push("Staged by the parent before the run. Files live under `.jumi-attachments/` (ignored, never committed).");
  lines.push("A task that needs to vendor a file copies it out explicitly.");
  if (sources.length > 0) lines.push(`Sources: ${sources.join(", ")}`);
  lines.push("");
  if (records.length === 0) {
    lines.push("No attachments.");
    lines.push("");
    return `${lines.join("\n")}`;
  }
  for (const record of records) {
    if (record.staged) {
      lines.push(
        `- ${record.name} — ${formatBytes(record.size)}${record.sha256 ? `, sha256:${record.sha256}` : ""} — ${record.url} → \`.jumi-attachments/${record.name}\``
      );
    } else {
      lines.push(`- ${record.name} — NOT STAGED: ${record.reason ?? "not staged"} — ${record.url}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

async function attachmentsExcludePath(worktree: string): Promise<string | undefined> {
  const dotGit = join(worktree, ".git");
  try {
    const { lstat } = await import("node:fs/promises");
    const info = await lstat(dotGit).catch(() => undefined);
    if (!info) return undefined;
    if (info.isDirectory()) return join(dotGit, "info", "exclude");
    if (!info.isFile()) return undefined;
    const text = await readFile(dotGit, "utf8").catch(() => "");
    const gitdirRel = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
    if (!gitdirRel) return undefined;
    const gitdir = resolve(worktree, gitdirRel);
    let common = gitdir;
    const commondir = (await readFile(join(gitdir, "commondir"), "utf8").catch(() => "")).trim();
    if (commondir) common = resolve(gitdir, commondir);
    return join(common, "info", "exclude");
  } catch {
    return undefined;
  }
}

function excludeListsAttachments(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === ATTACHMENTS_DIR ||
      trimmed === ATTACHMENTS_EXCLUDE ||
      trimmed === `/${ATTACHMENTS_DIR}` ||
      trimmed === `/${ATTACHMENTS_EXCLUDE}`
    );
  });
}

export async function ensureAttachmentsIgnored(worktree: string): Promise<boolean> {
  const excludePath = await attachmentsExcludePath(worktree);
  if (!excludePath) return false;
  await mkdir(dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  if (excludeListsAttachments(existing)) return true;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  await writeFile(excludePath, `${prefix}${ATTACHMENTS_EXCLUDE}\n`);
  return true;
}

export function isAttachmentsPath(path: string): boolean {
  return path === ATTACHMENTS_DIR || path.startsWith(`${ATTACHMENTS_DIR}/`);
}

export interface StageAttachmentsOptions {
  api: AttachmentApi;
  owner: string;
  repo: string;
  /** Issue index first, then PR index for follow-ups. Duplicates are merged by uuid/url. */
  indexes: number[];
  bodies?: readonly (string | null | undefined)[];
  worktree: string;
  log?: (message: string) => void;
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}

export interface StageAttachmentsResult {
  records: AttachmentRecord[];
  /** Manifest markdown, or undefined when there was nothing to report. */
  manifest?: string;
  stagedCount: number;
}

async function listAllForgeAttachments(
  api: AttachmentApi,
  owner: string,
  repo: string,
  indexes: number[],
  log?: (message: string) => void
): Promise<ForgeAttachment[]> {
  const out: ForgeAttachment[] = [];
  const seen = new Set<string>();
  const push = (attachment: ForgeAttachment) => {
    const key = attachment.uuid || `${attachment.id ?? ""}:${attachment.browser_download_url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(attachment);
  };
  for (const index of indexes) {
    if (typeof api.listIssueAttachments !== "function") break;
    try {
      const listed = await api.listIssueAttachments(owner, repo, index);
      for (const attachment of listed ?? []) push(attachment);
    } catch (err) {
      log?.(`attachments: list ${owner}/${repo}#${index} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof api.listIssueComments !== "function" || typeof api.listIssueCommentAttachments !== "function") {
      continue;
    }
    try {
      const comments = await api.listIssueComments(owner, repo, index);
      for (const comment of comments ?? []) {
        if (typeof comment?.id !== "number") continue;
        try {
          const assets = await api.listIssueCommentAttachments(owner, repo, comment.id);
          for (const attachment of assets ?? []) push(attachment);
        } catch {}
      }
    } catch {}
  }
  return out;
}

export async function stageIssueAttachments(opts: StageAttachmentsOptions): Promise<StageAttachmentsResult> {
  const log = opts.log ?? (() => undefined);
  const maxFiles = opts.maxFiles ?? MAX_ATTACHMENT_FILES;
  const maxPerFile = opts.maxBytesPerFile ?? MAX_ATTACHMENT_BYTES_PER_FILE;
  const maxTotal = opts.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES;
  const bodies = opts.bodies ?? [];
  const dir = join(opts.worktree, ATTACHMENTS_DIR);
  const manifestPath = join(opts.worktree, ATTACHMENTS_MANIFEST);
  // Clear any pre-existing stage so a re-stage of a shrunk set cannot leave
  // stale files on disk that are absent from the fresh manifest.
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);

  const forgeAttachments = await listAllForgeAttachments(opts.api, opts.owner, opts.repo, opts.indexes, log);
  const bodyUrls = extractBodyAttachmentUrls(bodies);
  const knownUrls = new Set(forgeAttachments.map((attachment) => attachment.browser_download_url));
  const githubOnlyUrls = bodyUrls.filter((url) => !knownUrls.has(url));

  const sources = opts.indexes.map((index) => `${opts.owner}/${opts.repo}#${index}`);
  const records: AttachmentRecord[] = [];
  const used = new Set<string>();
  let totalBytes = 0;
  let stagedFiles = 0;

  const noteUnstaged = (name: string, size: number, url: string, reason: string, source?: string) => {
    records.push({ name: sanitizeAttachmentName(name, used), size, url, staged: false, reason, source });
  };

  const canDownload = typeof opts.api.downloadAttachmentBytes === "function";
  let counted = 0;
  for (const attachment of forgeAttachments) {
    counted += 1;
    const url = pickBodyUrl(bodies, attachment.browser_download_url, [attachment.uuid ?? "", attachment.name]);
    const nameHint = attachment.name || url.split(/[?#]/)[0]?.split("/").pop() || "attachment";
    if (counted > maxFiles) {
      noteUnstaged(nameHint, attachment.size, url, `exceeds count cap (max ${maxFiles} files)`, sources[0]);
      continue;
    }
    if (attachment.size > maxPerFile) {
      noteUnstaged(
        nameHint,
        attachment.size,
        url,
        `exceeds per-file cap (${attachment.size} > ${maxPerFile} bytes)`,
        sources[0]
      );
      continue;
    }
    if (totalBytes + attachment.size > maxTotal) {
      noteUnstaged(nameHint, attachment.size, url, `exceeds total cap (max ${maxTotal} bytes)`, sources[0]);
      continue;
    }
    if (!canDownload) {
      noteUnstaged(nameHint, attachment.size, url, "forge download not supported", sources[0]);
      continue;
    }
    try {
      const bytes = await opts.api.downloadAttachmentBytes!(attachment.browser_download_url);
      if (bytes.byteLength > maxPerFile) {
        noteUnstaged(
          nameHint,
          bytes.byteLength,
          url,
          `exceeds per-file cap (${bytes.byteLength} > ${maxPerFile} bytes)`,
          sources[0]
        );
        continue;
      }
      if (totalBytes + bytes.byteLength > maxTotal) {
        noteUnstaged(nameHint, bytes.byteLength, url, `exceeds total cap (max ${maxTotal} bytes)`, sources[0]);
        continue;
      }
      const name = sanitizeAttachmentName(nameHint, used);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), bytes);
      const sha256 = sha256Hex(bytes);
      totalBytes += bytes.byteLength;
      stagedFiles += 1;
      records.push({ name, size: bytes.byteLength, sha256, url, staged: true, source: sources[0] });
    } catch (err) {
      noteUnstaged(
        nameHint,
        attachment.size,
        url,
        `download failed: ${err instanceof Error ? err.message : String(err)}`,
        sources[0]
      );
    }
  }

  for (const url of githubOnlyUrls) {
    if (counted >= maxFiles) {
      const fallback = url.split(/[?#]/)[0]?.split("/").pop() || "attachment";
      noteUnstaged(fallback, 0, url, `exceeds count cap (max ${maxFiles} files)`, sources[0]);
      continue;
    }
    counted += 1;
    const fallback = url.split(/[?#]/)[0]?.split("/").pop() || "attachment";
    if (!canDownload) {
      noteUnstaged(fallback, 0, url, "github user-attachments not supported", sources[0]);
      continue;
    }
    try {
      const bytes = await opts.api.downloadAttachmentBytes!(url);
      if (bytes.byteLength > maxPerFile) {
        noteUnstaged(
          fallback,
          bytes.byteLength,
          url,
          `exceeds per-file cap (${bytes.byteLength} > ${maxPerFile} bytes)`,
          sources[0]
        );
        continue;
      }
      if (totalBytes + bytes.byteLength > maxTotal) {
        noteUnstaged(fallback, bytes.byteLength, url, `exceeds total cap (max ${maxTotal} bytes)`, sources[0]);
        continue;
      }
      const name = sanitizeAttachmentName(fallback, used);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), bytes);
      const sha256 = sha256Hex(bytes);
      totalBytes += bytes.byteLength;
      stagedFiles += 1;
      records.push({ name, size: bytes.byteLength, sha256, url, staged: true, source: sources[0] });
    } catch (err) {
      noteUnstaged(
        fallback,
        0,
        url,
        `download failed: ${err instanceof Error ? err.message : String(err)}`,
        sources[0]
      );
    }
  }

  if (records.length === 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(manifestPath, { force: true }).catch(() => undefined);
    return { records, manifest: undefined, stagedCount: 0 };
  }

  const manifest = buildAttachmentsMarkdown(records, sources);
  await writeFile(manifestPath, manifest);
  await ensureAttachmentsIgnored(opts.worktree).catch(() => false);
  log(`attachments: staged ${stagedFiles}/${records.length} in ${ATTACHMENTS_DIR}`);
  return { records, manifest, stagedCount: stagedFiles };
}
