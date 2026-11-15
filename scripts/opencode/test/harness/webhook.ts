import type { ReviewQueueLike } from "../../src/server.ts";
import type { IssueJob, ReviewJob } from "../../src/types.ts";
import type { WorkerQueueLike } from "../../src/worker.ts";
import { encodeJson, signBody } from "../fixtures.ts";

export interface WebhookPostOptions extends RequestInit {
  event?: string;
  eventType?: string;
  secret?: string;
  raw?: Uint8Array;
  delivery?: string;
  url?: string;
  defaultEvent?: string;
}

/**
 * Shared signed-webhook POST. `defaultEvent` + `url` carry each call site's
 * old defaults; `raw`/`delivery` overrides exist for the sites that had them.
 * The event-header rule is the `ci_webhook`/`push_webhook` one (explicit event
 * wins, otherwise the default applies unless an `eventType` override is set):
 * every migrated call site either passes `event` explicitly or leaves both
 * unset, so the always-set variants behave identically through this helper.
 */
export async function webhookPost(
  body: unknown,
  opts: WebhookPostOptions & { defaultEvent: string; url: string }
): Promise<Request> {
  const raw = opts.raw ?? encodeJson(body);
  const secret = opts.secret ?? "webhook-secret";
  const signature = await signBody(raw, secret);
  const headers = new Headers(opts.headers);
  headers.set("content-type", "application/json");
  headers.set("x-gitea-signature", signature);
  if (opts.event !== undefined) headers.set("x-gitea-event", opts.event);
  else if (!opts.eventType) headers.set("x-gitea-event", opts.defaultEvent);
  if (opts.eventType) headers.set("x-gitea-event-type", opts.eventType);
  headers.set("x-gitea-delivery", opts.delivery ?? "delivery-1");
  return new Request(opts.url, {
    method: opts.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

export type WebhookOverrides = RequestInit & {
  event?: string;
  eventType?: string;
  secret?: string;
  raw?: Uint8Array;
  delivery?: string;
};

const WORKER_WEBHOOK_URL = "https://worker.test/webhooks/gitea";
const REVIEWER_WEBHOOK_URL = "https://reviewer.test/webhooks/gitea";

/** Worker webhook with the `ci_webhook` default event (`workflow_job`). */
export function workerWorkflowJobRequest(body: unknown, overrides: WebhookOverrides = {}): Promise<Request> {
  return webhookPost(body, { defaultEvent: "workflow_job", url: WORKER_WEBHOOK_URL, ...overrides });
}

/** Worker webhook with the `followup_webhook` default event (`issue_comment`). */
export function workerIssueCommentRequest(body: unknown, overrides: WebhookOverrides = {}): Promise<Request> {
  return webhookPost(body, { defaultEvent: "issue_comment", url: WORKER_WEBHOOK_URL, ...overrides });
}

/** Worker webhook with the `push_webhook` default event (`push`). */
export function workerPushRequest(body: unknown, overrides: WebhookOverrides = {}): Promise<Request> {
  return webhookPost(body, { defaultEvent: "push", url: WORKER_WEBHOOK_URL, ...overrides });
}

/** Worker webhook with the `worker_server` default event (`issues`). */
export function workerIssuesRequest(body: unknown, overrides: WebhookOverrides = {}): Promise<Request> {
  return webhookPost(body, { defaultEvent: "issues", url: WORKER_WEBHOOK_URL, ...overrides });
}

/** Reviewer webhook with the `server` default event (`pull_request`). */
export function reviewerRequest(body: unknown, overrides: WebhookOverrides = {}): Promise<Request> {
  return webhookPost(body, { defaultEvent: "pull_request", url: REVIEWER_WEBHOOK_URL, ...overrides });
}

/** Worker-queue double used by the worker webhook tests. */
export function makeWorkerQueue(): WorkerQueueLike & { jobs: IssueJob[] } {
  const jobs: IssueJob[] = [];
  return {
    jobs,
    enqueue(job) {
      jobs.push(job);
      return { key: `${job.owner}/${job.repo}#${job.issueNumber}`, queued: true };
    },
  };
}

/** Review-queue double used by the reviewer webhook tests. */
export function makeReviewQueue(): ReviewQueueLike & { jobs: ReviewJob[] } {
  const jobs: ReviewJob[] = [];
  return {
    jobs,
    enqueue(job) {
      jobs.push(job);
      return { key: `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`, queued: true };
    },
  };
}

/** Legacy alias: every `makeQueue` returning issue jobs was a worker queue. */
export const makeQueue = makeWorkerQueue;
