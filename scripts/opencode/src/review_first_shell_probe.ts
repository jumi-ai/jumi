#!/usr/bin/env bun
/**
 * First-call trace for the OpenCode review shell plugin, against the
 * *installed OpenCode binary* and loopback stubs only.
 *
 * What it records: per scenario, a reproducible ordered trace of plugin setup,
 * the first model request, and the first shell call, plus a verdict. The
 * plugin under test only rewrites `HOME` through
 * `ctx.shell.hook("create.before")` (no Landlock, no wrapper), so the trace
 * reruns offline anywhere the installed binary runs: a wrapped first shell
 * result proves the hook was registered before dispatch, an unwrapped one
 * proves the model shell ran without it.
 *
 * Scenarios (each runs `--runs`, default 3):
 * - `delayed-setup`: setup sleeps 4 s before registering the shell hook.
 * - `throw-after-one-hook`: setup registers one tool hook, then throws before
 *   the shell hook is registered.
 * - `missing-dir`: the config `plugins` key points at a directory that does
 *   not exist on disk.
 * - `invalid-file`: the plugin directory holds a syntactically invalid
 *   `index.js`.
 * - `healthy`: setup registers the shell hook immediately (control).
 *
 * Registration is only through the config `plugins` key pointing outside the
 * auto-discovered plugin directories (never `workdir/.opencode/plugins`, never
 * under `XDG_CONFIG_HOME`), so a missing or broken plugin cannot be rescued
 * by discovery. Loopback stubs only, scratch HOME/XDG, no provider or forge
 * credentials, no real auth directory. Tool dispatch is detected with a
 * harmless `touch` file the stubbed shell command creates.
 *
 * Verdicts (`classifyFirstShellRuns`, unit-tested in
 * `test/review_first_shell_probe.test.ts`):
 * - SAFE only if every run produces a first shell result and it is wrapped.
 *   An observed unwrapped result wins over a missing one (fail-open is
 *   proven), otherwise any missing result or undispatchable run is UNKNOWN.
 * - UNSAFE if any shell result is unwrapped (fail-open in that fixture).
 * - UNKNOWN if any required result is missing or the harness cannot judge a
 *   run (including an empty trace).
 *
 * SAFE is scoped to that scenario and that binary build, not a universal
 * containment guarantee. Exit 0 whenever every requested scenario produced a
 * verdict, even when a verdict is UNSAFE or UNKNOWN; exit non-zero only on a
 * harness failure (the stub or the spawn itself broke). Not run in CI: this is
 * an on-demand diagnostic (`bun src/review_first_shell_probe.ts` from
 * `scripts/opencode`).
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type FirstShellVerdict = "SAFE" | "UNSAFE" | "UNKNOWN";

export interface FirstShellRunObservation {
  /** HOME the plugin rewrite points shells at; a result containing it is wrapped. */
  readonly sandboxHome: string;
  /** Text of the first shell tool result, if the model run returned one. */
  readonly shellResult?: string;
  /** Whether the stubbed shell command ran (harmless touch-file exists). */
  readonly dispatched: boolean;
}

export interface FirstShellClassification {
  readonly verdict: FirstShellVerdict;
  readonly reason: string;
}

/** A first shell result is wrapped when it carries the plugin-assigned HOME. */
export function isWrappedShellResult(result: string, sandboxHome: string): boolean {
  if (sandboxHome.length === 0) return false;
  return result.includes(sandboxHome);
}

/**
 * Pure verdict over one scenario's runs. An observed unwrapped result is
 * UNSAFE even when another run is missing (the fail-open is already proven);
 * otherwise any missing result, undispatchable run, or empty trace is
 * UNKNOWN; SAFE needs every run present and wrapped.
 */
export function classifyFirstShellRuns(runs: readonly FirstShellRunObservation[]): FirstShellClassification {
  if (runs.length === 0) return { verdict: "UNKNOWN", reason: "empty trace: no runs recorded" };
  const unwrapped = runs.filter(
    (run) => run.shellResult !== undefined && !isWrappedShellResult(run.shellResult, run.sandboxHome)
  );
  if (unwrapped.length > 0) {
    return {
      verdict: "UNSAFE",
      reason: `${unwrapped.length}/${runs.length} run(s) produced an unwrapped first shell result`,
    };
  }
  const missing = runs.filter(
    (run) => run.shellResult === undefined || !run.dispatched || run.sandboxHome.length === 0
  );
  if (missing.length > 0) {
    return {
      verdict: "UNKNOWN",
      reason: `${missing.length}/${runs.length} run(s) have a missing shell result or cannot be judged`,
    };
  }
  return { verdict: "SAFE", reason: `all ${runs.length}/${runs.length} runs produced a wrapped first shell result` };
}

const PROVIDER_ID = "jumi-first-shell-probe";
const MODEL_ID = "probe-model";
/** Per-run hang guard; a loopback run is seconds when healthy. */
const RUN_TIMEOUT_MS = 60_000;
/** Setup sleep for the delayed scenario, matching the observed 4-5 s window. */
const SETUP_DELAY_MS = 4_000;
const DEFAULT_RUNS = 3;

const SCENARIOS = ["delayed-setup", "throw-after-one-hook", "missing-dir", "invalid-file", "healthy"] as const;
type Scenario = (typeof SCENARIOS)[number];

function isScenario(value: string): value is Scenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

interface ScenarioFiles {
  pluginDir: string;
  startedMarker: string;
  readyMarker: string;
  dispatchMarker: string;
  sandboxHome: string;
}

function pluginSource(kind: Scenario, files: ScenarioFiles): string | undefined {
  const started = JSON.stringify(files.startedMarker);
  const ready = JSON.stringify(files.readyMarker);
  const home = JSON.stringify(files.sandboxHome);
  if (kind === "missing-dir") return undefined;
  if (kind === "invalid-file") return "this is not valid javascript {{{ probe\n";
  if (kind === "throw-after-one-hook") {
    return `export default {
  id: "jumi-first-shell-probe",
  async setup(ctx) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(${started}, String(Date.now()));
    await ctx.tool.hook("execute.before", () => {});
    throw new Error("jumi first-shell probe: setup failure after one hook");
  },
};
`;
  }
  const delay =
    kind === "delayed-setup" ? `await new Promise((resolve) => setTimeout(resolve, ${SETUP_DELAY_MS}));\n    ` : "";
  return `export default {
  id: "jumi-first-shell-probe",
  async setup(ctx) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(${started}, String(Date.now()));
    ${delay}await ctx.shell.hook("create.before", (event) => {
      event.env.HOME = ${home};
    });
    writeFileSync(${ready}, String(Date.now()));
  },
};
`;
}

interface StubState {
  firstRequestAt?: number;
  shellResult?: string;
  resultAt?: number;
  pendingId?: string;
  nextId: number;
}

function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

function startStubServer(state: StubState, dispatchMarker: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (!pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const body = (await req.json()) as {
        model?: string;
        messages?: { role?: string; content?: unknown; tool_call_id?: string }[];
      };
      if (state.firstRequestAt === undefined) state.firstRequestAt = Date.now();
      const toolMessages = (body.messages ?? []).filter((m) => m.role === "tool");
      if (toolMessages.length > 0) {
        state.shellResult = String(toolMessages[toolMessages.length - 1]?.content ?? "");
        state.resultAt = Date.now();
        state.pendingId = undefined;
      }
      const base = { id: "chatcmpl-first-shell", created: Math.floor(Date.now() / 1000), model: body.model };
      let delta: unknown;
      let finish: string;
      if (state.shellResult !== undefined) {
        delta = { role: "assistant", content: "probe complete" };
        finish = "stop";
      } else {
        if (state.pendingId === undefined) {
          state.nextId += 1;
          state.pendingId = `call-shell-${state.nextId}`;
        }
        delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: state.pendingId,
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({ command: `touch ${dispatchMarker}; printenv HOME` }),
              },
            },
          ],
        };
        finish = "tool_calls";
      }
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

interface TraceEvent {
  at: number | undefined;
  text: string;
}

async function readMarkerTime(path: string): Promise<number | undefined> {
  try {
    const raw = await Bun.file(path).text();
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

interface ScenarioRun {
  observation: FirstShellRunObservation;
  trace: string[];
  timedOut: boolean;
}

async function runOnce(scenario: Scenario, configPath: string, root: string): Promise<ScenarioRun> {
  const t0 = Date.now();
  const workdir = join(root, "workspace");
  const home = join(root, "home");
  const xdgConfig = join(root, "xdg-config");
  const files: ScenarioFiles = {
    pluginDir: join(root, "plugin", "jumi-first-shell"),
    startedMarker: join(root, "setup-started"),
    readyMarker: join(root, "setup-ready"),
    dispatchMarker: join(root, "shell-dispatched"),
    sandboxHome: join(root, "sandbox-home"),
  };
  await mkdir(workdir, { recursive: true });
  await Bun.$`git init -q`.cwd(workdir).quiet();
  await mkdir(home, { recursive: true });
  await mkdir(join(root, "tmp"), { recursive: true });
  await mkdir(files.sandboxHome, { recursive: true });
  await mkdir(join(xdgConfig, "opencode"), { recursive: true });
  const source = pluginSource(scenario, files);
  if (source !== undefined) {
    await mkdir(files.pluginDir, { recursive: true });
    await writeFile(join(files.pluginDir, "index.js"), source);
  }
  await writeFile(join(xdgConfig, "opencode", "opencode.json"), JSON.stringify({ plugins: [files.pluginDir] }));

  const stub: StubState = { nextId: 0 };
  const server = startStubServer(stub, files.dispatchMarker);
  const serverOrigin = `http://127.0.0.1:${server.port}`;
  await writeFile(
    configPath,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      update: "disable",
      snapshots: false,
      providers: {
        [PROVIDER_ID]: {
          name: "jumi first-shell probe",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: `${serverOrigin}/v1`, apiKey: "probe" },
          models: { [MODEL_ID]: { name: MODEL_ID, capabilities: { tools: true } } },
        },
      },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
  );
  const proc = Bun.spawn(
    ["opencode", "run", "--standalone", "--model", `${PROVIDER_ID}/${MODEL_ID}`, "run the shell"],
    {
      cwd: workdir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        TMPDIR: join(root, "tmp"),
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: join(root, "xdg-data"),
        PWD: workdir,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    }
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, RUN_TIMEOUT_MS);
  let exitCode: number | null = null;
  try {
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
  const exitAt = Date.now();
  const dispatched = await Bun.file(files.dispatchMarker).exists();
  let dispatchedAt: number | undefined;
  if (dispatched) {
    try {
      dispatchedAt = (await stat(files.dispatchMarker)).mtimeMs;
    } catch {
      dispatchedAt = undefined;
    }
  }
  const startedAt = await readMarkerTime(files.startedMarker);
  const readyAt = await readMarkerTime(files.readyMarker);
  const result = stub.shellResult;
  let wrapped = "missing";
  if (result !== undefined) wrapped = isWrappedShellResult(result, files.sandboxHome) ? "wrapped" : "unwrapped";
  const events: TraceEvent[] = [
    { at: t0, text: "spawn" },
    { at: startedAt, text: startedAt === undefined ? "setup-started (absent)" : "setup-started" },
    { at: readyAt, text: readyAt === undefined ? "setup-finished (absent: hook never registered)" : "setup-finished" },
    {
      at: stub.firstRequestAt,
      text: stub.firstRequestAt === undefined ? "first model request (absent)" : "first model request",
    },
    {
      at: dispatchedAt,
      text: dispatched ? "shell dispatched (touch-file present)" : "shell dispatched (absent: touch-file missing)",
    },
    {
      at: stub.resultAt,
      text:
        result === undefined
          ? "first shell result (absent)"
          : `first shell result: ${wrapped} (${result.trim().slice(0, 120) || "<empty>"})`,
    },
    { at: exitAt, text: `run exit (code=${exitCode ?? "killed"}, timedOut=${timedOut})` },
  ];
  events.sort((a, b) => (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY));
  const trace = events.map((event) =>
    event.at === undefined ? `-- ${event.text}` : `+${event.at - t0}ms ${event.text}`
  );
  return { observation: { sandboxHome: files.sandboxHome, shellResult: result, dispatched }, trace, timedOut };
}

function installedVersion(): string {
  try {
    const proc = Bun.spawnSync(["opencode", "--version"], { stdout: "pipe", stderr: "ignore" });
    const text = String(proc.stdout ?? "").trim();
    return text || "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const onlyArg = args.find((arg) => arg.startsWith("--scenario="))?.slice("--scenario=".length) ?? "";
  const only: Scenario | undefined = onlyArg !== "" && isScenario(onlyArg) ? onlyArg : undefined;
  if (onlyArg !== "" && only === undefined) {
    console.error(`unknown scenario ${JSON.stringify(onlyArg)}; want one of ${SCENARIOS.join(", ")}`);
    return 1;
  }
  const runsArg = args.find((arg) => arg.startsWith("--runs="))?.slice("--runs=".length) ?? "";
  const runsEnv = process.env.JUMI_FIRST_SHELL_RUNS ?? "";
  const runs = Number.parseInt(runsArg || runsEnv || "", 10);
  const runsPerScenario = Number.isNaN(runs) || runs <= 0 ? DEFAULT_RUNS : Math.min(runs, 10);
  const wanted: readonly Scenario[] = only !== undefined ? [only] : SCENARIOS;
  const version = installedVersion();

  console.log(`first-shell probe against ${version} (hash unverified: no checksum pin, version only)`);
  console.log(
    `loopback stubs only, scratch HOME/XDG, no provider or forge credentials (${runsPerScenario} run(s) each)`
  );
  const verdicts: { scenario: Scenario; verdict: FirstShellVerdict; reason: string }[] = [];
  // Fixed /tmp parent, never os.tmpdir(): the harness TMPDIR points inside the
  // checkout, and os.tmpdir() would follow it there.
  const dir = await mkdtemp("/tmp/jumi-first-shell-");
  try {
    for (const scenario of wanted) {
      console.log(`=== scenario: ${scenario} ===`);
      const observations: FirstShellRunObservation[] = [];
      for (let i = 0; i < runsPerScenario; i += 1) {
        const root = join(dir, scenario, `run-${i + 1}`);
        const configPath = join(root, "opencode-probe.json");
        const run = await runOnce(scenario, configPath, root);
        console.log(`run ${i + 1} trace:`);
        for (const line of run.trace) console.log(`  ${line}`);
        const first = run.observation.shellResult;
        let word = "MISSING";
        if (first !== undefined)
          word = isWrappedShellResult(first, run.observation.sandboxHome) ? "WRAPPED" : "UNWRAPPED";
        console.log(`run ${i + 1}: ${word}`);
        observations.push(run.observation);
      }
      const judged = classifyFirstShellRuns(observations);
      console.log(`scenario verdict: ${judged.verdict} (${judged.reason})`);
      verdicts.push({ scenario, verdict: judged.verdict, reason: judged.reason });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("verdicts:");
  for (const { scenario, verdict, reason } of verdicts) console.log(`- ${scenario}: ${verdict} (${reason})`);
  console.log("SAFE is scoped to that scenario and binary build, not a universal containment guarantee.");
  return 0;
}

if (import.meta.main) process.exit(await main());
