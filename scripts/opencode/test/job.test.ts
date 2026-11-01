import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJobId, runOneShotJob } from "../src/job.ts";
import { openCodeConfigUsesXai, refuseXaiOAuth } from "../src/job_requirements.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import {
  emptyCiMethods,
  makeComment,
  makeConfig,
  makeFile,
  makeIssue,
  makeIssueJob,
  makeJob,
  makePR,
  makeRepo,
  makeWorkerConfig,
} from "./fixtures.ts";

function makeReviewApi() {
  return {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async () => makeComment(),
    updateIssueComment: async () => makeComment(),
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_o: string, _r: string, _s: string, status: { state: string }) => status,
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  } as never;
}

function frozenGitRunner() {
  return async (args: string[]) => {
    if (args[0] === "rev-parse") return "headsha";
    if (args[0] === "status") return "?? JUMI_REVIEW.md";
    if (args[0] === "ls-files") return "";
    if (args[0] === "checkout") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

describe("parseJobId", () => {
  test("requires JUMI_JOB_ID", () => {
    expect(() => parseJobId(undefined)).toThrow("JUMI_JOB_ID");
    expect(() => parseJobId("")).toThrow("JUMI_JOB_ID");
    expect(() => parseJobId("abc")).toThrow("Invalid JUMI_JOB_ID");
    expect(parseJobId("42")).toBe(42);
  });
});

describe("one-shot lease conditions", () => {
  test("row already taken exits 0 without running", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const taken = await store.lease("other-holder", 60_000);
    expect(taken).toBeDefined();
    const logs: string[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "jumi-job-taken-"));
    try {
      let ran = false;
      const result = await runOneShotJob({
        store,
        jobId: taken!.id,
        engineConfig: makeConfig({ workdir: workspace, home: workspace }),
        workerConfig: makeWorkerConfig(),
        // biome-ignore lint/suspicious/noExplicitAny: fake forge for the lease-taken path.
        api: makeReviewApi() as any,
        logger: (m) => logs.push(m),
        engineExtras: {
          gitRunner: frozenGitRunner() as never,
          workspacePreparer: async () => undefined,
          openCodeRunner: async () => {
            ran = true;
            return { status: "ok" as const, exitCode: 0, stdout: "" };
          },
        },
      });
      expect(result.exitCode).toBe(0);
      expect(ran).toBe(false);
      expect(logs.join("\n")).toMatch(/already leased|not queued|is leased/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("failed job still exits 0", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("probe", 60_000);
    expect(leased).toBeDefined();
    await store.releaseLease(leased!.id, "probe");
    const workspace = await mkdtemp(join(tmpdir(), "jumi-job-failed-"));
    try {
      const result = await runOneShotJob({
        store,
        jobId: leased!.id,
        engineConfig: makeConfig({ workdir: workspace, home: workspace }),
        workerConfig: makeWorkerConfig(),
        // biome-ignore lint/suspicious/noExplicitAny: fake forge for the failure path.
        api: makeReviewApi() as any,
        engineExtras: {
          gitRunner: frozenGitRunner() as never,
          workspacePreparer: async () => undefined,
          openCodeRunner: async () => ({
            status: "exit" as const,
            exitCode: 1,
            auth: true,
            message: "engine opencode/test: provider auth death",
          }),
        },
      });
      expect(result.exitCode).toBe(0);
      const row = await store.get(leased!.id);
      expect(row?.state).toBe("failed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("unreachable ledger exits non-zero", async () => {
    const store = new MemoryReviewJobStore();
    const broken = {
      ...store,
      get: async () => {
        throw new Error("connection refused");
      },
    } as unknown as MemoryReviewJobStore;
    const result = await runOneShotJob({
      store: broken,
      jobId: 1,
      engineConfig: makeConfig(),
      workerConfig: makeWorkerConfig(),
      // biome-ignore lint/suspicious/noExplicitAny: unreachable ledger never touches the forge.
      api: makeReviewApi() as any,
    });
    expect(result.exitCode).toBe(1);
  });
});

describe("one-shot xAI OAuth refusal", () => {
  let savedKeys: Record<string, string | undefined> = {};
  const clearStaticKeys = () => {
    savedKeys = {
      OPENCODE_API_KEY_FILE: process.env.OPENCODE_API_KEY_FILE,
      OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
      XAI_API_KEY: process.env.XAI_API_KEY,
    };
    delete process.env.OPENCODE_API_KEY_FILE;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.XAI_API_KEY;
  };
  const restoreStaticKeys = () => {
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  beforeEach(clearStaticKeys);
  afterEach(restoreStaticKeys);
  test("refuses a runner in the chain", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const row = (await store.lease("probe", 60_000))!;
    await store.releaseLease(row.id, "probe");
    const result = await runOneShotJob({
      store,
      jobId: row.id,
      engineConfig: makeConfig({
        runners: { grok: { type: "opencode", model: "xai/grok-4.6" } },
        chain: ["grok"],
      }),
      workerConfig: makeWorkerConfig(),
      // biome-ignore lint/suspicious/noExplicitAny: refusal happens before the forge is touched.
      api: makeReviewApi() as any,
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/runner/i);
    const current = await store.get(row.id);
    expect(current?.state).toBe("queued");
  });

  test("refuses a runner in independentReview groups", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const row = (await store.lease("probe", 60_000))!;
    await store.releaseLease(row.id, "probe");
    const result = await runOneShotJob({
      store,
      jobId: row.id,
      engineConfig: makeConfig({
        independentReview: {
          enabled: true,
          groups: { grok: [{ type: "opencode", model: "xai/grok-4.6" }] },
        },
      }),
      workerConfig: makeWorkerConfig(),
      // biome-ignore lint/suspicious/noExplicitAny: refusal happens before the forge is touched.
      api: makeReviewApi() as any,
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/independentReview/i);
  });

  test("refuses an OpenCode small_model pinning Grok, static keys keep working", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-job-xai-"));
    const configPath = join(dir, "opencode.json");
    await writeFile(configPath, JSON.stringify({ small_model: "xai/grok-4.6" }));
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const row = (await store.lease("probe", 60_000))!;
    await store.releaseLease(row.id, "probe");
    try {
      const refused = await runOneShotJob({
        store,
        jobId: row.id,
        engineConfig: makeConfig({ opencodeConfig: configPath, opencodeWellKnownUrl: "disabled" }),
        workerConfig: makeWorkerConfig(),
        // biome-ignore lint/suspicious/noExplicitAny: refusal happens before the forge is touched.
        api: makeReviewApi() as any,
      });
      expect(refused.exitCode).toBe(2);
      const allowed = await runOneShotJob({
        store,
        jobId: row.id,
        engineConfig: makeConfig({ opencodeConfig: configPath, opencodeWellKnownUrl: "disabled" }),
        workerConfig: makeWorkerConfig(),
        // biome-ignore lint/suspicious/noExplicitAny: static-key path still leases.
        api: makeReviewApi() as any,
        fetchImpl: (async () => {
          throw new Error("unused");
        }) as unknown as typeof fetch,
        engineExtras: {
          gitRunner: frozenGitRunner() as never,
          workspacePreparer: async () => undefined,
          openCodeRunner: async () => ({ status: "ok" as const, exitCode: 0, stdout: "" }),
        },
      });
      void allowed;
      // Static keys bypass the refusal: same config with a key file proceeds
      // past the gate (here to a skip, exit 0).
      process.env.OPENCODE_API_KEY_FILE = configPath;
      try {
        const workspace = await mkdtemp(join(tmpdir(), "jumi-job-xai-static-"));
        try {
          const withKey = await runOneShotJob({
            store,
            jobId: row.id,
            engineConfig: makeConfig({ opencodeConfig: configPath, opencodeWellKnownUrl: "disabled" }),
            workerConfig: makeWorkerConfig(),
            // biome-ignore lint/suspicious/noExplicitAny: static key path uses the fake forge.
            api: makeReviewApi() as any,
            engineExtras: {
              gitRunner: frozenGitRunner() as never,
              workspacePreparer: async () => undefined,
              openCodeRunner: async () => ({ status: "ok" as const, exitCode: 0, stdout: "" }),
            },
          });
          expect(withKey.exitCode).toBe(0);
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      } finally {
        delete process.env.OPENCODE_API_KEY_FILE;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("openCodeConfigUsesXai matches small_model and compaction", () => {
    expect(openCodeConfigUsesXai({ small_model: "xai/grok-4.6" })).toBe(true);
    expect(openCodeConfigUsesXai({ smallModel: "xai/grok-4.6" })).toBe(true);
    expect(openCodeConfigUsesXai({ agents: { compaction: { model: "xai/grok-4.6" } } })).toBe(true);
    expect(openCodeConfigUsesXai({ compaction: { model: "xai/grok-4.6" } })).toBe(true);
    expect(openCodeConfigUsesXai({ small_model: "openai/gpt-5.5" })).toBe(false);
    expect(openCodeConfigUsesXai({ model: "xai/grok-4.6" })).toBe(false);
  });

  test("refuseXaiOAuth checks the remote well-known config", async () => {
    const refusal = await refuseXaiOAuth({
      chain: [{ name: "primary", type: "opencode", model: "openai/gpt-5.5" }],
      opencodeConfigPath: undefined,
      wellKnownUrl: "https://example.test",
      fetchRemoteImpl: async () => ({ small_model: "xai/grok-4.6" }),
    });
    expect(refusal.refused).toBe(true);
    expect(refusal.reason).toMatch(/well-known/i);
  });
});

describe("one-shot SIGTERM holds the lease until the child stops", () => {
  test("abort waits for the child, then releases", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const probe = await store.lease("probe", 60_000, new Date(), ["implement", "follow-up", "conflict"]);
    expect(probe).toBeDefined();
    await store.releaseLease(probe!.id, "probe");
    const row = await store.get(probe!.id);
    expect(row?.state).toBe("queued");

    let childResolve!: () => void;
    const childDone = new Promise<void>((resolve) => {
      childResolve = resolve;
    });
    const abort = new AbortController();
    const logs: string[] = [];
    const runPromise = runOneShotJob({
      store,
      jobId: probe!.id,
      engineConfig: makeConfig(),
      workerConfig: makeWorkerConfig(),
      api: {
        getRepo: async () => makeRepo(),
        getCollaboratorPermission: async () => ({ permission: "write" }),
        getIssue: async () => makeIssue(),
      } as never,
      logger: (m) => logs.push(m),
      abortSignal: abort.signal,
      leasedBy: "one-shot-test",
      workerExtras: {
        implement: async () => {
          await childDone;
          const err = new Error("cancelled");
          err.name = "AbortError";
          throw err;
        },
      },
    });
    // Give the tick a beat to lease.
    await Bun.sleep(100);
    const leased = await store.get(probe!.id);
    expect(leased?.state).toBe("leased");
    abort.abort();
    await Bun.sleep(200);
    // Still leased while the child is running.
    const mid = await store.get(probe!.id);
    expect(mid?.state).toBe("leased");
    childResolve();
    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    const done = await store.get(probe!.id);
    expect(done?.state).not.toBe("leased");
  });
});
