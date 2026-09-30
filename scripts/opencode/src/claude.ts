import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { looksLikeProviderAuthDeath, providerAuthDeathMessage } from "./auth.ts";
import { stageClaudeCheckoutSkills } from "./claude_checkout_skills.ts";
import { claudeTracingEnv, claudeTracingPluginDir } from "./claude_tracing.ts";
import { ClaudeStreamParser } from "./claude_usage.ts";
import { observeEngineRun } from "./control_metrics.ts";
import {
  type Engine,
  EngineFailedError,
  type EngineResult,
  type EngineRunOptions,
  redactEngineText,
} from "./engine.ts";
import { ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { claudeDisallowedTools, forgeDenyHost } from "./forge_webfetch.ts";
import { resolveOpenCodePrompt } from "./git.ts";
import { looksLikeInfraStderr } from "./infra.ts";
import { QUOTA_MESSAGE, type QuotaClass } from "./quota.ts";
import { recordClaudeUsage } from "./token_metrics.ts";

export const CLAUDE_SETTING_SOURCES = "user";
export const CLAUDE_ALLOWED_TOOLS = "Read,Write,Edit,Bash,Grep,Glob,WebFetch,Skill";
export const CLAUDE_PERMISSION_MODE = "dontAsk";
/** stream-json keeps per-message usage even when the child is killed before `result`. */
export const CLAUDE_OUTPUT_FORMAT = "stream-json";

const CLAUDE_STDERR_MAX_BYTES = 64_000;
const SCRUB_ENV_PREFIXES = ["GITEA_", "GITHUB_APP_"] as const;
const SCRUB_ENV_KEYS = new Set(["GITHUB_WEBHOOK_SECRET"]);
const CLAUDE_USAGE_LIMIT_RE =
  /You've hit your (?:session |usage |weekly |opus |sonnet |5[- ]hour )?limit|Claude AI usage limit reached/i;

export function stripAnsi(str: string): string {
  return str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g"), "");
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

export async function readStreamLimited(
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

export function limitText(text: string, label: string, maxBytes?: number): { text: string; totalBytes: number } {
  const bytes = new TextEncoder().encode(text);
  if (!maxBytes || maxBytes <= 0 || bytes.byteLength <= maxBytes) return { text, totalBytes: bytes.byteLength };
  const head = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return { text: `${head}${truncateNote(label, maxBytes, "head")}`, totalBytes: bytes.byteLength };
}

async function readClaudeStdout(stream: ReadableStream<Uint8Array>, parser: ClaudeStreamParser): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
    }
  } finally {
    reader.releaseLock();
    parser.end();
  }
}

export function scrubbedKey(key: string): boolean {
  if (SCRUB_ENV_KEYS.has(key)) return true;
  return SCRUB_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function buildClaudeEnv(opts: EngineRunOptions, tempRoot: string): Record<string, string> {
  const tracing = claudeTracingEnv(opts.trace);
  if (!opts.sanitizeEnv) {
    const env = { ...process.env, TMPDIR: tempRoot, ...tracing } as Record<string, string>;
    delete env.XDG_CONFIG_HOME;
    return env;
  }

  const env: Record<string, string> = {
    HOME: opts.home ?? process.env.HOME ?? opts.workdir,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tempRoot,
    DISABLE_AUTOUPDATER: "1",
  };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (opts.extraEnv) {
    for (const [key, value] of Object.entries(opts.extraEnv)) {
      if (scrubbedKey(key)) continue;
      env[key] = value;
    }
  }
  // After extraEnv, because the scrub is what this has to survive: a sanitized
  // spawn that reaches the model but not Phoenix is an untraced job.
  Object.assign(env, tracing);
  return env;
}

/**
 * `checkoutSkillsPlugin` is the hook-free plugin `stageClaudeCheckoutSkills`
 * wrote for this spawn, when the checkout has skills.
 */
export function claudeArgv(opts: EngineRunOptions, checkoutSkillsPlugin?: string): string[] {
  const args = [
    "claude",
    "-p",
    "--setting-sources",
    CLAUDE_SETTING_SOURCES,
    "--permission-mode",
    CLAUDE_PERMISSION_MODE,
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS,
    // Deny beats every allow, so WebFetch stays on the allow-list for public
    // docs while the forge host itself is refused by the binary. The host is
    // this spawn's own `GIT_AUTH_HOST`, so a GitHub-factory child denies
    // github.com rather than only the Gitea default.
    "--disallowedTools",
    claudeDisallowedTools(forgeDenyHost(opts.extraEnv)),
    "--output-format",
    CLAUDE_OUTPUT_FORMAT,
    "--verbose",
    "--model",
    opts.model,
  ];
  if (opts.effort) args.push("--effort", opts.effort);
  // Phoenix tracing is an image-local plugin the parent names per spawn, so
  // `--setting-sources user` still keeps the untrusted checkout's hooks out.
  const tracingPlugin = claudeTracingPluginDir();
  if (tracingPlugin) args.push("--plugin-dir", tracingPlugin);
  // Checkout skills ride the same way: staged by the parent, never read from
  // the checkout's own `.claude/`, so `--setting-sources user` stays.
  if (checkoutSkillsPlugin) args.push("--plugin-dir", checkoutSkillsPlugin);
  if (opts.continueSession) args.push("--continue");
  return args;
}

function engineExitMessage(exitCode: number | null, detail: string): string {
  return `claude exited with code ${exitCode}${detail ? `:\n${detail}` : ""}`;
}

export function inspectClaudeUsageLimit(text: string | null | undefined): QuotaClass | undefined {
  if (!text || !CLAUDE_USAGE_LIMIT_RE.test(text)) return undefined;
  return "resetting";
}

export async function runClaude(opts: EngineRunOptions): Promise<EngineResult> {
  const log = opts.logger ?? ((message: string) => console.log(message));
  await ensureEngineScratchIgnored(opts.workdir);
  const prompt = await resolveOpenCodePrompt(opts);
  const tempRoot = join(opts.workdir, ".jumi-tmp");
  await mkdir(tempRoot, { recursive: true });

  const tmpDir = await mkdtemp(join(tempRoot, "claude-prompt-"));
  const tmpPath = join(tmpDir, "prompt.txt");
  await writeFile(tmpPath, prompt);
  const startedAtMs = Date.now();

  if (opts.abortSignal?.aborted) {
    const err = new Error("cancelled");
    err.name = "AbortError";
    throw err;
  }

  try {
    const checkoutSkills = await stageClaudeCheckoutSkills(opts.workdir, join(tmpDir, "checkout-skills"), log);
    const args = claudeArgv(opts, checkoutSkills);
    const proc = (() => {
      try {
        return Bun.spawn(args, {
          cwd: opts.workdir,
          stdin: Bun.file(tmpPath),
          stdout: "pipe",
          stderr: "pipe",
          env: buildClaudeEnv(opts, tempRoot),
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

    let timedOut = false;
    const timeout =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            proc.kill();
          }, opts.timeoutMs)
        : undefined;

    const parser = new ClaudeStreamParser();
    let stderrResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let exitCode: number | null = null;
    let runError: unknown;
    try {
      [, stderrResult, exitCode] = await Promise.all([
        readClaudeStdout(proc.stdout, parser),
        readStreamLimited(proc.stderr, "claude stderr", CLAUDE_STDERR_MAX_BYTES, "tail"),
        proc.exited,
      ]);
    } catch (err) {
      runError = err;
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
    }

    // Parent-held usage at child end, whatever the outcome (ok, non-zero,
    // timeout, 143, cancel). Fail-open: no usage records nothing.
    recordClaudeUsage(parser.usage());
    const stdoutResult = limitText(parser.text(), "claude output", opts.maxOutputBytes);
    const stdout = redactEngineText(stripAnsi(stdoutResult.text).trim(), opts);
    const stderr = redactEngineText(stripAnsi(stderrResult.text).trim(), opts);
    const combined = [stderr, stdout].filter(Boolean).join("\n");
    const durationMs = Date.now() - startedAtMs;
    const quota = !timedOut ? inspectClaudeUsageLimit(combined) : undefined;
    const auth = !quota && !timedOut && exitCode !== 143 && looksLikeProviderAuthDeath(combined);

    if (opts.abortSignal?.aborted) {
      const err = new Error("cancelled");
      err.name = "AbortError";
      throw err;
    }

    if (runError) {
      const message = redactEngineText(runError instanceof Error ? runError.message : String(runError), opts);
      if (auth || looksLikeProviderAuthDeath(message)) {
        if (stderr) log(`[claude stderr] ${stderr}`);
        const authMessage = providerAuthDeathMessage();
        observeEngineRun(opts, { status: "exit", infra: false, auth: true, durationMs, message: authMessage });
        throw new EngineFailedError(authMessage, false, { auth: true });
      }
      const isInfra = looksLikeInfraStderr(message);
      observeEngineRun(opts, { status: "exit", infra: isInfra, durationMs, message });
      throw new EngineFailedError(message, isInfra);
    }

    if (timedOut) {
      return observeEngineRun(opts, {
        status: "timeout",
        exitCode,
        stdout,
        message: engineExitMessage(exitCode, combined),
        infra: false,
        durationMs,
      });
    }

    if (exitCode === 0) {
      if (stderr) log(`[claude stderr] ${stderr}`);
      return observeEngineRun(opts, { status: "ok", exitCode: 0, stdout, durationMs });
    }

    if (quota) {
      if (stderr) log(`[claude stderr] ${stderr}`);
      return observeEngineRun(opts, {
        status: "stuck",
        exitCode,
        stdout,
        message: QUOTA_MESSAGE,
        infra: false,
        durationMs,
        quota,
      });
    }

    if (auth) {
      if (stderr) log(`[claude stderr] ${stderr}`);
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

    if (stderr) log(`[claude stderr] ${stderr}`);
    return observeEngineRun(opts, {
      status: "exit",
      exitCode,
      stdout,
      message: engineExitMessage(exitCode, combined),
      infra: looksLikeInfraStderr(combined),
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
    // Best-effort: a temp dir that will not go must not replace the engine result (#129).
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const claudeEngine: Engine = runClaude;
