import { beforeAll, beforeEach, expect, test } from "bun:test";
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
import { createFakeK8s } from "./harness/k8s.ts";
import { withWorkspace } from "./harness/temp.ts";
import { describePg, pgDatabaseUrl } from "./pg.ts";

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
    k8sCaFile: "/nonexistent-ca.crt",
    pollMs: 60_000,
    databaseUrl: pgDatabaseUrl,
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
    if (!pgDatabaseUrl) return;
    sql = createBunSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await store.migrate();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
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
    await withWorkspace(async (dir) => {
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
    });
  });

  test("cap is respected", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("no pod for a backoff row", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("no pod for a same-issue held row", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("no pod during a cooldown", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("repeated create returns AlreadyExists", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("failed Job expires the lease and counts an attempt", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("stale failed Job does not expire the replacement run", async () => {
    await withWorkspace(async (dir) => {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const first = [...fake.jobs.keys()][0];
      const firstParsed = parseDispatchJobName(first)!;
      const firstLease = await store.leaseJobById(firstParsed.rowId, "pod-1", 60000, new Date());
      expect(firstLease.leased).toBe(true);
      await store.forceExpireLease(firstParsed.rowId, { generation: 0, attempt: 0, leasedBy: "pod-1" }, new Date());
      const reclaimed = await store.reclaimExpired(5, new Date(), 1000, WORKER_JOB_KINDS);
      expect(reclaimed.requeued.length).toBe(1);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      expect(fake.jobs.size).toBe(2);
      const second = [...fake.jobs.keys()].find((n) => n !== first)!;
      expect(parseDispatchJobName(second)!.attempt).toBe(1);
      const secondLease = await store.leaseJobById(firstParsed.rowId, "pod-2", 15 * 60 * 1000, new Date());
      expect(secondLease.leased).toBe(true);
      (fake.jobs.get(first) as K8sJobObject).status = { failed: 1 };
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
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
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1 }));
      const fake = createFakeK8s();
      const config = testConfig(templateFile);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const first = [...fake.jobs.keys()][0];
      const firstParsed = parseDispatchJobName(first)!;
      const firstLease = await store.leaseJobById(firstParsed.rowId, "pod-1", 60000, new Date());
      expect(firstLease.leased).toBe(true);
      const staleSnapshot = await store.get(firstParsed.rowId);
      await store.forceExpireLease(firstParsed.rowId, { generation: 0, attempt: 0, leasedBy: "pod-1" }, new Date());
      const reclaimed = await store.reclaimExpired(5, new Date(), 1000, WORKER_JOB_KINDS);
      expect(reclaimed.requeued.length).toBe(1);
      await runDispatchTick(store, config, { fetchImpl: fake.fetchImpl, k8sToken: "t", logger: () => {} });
      const secondLease = await store.leaseJobById(firstParsed.rowId, "pod-2", 15 * 60 * 1000, new Date());
      expect(secondLease.leased).toBe(true);
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
    });
  });

  test("row run twice gets a fresh name", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("finished Jobs leave no pods and the queue still drains", async () => {
    await withWorkspace(async (dir) => {
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
    });
  });

  test("peekRunnable excludes current Job identities before the limit", async () => {
    await store.enqueueIssue(makeIssueJob({ issueNumber: 1, delivery: "d1" }));
    await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "d2" }));
    const queued = await store.peekRunnable(WORKER_JOB_KINDS, 10);
    expect(queued).toHaveLength(2);
    const withoutExclude = await store.peekRunnable(WORKER_JOB_KINDS, 1);
    expect(withoutExclude.map((row) => row.id)).toEqual([queued[0].id]);
    const withExclude = await store.peekRunnable(WORKER_JOB_KINDS, 1, new Date(), [
      { id: queued[0].id, generation: 0, attempt: queued[0].attempt },
    ]);
    expect(withExclude.map((row) => row.id)).toEqual([queued[1].id]);
  });

  test("fills free slots past already-admitted rows", async () => {
    await withWorkspace(async (dir) => {
      const templateFile = join(dir, "job.json");
      await writeFile(templateFile, JSON.stringify(baseTemplate()), "utf8");
      await store.enqueueIssue(makeIssueJob({ issueNumber: 1, delivery: "d1" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 2, delivery: "d2" }));
      await store.enqueueIssue(makeIssueJob({ issueNumber: 3, delivery: "d3" }));
      const queued = await store.peekRunnable(WORKER_JOB_KINDS, 10);
      expect(queued).toHaveLength(3);
      const oldestName = `jumi-worker-${queued[0].id}-g0-a${queued[0].attempt}`;
      expect(parseDispatchJobName(oldestName)).toBeDefined();
      const fake = createFakeK8s();
      fake.jobs.set(oldestName, {
        metadata: { name: oldestName },
        status: {},
        creationMs: Date.now(),
      } as unknown as typeof fake.jobs extends Map<string, infer V> ? V : never);
      const config = testConfig(templateFile, 2);
      const results = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
      });
      expect(results[0].created).toBe(1);
      expect(results[0].active).toBe(2);
      expect(fake.jobs.size).toBe(2);
      expect(fake.jobs.has(oldestName)).toBe(true);
    });
  });
});
