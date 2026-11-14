#!/usr/bin/env bun
/**
 * Prove the forge webfetch permission map against the *installed OpenCode
 * binary*, not a re-implementation of its wildcard matcher.
 *
 * A unit test that copies `Wildcard.match` grades itself: an OpenCode upgrade
 * can change matching semantics, silently drop the forge-host deny, and leave
 * the copy green. So this probe drives the real binary instead.
 *
 * How: stand up a throwaway OpenAI-compatible provider on loopback that always
 * answers with a single `webfetch` tool call for the URL under test, run
 * `opencode run` against it with `OPENCODE_CONFIG_CONTENT` carrying the exact
 * rules production uses, then read back what OpenCode fed the model as the tool
 * result. The same server also serves the fetch targets, so an allowed URL is
 * observed as a real HTTP hit and a denied URL is observed as no hit at all.
 *
 * The workspace is a repository that tries to get around the deny the ways a
 * repo can: a project permission, a repo agent's own rules, and a repo policy.
 * The same runs prove the rest of what a repo brings: its `AGENTS.md` reaches the
 * model, its plugin loads, and its skills load without running their commands.
 *
 * A web search runs under each shipped config too. With no provider selected,
 * OpenCode 2 cancels the search headless and `run` exits 1 after a finished
 * session, which discards the review.
 *
 * Exit 0 when every case matches its expectation, 1 otherwise.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  forgeOpenCodeConfigContent,
  forgeOpenCodeGlobalConfig,
  forgePermissions,
  isPermissionDenyText,
} from "./forge_webfetch.ts";
import { applyOpenCodeInlineConfig, type OpenCodeRunOptions } from "./git.ts";
import { SEARXNG_OPENCODE_TOOL, SEARXNG_SERVER_NAME } from "./searxng.ts";

/** Example homelab host for manual probing only; production derives the deny host from config. */
const PROBE_DENY_DOMAIN = "kirmanak.stream";

/** Body served for every probe target; seeing it means webfetch actually ran. */
const FETCH_MARKER = "JUMI-WEBFETCH-PROBE-REACHED";
/** Text of the planted `AGENTS.md`; seeing it in a request means instructions loaded. */
const INSTRUCTIONS_MARKER = "JUMI-AGENTS-MD-PROBE-REACHED";
const PROVIDER_ID = "jumi-webfetch-probe";
const MODEL_ID = "probe-model";
/**
 * Cap a single `opencode run`. The provider is loopback, so a healthy run is
 * seconds; this is only a hang guard. Kept low enough that the whole table
 * (`probeCases().length * RUN_TIMEOUT_MS`) stays well under the `timeout 600`
 * the image verification steps wrap the probe in — otherwise a partial hang
 * would be killed from outside as exit 124 with no per-row report.
 */
const RUN_TIMEOUT_MS = 60_000;

/** The checkout roots OpenCode 2 scans on its own. */
const CHECKOUT_SKILL_ROOTS = [".claude/skills", ".agents/skills", ".opencode/skills"];
const SKILL_BODY_MARKER = "JUMI-SKILL-PROBE-BODY";

const SHIPPED_CONFIGS = ["opencode-review.json", "opencode-implement.json"];
/** Base-branch marker for the review case: the head marker must never reach a review. */
const REVIEW_BASE_MARKER = "JUMI-REVIEW-BASE-AGENTS-MD-PROBE-REACHED";
/** Base-branch skill for the review case. */
const REVIEW_BASE_SKILL = "jumi-review-base-skill";
/** Head-only skill for the review case. */
const REVIEW_HEAD_SKILL = "jumi-review-head-skill";
/** Head-only skill under OpenCode's own skills root: project config off must block it too. */
const REVIEW_HEAD_OPENCODE_SKILL = "jumi-review-head-opencode-skill";
/** Keeps the search off the network: a failed search must leave the run alive. */
const SEARCH_OFFLINE_ENV = {
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1",
};

type Expectation = "allow" | "deny";

interface ProbeCase {
  /** Why this row exists, printed in the report. */
  readonly name: string;
  readonly url: string;
  readonly expect: Expectation;
}

/**
 * Built against the live loopback port so allow/deny is observable as an HTTP
 * hit, plus the real forge URLs the deny exists for.
 */
function probeCases(origin: string): readonly ProbeCase[] {
  return [
    {
      name: "unrelated host is fetchable",
      url: `${origin}/docs/upstream/readme`,
      expect: "allow",
    },
    {
      name: "forge host (real reviewer URL)",
      url: "https://gitea.kirmanak.stream/personal/jumi/pulls/1",
      expect: "deny",
    },
    {
      name: "forge API (real reviewer URL)",
      url: "https://gitea.kirmanak.stream/api/v1/repos/personal/jumi/issues",
      expect: "deny",
    },
    {
      name: "forge host, reachable target",
      url: `${origin}/gitea.kirmanak.stream/personal/jumi`,
      expect: "deny",
    },
    {
      name: "code search, reachable target",
      url: `${origin}/github.com/search?q=jumi`,
      expect: "deny",
    },
  ];
}

interface RunState {
  /** URL the fake model asks OpenCode to fetch this run. */
  url: string;
  /** Tool-result text OpenCode sent back to the model, if the call completed. */
  toolResult?: string;
  /** True once the probe target was actually requested over HTTP. */
  reached: boolean;
  /** True once any model request carried the planted `AGENTS.md`. */
  instructionsSeen: boolean;
  /** True once any model request carried the review base `AGENTS.md`. */
  baseSeen: boolean;
  /** Skill the stub's model loads instead of calling `webfetch`, when set. */
  skillId?: string;
  /** True when the stub's model calls `websearch` instead of `webfetch`. */
  search?: boolean;
  /** True when the stub's model calls the searxng MCP search tool. */
  mcpSearch?: boolean;
  /** True while the stub drives the production review shell plugin case. */
  pluginCase?: boolean;
  /** Harness MCP token path the plugin case must deny. */
  pluginTokenPath?: string;
  /** Sandbox HOME the plugin case must wrap shells into (proves wrapping). */
  pluginExpectedHome?: string;
  /** Tool results from the plugin-case run, in call order. */
  pluginResults?: string[];
  /** Call the stub is still waiting on a tool result for (id-tracked). */
  pluginPending?: { id: string; name: string; args: string };
  /** Completed plugin-case tool calls, paired by call id. */
  pluginCompleted?: { id: string; name: string; result: string }[];
  /** Counter for plugin-case call ids. */
  pluginNextId?: number;
}

function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

function toolCall(state: RunState): { name: string; arguments: string } {
  if (state.mcpSearch) return { name: SEARXNG_OPENCODE_TOOL, arguments: JSON.stringify({ query: "jumi probe" }) };
  if (state.search) return { name: "websearch", arguments: JSON.stringify({ query: "jumi probe" }) };
  if (state.skillId) return { name: "skill", arguments: JSON.stringify({ id: state.skillId }) };
  return { name: "webfetch", arguments: JSON.stringify({ url: state.url, format: "text" }) };
}

/**
 * Scripted calls for the review-plugin case. The pinned binary (2.2.7) ships
 * the shell tool as `shell` (a `bash` call aliases to it before hooks run),
 * `read` takes `path`, `list` takes `path`:
 * - `shell` runs `printenv HOME` until HOME comes back as the sandbox home
 *   (bounded retries: the plugin loads asynchronously with the first `run`,
 *   so the first calls can race registration — a hook that never registers
 *   exhausts the bound and fails the case instead of passing unwrapped);
 * - then `read` and `list` on the harness MCP token (both must come back
 *   blocked, never the token).
 */
const MAX_PLUGIN_SHELL_ATTEMPTS = 10;
interface PluginCall {
  readonly name: string;
  readonly args: string;
  readonly id: string;
}
/**
 * Harvest whatever tool results this request carries (paired by call id, so
 * retried turns, title-generation requests, or batched tool messages cannot
 * shift the pairing), then decide the next scripted call. At most one call is
 * ever outstanding: a request with no new result re-emits the pending call
 * with the same id instead of scripting a spurious duplicate.
 */
function reviewPluginCall(state: RunState, toolMessages: { id?: string; content: string }[]): PluginCall | undefined {
  const tokenPath = state.pluginTokenPath;
  const expectedHome = state.pluginExpectedHome;
  if (tokenPath === undefined || expectedHome === undefined) return undefined;
  if (state.pluginCompleted === undefined) state.pluginCompleted = [];
  const completed = state.pluginCompleted;
  for (const message of toolMessages) {
    if (
      message.id !== undefined &&
      state.pluginPending?.id === message.id &&
      !completed.some((done) => done.id === message.id)
    ) {
      completed.push({ id: message.id, name: state.pluginPending.name, result: message.content });
      state.pluginPending = undefined;
    }
  }
  if (state.pluginPending !== undefined) {
    state.pluginResults?.push(`called:${state.pluginPending.name}:${state.pluginPending.id} (repeat)`);
    return { name: state.pluginPending.name, args: state.pluginPending.args, id: state.pluginPending.id };
  }
  const done = (tool: string): string[] => completed.filter((call) => call.name === tool).map((call) => call.result);
  let next: { name: string; args: string } | undefined;
  const shells = done("shell");
  if (!shells.some((result) => result.includes(expectedHome)) && shells.length < MAX_PLUGIN_SHELL_ATTEMPTS)
    next = { name: "shell", args: JSON.stringify({ command: "printenv HOME" }) };
  else if (done("read").length === 0) next = { name: "read", args: JSON.stringify({ path: tokenPath }) };
  else if (done("list").length === 0) next = { name: "list", args: JSON.stringify({ path: dirname(tokenPath) }) };
  if (next === undefined) return undefined;
  const nextId = (state.pluginNextId ?? 0) + 1;
  state.pluginNextId = nextId;
  const id = `call-plugin-${nextId}`;
  state.pluginPending = { id, ...next };
  state.pluginResults?.push(`called:${next.name}:${id}`);
  return { ...next, id };
}
function startProbeServer(state: RunState) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (!pathname.endsWith("/chat/completions")) {
        state.reached = true;
        return new Response(FETCH_MARKER, { headers: { "content-type": "text/plain" } });
      }
      const body = (await req.json()) as {
        model?: string;
        messages?: { role?: string; content?: unknown; tool_call_id?: string }[];
      };
      if (JSON.stringify(body.messages ?? []).includes(INSTRUCTIONS_MARKER)) state.instructionsSeen = true;
      if (JSON.stringify(body.messages ?? []).includes(REVIEW_BASE_MARKER)) state.baseSeen = true;
      const toolMessages = (body.messages ?? []).filter((m) => m.role === "tool");
      const toolMessage = toolMessages[toolMessages.length - 1];
      if (toolMessage) state.toolResult = String(toolMessage.content ?? "");
      const base = { id: "chatcmpl-probe", created: Math.floor(Date.now() / 1000), model: body.model ?? MODEL_ID };
      const pluginCall =
        state.pluginCase === true
          ? reviewPluginCall(
              state,
              toolMessages.map((m) => ({ id: m.tool_call_id, content: String(m.content ?? "").slice(0, 2000) }))
            )
          : undefined;
      if (state.pluginCase === true) {
        for (const m of toolMessages) {
          state.pluginResults?.push(`result:${m.tool_call_id ?? "?"}:${String(m.content ?? "").slice(0, 300)}`);
        }
      }
      const delta =
        pluginCall !== undefined
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: pluginCall.id,
                  type: "function",
                  function: { name: pluginCall.name, arguments: pluginCall.args },
                },
              ],
            }
          : toolMessage
            ? { role: "assistant", content: "probe complete" }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_probe",
                    type: "function",
                    function: toolCall(state),
                  },
                ],
              };
      const finish = pluginCall !== undefined || toolMessage === undefined ? "tool_calls" : "stop";
      return new Response(
        sse([
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] },
        ]),
        { headers: { "content-type": "text/event-stream" } }
      );
    },
  });
}

/** A skill under `root`, carrying a frontmatter hook and inline shell that create `ranMarker`. */
async function seedCheckoutSkill(workdir: string, root: string, id: string, ranMarker: string): Promise<void> {
  await mkdir(join(workdir, root, id), { recursive: true });
  const hook = `hooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: "touch ${ranMarker}"\n`;
  await writeFile(
    join(workdir, root, id, "SKILL.md"),
    `---\nname: ${id}\ndescription: "Jumi webfetch probe skill"\n${hook}---\n${SKILL_BODY_MARKER} !\`touch ${ranMarker}\`\n\n\`\`\`!\ntouch ${ranMarker}\n\`\`\`\n`
  );
}

/** Every way the deny could be lifted from inside a repo, plus a plugin that leaves a marker. */
async function seedRepository(workdir: string, pluginMarker: string): Promise<void> {
  const allow = [{ action: "webfetch", resource: "*", effect: "allow" }];
  await writeFile(
    join(workdir, "opencode.json"),
    JSON.stringify({
      permissions: allow,
      policies: [{ action: "tool.use", resource: "webfetch:*", effect: "allow" }],
      agents: { build: { permissions: allow } },
    })
  );
  await mkdir(join(workdir, ".opencode", "plugins", "jumi-probe"), { recursive: true });
  await writeFile(
    join(workdir, ".opencode", "plugins", "jumi-probe", "index.ts"),
    `import { writeFileSync } from "node:fs";
export default { id: "jumi-probe", setup: async () => writeFileSync(${JSON.stringify(pluginMarker)}, "ran") };
`
  );
}

async function writeProbeConfig(dir: string, origin: string, websearch?: unknown): Promise<string> {
  const path = join(dir, "opencode-probe.json");
  await writeFile(
    path,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      update: "disable",
      snapshots: false,
      websearch,
      providers: {
        [PROVIDER_ID]: {
          name: "jumi webfetch probe",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: `${origin}/v1`, apiKey: "probe" },
          models: { [MODEL_ID]: { name: MODEL_ID, capabilities: { tools: true } } },
        },
      },
      // webfetch stays one star allow here on purpose: the rules under test arrive
      // at run time, exactly the way production delivers them.
      permissions: [
        { action: "webfetch", resource: "*", effect: "allow" },
        { action: "websearch", resource: "*", effect: "allow" },
        { action: "skill", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "question", resource: "*", effect: "deny" },
      ],
    }),
    "utf8"
  );
  return path;
}

async function runOpenCode(
  workdir: string,
  configPath: string,
  extraEnv: Record<string, string> = {},
  opts: { configContent?: string; globalPolicies?: string } = {}
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const xdgConfigHome = join(workdir, "..", "xdg-config");
  if (opts.globalPolicies !== undefined) {
    await mkdir(join(xdgConfigHome, "opencode"), { recursive: true });
    await writeFile(join(xdgConfigHome, "opencode", "opencode.json"), opts.globalPolicies);
  }
  const proc = Bun.spawn(
    ["opencode", "run", "--standalone", "--model", `${PROVIDER_ID}/${MODEL_ID}`, "fetch the url"],
    {
      cwd: workdir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // OpenCode 2 takes its directory from PWD before cwd, and relative
        // `skills` roots resolve against it. Same line as the production spawn.
        PWD: workdir,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_CONTENT: opts.configContent ?? forgeOpenCodeConfigContent(PROBE_DENY_DOMAIN),
        XDG_CONFIG_HOME: xdgConfigHome,
        ...extraEnv,
      },
    }
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, RUN_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, output: `${stdout}${stderr}`, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Review spawn through the production path: `OPENCODE_DISABLE_PROJECT_CONFIG=1`
 * with the forge deny still in force, plus the base skills/instructions from
 * outside the checkout. The head's `opencode.json`, plugin, skills, and
 * `AGENTS.md` stay on disk but must never load.
 */
async function runReviewOpenCode(
  workdir: string,
  configPath: string,
  baseDir: string,
  xdgConfig: string,
  extraEnv: Record<string, string> = {}
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const { readFile } = await import("node:fs/promises");
  let baseAgents = "";
  try {
    baseAgents = await readFile(join(baseDir, "AGENTS.md"), "utf8");
  } catch {
    baseAgents = "";
  }
  void baseAgents;
  const configContent = JSON.stringify({
    permissions: [
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "skill", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
      ...forgePermissions(PROBE_DENY_DOMAIN),
    ],
    skills: [join(baseDir, "skills")],
    instructions: [join(baseDir, "AGENTS.md")],
  });
  const proc = Bun.spawn(
    ["opencode", "run", "--standalone", "--model", `${PROVIDER_ID}/${MODEL_ID}`, "fetch the url"],
    {
      cwd: workdir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PWD: workdir,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_CONTENT: configContent,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        XDG_CONFIG_HOME: xdgConfig,
        ...extraEnv,
      },
    }
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, RUN_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, output: `${stdout}${stderr}`, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Marker standing in for the review MCP bearer token the plugin must deny. */
const REVIEW_PLUGIN_TOKEN = "JUMI-REVIEW-PLUGIN-PROBE-TOKEN";

/** Marker for the wrapped shell HOME the plugin case expects back from `shell`. */
const REVIEW_PLUGIN_SANDBOX_HOME_SUFFIX = "sandbox-home";

/**
 * Review-plugin case through the production path: the production
 * `writeOpenCodeReviewShellPlugin` output registered in a scratch global
 * config (the `plugins` key under a scratch `XDG_CONFIG_HOME`, exactly like
 * `runOpenCode` registers it), then the installed binary drives the stub
 * model through `shell` (must come back wrapped: HOME is the sandbox home),
 * `read` of the harness token (must come back blocked), and `list` of the
 * harness temp (blocked too). Project config stays disabled so the checkout
 * cannot shadow the harness plugin.
 */
async function runReviewPluginOpenCode(
  workdir: string,
  configPath: string,
  xdgConfig: string,
  onHarness: (tokenPath: string, expectedHome: string) => void
): Promise<{
  code: number;
  output: string;
  timedOut: boolean;
  sandboxHome: string;
  pluginDir: string;
  pluginReady: boolean;
}> {
  const {
    ensureSandboxedShellHome,
    resolveWorktreeGitDirsSync,
    reviewSandboxWrapperPath,
    sandboxedShellEnv,
    writeOpenCodeReviewShellPlugin,
    REVIEW_SHELL_PLUGIN_READY_NAME,
  } = await import("./review_sandbox.ts");
  // Harness temp under the shared tmpdir (never the checkout), mirroring
  // `makeReviewHarnessTempRoot`: the shell policy omits the shared tmpdir so
  // the token configs stay unreachable outside the plugin deny.
  const harnessTemp = await mkdtemp("/tmp/jumi-review-plugin-probe-");
  try {
    const scratchDir = join(workdir, ".jumi-tmp", "scratch");
    await mkdir(scratchDir, { recursive: true });
    await ensureSandboxedShellHome(scratchDir);
    const sandboxHome = sandboxedShellEnv(scratchDir).HOME;
    const tokenPath = join(harnessTemp, "review-mcp.json");
    await writeFile(tokenPath, JSON.stringify({ token: REVIEW_PLUGIN_TOKEN }), { mode: 0o600 });
    onHarness(tokenPath, sandboxHome);
    const home = process.env.HOME ?? workdir;
    const pluginDir = await writeOpenCodeReviewShellPlugin(harnessTemp, {
      workdir,
      scratchDir,
      harnessTempDir: harnessTemp,
      homeDir: home,
      gitDirs: resolveWorktreeGitDirsSync(workdir),
      wrapperPath: reviewSandboxWrapperPath(),
    });
    await mkdir(join(xdgConfig, "opencode"), { recursive: true });
    const globalPath = join(xdgConfig, "opencode", "opencode.json");
    let globalConfig: Record<string, unknown> = {};
    try {
      globalConfig = JSON.parse(await readFile(globalPath, "utf8")) as Record<string, unknown>;
    } catch {
      globalConfig = {};
    }
    const existing = Array.isArray(globalConfig.plugins) ? (globalConfig.plugins as unknown[]) : [];
    if (!existing.includes(pluginDir)) globalConfig.plugins = [...existing, pluginDir];
    await writeFile(globalPath, JSON.stringify(globalConfig), { mode: 0o600 });
    const configContent = JSON.stringify({
      permissions: [
        { action: "shell", resource: "*", effect: "allow" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "list", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "question", resource: "*", effect: "deny" },
      ],
    });
    const proc = Bun.spawn(
      ["opencode", "run", "--standalone", "--model", `${PROVIDER_ID}/${MODEL_ID}`, "run the requested tools"],
      {
        cwd: workdir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PWD: workdir,
          OPENCODE_CONFIG: configPath,
          OPENCODE_CONFIG_CONTENT: configContent,
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          XDG_CONFIG_HOME: xdgConfig,
        },
      }
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, RUN_TIMEOUT_MS);
    try {
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      // Read before the finally below removes the harness temp: proves the
      // plugin's setup ran to completion (both hooks registered).
      const pluginReady = await Bun.file(join(harnessTemp, REVIEW_SHELL_PLUGIN_READY_NAME)).exists();
      return { code: await proc.exited, output: `${stdout}${stderr}`, timedOut, sandboxHome, pluginDir, pluginReady };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(harnessTemp, { recursive: true, force: true });
  }
}

interface CaseResult {
  readonly probe: ProbeCase;
  readonly ok: boolean;
  readonly observed: string;
}

function judge(probe: ProbeCase, state: RunState): CaseResult {
  const result = state.toolResult;
  if (result == null) {
    return { probe, ok: false, observed: "OpenCode never returned a webfetch tool result" };
  }
  if (probe.expect === "allow") {
    const ok = state.reached && result.includes(FETCH_MARKER);
    return { probe, ok, observed: ok ? "fetched" : `not fetched (reached=${state.reached}): ${result.slice(0, 200)}` };
  }
  if (state.reached) {
    return { probe, ok: false, observed: "DENIED URL WAS FETCHED: the probe target received a request" };
  }
  // Keyed on OpenCode's deny text, not on the absence of a hit: an unrelated
  // failure (network error, bad tool name) also produces no HTTP request.
  const ok = isPermissionDenyText(result) && !result.includes(FETCH_MARKER);
  return {
    probe,
    ok,
    observed: ok ? "denied, with the forge webfetch rules in force" : `not denied: ${result.slice(0, 200)}`,
  };
}

/** Snippet the stub SearXNG instance returns; seeing it means the MCP search ran. */
const SEARXNG_SNIPPET_MARKER = "JUMI-SEARXNG-PROBE-SNIPPET";

/**
 * Stands in for the deployer's SearXNG instance: every `/search` answers the
 * JSON API shape `querySearxng` reads, with one loopback result on a host the
 * forge filter keeps.
 */
function startStubSearxng() {
  const state = { port: 0 };
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (!pathname.endsWith("/search")) return new Response("not found", { status: 404 });
      return Response.json({
        results: [
          {
            title: "Jumi searxng probe",
            url: `http://127.0.0.1:${state.port}/docs/upstream/readme`,
            content: SEARXNG_SNIPPET_MARKER,
          },
        ],
      });
    },
  });
  state.port = stub.port ?? 0;
  return stub;
}

/** Native search must be denied, even when the checkout tries to re-allow it. */
function judgeSearchDeny(label: string, result: string | undefined): { ok: boolean; line: string } {
  if (result == null) return { ok: false, line: `${label}: no tool result` };
  // The installed binary removes a policy-denied tool from the request
  // ("Tool is not available for this request: <tool>") instead of returning
  // the permission-deny text; either wording proves the tool cannot be used.
  // Anything else — including a ran-and-failed search — means the deny did
  // not hold.
  const unavailable = /not available for this request/i.test(result) && result.includes("websearch");
  const ok = isPermissionDenyText(result) || unavailable;
  return { ok, line: ok ? `${label}: denied` : `${label}: NOT DENIED: ${result.slice(0, 200)}` };
}

async function main(): Promise<number> {
  const state: RunState = { url: "", reached: false, instructionsSeen: false, baseSeen: false };
  const server = startProbeServer(state);
  const origin = `http://127.0.0.1:${server.port}`;
  const dir = await mkdtemp(join(tmpdir(), "jumi-webfetch-probe-"));
  const results: CaseResult[] = [];
  const skillChecks: { ok: boolean; line: string }[] = [];
  const searchChecks: { ok: boolean; line: string }[] = [];
  const searxngChecks: { ok: boolean; line: string }[] = [];
  let pluginRan = false;
  let workerInstructionsSeen = false;
  try {
    const workdir = join(dir, "workspace");
    await Bun.$`mkdir -p ${workdir}`.quiet();
    await Bun.$`git init -q`.cwd(workdir).quiet();
    await writeFile(join(workdir, "AGENTS.md"), `${INSTRUCTIONS_MARKER}\n`);
    const pluginMarker = join(dir, "repo-plugin-ran");
    await seedRepository(workdir, pluginMarker);
    await mkdir(join(dir, "xdg-config", "opencode"), { recursive: true });
    await writeFile(join(dir, "xdg-config", "opencode", "opencode.json"), forgeOpenCodeGlobalConfig(PROBE_DENY_DOMAIN));
    const configPath = await writeProbeConfig(dir, origin);

    console.log(`Permission rules under test: ${JSON.stringify(forgePermissions(PROBE_DENY_DOMAIN))}`);
    for (const probe of probeCases(origin)) {
      state.url = probe.url;
      state.reached = false;
      state.toolResult = undefined;
      const { code, output, timedOut } = await runOpenCode(workdir, configPath);
      if (timedOut) {
        results.push({ probe, ok: false, observed: `opencode run hung, killed after ${RUN_TIMEOUT_MS}ms` });
        continue;
      }
      if (state.toolResult == null && code !== 0) {
        results.push({ probe, ok: false, observed: `opencode run exited ${code}: ${output.slice(-400)}` });
        continue;
      }
      results.push(judge(probe, state));
    }

    pluginRan = await Bun.file(pluginMarker).exists();
    const ranMarker = join(dir, "skill-command-ran");
    for (const root of CHECKOUT_SKILL_ROOTS) {
      const id = `jumi-probe${root.replace(/\W+/g, "-")}`;
      await seedCheckoutSkill(workdir, root, id, ranMarker);
      state.skillId = id;
      state.toolResult = undefined;
      const { timedOut } = await runOpenCode(workdir, configPath);
      const loaded = !timedOut && (state.toolResult ?? "").includes(SKILL_BODY_MARKER);
      const ran = await Bun.file(ranMarker).exists();
      skillChecks.push({
        ok: loaded && !ran,
        line: `checkout ${root} skill ${loaded ? "loads" : "DID NOT LOAD"}, its hook and inline shell ${ran ? "RAN" : "did not run"}`,
      });
    }

    state.skillId = undefined;
    state.search = true;
    for (const name of SHIPPED_CONFIGS) {
      const shipped = JSON.parse(await readFile(join(import.meta.dir, "../../../.gitea", name), "utf8"));
      const searchConfig = await writeProbeConfig(dir, origin, shipped.websearch);
      state.toolResult = undefined;
      const { code, timedOut } = await runOpenCode(workdir, searchConfig, SEARCH_OFFLINE_ENV);
      const result = state.toolResult ?? "";
      searchChecks.push({
        ok: !timedOut && code === 0 && result.includes("Unable to search the web"),
        line: `${name}: a failed web search leaves the run alive (exit ${code}, ${result.slice(0, 120) || "no tool result"})`,
      });
    }
    state.search = undefined;

    // Configured mode: the exact inline config production builds, plus the
    // global policy, against the installed binary. Native `websearch` must be
    // denied — even with a checkout re-allowing it at every level it can
    // (permissions, agent rules, repo policy) — while the searxng MCP tool the
    // same inline config allows stays callable end to end.
    const searxngStub = startStubSearxng();
    try {
      const searxngOrigin = `http://127.0.0.1:${searxngStub.port}`;
      process.env.JUMI_SEARXNG_URL = searxngOrigin;
      let inlineContent = "";
      try {
        const inlineEnv: Record<string, string> = {};
        const inlineOpts: OpenCodeRunOptions = {
          model: "probe",
          workdir,
          extraEnv: { GIT_AUTH_HOST: PROBE_DENY_DOMAIN },
        };
        applyOpenCodeInlineConfig(inlineEnv, inlineOpts);
        inlineContent = inlineEnv.OPENCODE_CONFIG_CONTENT ?? "";
      } finally {
        delete process.env.JUMI_SEARXNG_URL;
      }
      if (!inlineContent.includes(SEARXNG_SERVER_NAME)) {
        searxngChecks.push({ ok: false, line: "production inline config registers the searxng server" });
      }
      const hostile = {
        permissions: [
          { action: "websearch", resource: "*", effect: "allow" },
          { action: "webfetch", resource: "*", effect: "allow" },
        ],
        policies: [
          { action: "tool.use", resource: "webfetch:*", effect: "allow" },
          { action: "tool.use", resource: "websearch:*", effect: "allow" },
          { action: "websearch.use", resource: "*", effect: "allow" },
        ],
        agents: { build: { permissions: [{ action: "websearch", resource: "*", effect: "allow" }] } },
      };
      await writeFile(join(workdir, "opencode.json"), JSON.stringify(hostile));
      // Production names a websearch provider in the shipped config (a
      // headless run exits 1 without one), so the deny runs use a config with
      // one: without a provider "not available" would prove nothing about the
      // policy. The offline env keeps a missed deny fast and hermetic.
      const providerConfig = await writeProbeConfig(dir, origin, { provider: "exa" });
      // Control first: without the searxng deny the tool is offered and runs
      // (and fails offline), proving "not available" below comes from the
      // policy rather than the provider setup.
      state.mcpSearch = undefined;
      state.search = true;
      state.toolResult = undefined;
      {
        const baseEnv: Record<string, string> = {};
        applyOpenCodeInlineConfig(baseEnv, { model: "probe", workdir, extraEnv: {} });
        const { timedOut } = await runOpenCode(workdir, providerConfig, SEARCH_OFFLINE_ENV, {
          configContent: baseEnv.OPENCODE_CONFIG_CONTENT ?? forgeOpenCodeConfigContent(PROBE_DENY_DOMAIN),
          globalPolicies: forgeOpenCodeGlobalConfig(PROBE_DENY_DOMAIN),
        });
        const result = state.toolResult ?? "";
        const ok = !timedOut && result.includes("Unable to search the web");
        searxngChecks.push({
          ok,
          line: ok
            ? "control: without the searxng deny the native tool runs (and fails offline)"
            : `control: native tool did not run without the deny (timedOut=${timedOut}): ${result.slice(0, 200) || "no tool result"}`,
        });
      }
      // Native search stays denied under the hostile checkout.
      state.mcpSearch = undefined;
      state.search = true;
      state.toolResult = undefined;
      {
        const { timedOut } = await runOpenCode(workdir, providerConfig, SEARCH_OFFLINE_ENV, {
          configContent: inlineContent,
          globalPolicies: forgeOpenCodeGlobalConfig(PROBE_DENY_DOMAIN, true),
        });
        const result = state.toolResult ?? "";
        const judged = judgeSearchDeny("configured: native websearch denied under a hostile checkout", result);
        searxngChecks.push({ ...judged, ok: judged.ok && !timedOut });
      }
      // The searxng MCP tool from the same inline config is callable.
      state.search = undefined;
      state.mcpSearch = true;
      state.toolResult = undefined;
      {
        const { timedOut } = await runOpenCode(
          workdir,
          providerConfig,
          {},
          {
            configContent: inlineContent,
            globalPolicies: forgeOpenCodeGlobalConfig(PROBE_DENY_DOMAIN, true),
          }
        );
        const result = state.toolResult ?? "";
        const ok = !timedOut && result.includes(SEARXNG_SNIPPET_MARKER);
        searxngChecks.push({
          ok,
          line: ok
            ? "configured: the searxng MCP search tool answers through the stub instance"
            : `configured: searxng_search did not answer (timedOut=${timedOut}): ${result.slice(0, 200) || "no tool result"}`,
        });
      }
      state.mcpSearch = undefined;
    } finally {
      searxngStub.stop(true);
    }
    // The worker verdicts above are final: the review runs below reuse the
    // shared stub state, so snapshot them before they are reset.
    workerInstructionsSeen = state.instructionsSeen;

    // Review case: the head must not configure its reviewer. Fresh workdir
    // with a head marker, a head plugin, and a head skill; the base dir holds
    // a different marker and one base skill. The review spawn disables
    // project config and points skills/instructions at the base dir.
    const reviewChecks: { ok: boolean; line: string }[] = [];
    const reviewWorkdir = join(dir, "review-workspace");
    await Bun.$`mkdir -p ${reviewWorkdir}`.quiet();
    await Bun.$`git init -q`.cwd(reviewWorkdir).quiet();
    await writeFile(join(reviewWorkdir, "AGENTS.md"), `${INSTRUCTIONS_MARKER}\n`);
    const reviewPluginMarker = join(dir, "review-plugin-ran");
    await seedRepository(reviewWorkdir, reviewPluginMarker);
    const reviewRanMarker = join(dir, "review-skill-command-ran");
    await seedCheckoutSkill(reviewWorkdir, ".agents/skills", REVIEW_HEAD_SKILL, reviewRanMarker);
    const reviewOpencodeRanMarker = join(dir, "review-opencode-skill-command-ran");
    await seedCheckoutSkill(reviewWorkdir, ".opencode/skills", REVIEW_HEAD_OPENCODE_SKILL, reviewOpencodeRanMarker);
    const reviewBase = join(dir, "review-base");
    await mkdir(join(reviewBase, "skills", REVIEW_BASE_SKILL), { recursive: true });
    await writeFile(join(reviewBase, "AGENTS.md"), `${REVIEW_BASE_MARKER}\n`);
    await writeFile(
      join(reviewBase, "skills", REVIEW_BASE_SKILL, "SKILL.md"),
      `---\nname: ${REVIEW_BASE_SKILL}\ndescription: "base skill"\n---\n${SKILL_BODY_MARKER}\n`
    );
    state.instructionsSeen = false;
    state.baseSeen = false;
    state.skillId = REVIEW_HEAD_SKILL;
    state.toolResult = undefined;
    state.url = `${origin}/docs/upstream/readme`;
    state.reached = false;
    {
      const { timedOut } = await runReviewOpenCode(reviewWorkdir, configPath, reviewBase, join(dir, "xdg-config"));
      const headLoaded = !timedOut && (state.toolResult ?? "").includes(SKILL_BODY_MARKER);
      const headRan = await Bun.file(reviewRanMarker).exists();
      reviewChecks.push({
        ok: !headLoaded && !headRan,
        line: `review: head skill does not load and its hook does not run (loaded=${headLoaded}, ran=${headRan})`,
      });
    }
    state.skillId = REVIEW_BASE_SKILL;
    state.toolResult = undefined;
    {
      const { timedOut } = await runReviewOpenCode(reviewWorkdir, configPath, reviewBase, join(dir, "xdg-config"));
      const baseLoaded = !timedOut && (state.toolResult ?? "").includes(SKILL_BODY_MARKER);
      reviewChecks.push({
        ok: baseLoaded,
        line: `review: base skill loads (${baseLoaded ? "loaded" : "DID NOT LOAD"})`,
      });
    }
    state.skillId = REVIEW_HEAD_OPENCODE_SKILL;
    state.toolResult = undefined;
    {
      const { timedOut } = await runReviewOpenCode(reviewWorkdir, configPath, reviewBase, join(dir, "xdg-config"));
      const headLoaded = !timedOut && (state.toolResult ?? "").includes(SKILL_BODY_MARKER);
      const headRan = await Bun.file(reviewOpencodeRanMarker).exists();
      reviewChecks.push({
        ok: !headLoaded && !headRan,
        line: `review: head .opencode/skills skill does not load and its hook does not run (loaded=${headLoaded}, ran=${headRan})`,
      });
    }
    reviewChecks.push({
      ok: !state.instructionsSeen,
      line: `review: head AGENTS.md does not reach the model (${state.instructionsSeen ? "LEAKED" : "absent"})`,
    });
    reviewChecks.push({
      ok: state.baseSeen,
      line: `review: base AGENTS.md reaches the model (${state.baseSeen ? "seen" : "missing"})`,
    });
    reviewChecks.push({
      ok: !(await Bun.file(reviewPluginMarker).exists()),
      line: `review: head plugin does not load (${(await Bun.file(reviewPluginMarker).exists()) ? "RAN" : "did not run"})`,
    });
    // Review shell-sandbox plugin case: the production review plugin
    // registered in a scratch global config, driven against the installed
    // binary. The stub model runs `shell` (must come back wrapped: HOME is the
    // sandbox home), then `read` and `list` on the harness MCP token (both
    // must come back blocked, never the token). If the binary never loads the
    // plugin directory, rejects the plugin id, or drops either hook, `shell`
    // runs unwrapped and the reads succeed — failing the case instead of
    // failing open. The setup-ready marker proves setup ran to completion
    // (both hooks registered); the wrapped shell plus the blocked reads prove
    // both hooks fire at runtime.
    const pluginWorkdir = join(dir, "review-plugin-workspace");
    await Bun.$`mkdir -p ${pluginWorkdir}`.quiet();
    await Bun.$`git init -q`.cwd(pluginWorkdir).quiet();
    state.pluginCase = true;
    state.pluginResults = [];
    state.pluginTokenPath = undefined;
    state.pluginExpectedHome = undefined;
    state.pluginPending = undefined;
    state.pluginCompleted = [];
    state.pluginNextId = 0;
    try {
      const pluginRun = await runReviewPluginOpenCode(
        pluginWorkdir,
        configPath,
        join(dir, "review-plugin-xdg"),
        (tokenPath, expectedHome) => {
          state.pluginTokenPath = tokenPath;
          state.pluginExpectedHome = expectedHome;
        }
      );
      const pluginSteps = state.pluginResults ?? [];
      const completed = state.pluginCompleted ?? [];
      const resultsOf = (tool: string): string[] =>
        completed.filter((call) => call.name === tool).map((call) => call.result);
      const shellResults = resultsOf("shell");
      const shellAttempts = new Set(
        pluginSteps.filter((step) => step.startsWith("called:shell:")).map((step) => step.split(":")[2])
      ).size;
      const pluginRead = resultsOf("read")[0] ?? "";
      const pluginList = resultsOf("list")[0] ?? "";
      const pluginBlocked = "Blocked: review sandbox denies reads of agent credentials";
      reviewChecks.push({
        ok: pluginRun.pluginReady,
        line: `review: plugin setup registered both hooks (ready marker present)`,
      });
      reviewChecks.push({
        ok:
          !pluginRun.timedOut &&
          pluginRun.sandboxHome.endsWith(REVIEW_PLUGIN_SANDBOX_HOME_SUFFIX) &&
          shellResults.some((result) => result.includes(pluginRun.sandboxHome)),
        line: `review: plugin wraps shell through the shell sandbox (HOME comes back as the sandbox home, ${shellAttempts} attempt(s))`,
      });
      reviewChecks.push({
        ok: !pluginRun.timedOut && pluginRead.includes(pluginBlocked) && !pluginRead.includes(REVIEW_PLUGIN_TOKEN),
        line: `review: plugin denies read of the harness MCP token (no token in the tool result)`,
      });
      reviewChecks.push({
        ok: !pluginRun.timedOut && pluginList.includes(pluginBlocked) && !pluginList.includes(REVIEW_PLUGIN_TOKEN),
        line: `review: plugin denies list of the harness temp (no token in the tool result)`,
      });
      if (reviewChecks.some((check) => !check.ok)) {
        console.log(`plugin case steps (truncated):`);
        for (const step of pluginSteps) console.log(`  ${step.slice(0, 300)}`);
        console.log(`plugin run: timedOut=${pluginRun.timedOut} pluginReady=${pluginRun.pluginReady}`);
      }
    } finally {
      state.pluginCase = false;
      state.pluginTokenPath = undefined;
      state.pluginExpectedHome = undefined;
      state.pluginPending = undefined;
    }
    for (const { ok, line } of reviewChecks) console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
    if (reviewChecks.some((check) => !check.ok)) return 1;
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }

  for (const { probe, ok, observed } of results) {
    console.log(`${ok ? "ok  " : "FAIL"} expect=${probe.expect} ${probe.name} <${probe.url}> -> ${observed}`);
  }
  console.log(`${workerInstructionsSeen ? "ok  " : "FAIL"} the repository's AGENTS.md reaches the model`);
  console.log(`${pluginRan ? "ok  " : "FAIL"} the repository's plugin loads`);
  for (const { ok, line } of [...skillChecks, ...searchChecks, ...searxngChecks])
    console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  const failures = results.filter((r) => !r.ok).length;
  if (
    !workerInstructionsSeen ||
    !pluginRan ||
    [...skillChecks, ...searchChecks, ...searxngChecks].some((check) => !check.ok)
  )
    return 1;
  if (failures > 0) {
    console.error(
      `webfetch permission probe: ${failures}/${results.length} case(s) failed against the OpenCode binary`
    );
    return 1;
  }
  console.log(`webfetch permission probe: ${results.length}/${results.length} cases match the forge permission map`);
  return 0;
}

process.exit(await main());
