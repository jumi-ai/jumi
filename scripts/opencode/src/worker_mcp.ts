/**
 * Parent-owned per-spawn worker MCP server.
 *
 * Mirrors `review_mcp.ts`: a loopback HTTP port (no socket file in the
 * checkout) with a random per-spawn bearer token. The harness writes the MCP
 * config under an outside harness temp root (`/tmp/jumi-worker-*`, never the
 * checkout and never the child environment) and the model reaches the tools
 * through MCP-style JSON-RPC over HTTP (`POST /mcp`): `initialize`,
 * `tools/list`, and `tools/call`.
 *
 * Tools:
 * - `no_changes(reason)`: follow-up rounds that leave the tree clean;
 * - `set_pr_body(markdown)`: PR description (same Refs/Fixes rules as the
 *   parent prompt);
 * - `skip(reason)`: implement has nothing to change;
 * - `blocked_on(ref, reason)`: cross-repo ref like `owner/repo#N` (or `#N`
 *   for this repo), feeding the dependency/blocked path;
 * - `set_handoff(notes)`: notes for the next round, size-capped, never secrets.
 *
 * The parent reads the small result store after the run and prefers the tool
 * value over the legacy `JUMI_*.md` file fallback for one transition period.
 */

import { randomBytes } from "node:crypto";
import { agyMcpServerEntry, claudeMcpConfigFor, codexMcpTomlEntry, openCodeMcpEntry } from "./review_mcp.ts";
import { sanitizeCheckReason } from "./verdict.ts";

export const WORKER_MCP_SERVER_NAME = "jumi-worker";

export const WORKER_MCP_TOOL_NAMES = ["no_changes", "set_pr_body", "skip", "blocked_on", "set_handoff"] as const;

export type WorkerMcpToolName = (typeof WORKER_MCP_TOOL_NAMES)[number];

/** Longest accepted `no_changes` reason (chars, after trim). */
export const MAX_WORKER_NO_CHANGES_REASON_CHARS = 500;

/** Longest accepted `set_pr_body` markdown (chars, after trim). Mirrors the parent prose cap. */
export const MAX_WORKER_PR_BODY_CHARS = 8000;

/** Longest accepted `skip` reason (chars, after trim). Mirrors the parent prose cap. */
export const MAX_WORKER_SKIP_REASON_CHARS = 8000;

/** Longest accepted `blocked_on` reason (chars, after trim). */
export const MAX_WORKER_BLOCKED_REASON_CHARS = 2000;

/** Handoff cap lives in `handoff.ts` (16 KiB); the tool stores the capped head. */
export const WORKER_HANDOFF_MAX_BYTES = 16 * 1024;

export function randomWorkerMcpToken(): string {
  return randomBytes(32).toString("hex");
}

export function workerMcpAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function isAuthorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? req.headers.get("x-jumi-worker-token") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : header.trim();
  if (!bearer || bearer.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < bearer.length; i++) diff |= bearer.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** Count sentences: non-empty segments split on `.`/`!`/`?`, ignoring dots inside URLs. */
export function countReasonSentences(reason: string): number {
  // Strip `http(s)://...` tokens first so dots inside a link (e.g. an
  // external-fix URL the issue explicitly wants) never count as boundaries.
  // Keep trailing sentence punctuation attached to the URL (the greedy `\S+`
  // would otherwise swallow the `.` that ends the sentence).
  const withoutUrls = reason.replace(/https?:\/\/\S+/g, (match) => {
    const trail = match.match(/[.,!?;:]+$/)?.[0] ?? "";
    return trail ? ` ${trail}` : " ";
  });
  return withoutUrls
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

export function validateNoChangesReason(reason: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  if (typeof reason !== "string") return { ok: false, error: "reason is required (1-3 sentences)" };
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, error: "reason is required (1-3 sentences)" };
  if (trimmed.length > MAX_WORKER_NO_CHANGES_REASON_CHARS) {
    return { ok: false, error: `reason is too long (max ${MAX_WORKER_NO_CHANGES_REASON_CHARS} chars)` };
  }
  const sentences = countReasonSentences(trimmed);
  if (sentences < 1 || sentences > 3) {
    return { ok: false, error: "reason must be 1-3 sentences" };
  }
  return { ok: true, reason: trimmed };
}

export function validatePrBody(markdown: unknown): { ok: true; markdown: string } | { ok: false; error: string } {
  if (typeof markdown !== "string") return { ok: false, error: "markdown is required" };
  const trimmed = markdown.replaceAll("\0", "").trim();
  if (!trimmed) return { ok: false, error: "markdown is required" };
  if (trimmed.length > MAX_WORKER_PR_BODY_CHARS) {
    return { ok: false, error: `markdown is too long (max ${MAX_WORKER_PR_BODY_CHARS} chars)` };
  }
  return { ok: true, markdown: trimmed };
}

export function validateSkipReason(reason: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  if (typeof reason !== "string") return { ok: false, error: "reason is required" };
  const trimmed = reason.replaceAll("\0", "").trim();
  if (!trimmed) return { ok: false, error: "reason is required" };
  if (trimmed.length > MAX_WORKER_SKIP_REASON_CHARS) {
    return { ok: false, error: `reason is too long (max ${MAX_WORKER_SKIP_REASON_CHARS} chars)` };
  }
  return { ok: true, reason: trimmed };
}

export interface WorkerBlockedOnRef {
  owner?: string;
  repo?: string;
  number: number;
  canonical: string;
}

const BLOCKED_ON_REF_RE = /^(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)|#(\d+))$/;

export function parseBlockedOnRef(
  ref: unknown,
  homeOwner?: string,
  homeRepo?: string
): { ok: true; ref: WorkerBlockedOnRef } | { ok: false; error: string } {
  if (typeof ref !== "string") return { ok: false, error: "ref is required like owner/repo#N or #N" };
  const trimmed = ref.trim();
  const match = trimmed.match(BLOCKED_ON_REF_RE);
  if (!match) return { ok: false, error: "ref must look like owner/repo#N or #N" };
  if (match[1] != null && match[2] != null && match[3] != null) {
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return { ok: false, error: "ref number must be positive" };
    return {
      ok: true,
      ref: { owner: match[1], repo: match[2], number, canonical: `${match[1]}/${match[2]}#${number}` },
    };
  }
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number) || number <= 0) return { ok: false, error: "ref number must be positive" };
  if (homeOwner && homeRepo) {
    return {
      ok: true,
      ref: { owner: homeOwner, repo: homeRepo, number, canonical: `${homeOwner}/${homeRepo}#${number}` },
    };
  }
  return { ok: true, ref: { number, canonical: `#${number}` } };
}

export function validateBlockedOn(
  input: { ref?: unknown; reason?: unknown },
  home?: { owner: string; repo: string }
): { ok: true; ref: WorkerBlockedOnRef; reason: string } | { ok: false; error: string } {
  const parsed = parseBlockedOnRef(input.ref, home?.owner, home?.repo);
  if (!parsed.ok) return parsed;
  if (typeof input.reason !== "string") return { ok: false, error: "reason is required" };
  const reason = input.reason.replaceAll("\0", "").trim();
  if (!reason) return { ok: false, error: "reason is required" };
  if (reason.length > MAX_WORKER_BLOCKED_REASON_CHARS) {
    return { ok: false, error: `reason is too long (max ${MAX_WORKER_BLOCKED_REASON_CHARS} chars)` };
  }
  return { ok: true, ref: parsed.ref, reason };
}

export function validateHandoffNotes(notes: unknown): { ok: true; notes: string } | { ok: false; error: string } {
  if (typeof notes !== "string") return { ok: false, error: "notes are required" };
  const trimmed = notes.replaceAll("\0", "").trim();
  if (!trimmed) return { ok: false, error: "notes are required" };
  const bytes = new TextEncoder().encode(trimmed).byteLength;
  if (bytes > WORKER_HANDOFF_MAX_BYTES) {
    return { ok: false, error: `notes are too long (max ${WORKER_HANDOFF_MAX_BYTES} bytes)` };
  }
  return { ok: true, notes: trimmed };
}

export interface WorkerBlockedOn {
  ref: string;
  reason: string;
  owner?: string;
  repo?: string;
  number: number;
}

/**
 * Small result store the parent reads after the run. One store lives for one
 * spawn and dies with it. Last call per tool wins.
 */
export class WorkerResultStore {
  private reason?: string;
  private prBody?: string;
  private skipReason?: string;
  private blockedOn?: WorkerBlockedOn;
  private handoff?: string;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  setNoChanges(input: { reason?: unknown }): { ok: true } | { ok: false; error: string } {
    if (this.closed) return { ok: false, error: "worker spawn ended: result store is closed" };
    const validated = validateNoChangesReason(input.reason);
    if (!validated.ok) return validated;
    this.reason = validated.reason;
    return { ok: true };
  }

  getNoChangesReason(): string | undefined {
    return this.reason ? `${this.reason}` : undefined;
  }

  hasNoChanges(): boolean {
    return this.reason !== undefined;
  }

  setPrBody(input: { markdown?: unknown }): { ok: true } | { ok: false; error: string } {
    if (this.closed) return { ok: false, error: "worker spawn ended: result store is closed" };
    const validated = validatePrBody(input.markdown);
    if (!validated.ok) return validated;
    this.prBody = validated.markdown;
    return { ok: true };
  }

  getPrBody(): string | undefined {
    return this.prBody ? `${this.prBody}` : undefined;
  }

  hasPrBody(): boolean {
    return this.prBody !== undefined;
  }

  setSkip(input: { reason?: unknown }): { ok: true } | { ok: false; error: string } {
    if (this.closed) return { ok: false, error: "worker spawn ended: result store is closed" };
    const validated = validateSkipReason(input.reason);
    if (!validated.ok) return validated;
    this.skipReason = validated.reason;
    return { ok: true };
  }

  getSkipReason(): string | undefined {
    return this.skipReason ? `${this.skipReason}` : undefined;
  }

  hasSkip(): boolean {
    return this.skipReason !== undefined;
  }

  setBlockedOn(input: { ref?: unknown; reason?: unknown }): { ok: true } | { ok: false; error: string } {
    if (this.closed) return { ok: false, error: "worker spawn ended: result store is closed" };
    const validated = validateBlockedOn(input);
    if (!validated.ok) return validated;
    this.blockedOn = {
      ref: validated.ref.canonical,
      reason: validated.reason,
      ...(validated.ref.owner ? { owner: validated.ref.owner } : {}),
      ...(validated.ref.repo ? { repo: validated.ref.repo } : {}),
      number: validated.ref.number,
    };
    return { ok: true };
  }

  getBlockedOn(): WorkerBlockedOn | undefined {
    return this.blockedOn ? { ...this.blockedOn } : undefined;
  }

  hasBlockedOn(): boolean {
    return this.blockedOn !== undefined;
  }

  setHandoff(input: { notes?: unknown }): { ok: true } | { ok: false; error: string } {
    if (this.closed) return { ok: false, error: "worker spawn ended: result store is closed" };
    const validated = validateHandoffNotes(input.notes);
    if (!validated.ok) return validated;
    this.handoff = validated.notes;
    return { ok: true };
  }

  getHandoff(): string | undefined {
    return this.handoff ? `${this.handoff}` : undefined;
  }

  hasHandoff(): boolean {
    return this.handoff !== undefined;
  }

  hasAnything(): boolean {
    return (
      this.reason !== undefined ||
      this.prBody !== undefined ||
      this.skipReason !== undefined ||
      this.blockedOn !== undefined ||
      this.handoff !== undefined
    );
  }
}

/**
 * Give the next spawn its own result scope: close the previous store and
 * point the server at a fresh one. Handoff is the one result that persists
 * across attempts, so carry it forward; skip, PR body, no-changes and
 * blockers start empty for the new attempt.
 */
export function rotateResultScope(
  log: (message: string) => void,
  prev: WorkerResultStore,
  server: { setStore: (store: WorkerResultStore) => void }
): WorkerResultStore {
  const handoff = prev.getHandoff();
  prev.close();
  const fresh = new WorkerResultStore();
  if (handoff != null) {
    const carried = fresh.setHandoff({ notes: handoff });
    if (!carried.ok) log(`worker result: handoff carry failed: ${carried.error}`);
  }
  server.setStore(fresh);
  return fresh;
}

/** Unfenced live body: worker markdown becomes a fenced Jumi addendum below maintainer text. */
export const UNFENCED_PR_BODY_ADDENDUM_NOTE =
  "The PR description is maintainer-written (no Jumi fence). Your `set_pr_body` markdown becomes a fenced Jumi section appended below it after a blank line: include only what the reviewer asked to be disclosed plus verification notes, not a full replacement description. The maintainer text above stays unchanged.";

function toolSchemas(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: "no_changes",
      description:
        "Record why this follow-up round leaves the tree unchanged: what triggered the round (review finding / CI failure / comment) and why nothing changed. Required, 1-3 sentences.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
    {
      name: "set_pr_body",
      description:
        "Record the pull-request description. If the change does not meet the issue Done condition, use Refs #N and list what is left, not a closing keyword like Fixes #N. A bare Refs #N with no remaining-work list is treated as finished. If the PR body is maintainer-written (no Jumi fence), your markdown becomes a fenced Jumi section appended below it: include only what the reviewer asked to be disclosed plus verification notes, not a full replacement description.",
      inputSchema: {
        type: "object",
        properties: { markdown: { type: "string" } },
        required: ["markdown"],
      },
    },
    {
      name: "skip",
      description: "Record that this implement round has nothing to change, with the reason. Last call wins.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
    {
      name: "blocked_on",
      description:
        "Record that this implement round is blocked on another issue: ref like owner/repo#N (or #N for this repo) plus the reason. Feeds the dependency/blocked path. Last call wins.",
      inputSchema: {
        type: "object",
        properties: { ref: { type: "string" }, reason: { type: "string" } },
        required: ["ref", "reason"],
      },
    },
    {
      name: "set_handoff",
      description:
        "Record notes for the next round: key files and why they matter, commands that built and tested, workarounds, what is left or risky. Size-capped, never include secrets.",
      inputSchema: {
        type: "object",
        properties: { notes: { type: "string" } },
        required: ["notes"],
      },
    },
  ];
}

function callTool(
  store: WorkerResultStore,
  name: string,
  args: Record<string, unknown>,
  opts?: { prBodyFenced?: boolean }
): { ok: boolean; text: string } {
  if (name === "no_changes") {
    const result = store.setNoChanges({ reason: args.reason });
    return result.ok ? { ok: true, text: JSON.stringify({ recorded: true }) } : { ok: false, text: result.error };
  }
  if (name === "set_pr_body") {
    const result = store.setPrBody({ markdown: args.markdown });
    if (!result.ok) return { ok: false, text: result.error };
    if (opts?.prBodyFenced === false) {
      return {
        ok: true,
        text: JSON.stringify({ recorded: true, pr_body_mode: "addendum", note: UNFENCED_PR_BODY_ADDENDUM_NOTE }),
      };
    }
    return { ok: true, text: JSON.stringify({ recorded: true }) };
  }
  if (name === "skip") {
    const result = store.setSkip({ reason: args.reason });
    return result.ok ? { ok: true, text: JSON.stringify({ recorded: true }) } : { ok: false, text: result.error };
  }
  if (name === "blocked_on") {
    const result = store.setBlockedOn({ ref: args.ref, reason: args.reason });
    return result.ok ? { ok: true, text: JSON.stringify({ recorded: true }) } : { ok: false, text: result.error };
  }
  if (name === "set_handoff") {
    const result = store.setHandoff({ notes: args.notes });
    return result.ok ? { ok: true, text: JSON.stringify({ recorded: true }) } : { ok: false, text: result.error };
  }
  return { ok: false, text: `unknown tool: ${name}` };
}

export interface StartedWorkerMcpServer {
  url: string;
  token: string;
  close: () => void;
  /**
   * Point the server at a fresh result scope. The previous store should
   * already be closed; the server keeps its URL/token so in-flight spawns
   * keep a stable endpoint while each attempt gets its own scope.
   */
  setStore: (store: WorkerResultStore) => void;
}

export async function startWorkerMcpServer(opts: {
  store: WorkerResultStore;
  token?: string;
  /** False when the live body has no Jumi fence: the `set_pr_body` result names the addendum case. */
  prBodyFenced?: boolean;
}): Promise<StartedWorkerMcpServer> {
  const token = opts.token ?? randomWorkerMcpToken();
  let current = opts.store;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return rpcError(null, -32700, "parse error");
      }
      if (!isAuthorized(req, token)) {
        return rpcError(body?.id, -32001, "wrong or missing bearer token");
      }
      if (current.isClosed) {
        return rpcError(body?.id, -32000, "worker spawn ended: result store is closed");
      }
      const method = body?.method;
      const params = body?.params ?? {};
      if (method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body?.id ?? null,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: WORKER_MCP_SERVER_NAME, version: "1.0.0" },
          },
        });
      }
      if (method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body?.id ?? null, result: { tools: toolSchemas() } });
      }
      if (method === "tools/call") {
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const out = callTool(current, name, args, { prBodyFenced: opts.prBodyFenced });
        return Response.json({
          jsonrpc: "2.0",
          id: body?.id ?? null,
          result: { content: [{ type: "text", text: out.text }], isError: out.ok ? undefined : true },
        });
      }
      if (method === "ping") {
        return Response.json({ jsonrpc: "2.0", id: body?.id ?? null, result: {} });
      }
      return rpcError(body?.id, -32601, `unknown method: ${String(method)}`);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    token,
    close: () => server.stop(true),
    setStore: (store: WorkerResultStore) => {
      current = store;
    },
  };
}

/** Where a worker result came from: tool store first, file fallback for one transition period. */
export type WorkerResultSource = "tool" | "file fallback" | "missing";

/**
 * Prefer the tool value; otherwise use the file fallback. Logs which path was
 * used so the file fallback can be removed later.
 */
export function preferWorkerTool(
  name: "pr_body" | "skip" | "blocked_on" | "handoff" | "no_changes",
  toolValue: string | null | undefined,
  fileValue: string | null | undefined,
  log?: (message: string) => void
): { value: string | null; source: WorkerResultSource } {
  if (toolValue != null && toolValue !== "") {
    log?.(`worker result: ${name} from tool`);
    return { value: toolValue, source: "tool" };
  }
  if (fileValue != null && fileValue !== "") {
    log?.(`worker result: ${name} from file fallback`);
    return { value: fileValue, source: "file fallback" };
  }
  log?.(`worker result: ${name} missing`);
  return { value: null, source: "missing" };
}

/** Minimal JSON-RPC client for tests and per-runner probes. */
export async function probeWorkerMcpServer(
  url: string,
  token: string,
  tool: string,
  args: Record<string, unknown> = {},
  id = 1
): Promise<{ ok: boolean; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...workerMcpAuthHeaders(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const payload = (await res.json()) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (payload.error) return { ok: false, text: payload.error.message ?? "error" };
  const text = payload.result?.content?.[0]?.text ?? "";
  return { ok: !payload.result?.isError, text };
}

export async function probeWorkerMcpInit(url: string, token: string): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...workerMcpAuthHeaders(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (!res.ok) return false;
  const payload = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
  return payload.result?.serverInfo?.name === WORKER_MCP_SERVER_NAME;
}

/** Per-spawn harness temp root outside the checkout (holds worker MCP token configs). */
export async function makeWorkerHarnessTempRoot(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  // Fixed `/tmp` parent, never `os.tmpdir()`: the worker harness points
  // `TMPDIR` at `<checkout>/.jumi-tmp/scratch`, and `os.tmpdir()` follows
  // `TMPDIR` — using it would put the token configs back inside the checkout.
  return mkdtemp("/tmp/jumi-worker-");
}

// ── Runner MCP configs (shared shapes from `review_mcp.ts`) ────────────────

/** OpenCode MCP entry for the worker server. */
export function openCodeWorkerMcpEntry(url: string, token: string): Record<string, unknown> {
  return openCodeMcpEntry(url, token);
}

/** Claude `--mcp-config` file content for the worker server. */
export function claudeWorkerMcpConfig(url: string, token: string): string {
  return claudeMcpConfigFor(WORKER_MCP_SERVER_NAME, url, token);
}

/** Codex `config.toml` snippet for the worker server. Real TOML: parsed with `Bun.TOML.parse` in tests. */
export function codexWorkerMcpTomlEntry(url: string, token: string): string {
  return codexMcpTomlEntry(WORKER_MCP_SERVER_NAME, url, token);
}

/** Agy `mcp_config.json` server value for the worker server. */
export function agyWorkerMcpEntry(url: string, token: string): Record<string, unknown> {
  return agyMcpServerEntry(url, token);
}

/**
 * Sticky body for a clean-tree follow-up round. The reason rides the same
 * sanitiser as verdict text so `>` (and `-->`) can never break the trailer
 * shape. Fail-open: no recorded reason posts the old bare message with
 * `(no reason given)` and never fails the job.
 */
export function buildNoChangesSticky(reason: string | undefined | null): string {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) return "no follow-up changes (no reason given)";
  return `no follow-up changes: ${sanitizeCheckReason(trimmed)}`;
}
