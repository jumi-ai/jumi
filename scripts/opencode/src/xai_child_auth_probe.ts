#!/usr/bin/env bun
/**
 * Prove the child xAI credential against the *installed OpenCode binary*.
 *
 * Jumi hands the child a credential that can call Grok but cannot refresh, so a
 * killed review cannot rotate the refresh grant and take the new token with it
 * (see `src/xai_auth.ts`). That only holds if OpenCode actually sends the
 * shipped shape as a bearer instead of routing it through its own refresh path.
 * A unit test cannot tell: the decision lives in OpenCode's provider loader, and
 * an upgrade can change it silently.
 *
 * How: point the `xai` provider at a loopback server, seed an isolated
 * `XDG_DATA_HOME` auth file with exactly what `childAuthFile` produces, and run
 * the real `opencode run`. Then assert the bearer the provider presented is the
 * access token we seeded, and that the seeded file is unchanged — a refresh
 * would have rewritten it.
 *
 * The fake server does not implement the xAI Responses API, so `opencode run`
 * itself fails afterwards. That is deliberate: the model's answer is not under
 * test, the Authorization header is, and hand-rolling a valid Responses stream
 * would make this probe fail on every ai-sdk change instead of on the one thing
 * it guards.
 *
 * Exit 0 when the credential is presented as a bearer and never rotated.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOpenCodeMajor } from "./git.ts";
import { childAuthFile, XAI_CHILD_AUTH_SHAPE, XAI_PROVIDER_ID } from "./xai_auth.ts";

/** Never a real token: the probe only needs the string to be echoed back. */
const PROBE_ACCESS = "jumi-xai-child-probe-access";
const PROBE_REFRESH = "jumi-xai-child-probe-refresh";
const MODEL_ID = "grok-4.6";
/** Hang guard only; a loopback provider answers in seconds. */
const RUN_TIMEOUT_MS = 120_000;

interface ProbeState {
  /** Authorization header of the first upstream call, if any. */
  authorization?: string;
  requests: number;
}

function startProbeServer(state: ProbeState) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      state.requests += 1;
      if (state.authorization === undefined) state.authorization = req.headers.get("authorization") ?? "(none)";
      // A non-retryable status: the header has already been observed, and the
      // run should end now rather than sit in the SDK's backoff.
      return new Response(JSON.stringify({ error: { message: "jumi xai child credential probe" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

async function writeProbeConfig(dir: string, origin: string): Promise<string> {
  const path = join(dir, "opencode-xai-probe.json");
  await writeFile(
    path,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      // Only the base URL moves: the provider, its auth loader and its SDK stay
      // the ones production uses, which is the point of the probe.
      provider: { [XAI_PROVIDER_ID]: { options: { baseURL: `${origin}/v1` }, models: { [MODEL_ID]: {} } } },
      permission: { edit: "deny", write: "deny", bash: "deny", webfetch: "deny", task: "deny", question: "deny" },
    }),
    "utf8"
  );
  return path;
}

async function runOpenCode(env: Record<string, string>, workdir: string): Promise<void> {
  const major = getOpenCodeMajor();
  const args =
    major >= 2
      ? ["opencode", "run", "--standalone", "-m", `${XAI_PROVIDER_ID}/${MODEL_ID}`, "say ok"]
      : ["opencode", "run", "--dir", workdir, "-m", `${XAI_PROVIDER_ID}/${MODEL_ID}`, "say ok"];
  const proc = Bun.spawn(args, {
    cwd: workdir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
  try {
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<number> {
  const shape = XAI_CHILD_AUTH_SHAPE;
  const state: ProbeState = { requests: 0 };
  const server = startProbeServer(state);
  const origin = `http://127.0.0.1:${server.port}`;
  const dir = await mkdtemp(join(tmpdir(), "jumi-xai-child-probe-"));
  const failures: string[] = [];
  try {
    const workdir = join(dir, "workspace");
    const dataHome = join(dir, "data");
    const authPath = join(dataHome, "opencode", "auth.json");
    await Bun.$`mkdir -p ${workdir} ${join(dataHome, "opencode")} ${join(dir, "home")}`.quiet();
    await Bun.$`git init -q`.cwd(workdir).quiet();

    // Exactly what the parent seeds for a child, from a parent credential that
    // does hold a refresh token.
    const seeded = childAuthFile(
      {
        [XAI_PROVIDER_ID]: {
          type: "oauth",
          access: PROBE_ACCESS,
          refresh: PROBE_REFRESH,
          expires: Date.now() + 6 * 60 * 60 * 1000,
        },
      },
      undefined,
      shape
    );
    const seededText = `${JSON.stringify(seeded, null, 2)}\n`;
    await writeFile(authPath, seededText, { mode: 0o600 });
    if (seededText.includes(PROBE_REFRESH)) {
      failures.push("childAuthFile handed the child a refresh token");
    }

    await runOpenCode(
      {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: join(dir, "home"),
        TMPDIR: dir,
        XDG_DATA_HOME: dataHome,
        XDG_CONFIG_HOME: join(dir, "xdg-config"),
        OPENCODE_CONFIG: await writeProbeConfig(dir, origin),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        // OpenCode 2 stores credentials in SQLite, not auth.json, and its xAI
        // provider sends XAI_API_KEY as bearer. The isolated auth file above is
        // ignored by V2, so hand the V2 child the same refresh-less token via
        // env, exactly like production does. V1 ignores the env and uses the file.
        XAI_API_KEY: PROBE_ACCESS,
      },
      workdir
    );

    if (state.authorization !== `Bearer ${PROBE_ACCESS}`) {
      failures.push(
        `OpenCode did not present the seeded access token as a bearer (requests=${state.requests}, authorization=${
          state.authorization ?? "(no upstream call)"
        })`
      );
    }
    const after = await readFile(authPath, "utf8");
    if (after !== seededText) failures.push("OpenCode rewrote the child auth file: the child entered a refresh path");
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`xAI child credential probe: the ${shape} shape is not usable by this OpenCode binary`);
    return 1;
  }
  console.log(
    `ok  xAI child credential (${shape}) is sent as a bearer and never refreshed by the installed OpenCode binary`
  );
  return 0;
}

process.exit(await main());
