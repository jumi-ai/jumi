import type { ReviewJobStore } from "./review_jobs.ts";

type InFlightLease = {
  release: () => Promise<void>;
  abort?: () => void;
  wait?: () => Promise<void>;
};

const inflight = new Set<InFlightLease>();

export function trackInFlightLease(
  release: () => Promise<void>,
  opts?: { abort?: () => void; wait?: () => Promise<void> }
): () => void {
  const entry: InFlightLease = { release, abort: opts?.abort, wait: opts?.wait };
  inflight.add(entry);
  return () => {
    inflight.delete(entry);
  };
}

/**
 * Ordered shutdown: abort first, wait for the child to stop, then release.
 * The old code released at the same moment it aborted, so the lease could be
 * free while the child was still running and another runner could overlap the
 * dying one. `installProcessShutdown` only aborts here; long-running ticks
 * release in their own shutdown path after the awaited child settles.
 * One-shot mode awaits the same ordering and then exits 0 (see `src/job.ts`).
 */
export async function shutdownInFlightLeases(): Promise<void> {
  const entries = [...inflight];
  for (const entry of entries) {
    try {
      entry.abort?.();
    } catch {
      // Best-effort: abort must not block the wait below.
    }
  }
  for (const entry of entries) {
    try {
      await entry.wait?.();
    } catch {
      // The job itself owns its error; shutdown only needs the child stopped.
    }
  }
  const pending = entries.map((entry) => entry.release());
  const results = await Promise.allSettled(pending);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}

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
    // Abort first. The tick's own shutdown path releases after the awaited
    // child settles (abort, wait, then release), so releasing here would free
    // the lease while the child is still running and let another runner
    // overlap the dying one. Only abort here; the release follows the wait.
    if (!shutdown.signal.aborted) shutdown.abort();
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
}
