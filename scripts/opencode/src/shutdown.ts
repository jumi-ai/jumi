import type { ReviewJobStore } from "./review_jobs.ts";
import { errorMessage } from "./util/error.ts";

export async function releaseLeaseOnShutdown(
  store: ReviewJobStore,
  id: number,
  jobKey: string,
  leasedBy: string,
  logger: (message: string) => void,
  expireLabel: string
): Promise<void> {
  try {
    const current = await store.get(id);
    if (current && current.leasedBy !== leasedBy) return;
    const released = await store.releaseLease(id, leasedBy);
    if (released) {
      logger(`released ${jobKey} on shutdown`);
    } else {
      await store.expireLease(id, leasedBy);
    }
  } catch (err) {
    logger(`${expireLabel} ${jobKey}: ${errorMessage(err)}`);
  }
}

export function installProcessShutdown(shutdown: AbortController, logger: (message: string) => void): void {
  const onSignal = (signal: string) => {
    logger(`received ${signal}, shutting down`);
    // Ordered shutdown: abort first, wait for the child to stop, then
    // release. The old code released at the same moment it aborted, so the
    // lease could be free while the child was still running and another
    // runner could overlap the dying one. Only abort here; each tick awaits
    // its child and releases in its own shutdown path after the child
    // settles (see the `releaseLeaseOnShutdown` calls in `src/server.ts` and
    // `src/worker.ts`). One-shot mode then exits 0 (see `src/job.ts`).
    if (!shutdown.signal.aborted) shutdown.abort();
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
}

/** Short fixed bound for the control listeners to drain after abort (no new config). */
export const CONTROL_SHUTDOWN_GRACE_MS = 5_000;
/** Cap for the force-close after the grace expires, so shutdown stays bounded. */
const SHUTDOWN_FORCE_MS = 1_000;

export interface StoppableServer {
  stop: (closeActiveConnections?: boolean) => Promise<void> | void;
}

/** Stop accepting new connections, drain within `graceMs`, then force-close stuck ones. Idempotent-safe. */
export async function stopServersWithinBound(
  servers: Array<StoppableServer | undefined>,
  graceMs: number,
  logger?: (message: string) => void
): Promise<void> {
  const targets = servers.filter((s): s is StoppableServer => s !== undefined);
  if (targets.length === 0) return;
  const graceful = targets.map((s) => {
    try {
      return Promise.resolve(s.stop());
    } catch (err) {
      logger?.(`shutdown stop failed: ${errorMessage(err)}`);
      return Promise.resolve();
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, graceMs));
  });
  await Promise.race([Promise.all(graceful).then(() => undefined), timeout]).catch(() => undefined);
  if (timer !== undefined) clearTimeout(timer);
  const force = targets.map((s) => {
    try {
      return Promise.resolve(s.stop(true));
    } catch {
      return Promise.resolve();
    }
  });
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const forceTimeout = new Promise<void>((resolve) => {
    forceTimer = setTimeout(resolve, SHUTDOWN_FORCE_MS);
  });
  await Promise.race([Promise.all(force).then(() => undefined), forceTimeout]).catch(() => undefined);
  if (forceTimer !== undefined) clearTimeout(forceTimer);
}
