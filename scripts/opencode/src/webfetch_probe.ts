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
 * Exit 0 when every case matches its expectation, 1 otherwise.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FORGE_DENY_DOMAIN,
  forgeOpenCodeConfigContent,
  forgeOpenCodeGlobalConfig,
  forgePermissions,
  isPermissionDenyText,
} from "./forge_webfetch.ts";

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
  /** Skill the stub's model loads instead of calling `webfetch`, when set. */
  skillId?: string;
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
      if (JSON.stringify(body.messages ?? []).includes(INSTRUCTIONS_MARKER)) state.instructionsSeen = true;
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
                function: state.skillId
                  ? { name: "skill", arguments: JSON.stringify({ id: state.skillId }) }
                  : { name: "webfetch", arguments: JSON.stringify({ url: state.url, format: "text" }) },
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

async function writeProbeConfig(dir: string, origin: string): Promise<string> {
  const path = join(dir, "opencode-probe.json");
  await writeFile(
    path,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      update: "disable",
      snapshots: false,
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
  configPath: string
): Promise<{ code: number; output: string; timedOut: boolean }> {
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
        OPENCODE_CONFIG_CONTENT: forgeOpenCodeConfigContent(FORGE_DENY_DOMAIN),
        XDG_CONFIG_HOME: join(workdir, "..", "xdg-config"),
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

async function main(): Promise<number> {
  const state: RunState = { url: "", reached: false, instructionsSeen: false };
  const server = startProbeServer(state);
  const origin = `http://127.0.0.1:${server.port}`;
  const dir = await mkdtemp(join(tmpdir(), "jumi-webfetch-probe-"));
  const results: CaseResult[] = [];
  const skillChecks: { ok: boolean; line: string }[] = [];
  let pluginRan = false;
  try {
    const workdir = join(dir, "workspace");
    await Bun.$`mkdir -p ${workdir}`.quiet();
    await Bun.$`git init -q`.cwd(workdir).quiet();
    await writeFile(join(workdir, "AGENTS.md"), `${INSTRUCTIONS_MARKER}\n`);
    const pluginMarker = join(dir, "repo-plugin-ran");
    await seedRepository(workdir, pluginMarker);
    await mkdir(join(dir, "xdg-config", "opencode"), { recursive: true });
    await writeFile(join(dir, "xdg-config", "opencode", "opencode.json"), forgeOpenCodeGlobalConfig(FORGE_DENY_DOMAIN));
    const configPath = await writeProbeConfig(dir, origin);

    console.log(`Permission rules under test: ${JSON.stringify(forgePermissions(FORGE_DENY_DOMAIN))}`);
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
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }

  for (const { probe, ok, observed } of results) {
    console.log(`${ok ? "ok  " : "FAIL"} expect=${probe.expect} ${probe.name} <${probe.url}> -> ${observed}`);
  }
  console.log(`${state.instructionsSeen ? "ok  " : "FAIL"} the repository's AGENTS.md reaches the model`);
  console.log(`${pluginRan ? "ok  " : "FAIL"} the repository's plugin loads`);
  for (const { ok, line } of skillChecks) console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  const failures = results.filter((r) => !r.ok).length;
  if (!state.instructionsSeen || !pluginRan || skillChecks.some((check) => !check.ok)) return 1;
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
