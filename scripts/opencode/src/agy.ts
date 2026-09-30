import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgyStreamParser } from "./agy_usage.ts";
import { looksLikeProviderAuthDeath, providerAuthDeathMessage } from "./auth.ts";
import { limitText, readStreamLimited, scrubbedKey, stripAnsi } from "./claude.ts";
import { observeEngineRun } from "./control_metrics.ts";
import { logDiagnostic } from "./diagnostics.ts";
import {
  type Engine,
  EngineFailedError,
  type EngineResult,
  type EngineRunOptions,
  redactEngineText,
} from "./engine.ts";
import { ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { agyConversationPath } from "./fallback.ts";
import { agyReadUrlDeny, forgeDenyHost } from "./forge_webfetch.ts";
import { resolveOpenCodePrompt } from "./git.ts";
import { looksLikeInfraStderr } from "./infra.ts";
import { QUOTA_MESSAGE, type QuotaClass } from "./quota.ts";
import { recordAgyUsage } from "./token_metrics.ts";

/** stream-json keeps per-step usage even when the child is killed before `result`. */
export const AGY_OUTPUT_FORMAT = "stream-json";
/** Unattended auto-approve. Without it print mode soft-denies tools and can return an empty SUCCESS. */
export const AGY_SKIP_PERMISSIONS = "--dangerously-skip-permissions";
/** Leave the child time to emit its `result` envelope before the parent kill. */
export const AGY_PRINT_TIMEOUT_MARGIN_MS = 30_000;
/** Linux MAX_ARG_STRLEN is 128 KiB; longer prompts go through a file pointer. */
export const AGY_ARGV_PROMPT_MAX_BYTES = 96_000;
export const AGY_SETTINGS_DIR = join(".gemini", "antigravity-cli");
/** Only seeded when absent: never overwrite a logged-in settings file. */
export const AGY_SEED_SETTINGS = { enableTelemetry: false, useG1Credits: false } as const;
/**
 * Workspace customization roots the CLI reads. Each can carry `hooks.json`,
 * plugins (which bundle their own hooks), rules, workflows, MCP config, and
 * `skills/`. A reviewer keeps only `skills/`.
 */
export const AGY_PROJECT_AGENT_NAMES = [".agents", ".agent", "_agents", "_agent"] as const;
const AGY_SKILLS_DIR = "skills";

const AGY_STDERR_MAX_BYTES = 64_000;
const AGY_AUTH_RE = /Please sign in|authentication required/i;

/**
 * Resetting-quota signal for the Antigravity runner, from that runner's own
 * result and stderr the same way Claude classifies its usage limit.
 *
 * The live Antigravity quota envelope is not known yet, so resource-exhausted
 * and 429-class results (429, rate limit, too many requests) are treated as
 * resetting quota rather than a terminal failure. The `agy_error` diagnostic
 * already records the exact envelope verbatim for the first live miss.
 * Never a hard latch: an unknown 429 must wait, not park.
 */
const AGY_QUOTA_RE = /resource[_\s-]*exhausted|\b429\b|rate[\s_-]*limit|too many requests/i;

export function inspectAgyQuotaLimit(text: string | null | undefined): QuotaClass | undefined {
  if (!text || !AGY_QUOTA_RE.test(text)) return undefined;
  return "resetting";
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

interface StashedAgyRoot {
  name: string;
  /** `skills/` was put back in a fresh root in the workdir for this spawn. */
  skills: boolean;
}

/**
 * Move every checkout customization root out of the workdir, then put back
 * only its `skills/` in a fresh root. Skills carry no hooks in this CLI; hooks
 * live in the root's `hooks.json` and in plugins, which stay stashed.
 * Records into `moved` as it goes, so a throw part-way still restores.
 */
async function stashAgyProjectAgents(workdir: string, stashRoot: string, moved: StashedAgyRoot[]): Promise<void> {
  for (const name of AGY_PROJECT_AGENT_NAMES) {
    try {
      await rename(join(workdir, name), join(stashRoot, name));
    } catch (err) {
      if (!isEnoent(err)) throw err;
      continue;
    }
    const root: StashedAgyRoot = { name, skills: false };
    moved.push(root);
    if (!(await lstat(join(stashRoot, name))).isDirectory()) continue;
    try {
      await lstat(join(stashRoot, name, AGY_SKILLS_DIR));
    } catch (err) {
      if (!isEnoent(err)) throw err;
      continue;
    }
    root.skills = true;
    await mkdir(join(workdir, name));
    await rename(join(stashRoot, name, AGY_SKILLS_DIR), join(workdir, name, AGY_SKILLS_DIR));
  }
}

async function restoreAgyProjectAgents(workdir: string, stashRoot: string, moved: StashedAgyRoot[]): Promise<void> {
  for (const { name, skills } of moved) {
    if (skills) {
      try {
        await rename(join(workdir, name, AGY_SKILLS_DIR), join(stashRoot, name, AGY_SKILLS_DIR));
      } catch (err) {
        // Anything but "the child removed it" leaves the skills where they are
        // rather than deleting them with the root below.
        if (!isEnoent(err)) continue;
      }
      // Only the root this spawn made; whatever the child wrote into it goes.
      await rm(join(workdir, name), { recursive: true, force: true }).catch(() => {});
    }
    await rename(join(stashRoot, name), join(workdir, name)).catch(() => {});
  }
}

function agyEnv(opts: EngineRunOptions, tempRoot: string): Record<string, string> {
  if (!opts.sanitizeEnv) {
    const env = { ...process.env, TMPDIR: tempRoot } as Record<string, string>;
    delete env.XDG_CONFIG_HOME;
    return env;
  }

  const env: Record<string, string> = {
    HOME: opts.home ?? process.env.HOME ?? opts.workdir,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tempRoot,
  };
  if (opts.extraEnv) {
    for (const [key, value] of Object.entries(opts.extraEnv)) {
      if (scrubbedKey(key)) continue;
      env[key] = value;
    }
  }
  return env;
}

/** Hostname safe to embed in `read_url(host)`. Anything else fails the spawn closed. */
export function agyForgeDenyHostOk(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && !host.includes("..");
}

/**
 * Add the forge `read_url` deny without dropping other settings. An allow of
 * the same host does not win: the CLI evaluates deny before allow, including
 * under `--dangerously-skip-permissions`.
 */
export function mergeAgyForgeDeny(settings: unknown, host: string): Record<string, unknown> {
  if (!agyForgeDenyHostOk(host)) {
    throw new Error(`refusing forge read_url deny for host ${JSON.stringify(host)}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("agy settings.json is not an object");
  }
  const next = { ...(settings as Record<string, unknown>) };
  const raw = next.permissions;
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("agy settings.json permissions is not an object");
  }
  const permissions = { ...((raw as Record<string, unknown> | undefined) ?? {}) };
  if (permissions.deny != null && !Array.isArray(permissions.deny)) {
    throw new Error("agy settings.json permissions.deny is not a list");
  }
  const deny = Array.isArray(permissions.deny) ? permissions.deny.filter((entry) => typeof entry === "string") : [];
  const rule = agyReadUrlDeny(host);
  if (!deny.includes(rule)) deny.push(rule);
  permissions.deny = deny;
  next.permissions = permissions;
  return next;
}

/**
 * Install the forge read_url deny in the settings file this spawn's HOME will
 * load. Existing keys stay (a logged-in settings file is not replaced). Throws
 * instead of returning when the rule cannot be installed: the caller must not
 * spawn.
 */
export async function ensureAgyForgeDeny(home: string, host: string): Promise<void> {
  if (!home) throw new EngineFailedError("agy spawn refused: no HOME for the forge read_url deny", false);
  const dir = join(home, AGY_SETTINGS_DIR);
  const path = join(dir, "settings.json");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let raw: string | undefined;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    const settings = raw == null ? { ...AGY_SEED_SETTINGS } : JSON.parse(raw);
    const next = mergeAgyForgeDeny(settings, host);
    const tmp = join(dir, `.settings.json.${process.pid}.tmp`);
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    if (err instanceof EngineFailedError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new EngineFailedError(`agy spawn refused: cannot install forge read_url deny: ${reason}`, false);
  }
}

/**
 * Best-effort: write telemetry-off / credit-overages-off settings only when the
 * CLI has no settings file yet. `agy models` may rewrite it, so this is not a
 * runtime assert. The forge read_url deny is installed separately and is not
 * best-effort.
 */
export async function seedAgySettings(home: string | undefined): Promise<void> {
  if (!home) return;
  const dir = join(home, AGY_SETTINGS_DIR);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "settings.json"), `${JSON.stringify(AGY_SEED_SETTINGS, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    return;
  }
}

/**
 * The print-mode prompt is never allowed to start with `/`, so no slash
 * command or checkout skill is expanded from it.
 */
export function agyPromptArg(prompt: string): string {
  return prompt.trimStart().startsWith("/") ? `Task:\n${prompt}` : prompt;
}

export function agyPrintTimeout(timeoutMs: number | undefined): string | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  const ms = timeoutMs > AGY_PRINT_TIMEOUT_MARGIN_MS * 2 ? timeoutMs - AGY_PRINT_TIMEOUT_MARGIN_MS : timeoutMs;
  return `${Math.max(1, Math.floor(ms / 1000))}s`;
}

export function agyArgv(opts: EngineRunOptions, prompt: string, conversationId?: string): string[] {
  const args = ["agy", "-p", agyPromptArg(prompt), "--output-format", AGY_OUTPUT_FORMAT, AGY_SKIP_PERMISSIONS];
  args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  const printTimeout = agyPrintTimeout(opts.timeoutMs);
  if (printTimeout) args.push("--print-timeout", printTimeout);
  if (opts.continueSession && conversationId) args.push("--conversation", conversationId);
  return args;
}

export function looksLikeAgyAuthDeath(text: string): boolean {
  return AGY_AUTH_RE.test(text) || looksLikeProviderAuthDeath(text);
}

async function readConversationId(workdir: string): Promise<string | undefined> {
  try {
    return (await readFile(agyConversationPath(workdir), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readAgyStdout(stream: ReadableStream<Uint8Array>, parser: AgyStreamParser): Promise<void> {
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

function engineExitMessage(exitCode: number | null, detail: string): string {
  return `agy exited with code ${exitCode}${detail ? `:\n${detail}` : ""}`;
}

/** Why a clean exit is not a completed run, or undefined when it is. */
export function agyIncompleteReason(parser: AgyStreamParser): string | undefined {
  const result = parser.result();
  if (!result) return undefined;
  if (result.status && result.status.toUpperCase() !== "SUCCESS") {
    return `agy result status ${result.status}${result.error ? `: ${result.error}` : ""}`;
  }
  if (!result.response?.trim() && result.deniedActions.length > 0) {
    return `agy returned an empty response with denied actions: ${result.deniedActions.join(", ")}`;
  }
  return undefined;
}

function cancelled(): Error {
  const err = new Error("cancelled");
  err.name = "AbortError";
  return err;
}

export async function runAgy(opts: EngineRunOptions): Promise<EngineResult> {
  const log = opts.logger ?? ((message: string) => console.log(message));
  await ensureEngineScratchIgnored(opts.workdir);
  const prompt = await resolveOpenCodePrompt(opts);
  const tempRoot = join(opts.workdir, ".jumi-tmp");
  await mkdir(tempRoot, { recursive: true });

  const tmpDir = await mkdtemp(join(tempRoot, "agy-prompt-"));
  const startedAtMs = Date.now();
  const stashRoot = join(tmpDir, "project-agents");
  const movedAgents: StashedAgyRoot[] = [];

  if (opts.abortSignal?.aborted) {
    // Best-effort: a temp dir that will not go must not replace the engine result (#129).
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw cancelled();
  }

  try {
    let promptArg = prompt;
    if (new TextEncoder().encode(prompt).byteLength > AGY_ARGV_PROMPT_MAX_BYTES) {
      const promptPath = join(tmpDir, "prompt.txt");
      await writeFile(promptPath, prompt);
      promptArg = `Read ${promptPath} and follow the instructions in it exactly.`;
    }
    const env = agyEnv(opts, tempRoot);
    const home = env.HOME;
    if (!home) throw new EngineFailedError("agy spawn refused: no HOME for the forge read_url deny", false);
    await seedAgySettings(home);
    // After extraEnv, so a job-supplied HOME is the file the child will load,
    // and a settings file that cannot take the deny fails the spawn closed.
    await ensureAgyForgeDeny(home, forgeDenyHost(opts.extraEnv));
    const conversationId = opts.continueSession ? await readConversationId(opts.workdir) : undefined;
    const args = agyArgv(opts, promptArg, conversationId);
    if (opts.trace?.kind === "review") {
      await mkdir(stashRoot, { recursive: true });
      await stashAgyProjectAgents(opts.workdir, stashRoot, movedAgents);
    }
    const proc = (() => {
      try {
        return Bun.spawn(args, {
          cwd: opts.workdir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env,
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

    const parser = new AgyStreamParser(opts.model);
    let stderrResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let exitCode: number | null = null;
    let runError: unknown;
    try {
      [, stderrResult, exitCode] = await Promise.all([
        readAgyStdout(proc.stdout, parser),
        readStreamLimited(proc.stderr, "agy stderr", AGY_STDERR_MAX_BYTES, "tail"),
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
    recordAgyUsage(parser.usage());
    const newConversation = parser.conversationId();
    if (newConversation) await writeFile(agyConversationPath(opts.workdir), `${newConversation}\n`).catch(() => {});

    const stdoutResult = limitText(parser.text(), "agy output", opts.maxOutputBytes);
    const stdout = redactEngineText(stripAnsi(stdoutResult.text).trim(), opts);
    const stderr = redactEngineText(stripAnsi(stderrResult.text).trim(), opts);
    const envelope = parser.result();
    const combined = [stderr, stdout].filter(Boolean).join("\n");
    const durationMs = Date.now() - startedAtMs;
    const quota =
      !timedOut && exitCode !== 143
        ? inspectAgyQuotaLimit([combined, envelope?.error].filter(Boolean).join("\n"))
        : undefined;
    const auth =
      !quota &&
      !timedOut &&
      exitCode !== 143 &&
      looksLikeAgyAuthDeath([stderr, envelope?.error].filter(Boolean).join("\n"));

    if (opts.abortSignal?.aborted) throw cancelled();

    if (runError) {
      const message = redactEngineText(runError instanceof Error ? runError.message : String(runError), opts);
      if (auth || looksLikeAgyAuthDeath(message)) {
        if (stderr) log(`[agy stderr] ${stderr}`);
        const authMessage = providerAuthDeathMessage();
        observeEngineRun(opts, { status: "exit", infra: false, auth: true, durationMs, message: authMessage });
        throw new EngineFailedError(authMessage, false, { auth: true });
      }
      const isInfra = looksLikeInfraStderr(message);
      observeEngineRun(opts, { status: "exit", infra: isInfra, durationMs, message });
      throw new EngineFailedError(message, isInfra);
    }

    if (stderr) log(`[agy stderr] ${stderr}`);
    if (exitCode !== 0 || envelope?.error) {
      // Record the exact envelope so the first live quota/5xx miss is known verbatim.
      logDiagnostic(log, "agy_error", {
        exit_code: exitCode,
        status: envelope?.status ?? null,
        error: envelope?.error ?? null,
      });
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

    const incomplete = exitCode === 0 ? agyIncompleteReason(parser) : undefined;
    if (exitCode === 0 && !incomplete) return observeEngineRun(opts, { status: "ok", exitCode: 0, stdout, durationMs });

    if (quota) {
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

    if (incomplete) {
      return observeEngineRun(opts, {
        status: "exit",
        exitCode,
        stdout,
        message: [incomplete, combined].filter(Boolean).join("\n"),
        infra: false,
        durationMs,
      });
    }

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
    if (looksLikeAgyAuthDeath(message)) {
      throw new EngineFailedError(providerAuthDeathMessage(), false, { auth: true });
    }
    if (looksLikeInfraStderr(message)) throw new EngineFailedError(message, true);
    throw err;
  } finally {
    await restoreAgyProjectAgents(opts.workdir, stashRoot, movedAgents);
    // Best-effort: a temp dir that will not go must not replace the engine result (#129).
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const agyEngine: Engine = runAgy;
