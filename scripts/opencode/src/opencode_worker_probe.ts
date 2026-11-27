#!/usr/bin/env bun
/**
 * Prove the OpenCode worker sees and can call the `jumi-worker` tools through
 * the real installed binary (jumi#965, tier 0).
 *
 * A unit test that imports `worker_mcp.ts` grades itself: an OpenCode upgrade
 * that changes the MCP config shape, renames a tool, or drops the worker entry
 * would keep the unit tests green while the worker silently loses its result
 * path (and the parent falls back to `JUMI_PR.md`). So this probe drives the
 * real `opencode` binary instead.
 *
 * How: stand up the real parent `startWorkerMcpServer`, stand up a throwaway
 * OpenAI-compatible provider on loopback that always answers with a single
 * `jumi-worker_set_pr_body` tool call, run `opencode run` against it with the
 * exact config production builds for a worker run (`OPENCODE_CONFIG` pointing
 * at the shipped implement config, `OPENCODE_CONFIG_CONTENT` from
 * `applyOpenCodeInlineConfig`, and the global config from
 * `forgeOpenCodeGlobalConfig` plus the production `openCodeWorkerMcpEntry`),
 * then read back what the store received.
 *
 * It proves, at the model boundary:
 *   1. Advertised: every tool the server lists via `tools/list` appears in a
 *      model request as a native `jumi-worker_<tool>` function with the same
 *      input schema production registers. Compared against the server's own
 *      list, not a hand-copied list. `set_pr_title` must be absent on a
 *      non-adopted job.
 *   2. Accepted: a valid `set_pr_body` (markdown plus a `remaining` list with
 *      a plain string and a typed {text, kind} item) reaches the parent
 *      `WorkerResultStore` through the real OpenCode-to-MCP path, and
 *      `preferWorkerTool` takes the tool path.
 *   3. Rejected: an invalid call (`remaining` with an unknown kind or a
 *      non-string/non-object item) comes back to the model as a tool error
 *      and stores nothing.
 *
 * Worker role only. No network beyond loopback, no credentials, no model cost.
 *
 * Exit 0 when every case matches, 1 otherwise.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgeOpenCodeGlobalConfig } from "./forge_webfetch.ts";
import { applyOpenCodeInlineConfig } from "./git.ts";
import {
  openCodeWorkerMcpEntry,
  preferWorkerTool,
  startWorkerMcpServer,
  WORKER_MCP_SERVER_NAME,
  WorkerResultStore,
} from "./worker_mcp.ts";

const PROVIDER_ID = "jumi-worker-probe";
const MODEL_ID = "probe-model";
/** Example homelab host for manual probing only; production derives the deny host from config. */
const PROBE_DENY_DOMAIN = "kirmanak.stream";
/**
 * Cap a single `opencode run`. The provider is loopback, so a healthy run is
 * seconds; this is only a hang guard. Kept low enough that the whole probe
 * stays well under the `timeout 600` the image verification steps wrap the
 * probe in.
 */
const RUN_TIMEOUT_MS = 60_000;

const PROBE_MARKDOWN = "Jumi worker probe body.\n\nRefs #965";
const PROBE_REMAINING = ["probe-remaining-item", { text: "probe typed work", kind: "work" }];

function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

interface CapturedRequest {
  tools?: Array<{ type?: string; function?: { name?: string; parameters?: unknown } }>;
  messages?: Array<{ role?: string; content?: unknown }>;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function directToolName(tool: string): string {
  return `${sanitize(WORKER_MCP_SERVER_NAME)}_${sanitize(tool)}`;
}

function startProbeServer(state: {
  bodies: CapturedRequest[];
  toolResult?: string;
  args: Record<string, unknown>;
  toolName: string;
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (!pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as CapturedRequest;
      state.bodies.push(body);
      const toolMessages = (body.messages ?? []).filter((m) => m.role === "tool");
      const toolMessage = toolMessages[toolMessages.length - 1];
      if (toolMessage) state.toolResult = String(toolMessage.content ?? "");
      const base = { id: "chatcmpl-probe", created: Math.floor(Date.now() / 1000), model: MODEL_ID };
      const delta =
        toolMessage !== undefined
          ? { role: "assistant", content: "probe complete" }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_probe",
                  type: "function",
                  function: { name: state.toolName, arguments: JSON.stringify(state.args) },
                },
              ],
            };
      const finish = toolMessage === undefined ? "tool_calls" : "stop";
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

async function writeProbeConfig(dir: string, origin: string): Promise<string> {
  const path = join(dir, "opencode-probe.json");
  await writeFile(
    path,
    JSON.stringify({
      share: "disabled",
      update: "disable",
      snapshots: false,
      providers: {
        [PROVIDER_ID]: {
          name: "jumi worker probe",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: `${origin}/v1`, apiKey: "probe" },
          models: { [MODEL_ID]: { name: MODEL_ID, capabilities: { tools: true } } },
        },
      },
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
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
  xdgConfigHome: string,
  inlineContent: string
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const proc = Bun.spawn(
    ["opencode", "run", "--standalone", "--model", `${PROVIDER_ID}/${MODEL_ID}`, "run the worker probe"],
    {
      cwd: workdir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PWD: workdir,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_CONTENT: inlineContent,
        XDG_CONFIG_HOME: xdgConfigHome,
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

function nativeWorkerTools(bodies: CapturedRequest[]): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (const body of bodies) {
    for (const tool of body.tools ?? []) {
      const name = tool.function?.name ?? "";
      if (name.startsWith(`${sanitize(WORKER_MCP_SERVER_NAME)}_`)) {
        found.set(name, tool.function?.parameters);
      }
    }
  }
  return found;
}

function requiredOf(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === "string").sort() : [];
}

function propertiesOf(schema: unknown): Record<string, { type?: unknown; items?: unknown }> {
  if (typeof schema !== "object" || schema === null) return {};
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return {};
  return properties as Record<string, { type?: unknown; items?: unknown }>;
}

async function main(): Promise<number> {
  const results: { ok: boolean; line: string }[] = [];
  const push = (ok: boolean, line: string) => results.push({ ok, line });
  const dir = await mkdtemp(join(tmpdir(), "jumi-opencode-worker-probe-"));
  const workerServer = await startWorkerMcpServer({ store: new WorkerResultStore() });
  try {
    // Authoritative tool list straight from the production server: adding a
    // tool never needs a probe edit.
    const listRes = await fetch(workerServer.url, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${workerServer.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const listPayload = (await listRes.json()) as {
      result?: { tools?: Array<{ name?: string; inputSchema?: unknown }> };
    };
    const expected = new Map<string, unknown>();
    for (const tool of listPayload.result?.tools ?? []) {
      if (typeof tool.name === "string") expected.set(tool.name, tool.inputSchema);
    }
    if (expected.size === 0) {
      push(false, "the worker MCP server lists no tools");
      return 1;
    }

    const workdir = join(dir, "workspace");
    await Bun.$`mkdir -p ${workdir}`.quiet();
    await Bun.$`git init -q`.cwd(workdir).quiet();
    const probeServerState = {
      bodies: [] as CapturedRequest[],
      toolResult: undefined as string | undefined,
      args: {} as Record<string, unknown>,
      toolName: "",
    };
    const modelServer = startProbeServer(probeServerState);
    try {
      const origin = `http://127.0.0.1:${modelServer.port}`;
      const configPath = await writeProbeConfig(dir, origin);
      const xdgConfigHome = join(dir, "xdg-config");
      await mkdir(join(xdgConfigHome, "opencode"), { recursive: true });
      const globalBase = JSON.parse(forgeOpenCodeGlobalConfig(PROBE_DENY_DOMAIN)) as Record<string, unknown>;
      // Exact production MCP wiring: the same helper the spawn uses.
      globalBase.mcp = { [WORKER_MCP_SERVER_NAME]: openCodeWorkerMcpEntry(workerServer.url, workerServer.token) };
      await writeFile(join(xdgConfigHome, "opencode", "opencode.json"), JSON.stringify(globalBase));
      // Exact production inline config, merged the way the spawn merges it.
      const inlineEnv: Record<string, string> = {};
      applyOpenCodeInlineConfig(inlineEnv, { model: "probe", workdir });
      const inlineContent = inlineEnv.OPENCODE_CONFIG_CONTENT ?? "";

      // --- Accepted run: valid set_pr_body through the real binary ---
      const validStore = new WorkerResultStore();
      workerServer.setStore(validStore);
      probeServerState.bodies = [];
      probeServerState.toolResult = undefined;
      probeServerState.toolName = directToolName("set_pr_body");
      probeServerState.args = { markdown: PROBE_MARKDOWN, remaining: PROBE_REMAINING };
      const valid = await runOpenCode(workdir, configPath, xdgConfigHome, inlineContent);

      // --- Advertised: every server tool is a native model tool with its schema ---
      const native = nativeWorkerTools(probeServerState.bodies);
      const missing = [...expected.keys()].filter((name) => !native.has(directToolName(name)));
      const extra = [...native.keys()].filter(
        (name) => ![...expected.keys()].some((tool) => directToolName(tool) === name)
      );
      push(
        probeServerState.bodies.length > 0,
        `the model request reaches the loopback provider (${probeServerState.bodies.length} request(s))`
      );
      push(
        missing.length === 0 && extra.length === 0,
        missing.length === 0 && extra.length === 0
          ? `advertised: all ${expected.size} worker tools are native model tools`
          : `advertised: missing=[${missing.join(",") || "<none>"}] extra=[${extra.join(",") || "<none>"}]`
      );
      push(
        !native.has(directToolName("set_pr_title")),
        "set_pr_title is absent on a non-adopted job (only offered when eligible)"
      );
      let schemasOk = missing.length === 0;
      const schemaMismatches: string[] = [];
      for (const [name, schema] of expected) {
        const parameters = native.get(directToolName(name));
        if (parameters === undefined) continue;
        const wantProps = Object.keys(propertiesOf(schema)).sort();
        const gotProps = Object.keys(propertiesOf(parameters)).sort();
        const wantRequired = requiredOf(schema);
        const gotRequired = requiredOf(parameters);
        if (
          JSON.stringify(wantProps) !== JSON.stringify(gotProps) ||
          JSON.stringify(wantRequired) !== JSON.stringify(gotRequired)
        ) {
          schemasOk = false;
          schemaMismatches.push(name);
        }
      }
      push(
        schemasOk,
        schemasOk
          ? "advertised: every worker tool carries the input schema production registers"
          : `advertised: schema mismatch for [${schemaMismatches.join(",")}]`
      );

      // --- Accepted: the value lands in the parent store via the tool path ---
      const acceptedResult = probeServerState.toolResult ?? "";
      const acceptedOk =
        !valid.timedOut &&
        acceptedResult.includes("recorded") &&
        validStore.getPrBody() === PROBE_MARKDOWN &&
        JSON.stringify(validStore.getPrRemaining()) === JSON.stringify(PROBE_REMAINING);
      push(
        acceptedOk,
        acceptedOk
          ? "accepted: valid set_pr_body reaches the parent result store through the binary"
          : `accepted: valid set_pr_body did not land (timedOut=${valid.timedOut} result=${acceptedResult.slice(0, 200) || "<none>"})`
      );
      const toolLogs: string[] = [];
      const preferred = preferWorkerTool("pr_body", validStore.getPrBody(), null, (m) => toolLogs.push(m));
      push(
        preferred.source === "tool" && toolLogs.some((m) => m.includes("from tool")),
        preferred.source === "tool"
          ? "accepted: the parent takes the worker result from the tool, not the file fallback"
          : `accepted: parent took ${preferred.source} instead of the tool`
      );

      // --- Rejected: invalid remaining is a tool error and stores nothing ---
      const invalidStore = new WorkerResultStore();
      workerServer.setStore(invalidStore);
      probeServerState.bodies = [];
      probeServerState.toolResult = undefined;
      probeServerState.toolName = directToolName("set_pr_body");
      probeServerState.args = { markdown: PROBE_MARKDOWN, remaining: [{ text: "x", kind: "nope" }] };
      const invalid = await runOpenCode(workdir, configPath, xdgConfigHome, inlineContent);
      const rejectedResult = probeServerState.toolResult ?? "";
      const rejectedOk =
        !invalid.timedOut &&
        rejectedResult.toLowerCase().includes("remaining") &&
        !invalidStore.hasPrBody() &&
        invalidStore.getPrBody() === undefined;
      push(
        rejectedOk,
        rejectedOk
          ? "rejected: invalid remaining comes back as a tool error and stores nothing"
          : `rejected: invalid call was not a visible tool error (timedOut=${invalid.timedOut} result=${rejectedResult.slice(0, 200) || "<none>"} stored=${invalidStore.hasPrBody()})`
      );
      if (!valid.timedOut && valid.code !== 0 && probeServerState.toolResult === undefined) {
        push(false, `opencode run exited ${valid.code}: ${valid.output.slice(-400)}`);
      }
      if (!invalid.timedOut && invalid.code !== 0 && rejectedResult === "") {
        push(false, `opencode run exited ${invalid.code}: ${invalid.output.slice(-400)}`);
      }
    } finally {
      modelServer.stop(true);
    }
  } finally {
    workerServer.close();
    await rm(dir, { recursive: true, force: true });
  }
  for (const { ok, line } of results) console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  const failures = results.filter((r) => !r.ok).length;
  if (failures > 0) {
    console.error(`opencode worker probe: ${failures}/${results.length} check(s) failed against the installed binary`);
    return 1;
  }
  console.log(`opencode worker probe: ${results.length}/${results.length} checks pass against the installed binary`);
  return 0;
}

if (import.meta.main) process.exit(await main());
