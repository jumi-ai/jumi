import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_LOOKUP_BUDGET_MS,
  CI_PENDING_REASON,
  encodeCiAbsentWait,
  encodeCiPendingWait,
  isCiWaitMarker,
} from "../src/ci.ts";
import type { ControlConfig } from "../src/control_config.ts";
import {
  type K8sJobObject,
  parseDispatchJobName,
  resetDispatchMetricsForTests,
  runDispatchTick,
} from "../src/dispatch.ts";
import type { ReviewApi } from "../src/review.ts";
import { enqueueCiWakeWithGate, enqueueReviewWithCiGate } from "../src/review_gate.ts";
import { MemoryReviewJobStore, REVIEW_KIND, renderQueueMetrics } from "../src/review_jobs.ts";
import { processEngineTick } from "../src/server.ts";
import { emptyCiMethods, makeComment, makeConfig, makeFile, makeIssue, makeJob, makePR, makeRepo } from "./fixtures.ts";

function makeCiApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_o, _r, _i, body) => makeComment({ body }),
    updateIssueComment: async (_o, _r, id, body) => makeComment({ id, body }),
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async () => ({ state: "success" }) as never,
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  };
  return { ...defaults, ...overrides };
}

function pendingApi(): ReviewApi {
  return makeCiApi({
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "pending" }],
  });
}

function successApi(): ReviewApi {
  return makeCiApi({
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  });
}

function emptyApi(): ReviewApi {
  return makeCiApi({
    listCommitStatuses: async () => [],
    listCheckRuns: async () => [],
    listActionJobs: async () => [],
  });
}

interface FakeK8s {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  jobs: Map<string, K8sJobObject & { creationMs: number }>;
  creates: string[];
}

function createFakeK8s(): FakeK8s {
  const jobs = new Map<string, K8sJobObject & { creationMs: number }>();
  const creates: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/apis/batch/v1/namespaces/") && url.endsWith("/jobs") && method === "POST") {
      const manifest = JSON.parse(String(init?.body ?? "{}")) as K8sJobObject;
      const name = manifest.metadata?.name ?? "";
      creates.push(name);
      if (jobs.has(name)) {
        return new Response(JSON.stringify({ reason: "AlreadyExists" }), { status: 409 });
      }
      jobs.set(name, {
        ...manifest,
        metadata: { ...(manifest.metadata ?? {}), creationTimestamp: new Date().toISOString() },
        status: {},
        creationMs: Date.now(),
      } as K8sJobObject & { creationMs: number });
      return new Response(JSON.stringify({ metadata: { name } }), { status: 201 });
    }
    if (url.includes("/apis/batch/v1/namespaces/") && url.endsWith("/jobs") && method === "GET") {
      const items = [...jobs.entries()].map(([name, job]) => ({
        metadata: { name, creationTimestamp: new Date(job.creationMs).toISOString() },
        status: (job as K8sJobObject).status ?? {},
      }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    if (url.includes("/apis/batch/v1/namespaces/") && url.includes("/jobs/") && method === "DELETE") {
      const name = decodeURIComponent(url.split("/jobs/")[1]?.split("?")[0] ?? "");
      jobs.delete(name);
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.includes("/api/v1/namespaces/") && url.includes("/pods")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return { fetchImpl, jobs, creates };
}

function baseTemplate(): Record<string, unknown> {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "placeholder" },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: {} },
        spec: {
          restartPolicy: "Never",
          containers: [{ name: "job", image: "img", env: [] }],
        },
      },
    },
  };
}

async function writeTemplate(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-ci-gate-"));
  const file = join(dir, "job.json");
  await writeFile(file, JSON.stringify(baseTemplate()), "utf8");
  return { dir, file };
}

function engineConfig(templateFile: string): ControlConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    home: "/data",
    role: "control",
    secretName: "codex-token",
    secretNamespace: "default",
    k8sApiUrl: "https://k8s.test",
    k8sTokenFile: "/nonexistent",
    k8sCaFile: "/nonexistent-ca.crt",
    pollMs: 60_000,
    databaseUrl: undefined,
    jobNamespace: "test-ns",
    jobStartupTimeoutMs: 10 * 60 * 1000,
    dispatchPollMs: 10_000,
    dispatchEngine: { enabled: true, maxJobs: 2, templateFile },
    dispatchWorker: { enabled: false },
  };
}

describe("CI gate: pending creates no Job until CI completes", () => {
  test("review queued while CI pending creates no Job until CI completes, then exactly one", async () => {
    resetDispatchMetricsForTests();
    const { dir, file } = await writeTemplate();
    try {
      const store = new MemoryReviewJobStore();
      const now = Date.now();
      const job = makeJob({ headSha: "pending-sha", prUpdatedAt: new Date(now).toISOString() });
      const gated = await enqueueReviewWithCiGate(store, job, {
        ciApi: pendingApi(),
        home: "/tmp/jumi-ci-gate",
        nowMs: now,
      });
      expect(gated.queued).toBe(true);
      const row = store.rows.find((r) => r.jobKey === gated.key)!;
      expect(row.state).toBe("queued");
      expect(row.leasedUntil).not.toBeNull();
      expect(isCiWaitMarker(row.error)).toBe(true);

      // No dispatchable rows: peek + dispatch create nothing.
      expect(await store.peekRunnable([REVIEW_KIND], 10, new Date(now))).toEqual([]);
      const fake = createFakeK8s();
      const first = await runDispatchTick(store, engineConfig(file), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        now: () => now,
      });
      expect(first[0].created).toBe(0);
      expect(fake.jobs.size).toBe(0);

      // CI completes: the status wake promotes the same row, no new row.
      const wake = await enqueueCiWakeWithGate(store, job, {
        ciApi: successApi(),
        home: "/tmp/jumi-ci-gate",
        nowMs: now + 1000,
      });
      expect(wake.queued).toBe(false);
      const promoted = store.rows.find((r) => r.jobKey === gated.key)!;
      expect(promoted.state).toBe("queued");
      expect(promoted.leasedUntil).toBeNull();
      expect(promoted.error).toBeNull();
      expect(store.rows.filter((r) => r.jobKey === gated.key)).toHaveLength(1);

      expect((await store.peekRunnable([REVIEW_KIND], 10, new Date(now + 1000))).map((r) => r.id)).toEqual([
        promoted.id,
      ]);
      const second = await runDispatchTick(store, engineConfig(file), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        now: () => now + 1000,
      });
      expect(second[0].created).toBe(1);
      expect(fake.jobs.size).toBe(1);
      const name = [...fake.jobs.keys()][0]!;
      expect(parseDispatchJobName(name)?.rowId).toBe(promoted.id);

      // Exactly one Job: a repeat tick does not create another.
      const third = await runDispatchTick(store, engineConfig(file), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        now: () => now + 2000,
      });
      expect(third[0].created).toBe(0);
      expect(fake.jobs.size).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("wake while CI still pending keeps the wait and creates no Job", async () => {
    const store = new MemoryReviewJobStore();
    const now = Date.now();
    const job = makeJob({ headSha: "still-pending" });
    await enqueueReviewWithCiGate(store, job, { ciApi: pendingApi(), home: "/tmp", nowMs: now });
    const wake = await enqueueCiWakeWithGate(store, job, { ciApi: pendingApi(), home: "/tmp", nowMs: now + 5000 });
    expect(wake.queued).toBe(false);
    expect("waiting" in wake && wake.waiting).toBe(true);
    expect(await store.peekRunnable([REVIEW_KIND], 10, new Date(now + 5000))).toEqual([]);
    const row = store.rows[0]!;
    expect(isCiWaitMarker(row.error)).toBe(true);
    expect(row.leasedUntil).not.toBeNull();
  });
});

describe("CI gate: no checks become dispatchable after the lookup budget", () => {
  test("head with no CI checks becomes dispatchable after the lookup budget", async () => {
    resetDispatchMetricsForTests();
    const { dir, file } = await writeTemplate();
    try {
      const store = new MemoryReviewJobStore();
      const now = Date.now();
      const job = makeJob({ headSha: "no-ci-sha" });
      await enqueueReviewWithCiGate(store, job, { ciApi: emptyApi(), home: "/tmp", nowMs: now });
      const row = store.rows[0]!;
      expect(isCiWaitMarker(row.error)).toBe(true);
      expect(row.leasedUntil).toBe(now + CI_LOOKUP_BUDGET_MS);

      expect(await store.peekRunnable([REVIEW_KIND], 10, new Date(now))).toEqual([]);
      const fake = createFakeK8s();
      const before = await runDispatchTick(store, engineConfig(file), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        now: () => now,
      });
      expect(before[0].created).toBe(0);

      // Budget expiry makes it dispatchable without any wake.
      const after = new Date(now + CI_LOOKUP_BUDGET_MS + 1000);
      expect((await store.peekRunnable([REVIEW_KIND], 10, after)).map((r) => r.id)).toEqual([row.id]);
      const tick = await runDispatchTick(store, engineConfig(file), {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        now: () => after.getTime(),
      });
      expect(tick[0].created).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CI gate: slots and waiting rows", () => {
  test("with both slots full and one row waiting, a dispatchable row is taken next", async () => {
    resetDispatchMetricsForTests();
    const { dir, file } = await writeTemplate();
    try {
      const store = new MemoryReviewJobStore();
      const now = Date.now();
      // Waiting row is oldest but must stay hidden; all PRs differ so no
      // same-PR cancellation interferes.
      await store.enqueue(makeJob({ headSha: "waiting-sha", prNumber: 90, delivery: "d-wait" }), {
        waitUntilMs: now + 60_60_1000,
        waitMarker: encodeCiPendingWait(now),
        nowMs: now,
      });
      await store.enqueue(makeJob({ headSha: "slot-a", prNumber: 101, delivery: "d-a" }));
      await store.enqueue(makeJob({ headSha: "slot-b", prNumber: 102, delivery: "d-b" }));
      await store.enqueue(makeJob({ headSha: "ready-sha", prNumber: 91, delivery: "d-ready" }));
      const runnableIds = (await store.peekRunnable([REVIEW_KIND], 10, new Date(now))).map((r) => r.headSha);
      expect(runnableIds).not.toContain("waiting-sha");
      expect(runnableIds).toContain("ready-sha");

      const fake = createFakeK8s();
      const config = engineConfig(file);
      const first = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        now: () => now,
      });
      expect(first[0].created).toBe(2);
      expect(fake.jobs.size).toBe(2);
      for (const name of fake.jobs.keys()) {
        const parsed = parseDispatchJobName(name)!;
        const row = await store.get(parsed.rowId);
        expect(row?.headSha).not.toBe("waiting-sha");
        // Simulate running pods leasing their rows so they leave the queue.
        const leased = await store.leaseJobById(parsed.rowId, `pod-${parsed.rowId}`, 15 * 60_000, new Date(now));
        expect(leased.leased).toBe(true);
      }
      // Free one slot (simulate a finished Job) and tick again: the ready row
      // is taken next, the waiting row stays hidden.
      const finished = [...fake.jobs.keys()][0]!;
      const parsed = parseDispatchJobName(finished)!;
      const holder = `pod-${parsed.rowId}`;
      await store.markPublished(parsed.rowId, holder, { state: "succeeded" });
      const jobObj = fake.jobs.get(finished)! as K8sJobObject;
      (jobObj as { status?: unknown }).status = { succeeded: 1 };
      const beforeSecond = new Set([...fake.jobs.keys()]);
      const second = await runDispatchTick(store, config, {
        fetchImpl: fake.fetchImpl,
        k8sToken: "t",
        logger: () => {},
        now: () => now + 1000,
      });
      expect(second[0].created).toBe(1);
      const newest = [...fake.jobs.keys()].find((n) => !beforeSecond.has(n))!;
      expect(newest).toBeDefined();
      const newestRow = await store.get(parseDispatchJobName(newest)!.rowId);
      // The waiting row (pr 90) is still hidden; the next dispatchable by
      // createdAt order after slot-a/slot-b is the ready row (pr 91).
      expect(newestRow?.headSha).not.toBe("waiting-sha");
      expect(newestRow?.headSha).toBe("ready-sha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CI gate: required-context narrowing", () => {
  type GateStatus = { id: number; context: string; status: "pending" | "success" | "failure" };
  function requiredApi(statuses: GateStatus[], required: string[]) {
    const base = makeCiApi({
      listCommitStatuses: async () => statuses,
      getPR: async () => makePR(),
    });
    return {
      ...base,
      getBranch: async () => ({ enableStatusCheck: true, requiredContexts: required }),
    } as unknown as ReviewApi & {
      getBranch: () => Promise<{ enableStatusCheck: boolean; requiredContexts: string[] }>;
    };
  }

  test("required success with a non-required pending check enqueues dispatchable", async () => {
    const store = new MemoryReviewJobStore();
    const now = Date.now();
    const job = makeJob({ headSha: "required-done" });
    const lines: string[] = [];
    const gated = await enqueueReviewWithCiGate(store, job, {
      ciApi: requiredApi(
        [
          { id: 1, context: "build", status: "success" },
          { id: 2, context: "optional", status: "pending" },
        ],
        ["build"]
      ),
      home: "/tmp",
      nowMs: now,
      logger: (m) => lines.push(m),
    });
    expect(gated.queued).toBe(true);
    const row = store.rows.find((r) => r.jobKey === gated.key)!;
    expect(row.leasedUntil).toBeNull();
    expect(row.error).toBeNull();
    expect(lines.some((l) => l.includes("required checks done, ignoring pending optional: optional"))).toBe(true);
    expect(await store.peekRunnable([REVIEW_KIND], 10, new Date(now))).toHaveLength(1);
  });

  test("a pending required context waits", async () => {
    const store = new MemoryReviewJobStore();
    const now = Date.now();
    const job = makeJob({ headSha: "required-pending" });
    await enqueueReviewWithCiGate(store, job, {
      ciApi: requiredApi(
        [
          { id: 1, context: "build", status: "pending" },
          { id: 2, context: "optional", status: "success" },
        ],
        ["build"]
      ),
      home: "/tmp",
      nowMs: now,
    });
    const row = store.rows[0]!;
    expect(isCiWaitMarker(row.error)).toBe(true);
    expect(await store.peekRunnable([REVIEW_KIND], 10, new Date(now))).toEqual([]);
  });

  test("a required context that never reported waits", async () => {
    const store = new MemoryReviewJobStore();
    const now = Date.now();
    const job = makeJob({ headSha: "required-missing" });
    await enqueueReviewWithCiGate(store, job, {
      ciApi: requiredApi([{ id: 2, context: "optional", status: "success" }], ["build"]),
      home: "/tmp",
      nowMs: now,
    });
    const row = store.rows[0]!;
    expect(isCiWaitMarker(row.error)).toBe(true);
    expect(await store.peekRunnable([REVIEW_KIND], 10, new Date(now))).toEqual([]);
  });

  test("CI wake with a red required check and a pending optional check promotes", async () => {
    const store = new MemoryReviewJobStore();
    const now = Date.now();
    const job = makeJob({ headSha: "wake-red" });
    await enqueueReviewWithCiGate(store, job, {
      ciApi: requiredApi([{ id: 1, context: "build", status: "pending" }], ["build"]),
      home: "/tmp",
      nowMs: now,
    });
    expect(isCiWaitMarker(store.rows[0]?.error)).toBe(true);
    const failingBase = makeCiApi({
      listCommitStatuses: async () => [
        { id: 1, context: "build", status: "failure" },
        { id: 2, context: "optional", status: "pending" },
      ],
      getPR: async () => makePR(),
    });
    const failing = {
      ...failingBase,
      getBranch: async () => ({ enableStatusCheck: true, requiredContexts: ["build"] }),
    } as unknown as ReviewApi & {
      getBranch: () => Promise<{ enableStatusCheck: boolean; requiredContexts: string[] }>;
    };
    const lines: string[] = [];
    const wake = await enqueueCiWakeWithGate(store, job, {
      ciApi: failing,
      home: "/tmp",
      nowMs: now + 1000,
      logger: (m) => lines.push(m),
    });
    expect("waiting" in wake).toBe(false);
    const row = store.rows[0]!;
    expect(row.leasedUntil).toBeNull();
    expect(row.error).toBeNull();
    expect(lines.some((l) => l.includes("required checks done, ignoring pending optional: optional"))).toBe(true);
  });
});

describe("CI gate: skip-only metric", () => {
  test("ledger counts skipped CI-pending rows and exposes them on /metrics", async () => {
    const store = new MemoryReviewJobStore();
    expect(await store.countCiPendingSkips()).toBe(0);
    expect(await store.countCiWaiting()).toBe(0);
    await store.enqueue(makeJob({ headSha: "skip-sha" }));
    const leased = await store.lease("engine-1", 60_000, undefined, [REVIEW_KIND]);
    await store.markPublished(leased!.id, "engine-1", { state: "skipped", reason: CI_PENDING_REASON });
    expect(await store.countCiPendingSkips()).toBe(1);
    const metrics = await renderQueueMetrics(store);
    expect(metrics).toContain("jumi_review_ci_pending_skips_total 1");
    expect(metrics).toContain("jumi_review_ci_waiting_queued");

    await store.enqueue(makeJob({ headSha: "wait-sha", delivery: "d2" }), {
      waitUntilMs: Date.now() + 60_000,
      waitMarker: encodeCiAbsentWait(Date.now()),
    });
    expect(await store.countCiWaiting()).toBe(1);
  });

  test("job-mode CI pending skip emits a diag line", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-ci-skip-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeCiApi({
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "pending" }],
      });
      const lines: string[] = [];
      await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        api,
        "engine-1",
        {
          workspacePreparer: async () => undefined,
          gitRunner: async () => "",
        } as never,
        (m) => lines.push(m)
      );
      expect(store.rows[0]?.resultReason).toBe(CI_PENDING_REASON);
      expect(lines.some((l) => l.includes("ci_pending_skip"))).toBe(true);
      expect(await store.countCiPendingSkips()).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
