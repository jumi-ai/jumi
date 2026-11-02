import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlConfig } from "../src/control_config.ts";
import { loadControlConfig } from "../src/control_config.ts";
import {
  buildJobManifest,
  dispatchJobName,
  type K8sJobObject,
  type K8sPodObject,
  k8sCreateJob,
  k8sDeleteJob,
  k8sListJobs,
  parseDispatchJobName,
  renderDispatchMetrics,
  resetDispatchMetricsForTests,
  runDispatchTick,
} from "../src/dispatch.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";

interface FakeK8s {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  jobs: Map<string, K8sJobObject & { creationMs: number }>;
  pods: Map<string, K8sPodObject[]>;
  deletes: string[];
  deleteUrls: string[];
  creates: string[];
}

function createFakeK8s(): FakeK8s {
  const jobs = new Map<string, K8sJobObject & { creationMs: number }>();
  const pods = new Map<string, K8sPodObject[]>();
  const deletes: string[] = [];
  const deleteUrls: string[] = [];
  const creates: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/apis/batch/v1/namespaces/") && url.endsWith("/jobs") && method === "POST") {
      const manifest = JSON.parse(String(init?.body ?? "{}")) as K8sJobObject;
      const name = manifest.metadata?.name ?? "";
      creates.push(name);
      if (jobs.has(name)) {
        return new Response(JSON.stringify({ reason: "AlreadyExists", message: `${name} already exists` }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      const nowIso = new Date().toISOString();
      jobs.set(name, {
        ...manifest,
        metadata: { ...(manifest.metadata ?? {}), creationTimestamp: nowIso },
        status: manifest.status ?? {},
        creationMs: Date.now(),
      } as K8sJobObject & { creationMs: number });
      return new Response(JSON.stringify({ metadata: { name } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/apis/batch/v1/namespaces/") && url.includes("/jobs/") && method === "DELETE") {
      const name = decodeURIComponent(url.split("/jobs/")[1]?.split("?")[0] ?? "");
      deletes.push(name);
      deleteUrls.push(url);
      if (!url.includes("propagationPolicy=Background")) {
        return new Response(JSON.stringify({ message: "propagationPolicy required" }), { status: 400 });
      }
      jobs.delete(name);
      pods.delete(name);
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.includes("/apis/batch/v1/namespaces/") && url.endsWith("/jobs") && method === "GET") {
      const items = [...jobs.entries()].map(([name, job]) => ({
        metadata: { name, creationTimestamp: new Date(job.creationMs).toISOString() },
        spec: (job as K8sJobObject).spec,
        status: (job as K8sJobObject).status ?? {},
      }));
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/v1/namespaces/") && url.includes("/pods") && method === "GET") {
      const selector = decodeURIComponent(url.split("labelSelector=")[1] ?? "");
      const jobName = selector.split("job-name=")[1]?.split("&")[0] ?? "";
      const items = pods.get(jobName) ?? [];
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
  return { fetchImpl, jobs, pods, deletes, deleteUrls, creates };
}

function baseTemplate(): Record<string, unknown> {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "placeholder", labels: { "jumi-role": "worker" } },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: { "jumi-role": "worker" } },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: "jumi-job",
          containers: [{ name: "job", image: "example-image:1", env: [] }],
        },
      },
    },
  };
}

function testConfig(templateFile: string, overrides: Partial<ControlConfig> = {}): ControlConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    home: "/data",
    role: "control",
    secretName: "codex-token",
    secretNamespace: "default",
    k8sApiUrl: "https://k8s.test",
    k8sTokenFile: "/nonexistent-token-file",
    pollMs: 60_000,
    databaseUrl: undefined,
    jobNamespace: "test-ns",
    jobStartupTimeoutMs: 10 * 60 * 1000,
    dispatchPollMs: 10_000,
    dispatchEngine: { enabled: false },
    dispatchWorker: { enabled: true, maxJobs: 2, templateFile },
    ...overrides,
  };
}

beforeEach(() => {
  resetDispatchMetricsForTests();
});

describe("dispatch job naming", () => {
  test("deterministic name carries generation and row id", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const row = (await store.peekRunnable(["review"], 1))[0];
    const name = dispatchJobName("engine", row);
    expect(name).toBe(`jumi-engine-${row.id}-g0-a0`);
    expect(parseDispatchJobName(name)).toEqual({ role: "engine", rowId: row.id });
    expect(parseDispatchJobName("something-else")).toBeUndefined();
  });

  test("template fill touches only the name and row id", async () => {
    const template = {
      ...baseTemplate(),
      metadata: { ...(baseTemplate().metadata as object), ownerReferences: [{ uid: "rolling" }] },
    };
    const manifest = buildJobManifest(template, "jumi-worker-7-g0-a0", 7);
    expect((manifest.metadata as { name: string }).name).toBe("jumi-worker-7-g0-a0");
    expect((manifest.metadata as Record<string, unknown>).ownerReferences).toBeUndefined();
    const containers = (
      ((manifest.spec as Record<string, unknown>).template as Record<string, unknown>).spec as Record<string, unknown>
    ).containers as Array<{ env: Array<{ name: string; value: string }> }>;
    expect(containers[0].env).toContainEqual({ name: "JUMI_JOB_ID", value: "7" });
    // Security settings, image, labels stay in GitOps.
    expect((manifest.spec as Record<string, unknown>).backoffLimit).toBe(0);
    expect(containers[0]).toMatchObject({ name: "job", image: "example-image:1" });
  });
});

describe("dispatch enablement", () => {
  test("missing cap refuses to enable dispatch", () => {
    expect(() =>
      loadControlConfig({ JUMI_ROLE: "control", CONTROL_DISPATCH_WORKER: "1" } as Record<string, string>)
    ).toThrow("CONTROL_WORKER_MAX_JOBS");
    expect(() =>
      loadControlConfig({
        JUMI_ROLE: "control",
        CONTROL_DISPATCH_ENGINE: "true",
        CONTROL_ENGINE_MAX_JOBS: "2",
      } as Record<string, string>)
    ).toThrow("CONTROL_ENGINE_JOB_TEMPLATE_FILE");
  });

  test("disabled dispatch creates nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const fake = createFakeK8s();
      const config = testConfig(templateFile, {
        dispatchWorker: { enabled: false },
        dispatchEngine: { enabled: false },
      });
      const results = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "token",
        logger: () => {},
      });
      expect(results).toEqual([]);
      expect(fake.creates).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatch runnable conditions", () => {
  test("scale from zero creates one Job per runnable row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1, delivery: "d1" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "d2" }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      const results = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "token",
        logger: () => {},
      });
      expect(results[0].created).toBe(2);
      expect(fake.jobs.size).toBe(2);
      expect(renderDispatchMetrics()).toContain('jumi_dispatch_jobs_created_total{role="worker"} 2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cap limits creation and counts active Jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1, delivery: "d1" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "d2" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 3, delivery: "d3" }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile, {
        dispatchWorker: { enabled: true, maxJobs: 2, templateFile },
      });
      const results = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "token",
        logger: () => {},
      });
      expect(results[0].created).toBe(2);
      expect(results[0].active).toBe(2);
      expect(renderDispatchMetrics()).toContain('jumi_dispatch_active_jobs{role="worker"} 2');
      // Second tick at cap creates nothing.
      const again = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "token",
        logger: () => {},
      });
      expect(again[0].created).toBe(0);
      expect(again[0].skipReason).toBe("cap reached");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no pod for a backoff row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const leased = await store.lease("holder", 60000, new Date(), WORKER_JOB_KINDS);
      expect(leased).toBeDefined();
      await store.requeueInfra(leased!.id, "holder", 60000, "infra-retry:1:123");
      const fake = createFakeK8s();
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "token",
        logger: () => {},
      });
      expect(results[0].created).toBe(0);
      expect(fake.jobs.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no pod for a same-issue held row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 12, delivery: "first" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 13, delivery: "second" }));
      // Hold issue 12 with a leased row: same-issue second row for 12 would be
      // blocked. Enqueue another row for the held issue via direct insert order.
      const held = await store.lease("pod-1", 60000, new Date(), WORKER_JOB_KINDS);
      expect(held?.issueNumber).toBe(12);
      const fake = createFakeK8s();
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "token",
        logger: () => {},
      });
      // Only issue 13 is runnable; issue 12's lease is held.
      expect(results[0].created).toBe(1);
      const names = [...fake.jobs.keys()];
      expect(names.length).toBe(1);
      const parsed = parseDispatchJobName(names[0]);
      const row = await store.get(parsed!.rowId);
      expect(row?.issueNumber).toBe(13);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no pod during a cooldown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      await store.recordRoleQuotaWait("worker", Date.now() + 60000);
      const fake = createFakeK8s();
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "token",
        logger: () => {},
      });
      expect(results[0].created).toBe(0);
      expect(results[0].skipReason).toBe("breaker/cooldown active");
      expect(fake.jobs.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no pod during a breaker open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      await store.recordRoleInfra("worker");
      await store.recordRoleInfra("worker");
      await store.recordRoleInfra("worker");
      const fake = createFakeK8s();
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "token",
        logger: () => {},
      });
      expect(results[0].created).toBe(0);
      expect(fake.jobs.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatch idempotency and failure handling", () => {
  test("repeated create returns AlreadyExists without error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      expect(fake.jobs.size).toBe(1);
      // Same row, same attempt: the name is deterministic, K8s returns 409.
      const again = await k8sCreateJob({
        apiUrl: "https://k8s.test",
        namespace: "test-ns",
        token: "t",
        manifest: { metadata: { name: [...fake.jobs.keys()][0] } },
        fetchImpl: fake.fetchImpl,
      });
      expect(again.alreadyExists).toBe(true);
      const second = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(second[0].created).toBe(0);
      expect(renderDispatchMetrics()).toContain('jumi_dispatch_errors_total{role="worker",op="create"} 0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("failed Job expires the lease at once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const name = [...fake.jobs.keys()][0];
      const parsed = parseDispatchJobName(name)!;
      // The pod leased the row, then died: Job reports failed.
      const leased = await store.leaseJobById(parsed.rowId, "job-pod", 15 * 60 * 1000, new Date());
      expect(leased.leased).toBe(true);
      const job = fake.jobs.get(name)!;
      (job as K8sJobObject).status = { failed: 1 };
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      // Failed Job is deleted with propagationPolicy=Background.
      expect(fake.jobs.has(name)).toBe(false);
      expect(fake.deleteUrls.some((u) => u.includes(name) && u.includes("propagationPolicy=Background"))).toBe(true);
      // Lease expired at once (not waiting for LEASE_MS).
      const row = await store.get(parsed.rowId);
      expect(row?.state).toBe("leased");
      expect(row?.leasedUntil).toBeLessThan(Date.now());
      // Reclaim counts the attempt and requeues (MAX_JOB_ATTEMPTS still applies).
      const reclaimed = await store.reclaimExpired(2, new Date(), 1000, WORKER_JOB_KINDS);
      expect(reclaimed.requeued.length).toBe(1);
      expect(reclaimed.requeued[0].attempt).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never-started pod is deleted with no attempt used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile, {
        dispatchWorker: { enabled: true, maxJobs: 2, templateFile },
      });
      await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        startupTimeoutMs: 10 * 60 * 1000,
      });
      const name = [...fake.jobs.keys()][0];
      const parsed = parseDispatchJobName(name)!;
      // Age the Job past the timeout with no pod ever starting.
      fake.jobs.get(name)!.creationMs = Date.now() - 11 * 60 * 1000;
      fake.pods.set(name, []);
      await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        startupTimeoutMs: 10 * 60 * 1000,
      });
      // Deleted with propagationPolicy=Background; the same queued row is
      // immediately recreated under the same deterministic name.
      expect(fake.deletes).toContain(name);
      expect(fake.deleteUrls.some((u) => u.includes(name) && u.includes("propagationPolicy=Background"))).toBe(true);
      const row = await store.get(parsed.rowId);
      expect(row?.state).toBe("queued");
      expect(row?.attempt).toBe(0);
      expect(renderDispatchMetrics()).toContain('jumi_dispatch_never_started_total{role="worker"} 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("row run twice gets a fresh name while the old Job exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile, {
        dispatchWorker: { enabled: true, maxJobs: 5, templateFile },
      });
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const first = [...fake.jobs.keys()][0];
      const parsed = parseDispatchJobName(first)!;
      // First run leased, then requeued with a new attempt while Job1 lingers.
      const leased = await store.leaseJobById(parsed.rowId, "pod-1", 60000, new Date());
      expect(leased.leased).toBe(true);
      await store.forceExpireLease(parsed.rowId, new Date());
      const reclaimed = await store.reclaimExpired(5, new Date(), 1000, WORKER_JOB_KINDS);
      expect(reclaimed.requeued.length).toBe(1);
      const second = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(second[0].created).toBe(1);
      expect(fake.jobs.size).toBe(2);
      expect(new Set(fake.jobs.keys()).size).toBe(2);
      expect([...fake.jobs.keys()]).toContain(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finished Jobs are cleaned and the queue still drains", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const name = [...fake.jobs.keys()][0];
      const parsed = parseDispatchJobName(name)!;
      // Pod finished: lease, publish terminal, Job reports success.
      const leased = await store.leaseJobById(parsed.rowId, "pod-1", 60000, new Date());
      expect(leased.leased).toBe(true);
      await store.markPublished(parsed.rowId, "pod-1", { state: "succeeded" });
      (fake.jobs.get(name) as K8sJobObject).status = { succeeded: 1 };
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      expect(fake.jobs.size).toBe(0);
      // Next enqueue still drains.
      await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "next" }));
      const next = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(next[0].created).toBe(1);
      expect(fake.jobs.size).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("k8s helpers pass propagationPolicy and list", async () => {
    const fake = createFakeK8s();
    await k8sCreateJob({
      apiUrl: "https://k8s.test",
      namespace: "ns",
      token: "t",
      manifest: { metadata: { name: "jumi-worker-1-g0-a0" } },
      fetchImpl: fake.fetchImpl,
    });
    const listed = await k8sListJobs({
      apiUrl: "https://k8s.test",
      namespace: "ns",
      token: "t",
      fetchImpl: fake.fetchImpl,
    });
    expect(listed.length).toBe(1);
    await k8sDeleteJob({
      apiUrl: "https://k8s.test",
      namespace: "ns",
      token: "t",
      name: "jumi-worker-1-g0-a0",
      fetchImpl: fake.fetchImpl,
    });
    expect(fake.jobs.size).toBe(0);
  });
});
