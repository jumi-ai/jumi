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
 * `opencode run` against it with `OPENCODE_PERMISSION` set to the exact string
 * production uses, then read back what OpenCode fed the model as the tool
 * result. The same server also serves the fetch targets, so an allowed URL is
 * observed as a real HTTP hit and a denied URL is observed as no hit at all.
 *
 * Exit 0 when every case matches its expectation, 1 otherwise.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FORGE_DENY_DOMAIN,
  forgeOpenCodeConfigContent,
  forgeOpenCodePermission,
  forgeWebfetchPermission,
} from "./forge_webfetch.ts";
import { getOpenCodeMajor } from "./git.ts";

/** Body served for every probe target; seeing it means webfetch actually ran. */
const FETCH_MARKER = "JUMI-WEBFETCH-PROBE-REACHED";
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

/**
 * What a blocked call must echo back. OpenCode serializes the whole webfetch
 * ruleset into the tool result — filtered by permission type, not by the rule
 * that matched — so there is nothing per-row to assert on. Seeing every deny
 * pattern proves the production map was the one in force, which is what
 * separates a real deny from an unrelated failure (network error, bad tool
 * name) that also produces no HTTP hit. Which entry did the denying is
 * established by the URL table below, not by the echo.
 *
 * Derived from the shipped map rather than OpenCode's English error text, so
 * an upgrade that rewords the message does not read as a dropped deny.
 */
const DENY_PATTERNS = Object.entries(forgeWebfetchPermission(FORGE_DENY_DOMAIN))
  .filter(([, action]) => action === "deny")
  .map(([pattern]) => pattern);

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
}

function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

/**
 * OpenAI-compatible `/v1/chat/completions` good enough for one tool-call turn:
 * first request returns the `webfetch` call, the next returns plain text so the
 * session ends. Also serves the probe targets themselves.
 */
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
      const body = (await req.json()) as { model?: string; messages?: { role?: string; content?: unknown }[] };
      const toolMessage = (body.messages ?? []).find((m) => m.role === "tool");
      if (toolMessage) state.toolResult = String(toolMessage.content ?? "");
      const base = { id: "chatcmpl-probe", created: Math.floor(Date.now() / 1000), model: body.model ?? MODEL_ID };
      const delta = toolMessage
        ? { role: "assistant", content: "probe complete" }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_probe",
                type: "function",
                function: { name: "webfetch", arguments: JSON.stringify({ url: state.url, format: "text" }) },
              },
            ],
          };
      const finish = toolMessage ? "stop" : "tool_calls";
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
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      provider: {
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "jumi webfetch probe",
          options: { baseURL: `${origin}/v1`, apiKey: "probe" },
          models: { [MODEL_ID]: { name: MODEL_ID, tool_call: true } },
        },
      },
      // webfetch stays scalar here on purpose: the map under test arrives via
      // OPENCODE_PERMISSION, exactly like production sets it at run time.
      permission: { webfetch: "allow", edit: "deny", write: "deny", task: "deny", question: "deny" },
    }),
    "utf8"
  );
  return path;
}

async function runOpenCode(
  workdir: string,
  configPath: string
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const major = getOpenCodeMajor();
  const args = ["opencode", "run"];
  if (major >= 2) args.push("--standalone");
  args.push("--model", `${PROVIDER_ID}/${MODEL_ID}`, "fetch the url");
  const proc = Bun.spawn(args, {
    cwd: workdir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      OPENCODE_CONFIG: configPath,
      OPENCODE_PERMISSION: forgeOpenCodePermission(FORGE_DENY_DOMAIN),
      // OpenCode 2 ignores OPENCODE_PERMISSION; the same deny arrives as
      // inline `permissions` config, exactly like production sets it.
      OPENCODE_CONFIG_CONTENT: forgeOpenCodeConfigContent(FORGE_DENY_DOMAIN),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    },
  });
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
  // OpenCode reports a blocked call by echoing the webfetch ruleset it was
  // holding (V1) or by returning "Permission denied: <action>" (V2).
  const missing = DENY_PATTERNS.filter((pattern) => !result.includes(pattern));
  const isV1Deny = missing.length === 0;
  const isV2Deny = getOpenCodeMajor() >= 2 && /Permission denied:\s*\w+/.test(result);
  const ok = (isV1Deny || isV2Deny) && !result.includes(FETCH_MARKER);
  return {
    probe,
    ok,
    observed: ok
      ? "denied, with the forge webfetch map in force"
      : `not denied under the forge map (ruleset missing ${missing.join(", ") || "nothing"}): ${result.slice(0, 200)}`,
  };
}

async function main(): Promise<number> {
  const state: RunState = { url: "", reached: false };
  const server = startProbeServer(state);
  const origin = `http://127.0.0.1:${server.port}`;
  const dir = await mkdtemp(join(tmpdir(), "jumi-webfetch-probe-"));
  const results: CaseResult[] = [];
  try {
    const workdir = join(dir, "workspace");
    await Bun.$`mkdir -p ${workdir}`.quiet();
    await Bun.$`git init -q`.cwd(workdir).quiet();
    const configPath = await writeProbeConfig(dir, origin);

    console.log(`Permission map under test: ${JSON.stringify(forgeWebfetchPermission(FORGE_DENY_DOMAIN))}`);
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
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }

  for (const { probe, ok, observed } of results) {
    console.log(`${ok ? "ok  " : "FAIL"} expect=${probe.expect} ${probe.name} <${probe.url}> -> ${observed}`);
  }
  const failures = results.filter((r) => !r.ok).length;
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
