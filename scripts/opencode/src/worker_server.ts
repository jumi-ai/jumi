import { hostname } from "node:os";
import { scrubSecretEnv } from "./config.ts";
import { meterWebhook, renderProcessMetrics } from "./control_metrics.ts";
import { createForge } from "./forge.ts";
import { handleGithubWebhook } from "./github_webhook.ts";
import { ensureOpenCodeWellKnownAuth } from "./opencode_auth.ts";
import type { ReviewQueue } from "./queue.ts";
import { createPgReviewJobStore, QUEUE_POLL_MS, type ReviewJobStore } from "./review_jobs.ts";
import { installProcessShutdown } from "./shutdown.ts";
import type { IssueJob } from "./types.ts";
import { verifyGiteaSignature } from "./webhook.ts";
import {
  abortIssueQueue,
  createIssueQueue,
  handleIssueCancel,
  processWorkerTick,
  reclaimExpiredWorkerJobs,
  type WorkerQueueLike,
} from "./worker.ts";
import type { WorkerConfig } from "./worker_config.ts";
import { loadWorkerConfig } from "./worker_config.ts";
import { type HandleWorkerWebhookDeps, handleWorkerWebhookEvent } from "./worker_webhook.ts";
import { adoptOrphanXaiSibling } from "./xai_auth.ts";

export {
  isFollowUpWebhookEvent,
  isIssuesWebhookEvent,
  isPullAssignWebhookEvent,
  isPushWebhookEvent,
  isWorkerWebhookEvent,
  isWorkflowJobWebhookEvent,
} from "./worker_webhook.ts";

function log(message: string) {
  console.log(`[worker] ${message}`);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authMatches(actual: string | null, expected?: string): boolean {
  if (!expected) return true;
  return actual === expected || actual === `Bearer ${expected}`;
}

export interface WorkerFetchHandlerDeps extends HandleWorkerWebhookDeps {
  queue: WorkerQueueLike;
}

export function createWorkerFetchHandler(config: WorkerConfig, deps: WorkerFetchHandlerDeps) {
  const logger = deps.logger ?? log;
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (url.pathname === "/metrics") {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" });
      return new Response(renderProcessMetrics(), {
        status: 200,
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    if (url.pathname === "/webhooks/github") {
      return meterWebhook(
        request.headers.get("x-github-event"),
        handleGithubWebhook(request, config, {
          worker: { queue: deps.queue, api: deps.api, cancel: deps.cancel, logger, sits: deps.sits },
          logger,
        })
      );
    }
    if (url.pathname !== "/webhooks/gitea") return json(404, { error: "not found" });
    const event = request.headers.get("x-gitea-event") || request.headers.get("x-gitea-event-type") || "unknown";
    return meterWebhook(event, handleGiteaWebhook());

    async function handleGiteaWebhook(): Promise<Response> {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      if (!request.headers.get("content-type")?.includes("application/json")) {
        return json(415, { error: "expected application/json" });
      }
      if (!authMatches(request.headers.get("authorization"), config.webhookAuthToken)) {
        return json(401, { error: "invalid authorization header" });
      }

      const rawBody = new Uint8Array(await request.arrayBuffer());
      if (rawBody.byteLength > config.maxWebhookBytes) {
        return json(413, { error: "webhook payload too large" });
      }
      const signatureOk = await verifyGiteaSignature(
        rawBody,
        config.webhookSecret,
        request.headers.get("x-gitea-signature")
      );
      if (!signatureOk) return json(401, { error: "invalid signature" });

      return handleWorkerWebhookEvent(
        rawBody,
        request.headers.get("x-gitea-event"),
        request.headers.get("x-gitea-event-type"),
        request.headers.get("x-gitea-delivery") ?? crypto.randomUUID(),
        {
          giteaUrl: config.giteaUrl,
          allowedOrgs: config.allowedOrgs,
          allowedRepos: config.allowedRepos,
          botUsername: config.botUsername,
          followupIgnoreLogins: config.followupIgnoreLogins,
        },
        { queue: deps.queue, api: deps.api, cancel: deps.cancel, logger, sits: deps.sits }
      );
    }
  };
}

function workerId(): string {
  return `worker-${hostname()}-${process.pid}-${crypto.randomUUID()}`;
}

function bindAbort(signal: AbortSignal | undefined, fn: () => void): void {
  if (!signal) return;
  if (signal.aborted) {
    fn();
    return;
  }
  signal.addEventListener("abort", fn, { once: true });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true }
    );
  });
}

async function main() {
  const config = loadWorkerConfig();
  scrubSecretEnv();
  const shutdown = new AbortController();
  installProcessShutdown(shutdown, log);
  await adoptOrphanXaiSibling(config.home, log).catch((err) =>
    log(`xAI sibling adoption failed: ${err instanceof Error ? err.message : String(err)}`)
  );
  await ensureOpenCodeWellKnownAuth({
    home: config.home,
    url: config.opencodeWellKnownUrl,
    key: config.opencodeWellKnownKey,
    token: config.opencodeWellKnownToken,
    logger: log,
  });
  const api = createForge(config);
  const store: ReviewJobStore | undefined = config.databaseUrl
    ? await createPgReviewJobStore(config.databaseUrl)
    : undefined;
  const skipLatches = store?.skipLatches;
  const ramQueue: ReviewQueue<IssueJob> | undefined = store
    ? undefined
    : createIssueQueue(config, api, log, skipLatches);
  const aborts = new Map<string, AbortController>();
  const pids = new Map<string, number>();
  const queue: WorkerQueueLike = store ? { enqueue: (job) => store.enqueueIssue(job) } : ramQueue!;
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createWorkerFetchHandler(config, {
      queue,
      api,
      sits: store?.sits,
      cancel: (owner, repo, issueNumber) =>
        handleIssueCancel(config, api, owner, repo, issueNumber, ramQueue, store, aborts, pids, skipLatches),
    }),
  });

  if (ramQueue) bindAbort(shutdown.signal, () => abortIssueQueue(ramQueue));

  if (store) {
    const leasedBy = workerId();
    const run = async () => {
      while (!shutdown.signal.aborted) {
        try {
          await reclaimExpiredWorkerJobs(store, config.maxJobAttempts, log);
          const result = await processWorkerTick(
            store,
            config,
            api,
            leasedBy,
            { abortSignal: shutdown.signal },
            log,
            aborts,
            pids
          );
          if (result === "idle") await sleep(QUEUE_POLL_MS, shutdown.signal);
        } catch (err) {
          if (shutdown.signal.aborted) return;
          log(`worker tick failed: ${err instanceof Error ? err.message : String(err)}`);
          await sleep(QUEUE_POLL_MS, shutdown.signal).catch(() => undefined);
        }
      }
    };
    void run();
  }

  log(
    `listening on ${server.hostname}:${server.port} ${
      store ? "ledger=postgres" : "ledger=none (DATABASE_URL unset; local/dev in-process queue, no ledger tick)"
    }`
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[worker] Fatal error:", err);
    process.exit(1);
  });
}
