import { readFile } from "node:fs/promises";
import type { ControlConfig } from "./control_config.ts";
import { JOB_ID_ENV } from "./job_env.ts";
import {
  type JobKind,
  REVIEW_KIND,
  type ReviewJobRecord,
  type ReviewJobStore,
  type RoleGateRole,
  WORKER_JOB_KINDS,
} from "./review_jobs.ts";

export type DispatchRole = "engine" | "worker";

const ENGINE_KINDS: readonly JobKind[] = [REVIEW_KIND];

export function kindsForDispatchRole(role: DispatchRole): readonly JobKind[] {
  return role === "engine" ? ENGINE_KINDS : WORKER_JOB_KINDS;
}

export function roleGateForDispatchRole(role: DispatchRole): RoleGateRole {
  return role;
}

function payloadGeneration(row: ReviewJobRecord): number {
  const payload = row.payload as { generation?: unknown } | null;
  const gen = payload?.generation;
  return typeof gen === "number" && Number.isFinite(gen) && gen >= 0 ? Math.floor(gen) : 0;
}

/**
 * Deterministic Job name: the generation as well as the row id, because a row
 * can legitimately run again while its previous Job still exists. Attempt is
 * included too so a requeued row (same id, new attempt) gets a fresh name
 * while a repeated create for the same state returns `AlreadyExists`.
 */
export function dispatchJobName(role: DispatchRole, row: ReviewJobRecord): string {
  return `jumi-${role}-${row.id}-g${payloadGeneration(row)}-a${row.attempt}`;
}

const JOB_NAME_RE = /^jumi-(engine|worker)-(\d+)-g(\d+)-a(\d+)$/;

export function parseDispatchJobName(name: string): { role: DispatchRole; rowId: number } | undefined {
  const match = JOB_NAME_RE.exec(name);
  if (!match) return undefined;
  const rowId = Number(match[2]);
  if (!Number.isInteger(rowId) || rowId <= 0) return undefined;
  return { role: match[1] as DispatchRole, rowId };
}

// ---- metrics ----

const createdCounts = new Map<string, number>();
const neverStartedCounts = new Map<string, number>();
const errorCounts = new Map<string, number>();
const activeGauges = new Map<string, number>();

function roleKey(role: DispatchRole): string {
  return role;
}

export function resetDispatchMetricsForTests(): void {
  createdCounts.clear();
  neverStartedCounts.clear();
  errorCounts.clear();
  activeGauges.clear();
}

function recordCreated(role: DispatchRole): void {
  createdCounts.set(roleKey(role), (createdCounts.get(roleKey(role)) ?? 0) + 1);
}

function recordNeverStarted(role: DispatchRole): void {
  neverStartedCounts.set(roleKey(role), (neverStartedCounts.get(roleKey(role)) ?? 0) + 1);
}

function recordDispatchError(role: DispatchRole, op: string): void {
  const key = `${roleKey(role)}\0${op}`;
  errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
}

function setActive(role: DispatchRole, count: number): void {
  activeGauges.set(roleKey(role), count);
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export function renderDispatchMetrics(): string {
  const lines = [
    "# HELP jumi_dispatch_jobs_created_total One-shot Jobs created by the control dispatcher",
    "# TYPE jumi_dispatch_jobs_created_total counter",
  ];
  for (const role of ["engine", "worker"] as const) {
    lines.push(`jumi_dispatch_jobs_created_total{role="${role}"} ${createdCounts.get(role) ?? 0}`);
  }
  lines.push("# HELP jumi_dispatch_active_jobs Active (non-complete) Jobs per role");
  lines.push("# TYPE jumi_dispatch_active_jobs gauge");
  for (const role of ["engine", "worker"] as const) {
    lines.push(`jumi_dispatch_active_jobs{role="${role}"} ${activeGauges.get(role) ?? 0}`);
  }
  lines.push("# HELP jumi_dispatch_never_started_total Jobs deleted before any pod started");
  lines.push("# TYPE jumi_dispatch_never_started_total counter");
  for (const role of ["engine", "worker"] as const) {
    lines.push(`jumi_dispatch_never_started_total{role="${role}"} ${neverStartedCounts.get(role) ?? 0}`);
  }
  lines.push("# HELP jumi_dispatch_errors_total Dispatcher errors by role and operation");
  lines.push("# TYPE jumi_dispatch_errors_total counter");
  const knownOps = ["create", "list", "delete", "template", "expire", "pods"] as const;
  const known = new Set(knownOps);
  for (const role of ["engine", "worker"] as const) {
    for (const op of knownOps) {
      lines.push(`jumi_dispatch_errors_total{role="${role}",op="${op}"} ${errorCounts.get(`${role}\0${op}`) ?? 0}`);
    }
  }
  const extras = [...errorCounts.entries()]
    .filter(([key]) => {
      const [, op] = key.split("\0");
      return !known.has(op as (typeof knownOps)[number]);
    })
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of extras) {
    const [role, op] = key.split("\0");
    lines.push(`jumi_dispatch_errors_total{role="${escapeLabel(role)}",op="${escapeLabel(op)}"} ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- K8s HTTP (plain fetch, no client library) ----

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface K8sJobObject {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string> };
  spec?: unknown;
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
    conditions?: Array<{ type?: string; status?: string }>;
  };
}

export interface K8sPodObject {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    containerStatuses?: Array<{ state?: { running?: unknown; terminated?: unknown; waiting?: unknown } }>;
  };
}

function k8sBase(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
}

function jobsCollectionUrl(apiUrl: string, namespace: string): string {
  return `${k8sBase(apiUrl)}/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`;
}

function jobUrl(apiUrl: string, namespace: string, name: string): string {
  return `${k8sBase(apiUrl)}/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}`;
}

function podsListUrl(apiUrl: string, namespace: string, jobName: string): string {
  return `${k8sBase(apiUrl)}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function isAlreadyExists(status: number): boolean {
  return status === 409;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function k8sCreateJob(opts: {
  apiUrl: string;
  namespace: string;
  token: string;
  manifest: Record<string, unknown>;
  fetchImpl?: FetchLike;
}): Promise<{ created: boolean; alreadyExists: boolean }> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(jobsCollectionUrl(opts.apiUrl, opts.namespace), {
    method: "POST",
    headers: authHeaders(opts.token),
    body: JSON.stringify(opts.manifest),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return { created: true, alreadyExists: false };
  if (isAlreadyExists(response.status)) return { created: false, alreadyExists: true };
  const text = await response.text().catch(() => "");
  throw new Error(`Job create failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ""}`);
}

export async function k8sListJobs(opts: {
  apiUrl: string;
  namespace: string;
  token: string;
  fetchImpl?: FetchLike;
}): Promise<K8sJobObject[]> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(jobsCollectionUrl(opts.apiUrl, opts.namespace), {
    method: "GET",
    headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Job list failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ""}`);
  }
  const parsed = (await readJsonBody(response)) as { items?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.items)) return [];
  return parsed.items as K8sJobObject[];
}

export async function k8sDeleteJob(opts: {
  apiUrl: string;
  namespace: string;
  token: string;
  name: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  // Orphaned pods otherwise: the Job's pods must go with it.
  const url = `${jobUrl(opts.apiUrl, opts.namespace, opts.name)}?propagationPolicy=Background`;
  const response = await fetchImpl(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok || response.status === 404) return;
  const text = await response.text().catch(() => "");
  throw new Error(`Job delete failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ""}`);
}

export async function k8sListPodsForJob(opts: {
  apiUrl: string;
  namespace: string;
  token: string;
  jobName: string;
  fetchImpl?: FetchLike;
}): Promise<K8sPodObject[]> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(podsListUrl(opts.apiUrl, opts.namespace, opts.jobName), {
    method: "GET",
    headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Pod list failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ""}`);
  }
  const parsed = (await readJsonBody(response)) as { items?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.items)) return [];
  return parsed.items as K8sPodObject[];
}

// ---- template ----

export async function loadJobTemplate(templateFile: string): Promise<Record<string, unknown>> {
  const raw = await readFile(templateFile, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Job template must contain a JSON object: ${templateFile}`);
  }
  return parsed as Record<string, unknown>;
}

function cloneTemplate(template: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
}

/**
 * Fill in only the name and the row id. Security settings, resources,
 * volumes, and labels stay in GitOps: nothing else is touched, and any
 * `ownerReference` is stripped (never point one at anything that rolls).
 */
export function buildJobManifest(
  template: Record<string, unknown>,
  name: string,
  rowId: number
): Record<string, unknown> {
  const manifest = cloneTemplate(template);
  const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
  metadata.name = name;
  delete metadata.resourceVersion;
  delete metadata.uid;
  delete metadata.creationTimestamp;
  delete metadata.generation;
  // Never adopt a rolling owner: the Job outlives any single replica.
  delete (metadata as Record<string, unknown>).ownerReferences;
  manifest.metadata = metadata;
  // The row id rides as env so the one-shot pod knows which row to lease.
  // Only this env is touched; image, serviceAccount, securityContext,
  // volumes, and labels stay exactly as GitOps mounted them.
  const spec = manifest.spec as Record<string, unknown> | undefined;
  const podTemplate = spec?.template as Record<string, unknown> | undefined;
  const podSpec = podTemplate?.spec as Record<string, unknown> | undefined;
  const containers = podSpec?.containers;
  if (Array.isArray(containers)) {
    for (const container of containers) {
      if (!container || typeof container !== "object" || Array.isArray(container)) continue;
      const rec = container as Record<string, unknown>;
      const env = Array.isArray(rec.env) ? (rec.env as Array<Record<string, unknown>>) : [];
      const existing = env.find((entry) => entry?.name === JOB_ID_ENV);
      if (existing) existing.value = String(rowId);
      else env.push({ name: JOB_ID_ENV, value: String(rowId) });
      rec.env = env;
    }
  }
  return manifest;
}

// ---- job state helpers ----

function jobSucceeded(job: K8sJobObject): boolean {
  if ((job.status?.succeeded ?? 0) >= 1) return true;
  return (job.status?.conditions ?? []).some((c) => c.type === "Complete" && c.status === "True");
}

function jobFailed(job: K8sJobObject): boolean {
  if ((job.status?.failed ?? 0) >= 1) return true;
  return (job.status?.conditions ?? []).some((c) => c.type === "Failed" && c.status === "True");
}

function jobCreationMs(job: K8sJobObject): number | undefined {
  const raw = job.metadata?.creationTimestamp;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function podStarted(pod: K8sPodObject): boolean {
  const phase = pod.status?.phase;
  if (phase === "Running" || phase === "Succeeded" || phase === "Failed") return true;
  for (const cs of pod.status?.containerStatuses ?? []) {
    if (cs.state?.running != null || cs.state?.terminated != null) return true;
  }
  return false;
}

// ---- dispatch tick ----

export interface DispatchTickDeps {
  now?: () => number;
  fetchImpl?: FetchLike;
  k8sToken?: string;
  k8sTokenFile?: string;
  logger?: (message: string) => void;
  namespace?: string;
  startupTimeoutMs?: number;
}

async function readK8sToken(tokenFile: string | undefined, fallback: string | undefined): Promise<string> {
  if (tokenFile) {
    try {
      const fresh = (await readFile(tokenFile, "utf8")).trim();
      if (fresh) return fresh;
    } catch {
      // Fall through to the explicit token (tests, local/dev).
    }
  }
  return fallback ?? "";
}

export interface DispatchRoleResult {
  role: DispatchRole;
  created: number;
  active: number;
  skipped: boolean;
  skipReason?: string;
}

async function dispatchOneRole(opts: {
  role: DispatchRole;
  store: ReviewJobStore;
  maxJobs: number;
  templateFile: string;
  apiUrl: string;
  namespace: string;
  token: string;
  startupTimeoutMs: number;
  nowMs: number;
  fetchImpl?: FetchLike;
  logger: (message: string) => void;
}): Promise<DispatchRoleResult> {
  const { role, store, maxJobs, templateFile, apiUrl, namespace, token, startupTimeoutMs, nowMs } = opts;
  const logger = opts.logger;

  // Cooldown/breaker: start nothing while the gate is closed. Reconcile still
  // runs below so dead/never-started Jobs do not wedge the cap.
  let gateBlocked = false;
  try {
    gateBlocked = !(await store.mayStartWork(roleGateForDispatchRole(role), new Date(nowMs)));
  } catch (err) {
    recordDispatchError(role, "list");
    logger(`dispatch ${role}: gate read failed: ${err instanceof Error ? err.message : String(err)}`);
    return { role, created: 0, active: 0, skipped: true, skipReason: "gate read failed" };
  }

  let template: Record<string, unknown>;
  try {
    template = await loadJobTemplate(templateFile);
  } catch (err) {
    recordDispatchError(role, "template");
    logger(`dispatch ${role}: template read failed: ${err instanceof Error ? err.message : String(err)}`);
    return { role, created: 0, active: 0, skipped: true, skipReason: "template read failed" };
  }

  let jobs: K8sJobObject[];
  try {
    jobs = await k8sListJobs({ apiUrl, namespace, token, fetchImpl: opts.fetchImpl });
  } catch (err) {
    recordDispatchError(role, "list");
    logger(`dispatch ${role}: job list failed: ${err instanceof Error ? err.message : String(err)}`);
    return { role, created: 0, active: 0, skipped: true, skipReason: "job list failed" };
  }

  let active = 0;
  for (const job of jobs) {
    const name = job.metadata?.name;
    if (!name) continue;
    const parsed = parseDispatchJobName(name);
    if (!parsed || parsed.role !== role) continue;
    if (jobSucceeded(job)) {
      try {
        await k8sDeleteJob({ apiUrl, namespace, token, name, fetchImpl: opts.fetchImpl });
      } catch (err) {
        recordDispatchError(role, "delete");
        logger(
          `dispatch ${role}: delete of succeeded ${name} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        active++;
      }
      continue;
    }
    if (jobFailed(job)) {
      // The pod died: expire the lease at once so the row moves within
      // seconds instead of waiting for LEASE_MS. Reclaim still counts the
      // attempt and applies MAX_JOB_ATTEMPTS. Cancelling a running job goes
      // through the ledger (#361), never through deleting its Job — this
      // path only handles Jobs the API already reports as failed.
      try {
        const row = await store.get(parsed.rowId);
        if (row && row.state === "leased") {
          await store.forceExpireLease(parsed.rowId, new Date(nowMs));
        } else if (row && row.state === "queued") {
          // The pod died before leasing (startup crash, ledger-unreachable
          // exit 1, xAI refusal exit 2): with backoffLimit 0 each becomes a
          // Failed Job without ever leasing, so expiring only leased rows
          // would delete for free and recreate forever with MAX_JOB_ATTEMPTS
          // never engaging. Lease as the dispatcher then expire at once so
          // the next reclaim counts the attempt.
          const leased = await store.leaseJobById(parsed.rowId, `dispatch-${role}`, 60_000, new Date(nowMs));
          if (leased.leased) {
            await store.forceExpireLease(parsed.rowId, new Date(nowMs));
          } else {
            // Not leasable (backoff or same-issue hold): the row already
            // throttles recreate via peekRunnable, but the failed run used
            // no attempt, so record it instead of silently deleting.
            recordDispatchError(role, "expire");
            logger(`dispatch ${role}: expire of failed ${name} skipped: ${leased.reason}`);
          }
        }
      } catch (err) {
        recordDispatchError(role, "expire");
        logger(
          `dispatch ${role}: expire of failed ${name} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        await k8sDeleteJob({ apiUrl, namespace, token, name, fetchImpl: opts.fetchImpl });
      } catch (err) {
        recordDispatchError(role, "delete");
        logger(
          `dispatch ${role}: delete of failed ${name} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        active++;
      }
      continue;
    }
    const createdAt = jobCreationMs(job);
    if (createdAt != null && nowMs - createdAt > startupTimeoutMs) {
      let pods: K8sPodObject[] = [];
      try {
        pods = await k8sListPodsForJob({ apiUrl, namespace, token, jobName: name, fetchImpl: opts.fetchImpl });
      } catch (err) {
        recordDispatchError(role, "pods");
        logger(`dispatch ${role}: pod list for ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        active++;
        continue;
      }
      if (!pods.some(podStarted)) {
        // The pod never started: delete the Job, keep the row queued with no
        // attempt used, and record the metric.
        try {
          await k8sDeleteJob({ apiUrl, namespace, token, name, fetchImpl: opts.fetchImpl });
          recordNeverStarted(role);
          logger(`dispatch ${role}: deleted never-started ${name}`);
        } catch (err) {
          recordDispatchError(role, "delete");
          logger(
            `dispatch ${role}: delete of never-started ${name} failed: ${err instanceof Error ? err.message : String(err)}`
          );
          active++;
        }
        continue;
      }
    }
    active++;
  }
  setActive(role, active);

  if (gateBlocked) {
    logger(`dispatch ${role}: breaker/cooldown active, starting nothing`);
    return { role, created: 0, active, skipped: true, skipReason: "breaker/cooldown active" };
  }

  const slots = maxJobs - active;
  if (slots <= 0) return { role, created: 0, active, skipped: true, skipReason: "cap reached" };

  let runnable: ReviewJobRecord[];
  try {
    runnable = await store.peekRunnable(kindsForDispatchRole(role), slots, new Date(nowMs));
  } catch (err) {
    recordDispatchError(role, "list");
    logger(`dispatch ${role}: runnable peek failed: ${err instanceof Error ? err.message : String(err)}`);
    return { role, created: 0, active, skipped: true, skipReason: "peek failed" };
  }
  let created = 0;
  for (const row of runnable) {
    const name = dispatchJobName(role, row);
    const manifest = buildJobManifest(template, name, row.id);
    try {
      const result = await k8sCreateJob({ apiUrl, namespace, token, manifest, fetchImpl: opts.fetchImpl });
      if (result.alreadyExists) {
        logger(`dispatch ${role}: ${name} already exists`);
        continue;
      }
      created++;
      recordCreated(role);
    } catch (err) {
      recordDispatchError(role, "create");
      logger(`dispatch ${role}: create of ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Reconciled active plus newly created: the gauge above counted pre-create
  // active; refresh it so a stopped dispatcher is told apart from idle queue.
  setActive(role, active + created);
  return { role, created, active: active + created, skipped: false };
}

export async function runDispatchTick(
  store: ReviewJobStore,
  config: ControlConfig,
  deps: DispatchTickDeps = {}
): Promise<DispatchRoleResult[]> {
  const logger = deps.logger ?? (() => {});
  const nowMs = deps.now?.() ?? Date.now();
  const namespace = deps.namespace ?? config.jobNamespace;
  const startupTimeoutMs = deps.startupTimeoutMs ?? config.jobStartupTimeoutMs;
  const token = await readK8sToken(deps.k8sTokenFile ?? config.k8sTokenFile, deps.k8sToken);
  if (!token) {
    logger("dispatch: no K8s service account token; skipping dispatch");
    return [];
  }
  const results: DispatchRoleResult[] = [];
  const roles: Array<{ role: DispatchRole; enabled: boolean; maxJobs?: number; templateFile?: string }> = [
    {
      role: "engine",
      enabled: config.dispatchEngine.enabled,
      maxJobs: config.dispatchEngine.maxJobs,
      templateFile: config.dispatchEngine.templateFile,
    },
    {
      role: "worker",
      enabled: config.dispatchWorker.enabled,
      maxJobs: config.dispatchWorker.maxJobs,
      templateFile: config.dispatchWorker.templateFile,
    },
  ];
  for (const entry of roles) {
    if (!entry.enabled) continue;
    if (entry.maxJobs == null || !entry.templateFile) {
      recordDispatchError(entry.role, "template");
      logger(`dispatch ${entry.role}: enabled without a cap and template file; refusing to start unlimited pods`);
      continue;
    }
    results.push(
      await dispatchOneRole({
        role: entry.role,
        store,
        maxJobs: entry.maxJobs,
        templateFile: entry.templateFile,
        apiUrl: config.k8sApiUrl,
        namespace,
        token,
        startupTimeoutMs,
        nowMs,
        fetchImpl: deps.fetchImpl,
        logger,
      })
    );
  }
  return results;
}
