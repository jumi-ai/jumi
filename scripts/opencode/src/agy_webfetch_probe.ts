#!/usr/bin/env bun
/**
 * Prove the forge read_url deny against the installed Antigravity binary.
 *
 * `agy` has no `--disallowedTools` flag. The policy surface is
 * `permissions.deny` in `~/.gemini/antigravity-cli/settings.json`, and
 * `--dangerously-skip-permissions` does not override a deny. This probe
 * installs that rule the way production does, points `agy -p` at a loopback
 * Gemini endpoint that emits one `read_url_content` call, and checks the
 * binary: an unrelated host is a real HTTP hit, the forge host is refused, and
 * the workspace is a repository trying to allow it back.
 *
 * Exit 0 when every case matches, 1 otherwise.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGY_SKIP_PERMISSIONS, ensureAgyForgeDeny } from "./agy.ts";
import { agyReadUrlDeny, FORGE_DENY_DOMAIN } from "./forge_webfetch.ts";

const FETCH_MARKER = "JUMI-WEBFETCH-PROBE-REACHED";
const DENY_MARK = "Matches user-configured deny rule";
const RUN_TIMEOUT_MS = 45_000;
const PRINT_TIMEOUT = "20s";

type Expectation = "allow" | "deny";

interface ProbeCase {
  readonly name: string;
  readonly url: string;
  readonly expect: Expectation;
  readonly host: string;
}

function probeCases(origin: string): readonly ProbeCase[] {
  return [
    {
      name: "unrelated host is fetchable",
      url: `${origin}/docs/upstream/readme`,
      expect: "allow",
      host: FORGE_DENY_DOMAIN,
    },
    {
      name: "forge host in the path is not a hostname deny",
      url: `${origin}/gitea.${FORGE_DENY_DOMAIN}/personal/jumi`,
      expect: "allow",
      host: FORGE_DENY_DOMAIN,
    },
    {
      name: "forge host",
      url: `https://gitea.${FORGE_DENY_DOMAIN}/personal/jumi/pulls/1`,
      expect: "deny",
      host: FORGE_DENY_DOMAIN,
    },
    {
      name: "forge API subdomain",
      url: `https://api.${FORGE_DENY_DOMAIN}/api/v1/repos/personal/jumi/issues`,
      expect: "deny",
      host: FORGE_DENY_DOMAIN,
    },
    {
      name: "github factory API subdomain",
      url: "https://api.github.com/repos/kirmanak/jumi/issues",
      expect: "deny",
      host: "github.com",
    },
  ];
}

interface RunState {
  url: string;
  hits: string[];
}

function startProbeServer(state: RunState) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST") {
        state.hits.push(url.pathname);
        return new Response(FETCH_MARKER, { headers: { "content-type": "text/plain" } });
      }
      const body = (await req.json()) as {
        contents?: { parts?: { functionResponse?: { name?: string } }[] }[];
        systemInstruction?: { parts?: { text?: string }[] };
      };
      const system = (body.systemInstruction?.parts ?? []).map((part) => part.text ?? "").join("\n");
      const responses = new Set<string>();
      for (const content of body.contents ?? []) {
        for (const part of content.parts ?? []) {
          const name = part.functionResponse?.name;
          if (name) responses.add(name);
        }
      }
      let parts: unknown[];
      if (system.includes("conversation title generator")) {
        parts = [{ text: "Probe Fetch" }];
      } else if (responses.has("read_url_content")) {
        parts = [{ text: "probe complete" }];
      } else {
        parts = [
          {
            functionCall: {
              name: "read_url_content",
              args: { Url: state.url, toolSummary: "fetch page", toolAction: "Fetching the page" },
            },
          },
        ];
      }
      const payload = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] };
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
}

async function writeSettings(home: string, host: string): Promise<void> {
  const dir = join(home, ".gemini", "antigravity-cli");
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "settings.json"),
    `${JSON.stringify(
      {
        enableTelemetry: false,
        useG1Credits: false,
        modelProvider: "gemini",
        permissions: { allow: [agyReadUrlDeny(host), "read_url(*)"] },
      },
      null,
      2
    )}\n`
  );
  await ensureAgyForgeDeny(home, host);
}

/** A repository trying to lift the deny, which lives under HOME and must hold anyway. */
async function seedRepository(workdir: string): Promise<void> {
  const settings = JSON.stringify({ permissions: { allow: ["read_url(*)"], deny: [] } });
  for (const root of [".agents", ".agent", "_agents", "_agent", ".gemini", ".gemini/antigravity-cli"]) {
    await mkdir(join(workdir, root), { recursive: true });
    await Bun.write(join(workdir, root, "settings.json"), settings);
  }
}

async function runAgy(
  workdir: string,
  home: string,
  origin: string,
  model: string
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const proc = Bun.spawn(
    [
      "agy",
      "-p",
      "fetch the url",
      "--output-format",
      "stream-json",
      AGY_SKIP_PERMISSIONS,
      "--print-timeout",
      PRINT_TIMEOUT,
      "--model",
      model,
    ],
    {
      cwd: workdir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: workdir,
        GEMINI_API_KEY: "probe",
        GOOGLE_GEMINI_BASE_URL: origin,
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
    return { code: await proc.exited, output: `${stdout}\n${stderr}`, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function probeModel(home: string, origin: string, workdir: string): Promise<string> {
  const proc = Bun.spawn(["agy", "models"], {
    cwd: workdir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: workdir,
      GEMINI_API_KEY: "probe",
      GOOGLE_GEMINI_BASE_URL: origin,
    },
  });
  const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    const slug = `${stdout}\n${stderr}`
      .split("\n")
      .map((line) => line.split("\t")[0]?.trim() ?? "")
      .find((line) => /^[a-z0-9][a-z0-9.-]*$/.test(line) && line.includes("-"));
    if (code !== 0 || !slug) {
      throw new Error(`agy models exited ${code}: ${`${stdout}${stderr}`.slice(-400)}`);
    }
    return slug;
  } finally {
    clearTimeout(timer);
  }
}

interface ToolOutcome {
  seen: boolean;
  error?: string;
  output?: string;
}

function toolOutcome(output: string): ToolOutcome {
  let seen = false;
  let error: string | undefined;
  let text: string | undefined;
  for (const line of output.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev: {
      step_update?: {
        step_type?: string;
        tool_name?: string;
        state?: string;
        tool_info?: { error?: { message?: string }; output?: unknown };
      };
    };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const step = ev.step_update;
    if (step?.step_type !== "tool" || step?.tool_name !== "read_url_content") continue;
    if (step.state !== "DONE" && step.state !== "ERROR") continue;
    seen = true;
    const info = step.tool_info ?? {};
    if (info.error?.message) error = info.error.message;
    if (info.output != null) text = String(info.output);
  }
  return { seen, error, output: text };
}

interface CaseResult {
  readonly probe: ProbeCase;
  readonly ok: boolean;
  readonly observed: string;
}

function judge(probe: ProbeCase, outcome: ToolOutcome, hits: readonly string[]): CaseResult {
  if (!outcome.seen) return { probe, ok: false, observed: "agy never finished a read_url_content call" };
  // A successful read_url_content does not echo the body in stream-json, so an
  // allow is a real HTTP hit and a deny is no hit plus the binary's deny error.
  const fetched = hits.length > 0;
  if (probe.expect === "allow") {
    const ok = fetched && !outcome.error;
    return {
      probe,
      ok,
      observed: ok
        ? "fetched"
        : `not fetched (hits=${hits.join(",") || "none"}): ${(outcome.error ?? outcome.output ?? "").slice(0, 200)}`,
    };
  }
  if (fetched) return { probe, ok: false, observed: "DENIED URL WAS FETCHED" };
  const ok = Boolean(outcome.error?.includes(DENY_MARK) && outcome.error.includes("Permission denied for read_url"));
  return {
    probe,
    ok,
    observed: ok
      ? "denied by the forge read_url rule"
      : `not denied: ${(outcome.error ?? outcome.output ?? "no tool error").slice(0, 240)}`,
  };
}

async function main(): Promise<number> {
  const state: RunState = { url: "", hits: [] };
  const server = startProbeServer(state);
  const origin = `http://127.0.0.1:${server.port}`;
  const dir = await mkdtemp(join(tmpdir(), "jumi-agy-webfetch-probe-"));
  const results: CaseResult[] = [];
  try {
    const workdir = join(dir, "workspace");
    await mkdir(workdir, { recursive: true });
    await Bun.$`git init -q`.cwd(workdir).quiet();
    await seedRepository(workdir);
    const homes = new Map<string, string>();
    for (const host of [FORGE_DENY_DOMAIN, "github.com"]) {
      const home = join(dir, `home-${host.replaceAll(".", "-")}`);
      await mkdir(home, { recursive: true });
      await writeSettings(home, host);
      homes.set(host, home);
    }
    const model = await probeModel(homes.get(FORGE_DENY_DOMAIN) ?? "", origin, workdir);
    console.log(
      `agy model ${model}; deny under test ${agyReadUrlDeny(FORGE_DENY_DOMAIN)} and ${agyReadUrlDeny("github.com")}`
    );
    for (const probe of probeCases(origin)) {
      state.url = probe.url;
      state.hits = [];
      const home = homes.get(probe.host);
      if (!home) {
        results.push({ probe, ok: false, observed: `no settings home for ${probe.host}` });
        continue;
      }
      const { output, timedOut } = await runAgy(workdir, home, origin, model);
      if (timedOut) {
        results.push({ probe, ok: false, observed: `agy hung, killed after ${RUN_TIMEOUT_MS}ms` });
        continue;
      }
      const outcome = toolOutcome(output);
      if (!outcome.seen) {
        results.push({ probe, ok: false, observed: `no read_url_content result: ${output.slice(-400)}` });
        continue;
      }
      results.push(judge(probe, outcome, state.hits));
    }
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }

  for (const { probe, ok, observed } of results) {
    console.log(`${ok ? "ok  " : "FAIL"} expect=${probe.expect} ${probe.name} <${probe.url}> -> ${observed}`);
  }
  const failures = results.filter((row) => !row.ok).length;
  if (failures > 0) {
    console.error(`agy webfetch probe: ${failures}/${results.length} case(s) failed against the agy binary`);
    return 1;
  }
  console.log(
    `agy webfetch probe: ${results.length}/${results.length} cases refused the forge host and allowed the rest`
  );
  return 0;
}

process.exit(await main());
