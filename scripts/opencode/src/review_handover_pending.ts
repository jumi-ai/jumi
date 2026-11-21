import type { ServiceConfig } from "./config.ts";
import { pickupPolicyForForge } from "./github_webhook.ts";
import { enqueueFollowUpFromReview } from "./handover.ts";
import type { ReviewApi, ReviewResult } from "./review.ts";
import type { ReviewJobStore } from "./review_jobs.ts";
import type { SqlClient } from "./sql_client.ts";
import { errorMessage } from "./util/error.ts";

const PENDING_HANDOVER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS review_handover_pending (
  review_job_id BIGINT PRIMARY KEY,
  published_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

interface PendingHandoverRow {
  reviewJobId: number;
  publishedStatus: string;
  createdAt: number;
}

function pendingStatuses(): ReadonlySet<string> {
  return new Set(["posted", "updated"]);
}

function getSql(store: ReviewJobStore): SqlClient | undefined {
  const sql = (store as unknown as { sql?: SqlClient }).sql;
  if (sql && typeof sql.unsafe === "function") return sql;
  return undefined;
}

function memoryPendings(store: ReviewJobStore): Map<number, PendingHandoverRow> {
  const holder = store as unknown as { __reviewHandoverPending?: Map<number, PendingHandoverRow> };
  // The one-shot proxy forwards property reads to its target, so the map is
  // shared between the proxy and the real store in the same process.
  if (!holder.__reviewHandoverPending) holder.__reviewHandoverPending = new Map();
  return holder.__reviewHandoverPending;
}

async function ensurePgTable(sql: SqlClient): Promise<void> {
  await sql.unsafe(PENDING_HANDOVER_SCHEMA_SQL);
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Record that the handover for a review job is still owed. Called before the
 * terminal transition so a crash after the verdict posts never loses the
 * obligation. Keyed idempotently by review job id: repeats keep the first
 * published status. Only `posted`/`updated` verdicts can hand over; anything
 * else is a no-op.
 */
export async function recordPendingHandover(
  store: ReviewJobStore,
  reviewJobId: number,
  publishedStatus: ReviewResult["status"]
): Promise<void> {
  if (!pendingStatuses().has(publishedStatus)) return;
  const sql = getSql(store);
  if (sql) {
    await ensurePgTable(sql);
    await sql.unsafe(
      `INSERT INTO review_handover_pending (review_job_id, published_status)
       VALUES ($1, $2)
       ON CONFLICT (review_job_id) DO NOTHING`,
      [reviewJobId, publishedStatus]
    );
    return;
  }
  const pendings = memoryPendings(store);
  if (!pendings.has(reviewJobId)) {
    pendings.set(reviewJobId, { reviewJobId, publishedStatus, createdAt: Date.now() });
  }
}

/** Drop a pending handover once its follow-up (or hold settlement) completed. */
export async function clearPendingHandover(store: ReviewJobStore, reviewJobId: number): Promise<void> {
  const sql = getSql(store);
  if (sql) {
    await ensurePgTable(sql);
    await sql.unsafe(`DELETE FROM review_handover_pending WHERE review_job_id = $1`, [reviewJobId]);
    return;
  }
  memoryPendings(store).delete(reviewJobId);
}

async function listPendingHandovers(store: ReviewJobStore, limit = 100): Promise<PendingHandoverRow[]> {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 100;
  const sql = getSql(store);
  if (sql) {
    await ensurePgTable(sql);
    const rows = asRows<{ review_job_id: unknown; published_status: unknown; created_at: unknown }>(
      await sql.unsafe(
        `SELECT review_job_id, published_status, created_at FROM review_handover_pending ORDER BY review_job_id ASC LIMIT $1`,
        [cap]
      )
    );
    return rows.map((row) => ({
      reviewJobId: Number(row.review_job_id),
      publishedStatus: String(row.published_status),
      createdAt: Date.parse(String(row.created_at)),
    }));
  }
  return [...memoryPendings(store).values()].sort((a, b) => a.reviewJobId - b.reviewJobId).slice(0, cap);
}

/**
 * Finish owed handovers without spawning the reviewer or posting another
 * review. Only terminal review rows are drained; leased/queued rows wait for
 * the normal reclaim path to settle them first. Every outcome that does not
 * throw (a queued follow-up or a settled hold/skip) clears the pending row,
 * so repeated resumption stays idempotent and no-follow-up cases produce
 * none. Failures keep the pending row for the next resumption.
 */
export async function resumePendingHandoffs(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void = console.log,
  limit = 50
): Promise<{ completed: number; failed: number }> {
  let pendings: PendingHandoverRow[];
  try {
    pendings = await listPendingHandovers(store, limit);
  } catch (err) {
    logger(`handoff resume list failed: ${errorMessage(err)}`);
    return { completed: 0, failed: 0 };
  }
  let completed = 0;
  let failed = 0;
  for (const pending of pendings) {
    try {
      const row = await store.get(pending.reviewJobId);
      if (!row) {
        await clearPendingHandover(store, pending.reviewJobId).catch(() => undefined);
        completed += 1;
        continue;
      }
      if (row.state === "queued" || row.state === "leased") continue;
      if (row.kind !== "review") {
        await clearPendingHandover(store, pending.reviewJobId).catch(() => undefined);
        completed += 1;
        continue;
      }
      const published = { status: pending.publishedStatus } as ReviewResult;
      const result = await enqueueFollowUpFromReview({
        store,
        api,
        row,
        ...pickupPolicyForForge(config.forge, config.botUsername),
        published,
        markdown: row.resultMarkdown,
        maxFollowupRounds: config.maxFollowupRounds,
        blockingQuestionAuthors: config.blockingQuestionAuthors,
        logger,
      });
      await clearPendingHandover(store, pending.reviewJobId);
      completed += 1;
      if (result?.queued) logger(`handoff resume follow-up ${result.key}`);
    } catch (err) {
      failed += 1;
      logger(`handoff resume failed review=${pending.reviewJobId}: ${errorMessage(err)}`);
    }
  }
  return { completed, failed };
}
