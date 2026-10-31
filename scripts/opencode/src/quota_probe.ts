#!/usr/bin/env bun
/**
 * Prove the quota reads against the *installed OpenCode binary*.
 *
 * `inspectQuotaSleepInDb` depends on OpenCode's private session DB: its columns,
 * the `retry` field on the assistant row, and when that field is cleared. Those
 * reads swallow SQLite errors on purpose, so an OpenCode upgrade that changes
 * any of this looks like "no quota hit", and every sleeping child would then sit
 * until the job timeout. Hand-written fixtures cannot notice that.
 *
 * How: stand up a throwaway OpenAI-compatible provider on loopback that answers
 * every request with the provider's quota 429 and a long `retry-after`, run
 * `opencode run` against it, and require the shipped read to see the sleep the
 * way the production poll does. Then stop the child the way production does and
 * require the sleep to be gone.
 *
 * Exit 0 when every case matches its expectation, 1 otherwise.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkQuotaDbSchema, inspectQuotaSleepInDb, type QuotaHit } from "./quota.ts";

const PROVIDER_ID = "jumi-quota-probe";
const MODEL_ID = "jumi-quota-probe-model";
const RETRY_AFTER_SECONDS = 7_200;
/** The child reaches the sleep in seconds; this is only a hang guard. */
const SLEEP_TIMEOUT_MS = 60_000;
const CLEAR_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

function startQuotaServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ error: { message: "Rate limit exceeded", code: "account_rate_limit" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(RETRY_AFTER_SECONDS) },
      });
    },
  });
}

async function writeProbeConfig(dir: string, origin: string): Promise<string> {
  const path = join(dir, "opencode-quota-probe.json");
  await writeFile(
    path,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      update: "disable",
      snapshots: false,
      providers: {
        [PROVIDER_ID]: {
          name: "jumi quota probe",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: `${origin}/v1`, apiKey: "probe" },
          models: { [MODEL_ID]: { name: MODEL_ID } },
        },
      },
    }),
    "utf8"
  );
  return path;
}

async function waitForSleep(dbPath: string, sinceMs: number): Promise<QuotaHit | undefined> {
  const deadline = Date.now() + SLEEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const hit = inspectQuotaSleepInDb(dbPath, sinceMs);
    if (hit) return hit;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

/** The `opencode` launcher can exit just before the binary under it clears the row. */
async function waitForClear(dbPath: string, sinceMs: number): Promise<QuotaHit | undefined> {
  const deadline = Date.now() + CLEAR_TIMEOUT_MS;
  let hit = inspectQuotaSleepInDb(dbPath, sinceMs);
  while (hit && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    hit = inspectQuotaSleepInDb(dbPath, sinceMs);
  }
  return hit;
}

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly observed: string;
}

async function main(): Promise<number> {
  const server = startQuotaServer();
  const dir = await mkdtemp(join(tmpdir(), "jumi-quota-probe-"));
  const results: CaseResult[] = [];
  try {
    const workdir = join(dir, "workspace");
    await mkdir(join(dir, "home"), { recursive: true });
    await mkdir(workdir, { recursive: true });
    await Bun.$`git init -q`.cwd(workdir).quiet();
    const dbPath = join(dir, "opencode-session.db");
    const spawnedAt = Date.now();
    const proc = Bun.spawn(["opencode", "run", "--standalone", "--model", `${PROVIDER_ID}/${MODEL_ID}`, "say ok"], {
      cwd: workdir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: join(dir, "home"),
        PWD: workdir,
        TMPDIR: dir,
        XDG_CONFIG_HOME: join(dir, "xdg-config"),
        XDG_DATA_HOME: join(dir, "xdg-data"),
        OPENCODE_CONFIG: await writeProbeConfig(dir, `http://127.0.0.1:${server.port}`),
        OPENCODE_DB: dbPath,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      },
    });
    try {
      const hit = await waitForSleep(dbPath, spawnedAt);
      results.push({
        name: "the live read sees a real quota sleep",
        ok: hit?.kind === "resetting",
        observed: hit ? `kind=${hit.kind}` : `no hit within ${SLEEP_TIMEOUT_MS}ms`,
      });
      results.push({
        name: "the sleep carries the provider's retry-after",
        ok: hit?.retryAfterMs === RETRY_AFTER_SECONDS * 1000,
        observed: `retryAfterMs=${hit?.retryAfterMs ?? "<none>"}`,
      });
      const later = inspectQuotaSleepInDb(dbPath, Date.now() + 1);
      results.push({
        name: "a row written before a later child started does not count",
        ok: hit !== undefined && later === undefined,
        observed: later ? `kind=${later.kind}` : "no hit",
      });
      const schema = checkQuotaDbSchema(dbPath);
      results.push({
        name: "the session DB has every column the quota reads use",
        ok: schema === undefined,
        observed: schema ?? "all present",
      });
    } finally {
      proc.kill();
      await proc.exited;
    }
    const after = await waitForClear(dbPath, spawnedAt);
    results.push({
      name: "stopping the child the way production does clears the sleep",
      ok: after === undefined,
      observed: after ? `still sleeping, kind=${after.kind}` : "cleared",
    });
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }

  for (const { name, ok, observed } of results) console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${observed}`);
  const failures = results.filter((result) => !result.ok).length;
  if (failures > 0) {
    console.error(`quota probe: ${failures}/${results.length} check(s) failed against the OpenCode binary`);
    return 1;
  }
  console.log(`quota probe: ${results.length}/${results.length} checks pass against the installed OpenCode binary`);
  return 0;
}

process.exit(await main());
