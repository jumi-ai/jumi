import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineRunOptions } from "./engine.ts";
import { EngineFailedError } from "./engine.ts";
import { childScratchDir } from "./engine_scratch.ts";

/**
 * Landlock sandbox for review spawns (jumi#531, part 2 jumi#550).
 *
 * Part-1 wrapped the whole agent (single domain). Part-2 keeps the agent
 * process outside the sandbox: the agent needs its HOME login and the
 * per-spawn MCP bearer token, which live in files the model must never read.
 * Every shell or command the model executes runs in its own Landlock domain
 * that cannot see the agent's secrets.
 *
 * Shape:
 * - Harness temp root (prompt file, MCP configs, XDG dirs, session DB) lives
 *   outside the checkout (`os.tmpdir()/jumi-review-*`), created per spawn by
 *   `makeReviewHarnessTempRoot`. It is never in the shell allow-list.
 * - Shell rules (`reviewShellSandboxRules`) grant RW on the checkout and the
 *   scratch dir only, RO on toolchains/system paths *without* `/tmp` (so the
 *   outside temp under the shared tmpdir stays unreachable), and no HOME.
 * - Shells get their own HOME/XDG dirs under scratch
 *   (`sandboxedShellHome`), so tools needing a writable HOME still work.
 * - The wrapper is reused (`review_sandbox.py`); only the policy differs.
 * - Provider keys are scrubbed from shell env via the `env -u` prefix in
 *   `reviewShellWrapperPrefix`, so a shell that prints its env learns nothing.
 * - Per-runner wiring is Jumi-owned (never from the checkout): OpenCode via a
 *   Jumi-owned `tool.execute.before` plugin for `bash`, Claude via a
 *   Jumi-owned `PreToolUse` hook (`updatedInput` rewrite), Codex/Agy via
 *   their `PreToolUse` equivalents. A runner that cannot be wrapped refuses
 *   instead of running unsandboxed.
 *
 * Filesystem allow-lists live here; environment scrubbing stays in the
 * per-runner builders, and this module audits the built agent env before
 * spawn so a token that slipped through fails the spawn closed.
 */

export const REVIEW_SANDBOX_MIN_ABI = 6;
export const REVIEW_SANDBOX_WRAPPER_ENV = "JUMI_REVIEW_SANDBOX_WRAPPER";
export const ALLOW_UNSANDBOXED_REVIEWS_ENV = "JUMI_ALLOW_UNSANDBOXED_REVIEWS";
export const SANDBOX_UNAVAILABLE_EXIT = 100;

const WRAPPER_FILE = "review_sandbox.py";

/** System paths a review agent may read (and traverse) but never write. */
export const REVIEW_SANDBOX_READ_ONLY_SYSTEM: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/opt",
  "/etc",
  "/proc",
  "/sys",
  "/tmp",
  "/app",
];

/**
 * System paths a sandboxed *shell* may read. Same as the agent set without
 * `/tmp`: the harness temp root lives under the shared tmpdir
 * (`os.tmpdir()/jumi-review-*`, outside the checkout), and Landlock unions
 * rights from every matching rule — keeping `/tmp` readable would keep the
 * outside temp and its MCP bearer-token configs readable too. Shells get
 * `TMPDIR` pointing at scratch, so tools that need temp space still work.
 */
export const REVIEW_SHELL_READ_ONLY_SYSTEM: readonly string[] = REVIEW_SANDBOX_READ_ONLY_SYSTEM.filter(
  (path) => path !== "/tmp"
);

/** Provider keys a review agent holds but its shells must never see. */
export const REVIEW_SHELL_SCRUB_KEYS: readonly string[] = [
  "OPENCODE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "XAI_API_KEY",
];

/** Sandboxed HOME for model-run shells, under scratch so tools can still write. */
export function sandboxedShellHome(scratchDir: string): string {
  return join(scratchDir, "sandbox-home");
}

/** XDG/HOME/TMPDIR overrides for a sandboxed shell. All paths stay in scratch. */
export function sandboxedShellEnv(scratchDir: string): Record<string, string> {
  const home = sandboxedShellHome(scratchDir);
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: scratchDir,
  };
}

/** Per-spawn harness temp root outside the checkout (holds MCP token configs). */
export async function makeReviewHarnessTempRoot(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  // Fixed `/tmp` parent, never `os.tmpdir()`: the implement/review harness
  // points `TMPDIR` at `<checkout>/.jumi-tmp/scratch`, and `os.tmpdir()`
  // follows `TMPDIR` — using it would put the token configs back inside the
  // checkout the shells can read. `/tmp` is outside every checkout, and the
  // shell policy omits `/tmp` so the outside temp stays unreachable.
  return mkdtemp("/tmp/jumi-review-");
}

/** Prefix (`jumi-review-`) identifying harness temp roots for deny checks. */
export const REVIEW_HARNESS_TEMP_PREFIX = "jumi-review-";

/** Device paths that also need /dev/null-style writes (tools open O_RDWR). Never grants creation. */
export const REVIEW_SANDBOX_DEVICE_PATHS: readonly string[] = ["/dev"];

export interface ReviewSandboxRules {
  readWrite: string[];
  readOnly: string[];
  devices: string[];
}

export interface ReviewSandboxRuleInput {
  workdir: string;
  scratchDir?: string;
  homeDir?: string;
  gitDirs?: string[];
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
 * Best-effort locations of the git dir behind `workdir`. Linked worktrees
 * keep objects outside the checkout (`.git` file with `gitdir: ...`), and a
 * sandboxed `git` needs both the worktree dir (HEAD, index, refs/worktree
 * state) and the common dir (objects) in the allow-list. Returns [] when
 * `.git` is a directory inside the checkout (already covered) or unreadable
 * (the spawn then fails loudly on first git use, never silently unsandboxed).
 */
export function resolveWorktreeGitDirsSync(workdir: string): string[] {
  let dotGit: string;
  try {
    dotGit = join(workdir, ".git");
    const text = readFileSync(dotGit, "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!match?.[1]) return [];
    const gitdir = resolve(workdir, match[1]);
    try {
      const commondir = readFileSync(join(gitdir, "commondir"), "utf8").trim();
      if (commondir) return [gitdir, resolve(gitdir, commondir)];
    } catch {
      // No commondir: the gitdir itself holds the objects.
    }
    return [gitdir];
  } catch {
    return [];
  }
}

export function reviewSandboxRules(input: ReviewSandboxRuleInput): ReviewSandboxRules {
  const scratchDir = input.scratchDir ?? childScratchDir(input.workdir);
  return {
    readWrite: dedupeAbsolute([input.workdir, scratchDir, input.homeDir, ...(input.gitDirs ?? [])]),
    readOnly: [...REVIEW_SANDBOX_READ_ONLY_SYSTEM],
    devices: [...REVIEW_SANDBOX_DEVICE_PATHS],
  };
}

export interface ReviewShellSandboxRuleInput {
  workdir: string;
  scratchDir?: string;
  gitDirs?: string[];
}

/**
 * Filesystem policy for one model-run shell. RW on the checkout and scratch
 * only; RO on toolchains/system paths without `/tmp`; no harness temp root,
 * no agent HOME, no MCP config. The harness temp root lives outside the
 * checkout (see `makeReviewHarnessTempRoot`), so omitting it here denies it.
 */
export function reviewShellSandboxRules(input: ReviewShellSandboxRuleInput): ReviewSandboxRules {
  const scratchDir = input.scratchDir ?? childScratchDir(input.workdir);
  return {
    readWrite: dedupeAbsolute([input.workdir, scratchDir, ...(input.gitDirs ?? [])]),
    readOnly: [...REVIEW_SHELL_READ_ONLY_SYSTEM],
    devices: [...REVIEW_SANDBOX_DEVICE_PATHS],
  };
}

/** Single-quote `arg` for `sh -c`. */
export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface ShellWrapperPrefixInput {
  wrapperPath?: string;
  sandboxHome?: string;
  scratchDir?: string;
}

/**
 * Shell prefix that scrubs provider keys, points HOME/XDG/TMPDIR at scratch,
 * and execs the Landlock wrapper. Prepend to `sh -c <escaped original>`.
 * The `env -u` list removes the agent's provider keys from the shell env so a
 * `printenv` in pull code learns nothing; HOME override hides the agent's
 * login configs.
 */
export function reviewShellWrapperPrefix(
  rules: ReviewSandboxRules,
  input: ShellWrapperPrefixInput = {},
  env: Record<string, string | undefined> = process.env
): string {
  const wrapper = input.wrapperPath ?? reviewSandboxWrapperPath(env);
  const parts: string[] = ["env"];
  for (const key of REVIEW_SHELL_SCRUB_KEYS) parts.push("-u", key);
  if (input.sandboxHome && input.scratchDir) {
    const shellEnv = sandboxedShellEnv(input.scratchDir);
    // HOME is derived from scratchDir; sandboxHome param pins the exact dir
    // the parent created (same value by construction).
    void input.sandboxHome;
    for (const [key, value] of Object.entries(shellEnv)) parts.push(`${key}=${value}`);
  } else if (input.scratchDir) {
    const shellEnv = sandboxedShellEnv(input.scratchDir);
    for (const [key, value] of Object.entries(shellEnv)) parts.push(`${key}=${value}`);
  }
  parts.push(wrapper);
  const flagParts: string[] = [];
  pushFlag(flagParts, "--ro", rules.readOnly);
  pushFlag(flagParts, "--dev", rules.devices);
  pushFlag(flagParts, "--rw", rules.readWrite);
  return [...parts, ...flagParts, "--"].map((part) => (part.includes(" ") ? shellEscape(part) : part)).join(" ");
}

/**
 * Wrap one shell command string so it runs inside the shell Landlock domain
 * with a scrubbed env. `original` is the model's `Bash` command text.
 */
export function wrapShellCommand(
  original: string,
  rules: ReviewSandboxRules,
  input: ShellWrapperPrefixInput = {},
  env: Record<string, string | undefined> = process.env
): string {
  return `${reviewShellWrapperPrefix(rules, input, env)} sh -c ${shellEscape(original)}`;
}

/** Full wrapper argv for one sandboxed shell (used by tests and the probe). */
export function reviewShellSandboxArgv(
  rules: ReviewSandboxRules,
  shellArgv: readonly string[],
  wrapperPath?: string
): string[] {
  return reviewSandboxArgv(rules, shellArgv, wrapperPath);
}

/** Absolute path of the wrapper script; overridable for tests. Never a value, only a path. */
export function reviewSandboxWrapperPath(env: Record<string, string | undefined> = process.env): string {
  const override = env[REVIEW_SANDBOX_WRAPPER_ENV]?.trim();
  if (override) return override;
  return join(dirname(fileURLToPath(import.meta.url)), WRAPPER_FILE);
}

/** Deployer escape hatch for rollout. Off unless exactly `"1"`; when on, every bypass is logged loudly. */
export function allowUnsandboxedReviews(env: Record<string, string | undefined> = process.env): boolean {
  return env[ALLOW_UNSANDBOXED_REVIEWS_ENV] === "1";
}

function pushFlag(argv: string[], flag: string, paths: readonly string[]): void {
  for (const path of paths) argv.push(flag, path);
}

/**
 * Full wrapper argv for an agent spawn. The `--` separator is always the
 * last wrapper flag so a fake wrapper in tests can passthrough-exec whatever
 * follows it, and a reader can see where policy ends and the agent begins.
 *
 * The agent binary itself is resolved to an absolute path in the parent
 * (pre-sandbox): an in-sandbox `execvp` PATH search would silently skip a
 * denied entry and run whatever same-named binary comes next on PATH, so the parent
 * pins exactly which file the wrapper execs. Unresolvable names stay bare
 * and fail loudly in the wrapper instead.
 */
export function reviewSandboxArgv(
  rules: ReviewSandboxRules,
  agentArgv: readonly string[],
  wrapperPath?: string
): string[] {
  const argv = [wrapperPath ?? reviewSandboxWrapperPath()];
  pushFlag(argv, "--ro", rules.readOnly);
  pushFlag(argv, "--dev", rules.devices);
  pushFlag(argv, "--rw", rules.readWrite);
  argv.push("--", ...resolveAgentBin(agentArgv));
  return argv;
}

/** Absolute agent binary when it is a bare name on the parent PATH. */
export function resolveAgentBin(
  agentArgv: readonly string[],
  env: Record<string, string | undefined> = process.env
): string[] {
  const [bin, ...rest] = agentArgv;
  if (!bin || bin.includes("/")) return [...agentArgv];
  const found = findOnPath(bin, env.PATH);
  if (!found) return [...agentArgv];
  return [found, ...rest];
}

/**
 * First executable `name` on `pathList`, checked live (unlike `Bun.which`,
 * which does not see PATH entries added after process start, exactly what
 * the test fakes — and a deployer wrapper dir — rely on).
 */
export function findOnPath(name: string, pathList: string | undefined): string | undefined {
  if (!name || name.includes("/") || !pathList) return undefined;
  for (const dir of pathList.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export interface ReviewSandboxProbe {
  available: boolean;
  abi?: number;
  reason?: string;
}

let probeOverride: ReviewSandboxProbe | undefined;

/** Test seam: force the probe to report `probe` (or clear with undefined). */
export function setReviewSandboxProbeForTests(probe: ReviewSandboxProbe | undefined): void {
  probeOverride = probe;
}

function probeWrapper(wrapperPath: string): ReviewSandboxProbe {
  try {
    accessSync(wrapperPath, constants.X_OK);
  } catch {
    return { available: false, reason: `sandbox wrapper is not executable: ${wrapperPath}` };
  }
  let proc: { exitCode: number | null; stdout: unknown; stderr: unknown };
  try {
    proc = Bun.spawnSync([wrapperPath, "--check"], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return {
      available: false,
      reason: `sandbox wrapper would not start: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const out = String(proc.stdout ?? "");
  const abi = /landlock-abi=(\d+)/.exec(out)?.[1];
  if (proc.exitCode === 0 && abi !== undefined && Number.parseInt(abi, 10) >= REVIEW_SANDBOX_MIN_ABI) {
    return { available: true, abi: Number.parseInt(abi, 10) };
  }
  const detail =
    String(proc.stderr ?? out)
      .trim()
      .split("\n")
      .pop() || `exit ${proc.exitCode}`;
  return { available: false, reason: `Landlock unavailable or below ABI ${REVIEW_SANDBOX_MIN_ABI}: ${detail}` };
}

export function checkReviewSandbox(env: Record<string, string | undefined> = process.env): ReviewSandboxProbe {
  if (probeOverride) return probeOverride;
  // Probed on every review spawn: a cached "available" must never survive a
  // rotated wrapper, and one spawnSync is noise next to a model run.
  return probeWrapper(reviewSandboxWrapperPath(env));
}

/**
 * Harness env namespace and credential shapes that must never reach a review
 * model. Provider keys the child legitimately needs (`OPENCODE_API_KEY`,
 * `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `XAI_API_KEY`) and the six Phoenix tracing labels (`JUMI_TRACE_KIND`,
 * `JUMI_OWNER`, `JUMI_REPO`, `JUMI_SHA`, `JUMI_JOB_ID`, `JUMI_AGENT_INSTANCE`,
 * owner/repo/sha/job labels the model already knows) are allowlisted by exact
 * name; everything matching a forbidden shape is a violation even when a
 * builder let it pass.
 */
const REVIEW_ENV_FORBIDDEN_PREFIXES = ["JUMI_", "GITEA_", "GITHUB_APP_", "GITHUB_WEBHOOK_", "GIT_"] as const;
const REVIEW_ENV_FORBIDDEN_EXACT = new Set([
  "GIT_AUTH_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITEA_BOT_TOKEN",
  "GITEA_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "BOARD_PEER_TOKEN",
  "GIT_PASSWORD",
  "JUMI_SECRETS_FILE",
]);
const REVIEW_ENV_ALLOWED_EXACT = new Set([
  "OPENCODE_API_KEY",
  "OPENCODE_MODEL",
  "OPENCODE_VARIANT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DB",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "XAI_API_KEY",
  "GIT_CONFIG_COUNT",
  // Non-secret forge hostname driving the host-scoped webfetch deny
  // (`child_git_proxy.ts`, `forge_webfetch.ts`); the write-capable token
  // itself never reaches the child (stripped parent-side) and stays
  // forbidden below.
  "GIT_AUTH_HOST",
]);
const REVIEW_ENV_ALLOWED_PREFIXES = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"] as const;
/**
 * Phoenix tracing labels a review Claude child carries (`claudeTracingEnv`).
 * They ride the child env so spans land under the same job/owner/repo as an
 * OpenCode run; they are owner/repo/sha/job labels the model already knows,
 * never credentials, so they are exempt from the `JUMI_` prefix ban.
 */
const REVIEW_ENV_ALLOWED_TRACING_EXACT = new Set([
  "JUMI_TRACE_KIND",
  "JUMI_OWNER",
  "JUMI_REPO",
  "JUMI_SHA",
  "JUMI_JOB_ID",
  "JUMI_AGENT_INSTANCE",
]);
const REVIEW_ENV_TOKEN_HINT = /(MCP.*(TOKEN|KEY|SECRET)|(TOKEN|KEY|SECRET).*MCP)/i;

/** Names (never values) in `env` that must fail a review spawn closed. Empty means clean. */
export function findReviewEnvViolations(env: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(env)) {
    if (REVIEW_ENV_ALLOWED_EXACT.has(key)) continue;
    if (REVIEW_ENV_ALLOWED_TRACING_EXACT.has(key)) continue;
    if (REVIEW_ENV_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (REVIEW_ENV_FORBIDDEN_EXACT.has(key) || REVIEW_ENV_FORBIDDEN_PREFIXES.some((p) => key.startsWith(p))) {
      violations.push(key);
      continue;
    }
    if (REVIEW_ENV_TOKEN_HINT.test(key)) violations.push(key);
  }
  return violations.sort();
}

export interface ReviewSpawnSandbox {
  argv: string[];
  sandboxed: boolean;
}

/**
 * Fail-closed sandbox decision for one agent spawn. Non-review spawns pass
 * through untouched. Review spawns are audited (forbidden env fails closed),
 * then the Landlock probe for *shell* sandboxing must pass unless the
 * deployer bypass is set (logged loudly) or the spawn is refused with the
 * remediation in the message. A review spawn without sanitized env is refused
 * instead of running unsandboxed.
 *
 * Part-2 shape (jumi#550): the agent itself runs UNSANDBOXED so it keeps its
 * HOME login and MCP token; every shell the model runs is wrapped separately
 * by Jumi-owned per-runner hooks (OpenCode plugin, Claude/Codex/Agy
 * PreToolUse) built from `reviewShellSandboxRules` + `wrapShellCommand`.
 * `sandboxed` is therefore always false here — it only reports whether the
 * agent argv itself was wrapped (never, for reviews). Callers set up the
 * shell hooks before spawn; this gate ensures they never run unsandboxed.
 */
export function resolveReviewSpawnSandbox(
  opts: Pick<EngineRunOptions, "trace" | "sanitizeEnv" | "workdir" | "home" | "model">,
  agentArgv: readonly string[],
  childEnv: Record<string, string>,
  log: (message: string) => void = () => undefined,
  env: Record<string, string | undefined> = process.env
): ReviewSpawnSandbox {
  if (opts.trace?.kind !== "review") return { argv: [...agentArgv], sandboxed: false };
  if (!opts.sanitizeEnv) {
    throw new EngineFailedError("review spawn refused: sanitizeEnv is required for review spawns", false);
  }
  const violations = findReviewEnvViolations(childEnv);
  if (violations.length > 0) {
    throw new EngineFailedError(
      `review spawn refused: child env carries forbidden keys: ${violations.join(", ")}`,
      false
    );
  }
  if (allowUnsandboxedReviews(env)) {
    log(
      `WARNING: ${ALLOW_UNSANDBOXED_REVIEWS_ENV}=1: running review spawn UNSANDBOXED without per-shell Landlock confinement`
    );
    return { argv: [...agentArgv], sandboxed: false };
  }
  const probe = checkReviewSandbox(env);
  if (!probe.available) {
    throw new EngineFailedError(
      `review spawn refused: Landlock sandbox unavailable (${probe.reason ?? "unknown"}). ` +
        `Set ${ALLOW_UNSANDBOXED_REVIEWS_ENV}=1 to run unsandboxed reviews (not recommended).`,
      false
    );
  }
  return { argv: [...agentArgv], sandboxed: false };
}

/** Runner types Jumi can sandbox per-shell with a Jumi-owned hook. */
export const REVIEW_SANDBOXABLE_RUNNERS: readonly string[] = ["opencode", "claude", "codex", "agy"] as const;

/**
 * Fail-closed per-runner support check. Every review runner must come through
 * a Jumi-owned hook that wraps its shells; a runner with no hook refuses with
 * one clear line instead of running unsandboxed. All four pinned runners have
 * hooks (OpenCode `tool.execute.before`, Claude/Codex `PreToolUse`
 * `updatedInput`, Agy `PreToolUse` `overwrite`); unknown types refuse.
 */
export function assertReviewRunnerSandboxable(runnerType: string): void {
  if ((REVIEW_SANDBOXABLE_RUNNERS as readonly string[]).includes(runnerType)) return;
  throw new EngineFailedError(
    `review spawn refused: ${runnerType} runner cannot be sandboxed with the installed binary (no Jumi-owned shell hook); refusing instead of running unsandboxed`,
    false
  );
}

export interface ReviewShellHookInput {
  workdir: string;
  scratchDir: string;
  harnessTempDir: string;
  homeDir?: string;
  gitDirs?: string[];
  wrapperPath?: string;
}

/** Rules + prefix inputs derived from one hook input (single place). */
export function reviewShellHookRules(input: ReviewShellHookInput): ReviewSandboxRules {
  return reviewShellSandboxRules({ workdir: input.workdir, scratchDir: input.scratchDir, gitDirs: input.gitDirs });
}

function reviewShellHookPrefix(input: ReviewShellHookInput, env?: Record<string, string | undefined>): string {
  const rules = reviewShellHookRules(input);
  return reviewShellWrapperPrefix(
    rules,
    { wrapperPath: input.wrapperPath, sandboxHome: sandboxedShellHome(input.scratchDir), scratchDir: input.scratchDir },
    env
  );
}

/** Paths a model's Read/Grep tools must never open (hook-level deny, not FS). */
export function reviewShellDeniedReadPrefixes(input: ReviewShellHookInput): string[] {
  const prefixes = [input.harnessTempDir];
  if (input.homeDir) {
    prefixes.push(
      join(input.homeDir, ".codex", "auth.json"),
      join(input.homeDir, ".claude", ".credentials.json"),
      join(input.homeDir, ".local", "share", "opencode", "auth.json"),
      join(input.homeDir, ".gemini")
    );
  }
  return prefixes;
}

/**
 * OpenCode `tool.execute.before` plugin (Jumi-owned, lives under the harness
 * temp root outside the checkout). Rewrites `bash` commands through the shell
 * wrapper and denies reads of the harness temp / agent credential files.
 */
export function openCodeReviewShellPluginCode(input: ReviewShellHookInput): string {
  const prefix = reviewShellHookPrefix(input);
  const denied = JSON.stringify(reviewShellDeniedReadPrefixes(input));
  return `// Jumi-owned review shell sandbox (jumi#550). Loaded from the harness temp root, never the checkout.
export const ReviewShellSandbox = async () => ({
  "tool.execute.before": async (toolInput, output) => {
    const deniedPrefixes = ${denied};
    const isDenied = (p) => typeof p === "string" && deniedPrefixes.some((d) => d && (p === d || p.startsWith(d + "/")));
    const tool = toolInput.tool;
    if (tool === "bash") {
      const cmd = output.args?.command;
      if (typeof cmd === "string" && cmd.length > 0) {
        const prefix = ${JSON.stringify(prefix)};
        const escaped = "'" + cmd.replace(/'/g, "'\\\\''") + "'";
        output.args = { ...output.args, command: prefix + " sh -c " + escaped };
      }
      return;
    }
    if (tool === "read") {
      const p = output.args?.filePath ?? output.args?.path;
      if (isDenied(p)) throw new Error("Blocked: review sandbox denies reads of agent credentials");
      return;
    }
    if (tool === "grep" || tool === "glob") {
      const p = output.args?.path;
      if (isDenied(p)) throw new Error("Blocked: review sandbox denies search outside the checkout");
    }
  },
});
`;
}

/**
 * Claude/Codex `PreToolUse` hook script (Jumi-owned, under the harness temp
 * root). Reads the hook JSON on stdin; rewrites `Bash.command` through the
 * shell wrapper via `updatedInput`; denies reads of harness temp / credential
 * files with exit 2. `hookSpecificOutput.updatedInput` replaces the whole
 * input, so every field is echoed back.
 */
export function claudeReviewHookScriptCode(input: ReviewShellHookInput): string {
  const prefix = reviewShellHookPrefix(input);
  const denied = JSON.stringify(reviewShellDeniedReadPrefixes(input));
  return `#!/usr/bin/env python3
"""Jumi-owned review shell sandbox hook (jumi#550). Rewrites Bash through Landlock, denies credential reads."""
import json
import sys

PREFIX = ${JSON.stringify(prefix)}
DENIED = ${denied}

def is_denied(path):
    if not isinstance(path, str) or not path:
        return False
    return any(path == d or path.startswith(d + "/") for d in DENIED if d)

def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    tool = event.get("tool_name", "")
    tool_input = event.get("tool_input", {}) or {}
    if tool == "Bash":
        cmd = tool_input.get("command", "")
        if isinstance(cmd, str) and cmd:
            new_input = dict(tool_input)
            new_input["command"] = PREFIX + " sh -c '" + cmd.replace("'", "'\\\\''") + "'"
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": new_input}}))
        sys.exit(0)
    if tool in ("Read", "Edit", "Write"):
        path = tool_input.get("file_path", "") or tool_input.get("path", "")
        if is_denied(path):
            print("Blocked: review sandbox denies reads of agent credentials", file=sys.stderr)
            sys.exit(2)
        sys.exit(0)
    sys.exit(0)

if __name__ == "__main__":
    main()
`;
}

/** Claude plugin `hooks/hooks.json` registering the hook above for Bash + file tools. */
export function claudeReviewHooksJson(hookCommand: string): string {
  return `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|Read|Edit|Write",
            hooks: [{ type: "command", command: hookCommand, timeout: 10 }],
          },
        ],
      },
    },
    null,
    2
  )}\n`;
}

/** Codex `hooks.json` (under CODEX_HOME): same rewrite shape as Claude. */
export function codexReviewHooksJson(hookCommand: string): string {
  return claudeReviewHooksJson(hookCommand);
}

/**
 * Agy `hooks.json` (global `~/.gemini/config/hooks.json` shape): `run_command`
 * is Agy's shell tool; `overwrite.CommandLine` replaces its command text.
 * The hook script below handles the Agy envelope (`toolCall.name/args`) and
 * the Claude envelope, so one script serves both runners in tests.
 */
export function agyReviewHooksJson(hookCommand: string): string {
  return `${JSON.stringify(
    {
      "jumi-review-shell-sandbox": {
        PreToolUse: [
          {
            matcher: "run_command|write_to_file|replace_file_content|multi_replace_file_content",
            hooks: [{ type: "command", command: hookCommand, timeout: 10 }],
          },
        ],
      },
    },
    null,
    2
  )}\n`;
}

/**
 * Agy-compatible hook script: handles `toolCall{name,args}` (Agy) and
 * `tool_name/tool_input` (Claude/Codex). Shell commands are wrapped with the
 * same Landlock prefix; credential reads are denied.
 */
export function agyReviewHookScriptCode(input: ReviewShellHookInput): string {
  const prefix = reviewShellHookPrefix(input);
  const denied = JSON.stringify(reviewShellDeniedReadPrefixes(input));
  return `#!/usr/bin/env python3
"""Jumi-owned review shell sandbox hook for Agy (jumi#550). Handles the Agy toolCall envelope."""
import json
import sys

PREFIX = ${JSON.stringify(prefix)}
DENIED = ${denied}

def is_denied(path):
    if not isinstance(path, str) or not path:
        return False
    return any(path == d or path.startswith(d + "/") for d in DENIED if d)

def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    call = event.get("toolCall") or {}
    name = call.get("name", "") or event.get("tool_name", "")
    args = call.get("args") or event.get("tool_input") or {}
    if name == "run_command":
        cmd = args.get("CommandLine", "") or args.get("command", "")
        if isinstance(cmd, str) and cmd:
            wrapped = PREFIX + " sh -c '" + cmd.replace("'", "'\\\\''") + "'"
            print(json.dumps({"decision": "allow", "overwrite": {"CommandLine": wrapped}}))
        sys.exit(0)
    if name in ("write_to_file", "replace_file_content", "multi_replace_file_content", "Read", "Edit", "Write"):
        path = args.get("FilePath", "") or args.get("file_path", "") or args.get("path", "")
        if is_denied(path):
            print(json.dumps({"decision": "deny", "reason": "Blocked: review sandbox denies reads of agent credentials"}))
            sys.exit(0)
        sys.exit(0)
    # Claude/Codex envelope fallback (same file can serve those runners in tests).
    tool = event.get("tool_name", "")
    tool_input = event.get("tool_input", {}) or {}
    if tool == "Bash":
        cmd = tool_input.get("command", "")
        if isinstance(cmd, str) and cmd:
            new_input = dict(tool_input)
            new_input["command"] = PREFIX + " sh -c '" + cmd.replace("'", "'\\\\''") + "'"
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": new_input}}))
        sys.exit(0)
    sys.exit(0)

if __name__ == "__main__":
    main()
`;
}

/** Fake-runner red-team helper: grade that a wrapped shell cannot read `secretPath`. */
export function reviewRedTeamSecretDenied(secretPath: string, observed: string): boolean {
  if (!observed) return false;
  if (observed.includes(secretPath) && /parent-secret|secret-token/.test(observed)) return false;
  return /Permission denied|Blocked|denied/i.test(observed);
}

/** Create the sandbox HOME tree under scratch (writable for tools). */
export async function ensureSandboxedShellHome(scratchDir: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  const home = sandboxedShellHome(scratchDir);
  await mkdir(home, { recursive: true });
  await mkdir(join(home, ".config"), { recursive: true });
  await mkdir(join(home, ".local", "share"), { recursive: true });
  await mkdir(join(home, ".cache"), { recursive: true });
  return home;
}

/** Write the OpenCode review shell plugin under the harness temp (Jumi-owned). */
export async function writeOpenCodeReviewShellPlugin(
  harnessTempDir: string,
  input: ReviewShellHookInput
): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const xdgConfig = join(harnessTempDir, "xdg-config", "opencode");
  const pluginDir = join(xdgConfig, "plugin");
  await mkdir(pluginDir, { recursive: true });
  const pluginPath = join(pluginDir, "jumi-review-shell-sandbox.js");
  await writeFile(pluginPath, openCodeReviewShellPluginCode(input), { mode: 0o600 });
  return pluginPath;
}

/** Write the Claude review shell hook plugin dir under the harness temp (Jumi-owned). */
export async function writeClaudeReviewShellPlugin(
  harnessTempDir: string,
  input: ReviewShellHookInput
): Promise<string> {
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  const pluginDir = join(harnessTempDir, "claude-review-shell-sandbox");
  const hooksDir = join(pluginDir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "sandbox-bash.py");
  await writeFile(hookPath, claudeReviewHookScriptCode(input), { mode: 0o700 });
  await chmod(hookPath, 0o700).catch(() => undefined);
  await writeFile(join(hooksDir, "hooks.json"), claudeReviewHooksJson(hookPath));
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "jumi-review-shell-sandbox", description: "Jumi-owned review shell sandbox" }, null, 2)}\n`
  );
  return pluginDir;
}

/** Write Codex review hooks under its review-only CODEX_HOME (Jumi-owned). */
export async function writeCodexReviewShellHooks(
  reviewHomeDir: string,
  input: ReviewShellHookInput
): Promise<{ hooksPath: string; hookPath: string }> {
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(reviewHomeDir, { recursive: true });
  const hookPath = join(reviewHomeDir, "jumi-review-shell-sandbox.py");
  await writeFile(hookPath, claudeReviewHookScriptCode(input), { mode: 0o700 });
  await chmod(hookPath, 0o700).catch(() => undefined);
  const hooksPath = join(reviewHomeDir, "hooks.json");
  await writeFile(hooksPath, codexReviewHooksJson(hookPath), { mode: 0o600 });
  return { hooksPath, hookPath };
}

/** Write the Agy review hook script under the harness temp (Jumi-owned). */
export async function writeAgyReviewShellHook(harnessTempDir: string, input: ReviewShellHookInput): Promise<string> {
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(harnessTempDir, { recursive: true });
  const hookPath = join(harnessTempDir, "agy-review-shell-sandbox.py");
  await writeFile(hookPath, agyReviewHookScriptCode(input), { mode: 0o700 });
  await chmod(hookPath, 0o700).catch(() => undefined);
  return hookPath;
}
