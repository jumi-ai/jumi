import { existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { looksLikeProviderAuthDeath, providerAuthDeathMessage } from "./auth.ts";
import {
  type ChildGitProxy,
  childProxyGitConfigEnv,
  childProxyRequestFrom,
  extraEnvHasGitToken,
  isChildStrippedKey,
  startChildGitProxy,
} from "./child_git_proxy.ts";
import { observeEngineRun } from "./control_metrics.ts";
import {
  byteLength,
  finalizeMemoryTracker,
  formatBytes,
  logDiagnostic,
  type MemoryPeakState,
  type MemorySample,
  pathSizeBytes,
  sampleMemory,
  trackMemoryPeak,
} from "./diagnostics.ts";
import {
  type Engine,
  EngineFailedError,
  type EngineResult,
  type EngineRunOptions,
  redactEngineText,
} from "./engine.ts";
import { ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { forgeDenyHost, forgeOpenCodeConfigContent, forgeOpenCodePermission } from "./forge_webfetch.ts";
import { classifyOpenCodeInfra, looksLikeInfraStderr } from "./infra.ts";
import { exportOpenCodeTrace } from "./phoenix.ts";
import {
  inspectQuotaHit,
  inspectQuotaInLogDir,
  QUOTA_MESSAGE,
  QUOTA_POLL_INTERVAL_MS,
  type QuotaHit,
} from "./quota.ts";
import { recordOpenCodeDb } from "./token_metrics.ts";
import { childAuthFile, ensureXaiCredentialForJob, isXaiModel, type XaiChildCredential } from "./xai_auth.ts";

const OPENCODE_STDERR_MAX_BYTES = 64_000;

/** Strip ANSI/VT100 CSI escape sequences from a string. */
function stripAnsi(str: string): string {
  // Matches all CSI sequences: ESC [ ... <letter>
  return str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g"), "");
}

/**
 * OpenCode Engine impl #0: run to completion in `opts.workdir`.
 * Stdout is logs (ANSI stripped), not the deliverable. Timeout and non-zero
 * exit are returned for the parent to fail closed. Abort still throws.
 *
 * Argv/stdin/`OPENCODE_CONFIG` stay inside this impl. The kernel Engine port is
 * the workspace: the parent writes task/feedback files and reads artifacts.
 * When `prompt` is omitted, stdin is synthesized from those files / `trace.kind`.
 */
export interface OpenCodeRunOptions extends EngineRunOptions {
  configPath?: string;
}

const WORKER_SCOPE = `Stay in this clone. Start from the parent-injected JUMI_*.md files; do not glob **/* or inventory the repo first.
Do not webfetch this Gitea host, its issues, PRs, /api, swagger, or Actions. Do not call tea or the forge API. The parent already wrote the task, feedback, conflict, and CI. Public upstream docs are fine.
Grep is ripgrep syntax, not JavaScript.
Ignore .jumi-tmp, including opencode-prompt-*/prompt.txt. The only Jumi files to read are JUMI_TASK.md, JUMI_QUEUE.md, JUMI_FEEDBACK.md, JUMI_CONFLICT.md, JUMI_CI.md, JUMI_PR.md, and JUMI_ATTACHMENTS.md at the repository root.
When JUMI_ATTACHMENTS.md exists, its staged inputs live under .jumi-attachments/ (ignored, never committed); copy a file out explicitly if the task needs to vendor it.
Verify once at the end, not after every edit.`;

const WORKER_COMMIT = `Commit at each coherent logical step with a descriptive message that says what the step does; a small task can be a single commit. No \`wip\` / \`fix lint\` / \`oops\` commits. Do not commit a broken intermediate state just to save progress.
Do not push. The parent pushes once after this run exits.
Do not force-push. Do not amend or rebase commits already on the remote branch. Do not commit JUMI_*.md sentinels.`;

const IMPLEMENT_FINISH = `Edit, write, and commit as needed.
${WORKER_COMMIT}
Do not ask questions.
If there is nothing to change, write JUMI_SKIP.md at the repository root with a short reason. Do not commit JUMI_SKIP.md.
When the task is complete, write JUMI_PR.md at the repository root with a short pull-request description: what changed, why, and what you ran to verify. Do not paste JUMI_TASK.md. Do not commit JUMI_PR.md. Do not open the pull request.
Then stop.`;

export const IMPLEMENT_PROMPT = `Read JUMI_TASK.md and implement the requested changes in this repository.
${WORKER_SCOPE}
${IMPLEMENT_FINISH}`;

export const IMPLEMENT_YIELD_PROMPT = `Read JUMI_TASK.md and JUMI_QUEUE.md and implement the requested changes in this repository.
${WORKER_SCOPE}
If this work cannot proceed until an id in JUMI_QUEUE.md finishes, write JUMI_BLOCKED.md at the repository root containing exactly one HTML comment:
\`<!-- jumi-blocked-by: #N -->\`
(or \`<!-- jumi-blocked-by: owner/repo#N -->\` for another repo), using an id from that list. Then stop. Do not commit. Do not push. Do not implement a guess.
Do not treat needing a new abstraction, a cluster pin, or a live image as a blocker.
${IMPLEMENT_FINISH}`;

export const BLOCKED_BY_REJECTED_PROMPT = `blocked-by rejected, implement
The previous JUMI_BLOCKED.md was not an id from JUMI_QUEUE.md (unknown, closed, invented, or this issue). Implement the requested changes in this repository.
${WORKER_SCOPE}
Do not write JUMI_BLOCKED.md unless the id is on JUMI_QUEUE.md. Do not commit a blocked-by guess.
${IMPLEMENT_FINISH}`;

export const FOLLOWUP_PROMPT = `Read JUMI_TASK.md (original issue) and JUMI_FEEDBACK.md (review comments).
If JUMI_CI.md is present, it is a parent-injected tail of failed Gitea Actions logs for this head. Address those failures too.
${WORKER_SCOPE}
Address the feedback in this repository on the current branch.
Do not reopen product decisions already specified in JUMI_TASK.md.
Leftover simplifications in the attached review are ideas to judge, not a backlog that must all land. A clean tree is a valid outcome. If a writer comment answers a question in that review, implement that answer.
If JUMI_PR.md is present, it is the pull-request description already posted. Update it so it describes the branch tip after your changes: what changed, why, and what you ran to verify. Do not commit JUMI_PR.md.
${WORKER_COMMIT}
Do not ask questions. Do not open a pull request.
When the feedback is addressed, stop.`;

export const CONFLICT_PROMPT = `Read JUMI_TASK.md (original issue) and JUMI_CONFLICT.md (merge vs the default branch).
If JUMI_CI.md is present, it is a parent-injected tail of failed Gitea Actions logs for this head.
${WORKER_SCOPE}
Resolve only the conflicted paths listed in JUMI_CONFLICT.md. Do not explore unrelated files first. One adjacent file is allowed only if the resolution truly requires it.
Keep both the issue intent and the default-branch changes when they are orthogonal.
Do not drop either side to “win.” Do not reopen product decisions in JUMI_TASK.md.
${WORKER_COMMIT}
Keep the merge commit flow: resolve in place and commit the resolution; do not merge, rebase, or force-push.
Do not ask questions. Do not open a pull request.
When conflicts are resolved and no <<<<<<< markers remain, stop.`;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveOpenCodePrompt(opts: OpenCodeRunOptions): Promise<string> {
  if (opts.prompt != null) return opts.prompt;
  const kind = opts.trace?.kind;
  if (kind === "review") return await readFile(join(opts.workdir, "JUMI_TASK.md"), "utf8");
  if (kind === "follow-up") return FOLLOWUP_PROMPT;
  if (kind === "conflict") return CONFLICT_PROMPT;
  if (kind === "implement") return IMPLEMENT_PROMPT;
  if (await pathExists(join(opts.workdir, "JUMI_CONFLICT.md"))) return CONFLICT_PROMPT;
  if (await pathExists(join(opts.workdir, "JUMI_FEEDBACK.md"))) return FOLLOWUP_PROMPT;
  return IMPLEMENT_PROMPT;
}

function resolveOpenCodeConfigPath(opts: OpenCodeRunOptions): string | undefined {
  return opts.configPath ?? process.env.OPENCODE_CONFIG;
}

/**
 * Every OpenCode child gets the forge webfetch deny, worker runs included: the
 * worker is the one holding a write-capable git token. The denied host is the
 * one this spawn authenticates against (`GIT_AUTH_HOST` from `extraEnv`), so
 * the GitHub factory denies `github.com` rather than the Gitea default. Set,
 * never merged, so a loosened `OPENCODE_PERMISSION` in the parent env cannot
 * reopen the host.
 *
 * OpenCode 2 ignores `OPENCODE_PERMISSION` and only reads `permissions`
 * (ordered array) from file config and `OPENCODE_CONFIG_CONTENT`, so the same
 * deny is also set as inline config for the V2 binary. V1 ignores the unknown
 * `permissions` field, V2 ignores `OPENCODE_PERMISSION`: setting both keeps
 * one binary from silently losing the deny during the upgrade.
 */
function denyForgeWebfetch(env: Record<string, string>, opts: OpenCodeRunOptions): void {
  const host = forgeDenyHost(opts.extraEnv);
  env.OPENCODE_PERMISSION = forgeOpenCodePermission(host);
  const ours = JSON.parse(forgeOpenCodeConfigContent(host)) as { permissions: unknown[] };
  const existing = env.OPENCODE_CONFIG_CONTENT;
  if (!existing) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permissions: ours.permissions });
    return;
  }
  try {
    const parsed = JSON.parse(existing) as { permissions?: unknown[] } & Record<string, unknown>;
    const base = Array.isArray(parsed.permissions) ? parsed.permissions : [];
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...parsed,
      permissions: [...base, ...(ours.permissions as unknown[])],
    });
  } catch {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permissions: ours.permissions });
  }
}

function openCodeXdgDataHome(tempRoot: string): string {
  return join(tempRoot, "xdg-data");
}

function openCodeLogDir(tempRoot: string): string {
  return join(openCodeXdgDataHome(tempRoot), "opencode", "log");
}

/**
 * Best-effort copy of the shared auth file into the per-run isolated data
 * dir so `XDG_DATA_HOME` isolation does not break provider auth. The file
 * holds well-known/Zen credentials seeded at server startup; `OPENCODE_API_KEY`
 * still flows via env. Never throws; missing source is fine (env-only auth).
 *
 * The copy is never the parent's xAI credential: `childAuthFile` swaps in one
 * that cannot refresh, so a killed child cannot rotate the grant and take the
 * new refresh token with it. Rewritten on every run rather than left in place,
 * because a hop reuses this temp dir and must see the token this run refreshed.
 */
async function seedIsolatedAuth(home: string, tempRoot: string, child?: XaiChildCredential): Promise<void> {
  const src = join(home, ".local", "share", "opencode", "auth.json");
  const dst = join(openCodeXdgDataHome(tempRoot), "opencode", "auth.json");
  try {
    if (!existsSync(src)) return;
    const auth = JSON.parse(await readFile(src, "utf8")) as Record<string, unknown>;
    await mkdir(join(openCodeXdgDataHome(tempRoot), "opencode"), { recursive: true });
    await writeFile(dst, `${JSON.stringify(childAuthFile(auth, child), null, 2)}\n`, { mode: 0o600 });
    await chmod(dst, 0o600).catch(() => undefined);
  } catch {
    return;
  }
}

/**
 * Own the xAI refresh grant from the long-lived process: refresh on the durable
 * auth file when the access token would not last this job, and hand the child a
 * credential that cannot refresh. Fails the job closed rather than starting a
 * Grok review that will 401 with no way to recover.
 *
 * A spawn on another provider still gets the refresh-less child credential, but
 * a dead xAI grant must not fail it: only the model that needs Grok fails here.
 */
async function resolveXaiChildCredential(
  opts: OpenCodeRunOptions,
  home: string,
  log: (message: string) => void
): Promise<XaiChildCredential | undefined> {
  if (!isXaiModel(opts.model)) return undefined;
  try {
    const resolved = await ensureXaiCredentialForJob({ home, timeoutMs: opts.timeoutMs, logger: log });
    return resolved?.child;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`xAI credential unusable for a ${opts.model} run: ${message}`);
    // Same shape as an auth death the child reports: the public message is the
    // hostname, the reason stays in the log.
    const authMessage = providerAuthDeathMessage();
    observeEngineRun(opts, { status: "exit", infra: false, auth: true, message: authMessage });
    throw new EngineFailedError(authMessage, false, { auth: true });
  }
}

export const OPENCODE_API_KEY_ENV = "OPENCODE_API_KEY";
export const OPENCODE_API_KEY_FILE_ENV = "OPENCODE_API_KEY_FILE";

export interface OpenCodeApiKeyResolution {
  key: string | undefined;
  filePath: string | undefined;
  fileError: string | undefined;
}

/**
 * Resolve the OpenCode API key for one child spawn, reading the file fresh
 * every time so a rotated Secret applies to the next spawn with no restart.
 *
 * - `OPENCODE_API_KEY_FILE` points at a mounted Secret file. When set and
 *   readable with non-empty (trimmed) contents, it wins over the env var.
 * - Otherwise fall back to `OPENCODE_API_KEY` when set.
 * - When the file path is set but the file is missing, unreadable, or empty
 *   and no env fallback exists, there is no key: the caller fails closed as
 *   a provider-auth failure. Never throws, never logs the key.
 */
export function resolveOpenCodeApiKey(env: Record<string, string | undefined> = process.env): OpenCodeApiKeyResolution {
  const rawPath = env[OPENCODE_API_KEY_FILE_ENV]?.trim();
  const filePath = rawPath ? rawPath : undefined;
  const rawEnvKey = env[OPENCODE_API_KEY_ENV]?.trim();
  const envKey = rawEnvKey ? rawEnvKey : undefined;
  if (!filePath) {
    return { key: envKey, filePath: undefined, fileError: undefined };
  }
  try {
    const content = readFileSync(filePath, "utf8").trim();
    if (content) {
      return { key: content, filePath, fileError: undefined };
    }
    if (envKey) {
      return { key: envKey, filePath, fileError: "empty" };
    }
    return { key: undefined, filePath, fileError: "empty" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (envKey) {
      return { key: envKey, filePath, fileError: reason };
    }
    return { key: undefined, filePath, fileError: reason };
  }
}

/**
 * Clear, key-free configuration reason for a spawn that has a key file
 * configured but no usable key from either source. Contains the provider
 * auth death phrase so hop and no-kick rules classify it as auth.
 */
export function openCodeApiKeyConfigError(filePath: string): string {
  return (
    `${OPENCODE_API_KEY_FILE_ENV} is missing, unreadable, or empty (${filePath}) ` +
    `and ${OPENCODE_API_KEY_ENV} is not set: ${providerAuthDeathMessage()}`
  );
}

function buildEnv(
  opts: OpenCodeRunOptions,
  tempRoot: string,
  openCodeDbPath: string,
  proxyUrl?: string
): Record<string, string> | undefined {
  // Per-review SQLite path under the workspace temp dir so session DB does not
  // accumulate on HOME across runs (OOM trail: 1.5GiB shared opencode.db).
  // Per-run XDG_DATA_HOME for the same reason for the OpenCode log dir: the
  // live quota signal is the isolated log file (`stream error` with a Free/Go
  // quota string), so a fresh dir means any hit belongs to this child and no
  // offset tracking against the shared `$HOME/.local/share` log is needed.
  const configPath = resolveOpenCodeConfigPath(opts);
  const xdgDataHome = openCodeXdgDataHome(tempRoot);
  // Read fresh on every spawn so a rotated Secret file applies to the next
  // child with no restart. The resolved value lives only in this local and
  // the child env: never written back to process.env, never logged.
  const apiKey = resolveOpenCodeApiKey();
  if (!opts.sanitizeEnv) {
    const env = {
      ...process.env,
      TMPDIR: tempRoot,
      OPENCODE_DB: openCodeDbPath,
      XDG_DATA_HOME: xdgDataHome,
    } as Record<string, string>;
    if (apiKey.key) env.OPENCODE_API_KEY = apiKey.key;
    else if (apiKey.filePath) delete env.OPENCODE_API_KEY;
    if (apiKey.filePath && !apiKey.key) {
      throw new EngineFailedError(openCodeApiKeyConfigError(apiKey.filePath), false, { auth: true });
    }
    if (configPath) env.OPENCODE_CONFIG = configPath;
    denyForgeWebfetch(env, opts);
    return env;
  }

  const env: Record<string, string> = {
    HOME: opts.home ?? process.env.HOME ?? opts.workdir,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tempRoot,
    XDG_CONFIG_HOME: join(tempRoot, "xdg-config"),
    XDG_DATA_HOME: xdgDataHome,
    OPENCODE_MODEL: opts.model,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DB: openCodeDbPath,
  };
  if (opts.variant) env.OPENCODE_VARIANT = opts.variant;

  if (apiKey.key) env.OPENCODE_API_KEY = apiKey.key;
  if (apiKey.filePath && !apiKey.key) {
    throw new EngineFailedError(openCodeApiKeyConfigError(apiKey.filePath), false, { auth: true });
  }
  if (configPath) env.OPENCODE_CONFIG = configPath;
  if (opts.extraEnv) {
    for (const [key, value] of Object.entries(opts.extraEnv)) {
      if (key.startsWith("GITEA_") || key.startsWith("GITHUB_APP_") || key === "GITHUB_WEBHOOK_SECRET") continue;
      // The file-resolved key wins: a caller-supplied key via extraEnv must not
      // silently override it (no current caller does this; latent hardening).
      if (key === OPENCODE_API_KEY_ENV || key === OPENCODE_API_KEY_FILE_ENV) continue;
      // The write-capable git token never reaches the child process: the parent
      // holds it and the child's git talks to the loopback proxy instead.
      // Stripped unconditionally (not only when a proxy started), so a spawn
      // that cannot proxy never leaks the token or the old `$GIT_AUTH_TOKEN`
      // credential helper; the spawn itself is refused below.
      if (isChildStrippedKey(key)) continue;
      env[key] = value;
    }
  }
  if (proxyUrl) {
    const request = childProxyRequestFrom(opts.extraEnv, opts.trace);
    Object.assign(
      env,
      childProxyGitConfigEnv(proxyUrl, {
        forgeUrl: request?.forgeUrl ?? "https://localhost/",
        forgeHost: request?.forgeHost ?? "",
      })
    );
  }
  // After extraEnv: a job-supplied OPENCODE_PERMISSION must not win over the deny.
  denyForgeWebfetch(env, opts);
  return env;
}

function truncateNote(label: string, maxBytes: number, keep: "head" | "tail" = "head"): string {
  if (keep === "tail") return `[${label} truncated at ${maxBytes} bytes; kept last]\n\n`;
  return `\n\n[${label} truncated at ${maxBytes} bytes]`;
}

function concatChunks(chunks: Uint8Array[], capturedBytes: number): Uint8Array {
  const captured = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    captured.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return captured;
}

function retainChunk(
  chunks: Uint8Array[],
  state: { capturedBytes: number },
  value: Uint8Array,
  maxBytes: number,
  keep: "head" | "tail"
): void {
  if (keep === "head") {
    if (state.capturedBytes >= maxBytes) return;
    const remaining = maxBytes - state.capturedBytes;
    const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining);
    chunks.push(chunk);
    state.capturedBytes += chunk.byteLength;
    return;
  }

  chunks.push(value);
  state.capturedBytes += value.byteLength;
  while (state.capturedBytes > maxBytes && chunks.length > 0) {
    const overflow = state.capturedBytes - maxBytes;
    const first = chunks[0];
    if (!first) break;
    if (first.byteLength <= overflow) {
      chunks.shift();
      state.capturedBytes -= first.byteLength;
    } else {
      chunks[0] = first.slice(overflow);
      state.capturedBytes -= overflow;
    }
  }
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  label: string,
  maxBytes?: number,
  keep: "head" | "tail" = "head"
): Promise<{ text: string; totalBytes: number }> {
  const chunks: Uint8Array[] = [];
  const state = { capturedBytes: 0 };
  let totalBytes = 0;
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (!maxBytes || maxBytes <= 0) {
        chunks.push(value);
        state.capturedBytes += value.byteLength;
        continue;
      }
      retainChunk(chunks, state, value, maxBytes, keep);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new TextDecoder().decode(concatChunks(chunks, state.capturedBytes));
  if (maxBytes && maxBytes > 0 && totalBytes > maxBytes) {
    const text =
      keep === "tail"
        ? `${truncateNote(label, maxBytes, "tail")}${output}`
        : `${output}${truncateNote(label, maxBytes, "head")}`;
    return { text, totalBytes };
  }
  return { text: output, totalBytes };
}

function countToolishLines(stderr: string): number {
  if (!stderr) return 0;
  let n = 0;
  for (const line of stderr.split("\n")) {
    if (/^\s*(➜|→|✱|•)\s/.test(line) || /\b(Bash|Read|Grep|Glob|Edit|Write)\b/.test(line)) n += 1;
  }
  return n;
}

function engineExitMessage(exitCode: number | null, stderr: string): string {
  return `opencode exited with code ${exitCode}${stderr ? `:\n${stderr}` : ""}`;
}

let openCodeMajorOverride: number | undefined;
let cachedMajor: number | undefined;

export function setOpenCodeMajorForTests(major?: number): void {
  openCodeMajorOverride = major;
}

export function resetOpenCodeVersionForTests(): void {
  openCodeMajorOverride = undefined;
  cachedMajor = undefined;
}

export function detectOpenCodeMajor(bin = "opencode"): number {
  if (openCodeMajorOverride !== undefined) {
    return openCodeMajorOverride;
  }
  try {
    const proc = Bun.spawnSync([bin, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      const text = proc.stdout.toString().trim();
      const match = /(\d+)\.\d+\.\d+/.exec(text);
      if (match) {
        return Number.parseInt(match[1], 10);
      }
    }
  } catch {
    // Binary missing or spawn error; fall back to 1.
  }
  return 1;
}

export function getOpenCodeMajor(): number {
  if (openCodeMajorOverride !== undefined) {
    return openCodeMajorOverride;
  }
  if (cachedMajor !== undefined) {
    return cachedMajor;
  }
  cachedMajor = detectOpenCodeMajor();
  return cachedMajor;
}

export interface OpenCodeArgOptions {
  workdir: string;
  model: string;
  variant?: string;
  continueSession?: boolean;
}

export function buildOpenCodeArgs(opts: OpenCodeArgOptions, major: number = getOpenCodeMajor()): string[] {
  if (major >= 2) {
    const variant = opts.variant?.trim();
    const model = variant ? `${opts.model}#${variant}` : opts.model;
    const args = ["opencode", "run", "--standalone", "-m", model];
    if (opts.continueSession) args.push("--continue");
    return args;
  }
  const args = ["opencode", "run", "--dir", opts.workdir, "-m", opts.model];
  if (opts.variant) args.push("--variant", opts.variant);
  if (opts.continueSession) args.push("--continue");
  return args;
}

export async function runOpenCode(opts: OpenCodeRunOptions): Promise<EngineResult> {
  const log = opts.logger ?? ((message: string) => console.log(message));
  await ensureEngineScratchIgnored(opts.workdir);
  const prompt = await resolveOpenCodePrompt(opts);
  const tempRoot = join(opts.workdir, ".jumi-tmp");
  await mkdir(tempRoot, { recursive: true });

  const tmpDir = await mkdtemp(join(tempRoot, "opencode-prompt-"));
  const tmpPath = join(tmpDir, "prompt.txt");
  await writeFile(tmpPath, prompt);

  const home = opts.home ?? process.env.HOME ?? opts.workdir;
  // Always isolate session DB under the review temp dir (deleted with workspace).
  const dbPath = join(tempRoot, "opencode-session.db");
  const logDir = openCodeLogDir(tempRoot);
  // Isolate the OpenCode log dir (XDG_DATA_HOME) so the live quota poll sees
  // only this child. Seed auth so isolation does not break provider auth.
  const xaiChild = await resolveXaiChildCredential(opts, home, log);
  await seedIsolatedAuth(home, tempRoot, xaiChild);
  const promptBytes = byteLength(prompt);
  const dbBefore = await pathSizeBytes(dbPath);
  const parentBefore = await sampleMemory(process.pid);

  logDiagnostic(log, "opencode_start", {
    review: opts.reviewLabel,
    model: opts.model,
    variant: opts.variant ?? null,
    hop: opts.hop === true ? true : undefined,
    prompt_bytes: promptBytes,
    prompt_bytes_h: formatBytes(promptBytes),
    opencode_db: dbPath,
    opencode_db_bytes: dbBefore,
    opencode_db_h: formatBytes(dbBefore),
    home,
    parent_rss_bytes: parentBefore.rssBytes,
    parent_rss_h: formatBytes(parentBefore.rssBytes),
    cgroup_bytes: parentBefore.cgroupBytes,
    cgroup_h: formatBytes(parentBefore.cgroupBytes),
    timeout_ms: opts.timeoutMs ?? 0,
  });

  let tracker: MemoryPeakState | undefined;
  let finalSample: MemorySample | undefined;
  let gitProxy: ChildGitProxy | undefined;

  if (opts.abortSignal?.aborted) {
    const err = new Error("cancelled");
    err.name = "AbortError";
    throw err;
  }

  try {
    // The write-capable git token stays in parent memory: when the spawn
    // carries one, the child's git talks to a loopback proxy that injects the
    // token only for git smart-HTTP paths scoped to the claimed repo. The
    // proxy lives only for this spawn and never writes the token to disk.
    if (opts.sanitizeEnv) {
      const request = childProxyRequestFrom(opts.extraEnv, opts.trace);
      if (request) {
        try {
          gitProxy = await startChildGitProxy(request);
        } catch (err) {
          throw new EngineFailedError(
            `opencode spawn refused: cannot start git credential proxy: ${err instanceof Error ? err.message : String(err)}`,
            true
          );
        }
      } else if (extraEnvHasGitToken(opts.extraEnv)) {
        throw new EngineFailedError(
          "opencode spawn refused: git token present but no credential proxy available",
          true
        );
      }
    }
    // Build the child env before spawning so a missing-key configuration
    // failure keeps its auth classification instead of being wrapped as infra.
    let childEnv: Record<string, string>;
    try {
      const built = buildEnv(opts, tempRoot, dbPath, gitProxy?.url);
      if (!built) throw new EngineFailedError("opencode spawn refused: no child env", true);
      childEnv = built;
      // OpenCode 2 stores credentials in SQLite, not auth.json, and its xAI
      // provider sends XAI_API_KEY as bearer. The isolated auth file above is
      // ignored by V2, so hand the V2 child the same refresh-less access token
      // via env. V1 still uses the file and ignores the env.
      if (xaiChild && getOpenCodeMajor() >= 2) {
        const token = xaiChild.type === "api" ? xaiChild.key : xaiChild.access;
        if (token) childEnv.XAI_API_KEY = token;
      } else if (!xaiChild && getOpenCodeMajor() >= 2 && isXaiModel(opts.model)) {
        // API-key parent (no OAuth entry): the file copy above carries the key
        // for V1, but V2 needs it as env. Best-effort, never throws or logs.
        try {
          const parentRaw = await readFile(join(home, ".local", "share", "opencode", "auth.json"), "utf8");
          const parent = JSON.parse(parentRaw) as Record<string, unknown>;
          const entry = (parent as { xai?: unknown }).xai as
            | { type?: unknown; key?: unknown }
            | undefined;
          if (entry?.type === "api" && typeof entry.key === "string" && entry.key) {
            childEnv.XAI_API_KEY = entry.key;
          } else if (entry?.type === "key" && typeof entry.key === "string" && entry.key) {
            childEnv.XAI_API_KEY = entry.key;
          } else if (process.env.XAI_API_KEY) {
            childEnv.XAI_API_KEY = process.env.XAI_API_KEY;
          }
        } catch {
          if (process.env.XAI_API_KEY) childEnv.XAI_API_KEY = process.env.XAI_API_KEY;
        }
      }
    } catch (err) {
      if (err instanceof EngineFailedError && err.auth) {
        const message = err.message;
        log(message);
        observeEngineRun(opts, {
          status: "exit",
          infra: false,
          auth: true,
          message: providerAuthDeathMessage(),
        });
        throw err;
      }
      throw err;
    }
    const major = getOpenCodeMajor();
    const args = buildOpenCodeArgs(opts, major);
    const proc = (() => {
      try {
        return Bun.spawn(args, {
          cwd: opts.workdir,
          stdin: Bun.file(tmpPath),
          stdout: "pipe",
          stderr: "pipe",
          env: childEnv,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new EngineFailedError(message, true);
      }
    })();

    const childPid = proc.pid;
    await opts.onPid?.(childPid);
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        return;
      }
    };
    if (opts.abortSignal?.aborted) onAbort();
    else opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    let trackerStartedAt = Date.now();
    tracker = trackMemoryPeak(childPid, opts.memorySampleIntervalMs ?? 5_000, (sample, peaks) => {
      logDiagnostic(log, "opencode_sample", {
        review: opts.reviewLabel,
        sample: peaks.n,
        child_rss_bytes: sample.rssBytes,
        child_rss_h: formatBytes(sample.rssBytes),
        child_rss_peak_bytes: peaks.rss,
        child_rss_peak_h: formatBytes(peaks.rss),
        cgroup_bytes: sample.cgroupBytes,
        cgroup_h: formatBytes(sample.cgroupBytes),
        cgroup_peak_bytes: peaks.cgroup,
        cgroup_peak_h: formatBytes(peaks.cgroup),
        elapsed_ms: Date.now() - trackerStartedAt,
      });
    });
    trackerStartedAt = tracker.startedAtMs;
    let timedOut = false;
    const timeout =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            proc.kill();
          }, opts.timeoutMs)
        : undefined;

    // Quota abort: while OpenCode sleeps on a Free/Go usage-limit retry-after
    // (often hours), the child PID stays alive and RSS goes flat. The pinned
    // OpenCode keeps retry status in memory (SessionStatus) and never writes
    // a per-attempt row to the session DB while sleeping, and `opencode run`
    // without `--print-logs` emits only the banner to stderr, so neither the
    // stderr stream nor DB polling can fire during the hang. Instead poll the
    // per-run isolated log file for the `llm` `stream error` line carrying a
    // Free/Go quota string (~170ms after stream start, before the sleep).
    // Match the Free/Go quota class only (narrow live pattern, retry context
    // required); ordinary short-window 429s that OpenCode retries in seconds
    // do not contain these strings and stay retries. No --print-logs, no
    // transcript dump to Loki, no Phoenix. The isolated dir means any hit
    // belongs to this child; no ANSI concerns (log has no color codes).
    let quotaHit = false;
    let quotaInfo: QuotaHit | undefined;
    const quotaIntervalMs = opts.quotaPollIntervalMs ?? QUOTA_POLL_INTERVAL_MS;
    const quotaTimer =
      quotaIntervalMs > 0
        ? setInterval(() => {
            if (quotaHit || timedOut || opts.abortSignal?.aborted) return;
            let hit: QuotaHit | undefined;
            try {
              hit = inspectQuotaInLogDir(logDir);
            } catch {
              hit = undefined;
            }
            if (!hit) return;
            quotaHit = true;
            quotaInfo = hit;
            logDiagnostic(log, "opencode_quota", {
              review: opts.reviewLabel,
              elapsed_ms: Date.now() - trackerStartedAt,
              quota_class: hit.kind,
              retry_after_ms: hit.retryAfterMs ?? null,
            });
            try {
              proc.kill();
            } catch {
              return;
            }
          }, quotaIntervalMs)
        : undefined;
    if (quotaTimer && typeof quotaTimer === "object" && "unref" in quotaTimer) {
      (quotaTimer as { unref: () => void }).unref();
    }

    // Consume stdout, stderr, and the exit code concurrently.
    // Reading stderr in parallel is required to prevent a deadlock when the
    // child writes more than the OS pipe buffer (~64KB) to stderr. Keep only a
    // bounded tail so verbose OpenCode logs cannot grow the reviewer heap
    // without bound; tool traces live at the end, not behind the banner.
    let stdoutResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let stderrResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let exitCode: number | null = null;
    let runError: unknown;
    try {
      [stdoutResult, stderrResult, exitCode] = await Promise.all([
        readStreamLimited(proc.stdout, "opencode output", opts.maxOutputBytes),
        readStreamLimited(proc.stderr, "opencode stderr", OPENCODE_STDERR_MAX_BYTES, "tail"),
        proc.exited,
      ]);
    } catch (err) {
      runError = err;
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
      if (quotaTimer) clearInterval(quotaTimer);
      finalSample = await finalizeMemoryTracker(tracker, childPid);
    }

    const dbAfter = await pathSizeBytes(dbPath);
    const parentAfter = await sampleMemory(process.pid);

    const stdout = redactEngineText(stripAnsi(stdoutResult.text).trim(), opts);
    const stderr = redactEngineText(stripAnsi(stderrResult.text).trim(), opts);
    const toolishLines = countToolishLines(stderr);
    const durationMs = Date.now() - tracker.startedAtMs;
    const tokensExist = recordOpenCodeDb(dbPath);
    const infra = classifyOpenCodeInfra({
      durationMs,
      stderr,
      dbBefore,
      dbAfter,
      tokensExist,
    });
    // Post-hoc quota classifier: the live log poll above drove the abort while
    // running. The checks below only classify outcomes where the poll missed
    // (child exited before the first 5s tick) or the error record landed in
    // the session DB (e.g. halt persisted assistantMessage.error).
    // Best-effort, never throws. No transcript is logged; only the regex is
    // tested. stderr is intentionally not scanned: the real binary never
    // emits quota strings there, so any match would be a tool trace echoing
    // the literals, not a quota retry.
    if (!quotaInfo) {
      try {
        quotaInfo = inspectQuotaHit(logDir, dbPath);
      } catch {
        quotaInfo = undefined;
      }
    }
    const quota = quotaInfo != null;
    const auth = !quota && !timedOut && exitCode !== 143 && looksLikeProviderAuthDeath(stderr);
    if (quotaInfo && !quotaHit) {
      logDiagnostic(log, "opencode_quota", {
        review: opts.reviewLabel,
        elapsed_ms: durationMs,
        quota_class: quotaInfo.kind,
        retry_after_ms: quotaInfo.retryAfterMs ?? null,
      });
    }

    logDiagnostic(log, "opencode_end", {
      review: opts.reviewLabel,
      model: opts.model,
      hop: opts.hop === true ? true : undefined,
      exit_code: exitCode,
      duration_ms: Date.now() - tracker.startedAtMs,
      samples: tracker.samples,
      child_rss_start_bytes: tracker.start.rssBytes,
      child_rss_start_h: formatBytes(tracker.start.rssBytes),
      child_rss_peak_bytes: tracker.peakRssBytes,
      child_rss_peak_h: formatBytes(tracker.peakRssBytes),
      child_rss_end_bytes: finalSample.rssBytes,
      child_rss_end_h: formatBytes(finalSample.rssBytes),
      cgroup_start_bytes: tracker.start.cgroupBytes,
      cgroup_start_h: formatBytes(tracker.start.cgroupBytes),
      cgroup_peak_bytes: tracker.peakCgroupBytes,
      cgroup_peak_h: formatBytes(tracker.peakCgroupBytes),
      cgroup_end_bytes: finalSample.cgroupBytes,
      cgroup_end_h: formatBytes(finalSample.cgroupBytes),
      parent_rss_end_bytes: parentAfter.rssBytes,
      parent_rss_end_h: formatBytes(parentAfter.rssBytes),
      stdout_bytes: stdoutResult.totalBytes,
      stdout_bytes_h: formatBytes(stdoutResult.totalBytes),
      stderr_bytes: stderrResult.totalBytes,
      stderr_bytes_h: formatBytes(stderrResult.totalBytes),
      stderr_toolish_lines: toolishLines,
      opencode_db_bytes: dbAfter,
      opencode_db_h: formatBytes(dbAfter),
      opencode_db_delta_bytes: dbBefore !== null && dbAfter !== null ? dbAfter - dbBefore : null,
      run_error: runError
        ? redactEngineText(runError instanceof Error ? runError.message : String(runError), opts).slice(0, 200)
        : null,
      infra,
      auth,
      quota,
      quota_class: quotaInfo?.kind ?? null,
      retry_after_ms: quotaInfo?.retryAfterMs ?? null,
    });
    await exportOpenCodeTrace({ dbPath, trace: opts.trace });

    if (opts.abortSignal?.aborted) {
      const err = new Error("cancelled");
      err.name = "AbortError";
      throw err;
    }

    if (quota && quotaInfo) {
      return observeEngineRun(opts, {
        status: "stuck",
        exitCode,
        stdout,
        message: QUOTA_MESSAGE,
        infra: false,
        durationMs,
        quota: quotaInfo.kind,
        retryAfterMs: quotaInfo.retryAfterMs,
      });
    }

    if (runError) {
      const message = redactEngineText(runError instanceof Error ? runError.message : String(runError), opts);
      if (auth || looksLikeProviderAuthDeath(message)) {
        if (stderr) log(`[opencode stderr] ${stderr}`);
        const authMessage = providerAuthDeathMessage();
        observeEngineRun(opts, { status: "exit", infra: false, auth: true, durationMs, message: authMessage });
        throw new EngineFailedError(authMessage, false, { auth: true });
      }
      const isInfra = infra || looksLikeInfraStderr(message);
      observeEngineRun(opts, { status: "exit", infra: isInfra, durationMs, message });
      throw new EngineFailedError(message, isInfra);
    }

    if (timedOut) {
      return observeEngineRun(opts, {
        status: "timeout",
        exitCode,
        stdout,
        message: engineExitMessage(exitCode, stderr),
        infra,
        durationMs,
      });
    }

    if (exitCode === 0) {
      // Log the already-bounded stderr capture (last 64 KiB). Do not pass
      // --print-logs: that is a different firehose. The old 2 KiB log-head cap
      // hid tool traces behind the OpenCode banner.
      if (stderr) {
        log(`[opencode stderr] ${stderr}`);
      }
      return observeEngineRun(opts, { status: "ok", exitCode: 0, stdout, durationMs });
    }

    if (auth) {
      if (stderr) log(`[opencode stderr] ${stderr}`);
      return observeEngineRun(opts, {
        status: "exit",
        exitCode,
        stdout,
        message: providerAuthDeathMessage(),
        infra: false,
        auth: true,
        durationMs,
      });
    }

    if (stderr) log(`[opencode stderr] ${stderr}`);
    return observeEngineRun(opts, {
      status: "exit",
      exitCode,
      stdout,
      message: engineExitMessage(exitCode, stderr),
      infra,
      durationMs,
    });
  } catch (err) {
    if (err instanceof EngineFailedError) throw err;
    if (err instanceof Error && (err.name === "AbortError" || err.message === "cancelled")) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeProviderAuthDeath(message)) {
      throw new EngineFailedError(providerAuthDeathMessage(), false, { auth: true });
    }
    if (looksLikeInfraStderr(message)) throw new EngineFailedError(message, true);
    throw err;
  } finally {
    tracker?.stop();
    await gitProxy?.close().catch(() => undefined);
    // Best-effort: a temp dir that will not go must not replace the engine result (#129).
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const openCodeEngine: Engine = runOpenCode;
