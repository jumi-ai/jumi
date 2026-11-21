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
import { createFakeK8s } from "./harness/k8s.ts";
import { withWorkspace } from "./harness/temp.ts";

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
    k8sCaFile: "/nonexistent-ca.crt",
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
    expect(parseDispatchJobName(name)).toEqual({ role: "engine", rowId: row.id, generation: 0, attempt: 0 });
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
    await withWorkspace(async (dir) => {
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
    });
  });
});

describe("dispatch runnable conditions", () => {
  test("scale from zero creates one Job per runnable row", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("cap limits creation and counts active Jobs", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("no pod for a backoff row", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("no pod for a same-issue held row", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("no pod during a cooldown", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("no pod during a breaker open", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });
});

describe("dispatch idempotency and failure handling", () => {
  test("repeated create returns AlreadyExists without error", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("failed Job expires the lease at once", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("stale failed Job does not expire the replacement run", async () => {
    await withWorkspace(async (dir) => {
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
      const firstParsed = parseDispatchJobName(first)!;
      // First run fails and is requeued: the row is now on the next attempt
      // while the first Job object lingers (e.g. its delete failed).
      const firstLease = await store.leaseJobById(firstParsed.rowId, "pod-1", 60000, new Date());
      expect(firstLease.leased).toBe(true);
      await store.forceExpireLease(firstParsed.rowId, { generation: 0, attempt: 0, leasedBy: "pod-1" }, new Date());
      const reclaimed = await store.reclaimExpired(5, new Date(), 1000, WORKER_JOB_KINDS);
      expect(reclaimed.requeued.length).toBe(1);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      expect(fake.jobs.size).toBe(2);
      const second = [...fake.jobs.keys()].find((n) => n !== first)!;
      expect(parseDispatchJobName(second)!.attempt).toBe(1);
      // The replacement run leased the row; the stale Job then reports failed.
      const secondLease = await store.leaseJobById(firstParsed.rowId, "pod-2", 15 * 60 * 1000, new Date());
      expect(secondLease.leased).toBe(true);
      (fake.jobs.get(first) as K8sJobObject).status = { failed: 1 };
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      // Stale Job is deleted, but the current run's lease is untouched and no
      // attempt is burned.
      expect(fake.jobs.has(first)).toBe(false);
      expect(fake.jobs.has(second)).toBe(true);
      const row = await store.get(firstParsed.rowId);
      expect(row?.state).toBe("leased");
      expect(row?.attempt).toBe(1);
      expect(row?.leasedUntil).toBeGreaterThan(Date.now());
    });
  });

  test("guarded expire leaves a replacement lease alone when the row moves mid-reconcile", async () => {
    await withWorkspace(async (dir) => {
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
      const firstParsed = parseDispatchJobName(first)!;
      const firstLease = await store.leaseJobById(firstParsed.rowId, "pod-1", 60000, new Date());
      expect(firstLease.leased).toBe(true);
      const staleSnapshot = await store.get(firstParsed.rowId);
      // Replacement attempt acquires the row before the dispatcher reconciles.
      await store.forceExpireLease(firstParsed.rowId, { generation: 0, attempt: 0, leasedBy: "pod-1" }, new Date());
      const reclaimed = await store.reclaimExpired(5, new Date(), 1000, WORKER_JOB_KINDS);
      expect(reclaimed.requeued.length).toBe(1);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const secondLease = await store.leaseJobById(firstParsed.rowId, "pod-2", 15 * 60 * 1000, new Date());
      expect(secondLease.leased).toBe(true);
      // The stale Job reports failed while the dispatcher still observes the
      // pre-replacement row: the guarded write must report no update.
      (fake.jobs.get(first) as K8sJobObject).status = { failed: 1 };
      const realGet = store.get.bind(store);
      store.get = (async () => ({ ...staleSnapshot! })) as typeof store.get;
      const logs: string[] = [];
      try {
        await runDispatchTick(store, config, {
          fetchImpl: fake.fetchImpl,
          k8sToken: "t",
          logger: (message: string) => logs.push(message),
        });
      } finally {
        store.get = realGet;
      }
      expect(fake.jobs.has(first)).toBe(false);
      const row = await store.get(firstParsed.rowId);
      expect(row?.state).toBe("leased");
      expect(row?.attempt).toBe(1);
      expect(row?.leasedBy).toBe("pod-2");
      expect(row?.leasedUntil).toBeGreaterThan(Date.now());
      expect(logs.some((message) => message.includes("stale"))).toBe(true);
    });
  });

  test("never-started pod is deleted with no attempt used", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("row run twice gets a fresh name while the old Job exists", async () => {
    await withWorkspace(async (dir) => {
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
      await store.forceExpireLease(parsed.rowId, { generation: 0, attempt: 0, leasedBy: "pod-1" }, new Date());
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
    });
  });

  test("finished Jobs are cleaned and the queue still drains", async () => {
    await withWorkspace(async (dir) => {
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
    });
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

describe("invalid inventories are errors", () => {
  function listFetch(body: string, status = 200): (input: string) => Promise<Response> {
    return async () => new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }

  test("k8sListJobs accepts valid inventories and rejects the rest", async () => {
    const opts = { apiUrl: "https://k8s.test", namespace: "ns", token: "t" };
    expect(await k8sListJobs({ ...opts, fetchImpl: listFetch(JSON.stringify({ items: [] })) })).toEqual([]);
    const nonempty = await k8sListJobs({
      ...opts,
      fetchImpl: listFetch(JSON.stringify({ items: [{ metadata: { name: "jumi-worker-1-g0-a0" } }] })),
    });
    expect(nonempty.length).toBe(1);
    await expect(k8sListJobs({ ...opts, fetchImpl: listFetch("not json{{{") })).rejects.toThrow("invalid payload");
    for (const shape of ["{}", JSON.stringify({ items: {} }), JSON.stringify({ items: "x" }), "null"]) {
      await expect(k8sListJobs({ ...opts, fetchImpl: listFetch(shape) })).rejects.toThrow("invalid payload");
    }
    await expect(k8sListJobs({ ...opts, fetchImpl: listFetch("boom", 500) })).rejects.toThrow("Job list failed");
  });

  test("invalid Job list creates nothing", async () => {
    await withWorkspace(async (dir) => {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const badFetch = listFetch("not json{{{");
      const logs: string[] = [];
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: badFetch,
        k8sToken: "t",
        logger: (message) => logs.push(message),
      });
      expect(results[0].created).toBe(0);
      expect(results[0].skipped).toBe(true);
      expect(results[0].skipReason).toBe("job list failed");
      expect(logs.some((line) => line.includes("job list failed"))).toBe(true);
      expect(renderDispatchMetrics()).toContain('jumi_dispatch_errors_total{role="worker",op="list"} 1');
    });
  });

  test("invalid Pod list deletes nothing", async () => {
    await withWorkspace(async (dir) => {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile, {
        dispatchWorker: { enabled: true, maxJobs: 2, templateFile },
      });
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const name = [...fake.jobs.keys()][0];
      fake.jobs.get(name)!.creationMs = Date.now() - 11 * 60 * 1000;
      const badPodsFetch = async (input: string, init?: RequestInit): Promise<Response> => {
        if (String(input).includes("/api/v1/namespaces/") && String(input).includes("/pods")) {
          return new Response("not json{{{", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return fake.fetchImpl(input, init);
      };
      const logs: string[] = [];
      const results = await runDispatchTick(store, config, {
        fetchImpl: badPodsFetch,
        k8sToken: "t",
        logger: (message) => logs.push(message),
        startupTimeoutMs: 10 * 60 * 1000,
      });
      expect(fake.jobs.has(name)).toBe(true);
      expect(fake.deletes).not.toContain(name);
      expect(renderDispatchMetrics()).toContain('jumi_dispatch_errors_total{role="worker",op="pods"} 1');
      expect(logs.some((line) => line.includes(`pod list for ${name} failed`))).toBe(true);
      expect(results[0].active).toBe(1);
    });
  });
});

describe("dispatch fills free slots past already-admitted rows", () => {
  test("cap 2 with the oldest row already admitted starts the next eligible row", async () => {
    await withWorkspace(async (dir) => {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1, delivery: "d1" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "d2" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 3, delivery: "d3" }));
      const queued = await store.peekRunnable(WORKER_JOB_KINDS, 10);
      expect(queued).toHaveLength(3);
      const oldestName = dispatchJobName("worker", queued[0]);
      const nextName = dispatchJobName("worker", queued[1]);
      const lastName = dispatchJobName("worker", queued[2]);
      const fake = createFakeK8s();
      fake.jobs.set(oldestName, {
        metadata: { name: oldestName },
        status: {},
        creationMs: Date.now(),
      } as unknown as typeof fake.jobs extends Map<string, infer V> ? V : never);
      const config = testConfig(templateFile, {
        dispatchWorker: { enabled: true, maxJobs: 2, templateFile },
      });
      const results = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(results[0].created).toBe(1);
      expect(results[0].active).toBe(2);
      expect(fake.jobs.size).toBe(2);
      expect(fake.jobs.has(oldestName)).toBe(true);
      expect(fake.jobs.has(nextName)).toBe(true);
      expect(fake.jobs.has(lastName)).toBe(false);
    });
  });

  test("cap reached creates nothing", async () => {
    await withWorkspace(async (dir) => {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1, delivery: "d1" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "d2" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 3, delivery: "d3" }));
      const queued = await store.peekRunnable(WORKER_JOB_KINDS, 10);
      const fake = createFakeK8s();
      for (const row of queued.slice(0, 2)) {
        const name = dispatchJobName("worker", row);
        fake.jobs.set(name, {
          metadata: { name },
          status: {},
          creationMs: Date.now(),
        } as unknown as typeof fake.jobs extends Map<string, infer V> ? V : never);
      }
      const config = testConfig(templateFile, {
        dispatchWorker: { enabled: true, maxJobs: 2, templateFile },
      });
      const results = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(results[0].created).toBe(0);
      expect(results[0].skipReason).toBe("cap reached");
      expect(fake.jobs.size).toBe(2);
    });
  });

  test("unavailable inventory with a free slot still creates nothing", async () => {
    await withWorkspace(async (dir) => {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1, delivery: "d1" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "d2" }));
      const queued = await store.peekRunnable(WORKER_JOB_KINDS, 10);
      const oldestName = dispatchJobName("worker", queued[0]);
      const fake = createFakeK8s();
      fake.jobs.set(oldestName, {
        metadata: { name: oldestName },
        status: {},
        creationMs: Date.now(),
      } as unknown as typeof fake.jobs extends Map<string, infer V> ? V : never);
      const unavailable = async () => new Response("boom", { status: 500 });
      const results = await runDispatchTick(store, testConfig(templateFile), {
        fetchImpl: unavailable,
        k8sToken: "t",
        logger: () => {},
      });
      expect(results[0].created).toBe(0);
      expect(results[0].skipped).toBe(true);
      expect(results[0].skipReason).toBe("job list failed");
      expect(fake.jobs.size).toBe(1);
    });
  });
});
