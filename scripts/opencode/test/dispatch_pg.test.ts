import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlConfig, loadControlConfig } from "../src/control_config.ts";
import {
  type K8sJobObject,
  type K8sPodObject,
  parseDispatchJobName,
  renderDispatchMetrics,
  resetDispatchMetricsForTests,
  runDispatchTick,
} from "../src/dispatch.ts";
import { createBunSqlClient, PgReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeIssueJob } from "./fixtures.ts";

const databaseUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
const describePg = databaseUrl ? describe : describe.skip;

interface FakeK8s {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  jobs: Map<string, K8sJobObject & { creationMs: number }>;
  pods: Map<string, K8sPodObject[]>;
  deleteUrls: string[];
}

function createFakeK8s(): FakeK8s {
  const jobs = new Map<string, K8sJobObject & { creationMs: number }>();
  const pods = new Map<string, K8sPodObject[]>();
  const deleteUrls: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/apis/batch/v1/namespaces/") && url.endsWith("/jobs") && method === "POST") {
      const manifest = JSON.parse(String(init?.body ?? "{}")) as K8sJobObject;
      const name = manifest.metadata?.name ?? "";
      if (jobs.has(name)) {
        return new Response(JSON.stringify({ reason: "AlreadyExists" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      jobs.set(name, {
        ...manifest,
        metadata: { ...(manifest.metadata ?? {}), creationTimestamp: new Date().toISOString() },
        status: manifest.status ?? {},
        creationMs: Date.now(),
      } as K8sJobObject & { creationMs: number });
      return new Response(JSON.stringify({ metadata: { name } }), { status: 201 });
    }
    if (url.includes("/apis/batch/v1/namespaces/") && url.includes("/jobs/") && method === "DELETE") {
      const name = decodeURIComponent(url.split("/jobs/")[1]?.split("?")[0] ?? "");
      deleteUrls.push(url);
      if (!url.includes("propagationPolicy=Background")) {
        return new Response("propagationPolicy required", { status: 400 });
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
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    if (url.includes("/api/v1/namespaces/") && url.includes("/pods") && method === "GET") {
      const selector = decodeURIComponent(url.split("labelSelector=")[1] ?? "");
      const jobName = selector.split("job-name=")[1]?.split("&")[0] ?? "";
      return new Response(JSON.stringify({ items: pods.get(jobName) ?? [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, jobs, pods, deleteUrls };
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

function testConfig(templateFile: string, maxJobs = 5): ControlConfig {
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
    databaseUrl,
    jobNamespace: "test-ns",
    jobStartupTimeoutMs: 10 * 60 * 1000,
    dispatchPollMs: 10_000,
    dispatchEngine: { enabled: false },
    dispatchWorker: { enabled: true, maxJobs, templateFile },
  };
}

describePg("dispatch against real postgres with a fake Kubernetes API", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = createBunSqlClient(databaseUrl);
    store = new PgReviewJobStore(sql);
    await store.migrate();
  });

  beforeEach(async () => {
    if (!databaseUrl) return;
    resetDispatchMetricsForTests();
    await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches, jumi_run_usage RESTART IDENTITY`);
    await sql.unsafe(`TRUNCATE role_gates`);
    await store.migrate();
  });

  test("missing cap refuses to enable dispatch", () => {
    expect(() =>
      loadControlConfig({ JUMI_ROLE: "control", CONTROL_DISPATCH_WORKER: "1" } as Record<string, string>)
    ).toThrow("CONTROL_WORKER_MAX_JOBS");
  });

  test("scale from zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1, delivery: "d1" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "d2" }));
      const fake = createFakeK8s();
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(results[0].created).toBe(2);
      expect(fake.jobs.size).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cap is respected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1, delivery: "d1" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "d2" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 3, delivery: "d3" }));
      const fake = createFakeK8s();
      const results = await runDispatchTick(store, testConfig(templateFile, 2), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(results[0].created).toBe(2);
      expect(renderDispatchMetrics()).toContain('jumi_dispatch_active_jobs{role="worker"} 2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no pod for a backoff row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const leased = await store.lease("holder", 60000, new Date(), WORKER_JOB_KINDS);
      expect(leased).toBeDefined();
      await store.requeueInfra(leased!.id, "holder", 60000, "infra-retry:1:123");
      const fake = createFakeK8s();
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(results[0].created).toBe(0);
      expect(fake.jobs.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no pod for a same-issue held row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 12, delivery: "first" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 13, delivery: "second" }));
      const held = await store.lease("pod-1", 60000, new Date(), WORKER_JOB_KINDS);
      expect(held?.issueNumber).toBe(12);
      const fake = createFakeK8s();
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(results[0].created).toBe(1);
      const name = [...fake.jobs.keys()][0];
      const parsed = parseDispatchJobName(name)!;
      const row = await store.get(parsed.rowId);
      expect(row?.issueNumber).toBe(13);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no pod during a cooldown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      await store.recordRoleQuotaWait("worker", Date.now() + 60000);
      const fake = createFakeK8s();
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(results[0].created).toBe(0);
      expect(fake.jobs.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("repeated create returns AlreadyExists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      expect(fake.jobs.size).toBe(1);
      const second = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(second[0].created).toBe(0);
      expect(fake.jobs.size).toBe(1);
      expect(renderDispatchMetrics()).toContain('jumi_dispatch_errors_total{role="worker",op="create"} 0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("failed Job expires the lease and counts an attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const name = [...fake.jobs.keys()][0];
      const parsed = parseDispatchJobName(name)!;
      const leased = await store.leaseJobById(parsed.rowId, "job-pod", 15 * 60 * 1000, new Date());
      expect(leased.leased).toBe(true);
      (fake.jobs.get(name) as K8sJobObject).status = { failed: 1 };
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      expect(fake.jobs.has(name)).toBe(false);
      expect(fake.deleteUrls.some((u) => u.includes("propagationPolicy=Background"))).toBe(true);
      const reclaimed = await store.reclaimExpired(2, new Date(), 1000, WORKER_JOB_KINDS);
      expect(reclaimed.requeued.length).toBe(1);
      expect(reclaimed.requeued[0].attempt).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never-started pod is deleted with no attempt used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        startupTimeoutMs: 10 * 60 * 1000,
      });
      const name = [...fake.jobs.keys()][0];
      const parsed = parseDispatchJobName(name)!;
      fake.jobs.get(name)!.creationMs = Date.now() - 11 * 60 * 1000;
      fake.pods.set(name, []);
      await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        startupTimeoutMs: 10 * 60 * 1000,
      });
      expect(fake.deleteUrls.some((u) => u.includes(name) && u.includes("propagationPolicy=Background"))).toBe(true);
      const row = await store.get(parsed.rowId);
      expect(row?.state).toBe("queued");
      expect(row?.attempt).toBe(0);
      expect(renderDispatchMetrics()).toContain('jumi_dispatch_never_started_total{role="worker"} 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("row run twice gets a fresh name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile, 5);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const first = [...fake.jobs.keys()][0];
      const parsed = parseDispatchJobName(first)!;
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finished Jobs leave no pods and the queue still drains", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-dispatch-pg-"));
    try {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const name = [...fake.jobs.keys()][0];
      const parsed = parseDispatchJobName(name)!;
      const leased = await store.leaseJobById(parsed.rowId, "pod-1", 60000, new Date());
      expect(leased.leased).toBe(true);
      await store.markPublished(parsed.rowId, "pod-1", { state: "succeeded" });
      (fake.jobs.get(name) as K8sJobObject).status = { succeeded: 1 };
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      expect(fake.jobs.size).toBe(0);
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
});
