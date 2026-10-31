import type { EngineResult } from "./engine.ts";
import type { JobKind } from "./review_jobs.ts";
import { renderTokenExporterHealth, renderTokenMetrics } from "./token_metrics.ts";

export const WEBHOOK_RESULTS = ["accepted", "skipped", "hmac", "too large", "unavailable", "ping"] as const;
export type WebhookResult = (typeof WEBHOOK_RESULTS)[number];

export const WEBHOOK_EVENTS = [
  "check_run",
  "issue_assign",
  "issue_comment",
  "issues",
  "ping",
  "pull_request",
  "pull_request_assign",
  "pull_request_comment",
  "pull_request_rejected",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_rejected",
  "push",
  "status",
  "workflow_job",
  "workflow_run",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const WEBHOOK_EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

export const JOB_RESULTS = ["succeeded", "skipped", "failed"] as const;
export type JobResult = (typeof JOB_RESULTS)[number];

export const OPENCODE_EXIT_CLASSES = ["ok", "143", "timeout", "infra", "incomplete", "auth", "quota"] as const;
export type OpenCodeExitClass = (typeof OPENCODE_EXIT_CLASSES)[number];

export const RUN_KINDS: readonly JobKind[] = ["review", "implement", "follow-up", "conflict"];

export const DURATION_BUCKETS_SECONDS = [15, 30, 60, 120, 300, 600, 1200, 1800, 3600] as const;

const webhookCounts = new Map<string, number>();
const jobCounts = new Map<string, number>();
const exitCounts = new Map<string, number>();
const durationSum = new Map<string, number>();
const durationCount = new Map<string, number>();
const durationBuckets = new Map<string, number>();

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function add(map: Map<string, number>, key: string, value = 1): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function webhookKey(event: string, result: WebhookResult): string {
  return `${event}\0${result}`;
}

function kindResultKey(kind: string, result: string): string {
  return `${kind}\0${result}`;
}

function bucketKey(kind: string, result: string, le: string): string {
  return `${kind}\0${result}\0${le}`;
}

export function resetControlMetricsForTests(): void {
  webhookCounts.clear();
  jobCounts.clear();
  exitCounts.clear();
  durationSum.clear();
  durationCount.clear();
  durationBuckets.clear();
}

export function classifyOpenCodeExit(result: {
  status: string;
  exitCode?: number | null;
  infra?: boolean;
  auth?: boolean;
  quota?: string | null;
  hopped?: boolean;
}): OpenCodeExitClass {
  if (result.status === "timeout") return "timeout";
  if (result.infra === true) return "infra";
  if (result.exitCode === 143) {
    if (result.quota != null && result.hopped === true) return "quota";
    return "143";
  }
  if (result.auth === true && result.quota == null) return "auth";
  if (result.quota != null) return "quota";
  if (result.status === "ok") return "ok";
  return "incomplete";
}

export function webhookEventLabel(event: string | null | undefined): string {
  return event && WEBHOOK_EVENT_SET.has(event) ? event : "unknown";
}

export function recordWebhook(event: string | null | undefined, result: WebhookResult): void {
  add(webhookCounts, webhookKey(webhookEventLabel(event), result));
}

export async function meterWebhook(event: string | null, response: Response | Promise<Response>): Promise<Response> {
  const resolved = await response;
  const result = await webhookResultFromResponse(resolved);
  if (result) recordWebhook(event, result);
  return resolved;
}

async function webhookResultFromResponse(response: Response): Promise<WebhookResult | undefined> {
  if (response.status === 413) return "too large";
  if (response.status === 503) return "unavailable";
  if (response.status === 200) return "ping";
  if (response.status === 401) {
    try {
      const body = (await response.clone().json()) as { error?: unknown };
      if (body?.error === "invalid signature") return "hmac";
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (response.status !== 202) return undefined;
  try {
    const body = (await response.clone().json()) as { skipped?: unknown };
    if (body && typeof body === "object" && "skipped" in body) return "skipped";
  } catch {
    return "accepted";
  }
  return "accepted";
}

export function recordJobCompleted(kind: string, result: JobResult): void {
  add(jobCounts, kindResultKey(kind, result));
}

export function shouldDeferQuotaExit(result: {
  status: string;
  exitCode?: number | null;
  infra?: boolean;
  quota?: string | null;
  hopped?: boolean;
}): boolean {
  return result.quota != null && classifyOpenCodeExit(result) === "143";
}

export function recordOpenCodeRun(kind: string, result: EngineResult & { hopped?: boolean }): void {
  const exitClass = classifyOpenCodeExit(result);
  addExit(kind, exitClass, result.durationMs);
}

export function observeEngineRun(
  opts: { abortSignal?: AbortSignal; deferQuotaExit?: boolean; trace?: { kind?: string } },
  result: EngineResult
): EngineResult {
  if (opts.abortSignal?.aborted) return result;
  if (opts.deferQuotaExit && shouldDeferQuotaExit(result)) return result;
  recordOpenCodeRun(opts.trace?.kind ?? "review", result);
  return result;
}

function addExit(kind: string, exitClass: OpenCodeExitClass, durationMs: number | undefined): void {
  const countKey = kindResultKey(kind, exitClass);
  add(exitCounts, countKey);
  if (durationMs == null || durationMs < 0) return;
  const seconds = durationMs / 1000;
  const key = kindResultKey(kind, exitClass);
  add(durationSum, key, seconds);
  add(durationCount, key);
  for (const le of DURATION_BUCKETS_SECONDS) {
    if (seconds <= le) add(durationBuckets, bucketKey(kind, exitClass, String(le)));
  }
  add(durationBuckets, bucketKey(kind, exitClass, "+Inf"));
}

export function renderWebhookMetrics(): string {
  const lines = [
    "# HELP jumi_webhooks_total Webhook deliveries by forge event and result",
    "# TYPE jumi_webhooks_total counter",
  ];
  const entries = [...webhookCounts.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of entries) {
    const [event, result] = key.split("\0") as [string, WebhookResult];
    lines.push(`jumi_webhooks_total{event="${escapeLabel(event)}",result="${escapeLabel(result)}"} ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderRunMetrics(): string {
  const lines = [
    "# HELP jumi_jobs_completed_total Jobs completed by this process",
    "# TYPE jumi_jobs_completed_total counter",
  ];
  for (const kind of RUN_KINDS) {
    for (const result of JOB_RESULTS) {
      const value = jobCounts.get(kindResultKey(kind, result)) ?? 0;
      lines.push(`jumi_jobs_completed_total{kind="${kind}",result="${result}"} ${value}`);
    }
  }

  lines.push("# HELP jumi_job_duration_seconds OpenCode run duration in seconds");
  lines.push("# TYPE jumi_job_duration_seconds histogram");
  const durationKeys = [...durationCount.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of durationKeys) {
    const [kind, result] = key.split("\0") as [string, string];
    const labels = `kind="${escapeLabel(kind)}",result="${escapeLabel(result)}"`;
    for (const le of DURATION_BUCKETS_SECONDS) {
      const value = durationBuckets.get(bucketKey(kind, result, String(le))) ?? 0;
      lines.push(`jumi_job_duration_seconds_bucket{${labels},le="${le}"} ${value}`);
    }
    lines.push(
      `jumi_job_duration_seconds_bucket{${labels},le="+Inf"} ${durationBuckets.get(bucketKey(kind, result, "+Inf")) ?? 0}`
    );
    lines.push(`jumi_job_duration_seconds_sum{${labels}} ${durationSum.get(key) ?? 0}`);
    lines.push(`jumi_job_duration_seconds_count{${labels}} ${durationCount.get(key) ?? 0}`);
  }

  lines.push("# HELP jumi_opencode_exits_total OpenCode exits by kind and class");
  lines.push("# TYPE jumi_opencode_exits_total counter");
  for (const kind of RUN_KINDS) {
    for (const exitClass of OPENCODE_EXIT_CLASSES) {
      const value = exitCounts.get(kindResultKey(kind, exitClass)) ?? 0;
      lines.push(`jumi_opencode_exits_total{kind="${kind}",class="${exitClass}"} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderProcessMetrics(): string {
  return `${renderTokenMetrics()}${renderRunMetrics()}`;
}

/**
 * What engine/worker pods serve on `/metrics`. Exporter health gauges only:
 * the durable `ai_tokens_*` / `ai_sessions` / `jumi_jobs_completed_total` /
 * `jumi_job_duration_seconds_*` / `jumi_opencode_exits_total` series now come
 * from the router's ledger export, and serving the same names here would
 * double totals for anyone scraping every pod. Scrape the router for totals.
 */
export function renderEphemeralMetrics(): string {
  return renderTokenExporterHealth();
}
