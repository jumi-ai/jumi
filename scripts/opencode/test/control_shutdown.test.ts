import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControl } from "../src/control.ts";
import type { ControlConfig } from "../src/control_config.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function makeConfig(): Promise<ControlConfig> {
  const home = await mkdtemp(join(tmpdir(), "control-shutdown-"));
  dirs.push(home);
  return {
    host: "127.0.0.1",
    port: 0,
    home,
    role: "control",
    secretName: "codex-token",
    secretNamespace: "default",
    k8sApiUrl: "https://127.0.0.1:1",
    k8sTokenFile: join(home, "no-token"),
    k8sCaFile: join(home, "no-ca"),
    pollMs: 50,
    jobNamespace: "default",
    jobStartupTimeoutMs: 1_000,
    dispatchPollMs: 50,
    dispatchEngine: { enabled: false },
    dispatchWorker: { enabled: false },
  };
}

describe("control shutdown", () => {
  test("abort stops both listeners within the bound", async () => {
    const config = await makeConfig();
    const abort = new AbortController();
    const handle = await startControl(config, {
      signal: abort.signal,
      logger: () => {},
      shutdownGraceMs: 500,
      deviceLoginPort: 0,
      deviceLoginHost: "127.0.0.1",
    });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.deviceLoginPort).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(health.status).toBe(200);
    await health.text().catch(() => undefined);
    const ordinalHealth = await fetch(`http://127.0.0.1:${handle.deviceLoginPort}/healthz`);
    expect(ordinalHealth.status).toBe(200);
    await ordinalHealth.text().catch(() => undefined);

    abort.abort();
    const started = Date.now();
    await handle.closed;
    expect(Date.now() - started).toBeLessThan(5_000);

    await expect(fetch(`http://127.0.0.1:${handle.port}/healthz`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${handle.deviceLoginPort}/healthz`)).rejects.toThrow();

    // Repeated signals are harmless.
    await handle.stop();
    await handle.closed;
  });

  test("stuck in-flight handler still settles within the bound", async () => {
    const config = await makeConfig();
    const abort = new AbortController();
    let releaseStuck!: () => void;
    const stuckGate = new Promise<void>((resolve) => {
      releaseStuck = resolve;
    });
    const fetchHandler = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === "/stuck") {
        await stuckGate;
        return new Response("stuck-done", { status: 200 });
      }
      if (url.pathname === "/healthz") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const handle = await startControl(config, {
      signal: abort.signal,
      logger: () => {},
      shutdownGraceMs: 200,
      fetchHandler,
      deviceLoginPort: 0,
      deviceLoginHost: "127.0.0.1",
    });

    const stuck = fetch(`http://127.0.0.1:${handle.port}/stuck`);
    // Mark handled immediately so the force-close reset cannot surface as an unhandled rejection.
    stuck.catch(() => undefined);
    // Let the in-flight request reach the handler before aborting.
    await Bun.sleep(100);
    const health = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(health.status).toBe(200);
    await health.text().catch(() => undefined);

    abort.abort();
    const started = Date.now();
    await handle.closed;
    expect(Date.now() - started).toBeLessThan(5_000);

    await expect(fetch(`http://127.0.0.1:${handle.port}/healthz`)).rejects.toThrow();

    // The forced drain terminates the stuck connection client-side.
    const outcome = await Promise.race([
      stuck.then(() => "settled").catch(() => "rejected"),
      Bun.sleep(2_000).then(() => "timeout"),
    ]);
    expect(outcome).not.toBe("timeout");
    releaseStuck();
    await stuck.catch(() => undefined);
    await handle.stop();
  });

  test("startup with listening disabled is unchanged", async () => {
    const config = await makeConfig();
    const abort = new AbortController();
    const handle = await startControl(config, {
      signal: abort.signal,
      listen: false,
      logger: () => {},
      shutdownGraceMs: 100,
    });
    expect(handle.port).toBeUndefined();
    abort.abort();
    await handle.closed;
    await handle.stop();
  });
});
