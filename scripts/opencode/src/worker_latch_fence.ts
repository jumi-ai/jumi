import { recordJobCompleted } from "./control_metrics.ts";
import { logDiagnostic } from "./diagnostics.ts";
import { resolveWorkerHeld } from "./exhausted_hold.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { cancelIssueWork } from "./implement.ts";
import type { ReviewJobStore } from "./review_jobs.ts";
import { LatchFenceRejected, LatchFenceUnsupported, type SkipLatchStore } from "./skip_latches.ts";
import { errorMessage } from "./util/error.ts";
import type { WorkerConfig } from "./worker_config.ts";

export type WorkerLatchFenceFailure = { kind: "rejected" | "unsupported"; error: Error };

const LATCH_GENERATION_CHANGED_REASON = "latch generation changed";
const LATCH_FENCE_UNSUPPORTED_REASON = "latch fence unsupported";

/**
 * Runner-local latch fence: every `put` this job makes carries its lease
 * (row id, exact tick token, payload generation). `get`/`delete` are
 * forwarded unwatched. The first rejection is recorded, the job's controller
 * is aborted, and the error is rethrown — call sites may swallow it, so the
 * recorded flag (not the runner's return/throw) is authoritative.
 *
 * Limit: forge calls already issued before the rejection are not rolled
 * back; the fence only stops later latch writes and further progress. Never
 * retry the write unfenced.
 */
export function fencedSkipLatchesForWorkerJob(opts: {
  skipLatches: SkipLatchStore;
  jobId: number;
  leasedBy: string;
  generation: number;
  abort: AbortController;
  record: (failure: WorkerLatchFenceFailure) => void;
}): SkipLatchStore {
  const fence = { jobId: opts.jobId, leasedBy: opts.leasedBy, generation: opts.generation };
  return {
    get: (latchKey) => opts.skipLatches.get(latchKey),
    delete: (latchKey) => opts.skipLatches.delete(latchKey),
    put: async (latchKey, patch) => {
      try {
        await opts.skipLatches.put(latchKey, patch, fence);
      } catch (err) {
        if (err instanceof LatchFenceRejected) {
          opts.record({ kind: "rejected", error: err });
          try {
            opts.abort.abort();
          } catch {
            // Never fail the latch write on abort mechanics.
          }
          throw err;
        }
        if (err instanceof LatchFenceUnsupported) {
          opts.record({ kind: "unsupported", error: err });
          try {
            opts.abort.abort();
          } catch {
            // Never fail the latch write on abort mechanics.
          }
          throw err;
        }
        throw err;
      }
    },
  };
}

export interface WorkerLatchFenceSettleTarget {
  owner: string;
  repo: string;
  issueNumber: number;
  headSha: string;
  prNumber?: number | null;
  mode?: string;
  jobKey: string;
  jobKind: string;
}

/**
 * Settle a recorded fence failure after the cancel/lost-owner/shutdown
 * checks have run. Still owned with no cancel/shutdown: generation
 * rejections settle `skipped`/`latch generation changed`, unsupported
 * fencing settles `failed`/`latch fence unsupported`. Follow-up hold and
 * strict-slot handling run only after the owner-fenced `markPublished`
 * confirms the settlement; a `cancelled: true` return keeps cancel
 * semantics and `succeeded` is never published. Ownership is re-read here
 * and `markPublished` stays fenced against a later race.
 */
export async function settleWorkerLatchFenceFailure(opts: {
  failure: WorkerLatchFenceFailure | undefined;
  store: ReviewJobStore;
  api: IssueApi;
  config: Pick<WorkerConfig, "botUsername" | "home">;
  rowId: number;
  leasedBy: string;
  target: WorkerLatchFenceSettleTarget;
  logger: (message: string) => void;
  recordModelReached: () => void | Promise<void>;
}): Promise<"processed" | undefined> {
  const { failure, store, api, config, rowId, leasedBy, target, logger } = opts;
  if (!failure) return undefined;
  let owned = false;
  try {
    const fresh = await store.get(rowId);
    owned = fresh?.state === "leased" && fresh.leasedBy === leasedBy;
  } catch {
    owned = false;
  }
  if (!owned) {
    if (target.mode === "follow-up") {
      await resolveWorkerHeld(
        api,
        store,
        target.owner,
        target.repo,
        target.issueNumber,
        target.headSha ?? "",
        "skipped",
        "job cancelled",
        target.prNumber
      );
    }
    logger(`${target.jobKey} cancelled`);
    return "processed";
  }
  const rejected = failure.kind === "rejected";
  const state = rejected ? ("skipped" as const) : ("failed" as const);
  const reason = rejected ? LATCH_GENERATION_CHANGED_REASON : LATCH_FENCE_UNSUPPORTED_REASON;
  if (!rejected) {
    logDiagnostic(logger, "latch_fence_unsupported", { job: target.jobKey, reason });
    logger(`${target.jobKey} latch fence unsupported: ${errorMessage(failure.error)}`);
  }
  let published: { cancelled: boolean };
  try {
    published = await store.markPublished(rowId, leasedBy, { state, reason });
  } catch {
    logger(`${target.jobKey} cancelled`);
    return "processed";
  }
  if (published.cancelled) {
    if (target.mode === "follow-up") {
      await resolveWorkerHeld(
        api,
        store,
        target.owner,
        target.repo,
        target.issueNumber,
        target.headSha ?? "",
        "skipped",
        "job cancelled",
        target.prNumber
      );
    }
    try {
      await cancelIssueWork({
        api,
        owner: target.owner,
        repo: target.repo,
        issueNumber: target.issueNumber,
        botUsername: config.botUsername,
        home: config.home,
        killPid: () => undefined,
      });
    } catch (err) {
      logger(`cancel cleanup failed ${target.jobKey}: ${errorMessage(err)}`);
    }
    logger(`${target.jobKey} cancelled`);
    return "processed";
  }
  if (target.mode === "follow-up") {
    await resolveWorkerHeld(
      api,
      store,
      target.owner,
      target.repo,
      target.issueNumber,
      target.headSha ?? "",
      "skipped",
      rejected ? reason : "job failed",
      target.prNumber
    );
  }
  {
    const { settleStrictSlotForWorkerOutcome } = await import("./strict_refresh_terminal.ts");
    await settleStrictSlotForWorkerOutcome({
      slots: store.strictSlots,
      job: {
        owner: target.owner,
        repo: target.repo,
        prNumber: typeof target.prNumber === "number" ? target.prNumber : undefined,
        headSha: target.headSha ?? "",
      },
      status: state,
      reason,
      log: logger,
    });
  }
  recordJobCompleted(target.jobKind, state);
  logger(`${target.jobKey} ${state}: ${reason}`);
  await opts.recordModelReached();
  return "processed";
}
