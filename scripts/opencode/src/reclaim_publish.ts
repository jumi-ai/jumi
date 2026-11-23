import type { ReviewApi } from "./ports.ts";
import { RECLAIM_PUBLISH_MAX_FAILURES, type ReviewJobRecord, type ReviewJobStore } from "./review_jobs.ts";
import { errorMessage } from "./util/error.ts";

/**
 * Reclaim-publish settlement for rows that can never publish (#810).
 *
 * A review row that hits max attempts and then can't publish never reached a
 * terminal state: the router re-claimed it on every tick, forever (111k
 * 404s/day in the live case). The shared failure path below settles such
 * rows to `failed` instead of expiring the lease for another pass:
 *
 * - permanent failures (gone repo/installation/PR, closed or merged PR)
 *   settle on the first failure, with the publish error in `result_reason`;
 * - transient-looking errors expire the lease for another pass until
 *   `RECLAIM_PUBLISH_MAX_FAILURES` consecutive failures settle `failed`,
 *   so a transient-looking error cannot loop forever either.
 *
 * Both forges share the `→ <status>:` error shape, so the gone check below
 * is forge-generic. Used by the router's review and worker reclaim loops.
 */

/**
 * A reclaim-publish error that can never succeed on retry: the forge reports
 * the repo, installation, or PR as gone (HTTP 404/410 on either forge).
 */
export function isGonePublishError(err: unknown): boolean {
  return err instanceof Error && (/→ 404\b/.test(err.message) || /→ 410\b/.test(err.message));
}

/**
 * Permanent reclaim-publish failure (#810): a gone repo/installation/PR, or
 * a PR the forge reports as closed or merged. The status check is
 * forge-generic; the closed/merged probe keeps a transient-looking error on
 * a dead PR from looping forever. A failed probe is not permanent: the
 * bounded retry below still caps the loop.
 */
async function isPermanentReclaimPublishFailure(
  api: ReviewApi,
  row: ReviewJobRecord,
  err: unknown,
  logger: (message: string) => void
): Promise<boolean> {
  if (isGonePublishError(err)) return true;
  try {
    const pr = await api.getPR(row.owner, row.repo, row.prNumber);
    if (pr.merged || pr.state !== "open") return true;
  } catch (probeErr) {
    if (isGonePublishError(probeErr)) return true;
    logger(`reclaim-publish probe failed ${row.jobKey}: ${errorMessage(probeErr)}`);
  }
  return false;
}

/**
 * Shared reclaim-publish failure path for review and worker rows. Permanent
 * failures settle the row to `failed` with the publish error in
 * `result_reason`; transient-looking errors expire the lease for another
 * pass until the retry bound settles `failed`.
 */
export async function handleReclaimPublishFailure(
  store: ReviewJobStore,
  api: ReviewApi,
  row: ReviewJobRecord,
  err: unknown,
  logger: (message: string) => void,
  scope: "review" | "worker"
): Promise<void> {
  const publishError = errorMessage(err);
  logger(`reclaim-publish failed ${row.jobKey}: ${publishError}`);
  if (row.leasedBy == null) {
    logger(`reclaim expire failed ${row.jobKey}: cannot expire lease for job ${row.id}`);
    return;
  }
  const token = row.leasedBy;
  let permanent = isGonePublishError(err);
  if (!permanent && scope === "review") {
    try {
      permanent = await isPermanentReclaimPublishFailure(api, row, err, logger);
    } catch {
      permanent = false;
    }
  }
  if (permanent) {
    try {
      await store.markPublished(row.id, token, { state: "failed", reason: publishError });
      logger(`reclaim-publish settled failed ${row.jobKey}: ${publishError}`);
    } catch (settleErr) {
      logger(`reclaim settle failed ${row.jobKey}: ${errorMessage(settleErr)}`);
    }
    return;
  }
  let failures = (row.reclaimPublishFailures ?? 0) + 1;
  try {
    failures = await store.recordReclaimPublishFailure(row.id, token, publishError);
  } catch (recordErr) {
    logger(`reclaim failure record failed ${row.jobKey}: ${errorMessage(recordErr)}`);
  }
  if (failures >= RECLAIM_PUBLISH_MAX_FAILURES) {
    try {
      await store.markPublished(row.id, token, { state: "failed", reason: publishError });
      logger(`reclaim-publish settled failed ${row.jobKey} after ${failures} failures: ${publishError}`);
    } catch (settleErr) {
      logger(`reclaim settle failed ${row.jobKey}: ${errorMessage(settleErr)}`);
    }
    return;
  }
  try {
    await store.expireLease(row.id, token);
  } catch (expireErr) {
    logger(`reclaim expire failed ${row.jobKey}: ${errorMessage(expireErr)}`);
  }
}
