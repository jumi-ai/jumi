/**
 * Strict offline Pi worker harness (jumi#934).
 *
 * Runs implement / follow-up / conflict intents through the real Pi SDK
 * (`createAgentSession`) in an isolated attempt, never in the privileged
 * parent. The session owns one conversation over a disposable checkout
 * (`cwd`); the parent owns commits, pushes, and PR decisions and alone
 * decides what to publish. No production provider is needed: tests drive the
 * session with a scripted loopback model.
 *
 * Boundaries (all enforced in code, never in prompt text alone):
 * - Trusted resource loader: a custom `ResourceLoader` with no discovery.
 *   No project/head, user, or global Pi settings, extensions, hooks,
 *   packages, or MCP servers load. Trusted base instructions are prompt
 *   data, not executable configuration. Executing a repo test inside the
 *   sandbox is explicitly authorized work, never permission to register an
 *   extension.
 * - Explicit transports only: the caller supplies the `ModelRuntime`/`Model`
 *   (loopback in tests). No SDK telemetry, update checks, downloads, or
 *   install-on-first-use: in-memory settings disable them and the loader
 *   does no package resolution.
 * - Role-scoped tools only: the model reaches `read`, guarded `bash`,
 *   guarded `edit`/`write`, and the `jumi_*` worker tools bound to the
 *   parent's `WorkerResultStore`. Every other built-in stays disabled, and
 *   tools are registered once per role (one session loadout per intent).
 * - Destination-constrained writes: native edit/write tools and shell
 *   redirections may touch only the worktree and explicitly job-owned
 *   scratch/build roots. Writes outside those roots, to credential/control
 *   state, or to Git administrative files (including hooks/config) are
 *   denied. Symlinks are resolved before the check. Missing enforcement
 *   fails closed. Parent-owned Git operations run outside the tool shell
 *   and keep working. The tool shell never inherits parent permissions.
 * - Shell sandbox: a probe must report Landlock available (or the deployer
 *   bypass is set) before the session starts; the guarded `bash` override
 *   denies `git push`/`commit`, scrubs the per-shell env (canaries, forge
 *   tokens, HOME secrets), bounds output/time, kills the owned process
 *   group on cancel, and rejects late results.
 * - Parent owns releases: the harness never commits, pushes, or opens a
 *   pull; it only reports the parent-observed diff. Unset harness mode
 *   keeps the existing legacy worker.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EngineFailedError } from "./engine.ts";
import { buildPiSessionEnv, createGuardedPiReadTool } from "./pi_review.ts";
import { validateFindingResponse } from "./review_findings.ts";
import {
  allowUnsandboxedReviews,
  ensureSandboxedShellHome,
  findReviewEnvViolations,
  resolveWorktreeGitDirsSync,
  reviewSandboxWrapperPath,
  reviewShellSandboxRules,
  wrapShellCommand,
} from "./review_sandbox.ts";
import {
  validateBlockedOn,
  validateHandoffNotes,
  validateNoChangesReason,
  validatePrBody,
  validatePrRemaining,
  validateSkipReason,
  type WorkerResultStore,
} from "./worker_mcp.ts";

export type PiWorkerIntent = "implement" | "follow-up" | "conflict";

export const PI_WORKER_SYSTEM_PREAMBLE =
  "You are Jumi's offline worker agent. Make the requested code change with the edit/write tools and verify it by running the repo's tests through bash. " +
  "Do not commit, push, or open pulls; the parent owns releases. Record results only through the jumi_* tools.";

const PI_WORKER_INTENT_PREAMBLE: Record<PiWorkerIntent, string> = {
  implement:
    "Intent: implement. Use jumi_skip when there is nothing to change, jumi_blocked_on when blocked, jumi_set_pr_body for the PR description, jumi_set_handoff for next-round notes.",
  "follow-up":
    "Intent: follow-up. Use jumi_no_changes when the tree stays clean, jumi_set_pr_body for the PR description, jumi_set_handoff for next-round notes, jumi_finding_response to answer blocking findings.",
  conflict:
    "Intent: conflict. Resolve the merge conflict in the worktree and record jumi_set_pr_body plus jumi_set_handoff.",
};

export const PI_WORKER_TOOLS_BY_INTENT: Record<PiWorkerIntent, readonly string[]> = {
  implement: ["jumi_skip", "jumi_blocked_on", "jumi_set_pr_body", "jumi_set_handoff"],
  "follow-up": ["jumi_no_changes", "jumi_set_pr_body", "jumi_set_handoff", "jumi_finding_response"],
  conflict: ["jumi_set_pr_body", "jumi_set_handoff"],
};

/** Role-scoped worker tool names for one intent. Registered once per attempt. */
export function piWorkerToolsForIntent(intent: PiWorkerIntent): readonly string[] {
  return [...PI_WORKER_TOOLS_BY_INTENT[intent]];
}

/** Trusted loader: no discovery of any kind. Base instructions are prompt data. */
export function createTrustedPiWorkerResourceLoader(
  baseInstructions?: string,
  intent?: PiWorkerIntent
): ResourceLoader {
  const role = intent ? `\n\n<role>${PI_WORKER_INTENT_PREAMBLE[intent]}</role>` : "";
  const systemPrompt = baseInstructions?.trim()
    ? `${PI_WORKER_SYSTEM_PREAMBLE}${role}\n\n<base_instructions>\n${baseInstructions.trim()}\n</base_instructions>`
    : `${PI_WORKER_SYSTEM_PREAMBLE}${role}`;
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** In-memory settings: no telemetry, no update checks, no packages, no retries. */
export function createPiWorkerSettings(intent: PiWorkerIntent): SettingsManager {
  return SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    enableAnalytics: false,
    enableInstallTelemetry: false,
    packages: [],
    extensions: [],
    defaultTools: ["read", "bash", "edit", "write", ...piWorkerToolsForIntent(intent)],
  } as Parameters<typeof SettingsManager.inMemory>[0]);
}

export interface PiWorkerSandboxProbe {
  available: boolean;
  reason?: string;
}

/** Fail closed when the shell sandbox is missing unless the deployer bypasses. */
export function assertPiWorkerSandboxAvailable(
  probe: PiWorkerSandboxProbe,
  env: Record<string, string | undefined> = process.env
): void {
  if (env.JUMI_ALLOW_UNSANDBOXED_REVIEWS === "1") return;
  if (probe.available) return;
  throw new EngineFailedError(
    `pi worker refused: shell sandbox unavailable (${probe.reason ?? "unknown"}). ` +
      `Set JUMI_ALLOW_UNSANDBOXED_REVIEWS=1 to run unsandboxed (not recommended).`,
    false
  );
}

export interface PiWorkerToolCallRecord {
  name: string;
  args: unknown;
  ok: boolean;
  text: string;
}

/** Output bound for every worker tool result (chars). */
export const PI_WORKER_MAX_OUTPUT_CHARS = 8000;

/** Default per-tool wall clock (ms) when the model omits `timeout`. */
export const PI_WORKER_TOOL_TIMEOUT_MS = 60_000;

/** Absolute cap for a single model-requested tool timeout (ms). */
export const PI_WORKER_TOOL_TIMEOUT_MAX_MS = 120_000;

/** Redact exact secret/canary values from tool output. Never logs values. */
export function redactWorkerOutput(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

// --- Destination-constrained writes ---

export interface PiWorkerWriteScope {
  workdir: string;
  allowedRoots: string[];
  deniedPrefixes: string[];
  gitDir: string;
  gitDirs: string[];
}

function dedupeAbsolute(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    const absolute = isAbsolute(path) ? path : resolve(path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}

/**
 * Roots a worker tool may write: the worktree plus explicitly job-owned
 * scratch/build paths needed for tests. Anything else fails closed.
 */
export function resolvePiWorkerAllowedRoots(
  workdir: string,
  scratchDir: string,
  extraWriteRoots?: readonly string[]
): string[] {
  return dedupeAbsolute([workdir, scratchDir, ...(extraWriteRoots ?? [])]);
}

/** Prefixes a worker tool must never write, even inside the worktree. */
export function resolvePiWorkerDeniedPrefixes(opts: {
  workdir: string;
  agentDir: string;
  shellHome: string;
  gitDirs?: readonly string[];
}): string[] {
  return dedupeAbsolute([opts.agentDir, opts.shellHome, join(opts.workdir, ".git"), ...(opts.gitDirs ?? [])]);
}

function insideAny(candidate: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
}

/**
 * Lexical destination check: inside an allowed root and outside every
 * denied prefix and outside the worktree `.git` admin dir.
 */
export function isWorkerWriteDeniedLexical(resolved: string, scope: PiWorkerWriteScope): boolean {
  if (insideAny(resolved, scope.deniedPrefixes)) return true;
  if (resolved === scope.gitDir || resolved.startsWith(`${scope.gitDir}/`)) return true;
  if (!insideAny(resolved, scope.allowedRoots)) return true;
  return false;
}

/**
 * Full destination check with symlink confinement. The checkout is
 * head-supplied, so a link inside it can point outside: the real path must
 * satisfy the same allow/deny rule. Unresolvable paths fail closed when
 * `failClosed` is set (writes), while reads use the lexical decision.
 */
export async function isWorkerWriteDenied(
  resolved: string,
  scope: PiWorkerWriteScope,
  opts: { failClosed?: boolean } = {}
): Promise<boolean> {
  if (isWorkerWriteDeniedLexical(resolved, scope)) return true;
  try {
    const effective = await realpath(resolved);
    if (isWorkerWriteDeniedLexical(effective, scope)) return true;
    return false;
  } catch {
    // Missing file: check the nearest existing parent so `write` of a new
    // file through a symlinked dir cannot escape. Failure to resolve the
    // parent fails closed for writes.
    try {
      let cur = dirname(resolved);
      for (let i = 0; i < 64; i++) {
        try {
          const parentReal = await realpath(cur);
          const rel = resolved.slice(cur.length).replace(/^\/+/, "");
          const effective = rel ? join(parentReal, rel) : parentReal;
          return isWorkerWriteDeniedLexical(effective, scope);
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (code !== "ENOENT" && code !== "ENOTDIR") return opts.failClosed !== false;
          if (cur === dirname(cur)) return opts.failClosed !== false;
          cur = dirname(cur);
        }
      }
      return true;
    } catch {
      return true;
    }
  }
}

export function buildPiWorkerScope(opts: {
  workdir: string;
  scratchDir: string;
  agentDir: string;
  shellHome: string;
  extraWriteRoots?: readonly string[];
  gitDirs?: readonly string[];
}): PiWorkerWriteScope {
  const workdir = resolve(opts.workdir);
  const gitDir = join(workdir, ".git");
  return {
    workdir,
    allowedRoots: resolvePiWorkerAllowedRoots(workdir, opts.scratchDir, opts.extraWriteRoots),
    deniedPrefixes: resolvePiWorkerDeniedPrefixes({
      workdir,
      agentDir: opts.agentDir,
      shellHome: opts.shellHome,
      gitDirs: opts.gitDirs,
    }),
    gitDir,
    gitDirs: [...(opts.gitDirs ?? [])],
  };
}

// --- Guarded edit/write tools ---

function workerToolError(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: true;
} {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}

function workerToolOk(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return { content: [{ type: "text", text }], details: {} };
}

/** Guarded `edit`: exact-match file edits constrained by destination. */
export function createGuardedPiWorkerEditTool(opts: {
  scope: PiWorkerWriteScope;
  secrets?: readonly (string | undefined)[];
  onCall?: (path: string, denied: boolean) => void;
}): {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    toolCallId: string,
    params: { path: string; edits: Array<{ oldText: string; newText: string }> },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }>;
} {
  return {
    name: "edit",
    label: "Edit",
    description: "Make precise file edits inside the worker checkout",
    parameters: Type.Object({
      path: Type.String(),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
    }),
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        opts.onCall?.(String((params as { path?: unknown }).path ?? ""), true);
        return workerToolError("cancelled");
      }
      const raw = String((params as { path?: unknown }).path ?? "");
      if (!raw.trim()) {
        opts.onCall?.(raw, true);
        return workerToolError("denied: pi worker edit denies empty path");
      }
      const resolved = resolve(opts.scope.workdir, raw);
      if (await isWorkerWriteDenied(resolved, opts.scope, { failClosed: true })) {
        opts.onCall?.(raw, true);
        return workerToolError(`denied: pi worker edit denies: ${raw.slice(0, 120)}`);
      }
      const edits = (params as { edits?: unknown }).edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        opts.onCall?.(raw, true);
        return workerToolError("denied: pi worker edit needs at least one edit");
      }
      opts.onCall?.(raw, false);
      let content: string;
      try {
        content = await readFile(resolved, "utf8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return workerToolError(`edit failed: ${message}`);
      }
      let next = content;
      for (const entry of edits) {
        if (signal?.aborted) return workerToolError("cancelled");
        const oldText = String((entry as { oldText?: unknown }).oldText ?? "");
        const newText = String((entry as { newText?: unknown }).newText ?? "");
        if (!oldText) return workerToolError("edit failed: oldText is required");
        const occurrences = next.split(oldText).length - 1;
        if (occurrences !== 1) {
          return workerToolError(`edit failed: oldText must match exactly once (matched ${occurrences})`);
        }
        next = next.replace(oldText, newText);
      }
      if (signal?.aborted) return workerToolError("cancelled");
      try {
        await writeFile(resolved, next, "utf8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return workerToolError(`edit failed: ${message}`);
      }
      return workerToolOk(redactWorkerOutput(`edited ${raw.slice(0, 120)}`, opts.secrets ?? []).slice(0, 8000));
    },
  };
}

/** Guarded `write`: create or overwrite files constrained by destination. */
export function createGuardedPiWorkerWriteTool(opts: {
  scope: PiWorkerWriteScope;
  secrets?: readonly (string | undefined)[];
  onCall?: (path: string, denied: boolean) => void;
}): {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    toolCallId: string,
    params: { path: string; content: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }>;
} {
  return {
    name: "write",
    label: "Write",
    description: "Create or overwrite files inside the worker checkout",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        opts.onCall?.(String((params as { path?: unknown }).path ?? ""), true);
        return workerToolError("cancelled");
      }
      const raw = String((params as { path?: unknown }).path ?? "");
      if (!raw.trim()) {
        opts.onCall?.(raw, true);
        return workerToolError("denied: pi worker write denies empty path");
      }
      const resolved = resolve(opts.scope.workdir, raw);
      if (await isWorkerWriteDenied(resolved, opts.scope, { failClosed: true })) {
        opts.onCall?.(raw, true);
        return workerToolError(`denied: pi worker write denies: ${raw.slice(0, 120)}`);
      }
      const content = String((params as { content?: unknown }).content ?? "");
      opts.onCall?.(raw, false);
      if (signal?.aborted) return workerToolError("cancelled");
      try {
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, content, "utf8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return workerToolError(`write failed: ${message}`);
      }
      return workerToolOk(redactWorkerOutput(`wrote ${raw.slice(0, 120)}`, opts.secrets ?? []).slice(0, 8000));
    },
  };
}

// --- Guarded bash with destination guard, owned group, bound output/time ---

const PI_WORKER_GIT_WRITE_SUBCOMMANDS = new Set(["push", "commit", "fetch", "pull", "clone", "ls-remote"]);
const PI_WORKER_NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "lftp",
  "rsync",
  "nc",
  "ncat",
  "socat",
  "telnet",
  "aria2c",
  "axel",
  "dig",
  "nslookup",
]);
const PI_WORKER_NETWORK_SCRIPT_RE = /urllib|requests|http\.client|socket|fetch\(|axios|XMLHttpRequest/i;
const PI_WORKER_SUBSTITUTION_RE = /\$\(|`|<\([^)]*\)/;

interface PiWorkerShellWord {
  text: string;
  quoted: boolean;
}

/** Split a shell command into words, tracking quoting so `"git push"` stays data. */
function piWorkerShellWords(command: string): PiWorkerShellWord[] {
  const out: PiWorkerShellWord[] = [];
  let current = "";
  let currentQuoted = false;
  let quote: "'" | '"' | null = null;
  const flush = () => {
    if (current) {
      out.push({ text: current, quoted: currentQuoted });
      current = "";
      currentQuoted = false;
    }
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < command.length) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      currentQuoted = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[++i];
      continue;
    }
    if (
      ch === " " ||
      ch === "\t" ||
      ch === "\n" ||
      ch === ";" ||
      ch === "&" ||
      ch === "|" ||
      ch === "(" ||
      ch === ")"
    ) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return out;
}

function piWorkerBasename(word: string): string {
  const base = word.split("/").pop() ?? word;
  return base.toLowerCase();
}

/** Deny `git` write/network subcommands, skipping global flags (`-c k=v`, `-C dir`, `--no-pager`). */
function piWorkerGitWriteDenied(command: string): boolean {
  const words = piWorkerShellWords(command);
  for (let i = 0; i < words.length; i++) {
    if (words[i].quoted) continue;
    if (piWorkerBasename(words[i].text) !== "git") continue;
    let j = i + 1;
    while (j < words.length) {
      if (words[j].quoted) break;
      const flag = words[j].text;
      if (!flag.startsWith("-") || flag === "-") break;
      // `-c <k=v>` and `-C <path>` consume the next word.
      if ((flag === "-c" || flag === "-C") && j + 1 < words.length) j += 2;
      else j += 1;
    }
    if (j >= words.length || words[j].quoted) continue;
    if (PI_WORKER_GIT_WRITE_SUBCOMMANDS.has(words[j].text.toLowerCase())) return true;
  }
  return false;
}

/** Split a command on unquoted shell operators so quoted `;`/`|` stay data. */
function piWorkerSplitSegments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === "\\" && i + 1 < command.length) current += command[++i];
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")" || ch === "\n") {
      out.push(current);
      current = "";
      // Skip the second char of `&&`/`||`.
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Deny shell network exfil verbs (`curl`, `wget`, `ssh`, ..., `/dev/tcp/`, scripted urllib). */
function piWorkerNetworkDenied(command: string): boolean {
  if (/\/dev\/tcp\//.test(command)) return true;
  const segments = piWorkerSplitSegments(command);
  for (const segment of segments) {
    const words = piWorkerShellWords(segment.trim()).filter((word) => word.text.length > 0);
    if (words.length === 0) continue;
    const first = words.find((word) => word.text.length > 0) ?? words[0];
    if (!first.quoted && PI_WORKER_NETWORK_COMMANDS.has(piWorkerBasename(first.text))) return true;
    for (const word of words) {
      if (word.quoted) continue;
      const base = piWorkerBasename(word.text);
      if (
        base === "python" ||
        base.startsWith("python") ||
        base === "perl" ||
        base === "ruby" ||
        base === "node" ||
        base === "bun" ||
        base === "php"
      ) {
        // The program text is data even when quoted (`-c "import urllib..."`),
        // so scan quoted words too: they are code for the interpreter.
        const rest = words.map((other) => other.text).join(" ");
        if (PI_WORKER_NETWORK_SCRIPT_RE.test(rest)) return true;
      }
    }
  }
  return false;
}

function piWorkerBashDenied(command: string): boolean {
  if (PI_WORKER_SUBSTITUTION_RE.test(command)) return true;
  if (piWorkerGitWriteDenied(command)) return true;
  if (piWorkerNetworkDenied(command)) return true;
  return false;
}

// Matches `>file`, `>>file`, `2>file`, `2>>file`, and `&>file`: an optional
// fd/`&` prefix before the operator. Bare fd dupes (`>&2`, `2>&1`) carry no
// path target and are filtered below.
const REDIRECT_TARGET_RE = /(?:\d*|&)?(>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&<>"']+))/g;
const TEE_TARGET_RE = /\|\s*tee\s+(?:-[a-z]+\s+)*"?([^"\s;|&<>]+)"?/gi;

function extractWorkerBashTargets(command: string): string[] {
  const out: string[] = [];
  REDIRECT_TARGET_RE.lastIndex = 0;
  for (const match of command.matchAll(REDIRECT_TARGET_RE)) {
    const target = match[2] ?? match[3] ?? match[4];
    // `/dev/null` and bare fd dupes (`>&2`, `2>`) are not filesystem writes.
    if (!target || target === "/dev/null" || /^\d+$/.test(target) || target.startsWith("&")) continue;
    out.push(target);
  }
  TEE_TARGET_RE.lastIndex = 0;
  for (const match of command.matchAll(TEE_TARGET_RE)) {
    const target = match[1];
    if (!target || target === "/dev/null") continue;
    out.push(target);
  }
  return out;
}

/** Guarded `bash`: test runs allowed, writes constrained by destination. */
export function createGuardedPiWorkerBashTool(opts: {
  cwd: string;
  scope: PiWorkerWriteScope;
  env: Record<string, string>;
  secrets?: readonly (string | undefined)[];
  toolTimeoutMs?: number;
  onCall?: (command: string, denied: boolean) => void;
  sandbox?: { scratchDir: string; gitDirs?: readonly string[]; wrapperPath?: string };
}): {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }>;
} {
  return {
    name: "bash",
    label: "Bash",
    description: "Execute shell commands in the worker checkout; repo tests may run",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    execute: async (_toolCallId, params, signal) => {
      const command = String((params as { command?: unknown }).command ?? "");
      if (!command.trim()) {
        opts.onCall?.(command, true);
        return workerToolError("empty command denied");
      }
      if (piWorkerBashDenied(command)) {
        opts.onCall?.(command, true);
        return workerToolError(`denied: pi worker shell denies: ${command.slice(0, 120)}`);
      }
      // Destination guard for explicit redirections/tee targets. Commands
      // without explicit outside writes (repo tests writing artifacts under
      // the worktree) pass through to the Landlock domain for confinement.
      const targets = extractWorkerBashTargets(command);
      for (const target of targets) {
        if (signal?.aborted) {
          opts.onCall?.(command, true);
          return workerToolError("cancelled");
        }
        const resolved = resolve(opts.cwd, target);
        if (await isWorkerWriteDenied(resolved, opts.scope, { failClosed: true })) {
          opts.onCall?.(command, true);
          return workerToolError(`denied: pi worker shell denies write: ${target.slice(0, 120)}`);
        }
      }
      opts.onCall?.(command, false);
      let spawnCommand = command;
      if (opts.sandbox) {
        const base = reviewShellSandboxRules({
          workdir: opts.cwd,
          scratchDir: opts.sandbox.scratchDir,
          gitDirs: [...(opts.sandbox.gitDirs ?? [])],
        });
        const extra = (opts.scope.allowedRoots ?? []).filter(
          (root) => !base.readWrite.includes(root) && root !== opts.cwd && root !== opts.sandbox?.scratchDir
        );
        const rules = { ...base, readWrite: [...base.readWrite, ...extra] };
        spawnCommand = wrapShellCommand(command, rules, {
          wrapperPath: opts.sandbox.wrapperPath ?? reviewSandboxWrapperPath(),
          scratchDir: opts.sandbox.scratchDir,
        });
      }
      const requested = (params as { timeout?: unknown }).timeout;
      const capped =
        typeof requested === "number" && Number.isFinite(requested) && requested > 0
          ? Math.min(Math.trunc(requested), PI_WORKER_TOOL_TIMEOUT_MAX_MS)
          : (opts.toolTimeoutMs ?? PI_WORKER_TOOL_TIMEOUT_MS);
      if (signal?.aborted) return workerToolError("cancelled");
      // Owned process group: `setsid` puts the shell in its own session so
      // abort kills descendants too. Late completions after abort are
      // rejected as cancelled instead of reported as success.
      const useSetsid = await hasSetsidOnPath(opts.env.PATH);
      const argv = useSetsid ? ["setsid", "sh", "-c", spawnCommand] : ["sh", "-c", spawnCommand];
      const proc = Bun.spawn(argv, {
        cwd: opts.cwd,
        env: opts.env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      const pgid = proc.pid;
      let settled = false;
      let timedOut = false;
      let callerAborted = false;
      const onAbort = () => {
        callerAborted = true;
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (useSetsid) process.kill(-pgid, "SIGTERM");
          else proc.kill("SIGTERM");
        } catch {}
      }, capped);
      const readers = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      try {
        const abortWait =
          signal == null
            ? new Promise<never>(() => undefined)
            : new Promise<never>((_, reject) => {
                if (signal.aborted) {
                  callerAborted = true;
                  reject(abortError());
                  return;
                }
                signal.addEventListener("abort", () => reject(abortError()), { once: true });
              });
        // Suppress unhandled rejection when the abort path wins the race.
        abortWait.catch(() => undefined);
        const result = await Promise.race([readers, abortWait]).catch((err) => {
          throw err;
        });
        if (callerAborted || signal?.aborted) throw abortError();
        if (timedOut) {
          return workerToolError(`pi worker shell timed out after ${capped}ms`);
        }
        const [stdout, stderr, exitCode] = result as [string, string, number];
        settled = true;
        const output = redactWorkerOutput(
          [stdout, stderr].filter(Boolean).join("\n").slice(0, PI_WORKER_MAX_OUTPUT_CHARS),
          opts.secrets ?? []
        );
        if (exitCode !== 0) {
          return { content: [{ type: "text", text: output || `exit ${exitCode}` }], details: {}, isError: true };
        }
        return workerToolOk(output || "(no output)");
      } catch (err) {
        // Cancellation cleans up the owned group: SIGTERM, grace, SIGKILL,
        // then reject the late result as cancelled.
        try {
          if (useSetsid) process.kill(-pgid, "SIGTERM");
          else proc.kill("SIGTERM");
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200)).catch(() => undefined);
        try {
          if (useSetsid && isGroupAlive(pgid)) process.kill(-pgid, "SIGKILL");
        } catch {}
        await proc.exited.catch(() => undefined);
        settled = true;
        void settled;
        const message = err instanceof Error ? err.message : String(err);
        if (callerAborted || signal?.aborted || timedOut || message === "cancelled") {
          return workerToolError(
            timedOut && !callerAborted ? `pi worker shell timed out after ${capped}ms` : "cancelled"
          );
        }
        return workerToolError(`pi worker shell failed: ${message}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function abortError(): Error {
  const err = new Error("cancelled");
  err.name = "AbortError";
  return err;
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

async function hasSetsidOnPath(pathValue: string | undefined): Promise<boolean> {
  const { access, constants } = await import("node:fs");
  const dirs = (pathValue ?? process.env.PATH ?? "").split(":");
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      await new Promise<void>((resolvePromise, reject) => {
        access(join(dir, "setsid"), constants.X_OK, (err) => (err ? reject(err) : resolvePromise()));
      });
      return true;
    } catch {}
  }
  return false;
}

// --- Role-scoped Jumi worker tools bound to the parent's store ---

export function createPiWorkerCustomTools(
  store: WorkerResultStore,
  intent: PiWorkerIntent,
  onCall?: (record: PiWorkerToolCallRecord) => void
  // Typed as unknown records: the Pi SDK `ToolDefinition` generics vary by
  // schema, and the harness passes these straight into `customTools`.
): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  const push = (tool: Record<string, unknown>) => {
    tools.push(tool);
  };
  if (intent === "follow-up") {
    push({
      name: "jumi_no_changes",
      label: "No changes",
      description: "Record why this follow-up round leaves the tree unchanged (1-3 sentences).",
      parameters: Type.Object({ reason: Type.String() }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const result = store.setNoChanges({ reason: params.reason });
        const text = result.ok ? JSON.stringify({ recorded: true }) : result.error;
        onCall?.({ name: "jumi_no_changes", args: params, ok: result.ok, text });
        return result.ok ? workerToolOk(text) : workerToolError(text);
      },
    });
  }
  if (intent === "implement") {
    push({
      name: "jumi_skip",
      label: "Skip",
      description: "Record that this implement round has nothing to change, with the reason.",
      parameters: Type.Object({ reason: Type.String() }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const result = store.setSkip({ reason: params.reason });
        const text = result.ok ? JSON.stringify({ recorded: true }) : result.error;
        onCall?.({ name: "jumi_skip", args: params, ok: result.ok, text });
        return result.ok ? workerToolOk(text) : workerToolError(text);
      },
    });
    push({
      name: "jumi_blocked_on",
      label: "Blocked on",
      description: "Record that this implement round is blocked on another issue: ref plus reason.",
      parameters: Type.Object({ ref: Type.String(), reason: Type.String() }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const result = store.setBlockedOn({ ref: params.ref, reason: params.reason });
        const text = result.ok ? JSON.stringify({ recorded: true }) : result.error;
        onCall?.({ name: "jumi_blocked_on", args: params, ok: result.ok, text });
        return result.ok ? workerToolOk(text) : workerToolError(text);
      },
    });
  }
  push({
    name: "jumi_set_pr_body",
    label: "Set PR body",
    description: "Record the pull-request description markdown.",
    parameters: Type.Object({ markdown: Type.String(), remaining: Type.Optional(Type.Array(Type.String())) }),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = store.setPrBody({ markdown: params.markdown, remaining: params.remaining });
      const text = result.ok ? JSON.stringify({ recorded: true }) : result.error;
      onCall?.({ name: "jumi_set_pr_body", args: params, ok: result.ok, text });
      return result.ok ? workerToolOk(text) : workerToolError(text);
    },
  });
  push({
    name: "jumi_set_handoff",
    label: "Set handoff",
    description: "Record notes for the next round (never secrets).",
    parameters: Type.Object({ notes: Type.String() }),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const validated = validateHandoffNotes(params.notes);
      const result = validated.ok ? store.setHandoff({ notes: validated.notes }) : validated;
      const text = result.ok ? JSON.stringify({ recorded: true }) : (result as { error: string }).error;
      onCall?.({ name: "jumi_set_handoff", args: params, ok: result.ok, text });
      return result.ok ? workerToolOk(text) : workerToolError(text);
    },
  });
  if (intent === "follow-up") {
    push({
      name: "jumi_finding_response",
      label: "Finding response",
      description: "Answer one blocking finding: fixed, unchanged, or needs_maintainer.",
      parameters: Type.Object({
        finding: Type.String(),
        status: Type.String(),
        reason: Type.Optional(Type.String()),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const result = store.setFindingResponse({
          finding: params.finding,
          status: params.status,
          reason: params.reason,
        });
        const text = result.ok ? JSON.stringify({ recorded: true }) : result.error;
        onCall?.({ name: "jumi_finding_response", args: params, ok: result.ok, text });
        return result.ok ? workerToolOk(text) : workerToolError(text);
      },
    });
  }
  // Validate imports stay live: every worker tool shape reuses the
  // parent-owned validators, never a divergent copy.
  void validateBlockedOn;
  void validateNoChangesReason;
  void validatePrBody;
  void validatePrRemaining;
  void validateSkipReason;
  void validateFindingResponse;
  return tools;
}

export interface PiWorkerAttemptOptions {
  /** Disposable checkout the session runs in; never the privileged parent cwd. */
  workdir: string;
  /** Trusted base-branch instructions as prompt data (never executable config). */
  baseInstructions?: string;
  /** Worker intent: implement, follow-up, or conflict. */
  intent: PiWorkerIntent;
  /** User prompt for this attempt. */
  prompt: string;
  /** Parent-owned worker result store; the harness writes it, the parent publishes it. */
  store: WorkerResultStore;
  /** Explicitly selected inference transport (loopback in tests). */
  modelRuntime: unknown;
  model: unknown;
  /** Isolated agent dir; defaults to a fresh tmpdir (never ~/.pi). */
  agentDir?: string;
  /** Hosts the attempt may contact over HTTP (loopback only in tests). Empty means none. */
  allowedFetchHosts?: readonly string[];
  /** Scrubbed shell env (HOME/scratch/git proxy). Secrets are never added. */
  shellEnv?: Record<string, string>;
  /** Extra env merged into the shell env after scrubbing (violations dropped). */
  extraEnv?: Record<string, string | undefined>;
  /** Git proxy host for per-shell `GIT_AUTH_HOST` (no token). */
  gitHost?: string;
  /** Extra job-owned write roots outside the worktree (scratch/build dirs). */
  extraWriteRoots?: readonly string[];
  /** Values to redact from tool output (canaries, tokens). */
  redactSecrets?: readonly (string | undefined)[];
  sandboxProbe?: PiWorkerSandboxProbe;
  abortSignal?: AbortSignal;
  logger?: (message: string) => void;
  timeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface PiWorkerAttemptResult {
  status: "complete" | "incomplete";
  reason?: string;
  destinations: string[];
  toolCalls: PiWorkerToolCallRecord[];
  /** Parent-observed `git diff` after the attempt (never written by the model). */
  diff: string;
  dirty: boolean;
}

async function parentGitDiff(workdir: string): Promise<{ diff: string; dirty: boolean }> {
  try {
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: workdir });
    const lines = String(status.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      // Harness scratch is parent-owned, never part of the patch.
      .filter((line) => {
        const path = line.length >= 4 ? line.slice(3).trim().replace(/^"|"$/g, "") : line;
        return path !== ".jumi-tmp" && !path.startsWith(".jumi-tmp/");
      });
    if (lines.length === 0) return { diff: "", dirty: false };
    const proc = Bun.spawnSync(["git", "diff", "--", ".", ":!.jumi-tmp"], { cwd: workdir });
    const diff = String(proc.stdout ?? "").slice(0, PI_WORKER_MAX_OUTPUT_CHARS);
    return { diff, dirty: true };
  } catch {
    return { diff: "", dirty: false };
  }
}

/**
 * Run one isolated worker attempt through the real Pi SDK session. The
 * session runs with `cwd` = the disposable checkout and an isolated agent
 * dir; the privileged parent never executes model tools itself. The parent
 * observes the diff with its own Git operations after the session ends.
 */
export async function runPiWorkerAttempt(opts: PiWorkerAttemptOptions): Promise<PiWorkerAttemptResult> {
  const log = opts.logger ?? (() => undefined);
  if (!opts.workdir || opts.workdir === process.cwd()) {
    throw new EngineFailedError("pi worker refused: workdir must be a disposable checkout, not the parent cwd", false);
  }
  assertPiWorkerSandboxAvailable(opts.sandboxProbe ?? { available: true });
  const shellHome = join(opts.workdir, ".jumi-tmp", "pi-shell-home");
  const scratchDir = join(opts.workdir, ".jumi-tmp", "scratch");
  try {
    await mkdir(scratchDir, { recursive: true });
    await mkdir(shellHome, { recursive: true });
    await ensureSandboxedShellHome(scratchDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EngineFailedError(`pi worker refused: cannot create shell scratch dirs: ${message}`, false);
  }
  const sessionEnv =
    opts.shellEnv ??
    buildPiSessionEnv({
      home: shellHome,
      scratchDir,
      gitHost: opts.gitHost,
      extra: opts.extraEnv,
    });
  const violations = findReviewEnvViolations(sessionEnv);
  if (violations.length > 0) {
    throw new EngineFailedError(
      `pi worker refused: session env carries forbidden keys: ${violations.join(", ")}`,
      false
    );
  }

  const agentDir = opts.agentDir ?? (await mkdtemp(join(tmpdir(), "jumi-pi-worker-")));
  const ownAgentDir = opts.agentDir === undefined;
  const scope = buildPiWorkerScope({
    workdir: opts.workdir,
    scratchDir,
    agentDir,
    shellHome,
    extraWriteRoots: opts.extraWriteRoots,
    gitDirs: resolveWorktreeGitDirsSync(opts.workdir),
  });
  // Missing enforcement fails closed: an empty allow-list never authorizes.
  if (scope.allowedRoots.length === 0) {
    throw new EngineFailedError("pi worker refused: no allowed write roots", false);
  }

  const destinations: string[] = [];
  const allowed = new Set((opts.allowedFetchHosts ?? []).map((host) => host.toLowerCase()));
  const realFetch = globalThis.fetch;
  const spy = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    try {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
      );
      destinations.push(`${url.protocol}//${url.host}${url.pathname}`);
    } catch {
      destinations.push(String(typeof input === "string" ? input : ((input as Request)?.url ?? input)));
    }
    return realFetch(input as never, init as never);
  };
  globalThis.fetch = spy as typeof fetch;

  const toolCalls: PiWorkerToolCallRecord[] = [];
  const guardedRead = createGuardedPiReadTool({
    cwd: opts.workdir,
    deniedPrefixes: [agentDir, shellHome],
    onCall: (path, denied) => {
      toolCalls.push({ name: "read", args: { path }, ok: !denied, text: denied ? "denied" : "ran" });
    },
  });
  const sandboxed = !allowUnsandboxedReviews();
  const guardedBash = createGuardedPiWorkerBashTool({
    cwd: opts.workdir,
    scope,
    env: sessionEnv,
    secrets: opts.redactSecrets,
    toolTimeoutMs: opts.toolTimeoutMs,
    onCall: (command, denied) => {
      toolCalls.push({ name: "bash", args: { command }, ok: !denied, text: denied ? "denied" : "ran" });
    },
    ...(sandboxed
      ? {
          sandbox: {
            scratchDir,
            gitDirs: resolveWorktreeGitDirsSync(opts.workdir),
            wrapperPath: reviewSandboxWrapperPath(),
          },
        }
      : {}),
  });
  const guardedEdit = createGuardedPiWorkerEditTool({
    scope,
    secrets: opts.redactSecrets,
    onCall: (path, denied) => {
      toolCalls.push({ name: "edit", args: { path }, ok: !denied, text: denied ? "denied" : "ran" });
    },
  });
  const guardedWrite = createGuardedPiWorkerWriteTool({
    scope,
    secrets: opts.redactSecrets,
    onCall: (path, denied) => {
      toolCalls.push({ name: "write", args: { path }, ok: !denied, text: denied ? "denied" : "ran" });
    },
  });

  const resourceLoader = createTrustedPiWorkerResourceLoader(opts.baseInstructions, opts.intent);
  await resourceLoader.reload();
  const settingsManager = createPiWorkerSettings(opts.intent);
  const sessionManager = SessionManager.inMemory(opts.workdir);

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const roleTools = piWorkerToolsForIntent(opts.intent);
    const created = await createAgentSession({
      cwd: opts.workdir,
      agentDir,
      model: opts.model as never,
      modelRuntime: opts.modelRuntime as never,
      resourceLoader,
      tools: ["read", "bash", "edit", "write", ...roleTools],
      customTools: [
        ...createPiWorkerCustomTools(opts.store, opts.intent, (record) => toolCalls.push(record)),
        guardedBash,
        guardedRead,
        guardedEdit,
        guardedWrite,
      ] as never[],
      sessionManager,
      settingsManager,
    });
    session = created.session;
    const running = created.session;
    const active = new Set(session.getActiveToolNames());
    for (const required of ["read", "bash", "edit", "write", ...roleTools]) {
      if (!active.has(required)) {
        throw new EngineFailedError(`pi worker refused: required tool not active: ${required}`, false);
      }
    }
    // Role separation: only the intent's worker tools are active, registered once.
    const allWorkerTools = new Set(Object.values(PI_WORKER_TOOLS_BY_INTENT).flat());
    for (const other of allWorkerTools) {
      if (!roleTools.includes(other) && active.has(other)) {
        throw new EngineFailedError(`pi worker refused: out-of-role tool active: ${other}`, false);
      }
    }
    // Search tools stay disabled; every other built-in beyond the loadout fails.
    for (const extra of ["grep", "find", "ls", "powershell"]) {
      if (active.has(extra)) {
        throw new EngineFailedError(`pi worker refused: search tool must stay disabled: ${extra}`, false);
      }
    }

    const timeoutMs = opts.timeoutMs ?? 120_000;
    let timedOut = false;
    let callerAborted = opts.abortSignal?.aborted ?? false;
    const timer = setTimeout(() => {
      timedOut = true;
      void running.abort().catch(() => undefined);
    }, timeoutMs);
    const onAbort = () => {
      callerAborted = true;
      void running.abort().catch(() => undefined);
    };
    if (!callerAborted) {
      opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    } else {
      void running.abort().catch(() => undefined);
    }
    try {
      if (!callerAborted) {
        await running.prompt(opts.prompt);
      }
    } finally {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }
    if (callerAborted) {
      const observed = await parentGitDiff(opts.workdir);
      return {
        status: "incomplete",
        reason: "Incomplete worker: aborted",
        destinations,
        toolCalls,
        diff: observed.diff,
        dirty: observed.dirty,
      };
    }
    if (timedOut) {
      const observed = await parentGitDiff(opts.workdir);
      return {
        status: "incomplete",
        reason: "Incomplete worker: timed out",
        destinations,
        toolCalls,
        diff: observed.diff,
        dirty: observed.dirty,
      };
    }

    const ambient = destinations.filter((destination) => {
      try {
        const host = new URL(destination).hostname.toLowerCase();
        return !allowed.has(host);
      } catch {
        return true;
      }
    });
    if (ambient.length > 0) {
      const observed = await parentGitDiff(opts.workdir);
      return {
        status: "incomplete",
        reason: `Incomplete worker: ambient network destinations observed: ${[...new Set(ambient)].join(", ")}`,
        destinations,
        toolCalls,
        diff: observed.diff,
        dirty: observed.dirty,
      };
    }

    const observed = await parentGitDiff(opts.workdir);
    if (opts.intent === "follow-up" && opts.store.getNoChangesReason() && !observed.dirty) {
      return { status: "complete", destinations, toolCalls, diff: observed.diff, dirty: observed.dirty };
    }
    if (opts.intent === "implement" && (opts.store.getSkipReason() || opts.store.getBlockedOn())) {
      return { status: "complete", destinations, toolCalls, diff: observed.diff, dirty: observed.dirty };
    }
    if (observed.dirty) {
      return { status: "complete", destinations, toolCalls, diff: observed.diff, dirty: observed.dirty };
    }
    return {
      status: "incomplete",
      reason: "Incomplete worker: no changes and no skip/no-changes",
      destinations,
      toolCalls,
      diff: observed.diff,
      dirty: observed.dirty,
    };
  } catch (err) {
    if (err instanceof EngineFailedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "incomplete",
      reason: `Incomplete worker: ${message}`,
      destinations,
      toolCalls,
      diff: "",
      dirty: false,
    };
  } finally {
    globalThis.fetch = realFetch;
    try {
      session?.dispose();
    } catch {}
    if (ownAgentDir) {
      await rm(agentDir, { recursive: true, force: true }).catch(() => undefined);
      void log;
    }
  }
}
