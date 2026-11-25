import { AUTOMERGE_NOTE_MARKER } from "./automerge.ts";
import { reconcileAutomergeCancellation } from "./automerge_decision.ts";
import type { ServiceConfig } from "./config.ts";
import { logDiagnostic } from "./diagnostics.ts";
import type { ReviewApi } from "./ports.ts";
import {
  HEARTBEAT_MS,
  makeReclaimOwner,
  type ReviewJobStore,
} from "./review_jobs.ts";
import { upsertStickyComment } from "./sticky_comment.ts";
import { errorMessage } from "./util/error.ts";
import { redactGitSecrets } from "./workspace.ts";

/**
 * Cancellation-only drain for durable automerge-reconcile obligations
 * (issue #837). Runs inside the router's existing reclaim tick: claims due
 * rows, re-reads the latest PR labels and current repo policy immediately
 * before any cancel, cancels only when fresh state still requires it, and
 * settles the row. Never schedules. Ships inactive: nothing writes rows
 * until the admission ticket, so this drain is a no-op on its own.
 *
 * Honest limit: the native forge cancel is not exactly-once and cannot be
 * fenced globally against a concurrent enable. The guarantees are the
 * latest-state re-read immediately before the cancel call, the lease token,
 * and the generation fence; a response lost after a successful cancel leaves
 * the row, and the retry reads `absent`, which is a harmless success.
 */

const DRAIN_LIMIT = 50;

function redactReconcileError(config: ServiceConfig, err: unknown): string {
  const secrets = [
    config.giteaToken,
    config.githubAppPrivateKey,
    config.webhookSecret,
    config.githubWebhookSecret,
    config.webhookAuthToken,
    config.boardPeerToken,
    config.boardMcpToken,
    config.boardMcpKickToken,
  ];
  return redactGitSecrets(errorMessage(err), secrets).slice(0, 1000);
}

/** Attempt count carried by an infra-retry marker (`infra-retry:<n>:<ts>`). */
function attemptsOfRetryMarker(retryMarker: string | null): number | undefined {
  if (!retryMarker) return undefined;
  const match = /^infra-retry:(\d+):/.exec(retryMarker);
  if (!match?.[1]) return undefined;
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : undefined;
}

function exhaustedNote(): string {
  return (
    `Jumi could not verify auto-merge cancellation on this pull request and will not retry automatically. ` +
    `Please check or cancel auto-merge manually.`
  );
}

interface ClaimedReconcileRow {
  owner: string;
  repo: string;
  prNumber: number;
  generation: number;
  retryMarker: string | null;
  nextAttemptAtMs: number | null;
}

type RowOutcome = "completed" | "retried" | "blocked";

/**
 * Drain at most `limit` due automerge-reconcile obligations. Each row is
 * claimed with a fresh owner just before processing; the lease is renewed
 * while awaiting forge reads, and the cancel call itself is fenced on a
 * verify/renew immediately before dispatch, so a lost or expired owner
 * never dispatches a cancel. `removed`/`absent`/`not-needed` complete the
 * row, `retry` (or a throw) fails it with a redacted message, and
 * `unsupported` blocks it visibly.
 */
export async function drainAutomergeReconcile(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void = console.log,
  limit = DRAIN_LIMIT,
  opts?: { nowMs?: number }
): Promise<{ claimed: number; completed: number; retried: number; blocked: number }> {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : DRAIN_LIMIT;
  const summary = { claimed: 0, completed: 0, retried: 0, blocked: 0 };
  for (let i = 0; i < cap; i += 1) {
    const token = makeReclaimOwner();
    const nowMs = opts?.nowMs ?? Date.now();
    let rows: Awaited<ReturnType<ReviewJobStore["automergeReconcile"]["claimDue"]>>;
    try {
      rows = await store.automergeReconcile.claimDue(token, config.leaseMs, 1, nowMs);
    } catch (err) {
      logger(`automerge reconcile claim failed: ${errorMessage(err)}`);
      return summary;
    }
    const row = rows[0];
    if (!row) return summary;
    summary.claimed += 1;
    const outcome = await processReconcileRow(store, api, config, logger, row, token, opts?.nowMs);
    if (outcome === "completed") summary.completed += 1;
    else if (outcome === "blocked") summary.blocked += 1;
    else summary.retried += 1;
  }
  return summary;
}

async function processReconcileRow(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void,
  row: ClaimedReconcileRow,
  token: string,
  nowMsOverride?: number
): Promise<RowOutcome> {
  const coords = `${row.owner}/${row.repo}#${row.prNumber}`;
  const reconcile = store.automergeReconcile;
  const now = (): number => nowMsOverride ?? Date.now();
  // Heartbeat while awaiting forge reads: a slow healthy read keeps
  // ownership instead of silently losing it mid-row. Stopped before the
  // pre-cancel verify so an expired lease is observed, never masked.
  const heartbeat = setInterval(() => {
    void reconcile
      .renew(row.owner, row.repo, row.prNumber, token, row.generation, config.leaseMs, now())
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  const stopHeartbeat = (): void => {
    clearInterval(heartbeat);
  };
  try {
    let result: Awaited<ReturnType<typeof reconcileAutomergeCancellation>>;
    try {
      result = await reconcileAutomergeCancellation({
        api,
        forgeKind: config.forge,
        owner: row.owner,
        repo: row.repo,
        prNumber: row.prNumber,
        automergeRepos: config.automergeRepos,
        automergeEnabled: config.automergeEnabled,
        trustedSenderLogins: config.trustedSenderLogins,
        botUsername: config.botUsername,
        log: logger,
        // Fence a not-yet-dispatched cancel on live ownership: renew (and
        // verify the generation) immediately before the cancel call. A lost
        // or expired lease forbids the dispatch; the row is re-processed
        // next tick against fresh state.
        beforeCancel: async () => {
          stopHeartbeat();
          try {
            return await reconcile.renew(
              row.owner,
              row.repo,
              row.prNumber,
              token,
              row.generation,
              config.leaseMs,
              now()
            );
          } catch {
            return false;
          }
        },
      });
    } catch (err) {
      stopHeartbeat();
      await settleReconcileFail(
        store,
        api,
        config,
        logger,
        row,
        token,
        redactReconcileError(config, err),
        nowMsOverride
      );
      return "retried";
    }
    stopHeartbeat();
    if (result === "removed" || result === "absent" || result === "not-needed") {
      const settled = await reconcile.complete(
        row.owner,
        row.repo,
        row.prNumber,
        token,
        row.generation,
        now()
      );
      if (settled === "deleted") return "completed";
      logger(`automerge reconcile ${settled} ${coords} generation=${row.generation}`);
      return "retried";
    }
    if (result === "unsupported") {
      const diagnostic = `forge does not expose auto-merge cancellation for ${coords}`;
      const settled = await reconcile.block(
        row.owner,
        row.repo,
        row.prNumber,
        token,
        row.generation,
        diagnostic,
        now()
      );
      if (settled !== "exhausted") {
        logger(`automerge reconcile ${settled} ${coords} generation=${row.generation}`);
        return "retried";
      }
      logDiagnostic(logger, "automerge_reconcile_exhausted", {
        owner: row.owner,
        repo: row.repo,
        pr: row.prNumber,
        generation: row.generation,
        reason: diagnostic,
      });
      await postExhaustedNote(api, config, logger, row);
      return "blocked";
    }
    if (result === "lost") {
      logger(`automerge reconcile lost ${coords} generation=${row.generation}: lease not held before cancel`);
      return "retried";
    }
    await settleReconcileFail(
      store,
      api,
      config,
      logger,
      row,
      token,
      `forge read or cancel failed for ${coords}`,
      nowMsOverride
    );
    return "retried";
  } catch (err) {
    stopHeartbeat();
    logger(`automerge reconcile failed ${coords}: ${errorMessage(err)}`);
    try {
      await settleReconcileFail(store, api, config, logger, row, token, redactReconcileError(config, err), nowMsOverride);
    } catch {
      // Best-effort: the row keeps its lease and is re-processed next tick.
    }
    return "retried";
  } finally {
    stopHeartbeat();
  }
}

async function settleReconcileFail(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void,
  row: ClaimedReconcileRow,
  token: string,
  message: string,
  nowMsOverride?: number
): Promise<void> {
  const coords = `${row.owner}/${row.repo}#${row.prNumber}`;
  const settled = await store.automergeReconcile.fail(
    row.owner,
    row.repo,
    row.prNumber,
    token,
    row.generation,
    message,
    nowMsOverride ?? Date.now()
  );
  if (settled === "exhausted") {
    const fields: Record<string, string | number | null | undefined> = {
      owner: row.owner,
      repo: row.repo,
      pr: row.prNumber,
      generation: row.generation,
      reason: message,
    };
    const attempts = attemptsOfRetryMarker(row.retryMarker);
    if (attempts !== undefined) fields.attempts = attempts + 1;
    logDiagnostic(logger, "automerge_reconcile_exhausted", fields);
    await postExhaustedNote(api, config, logger, row);
  } else if (settled === "rearmed" || settled === "lost") {
    logger(`automerge reconcile ${settled} ${coords} generation=${row.generation}`);
  }
}

async function postExhaustedNote(
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void,
  row: ClaimedReconcileRow
): Promise<void> {
  try {
    await upsertStickyComment(
      api,
      row.owner,
      row.repo,
      row.prNumber,
      config.botUsername,
      AUTOMERGE_NOTE_MARKER,
      exhaustedNote()
    );
  } catch (err) {
    logger(`automerge reconcile note failed ${row.owner}/${row.repo}#${row.prNumber}: ${errorMessage(err)}`);
  }
}
