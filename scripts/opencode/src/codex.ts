import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { looksLikeProviderAuthDeath, providerAuthDeathForRun } from "./auth.ts";
import {
  type ChildGitProxy,
  childProxyGitConfigEnv,
  childProxyRequestFrom,
  extraEnvHasGitToken,
  isChildStrippedKey,
  startChildGitProxy,
} from "./child_git_proxy.ts";
import { limitText, readStreamLimited, scrubbedKey, stripAnsi } from "./claude.ts";
import { ensureCodexPublishedAuth } from "./codex_auth.ts";
import { exportCodexTrace } from "./codex_tracing.ts";
import { CodexStreamParser, type CodexTokens, codexTokensFrom } from "./codex_usage.ts";
import { observeEngineRun } from "./control_metrics.ts";
import {
  type Engine,
  EngineFailedError,
  type EngineResult,
  type EngineRunOptions,
  redactEngineText,
} from "./engine.ts";
import { CHILD_SCRATCH_DIR, ensureChildScratchDir, ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { codexThreadPath, codexThreadUsagePath, looksLikeProviderUnavailable } from "./fallback.ts";
import { resolveOpenCodePrompt } from "./git.ts";
import { stageWorkdirImageSkills } from "./image_skills.ts";
import { looksLikeInfraStderr } from "./infra.ts";
import { parseQuotaResetAtMs, QUOTA_MESSAGE, type QuotaClass } from "./quota.ts";
import { stageBaseSkillsIntoWorkdir, writeCodexReviewHome } from "./review_base.ts";
import { resolveReviewSpawnSandbox } from "./review_sandbox.ts";
import { CODEX_DEFAULT_EFFORT } from "./runners.ts";
import { recordCodexUsage } from "./token_metrics.ts";

export const CODEX_SANDBOX = "danger-full-access";
export const CODEX_APPROVAL = "never";
export const REVIEW_ARTIFACT = "JUMI_REVIEW.md";

const CODEX_STDERR_MAX_BYTES = 64_000;
const API_KEY_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;
const CODEX_AUTH_RE =
  /not logged in|please (?:sign in|log in)|authentication required|login required|no credentials|unauthorized|invalid api key|missing api key|chatgpt login|failed to refresh token|session has ended|refresh_token_invalidated|token_invalidated|token_revoked|access token could not be refreshed|authentication token has been invalidated|invalidated oauth token|refresh token was revoked/i;
const CODEX_USAGE_LIMIT_RE =
  /usage[_\s-]*limit|rate[\s_-]*limit|too many requests|\b429\b|insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|exhausted)|out of quota|hit your (?:usage|free|session) limit/i;

// The repository's `.codex` config, hooks, rules, and MCP servers load on every
// spawn, and a `-c` override outranks them, so what this list pins still holds.
function codexHardeningArgs(effort: string): string[] {
  return [
    "-c",
    `model_reasoning_effort="${effort}"`,
    "-c",
    'web_search="live"',
    "-c",
    "features.context_management.experimental_mode=false",
    // `--disable` is not a documented `codex exec` flag (it is a global flag
    // that does not propagate there), so these use the `-c features.*=false`
    // form `--disable` itself translates to.
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
    // The default excludes drop every `*KEY*`, `*SECRET*`, `*TOKEN*` name from
    // the agent's shell commands, which takes `GIT_CONFIG_KEY_*` and
    // `GIT_AUTH_TOKEN` with it and breaks every `git` call. Hide only the API
    // keys by exact name.
    "-c",
    "shell_environment_policy.ignore_default_excludes=true",
    "-c",
    `shell_environment_policy.exclude=${JSON.stringify(API_KEY_ENV)}`,
    "-c",
    'model_provider="openai"',
  ];
}

function codexConfigArgs(model: string, effort: string, isReview = false): string[] {
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
    // Workers run head hooks with an explicit bypass because nobody is there
    // to approve trust. Reviews mark the workdir untrusted in a review-only
    // CODEX_HOME instead, so project hooks never load and there is nothing to
    // bypass.
    ...(isReview ? [] : ["--dangerously-bypass-hook-trust"]),
    "--model",
    model,
    ...codexHardeningArgs(effort),
  ];
}

/**
 * Flags for `codex exec resume <id>`. `--color` is declared on the `exec`
 * command without `global = true`, so it must appear before the `resume`
 * subcommand — after it the real binary rejects it as an unexpected
 * argument. `--json`, `--skip-git-repo-check`, and `-c` are `global = true`
 * and therefore valid on either side (workers also pass
 * `--dangerously-bypass-hook-trust` there; reviews omit it because the
 * workdir is untrusted and no project hook loads); the globals stay before
 * `resume` with `--color` while the
 * `-c` overrides travel after the thread id. `--model` is made global by
 * upstream `mark_exec_global_args()` and is repeated too: `exec resume` takes
 * the model from this invocation's config, not from the stored thread, so
 * without it an extra turn would run on the binary's default model. Every
 * `-c` override is per-invocation config reloaded from scratch on each `exec resume`, not
 * per-thread state, so the full turn-1 hardening list is repeated here —
 * otherwise turn 2+ would silently turn web search back off and re-enable
 * experimental context management, undoing what turn 1 pinned.
 */
function codexResumePreArgs(model: string, isReview = false): string[] {
  return [
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    // Same review rule as the fresh spawn: untrusted workdir, no bypass flag.
    ...(isReview ? [] : ["--dangerously-bypass-hook-trust"]),
    "--model",
    model,
  ];
}

function codexResumeArgs(effort: string): string[] {
  return codexHardeningArgs(effort);
}

export function codexArgv(opts: EngineRunOptions, threadId?: string): string[] {
  const effort = opts.effort || CODEX_DEFAULT_EFFORT;
  const isReview = opts.trace?.kind === "review";
  if (opts.continueSession && threadId)
    return [
      "codex",
      "exec",
      ...codexResumePreArgs(opts.model, isReview),
      "resume",
      threadId,
      ...codexResumeArgs(effort),
      "-",
    ];
  const flags = codexConfigArgs(opts.model, effort, isReview);
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

/**
 * Log what the provider said on a non-ok exit: stderr as before, plus the
 * structured error events when they add anything. Usage limits and auth death
 * arrive as JSON `error` / `turn.failed` events on stdout with empty stderr,
 * so without this the provider's message (including its reset time) is lost.
 * Both strings arrive already redacted and size-capped; identical content
 * logs once.
 */
function logCodexFailure(log: (message: string) => void, stderr: string, errors: string): void {
  if (stderr) log(`[codex stderr] ${stderr}`);
  if (errors && errors !== stderr) log(`[codex errors] ${errors}`);
}

function redactApiKeys(text: string): string {
  let out = text;
  for (const key of API_KEY_ENV) {
    const value = process.env[key];
    if (value) out = out.split(value).join("[redacted]");
  }
  return out;
}

export function buildCodexEnv(
  opts: EngineRunOptions,
  tempRoot: string,
  proxyUrl?: string,
  reviewHome?: string
): Record<string, string> {
  const scratchDir = join(tempRoot, CHILD_SCRATCH_DIR);
  const base = opts.sanitizeEnv
    ? {
        HOME: opts.home ?? process.env.HOME ?? opts.workdir,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: scratchDir,
      }
    : ({ ...process.env, TMPDIR: scratchDir } as Record<string, string>);
  const env: Record<string, string> = { ...base };
  if (opts.sanitizeEnv && opts.extraEnv) {
    for (const [key, value] of Object.entries(opts.extraEnv)) {
      if (scrubbedKey(key)) continue;
      if ((API_KEY_ENV as readonly string[]).includes(key)) continue;
      if (key === "CODEX_HOME" || key === "XDG_CONFIG_HOME") continue;
      // Unconditional: a spawn that cannot proxy must still never see the
      // token or the old `$GIT_AUTH_TOKEN` credential helper (refused below).
      if (isChildStrippedKey(key)) continue;
      env[key] = value;
    }
  }
  if (proxyUrl && opts.sanitizeEnv) {
    const request = childProxyRequestFrom(opts.extraEnv, opts.trace);
    Object.assign(
      env,
      childProxyGitConfigEnv(proxyUrl, {
        forgeUrl: request?.forgeUrl ?? "https://localhost/",
        forgeHost: request?.forgeHost ?? "",
      })
    );
  }
  delete env.XDG_CONFIG_HOME;
  // Reviews run with a review-only CODEX_HOME that marks the workdir
  // untrusted, so the head's `.codex` config, hooks, rules, and MCP servers
  // never load. Workers keep the inherited HOME behavior (no override).
  if (reviewHome) env.CODEX_HOME = reviewHome;
  else delete env.CODEX_HOME;
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

/** The total `threadId` had reached when its last run ended, if one was saved. */
async function readThreadTotal(workdir: string, threadId: string): Promise<CodexTokens | undefined> {
  try {
    const saved: unknown = JSON.parse(await readFile(codexThreadUsagePath(workdir), "utf8"));
    if (typeof saved !== "object" || saved === null) return undefined;
    const { threadId: savedThread, tokens } = saved as { threadId?: unknown; tokens?: unknown };
    return savedThread === threadId ? codexTokensFrom(tokens) : undefined;
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
  if (opts.reviewMcp && opts.trace?.kind === "review") {
    log(
      "codex runner: review MCP server not wired in this release; using JUMI_REVIEW.md fallback (transition, not silent)"
    );
  }
  const prompt = await resolveOpenCodePrompt(opts);
  const tempRoot = join(opts.workdir, ".jumi-tmp");
  await mkdir(tempRoot, { recursive: true });
  await ensureChildScratchDir(opts.workdir);

  const tmpDir = await mkdtemp(join(tempRoot, "codex-prompt-"));
  const tmpPath = join(tmpDir, "prompt.txt");
  await writeFile(tmpPath, prompt);
  const startedAtMs = Date.now();
  let imageStaging: { cleanup: () => Promise<void> } | undefined;
  let baseStaging: { cleanup: () => Promise<void> } | undefined;
  let gitProxy: ChildGitProxy | undefined;
  let reviewHome: string | undefined;

  if (opts.abortSignal?.aborted) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw cancelled();
  }

  try {
    // Published token-only mode: when `CODEX_AUTH_FILE` names a file, validate
    // its `exp` against the run budget and symlink it into place before every
    // spawn, including resume. A rotated token reaches a running job because
    // Codex re-reads that path after a 401. Any failure is auth so the chain
    // hops; never run where a refresh race is possible.
    try {
      const home = opts.home ?? process.env.HOME ?? opts.workdir;
      await ensureCodexPublishedAuth({ home, timeoutMs: opts.timeoutMs });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log(`Codex published auth unusable: ${detail}`);
      const authMessage = providerAuthDeathForRun({ ...opts, type: "codex" });
      observeEngineRun(opts, {
        status: "exit",
        infra: false,
        auth: true,
        durationMs: Date.now() - startedAtMs,
        message: authMessage,
      });
      throw new EngineFailedError(authMessage, false, { auth: true });
    }
    const isReview = opts.trace?.kind === "review";
    if (isReview) {
      // Review-only home: the workdir is untrusted, so the head's `.codex`
      // config, hooks, rules, and MCP servers never load. The home lives
      // under the spawn's temp root (outside the tracked checkout). Auth
      // still comes from the real HOME: link it in when present so the
      // review keeps the parent's credential without copying the grant.
      reviewHome = join(tmpDir, "codex-home");
      await writeCodexReviewHome(reviewHome, opts.workdir);
      try {
        const home = opts.home ?? process.env.HOME ?? opts.workdir;
        const authSrc = join(home, ".codex", "auth.json");
        const authDst = join(reviewHome, "auth.json");
        const { readlink, symlink } = await import("node:fs/promises");
        const target = await readlink(authSrc).catch(() => undefined);
        if (target) await symlink(target, authDst).catch(() => undefined);
        else {
          const { readFile, writeFile } = await import("node:fs/promises");
          const raw = await readFile(authSrc, "utf8").catch(() => undefined);
          if (raw) await writeFile(authDst, raw, { mode: 0o600 }).catch(() => undefined);
        }
      } catch {
        // Best-effort: API-key and local modes have no HOME auth file.
      }
      // Base skills replace the head's for the duration of the spawn. The
      // head's `.codex` stays on disk (readable as diff content) but never
      // loads (untrusted above); skills have no trust gate, so they are
      // hidden here and restored on cleanup.
      if (opts.baseInstructionsDir) {
        baseStaging = await stageBaseSkillsIntoWorkdir(opts.workdir, opts.baseInstructionsDir, log);
      }
    }
    // Shared image skills: review gets the reviewer skill, workers get the
    // worker skill. Staged into the repo-local `.agents/skills` Codex scans,
    // cleaned up before return so the tree stays clean.
    imageStaging = await stageWorkdirImageSkills(opts.workdir, opts.trace?.kind);
    const threadId = opts.continueSession ? await readThreadId(opts.workdir) : undefined;
    const args = codexArgv(opts, threadId);
    if (opts.sanitizeEnv) {
      const request = childProxyRequestFrom(opts.extraEnv, opts.trace);
      if (request) {
        try {
          gitProxy = await startChildGitProxy(request);
        } catch (err) {
          throw new EngineFailedError(
            `codex spawn refused: cannot start git credential proxy: ${err instanceof Error ? err.message : String(err)}`,
            true
          );
        }
      } else if (extraEnvHasGitToken(opts.extraEnv)) {
        throw new EngineFailedError("codex spawn refused: git token present but no credential proxy available", true);
      }
    }
    const codexEnv = buildCodexEnv(opts, tempRoot, gitProxy?.url, reviewHome);
    // Review spawns run confined: the wrapper argv fails closed when
    // Landlock is unavailable, so pull code never runs unsandboxed.
    const codexSpawnArgv = resolveReviewSpawnSandbox(opts, args, codexEnv, log).argv;
    const proc = (() => {
      try {
        return Bun.spawn(codexSpawnArgv, {
          cwd: opts.workdir,
          stdin: Bun.file(tmpPath),
          stdout: "pipe",
          stderr: "pipe",
          env: codexEnv,
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

    const parser = new CodexStreamParser(threadId ? await readThreadTotal(opts.workdir, threadId) : undefined);
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
    const threadTotal = parser.threadTotal();
    const usageThread = newThread ?? threadId;
    if (threadTotal && usageThread) {
      const saved = JSON.stringify({ threadId: usageThread, tokens: threadTotal });
      await writeFile(codexThreadUsagePath(opts.workdir), `${saved}\n`).catch(() => {});
    }

    const stdoutResult = limitText(parser.text(), "codex output", opts.maxOutputBytes);
    const stdout = redactEngineText(redactApiKeys(stripAnsi(stdoutResult.text).trim()), opts);
    const stderr = redactEngineText(redactApiKeys(stripAnsi(stderrResult.text).trim()), opts);
    const errorsResult = limitText(parser.errors(), "codex errors", CODEX_STDERR_MAX_BYTES);
    const errors = redactEngineText(redactApiKeys(stripAnsi(errorsResult.text).trim()), opts);
    const signal = [stderr, errors].filter(Boolean).join("\n");
    const combined = [stderr, stdout].filter(Boolean).join("\n");
    const durationMs = Date.now() - startedAtMs;
    const quota = !timedOut ? looksLikeCodexUsageLimit(signal) : undefined;
    const auth = !quota && !timedOut && exitCode !== 143 && looksLikeCodexAuthDeath(signal);
    const providerDown = !quota && !auth && !timedOut && exitCode !== 143 && looksLikeProviderUnavailable(signal);

    if (opts.abortSignal?.aborted) throw cancelled();

    if (runError) {
      const message = redactEngineText(runError instanceof Error ? runError.message : String(runError), opts);
      if (auth || looksLikeCodexAuthDeath(message)) {
        logCodexFailure(log, stderr, errors);
        const authMessage = providerAuthDeathForRun({ ...opts, type: "codex" });
        observeEngineRun(opts, { status: "exit", infra: false, auth: true, durationMs, message: authMessage });
        throw new EngineFailedError(authMessage, false, { auth: true });
      }
      const isInfra = looksLikeInfraStderr(message);
      logCodexFailure(log, stderr, errors);
      observeEngineRun(opts, { status: "exit", infra: isInfra, durationMs, message });
      throw new EngineFailedError(message, isInfra);
    }

    if (timedOut) {
      logCodexFailure(log, stderr, errors);
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
      // Fails closed like agy's empty SUCCESS: a non-ok result, so the parent
      // fails the job instead of running its write-only retry turn.
      if (opts.trace?.kind === "review" && (await reviewArtifactMissing(opts.workdir))) {
        if (errors && errors !== stderr) log(`[codex errors] ${errors}`);
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
      logCodexFailure(log, stderr, errors);
      const quotaResetAtMs = parseQuotaResetAtMs(signal);
      return observeEngineRun(opts, {
        status: "stuck",
        exitCode,
        stdout,
        message: QUOTA_MESSAGE,
        infra: false,
        durationMs,
        quota,
        ...(quotaResetAtMs != null ? { quotaResetAtMs } : {}),
      });
    }

    if (auth) {
      logCodexFailure(log, stderr, errors);
      return observeEngineRun(opts, {
        status: "exit",
        exitCode,
        stdout,
        message: providerAuthDeathForRun({ ...opts, type: "codex" }),
        infra: false,
        auth: true,
        durationMs,
      });
    }

    logCodexFailure(log, stderr, errors);
    // The message feeds the chain's hop classifier, so it is built from
    // `signal` only: agent message text stays in `stdout`.
    const message = providerDown ? signal : engineExitMessage(exitCode, signal);
    return observeEngineRun(opts, {
      status: "exit",
      exitCode,
      stdout,
      message,
      infra: providerDown ? false : looksLikeInfraStderr(signal),
      durationMs,
    });
  } catch (err) {
    if (err instanceof EngineFailedError) throw err;
    if (err instanceof Error && (err.name === "AbortError" || err.message === "cancelled")) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeCodexAuthDeath(message)) {
      throw new EngineFailedError(providerAuthDeathForRun({ ...opts, type: "codex" }), false, { auth: true });
    }
    if (looksLikeInfraStderr(message)) throw new EngineFailedError(message, true);
    throw err;
  } finally {
    await imageStaging?.cleanup().catch(() => undefined);
    await baseStaging?.cleanup().catch(() => undefined);
    await gitProxy?.close().catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const codexEngine: Engine = runCodex;
