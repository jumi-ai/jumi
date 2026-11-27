/**
 * Pi codemode loadout (jumi#997).
 *
 * Codemode is the one deliberate built-in exception to Jumi's "no Pi
 * settings, extensions, or MCP servers" isolation: both Pi roles declare the
 * `codemode` tool in `on` mode so the model can batch `read`/`bash`/`jumi_*`
 * calls in one script. Everything else stays exactly as strict as before:
 * no user, global, or project Pi settings, extensions, hooks, packages, or
 * MCP servers load, and `builtin:mcp` / `builtin:tool-search` stay off.
 *
 * Guarantees enforced here (not in prompt text):
 * - `models.*` is never exposed to scripts (`models: false`). A script that
 *   touches `models` fails without reaching a provider, spending credentials,
 *   or making network calls.
 * - Codemode's own file writes (truncated-output spill, `image()` saves) go
 *   through `os.tmpdir()`. The harnesses point `TMPDIR` at the job-owned
 *   scratch dir for the duration of the attempt so those files land only in
 *   scratch, never in the checkout diff or outside the write roots.
 */

import {
  createCodemodeExtension,
  DefaultResourceLoader,
  type ResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** The only Pi tool scripts may use to call other tools. */
export const PI_CODEMODE_TOOL_NAME = "codemode" as const;

/**
 * Codemode in `on` mode without model access. `on` keeps the role's direct
 * tools declared to the model; scripts are an extra way to call them. `only`
 * stays off. `models: false` removes the `models` global so classifier and
 * image calls fail before any provider request.
 */
function createPiCodemodeFactory(): ReturnType<typeof createCodemodeExtension> {
  return createCodemodeExtension({ models: false, mode: "on" });
}

/**
 * Trusted loader with no discovery and exactly one inline extension:
 * codemode. No project/head, user, or global Pi settings, extensions, hooks,
 * packages, or MCP servers load. Trusted base instructions are prompt data,
 * never executable configuration. The loader's own cwd/agentDir never grant
 * the session filesystem access: the session cwd/agentDir are passed to
 * `createAgentSession`, and `noExtensions`/`noSkills`/etc. disable all
 * discovery, so dummy values here cannot widen the loadout.
 */
export function createTrustedPiLoaderWithCodemode(systemPrompt: string): ResourceLoader {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    enableAnalytics: false,
    enableInstallTelemetry: false,
    packages: [],
    extensions: [],
  } as Parameters<typeof SettingsManager.inMemory>[0]);
  const inner = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager: settings as never,
    extensionFactories: [createPiCodemodeFactory() as never],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    skillsOverride: () => ({ skills: [], diagnostics: [] }) as never,
    promptsOverride: () => ({ prompts: [], diagnostics: [] }) as never,
    themesOverride: () => ({ themes: [], diagnostics: [] }) as never,
    agentsFilesOverride: () => ({ agentsFiles: [] }) as never,
  } as never);
  // `DefaultResourceLoader.getSystemPrompt()` is only populated after
  // `reload()`, but callers (and the pre-existing Go round-trip test) read it
  // synchronously. The prompt is fixed at construction, so expose it
  // immediately while delegating everything else to the inner loader.
  const loader = inner as unknown as ResourceLoader & {
    getSystemPrompt: () => string | undefined;
  };
  const getSystemPrompt = loader.getSystemPrompt.bind(loader);
  return {
    getExtensions: loader.getExtensions.bind(loader),
    getSkills: loader.getSkills.bind(loader),
    getPrompts: loader.getPrompts.bind(loader),
    getThemes: loader.getThemes.bind(loader),
    getAgentsFiles: loader.getAgentsFiles.bind(loader),
    getSystemPrompt: () => getSystemPrompt() ?? systemPrompt,
    getSystemPromptSource: loader.getSystemPromptSource.bind(loader),
    getAppendSystemPrompt: loader.getAppendSystemPrompt.bind(loader),
    getAppendSystemPromptSources: loader.getAppendSystemPromptSources.bind(loader),
    extendResources: loader.extendResources.bind(loader),
    reload: loader.reload.bind(loader),
  } as unknown as ResourceLoader;
}

/**
 * Run `fn` with `TMPDIR` pointed at the job-owned scratch dir so codemode's
 * own writes (full-output spill, `image()` saves via `writeOutputFile`,
 * which uses `os.tmpdir()`) land only in scratch. Restores the previous
 * value even on failure. The scratch dir lives under
 * `<workdir>/.jumi-tmp/scratch`, which the parent diff already excludes.
 */
export async function withPiCodemodeScratch<T>(scratchDir: string, fn: () => Promise<T>): Promise<T> {
  const key = "TMPDIR";
  const previous = process.env[key];
  process.env[key] = scratchDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

export interface PiCodemodeCallRecord {
  name: string;
  args: unknown;
  ok: boolean;
  text: string;
}

/**
 * Collect codemode outer calls from the session branch for telemetry and
 * evidence. Nested calls are already recorded by the guarded tools'
 * `onCall`; without this the outer `codemode` invocation itself would be
 * invisible. Returns one record per `codemode` tool result, with the joined
 * text content (truncated) and the `fullOutputPath` spill, if any.
 */
export function collectPiCodemodeCalls(
  branch: readonly unknown[]
): Array<PiCodemodeCallRecord & { fullOutputPath?: string }> {
  const out: Array<PiCodemodeCallRecord & { fullOutputPath?: string }> = [];
  for (const entry of branch as Array<{
    type?: unknown;
    message?: {
      role?: unknown;
      toolName?: unknown;
      toolCallId?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: unknown;
    };
  }>) {
    if (entry?.type !== "message") continue;
    const message = entry.message as
      | {
          role?: unknown;
          toolName?: unknown;
          content?: Array<{ type?: unknown; text?: unknown }>;
          details?: { fullOutputPath?: unknown };
          isError?: unknown;
        }
      | undefined;
    if (!message || message.role !== "toolResult" || message.toolName !== PI_CODEMODE_TOOL_NAME) continue;
    const texts = Array.isArray(message.content)
      ? message.content
          .filter((block) => block?.type === "text")
          .map((block) => String(block?.text ?? ""))
          .join("\n")
      : "";
    const fullOutputPath =
      message.details &&
      typeof message.details === "object" &&
      typeof (message.details as { fullOutputPath?: unknown }).fullOutputPath === "string"
        ? ((message.details as { fullOutputPath: string }).fullOutputPath as string)
        : undefined;
    out.push({
      name: PI_CODEMODE_TOOL_NAME,
      args: {},
      ok: message.isError !== true,
      text: texts.slice(0, 8000),
      ...(fullOutputPath ? { fullOutputPath } : {}),
    });
  }
  return out;
}

/**
 * Fail closed when a codemode spill or image file lands outside the
 * job-owned scratch dir. Returns the offending path, or `null` when every
 * recorded codemode file write is inside scratch.
 */
export function findCodemodeEscape(
  calls: ReadonlyArray<{ fullOutputPath?: string; text: string }>,
  scratchDir: string,
  workdir: string
): string | null {
  const inside = (candidate: string, root: string): boolean => {
    const normalized = candidate === root || candidate.startsWith(`${root}/`);
    return normalized;
  };
  for (const call of calls) {
    if (call.fullOutputPath && !inside(call.fullOutputPath, scratchDir)) {
      return call.fullOutputPath;
    }
    // Image saves render as `[Image saved to <path> (...)]` in the text.
    for (const match of call.text.matchAll(/\[Image saved to ([^\]]+?) \(/g)) {
      const raw = (match[1] ?? "").trim().split(" ")[0] ?? "";
      if (!raw) continue;
      if (!inside(raw, scratchDir) && !inside(raw, workdir)) return raw;
      if (inside(raw, workdir) && !inside(raw, scratchDir)) return raw;
    }
  }
  return null;
}
