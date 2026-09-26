import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { looksLikeProviderAuthDeath, providerAuthDeathMessage } from "./auth.ts";
import { limitText, readStreamLimited, scrubbedKey, stripAnsi } from "./claude.ts";
import { exportCodexTrace } from "./codex_tracing.ts";
import { CodexStreamParser } from "./codex_usage.ts";
import { observeEngineRun } from "./control_metrics.ts";
import {
  type Engine,
  EngineFailedError,
  type EngineResult,
  type EngineRunOptions,
  redactEngineText,
} from "./engine.ts";
import { ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { codexThreadPath, looksLikeProviderUnavailable } from "./fallback.ts";
import { resolveOpenCodePrompt } from "./git.ts";
import { looksLikeInfraStderr } from "./infra.ts";
import { QUOTA_MESSAGE, type QuotaClass } from "./quota.ts";
import { CODEX_DEFAULT_EFFORT } from "./runners.ts";
import { recordCodexUsage } from "./token_metrics.ts";

export const CODEX_SANDBOX = "danger-full-access";
export const CODEX_APPROVAL = "never";
export const REVIEW_ARTIFACT = "JUMI_REVIEW.md";

const CODEX_STDERR_MAX_BYTES = 64_000;
const API_KEY_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;
const CODEX_AUTH_RE =
  /not logged in|please (?:sign in|log in)|authentication required|login required|no credentials|unauthorized|invalid api key|missing api key|chatgpt login/i;
const CODEX_USAGE_LIMIT_RE =
  /usage[_\s-]*limit|rate[\s_-]*limit|too many requests|\b429\b|insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|exhausted)|out of quota|hit your (?:usage|free|session) limit/i;

function codexHardeningArgs(effort: string): string[] {
  return [
    "-c",
    `model_reasoning_effort="${effort}"`,
    "-c",
    'web_search="disabled"',
    "-c",
    "features.context_management.experimental_mode=false",
    // `--disable` is not a documented `codex exec` flag (it is a global flag
    // that does not propagate there), so these use the `-c features.*=false`
    // form `--disable` itself translates to.
    "-c",
    "features.hooks=false",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.apps=false",
    "-c",
    "agents.enabled=false",
    "-c",
    "otel.log_user_prompt=false",
    "-c",
    'otel.trace_exporter="none"',
    "-c",
    `sandbox_mode="${CODEX_SANDBOX}"`,
    // `--ask-for-approval` is likewise absent from the `codex exec` flag set;
    // `-c approval_policy` is the documented route for the same value.
    "-c",
    `approval_policy="${CODEX_APPROVAL}"`,
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
    "-c",
    'model_provider="openai"',
  ];
}

function codexConfigArgs(model: string, effort: string): string[] {
  return [
    "--json",
    "--color",
    "never",
    // `--sandbox` is a documented `codex exec` flag; `-c sandbox_mode` below
    // repeats it so the resume path (which omits `--sandbox`) keeps the same
    // danger-full-access class without relying on a flag `exec resume` has
    // rejected on past releases.
    "--sandbox",
    CODEX_SANDBOX,
    "--skip-git-repo-check",
    "--ignore-rules",
    "--ignore-user-config",
    "--model",
    model,
    ...codexHardeningArgs(effort),
  ];
}

/**
 * Flags for `codex exec resume <id>`. `--color` is declared on the `exec`
 * command without `global = true`, so it must appear before the `resume`
 * subcommand — after it the real binary rejects it as an unexpected
 * argument. `--json`, `--skip-git-repo-check`, `--ignore-rules`,
 * `--ignore-user-config`, and `-c` are `global = true` and therefore valid
 * on either side; the globals stay before `resume` with `--color` while the
 * `-c` overrides travel after the thread id. Every `-c` override is
 * per-invocation config reloaded from scratch on each `exec resume`, not
 * per-thread state, so the full turn-1 hardening list is repeated here —
 * otherwise turn 2+ would silently re-enable hooks, web-search,
 * experimental context management, and project `.rules` loading that turn 1
 * disabled.
 */
function codexResumePreArgs(): string[] {
  return ["--json", "--color", "never", "--skip-git-repo-check", "--ignore-rules", "--ignore-user-config"];
}

function codexResumeArgs(effort: string): string[] {
  return codexHardeningArgs(effort);
}

export function codexArgv(opts: EngineRunOptions, threadId?: string): string[] {
  const effort = opts.effort || CODEX_DEFAULT_EFFORT;
  if (opts.continueSession && threadId)
    return ["codex", "exec", ...codexResumePreArgs(), "resume", threadId, ...codexResumeArgs(effort), "-"];
  const flags = codexConfigArgs(opts.model, effort);
  return ["codex", "exec", ...flags, "-"];
}

export function looksLikeCodexAuthDeath(text: string): boolean {
  return CODEX_AUTH_RE.test(text) || looksLikeProviderAuthDeath(text);
}

export function looksLikeCodexUsageLimit(text: string | null | undefined): QuotaClass | undefined {
  if (!text || !CODEX_USAGE_LIMIT_RE.test(text)) return undefined;
  return "resetting";
}

function engineExitMessage(exitCode: number | null, detail: string): string {
  return `codex exited with code ${exitCode}${detail ? `:\n${detail}` : ""}`;
}

function redactApiKeys(text: string): string {
  let out = text;
  for (const key of API_KEY_ENV) {
    const value = process.env[key];
    if (value) out = out.split(value).join("[redacted]");
  }
  return out;
}

function buildCodexEnv(opts: EngineRunOptions, tempRoot: string): Record<string, string> {
  const base = opts.sanitizeEnv
    ? {
        HOME: opts.home ?? process.env.HOME ?? opts.workdir,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: tempRoot,
      }
    : ({ ...process.env, TMPDIR: tempRoot } as Record<string, string>);
  const env: Record<string, string> = { ...base };
  if (opts.sanitizeEnv && opts.extraEnv) {
    for (const [key, value] of Object.entries(opts.extraEnv)) {
      if (scrubbedKey(key)) continue;
      if ((API_KEY_ENV as readonly string[]).includes(key)) continue;
      if (key === "CODEX_HOME" || key === "XDG_CONFIG_HOME") continue;
      env[key] = value;
    }
  }
  delete env.XDG_CONFIG_HOME;
  delete env.CODEX_HOME;
  for (const key of API_KEY_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

async function readThreadId(workdir: string): Promise<string | undefined> {
  try {
    return (await readFile(codexThreadPath(workdir), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function reviewArtifactMissing(workdir: string): Promise<boolean> {
  const path = join(workdir, REVIEW_ARTIFACT);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size === 0) return true;
    const text = await readFile(path, "utf8");
    return !text.trim();
  } catch {
    return true;
  }
}

async function readCodexStdout(stream: ReadableStream<Uint8Array>, parser: CodexStreamParser): Promise<void> {
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

function cancelled(): Error {
  const err = new Error("cancelled");
  err.name = "AbortError";
  return err;
}

export async function runCodex(opts: EngineRunOptions): Promise<EngineResult> {
  const log = opts.logger ?? ((message: string) => console.log(message));
  await ensureEngineScratchIgnored(opts.workdir);
  const prompt = await resolveOpenCodePrompt(opts);
  const tempRoot = join(opts.workdir, ".jumi-tmp");
  await mkdir(tempRoot, { recursive: true });

  const tmpDir = await mkdtemp(join(tempRoot, "codex-prompt-"));
  const tmpPath = join(tmpDir, "prompt.txt");
  await writeFile(tmpPath, prompt);
  const startedAtMs = Date.now();

  if (opts.abortSignal?.aborted) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw cancelled();
  }

  try {
    const threadId = opts.continueSession ? await readThreadId(opts.workdir) : undefined;
    const args = codexArgv(opts, threadId);
    const proc = (() => {
      try {
        return Bun.spawn(args, {
          cwd: opts.workdir,
          stdin: Bun.file(tmpPath),
          stdout: "pipe",
          stderr: "pipe",
          env: buildCodexEnv(opts, tempRoot),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new EngineFailedError(message, true);
      }
    })();

    await opts.onPid?.(proc.pid);
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

    const parser = new CodexStreamParser();
    let stderrResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let exitCode: number | null = null;
    let runError: unknown;
    try {
      [, stderrResult, exitCode] = await Promise.all([
        readCodexStdout(proc.stdout, parser),
        readStreamLimited(proc.stderr, "codex stderr", CODEX_STDERR_MAX_BYTES, "tail"),
        proc.exited,
      ]);
    } catch (err) {
      runError = err;
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
    }

    const model = parser.modelSeen() || opts.model;
    recordCodexUsage(parser.usage(model));
    await exportCodexTrace(parser.traceEvents(), opts.trace, model);
    const newThread = parser.threadIdValue();
    if (newThread) await writeFile(codexThreadPath(opts.workdir), `${newThread}\n`).catch(() => {});

    const stdoutResult = limitText(parser.text(), "codex output", opts.maxOutputBytes);
    const stdout = redactEngineText(redactApiKeys(stripAnsi(stdoutResult.text).trim()), opts);
    const stderr = redactEngineText(redactApiKeys(stripAnsi(stderrResult.text).trim()), opts);
    const signal = [stderr, parser.errors()].filter(Boolean).join("\n");
    const combined = [stderr, stdout].filter(Boolean).join("\n");
    const durationMs = Date.now() - startedAtMs;
    const quota = !timedOut ? looksLikeCodexUsageLimit(signal) : undefined;
    const auth = !quota && !timedOut && exitCode !== 143 && looksLikeCodexAuthDeath(signal);
    const fiveXx = /\b5\d\d\b|internal server error/i.test(signal);
    const providerDown =
      !quota && !auth && !timedOut && exitCode !== 143 && (looksLikeProviderUnavailable(signal) || fiveXx);

    if (opts.abortSignal?.aborted) throw cancelled();

    if (runError) {
      const message = redactEngineText(runError instanceof Error ? runError.message : String(runError), opts);
      if (auth || looksLikeCodexAuthDeath(message)) {
        if (stderr) log(`[codex stderr] ${stderr}`);
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
      if (stderr) log(`[codex stderr] ${stderr}`);
      if (opts.trace?.kind === "review" && (await reviewArtifactMissing(opts.workdir))) {
        return observeEngineRun(opts, {
          status: "exit",
          exitCode: 0,
          stdout,
          message: "incomplete review: no artifact",
          infra: false,
          durationMs,
        });
      }
      return observeEngineRun(opts, { status: "ok", exitCode: 0, stdout, durationMs });
    }

    if (quota) {
      if (stderr) log(`[codex stderr] ${stderr}`);
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
      if (stderr) log(`[codex stderr] ${stderr}`);
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

    if (stderr) log(`[codex stderr] ${stderr}`);
    const providerMessage = looksLikeProviderUnavailable(signal) ? signal : `provider error: ${signal}`;
    const message = providerDown ? providerMessage || combined : engineExitMessage(exitCode, combined);
    return observeEngineRun(opts, {
      status: "exit",
      exitCode,
      stdout,
      message,
      infra: providerDown ? false : looksLikeInfraStderr(combined),
      durationMs,
    });
  } catch (err) {
    if (err instanceof EngineFailedError) throw err;
    if (err instanceof Error && (err.name === "AbortError" || err.message === "cancelled")) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeCodexAuthDeath(message)) {
      throw new EngineFailedError(providerAuthDeathMessage(), false, { auth: true });
    }
    if (looksLikeInfraStderr(message)) throw new EngineFailedError(message, true);
    throw err;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const codexEngine: Engine = runCodex;
