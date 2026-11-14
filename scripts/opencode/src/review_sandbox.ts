import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineRunOptions } from "./engine.ts";
import { EngineFailedError } from "./engine.ts";
import { childScratchDir } from "./engine_scratch.ts";

/**
 * Landlock sandbox for review spawns (jumi#531).
 *
 * The agent binary runs through `review_sandbox.py`, which restricts itself
 * with Landlock and execs the agent. Every shell command the model then runs
 * inherits the domain: pull code sees only the checkout and scratch space,
 * never the harness through /proc, signals, or abstract sockets, and never
 * files outside the allow-list.
 *
 * Filesystem allow-lists live here; environment scrubbing stays in the
 * per-runner builders (`buildEnv`, `buildClaudeEnv`, `buildCodexEnv`,
 * `agyEnv`), and this module audits the built env before spawn so a token
 * that slipped through fails the spawn closed instead of reaching the model.
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
  gitDir?: string;
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
 * Best-effort location of the git dir behind `workdir`. Linked worktrees
 * keep objects outside the checkout (`.git` file with `gitdir: ...`), and a
 * sandboxed `git` cannot open them unless the dir is in the allow-list.
 * Returns undefined when `.git` is a directory inside the checkout (already
 * covered) or unreadable (the spawn then fails loudly on first git use,
 * never silently unsandboxed).
 */
export function resolveWorktreeGitDirSync(workdir: string): string | undefined {
  let dotGit: string;
  try {
    dotGit = join(workdir, ".git");
    const text = readFileSync(dotGit, "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!match?.[1]) return undefined;
    const gitdir = resolve(workdir, match[1]);
    try {
      const commondir = readFileSync(join(gitdir, "commondir"), "utf8").trim();
      if (commondir) return resolve(gitdir, commondir);
    } catch {
      // No commondir: the gitdir itself holds the objects.
    }
    return gitdir;
  } catch {
    return undefined;
  }
}

export function reviewSandboxRules(input: ReviewSandboxRuleInput): ReviewSandboxRules {
  const scratchDir = input.scratchDir ?? childScratchDir(input.workdir);
  return {
    readWrite: dedupeAbsolute([input.workdir, scratchDir, input.homeDir, input.gitDir]),
    readOnly: [...REVIEW_SANDBOX_READ_ONLY_SYSTEM],
    devices: [...REVIEW_SANDBOX_DEVICE_PATHS],
  };
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
 * `CODEX_API_KEY`, `XAI_API_KEY`) are allowlisted by exact name; everything
 * matching a forbidden shape is a violation even when a builder let it pass.
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
]);
const REVIEW_ENV_ALLOWED_PREFIXES = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"] as const;
const REVIEW_ENV_TOKEN_HINT = /(MCP.*(TOKEN|KEY|SECRET)|(TOKEN|KEY|SECRET).*MCP)/i;

/** Names (never values) in `env` that must fail a review spawn closed. Empty means clean. */
export function findReviewEnvViolations(env: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(env)) {
    if (REVIEW_ENV_ALLOWED_EXACT.has(key)) continue;
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
 * Fail-closed sandbox decision for one agent spawn. Non-review and
 * unsanitized spawns pass through untouched. Review spawns are audited
 * (forbidden env fails closed), then wrapped unless the deployer allowlist
 * bypass is set (logged loudly) or Landlock is unavailable (refused with
 * the remediation in the message so the chain fails with one clear line).
 */
export function resolveReviewSpawnSandbox(
  opts: Pick<EngineRunOptions, "trace" | "sanitizeEnv" | "workdir" | "home" | "model">,
  agentArgv: readonly string[],
  childEnv: Record<string, string>,
  log: (message: string) => void = () => undefined,
  env: Record<string, string | undefined> = process.env
): ReviewSpawnSandbox {
  if (opts.trace?.kind !== "review" || !opts.sanitizeEnv) return { argv: [...agentArgv], sandboxed: false };
  const violations = findReviewEnvViolations(childEnv);
  if (violations.length > 0) {
    throw new EngineFailedError(
      `review spawn refused: child env carries forbidden keys: ${violations.join(", ")}`,
      false
    );
  }
  if (allowUnsandboxedReviews(env)) {
    log(`WARNING: ${ALLOW_UNSANDBOXED_REVIEWS_ENV}=1: running review spawn UNSANDBOXED without Landlock confinement`);
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
  const rules = reviewSandboxRules({
    workdir: opts.workdir,
    homeDir: opts.home,
    gitDir: resolveWorktreeGitDirSync(opts.workdir),
  });
  if (opts.home && !rules.readWrite.includes(resolve(opts.home))) {
    log(
      `review sandbox: HOME ${opts.home} is outside the checkout and stays visible to the model (narrowing is follow-up work)`
    );
  }
  return { argv: reviewSandboxArgv(rules, agentArgv, reviewSandboxWrapperPath(env)), sandboxed: true };
}
