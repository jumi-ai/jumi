import type { ReviewJobStore } from "./review_jobs.ts";

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
    logger(`${expireLabel} ${jobKey}: ${err instanceof Error ? err.message : String(err)}`);
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
