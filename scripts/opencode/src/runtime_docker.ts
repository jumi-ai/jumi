import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test-only Docker computer. Proves the runtime port is real.
 *
 * Neither factory selects this runtime: production (`worker.ts`,
 * `engine_dispatch.ts`, `runners.ts`) never imports this module. No new
 * required environment, no chart change.
 *
 * - One generic image for every repo. No per-repo image, no snapshot.
 * - The container can edit the workspace (bind-mounted, writable) and run
 *   commands via `docker exec`.
 * - The engine child receives no forge token. Clone credentials
 *   (`GIT_AUTH_*`) are injected by the parent per exec, as today.
 * - Auth is a mount the operator already has (`-v <host>:/auth:ro`). This
 *   runtime never runs `docker login` and never copies one ordinal's auth
 *   onto another: each session mounts, it does not `docker cp` auth between
 *   containers.
 * - Timeout and kill belong to the runtime. No memory API.
 * - Logs stream to the parent via `logger`. Not a second trace store.
 *
 * Timeout/cancel kill the container itself (`docker kill` stops the
 * container's main process, not just the exec), so a session is single-use
 * after a timeout or cancel: destroy it and provision a fresh session
 * rather than exec-ing into it again.
 */

export const DOCKER_RUNTIME_IMAGE = "docker.io/library/debian:bookworm-slim";

export const DOCKER_RUNTIME_NAME = "docker-test-only";

export interface DockerExecOpts {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  logger?: (message: string) => void;
}

export interface DockerSession {
  name: string;
  hostWorkdir: string;
  containerWorkdir: string;
  authMountSrc?: string;
  exec(args: string[], opts?: DockerExecOpts): Promise<string>;
  copyOut(containerPath: string, hostPath: string): Promise<void>;
  destroy(): Promise<void>;
}

async function runDocker(args: string[], opts?: { env?: Record<string, string | undefined> }): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts?.env },
  });
  const [out, err, code] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited]);
  if (code !== 0)
    throw new Error(`docker ${args.join(" ")} failed (${code}): ${[out, err].filter(Boolean).join("\n")}`);
  return out;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out).trim();
}

function childEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  // Clone credentials injected by the parent, as today. Forge tokens never
  // reach the engine child.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v == null) continue;
    if (k === "GIT_AUTH_HOST" || k === "GIT_AUTH_USERNAME" || k === "GIT_AUTH_TOKEN") out[k] = v;
    if (k === "GIT_AUTHOR_NAME" || k === "GIT_AUTHOR_EMAIL") out[k] = v;
    if (k === "GIT_COMMITTER_NAME" || k === "GIT_COMMITTER_EMAIL") out[k] = v;
  }
  return out;
}

export function dockerChildEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  return childEnv(parentEnv);
}

let sessionCounter = 0;

export async function provisionDockerSession(opts?: {
  image?: string;
  authMountSrc?: string;
  logger?: (message: string) => void;
}): Promise<DockerSession> {
  const image = opts?.image ?? DOCKER_RUNTIME_IMAGE;
  const hostWorkdir = await mkdtemp(join(tmpdir(), "jumi-docker-work-"));
  const name = `jumi-docker-test-${process.pid}-${Date.now()}-${sessionCounter++}`;
  const args = ["run", "-d", "--name", name];
  args.push("-v", `${hostWorkdir}:/work`);
  if (opts?.authMountSrc) args.push("-v", `${opts.authMountSrc}:/auth:ro`);
  args.push(image, "sleep", "infinity");
  try {
    await runDocker(args);
  } catch (err) {
    await rm(hostWorkdir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  const containerWorkdir = "/work";
  try {
    await runDocker(["exec", name, "mkdir", "-p", containerWorkdir]);
  } catch (err) {
    await runDocker(["rm", "-f", name]).catch(() => undefined);
    await rm(hostWorkdir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  let destroyed = false;
  let containerRemoved = false;
  const exec = async (cmd: string[], execOpts?: DockerExecOpts): Promise<string> => {
    const child = childEnv({ ...process.env, ...execOpts?.env });
    const execArgs = ["exec"];
    for (const [k, v] of Object.entries(child)) execArgs.push("-e", `${k}=${v}`);
    execArgs.push(name, ...cmd);
    const log = execOpts?.logger ?? opts?.logger;
    log?.(`$ ${cmd.join(" ")}`);
    if (execOpts?.abortSignal?.aborted) {
      const err = new Error("cancelled");
      err.name = "AbortError";
      throw err;
    }
    const proc = Bun.spawn(["docker", ...execArgs], { stdout: "pipe", stderr: "pipe", env: process.env });
    let done = false;
    const onAbort = () => {
      if (done) return;
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
      void runDocker(["kill", name]).catch(() => undefined);
    };
    execOpts?.abortSignal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timeout =
      execOpts?.timeoutMs && execOpts.timeoutMs > 0
        ? setTimeout(() => {
            if (done) return;
            timedOut = true;
            try {
              proc.kill();
            } catch {
              // Already exited.
            }
            void runDocker(["kill", name]).catch(() => undefined);
          }, execOpts.timeoutMs)
        : undefined;
    try {
      const [out, errText, code] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited]);
      done = true;
      if (timeout) clearTimeout(timeout);
      if (timedOut) throw new Error(`docker exec timed out after ${execOpts?.timeoutMs}ms: ${cmd.join(" ")}`);
      if (execOpts?.abortSignal?.aborted) {
        const err = new Error("cancelled");
        err.name = "AbortError";
        throw err;
      }
      if (code !== 0) throw new Error(`docker exec failed (${code}): ${[out, errText].filter(Boolean).join("\n")}`);
      if (out) log?.(out);
      if (errText) log?.(errText);
      return out;
    } finally {
      done = true;
      execOpts?.abortSignal?.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
    }
  };

  const copyOut = async (containerPath: string, hostPath: string): Promise<void> => {
    await runDocker(["cp", `${name}:${containerPath}`, hostPath]);
  };

  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    // Throws on failure so callers with a landed push can wrap this in
    // `destroyPreservingPush`; test-only sessions with no push just let it throw.
    // Flags are set only after each step succeeds so a failed destroy stays
    // retryable instead of poisoning the next call.
    if (!containerRemoved) {
      await runDocker(["rm", "-f", name]);
      containerRemoved = true;
    }
    await rm(hostWorkdir, { recursive: true, force: true });
    destroyed = true;
  };

  return { name, hostWorkdir, containerWorkdir, authMountSrc: opts?.authMountSrc, exec, copyOut, destroy };
}

/**
 * Destroy always runs. A failed destroy must not discard a push that already
 * landed: callers pass `pushLanded=true` and keep their prior result when
 * destroy throws.
 */
export async function destroyPreservingPush(
  destroy: () => Promise<void>,
  opts: { pushLanded: boolean; logger?: (message: string) => void }
): Promise<void> {
  try {
    await destroy();
  } catch (err) {
    opts.logger?.(`docker destroy failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!opts.pushLanded) throw err;
  }
}
