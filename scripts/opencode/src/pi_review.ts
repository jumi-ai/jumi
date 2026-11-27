/**
 * Strict offline Pi review harness (jumi#932).
 *
 * Runs one structured review through the real Pi SDK (`createAgentSession`)
 * in an isolated attempt, never in the privileged parent. The session owns
 * one conversation over a disposable checkout (`cwd`); the parent owns the
 * verdict store and alone decides whether to publish. No production provider
 * is needed: tests drive the session with a scripted loopback model, and the
 * harness never falls back to the `JUMI_REVIEW.md` file artifact.
 *
 * Boundaries (all enforced in code, never in prompt text alone):
 * - Trusted resource loader: a custom `ResourceLoader` with no discovery.
 *   No project/head, user, or global Pi settings, extensions, hooks,
 *   packages, or MCP servers load. Trusted base instructions are prompt data,
 *   not executable configuration.
 * - Explicit transports only: the caller supplies the `ModelRuntime`/`Model`
 *   (loopback in tests, an explicitly selected inference transport in
 *   production). No SDK telemetry, update checks, downloads, or
 *   install-on-first-use: in-memory settings disable them and the loader does
 *   no package resolution.
 * - Role-scoped Jumi tools only: the model reaches `read`, a guarded `bash`
 *   override, and the `jumi_*` verdict tools bound to the parent's
 *   `ReviewVerdictStore`. `edit`/`write` and every other built-in stay
 *   disabled, so non-shell writes fail as unknown tools.
 * - Shell sandbox: a probe must report Landlock available (or the deployer
 *   bypass is set) before the session starts; the guarded `bash` override
 *   denies writes and scrubs the per-shell env (canaries, forge tokens, HOME
 *   secrets) while keeping the git proxy host.
 * - Verdict contract is always `required`: a missing or malformed structured
 *   verdict fails the attempt even when `JUMI_REVIEW.md` claims success and
 *   the child exits zero. Selecting the old harness (`legacy`) never
 *   authorizes a file-verdict downgrade inside Pi, and a Pi failure never
 *   rescues to legacy.
 */

import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EngineFailedError } from "./engine.ts";
import {
  allowUnsandboxedReviews,
  ensureSandboxedShellHome,
  findReviewEnvViolations,
  resolveWorktreeGitDirsSync,
  reviewSandboxWrapperPath,
  reviewShellSandboxRules,
  wrapShellCommand,
} from "./review_sandbox.ts";
import { REVIEW_VERDICT_CONTRACT_REQUIRED, type ReviewVerdictContract } from "./review_verdict_contract.ts";
import type { ReviewVerdictStore } from "./review_verdict_store.ts";

/** Fixed harness preamble. Base instructions are appended as data below it. */
export const PI_REVIEW_SYSTEM_PREAMBLE =
  "You are Jumi's offline review agent. Record findings and exactly one verdict through the jumi_* tools. " +
  "Do not write files to record the verdict; the parent publishes from the structured store, never from JUMI_REVIEW.md.";

export const PI_REVIEW_TOOL_NAMES = [
  "jumi_add_finding",
  "jumi_update_finding",
  "jumi_remove_finding",
  "jumi_set_verdict",
  "jumi_list_findings",
  "jumi_previous_findings",
] as const;

export type PiReviewToolName = (typeof PI_REVIEW_TOOL_NAMES)[number];

/** Pi verdict contract is always structured-required; the file never publishes. */
export const PI_REVIEW_CONTRACT: ReviewVerdictContract = REVIEW_VERDICT_CONTRACT_REQUIRED;

/**
 * The old harness selection never authorizes a file-verdict downgrade inside
 * Pi. An explicit `legacy` contract still resolves to `required` here; legacy
 * behavior lives only in the legacy engine path, never in this harness.
 */
export function resolvePiVerdictContract(explicit?: ReviewVerdictContract | null): ReviewVerdictContract {
  void explicit;
  return REVIEW_VERDICT_CONTRACT_REQUIRED;
}

/** Trusted loader: no discovery of any kind. Everything is explicit. */
export function createTrustedPiResourceLoader(baseInstructions?: string): ResourceLoader {
  const systemPrompt = baseInstructions?.trim()
    ? `${PI_REVIEW_SYSTEM_PREAMBLE}\n\n<base_instructions>\n${baseInstructions.trim()}\n</base_instructions>`
    : PI_REVIEW_SYSTEM_PREAMBLE;
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
export function createPiReviewSettings(): SettingsManager {
  return SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    enableAnalytics: false,
    enableInstallTelemetry: false,
    packages: [],
    extensions: [],
    defaultTools: ["read", "bash", ...PI_REVIEW_TOOL_NAMES],
  } as Parameters<typeof SettingsManager.inMemory>[0]);
}

export interface PiSandboxProbe {
  available: boolean;
  reason?: string;
}

/** Fail closed when the shell sandbox is missing unless the deployer bypasses. */
export function assertPiSandboxAvailable(
  probe: PiSandboxProbe,
  env: Record<string, string | undefined> = process.env
): void {
  if (env.JUMI_ALLOW_UNSANDBOXED_REVIEWS === "1") return;
  if (probe.available) return;
  throw new EngineFailedError(
    `pi review refused: shell sandbox unavailable (${probe.reason ?? "unknown"}). ` +
      `Set JUMI_ALLOW_UNSANDBOXED_REVIEWS=1 to run unsandboxed reviews (not recommended).`,
    false
  );
}

export interface PiToolCallRecord {
  name: string;
  args: unknown;
  ok: boolean;
  text: string;
}

/** Minimal scrubbed env for Pi tool shells. No secrets, no forge tokens. */
export function buildPiSessionEnv(input: {
  path?: string;
  home: string;
  scratchDir: string;
  gitHost?: string;
  extra?: Record<string, string | undefined>;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: input.path ?? process.env.PATH ?? "/usr/bin:/bin",
    HOME: input.home,
    TMPDIR: input.scratchDir,
  };
  if (input.gitHost) env.GIT_AUTH_HOST = input.gitHost;
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (value === undefined) continue;
    if (findReviewEnvViolations({ ...env, [key]: value }).length > 0) continue;
    env[key] = value;
  }
  return env;
}

const PI_BASH_DENY_RE =
  /(^|[^A-Za-z0-9_])(rm|mv|mkdir|touch|tee|chmod|chown|truncate)\b|>|>>|\|\s*tee\b|git\s+push|git\s+commit/i;

// Command substitution smuggles writes through an allowlisted outer verb
// (`echo $(touch pwned)`, backticks, `<(...)`). Simple `$VAR`/`${VAR}`
// expansion stays allowed; `$(...)`, `$((...))`, backticks, and `<(...)`
// process substitution do not.
const PI_BASH_SUBSTITUTION_RE = /\$\(|`|<\([^)]*\)/;

function isPiBashDenied(command: string): boolean {
  if (PI_BASH_SUBSTITUTION_RE.test(command)) return true;
  return PI_BASH_DENY_RE.test(command);
}

const PI_BASH_READ_PREFIX_RE =
  /^\s*(cat|ls|head|tail|wc|grep|find|git\s+(status|diff|log|rev-parse|ls-files|show)|sed\s+-n|awk|cut|sort|uniq|file|stat|echo)\b/;

/** Guarded `read` override: only files inside the checkout, never denied prefixes. */
export function createGuardedPiReadTool(opts: {
  cwd: string;
  deniedPrefixes: readonly string[];
  onCall?: (path: string, denied: boolean) => void;
}): {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    toolCallId: string,
    params: { path: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }>;
} {
  return {
    name: "read",
    label: "Read",
    description: "Read a file inside the review checkout",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_toolCallId, params) => {
      const raw = String((params as { path?: unknown }).path ?? "");
      if (!raw.trim()) {
        opts.onCall?.(raw, true);
        return {
          content: [{ type: "text", text: "denied: pi review read denies empty path" }],
          details: {},
          isError: true,
        };
      }
      // Lexical canonicalization: `resolve` collapses `.`/`..`/duplicate
      // slashes, so `../outside` no longer smuggles past the prefix check
      // by string-matching `cwd + "/"`.
      const resolved = resolve(opts.cwd, raw);
      const cwdResolved = resolve(opts.cwd);
      const insideCwd = resolved === cwdResolved || resolved.startsWith(`${cwdResolved}/`);
      const normalizedPrefixes = opts.deniedPrefixes.map((prefix) => resolve(prefix));
      let denied =
        !insideCwd || normalizedPrefixes.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`));
      let effectivePath = resolved;
      if (!denied) {
        try {
          // Symlink confinement: the checkout is head-supplied, so a link
          // inside it can point outside. `readFile` follows links, so the
          // containment check must run on the real path too.
          const effective = await realpath(resolved);
          const realCwd = await realpath(cwdResolved).catch(() => cwdResolved);
          const realPrefixes = await Promise.all(
            normalizedPrefixes.map(async (prefix) => realpath(prefix).catch(() => prefix))
          );
          const insideReal = effective === realCwd || effective.startsWith(`${realCwd}/`);
          if (
            !insideReal ||
            realPrefixes.some((prefix) => effective === prefix || effective.startsWith(`${prefix}/`))
          ) {
            denied = true;
          } else {
            effectivePath = effective;
          }
        } catch {
          // Unresolvable (missing file): the lexical decision stands and the
          // `readFile` below fails closed. A dangling link cannot leak
          // content because there is nothing to read.
        }
      }
      opts.onCall?.(raw, denied);
      if (denied) {
        return {
          content: [{ type: "text", text: `denied: pi review read denies: ${raw.slice(0, 120)}` }],
          details: {},
          isError: true,
        };
      }
      try {
        const content = await readFile(effectivePath, "utf8");
        return { content: [{ type: "text", text: content.slice(0, 8000) }], details: {} };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `read failed: ${message}` }], details: {}, isError: true };
      }
    },
  };
}

/** Guarded `bash` override: read-only commands run, writes fail closed. */
export function createGuardedPiBashTool(opts: {
  cwd: string;
  env: Record<string, string>;
  onCall?: (command: string, denied: boolean) => void;
  /**
   * Landlock confinement for the production path (`runPiReviewAttempt`
   * supplies it; direct unit calls omit it and exercise only the deny
   * predicate). When present, the allowed command runs inside the shell
   * Landlock domain built from `reviewShellSandboxRules`, so an allowed
   * verb cannot reach the harness temp, the agent HOME, or the shared
   * `/tmp` outside the checkout.
   */
  sandbox?: { scratchDir: string; gitDirs?: readonly string[]; wrapperPath?: string };
}): {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    toolCallId: string,
    params: { command: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }>;
} {
  return {
    name: "bash",
    label: "Bash",
    description: "Execute guarded read-only shell commands in the review checkout",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    execute: async (_toolCallId, params, signal) => {
      const command = String((params as { command?: unknown }).command ?? "");
      if (!command.trim()) {
        opts.onCall?.(command, true);
        return { content: [{ type: "text", text: "empty command denied" }], details: {}, isError: true };
      }
      if (isPiBashDenied(command) || !PI_BASH_READ_PREFIX_RE.test(command)) {
        opts.onCall?.(command, true);
        return {
          content: [{ type: "text", text: `denied: pi review shell denies writes: ${command.slice(0, 120)}` }],
          details: {},
          isError: true,
        };
      }
      opts.onCall?.(command, false);
      // The deny predicate above cannot parse shell syntax, so confinement
      // is defense in depth: allowed verbs run inside the Landlock domain.
      let spawnCommand = command;
      if (opts.sandbox) {
        const rules = reviewShellSandboxRules({
          workdir: opts.cwd,
          scratchDir: opts.sandbox.scratchDir,
          gitDirs: [...(opts.sandbox.gitDirs ?? [])],
        });
        spawnCommand = wrapShellCommand(command, rules, {
          wrapperPath: opts.sandbox.wrapperPath ?? reviewSandboxWrapperPath(),
          scratchDir: opts.sandbox.scratchDir,
        });
      }
      const proc = Bun.spawn(["sh", "-c", spawnCommand], {
        cwd: opts.cwd,
        env: opts.env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
        signal,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const output = [stdout, stderr].filter(Boolean).join("\n").slice(0, 8000);
      if (exitCode !== 0) {
        return { content: [{ type: "text", text: output || `exit ${exitCode}` }], details: {}, isError: true };
      }
      return { content: [{ type: "text", text: output || "(no output)" }], details: {} };
    },
  };
}

/** Role-scoped Jumi verdict tools bound to the parent's store. */
export function createPiReviewCustomTools(
  store: ReviewVerdictStore,
  onCall?: (record: PiToolCallRecord) => void
  // Typed as unknown records: the Pi SDK `ToolDefinition` generics vary by
  // schema, and the harness passes these straight into `customTools`.
): Array<Record<string, unknown>> {
  const wrap = (
    name: string,
    text: string,
    ok: boolean
  ): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean } => {
    onCall?.({ name, args: {}, ok, text });
    return ok
      ? { content: [{ type: "text", text }], details: {} }
      : { content: [{ type: "text", text }], details: {}, isError: true };
  };
  return [
    {
      name: "jumi_add_finding",
      label: "Add finding",
      description:
        "Record one review finding. Path must be a changed file; line must be in the diff hunks. Use needs_maintainer for maintainer-only questions (question only); use proof {location, command, excerpt} for bug/risk proof.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        line: Type.Optional(Type.Number()),
        severity: Type.String(),
        title: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        needs_maintainer: Type.Optional(Type.Boolean()),
        proof: Type.Optional(
          Type.Object({
            location: Type.Optional(Type.String()),
            command: Type.Optional(Type.String()),
            excerpt: Type.Optional(Type.String()),
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const result = store.addFinding({
          ...(params.path !== undefined ? { path: params.path as string } : {}),
          ...(params.line !== undefined ? { line: params.line as number } : {}),
          severity: params.severity as string,
          ...(params.title !== undefined ? { title: params.title as string } : {}),
          ...(params.body !== undefined ? { body: params.body as string } : {}),
          ...(params.needs_maintainer !== undefined ? { needs_maintainer: params.needs_maintainer } : {}),
          ...(params.proof !== undefined ? { proof: params.proof } : {}),
        });
        const text = result.ok ? JSON.stringify({ id: result.id }) : result.error;
        onCall?.({ name: "jumi_add_finding", args: params, ok: result.ok, text });
        return result.ok
          ? { content: [{ type: "text", text }], details: {} }
          : { content: [{ type: "text", text }], details: {}, isError: true };
      },
    },
    {
      name: "jumi_update_finding",
      label: "Update finding",
      description:
        "Update a recorded finding by id. needs_maintainer and proof follow the add_finding rules; omitting them preserves the previous value.",
      parameters: Type.Object({
        id: Type.String(),
        path: Type.Optional(Type.String()),
        line: Type.Optional(Type.Number()),
        severity: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        needs_maintainer: Type.Optional(Type.Boolean()),
        proof: Type.Optional(
          Type.Object({
            location: Type.Optional(Type.String()),
            command: Type.Optional(Type.String()),
            excerpt: Type.Optional(Type.String()),
          })
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const result = store.updateFinding({ ...(params as { id: unknown }) });
        const text = result.ok ? JSON.stringify({ updated: true }) : result.error;
        onCall?.({ name: "jumi_update_finding", args: params, ok: result.ok, text });
        return result.ok
          ? { content: [{ type: "text", text }], details: {} }
          : { content: [{ type: "text", text }], details: {}, isError: true };
      },
    },
    {
      name: "jumi_remove_finding",
      label: "Remove finding",
      description: "Remove a recorded finding by id.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const result = store.removeFinding({ ...(params as { id: unknown }) });
        const text = result.ok ? JSON.stringify({ removed: true }) : result.error;
        onCall?.({ name: "jumi_remove_finding", args: params, ok: result.ok, text });
        return result.ok
          ? { content: [{ type: "text", text }], details: {} }
          : { content: [{ type: "text", text }], details: {}, isError: true };
      },
    },
    {
      name: "jumi_set_verdict",
      label: "Set verdict",
      description:
        "Record the review verdict. Success with an open bug/risk is rejected. Use incomplete (failure only) for could-not-finish without consulting the reason text.",
      parameters: Type.Object({
        state: Type.String(),
        reason: Type.Optional(Type.String()),
        incomplete: Type.Optional(Type.String()),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const result = store.setVerdict({
          state: params.state,
          reason: params.reason,
          incomplete: params.incomplete,
        });
        const text = result.ok ? JSON.stringify({ recorded: true }) : result.error;
        onCall?.({ name: "jumi_set_verdict", args: params, ok: result.ok, text });
        return result.ok
          ? { content: [{ type: "text", text }], details: {} }
          : { content: [{ type: "text", text }], details: {}, isError: true };
      },
    },
    {
      name: "jumi_list_findings",
      label: "List findings",
      description: "List recorded findings.",
      parameters: Type.Object({}),
      execute: async () => wrap("jumi_list_findings", JSON.stringify({ findings: store.listFindings() }), true),
    },
    {
      name: "jumi_previous_findings",
      label: "Previous findings",
      description: "Previous review finding lines.",
      parameters: Type.Object({}),
      execute: async () =>
        wrap("jumi_previous_findings", JSON.stringify({ findings: store.listPreviousFindings() }), true),
    },
  ];
}

export interface PiReviewAttemptOptions {
  /** Disposable checkout the session runs in; never the privileged parent cwd. */
  workdir: string;
  /** Trusted base-branch instructions as prompt data (never executable config). */
  baseInstructions?: string;
  /** User prompt for this review. */
  prompt: string;
  /** Parent-owned verdict store; the harness writes it, the parent publishes it. */
  store: ReviewVerdictStore;
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
  sandboxProbe?: PiSandboxProbe;
  abortSignal?: AbortSignal;
  logger?: (message: string) => void;
  timeoutMs?: number;
}

export interface PiReviewAttemptResult {
  status: "complete" | "incomplete";
  markdown: string;
  reason?: string;
  destinations: string[];
  toolCalls: PiToolCallRecord[];
}

/**
 * Run one isolated structured review through the real Pi SDK session.
 * The session runs with `cwd` = the disposable checkout and an isolated
 * agent dir; the privileged parent never executes model tools itself.
 * The `JUMI_REVIEW.md` file is read only to prove it is ignored: it never
 * publishes, even when it claims success and the session ends cleanly.
 */
export async function runPiReviewAttempt(opts: PiReviewAttemptOptions): Promise<PiReviewAttemptResult> {
  const log = opts.logger ?? (() => undefined);
  if (!opts.workdir || opts.workdir === process.cwd()) {
    throw new EngineFailedError("pi review refused: workdir must be a disposable checkout, not the parent cwd", false);
  }
  assertPiSandboxAvailable(opts.sandboxProbe ?? { available: true });
  const shellHome = join(opts.workdir, ".jumi-tmp", "pi-shell-home");
  const scratchDir = join(opts.workdir, ".jumi-tmp", "scratch");
  // Landlock `RW` paths must exist (the wrapper requires them). Create the
  // shell HOME, the scratch dir, and the wrapper-owned sandbox HOME up
  // front so an allowed shell never fails on a missing allow-listed path.
  try {
    await mkdir(scratchDir, { recursive: true });
    await mkdir(shellHome, { recursive: true });
    await ensureSandboxedShellHome(scratchDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EngineFailedError(`pi review refused: cannot create shell scratch dirs: ${message}`, false);
  }
  const sessionEnv =
    opts.shellEnv ?? buildPiSessionEnv({ home: shellHome, scratchDir, gitHost: opts.gitHost, extra: opts.extraEnv });
  const violations = findReviewEnvViolations(sessionEnv);
  if (violations.length > 0) {
    throw new EngineFailedError(
      `pi review refused: session env carries forbidden keys: ${violations.join(", ")}`,
      false
    );
  }

  const agentDir = opts.agentDir ?? (await mkdtemp(join(tmpdir(), "jumi-pi-agent-")));
  const ownAgentDir = opts.agentDir === undefined;

  const destinations: string[] = [];
  const allowed = new Set((opts.allowedFetchHosts ?? []).map((host) => host.toLowerCase()));
  const realFetch = globalThis.fetch;
  const spy = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    try {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
      );
      destinations.push(`${url.protocol}//${url.host}${url.pathname}`);
      const host = url.hostname.toLowerCase();
      void allowed;
      void host;
    } catch {
      destinations.push(String(typeof input === "string" ? input : ((input as Request)?.url ?? input)));
    }
    return realFetch(input as never, init as never);
  };
  globalThis.fetch = spy as typeof fetch;

  const toolCalls: PiToolCallRecord[] = [];
  const guardedRead = createGuardedPiReadTool({
    cwd: opts.workdir,
    deniedPrefixes: [agentDir, shellHome, join(opts.workdir, ".jumi-tmp", "pi-shell-home")],
    onCall: (path, denied) => {
      toolCalls.push({ name: "read", args: { path }, ok: !denied, text: denied ? "denied" : "ran" });
    },
  });
  const sandboxed = !allowUnsandboxedReviews();
  const guardedBash = createGuardedPiBashTool({
    cwd: opts.workdir,
    env: sessionEnv,
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

  const resourceLoader = createTrustedPiResourceLoader(opts.baseInstructions);
  await resourceLoader.reload();
  const settingsManager = createPiReviewSettings();
  const sessionManager = SessionManager.inMemory(opts.workdir);

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const created = await createAgentSession({
      cwd: opts.workdir,
      agentDir,
      model: opts.model as never,
      modelRuntime: opts.modelRuntime as never,
      resourceLoader,
      tools: ["read", "bash", ...PI_REVIEW_TOOL_NAMES],
      customTools: [
        ...createPiReviewCustomTools(opts.store, (record) => toolCalls.push(record)),
        guardedBash,
        guardedRead,
      ] as never[],
      sessionManager,
      settingsManager,
    });
    session = created.session;
    const running = created.session;
    const active = new Set(session.getActiveToolNames());
    for (const required of ["read", "bash", ...PI_REVIEW_TOOL_NAMES]) {
      if (!active.has(required)) {
        throw new EngineFailedError(`pi review refused: required tool not active: ${required}`, false);
      }
    }
    if (active.has("edit") || active.has("write")) {
      throw new EngineFailedError("pi review refused: write tools must stay disabled", false);
    }

    // `session.prompt` takes no signal: cancellation is `session.abort()`.
    // Wire the caller signal and the timeout to it so a stuck run cannot
    // hang the attempt (every wait has a wake). The timer and listener are
    // always cleaned up below.
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
      return {
        status: "incomplete",
        markdown: opts.store.toMarkdown(),
        reason: "Incomplete review: aborted",
        destinations,
        toolCalls,
      };
    }
    if (timedOut) {
      return {
        status: "incomplete",
        markdown: opts.store.toMarkdown(),
        reason: "Incomplete review: timed out",
        destinations,
        toolCalls,
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
      return {
        status: "incomplete",
        markdown: opts.store.toMarkdown(),
        reason: `Incomplete review: ambient network destinations observed: ${[...new Set(ambient)].join(", ")}`,
        destinations,
        toolCalls,
      };
    }

    // The checkout file never publishes: read it only to prove it is ignored.
    let fileClaimsSuccess = false;
    try {
      const file = await readFile(join(opts.workdir, "JUMI_REVIEW.md"), "utf8");
      fileClaimsSuccess = /jumi-check:\s*success/i.test(file);
    } catch {
      fileClaimsSuccess = false;
    }

    const record = opts.store.toRecord();
    if (record.state === "incomplete" || !opts.store.hasVerdict()) {
      void fileClaimsSuccess;
      return {
        status: "incomplete",
        markdown: opts.store.toMarkdown(),
        reason: "Incomplete review: no verdict",
        destinations,
        toolCalls,
      };
    }
    return { status: "complete", markdown: opts.store.toMarkdown(), destinations, toolCalls };
  } catch (err) {
    if (err instanceof EngineFailedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "incomplete",
      markdown: opts.store.toMarkdown(),
      reason: `Incomplete review: ${message}`,
      destinations,
      toolCalls,
    };
  } finally {
    globalThis.fetch = realFetch;
    try {
      session?.dispose();
    } catch {
      // Ignore disposal errors.
    }
    if (ownAgentDir) {
      await rm(agentDir, { recursive: true, force: true }).catch(() => undefined);
      void log;
    }
  }
}
