import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";

/**
 * Abortable `git` spawn: process-group cancellation for `runGit`.
 *
 * When a signal is supplied, `git` runs under `setsid` in its own
 * session/process group (the same approach as `runRepoChildScript`), so an
 * abort can terminate Git and the descendants that remain in the group
 * (ssh/remote/credential helpers). This is process-group cancellation, not a
 * containment boundary: a descendant that creates a new session/group escapes
 * it. Callers without a signal keep the direct-child spawn in `workspace.ts`.
 */

/** Grace after SIGTERM to the owned git process group before SIGKILL. */
export const GIT_ABORT_GRACE_MS = 5000;

function gitAbortError(): Error {
  const err = new Error("cancelled");
  err.name = "AbortError";
  return err;
}

/**
 * Fail-closed `setsid` probe against the PATH `git` will actually spawn with:
 * `Bun.spawn` resolves binaries through the spawn env's `PATH`, not the
 * process one, so probe that same value (unset falls back to the process
 * `PATH`, like the `repo_setup.ts` `Bun.which("setsid")` probe).
 */
function isSetsidAvailable(spawnPath: string | undefined): boolean {
  const pathValue = spawnPath ?? process.env.PATH ?? "";
  return pathValue.split(":").some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, "setsid"), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function throwUnlessEsrch(err: unknown): void {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ESRCH") return;
  throw err;
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ESRCH") return false;
    // EPERM means a live group we cannot signal; anything else is a failure.
    if (code === "EPERM") return true;
    throw err;
  }
}

async function readReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output).trim();
}

export interface OwnedGroupGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn `git` under `setsid` and wait for it, killing the owned process group
 * on abort: pre-aborted rejects without spawning; otherwise SIGTERM the group,
 * wait up to `GIT_ABORT_GRACE_MS` for the group to go (not merely the direct
 * child), then SIGKILL, await the direct child, cancel pending stream readers
 * instead of waiting for their EOF, and reject `AbortError`. Group cleanup runs
 * independently of stream completion, so a helper that outlives `git` (or
 * holds its pipes) is still terminated. Non-ESRCH kill failures propagate.
 */
export async function runGitInOwnedGroup(
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; signal: AbortSignal }
): Promise<OwnedGroupGitResult> {
  const signal = opts.signal;
  if (signal.aborted) throw gitAbortError();
  if (!isSetsidAvailable(opts.env.PATH)) {
    throw new Error("runGit: abort signal requires setsid on PATH (util-linux provides it)");
  }
  const proc = Bun.spawn(["setsid", "git", ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
  });
  const pgid = proc.pid;
  const outReader = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
  const errReader = (proc.stderr as unknown as ReadableStream<Uint8Array>).getReader();
  const outPromise = readReader(outReader);
  const errPromise = readReader(errReader);
  const exitPromise = proc.exited;
  // Suppress unhandled rejections: the abort path cancels these readers and
  // settles them via allSettled below instead of awaiting their EOF.
  outPromise.catch(() => undefined);
  errPromise.catch(() => undefined);
  let onAbort = () => {};
  const abortFired = new Promise<never>((_, reject) => {
    onAbort = () => reject(gitAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const completed = (async () => {
    const [stdout, stderr, exitCode] = await Promise.all([outPromise, errPromise, exitPromise]);
    return { stdout, stderr, exitCode };
  })();
  // Avoid an unhandled rejection when the abort wins the race below.
  completed.catch(() => undefined);
  try {
    const result = await Promise.race([completed, abortFired]);
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) throw gitAbortError();
    return result;
  } catch (err) {
    if (!signal.aborted) throw err;
    try {
      process.kill(-pgid, "SIGTERM");
    } catch (killErr) {
      throwUnlessEsrch(killErr);
    }
    const deadline = Date.now() + GIT_ABORT_GRACE_MS;
    let gone = !isGroupAlive(pgid);
    while (!gone && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      gone = !isGroupAlive(pgid);
    }
    if (!gone && isGroupAlive(pgid)) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (killErr) {
        throwUnlessEsrch(killErr);
      }
    }
    await exitPromise.catch(() => undefined);
    await Promise.allSettled([outReader.cancel().catch(() => undefined), errReader.cancel().catch(() => undefined)]);
    await Promise.allSettled([outPromise, errPromise]);
    throw gitAbortError();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
