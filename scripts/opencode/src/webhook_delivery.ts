/**
 * Replay guard for signed webhook deliveries.
 *
 * `X-Gitea-Delivery` / `X-GitHub-Delivery` is a forge-assigned UUID the
 * parent copies into the job as identity only. A captured valid delivery
 * replays byte-for-byte, including a valid HMAC, so signature verification
 * alone cannot reject it. The queue dedupes concurrent enqueues by job key,
 * but after a job completes the same delivery would enqueue again.
 *
 * This is a process-local, bounded LRU of recently seen delivery IDs. A
 * replayed delivery in the same process lifetime returns `true` (seen) and
 * the caller answers 202-deduped without enqueueing. It does not survive a
 * restart: after a restart a replayed delivery re-enqueues the same job key,
 * which the ledger dedupes while queued/leased and otherwise re-runs
 * idempotently (same SHA review, same issue follow-up gate). That residual
 * is documented as accepted risk in the README threat model.
 */
export function createDeliveryDedupe(limit = 2000): {
  /** Read-only probe: true when this delivery was already recorded. Never mutates. */
  has(delivery: string): boolean;
  /** Record a delivery as handled. No-op for empty ids and already-known ids. */
  mark(delivery: string): void;
  /** Legacy check-then-record. Prefer has/mark so unauthenticated or failed
   * deliveries never occupy a slot (see server.ts, worker_server.ts, github_webhook.ts). */
  seen(delivery: string): boolean;
  size(): number;
} {
  const order: string[] = [];
  const known = new Set<string>();
  const has = (delivery: string): boolean => {
    if (!delivery) return false;
    return known.has(delivery);
  };
  const mark = (delivery: string): void => {
    if (!delivery || known.has(delivery)) return;
    known.add(delivery);
    order.push(delivery);
    while (order.length > limit) {
      const oldest = order.shift();
      if (oldest !== undefined) known.delete(oldest);
    }
  };
  return {
    has,
    mark,
    seen(delivery: string): boolean {
      if (has(delivery)) return true;
      if (!delivery) return false;
      mark(delivery);
      return false;
    },
    size(): number {
      return known.size;
    },
  };
}

export type DeliveryDedupe = ReturnType<typeof createDeliveryDedupe>;
