import { createHash } from "node:crypto";
import type { AutomergeReconcileStore } from "./automerge_reconcile.ts";
import { errorMessage } from "./util/error.ts";

/**
 * Durable cancellation-verification admission for automerge label webhooks
 * (issue #839). The shared label handler stays small: this module owns the
 * cause identity, the store lookup, the admission write, and the settle
 * fence, while the drained obligation itself lives in
 * `automerge_reconcile.ts` and the cancel runs only in
 * `automerge_reconcile_drain.ts`.
 */

/** Thrown when the durable admission write fails. Routers map it to 503. */
export class AutomergeAdmissionError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "AutomergeAdmissionError";
  }
}

export function isAutomergeAdmissionError(err: unknown): err is AutomergeAdmissionError {
  return err instanceof AutomergeAdmissionError;
}

/**
 * Shared webhook lookup for the obligation store. Mirrors `strictSlotsFor`:
 * the Gitea worker path reads `automergeReconcile` directly, the GitHub
 * path reads it off `worker.automergeReconcile`, and the review/queue
 * fallbacks keep older wiring working if the store ever rides along there.
 */
function automergeReconcileFor(deps: unknown): AutomergeReconcileStore | undefined {
  if (!deps || typeof deps !== "object") return undefined;
  const holder = deps as {
    automergeReconcile?: AutomergeReconcileStore;
    worker?: {
      automergeReconcile?: AutomergeReconcileStore;
      review?: { automergeReconcile?: AutomergeReconcileStore };
    };
    review?: { automergeReconcile?: AutomergeReconcileStore };
    queue?: { automergeReconcile?: AutomergeReconcileStore };
  };
  if (holder.automergeReconcile) return holder.automergeReconcile;
  if (holder.worker?.automergeReconcile) return holder.worker.automergeReconcile;
  const workerReview = holder.worker?.review?.automergeReconcile;
  if (workerReview) return workerReview;
  if (holder.review?.automergeReconcile) return holder.review.automergeReconcile;
  if (holder.queue?.automergeReconcile) return holder.queue.automergeReconcile;
  return undefined;
}

/**
 * Stable cause identity for an admission. The original forge delivery
 * header is the cause; when the route has no header, a SHA-256 of the raw
 * body namespaced by forge keeps distinct deliveries distinct without
 * mistaking the router's random fallback UUID for a stable forge id.
 */
export function automergeCauseId(
  rawBody: Uint8Array,
  forgeKind: string,
  deliveryHeader: string | null | undefined
): string {
  if (deliveryHeader) return deliveryHeader;
  const digest = createHash("sha256").update(`automerge-label:${forgeKind}:`).update(rawBody).digest("hex");
  return `sha256:${digest}`;
}

/**
 * Router-side admission arguments. Returns undefined when the store is not
 * wired (older wiring, tests), preserving today's inline behavior exactly.
 * An explicit `opts` with no header hashes the body; without `opts` the
 * passed delivery itself stays the cause, as before.
 */
export function automergeAdmissionFor(
  deps: unknown,
  rawBody: Uint8Array,
  forgeKind: string,
  delivery: string,
  opts?: { forgeDeliveryId?: string | null }
): { automergeReconcile: AutomergeReconcileStore; causeId: string } | undefined {
  const automergeReconcile = automergeReconcileFor(deps);
  if (!automergeReconcile) return undefined;
  const header = opts ? (opts.forgeDeliveryId ?? null) : delivery;
  return { automergeReconcile, causeId: automergeCauseId(rawBody, forgeKind, header) };
}

/**
 * Request the cancellation-verification obligation before any forge attempt
 * or read. A duplicate carries its original generation and needs no further
 * effect; a failed write throws `AutomergeAdmissionError` for the 503 path.
 */
export async function requestAutomergeAdmission(opts: {
  store: AutomergeReconcileStore;
  owner: string;
  repo: string;
  prNumber: number;
  causeId: string;
  action: string;
  log?: (message: string) => void;
}): Promise<{ status: "admitted"; generation: number } | { status: "duplicate"; reason: string }> {
  const coords = `${opts.owner}/${opts.repo}#${opts.prNumber}`;
  let admission: { status: string; generation: number };
  try {
    admission = await opts.store.request(opts.owner, opts.repo, opts.prNumber, opts.causeId, Date.now());
  } catch (err) {
    throw new AutomergeAdmissionError(`automerge admission failed for ${coords}: ${errorMessage(err)}`);
  }
  if (admission.status === "duplicate") {
    opts.log?.(`automerge label ${opts.action} for ${coords}: duplicate (generation ${admission.generation})`);
    return {
      status: "duplicate",
      reason: `automerge label ${opts.action}: duplicate (generation ${admission.generation})`,
    };
  }
  return { status: "admitted", generation: admission.generation };
}

/** Outcomes decisive enough to settle the admission inline (fresh reads). */
const DECISIVE_NON_CANCEL = new Set(["scheduled", "none", "deployment-blocked"]);

/**
 * Settle only this admission's generation after a decisive fresh non-cancel
 * outcome. Deferred cancels, unreadable results, and fall-throughs leave
 * the obligation for the leased drainer. A stale settle (bumped by a newer
 * delivery) is harmless; a failed settle is logged while the durable work
 * stays for the drainer.
 */
export async function settleAutomergeAdmission(opts: {
  store: AutomergeReconcileStore;
  owner: string;
  repo: string;
  prNumber: number;
  generation: number;
  action: string;
  log?: (message: string) => void;
}): Promise<void> {
  if (!DECISIVE_NON_CANCEL.has(opts.action)) return;
  const coords = `${opts.owner}/${opts.repo}#${opts.prNumber}`;
  try {
    await opts.store.settle(opts.owner, opts.repo, opts.prNumber, opts.generation);
  } catch (err) {
    opts.log?.(`automerge admission settle failed for ${coords}: ${errorMessage(err)}`);
  }
}
