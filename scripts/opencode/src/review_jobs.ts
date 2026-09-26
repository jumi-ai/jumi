import { isCiLookupRetryMarker, isCiWaitSkipReason } from "./ci.ts";
import { isInfraRetryMarker } from "./infra.ts";
import type { EnqueueResult } from "./queue.ts";
import { isQuotaWaitMarker } from "./quota.ts";
import { isTerminalSkipReason, type PersistReviewResult, reviewJobKey } from "./review.ts";
import { MemoryRouterSitStore, PgRouterSitStore, ROUTER_SITS_SCHEMA_SQL, type RouterSitStore } from "./router_sits.ts";
import {
  ISSUE_SKIP_LATCHES_SCHEMA_SQL,
  MemorySkipLatchStore,
  PgSkipLatchStore,
  type SkipLatchStore,
} from "./skip_latches.ts";
import { createBunSqlClient, pgTextArrayLiteral, type SqlClient, wrapSqlError } from "./sql_client.ts";
import type { IssueJob, IssueJobTrigger, ReviewJob } from "./types.ts";

export {
  createBunSqlClient,
  isQueueUnavailable,
  pgTextArrayLiteral,
  QueueUnavailableError,
} from "./sql_client.ts";

export const REVIEW_JOB_STATES = ["queued", "leased", "succeeded", "skipped", "failed", "cancelled"] as const;
export type ReviewJobState = (typeof REVIEW_JOB_STATES)[number];

export const JOB_KINDS = ["review", "implement", "follow-up", "conflict"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const REVIEW_KIND: JobKind = "review";
export const WORKER_JOB_KINDS: readonly JobKind[] = ["implement", "follow-up", "conflict"];

export interface IssueJobPayload {
  issueNumber: number;
  title: string;
  body: string;
  htmlUrl: string;
  issueUpdatedAt: string;
  defaultBranch: string;
  cloneUrl: string;
  action: string;
  trigger?: IssueJobTrigger;
  generation?: number;
}

export const MAX_ATTEMPTS_REASON = "Jumi review failed: max attempts exceeded";
export const HEARTBEAT_MS = 30_000;
export const QUEUE_POLL_MS = 1_000;
export const RECLAIM_LEASED_BY = "reclaim";

export type { PersistReviewResult };

export interface ReviewJobRecord {
  id: number;
  jobKey: string;
  kind: JobKind;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  issueNumber: number | null;
  payload: IssueJobPayload | null;
  delivery: string;
  state: ReviewJobState;
  attempt: number;
  leasedBy: string | null;
  leasedUntil: number | null;
  resultMarkdown: string | null;
  /** Formatted runner stamp for the spawn that produced `resultMarkdown`. */
  resultRunner?: string | null;
  resultReason: string | null;
  error: string | null;
  pendingStatusAt: number | null;
  publishedAt: number | null;
  prUpdatedAt: number | null;
  /** A same-key review wake arrived while this row was leased; a CI-wait skip requeues instead of finishing. */
  rewakeRequested?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ReclaimResult {
  requeued: ReviewJobRecord[];
  publish: ReviewJobRecord[];
}

export interface ReviewJobStore {
  migrate(): Promise<void>;
  enqueue(job: ReviewJob): Promise<EnqueueResult>;
  enqueueIssue(job: IssueJob): Promise<EnqueueResult>;
  drop(key: string): Promise<boolean>;
  lease(
    leasedBy: string,
    leaseMs: number,
    now?: Date,
    kinds?: readonly JobKind[]
  ): Promise<ReviewJobRecord | undefined>;
  heartbeat(id: number, leasedBy: string, leaseMs: number, now?: Date): Promise<boolean>;
  expireLease(id: number, leasedBy: string, now?: Date): Promise<boolean>;
  requeueInfra(id: number, leasedBy: string, backoffMs: number, marker: string, now?: Date): Promise<boolean>;
  releaseLease(id: number, leasedBy: string): Promise<boolean>;
  saveResult(id: number, leasedBy: string, result: PersistReviewResult): Promise<void>;
  markPublished(
    id: number,
    leasedBy: string,
    outcome: { state: "succeeded" | "skipped" | "failed"; reason?: string }
  ): Promise<void>;
  reclaimExpired(maxAttempts: number, now?: Date, leaseMs?: number, kinds?: readonly JobKind[]): Promise<ReclaimResult>;
  cancelQueuedForIssue(owner: string, repo: string, issueNumber: number): Promise<number>;
  countSucceeded(kind: JobKind, owner: string, repo: string, issueNumber: number): Promise<number>;
  countByState(): Promise<Record<ReviewJobState, number>>;
  countByKindState(): Promise<Record<JobKind, Record<ReviewJobState, number>>>;
  oldestQueuedAgeSeconds(now?: Date): Promise<Record<JobKind, number>>;
  get(id: number): Promise<ReviewJobRecord | undefined>;
  /** Queued or leased rows for the operator board. No forge calls. Throws when the ledger is down. */
  listInflight(limit?: number): Promise<ReviewJobRecord[]>;
  readonly skipLatches: SkipLatchStore;
  readonly sits: RouterSitStore;
  readIssueSkipLatch(owner: string, repo: string, issueNumber: number): Promise<IssueSkipLatch>;
  clearIssueSkipLatch(owner: string, repo: string, issueNumber: number): Promise<IssueSkipLatch>;
  setIssueSkipReason(owner: string, repo: string, issueNumber: number, reason: string): Promise<void>;
}

export interface IssueSkipLatch {
  generation: number;
  skipReason: string | null;
}

export function emptyIssueSkipLatch(): IssueSkipLatch {
  return { generation: 0, skipReason: null };
}

function issueSkipLatchKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

export const REVIEW_JOBS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS review_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  delivery TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'skipped', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  leased_by TEXT,
  leased_until TIMESTAMPTZ,
  result_markdown TEXT,
  result_reason TEXT,
  error TEXT,
  pending_status_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  pr_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_inflight_job_key
  ON review_jobs (job_key)
  WHERE state IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS review_jobs_queued_created
  ON review_jobs (created_at, id)
  WHERE state = 'queued';

CREATE INDEX IF NOT EXISTS review_jobs_leased_until
  ON review_jobs (leased_until)
  WHERE state = 'leased';

ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS pr_updated_at TIMESTAMPTZ;
ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'review';
ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS issue_number INTEGER;
ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS result_runner TEXT;
ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS rewake_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS review_jobs_queued_kind_created
  ON review_jobs (kind, created_at, id)
  WHERE state = 'queued';

UPDATE review_jobs
SET state = 'queued', leased_by = NULL, leased_until = NULL, updated_at = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY owner, repo, issue_number
      ORDER BY id ASC
    ) AS rn
    FROM review_jobs
    WHERE state = 'leased'
      AND kind IN ('implement', 'follow-up', 'conflict')
      AND issue_number IS NOT NULL
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_leased_worker_issue
  ON review_jobs (owner, repo, issue_number)
  WHERE state = 'leased' AND kind IN ('implement', 'follow-up', 'conflict') AND issue_number IS NOT NULL;
`;

const BACKOFF_ERROR_PREDICATE =
  "(error IS NULL OR error LIKE 'infra-retry:%' OR error LIKE 'quota-wait:%' OR error LIKE 'ci-lookup-retry:%')";

function isBackoffMarker(error: string | null | undefined): boolean {
  return isInfraRetryMarker(error) || isQuotaWaitMarker(error) || isCiLookupRetryMarker(error);
}

export function hasPersistedResult(row: ReviewJobRecord): boolean {
  if (row.resultMarkdown || row.resultReason) return true;
  return Boolean(row.error && !isBackoffMarker(row.error));
}

function isTerminalOutcome(state: ReviewJobState, reason: string | null | undefined): boolean {
  return state === "succeeded" || (state === "skipped" && isTerminalSkipReason(reason));
}

// A finished sibling check is the wake after a CI skip, so one that lands while the
// row is leased (and is deduped against it) must not be lost when the lease ends in a CI wait.
function isCiRewakeOutcome(outcome: { state: string; reason?: string }): boolean {
  return outcome.state === "skipped" && isCiWaitSkipReason(outcome.reason);
}

function jobPrUpdatedAtMs(job: ReviewJob): number | null {
  if (!job.prUpdatedAt) return null;
  const parsed = Date.parse(job.prUpdatedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSamePullRequest(
  row: { owner: string; repo: string; prNumber: number },
  job: { owner: string; repo: string; prNumber: number }
): boolean {
  return row.owner === job.owner && row.repo === job.repo && row.prNumber === job.prNumber;
}

function rowKind(row: { kind?: JobKind | null }): JobKind {
  return row.kind || REVIEW_KIND;
}

function hasNewerInflight(rows: ReviewJobRecord[], job: ReviewJob, key: string): boolean {
  const incomingTs = jobPrUpdatedAtMs(job);
  if (incomingTs == null) return false;
  return rows.some(
    (row) =>
      rowKind(row) === REVIEW_KIND &&
      isSamePullRequest(row, job) &&
      (row.state === "queued" || row.state === "leased") &&
      row.jobKey !== key &&
      row.prUpdatedAt != null &&
      row.prUpdatedAt > incomingTs
  );
}

export function workerJobKind(job: IssueJob): JobKind {
  return job.mode ?? "implement";
}

export function workerJobKey(job: IssueJob): string {
  const kind = workerJobKind(job);
  if (kind === "implement") return `implement:${job.owner}/${job.repo}#${job.issueNumber}`;
  const base = `${kind}:${job.owner}/${job.repo}#${job.prNumber ?? 0}:${job.headSha ?? ""}`;
  if (kind !== "follow-up" || job.trigger?.event !== "workflow_job") return base;
  const jobId = job.trigger.workflowJobId;
  if (typeof jobId === "number" && Number.isFinite(jobId)) return `${base}:${jobId}`;
  return base;
}

export function issueJobPayload(job: IssueJob): IssueJobPayload {
  return {
    issueNumber: job.issueNumber,
    title: job.title,
    body: job.body,
    htmlUrl: job.htmlUrl,
    issueUpdatedAt: job.issueUpdatedAt,
    defaultBranch: job.defaultBranch,
    cloneUrl: job.cloneUrl,
    action: job.action,
    trigger: job.trigger,
  };
}

function payloadGeneration(payload: IssueJobPayload | null | undefined): number {
  return typeof payload?.generation === "number" && Number.isFinite(payload.generation) ? payload.generation : 0;
}

function issueJobPayloadAt(job: IssueJob, generation: number): IssueJobPayload {
  return { ...issueJobPayload(job), generation };
}

export function issueJobFromRecord(row: ReviewJobRecord): IssueJob {
  const payload = row.payload;
  if (!payload) throw new Error(`job ${row.id} missing payload`);
  const kind = rowKind(row);
  return {
    delivery: row.delivery,
    owner: row.owner,
    repo: row.repo,
    issueNumber: payload.issueNumber,
    action: payload.action,
    title: payload.title,
    body: payload.body,
    htmlUrl: payload.htmlUrl,
    issueUpdatedAt: payload.issueUpdatedAt,
    defaultBranch: payload.defaultBranch,
    cloneUrl: payload.cloneUrl,
    receivedAt: new Date(row.createdAt).toISOString(),
    mode: kind === "review" ? undefined : kind,
    prNumber: row.prNumber || undefined,
    headSha: row.headSha || undefined,
    trigger: payload.trigger,
  };
}

function parsePayload(value: unknown): IssueJobPayload | null {
  if (value == null) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Partial<IssueJobPayload>;
  if (typeof rec.issueNumber !== "number" || typeof rec.title !== "string") return null;
  return {
    issueNumber: rec.issueNumber,
    title: rec.title,
    body: typeof rec.body === "string" ? rec.body : "",
    htmlUrl: typeof rec.htmlUrl === "string" ? rec.htmlUrl : "",
    issueUpdatedAt: typeof rec.issueUpdatedAt === "string" ? rec.issueUpdatedAt : "",
    defaultBranch: typeof rec.defaultBranch === "string" ? rec.defaultBranch : "",
    cloneUrl: typeof rec.cloneUrl === "string" ? rec.cloneUrl : "",
    action: typeof rec.action === "string" ? rec.action : "",
    trigger: rec.trigger,
    ...(typeof rec.generation === "number" && Number.isFinite(rec.generation) ? { generation: rec.generation } : {}),
  };
}

function kindsOrReview(kinds?: readonly JobKind[]): readonly JobKind[] {
  return kinds && kinds.length > 0 ? kinds : [REVIEW_KIND];
}

function isWorkerKind(kind: JobKind): boolean {
  return WORKER_JOB_KINDS.includes(kind);
}

function sameWorkerIssue(
  left: { owner: string; repo: string; issueNumber: number | null },
  right: { owner: string; repo: string; issueNumber: number | null }
): boolean {
  return left.owner === right.owner && left.repo === right.repo && left.issueNumber === right.issueNumber;
}

function workerIssueIsLeased(
  rows: readonly ReviewJobRecord[],
  candidate: { owner: string; repo: string; issueNumber: number | null }
): boolean {
  return rows.some(
    (held) => held.state === "leased" && isWorkerKind(rowKind(held)) && sameWorkerIssue(held, candidate)
  );
}

function leasesWorkerKinds(kinds: readonly JobKind[]): boolean {
  return kinds.some((kind) => isWorkerKind(kind));
}

function isImplementTerminal(
  row: Pick<ReviewJobRecord, "kind" | "state" | "resultReason" | "payload">,
  job: IssueJob
): boolean {
  if (rowKind(row) !== "implement") return false;
  if (row.state === "succeeded") return true;
  return (
    row.state === "skipped" && row.resultReason === "no-changes" && row.payload?.issueUpdatedAt === job.issueUpdatedAt
  );
}

function emptyCounts(): Record<ReviewJobState, number> {
  return { queued: 0, leased: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 0 };
}

function emptyKindStateCounts(): Record<JobKind, Record<ReviewJobState, number>> {
  return {
    review: emptyCounts(),
    implement: emptyCounts(),
    "follow-up": emptyCounts(),
    conflict: emptyCounts(),
  };
}

function emptyOldestQueuedAge(): Record<JobKind, number> {
  return { review: 0, implement: 0, "follow-up": 0, conflict: 0 };
}

function mapIssueSkipLatch(row: { generation: unknown; skip_reason: unknown }): IssueSkipLatch {
  return {
    generation: num(row.generation),
    skipReason: strOrNull(row.skip_reason),
  };
}

export class MemoryReviewJobStore implements ReviewJobStore {
  readonly rows: ReviewJobRecord[] = [];
  readonly skipLatches = new MemorySkipLatchStore();
  readonly sits = new MemoryRouterSitStore();
  private nextId = 1;
  private chain = Promise.resolve();
  private readonly issueSkipLatches = new Map<string, IssueSkipLatch>();

  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async migrate(): Promise<void> {
    await this.sits.migrate();
  }

  enqueue(job: ReviewJob): Promise<EnqueueResult> {
    return this.locked(async () => {
      const key = reviewJobKey(job);
      const now = Date.now();
      const sameKey = this.rows.filter((row) => row.jobKey === key);
      if (sameKey.some((row) => isTerminalOutcome(row.state, row.resultReason))) {
        await this.sits.remember(job.owner, job.repo, job.prNumber, "terminal-result");
        return { key, queued: false };
      }
      if (sameKey.some((row) => row.state === "queued" || row.state === "leased")) {
        for (const row of sameKey) {
          if (row.state === "leased") row.rewakeRequested = true;
          if (
            row.state === "queued" &&
            row.leasedUntil != null &&
            row.leasedUntil > now &&
            isCiLookupRetryMarker(row.error)
          ) {
            row.leasedUntil = null;
            row.updatedAt = now;
          }
        }
        await this.sits.remember(job.owner, job.repo, job.prNumber, "repo-mutex");
        return { key, queued: false };
      }
      if (hasNewerInflight(this.rows, job, key)) {
        return { key, queued: false };
      }
      const incomingTs = jobPrUpdatedAtMs(job);
      for (const row of this.rows) {
        if (
          rowKind(row) === REVIEW_KIND &&
          isSamePullRequest(row, job) &&
          row.state === "queued" &&
          row.jobKey !== key &&
          (incomingTs == null || row.prUpdatedAt == null || row.prUpdatedAt <= incomingTs)
        ) {
          row.state = "cancelled";
          row.updatedAt = now;
        }
      }
      this.rows.push({
        id: this.nextId++,
        jobKey: key,
        kind: REVIEW_KIND,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        issueNumber: null,
        payload: null,
        delivery: job.delivery,
        state: "queued",
        attempt: 0,
        leasedBy: null,
        leasedUntil: null,
        resultMarkdown: null,
        resultReason: null,
        error: null,
        pendingStatusAt: null,
        publishedAt: null,
        prUpdatedAt: incomingTs,
        createdAt: now,
        updatedAt: now,
      });
      await this.sits.clear(job.owner, job.repo, job.prNumber);
      return { key, queued: true };
    });
  }

  enqueueIssue(job: IssueJob): Promise<EnqueueResult> {
    return this.locked(async () => {
      const key = workerJobKey(job);
      const kind = workerJobKind(job);
      const now = Date.now();
      const sameKey = this.rows.filter((row) => row.jobKey === key);
      if (sameKey.some((row) => row.state === "queued" || row.state === "leased")) {
        await this.sits.remember(job.owner, job.repo, job.issueNumber, "repo-mutex");
        return { key, queued: false };
      }
      if (kind === "implement" && sameKey.some((row) => isImplementTerminal(row, job))) {
        const terminal = sameKey.find((row) => isImplementTerminal(row, job));
        if (terminal?.resultReason === "no-changes") {
          await this.sits.remember(job.owner, job.repo, job.issueNumber, "no-changes");
        } else {
          await this.sits.remember(job.owner, job.repo, job.issueNumber, "terminal-result");
        }
        return { key, queued: false };
      }
      if (kind !== "implement" && job.prNumber) {
        for (const row of this.rows) {
          if (
            rowKind(row) === kind &&
            isSamePullRequest(row, { owner: job.owner, repo: job.repo, prNumber: job.prNumber }) &&
            row.state === "queued" &&
            row.jobKey !== key
          ) {
            row.state = "cancelled";
            row.updatedAt = now;
          }
        }
      }
      this.rows.push({
        id: this.nextId++,
        jobKey: key,
        kind,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber ?? 0,
        headSha: job.headSha ?? "",
        issueNumber: job.issueNumber,
        payload: issueJobPayloadAt(
          job,
          this.issueSkipLatches.get(issueSkipLatchKey(job.owner, job.repo, job.issueNumber))?.generation ?? 0
        ),
        delivery: job.delivery,
        state: "queued",
        attempt: 0,
        leasedBy: null,
        leasedUntil: null,
        resultMarkdown: null,
        resultReason: null,
        error: null,
        pendingStatusAt: null,
        publishedAt: null,
        prUpdatedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await this.sits.clear(job.owner, job.repo, job.issueNumber);
      return { key, queued: true };
    });
  }

  drop(key: string): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.jobKey === key && item.state === "queued");
      if (!row) return false;
      row.state = "cancelled";
      row.updatedAt = Date.now();
      return true;
    });
  }

  lease(
    leasedBy: string,
    leaseMs: number,
    now = new Date(),
    kinds?: readonly JobKind[]
  ): Promise<ReviewJobRecord | undefined> {
    return this.locked(() => {
      const allowed = kindsOrReview(kinds);
      const serializeWorkers = leasesWorkerKinds(allowed);
      const ts = now.getTime();
      const row = this.rows.find((item) => {
        if (item.state !== "queued" || !allowed.includes(rowKind(item))) return false;
        if (item.leasedUntil != null && item.leasedUntil > ts) return false;
        if (serializeWorkers && isWorkerKind(rowKind(item)) && workerIssueIsLeased(this.rows, item)) return false;
        return true;
      });
      if (!row) return undefined;
      row.state = "leased";
      row.leasedBy = leasedBy;
      row.leasedUntil = ts + leaseMs;
      row.updatedAt = ts;
      return { ...row };
    });
  }

  heartbeat(id: number, leasedBy: string, leaseMs: number, now = new Date()): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) return false;
      const ts = now.getTime();
      row.leasedUntil = ts + leaseMs;
      row.updatedAt = ts;
      return true;
    });
  }

  expireLease(id: number, leasedBy: string, now = new Date()): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) return false;
      const ts = now.getTime();
      row.leasedUntil = ts - 1;
      row.leasedBy = null;
      row.updatedAt = ts;
      return true;
    });
  }

  requeueInfra(id: number, leasedBy: string, backoffMs: number, marker: string, now = new Date()): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) return false;
      if (hasPersistedResult(row)) return false;
      const ts = now.getTime();
      row.state = "queued";
      row.leasedBy = null;
      row.leasedUntil = ts + backoffMs;
      row.error = marker;
      row.updatedAt = ts;
      return true;
    });
  }

  releaseLease(id: number, leasedBy: string): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) return false;
      if (hasPersistedResult(row)) return false;
      const ts = Date.now();
      row.state = "queued";
      row.leasedBy = null;
      row.leasedUntil = null;
      row.updatedAt = ts;
      return true;
    });
  }

  saveResult(id: number, leasedBy: string, result: PersistReviewResult): Promise<void> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) throw new Error(`cannot save result for job ${id}`);
      if (result.kind === "markdown") {
        row.resultMarkdown = result.markdown;
        row.resultRunner = result.runner ?? null;
        row.resultReason = null;
        row.error = null;
      } else if (result.kind === "skip") {
        row.resultReason = result.reason;
        row.resultMarkdown = null;
      } else {
        row.error = result.error;
        row.resultReason = result.error;
        row.resultMarkdown = null;
      }
      row.updatedAt = Date.now();
    });
  }

  markPublished(
    id: number,
    leasedBy: string,
    outcome: { state: "succeeded" | "skipped" | "failed"; reason?: string }
  ): Promise<void> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) throw new Error(`cannot mark published for job ${id}`);
      const ts = Date.now();
      const rewake = Boolean(row.rewakeRequested) && isCiRewakeOutcome(outcome);
      row.rewakeRequested = false;
      if (rewake) {
        row.state = "queued";
        row.resultReason = null;
        row.leasedBy = null;
        row.leasedUntil = null;
        row.updatedAt = ts;
        return;
      }
      row.state = outcome.state;
      if (outcome.reason) row.resultReason = outcome.reason;
      row.publishedAt = ts;
      row.leasedBy = null;
      row.leasedUntil = null;
      row.updatedAt = ts;
    });
  }

  reclaimExpired(
    maxAttempts: number,
    now = new Date(),
    leaseMs = HEARTBEAT_MS,
    kinds?: readonly JobKind[]
  ): Promise<ReclaimResult> {
    return this.locked(() => {
      const allowed = kindsOrReview(kinds);
      const ts = now.getTime();
      const claimedUntil = ts + leaseMs;
      const requeued: ReviewJobRecord[] = [];
      const publish: ReviewJobRecord[] = [];
      for (const row of this.rows) {
        if (row.state !== "leased" || row.leasedUntil == null || row.leasedUntil >= ts) continue;
        if (!allowed.includes(rowKind(row))) continue;
        if (hasPersistedResult(row)) {
          row.leasedBy = RECLAIM_LEASED_BY;
          row.leasedUntil = claimedUntil;
          row.updatedAt = ts;
          publish.push({ ...row });
          continue;
        }
        row.attempt += 1;
        row.updatedAt = ts;
        if (isInfraRetryMarker(row.error)) row.error = null;
        if (row.attempt >= maxAttempts) {
          row.error = MAX_ATTEMPTS_REASON;
          row.resultReason = MAX_ATTEMPTS_REASON;
          row.leasedBy = RECLAIM_LEASED_BY;
          row.leasedUntil = claimedUntil;
          publish.push({ ...row });
          continue;
        }
        row.state = "queued";
        row.leasedBy = null;
        row.leasedUntil = null;
        requeued.push({ ...row });
      }
      return { requeued, publish };
    });
  }

  countByState(): Promise<Record<ReviewJobState, number>> {
    return this.locked(() => {
      const counts = emptyCounts();
      for (const row of this.rows) counts[row.state]++;
      return counts;
    });
  }

  countByKindState(): Promise<Record<JobKind, Record<ReviewJobState, number>>> {
    return this.locked(() => {
      const counts = emptyKindStateCounts();
      for (const row of this.rows) {
        const kind = rowKind(row);
        if (kind in counts && row.state in counts[kind]) counts[kind][row.state]++;
      }
      return counts;
    });
  }

  oldestQueuedAgeSeconds(now = new Date()): Promise<Record<JobKind, number>> {
    return this.locked(() => {
      const nowMs = now.getTime();
      const oldest: Partial<Record<JobKind, number>> = {};
      for (const row of this.rows) {
        if (row.state !== "queued") continue;
        const kind = rowKind(row);
        if (oldest[kind] == null || row.createdAt < oldest[kind]!) oldest[kind] = row.createdAt;
      }
      const ages = emptyOldestQueuedAge();
      for (const kind of JOB_KINDS) {
        const createdAt = oldest[kind];
        if (createdAt != null) ages[kind] = Math.max(0, (nowMs - createdAt) / 1000);
      }
      return ages;
    });
  }

  get(id: number): Promise<ReviewJobRecord | undefined> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      return row ? { ...row } : undefined;
    });
  }

  listInflight(limit = 200): Promise<ReviewJobRecord[]> {
    return this.locked(() => {
      const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 200;
      return this.rows
        .filter((row) => row.state === "queued" || row.state === "leased")
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
        .slice(0, cap)
        .map((row) => ({ ...row }));
    });
  }

  cancelQueuedForIssue(owner: string, repo: string, issueNumber: number): Promise<number> {
    return this.locked(async () => {
      const now = Date.now();
      let n = 0;
      for (const row of this.rows) {
        if (row.owner !== owner || row.repo !== repo || row.issueNumber !== issueNumber) continue;
        if (!WORKER_JOB_KINDS.includes(rowKind(row))) continue;
        if (row.state !== "queued" && row.state !== "leased") continue;
        row.state = "cancelled";
        row.leasedBy = null;
        row.leasedUntil = null;
        row.updatedAt = now;
        n++;
      }
      await this.sits.clear(owner, repo, issueNumber);
      return n;
    });
  }

  countSucceeded(kind: JobKind, owner: string, repo: string, issueNumber: number): Promise<number> {
    return this.locked(() => {
      const generation = this.issueSkipLatches.get(issueSkipLatchKey(owner, repo, issueNumber))?.generation ?? 0;
      return this.rows.filter(
        (row) =>
          rowKind(row) === kind &&
          row.owner === owner &&
          row.repo === repo &&
          row.issueNumber === issueNumber &&
          row.state === "succeeded" &&
          payloadGeneration(row.payload) === generation
      ).length;
    });
  }

  readIssueSkipLatch(owner: string, repo: string, issueNumber: number): Promise<IssueSkipLatch> {
    return this.locked(() => {
      const latch = this.issueSkipLatches.get(issueSkipLatchKey(owner, repo, issueNumber));
      return latch ? { ...latch } : emptyIssueSkipLatch();
    });
  }

  clearIssueSkipLatch(owner: string, repo: string, issueNumber: number): Promise<IssueSkipLatch> {
    return this.locked(async () => {
      const key = issueSkipLatchKey(owner, repo, issueNumber);
      const current = this.issueSkipLatches.get(key);
      const next: IssueSkipLatch = { generation: (current?.generation ?? 0) + 1, skipReason: null };
      this.issueSkipLatches.set(key, next);
      await this.skipLatches.delete({ owner, repo, issueNumber });
      await this.sits.clear(owner, repo, issueNumber);
      return { ...next };
    });
  }

  setIssueSkipReason(owner: string, repo: string, issueNumber: number, reason: string): Promise<void> {
    return this.locked(() => {
      const key = issueSkipLatchKey(owner, repo, issueNumber);
      const current = this.issueSkipLatches.get(key);
      this.issueSkipLatches.set(key, { generation: current?.generation ?? 0, skipReason: reason });
    });
  }
}

type ReviewJobRow = {
  id: unknown;
  job_key: unknown;
  kind: unknown;
  owner: unknown;
  repo: unknown;
  pr_number: unknown;
  head_sha: unknown;
  issue_number: unknown;
  payload: unknown;
  delivery: unknown;
  state: unknown;
  attempt: unknown;
  leased_by: unknown;
  leased_until: unknown;
  result_markdown: unknown;
  result_runner?: unknown;
  result_reason: unknown;
  error: unknown;
  pending_status_at: unknown;
  published_at: unknown;
  pr_updated_at: unknown;
  rewake_requested?: unknown;
  created_at: unknown;
  updated_at: unknown;
};

// Bun's `PostgresError` carries the SQLSTATE in `errno` and puts `ERR_POSTGRES_SERVER_ERROR`
// in `code`, so reading `code` / `sqlState` alone never matches a real unique violation and
// `lease()` would surface a routine index race as a dead queue. Covered by the real-Postgres
// suite in test/review_jobs_pg.test.ts.
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const rec = current as { code?: unknown; sqlState?: unknown; errno?: unknown; cause?: unknown };
    for (const value of [rec.code, rec.sqlState, rec.errno]) {
      if (value === "23505" || value === 23505) return true;
    }
    current = rec.cause;
  }
  return false;
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  throw new Error(`expected number, got ${typeof value}`);
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function strOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function epoch(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function epochRequired(value: unknown): number {
  return epoch(value) ?? Date.now();
}

function mapRow(row: ReviewJobRow): ReviewJobRecord {
  return {
    id: num(row.id),
    jobKey: str(row.job_key),
    kind: (str(row.kind) || REVIEW_KIND) as JobKind,
    owner: str(row.owner),
    repo: str(row.repo),
    prNumber: num(row.pr_number),
    headSha: str(row.head_sha),
    issueNumber: row.issue_number == null || row.issue_number === "" ? null : num(row.issue_number),
    payload: parsePayload(row.payload),
    delivery: str(row.delivery),
    state: str(row.state) as ReviewJobState,
    attempt: num(row.attempt),
    leasedBy: strOrNull(row.leased_by),
    leasedUntil: epoch(row.leased_until),
    resultMarkdown: strOrNull(row.result_markdown),
    resultRunner: strOrNull(row.result_runner),
    resultReason: strOrNull(row.result_reason),
    error: strOrNull(row.error),
    pendingStatusAt: epoch(row.pending_status_at),
    publishedAt: epoch(row.published_at),
    prUpdatedAt: epoch(row.pr_updated_at),
    rewakeRequested: row.rewake_requested === true || row.rewake_requested === "t",
    createdAt: epochRequired(row.created_at),
    updatedAt: epochRequired(row.updated_at),
  };
}

export class PgReviewJobStore implements ReviewJobStore {
  readonly skipLatches: PgSkipLatchStore;
  readonly sits: PgRouterSitStore;

  constructor(private readonly sql: SqlClient) {
    this.skipLatches = new PgSkipLatchStore(sql);
    this.sits = new PgRouterSitStore(sql);
  }

  async migrate(): Promise<void> {
    try {
      await this.sql.unsafe(REVIEW_JOBS_SCHEMA_SQL);
      await this.sql.unsafe(ISSUE_SKIP_LATCHES_SCHEMA_SQL);
      await this.sql.unsafe(ROUTER_SITS_SCHEMA_SQL);
    } catch (err) {
      wrapSqlError(err);
    }
  }

  private async rememberSitTx(
    tx: SqlClient,
    owner: string,
    repo: string,
    number: number,
    reason: "terminal-result" | "repo-mutex" | "no-changes"
  ): Promise<void> {
    await tx.unsafe(
      `INSERT INTO router_sits (owner, repo, number, reason, decided_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (owner, repo, number)
       DO UPDATE SET reason = EXCLUDED.reason, decided_at = NOW(), updated_at = NOW()`,
      [owner, repo, number, reason]
    );
  }

  private async clearSitTx(tx: SqlClient, owner: string, repo: string, number: number): Promise<void> {
    await tx.unsafe(`DELETE FROM router_sits WHERE owner = $1 AND repo = $2 AND number = $3`, [owner, repo, number]);
  }

  async enqueue(job: ReviewJob): Promise<EnqueueResult> {
    const key = reviewJobKey(job);
    const prUpdatedAt = job.prUpdatedAt ?? null;
    return this.sql.begin(async (tx) => {
      const done = asRows<{ state: unknown; result_reason: unknown }>(
        await tx.unsafe(
          `SELECT state, result_reason FROM review_jobs WHERE job_key = $1 AND state IN ('succeeded', 'skipped')`,
          [key]
        )
      );
      if (done.some((row) => isTerminalOutcome(str(row.state) as ReviewJobState, strOrNull(row.result_reason)))) {
        await this.rememberSitTx(tx, job.owner, job.repo, job.prNumber, "terminal-result");
        return { key, queued: false };
      }

      const inflight = asRows<{ job_key: unknown; pr_updated_at: unknown }>(
        await tx.unsafe(
          `SELECT job_key, pr_updated_at FROM review_jobs
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND kind = $4 AND state IN ('queued', 'leased')
           ORDER BY id
           FOR UPDATE`,
          [job.owner, job.repo, job.prNumber, REVIEW_KIND]
        )
      );
      if (inflight.some((row) => str(row.job_key) === key)) {
        await tx.unsafe(
          `UPDATE review_jobs
           SET rewake_requested = CASE WHEN state = 'leased' THEN TRUE ELSE rewake_requested END,
               leased_until = CASE
                 WHEN state = 'queued' AND leased_until > NOW() AND error LIKE 'ci-lookup-retry:%' THEN NULL
                 ELSE leased_until
               END,
               updated_at = NOW()
           WHERE job_key = $1
             AND (state = 'leased' OR (state = 'queued' AND leased_until > NOW() AND error LIKE 'ci-lookup-retry:%'))`,
          [key]
        );
        await this.rememberSitTx(tx, job.owner, job.repo, job.prNumber, "repo-mutex");
        return { key, queued: false };
      }
      const incomingTs = jobPrUpdatedAtMs(job);
      if (
        incomingTs != null &&
        inflight.some((row) => {
          const existing = epoch(row.pr_updated_at);
          return existing != null && existing > incomingTs;
        })
      ) {
        return { key, queued: false };
      }

      const inserted = asRows<{ id: unknown }>(
        await tx.unsafe(
          `INSERT INTO review_jobs (
             job_key, owner, repo, pr_number, head_sha, delivery, state, attempt, pr_updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', 0, $7::timestamptz)
           ON CONFLICT (job_key) WHERE state IN ('queued', 'leased')
           DO NOTHING
           RETURNING id`,
          [key, job.owner, job.repo, job.prNumber, job.headSha, job.delivery, prUpdatedAt]
        )
      );
      if (inserted.length === 0) {
        await this.rememberSitTx(tx, job.owner, job.repo, job.prNumber, "repo-mutex");
        return { key, queued: false };
      }

      await tx.unsafe(
        `UPDATE review_jobs
         SET state = 'cancelled', updated_at = NOW()
         WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND kind = $6 AND state = 'queued' AND job_key <> $4
           AND ($5::timestamptz IS NULL OR pr_updated_at IS NULL OR pr_updated_at <= $5::timestamptz)`,
        [job.owner, job.repo, job.prNumber, key, prUpdatedAt, REVIEW_KIND]
      );
      await this.clearSitTx(tx, job.owner, job.repo, job.prNumber);
      return { key, queued: true };
    });
  }

  async enqueueIssue(job: IssueJob): Promise<EnqueueResult> {
    const key = workerJobKey(job);
    const kind = workerJobKind(job);
    return this.sql.begin(async (tx) => {
      if (kind === "implement") {
        const done = asRows<{ state: unknown; result_reason: unknown; payload: unknown }>(
          await tx.unsafe(
            `SELECT state, result_reason, payload FROM review_jobs WHERE job_key = $1 AND state IN ('succeeded', 'skipped')`,
            [key]
          )
        );
        const terminal = done.find((row) =>
          isImplementTerminal(
            {
              kind,
              state: str(row.state) as ReviewJobState,
              resultReason: strOrNull(row.result_reason),
              payload: parsePayload(row.payload),
            },
            job
          )
        );
        if (terminal) {
          if (strOrNull(terminal.result_reason) === "no-changes") {
            await this.rememberSitTx(tx, job.owner, job.repo, job.issueNumber, "no-changes");
          } else {
            await this.rememberSitTx(tx, job.owner, job.repo, job.issueNumber, "terminal-result");
          }
          return { key, queued: false };
        }
      }

      const inflight = asRows<{ job_key: unknown }>(
        await tx.unsafe(
          `SELECT job_key FROM review_jobs
           WHERE job_key = $1 AND state IN ('queued', 'leased')
           ORDER BY id
           FOR UPDATE`,
          [key]
        )
      );
      if (inflight.length > 0) {
        await this.rememberSitTx(tx, job.owner, job.repo, job.issueNumber, "repo-mutex");
        return { key, queued: false };
      }

      const latchRows = asRows<{ generation: unknown }>(
        await tx.unsafe(
          `SELECT generation FROM issue_skip_latches WHERE owner = $1 AND repo = $2 AND issue_number = $3`,
          [job.owner, job.repo, job.issueNumber]
        )
      );
      const payload = issueJobPayloadAt(job, latchRows[0] ? num(latchRows[0].generation) : 0);

      const inserted = asRows<{ id: unknown }>(
        await tx.unsafe(
          `INSERT INTO review_jobs (
             job_key, kind, owner, repo, pr_number, head_sha, issue_number, payload, delivery, state, attempt
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'queued', 0)
           ON CONFLICT (job_key) WHERE state IN ('queued', 'leased')
           DO NOTHING
           RETURNING id`,
          [
            key,
            kind,
            job.owner,
            job.repo,
            job.prNumber ?? 0,
            job.headSha ?? "",
            job.issueNumber,
            JSON.stringify(payload),
            job.delivery,
          ]
        )
      );
      if (inserted.length === 0) {
        await this.rememberSitTx(tx, job.owner, job.repo, job.issueNumber, "repo-mutex");
        return { key, queued: false };
      }

      if (kind !== "implement" && job.prNumber) {
        await tx.unsafe(
          `UPDATE review_jobs
           SET state = 'cancelled', updated_at = NOW()
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND kind = $4 AND state = 'queued' AND job_key <> $5`,
          [job.owner, job.repo, job.prNumber, kind, key]
        );
      }
      await this.clearSitTx(tx, job.owner, job.repo, job.issueNumber);
      return { key, queued: true };
    });
  }

  async drop(key: string): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs SET state = 'cancelled', updated_at = NOW()
         WHERE job_key = $1 AND state = 'queued'
         RETURNING id`,
        [key]
      )
    );
    return rows.length > 0;
  }

  async lease(
    leasedBy: string,
    leaseMs: number,
    now = new Date(),
    kinds?: readonly JobKind[]
  ): Promise<ReviewJobRecord | undefined> {
    const allowed = kindsOrReview(kinds);
    const until = new Date(now.getTime() + leaseMs).toISOString();
    const serializeWorkers = leasesWorkerKinds(allowed);
    const runnable = `(leased_until IS NULL OR leased_until <= $3::timestamptz)`;
    const query = serializeWorkers
      ? `UPDATE review_jobs
         SET state = 'leased', leased_by = $1, leased_until = $2::timestamptz, updated_at = NOW()
         WHERE id = (
           SELECT id FROM review_jobs
           WHERE state = 'queued' AND kind = ANY($4::text[]) AND ${runnable}
             AND NOT EXISTS (
               SELECT 1 FROM review_jobs held
               WHERE held.state = 'leased'
                 AND held.kind = ANY($5::text[])
                 AND held.owner = review_jobs.owner
                 AND held.repo = review_jobs.repo
                 AND held.issue_number IS NOT DISTINCT FROM review_jobs.issue_number
             )
           ORDER BY created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`
      : `UPDATE review_jobs
         SET state = 'leased', leased_by = $1, leased_until = $2::timestamptz, updated_at = NOW()
         WHERE id = (
           SELECT id FROM review_jobs
           WHERE state = 'queued' AND kind = ANY($4::text[]) AND ${runnable}
           ORDER BY created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`;
    const nowIso = now.toISOString();
    const params = serializeWorkers
      ? [leasedBy, until, nowIso, pgTextArrayLiteral(allowed), pgTextArrayLiteral([...WORKER_JOB_KINDS])]
      : [leasedBy, until, nowIso, pgTextArrayLiteral(allowed)];
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = asRows<ReviewJobRow>(await this.sql.unsafe(query, params));
        return rows[0] ? mapRow(rows[0]) : undefined;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (attempt >= 1) return undefined;
      }
    }
  }

  async heartbeat(id: number, leasedBy: string, leaseMs: number, now = new Date()): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET leased_until = $3::timestamptz, updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
         RETURNING id`,
        [id, leasedBy, new Date(now.getTime() + leaseMs).toISOString()]
      )
    );
    return rows.length > 0;
  }

  async expireLease(id: number, leasedBy: string, now = new Date()): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET leased_until = $3::timestamptz, leased_by = NULL, updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
         RETURNING id`,
        [id, leasedBy, new Date(now.getTime() - 1).toISOString()]
      )
    );
    return rows.length > 0;
  }

  async requeueInfra(
    id: number,
    leasedBy: string,
    backoffMs: number,
    marker: string,
    now = new Date()
  ): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET state = 'queued',
             leased_by = NULL,
             leased_until = $3::timestamptz,
             error = $4,
             updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
            AND result_markdown IS NULL AND result_reason IS NULL
            AND ${BACKOFF_ERROR_PREDICATE}
           RETURNING id`,
        [id, leasedBy, new Date(now.getTime() + backoffMs).toISOString(), marker]
      )
    );
    return rows.length > 0;
  }

  async releaseLease(id: number, leasedBy: string): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET state = 'queued', leased_by = NULL, leased_until = NULL, updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
            AND result_markdown IS NULL AND result_reason IS NULL
            AND ${BACKOFF_ERROR_PREDICATE}
           RETURNING id`,
        [id, leasedBy]
      )
    );
    return rows.length > 0;
  }

  async saveResult(id: number, leasedBy: string, result: PersistReviewResult): Promise<void> {
    let rows: { id: unknown }[];
    if (result.kind === "markdown") {
      rows = asRows<{ id: unknown }>(
        await this.sql.unsafe(
          `UPDATE review_jobs
           SET result_markdown = $3, result_runner = $4, result_reason = NULL, error = NULL, updated_at = NOW()
           WHERE id = $1 AND leased_by = $2 AND state = 'leased'
           RETURNING id`,
          [id, leasedBy, result.markdown, result.runner ?? null]
        )
      );
    } else if (result.kind === "skip") {
      rows = asRows<{ id: unknown }>(
        await this.sql.unsafe(
          `UPDATE review_jobs
           SET result_reason = $3, result_markdown = NULL, updated_at = NOW()
           WHERE id = $1 AND leased_by = $2 AND state = 'leased'
           RETURNING id`,
          [id, leasedBy, result.reason]
        )
      );
    } else {
      rows = asRows<{ id: unknown }>(
        await this.sql.unsafe(
          `UPDATE review_jobs
           SET error = $3, result_reason = $3, result_markdown = NULL, updated_at = NOW()
           WHERE id = $1 AND leased_by = $2 AND state = 'leased'
           RETURNING id`,
          [id, leasedBy, result.error]
        )
      );
    }
    if (rows.length === 0) throw new Error(`cannot save result for job ${id}`);
  }

  async markPublished(
    id: number,
    leasedBy: string,
    outcome: { state: "succeeded" | "skipped" | "failed"; reason?: string }
  ): Promise<void> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET state = CASE WHEN $5::boolean AND rewake_requested THEN 'queued' ELSE $3 END,
             result_reason = CASE WHEN $5::boolean AND rewake_requested THEN NULL ELSE COALESCE($4, result_reason) END,
             published_at = CASE WHEN $5::boolean AND rewake_requested THEN published_at ELSE NOW() END,
             rewake_requested = FALSE,
             leased_by = NULL,
             leased_until = NULL,
             updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
         RETURNING id`,
        [id, leasedBy, outcome.state, outcome.reason ?? null, isCiRewakeOutcome(outcome)]
      )
    );
    if (rows.length === 0) throw new Error(`cannot mark published for job ${id}`);
  }

  async reclaimExpired(
    maxAttempts: number,
    now = new Date(),
    leaseMs = HEARTBEAT_MS,
    kinds?: readonly JobKind[]
  ): Promise<ReclaimResult> {
    return this.sql.begin(async (tx) => {
      const allowed = kindsOrReview(kinds);
      const ts = now.toISOString();
      const claimedUntil = new Date(now.getTime() + leaseMs).toISOString();
      const expired = asRows<ReviewJobRow>(
        await tx.unsafe(
          `SELECT * FROM review_jobs
           WHERE state = 'leased' AND leased_until < $1::timestamptz AND kind = ANY($2::text[])
           ORDER BY id
           FOR UPDATE SKIP LOCKED`,
          [ts, pgTextArrayLiteral(allowed)]
        )
      );

      const requeued: ReviewJobRecord[] = [];
      const publish: ReviewJobRecord[] = [];

      for (const raw of expired) {
        const row = mapRow(raw);
        if (hasPersistedResult(row)) {
          const updated = asRows<ReviewJobRow>(
            await tx.unsafe(
              `UPDATE review_jobs
               SET leased_by = $2,
                   leased_until = $3::timestamptz,
                   updated_at = NOW()
               WHERE id = $1 AND state = 'leased'
               RETURNING *`,
              [row.id, RECLAIM_LEASED_BY, claimedUntil]
            )
          );
          if (updated[0]) publish.push(mapRow(updated[0]));
          continue;
        }
        if (row.attempt + 1 >= maxAttempts) {
          const updated = asRows<ReviewJobRow>(
            await tx.unsafe(
              `UPDATE review_jobs
               SET attempt = attempt + 1,
                   error = $2,
                   result_reason = $2,
                   leased_by = $3,
                   leased_until = $4::timestamptz,
                   updated_at = NOW()
               WHERE id = $1
               RETURNING *`,
              [row.id, MAX_ATTEMPTS_REASON, RECLAIM_LEASED_BY, claimedUntil]
            )
          );
          if (updated[0]) publish.push(mapRow(updated[0]));
          continue;
        }
        const updated = asRows<ReviewJobRow>(
          await tx.unsafe(
            `UPDATE review_jobs
             SET attempt = attempt + 1,
                 state = 'queued',
                 leased_by = NULL,
                 leased_until = NULL,
                 error = CASE WHEN error LIKE 'infra-retry:%' THEN NULL ELSE error END,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [row.id]
          )
        );
        if (updated[0]) requeued.push(mapRow(updated[0]));
      }

      return { requeued, publish };
    });
  }

  async countByState(): Promise<Record<ReviewJobState, number>> {
    const rows = asRows<{ state: unknown; n: unknown }>(
      await this.sql.unsafe(`SELECT state, COUNT(*)::bigint AS n FROM review_jobs GROUP BY state`)
    );
    const counts = emptyCounts();
    for (const row of rows) {
      const state = str(row.state) as ReviewJobState;
      if (state in counts) counts[state] = num(row.n);
    }
    return counts;
  }

  async countByKindState(): Promise<Record<JobKind, Record<ReviewJobState, number>>> {
    const rows = asRows<{ kind: unknown; state: unknown; n: unknown }>(
      await this.sql.unsafe(`SELECT kind, state, COUNT(*)::bigint AS n FROM review_jobs GROUP BY kind, state`)
    );
    const counts = emptyKindStateCounts();
    for (const row of rows) {
      const kind = (str(row.kind) || REVIEW_KIND) as JobKind;
      const state = str(row.state) as ReviewJobState;
      if (kind in counts && state in counts[kind]) counts[kind][state] = num(row.n);
    }
    return counts;
  }

  async oldestQueuedAgeSeconds(now = new Date()): Promise<Record<JobKind, number>> {
    const rows = asRows<{ kind: unknown; age: unknown }>(
      await this.sql.unsafe(
        `SELECT kind, EXTRACT(EPOCH FROM ($1::timestamptz - MIN(created_at))) AS age
         FROM review_jobs WHERE state = 'queued' GROUP BY kind`,
        [now.toISOString()]
      )
    );
    const ages = emptyOldestQueuedAge();
    for (const row of rows) {
      const kind = (str(row.kind) || REVIEW_KIND) as JobKind;
      if (kind in ages && row.age != null && row.age !== "") ages[kind] = Math.max(0, num(row.age));
    }
    return ages;
  }

  async get(id: number): Promise<ReviewJobRecord | undefined> {
    const rows = asRows<ReviewJobRow>(await this.sql.unsafe(`SELECT * FROM review_jobs WHERE id = $1`, [id]));
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async listInflight(limit = 200): Promise<ReviewJobRecord[]> {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 200;
    const rows = asRows<ReviewJobRow>(
      await this.sql.unsafe(
        `SELECT * FROM review_jobs WHERE state IN ('queued', 'leased') ORDER BY created_at ASC, id ASC LIMIT $1`,
        [cap]
      )
    );
    return rows.map(mapRow);
  }

  async cancelQueuedForIssue(owner: string, repo: string, issueNumber: number): Promise<number> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs SET state = 'cancelled', leased_by = NULL, leased_until = NULL, updated_at = NOW()
         WHERE owner = $1 AND repo = $2 AND issue_number = $3 AND kind = ANY($4::text[]) AND state IN ('queued', 'leased')
         RETURNING id`,
        [owner, repo, issueNumber, pgTextArrayLiteral(WORKER_JOB_KINDS)]
      )
    );
    await this.sits.clear(owner, repo, issueNumber);
    return rows.length;
  }

  async countSucceeded(kind: JobKind, owner: string, repo: string, issueNumber: number): Promise<number> {
    const rows = asRows<{ n: unknown }>(
      await this.sql.unsafe(
        `SELECT COUNT(*)::bigint AS n FROM review_jobs
         WHERE kind = $1 AND owner = $2 AND repo = $3 AND issue_number = $4 AND state = 'succeeded'
           AND COALESCE((payload->>'generation')::integer, 0) = (
             SELECT COALESCE(
               (SELECT generation FROM issue_skip_latches WHERE owner = $2 AND repo = $3 AND issue_number = $4),
               0
             )
           )`,
        [kind, owner, repo, issueNumber]
      )
    );
    return rows[0] ? num(rows[0].n) : 0;
  }

  async readIssueSkipLatch(owner: string, repo: string, issueNumber: number): Promise<IssueSkipLatch> {
    const rows = asRows<{ generation: unknown; skip_reason: unknown }>(
      await this.sql.unsafe(
        `SELECT generation, skip_reason FROM issue_skip_latches WHERE owner = $1 AND repo = $2 AND issue_number = $3`,
        [owner, repo, issueNumber]
      )
    );
    return rows[0] ? mapIssueSkipLatch(rows[0]) : emptyIssueSkipLatch();
  }

  async clearIssueSkipLatch(owner: string, repo: string, issueNumber: number): Promise<IssueSkipLatch> {
    const rows = asRows<{ generation: unknown; skip_reason: unknown }>(
      await this.sql.unsafe(
        `INSERT INTO issue_skip_latches (owner, repo, issue_number, generation, skip_reason, updated_at)
         VALUES ($1, $2, $3, 1, NULL, NOW())
         ON CONFLICT (owner, repo, issue_number)
         DO UPDATE SET generation = issue_skip_latches.generation + 1, skip_reason = NULL,
           followup = '{}'::jsonb, conflict = '{}'::jsonb, ci = '{}'::jsonb, stuck = '{}'::jsonb,
           updated_at = NOW()
         RETURNING generation, skip_reason`,
        [owner, repo, issueNumber]
      )
    );
    await this.sits.clear(owner, repo, issueNumber);
    return rows[0] ? mapIssueSkipLatch(rows[0]) : emptyIssueSkipLatch();
  }

  async setIssueSkipReason(owner: string, repo: string, issueNumber: number, reason: string): Promise<void> {
    await this.sql.unsafe(
      `INSERT INTO issue_skip_latches (owner, repo, issue_number, generation, skip_reason, updated_at)
       VALUES ($1, $2, $3, 0, $4, NOW())
       ON CONFLICT (owner, repo, issue_number)
       DO UPDATE SET skip_reason = EXCLUDED.skip_reason, updated_at = NOW()`,
      [owner, repo, issueNumber, reason]
    );
  }
}

export async function createPgReviewJobStore(databaseUrl: string): Promise<PgReviewJobStore> {
  const store = new PgReviewJobStore(createBunSqlClient(databaseUrl));
  await store.migrate();
  return store;
}

export async function renderQueueMetrics(store: ReviewJobStore, now = new Date()): Promise<string> {
  const counts = await store.countByKindState();
  const ages = await store.oldestQueuedAgeSeconds(now);
  const lines = ["# HELP jumi_review_jobs Number of jobs by state and kind", "# TYPE jumi_review_jobs gauge"];
  for (const kind of JOB_KINDS) {
    for (const state of REVIEW_JOB_STATES) {
      lines.push(`jumi_review_jobs{state="${state}",kind="${kind}"} ${counts[kind][state]}`);
    }
  }
  lines.push("# HELP jumi_review_jobs_oldest_queued_age_seconds Age in seconds of the oldest queued job by kind");
  lines.push("# TYPE jumi_review_jobs_oldest_queued_age_seconds gauge");
  for (const kind of JOB_KINDS) {
    lines.push(`jumi_review_jobs_oldest_queued_age_seconds{kind="${kind}"} ${ages[kind]}`);
  }
  return `${lines.join("\n")}\n`;
}
