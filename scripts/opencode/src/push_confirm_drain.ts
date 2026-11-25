import type { ServiceConfig } from "./config.ts";
import { logDiagnostic } from "./diagnostics.ts";
import type { ReviewApi } from "./ports.ts";
import { pushConfirmExhaustedMessage } from "./push_confirm.ts";
import { enqueueReviewWithCiGate } from "./review_gate.ts";
import { HEARTBEAT_MS, makeReclaimOwner, type ReviewJobStore } from "./review_jobs.ts";
import { upsertStickyComment } from "./sticky_comment.ts";
import { errorMessage } from "./util/error.ts";
import { redactGitSecrets } from "./workspace.ts";

const PUSH_CONFIRM_NOTE_MARKER = "<!-- jumi-push-confirm -->";

const DRAIN_LIMIT = 50;

function redactPushConfirmError(config: ServiceConfig, err: unknown): string {
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

function isNotFoundError(err: unknown): boolean {
  return /→ 404\b/.test(errorMessage(err));
}

function exhaustedNote(expectedSha: string, lastError: string | null): string {
  const detail = (lastError ?? "").trim();
  if (detail && detail !== pushConfirmExhaustedMessage(expectedSha)) {
    return `Jumi could not confirm its push to this pull request (${pushConfirmExhaustedMessage(expectedSha)}): ${detail.slice(0, 300)}. Please push or sync the branch to review the current head.`;
  }
  return `Jumi pushed to this pull request but ${pushConfirmExhaustedMessage(expectedSha)}. Please push or sync the branch to review the current head.`;
}

interface ClaimedPushRow {
  owner: string;
  repo: string;
  prNumber: number;
  generation: number;
  expectedSha: string;
  branch: string;
  retryMarker: string | null;
  nextAttemptAtMs: number | null;
}

type RowOutcome = "completed" | "retried" | "blocked";

export async function drainPushConfirm(
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
    let rows: Awaited<ReturnType<ReviewJobStore["pushConfirm"]["claimDue"]>>;
    try {
      rows = await store.pushConfirm.claimDue(token, config.leaseMs, 1, nowMs);
    } catch (err) {
      logger(`push confirm claim failed: ${errorMessage(err)}`);
      return summary;
    }
    const row = rows[0];
    if (!row) return summary;
    summary.claimed += 1;
    const outcome = await processPushRow(store, api, config, logger, row, token, opts?.nowMs);
    if (outcome === "completed") summary.completed += 1;
    else if (outcome === "blocked") summary.blocked += 1;
    else summary.retried += 1;
  }
  return summary;
}

async function processPushRow(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void,
  row: ClaimedPushRow,
  token: string,
  nowMsOverride?: number
): Promise<RowOutcome> {
  const coords = `${row.owner}/${row.repo}#${row.prNumber}`;
  const pushConfirm = store.pushConfirm;
  const now = (): number => nowMsOverride ?? Date.now();
  const heartbeat = setInterval(() => {
    void pushConfirm
      .renew(row.owner, row.repo, row.prNumber, token, row.generation, config.leaseMs, now())
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  const stopHeartbeat = (): void => {
    clearInterval(heartbeat);
  };
  try {
    let pr: Awaited<ReturnType<ReviewApi["getPR"]>>;
    try {
      pr = await api.getPR(row.owner, row.repo, row.prNumber);
    } catch (err) {
      stopHeartbeat();
      if (isNotFoundError(err)) {
        const settled = await pushConfirm.complete(row.owner, row.repo, row.prNumber, token, row.generation, now());
        if (settled === "deleted") {
          logger(`push confirm ${coords} PR not found, obligation dropped`);
          return "completed";
        }
        logger(`push confirm ${settled} ${coords} generation=${row.generation}`);
        return "retried";
      }
      await settlePushFail(store, api, config, logger, row, token, redactPushConfirmError(config, err), nowMsOverride);
      return "retried";
    }
    stopHeartbeat();
    if (pr.merged === true || pr.state === "closed") {
      const settled = await pushConfirm.complete(row.owner, row.repo, row.prNumber, token, row.generation, now());
      if (settled === "deleted") {
        logger(`push confirm ${coords} PR closed, obligation dropped`);
        return "completed";
      }
      logger(`push confirm ${settled} ${coords} generation=${row.generation}`);
      return "retried";
    }
    const headSha = pr.head?.sha ?? "";
    if (headSha === row.expectedSha) {
      const receivedAt = new Date(now()).toISOString();
      const job = {
        delivery: `push-confirm:${row.generation}:${row.expectedSha}`,
        owner: row.owner,
        repo: row.repo,
        prNumber: row.prNumber,
        action: "synchronize",
        headSha: row.expectedSha,
        receivedAt,
        ...(typeof pr.updated_at === "string" && pr.updated_at ? { prUpdatedAt: pr.updated_at } : {}),
      };
      try {
        const result = await enqueueReviewWithCiGate(store, job, {
          ciApi: api as never,
          home: config.home,
          logger,
        });
        logger(
          `push confirm ${coords}@${row.expectedSha.slice(0, 12)} ${result.queued ? "queued" : "deduped"} ${result.key}`
        );
      } catch (err) {
        await settlePushFail(
          store,
          api,
          config,
          logger,
          row,
          token,
          redactPushConfirmError(config, err),
          nowMsOverride
        );
        return "retried";
      }
      const settled = await pushConfirm.complete(row.owner, row.repo, row.prNumber, token, row.generation, now());
      if (settled === "deleted") return "completed";
      logger(`push confirm ${settled} ${coords} generation=${row.generation}`);
      return "retried";
    }
    const message = pushConfirmExhaustedMessage(row.expectedSha);
    const settled = await pushConfirm.fail(row.owner, row.repo, row.prNumber, token, row.generation, message, now());
    if (settled === "exhausted") {
      logDiagnostic(logger, "push_confirm_exhausted", {
        owner: row.owner,
        repo: row.repo,
        pr: row.prNumber,
        generation: row.generation,
        expected: row.expectedSha,
        actual: headSha,
        reason: message,
      });
      await postExhaustedNote(api, config, logger, row, message);
      try {
        await store.sits.remember(row.owner, row.repo, row.prNumber, "push-unregistered");
      } catch (err) {
        logger(`push confirm sit failed ${coords}: ${errorMessage(err)}`);
      }
      return "blocked";
    }
    if (settled === "rearmed" || settled === "lost") {
      logger(
        `push confirm ${settled} ${coords} generation=${row.generation} expected=${row.expectedSha.slice(0, 12)} actual=${headSha.slice(0, 12)}`
      );
    } else {
      logger(
        `push confirm mismatch ${coords} expected=${row.expectedSha.slice(0, 12)} actual=${headSha.slice(0, 12)}, retrying`
      );
    }
    return "retried";
  } catch (err) {
    stopHeartbeat();
    logger(`push confirm failed ${coords}: ${errorMessage(err)}`);
    try {
      await settlePushFail(store, api, config, logger, row, token, redactPushConfirmError(config, err), nowMsOverride);
    } catch {
      // Best-effort: the row keeps its lease and is re-processed next tick.
    }
    return "retried";
  } finally {
    stopHeartbeat();
  }
}

async function settlePushFail(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void,
  row: ClaimedPushRow,
  token: string,
  message: string,
  nowMsOverride?: number
): Promise<void> {
  const coords = `${row.owner}/${row.repo}#${row.prNumber}`;
  const settled = await store.pushConfirm.fail(
    row.owner,
    row.repo,
    row.prNumber,
    token,
    row.generation,
    message,
    nowMsOverride ?? Date.now()
  );
  if (settled === "exhausted") {
    logDiagnostic(logger, "push_confirm_exhausted", {
      owner: row.owner,
      repo: row.repo,
      pr: row.prNumber,
      generation: row.generation,
      expected: row.expectedSha,
      reason: message,
    });
    await postExhaustedNote(api, config, logger, row, message);
    try {
      await store.sits.remember(row.owner, row.repo, row.prNumber, "push-unregistered");
    } catch (err) {
      logger(`push confirm sit failed ${coords}: ${errorMessage(err)}`);
    }
  } else if (settled === "rearmed" || settled === "lost") {
    logger(`push confirm ${settled} ${coords} generation=${row.generation}`);
  }
}

async function postExhaustedNote(
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void,
  row: ClaimedPushRow,
  lastError: string
): Promise<void> {
  try {
    await upsertStickyComment(
      api,
      row.owner,
      row.repo,
      row.prNumber,
      config.botUsername,
      PUSH_CONFIRM_NOTE_MARKER,
      exhaustedNote(row.expectedSha, lastError)
    );
  } catch (err) {
    logger(`push confirm note failed ${row.owner}/${row.repo}#${row.prNumber}: ${errorMessage(err)}`);
  }
}
