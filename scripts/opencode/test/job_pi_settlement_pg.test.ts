import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeHarnessMode } from "../src/harness_mode.ts";
import { runOneShotJob } from "../src/job.ts";
import { buildPiAttemptStamp, piAttemptStampFromRecord } from "../src/pi_attempt.ts";
import { runPiReviewAttempt } from "../src/pi_review.ts";
import { runPiWorkerAttempt } from "../src/pi_worker.ts";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { handleIssueCancel } from "../src/worker.ts";
import { WorkerResultStore } from "../src/worker_mcp.ts";
import { makeForgeApi, makeIssueApi } from "./fakes/forge.ts";
import {
  emptyCiMethods,
  makeComment,
  makeConfig,
  makeFile,
  makeIssue,
  makeIssueJob,
  makeJob,
  makeRepo,
  makeWorkerConfig,
} from "./fixtures.ts";
import { frozenGitRunner } from "./harness/git.ts";
import { withWorkspace } from "./harness/temp.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string };

async function makeLoopback(steps: ScriptStep[]) {
  const queue = [...steps];
  const api = {
    streamSimple(model: never, _context: { messages: Array<{ role: string; content?: unknown }> }) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const next = queue.shift() ?? { text: "done" };
        if ("text" in next) {
          const msg = {
            role: "assistant",
            content: [{ type: "text", text: next.text }],
            api: (model as { api: string }).api,
            provider: (model as { provider: string }).provider,
            model: (model as { id: string }).id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: msg } as never);
          stream.push({ type: "done", reason: "stop", message: msg } as never);
          stream.end(msg as never);
          return;
        }
        const msg = {
          role: "assistant",
          content: [
            { type: "toolCall", id: `call-${Date.now()}-${Math.random()}`, name: next.tool, arguments: next.args },
          ],
          api: (model as { api: string }).api,
          provider: (model as { provider: string }).provider,
          model: (model as { id: string }).id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: msg } as never);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg } as never);
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: (msg.content as Array<never>)[0],
          partial: msg,
        } as never);
        stream.push({ type: "done", reason: "toolUse", message: msg } as never);
        stream.end(msg as never);
      });
      return stream;
    },
    stream(model: never, context: never, _opts?: never) {
      return (this as unknown as { streamSimple: (model: never, context: never) => never }).streamSimple(
        model,
        context
      );
    },
  };
  const provider = createProvider({
    id: "jumi-pi-settlement-loopback",
    name: "loopback",
    models: [
      {
        id: "loopback-1",
        name: "loopback",
        api: "openai-completions",
        provider: "jumi-pi-settlement-loopback",
        baseUrl: "http://127.0.0.1/loopback",
        input: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 16_000,
        maxTokens: 1_000,
      },
    ],
    auth: {
      apiKey: {
        name: "loopback",
        resolve: async () => ({ auth: { type: "apiKey", key: "loopback-key" }, source: "test" }),
      },
    },
    api: api as never,
  } as never);
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false } as never);
  (runtime as unknown as { registerNativeProvider: (p: unknown) => void }).registerNativeProvider(provider);
  const model = runtime.getModel("jumi-pi-settlement-loopback", "loopback-1");
  if (!model) throw new Error("loopback model missing");
  return { runtime, model };
}

function gitSync(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(proc.stderr)}`);
}

describePg("pi job settlement against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  beforeAll(async () => {
    if (!pgDatabaseUrl) return;
    sql = openTestSqlClient(pgDatabaseUrl);
    store = new PgReviewJobStore(sql);
    await store.migrate();
  });

  afterAll(async () => {
    await (sql as SqlClient | undefined)?.close?.();
  });

  beforeEach(async () => {
    if (!pgDatabaseUrl) return;
    await sql.unsafe(
      `TRUNCATE review_jobs, follow_up_wake_causes, issue_skip_latches, jumi_run_usage RESTART IDENTITY`
    );
    await sql.unsafe(`TRUNCATE role_gates`);
    await store.migrate();
  });

  test("review success via real Pi child publishes exactly once with legacy harness and usage", async () => {
    const api = makeForgeApi({
      getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
      listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    });
    await store.enqueue(makeJob({ delivery: "pi-review-ok", headSha: "headsha", prNumber: 7 }));
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const jobId = Number(ids[0]?.id);

    await withWorkspace(async (workspace) => {
      const result = await runOneShotJob({
        store,
        jobId,
        engineConfig: makeConfig({ workdir: workspace, home: workspace, opencodeWellKnownUrl: "disabled" }),
        workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
        api: api as never,
        leasedBy: "pi-settlement-review-ok",
        engineExtras: {
          gitRunner: frozenGitRunner() as never,
          workspacePreparer: async (opts: { workdir: string }) => {
            await Bun.$`mkdir -p ${opts.workdir}/src`.quiet();
            await writeFile(join(opts.workdir, "src", "demo.ts"), "old\n");
          },
          verdictContract: "legacy" as never,
          openCodeRunner: (async (opts: { workdir: string }) => {
            const { runtime, model } = await makeLoopback([{ tool: "jumi_set_verdict", args: { state: "success" } }]);
            const verdict = new ReviewVerdictStore({
              changedFiles: [{ filename: "src/demo.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
            });
            const attempt = await runPiReviewAttempt({
              workdir: opts.workdir,
              prompt: "pi settlement review",
              store: verdict,
              modelRuntime: runtime,
              model,
              baseInstructions: "base",
              timeoutMs: 30_000,
            });
            expect(attempt.status).toBe("complete");
            expect(verdict.hasVerdict()).toBe(true);
            await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), attempt.markdown);
            return { status: "ok" as const, exitCode: 0, stdout: "" };
          }) as never,
        },
      });
      expect(result.exitCode).toBe(0);
      const row = await store.get(jobId);
      expect(row?.state).toBe("succeeded");
      // Actual harness is legacy: old rows and new legacy saves read as absent.
      expect(row?.harnessMode).toBeUndefined();
      expect(normalizeHarnessMode((row as { harnessMode?: unknown })?.harnessMode)).toBe("legacy");
      // Legacy settlement carries no Pi stamp: profile/usage stay absent, never zero-filled.
      expect(piAttemptStampFromRecord((row ?? {}) as Record<string, unknown>)).toBeUndefined();
      const cols = (await sql.unsafe(
        `SELECT harness_mode, pi_profile, pi_tokens_input FROM review_jobs WHERE id = $1`,
        [jobId]
      )) as Array<{
        harness_mode: unknown;
        pi_profile: unknown;
        pi_tokens_input: unknown;
      }>;
      expect(cols[0]?.harness_mode).toBeNull();
      expect(cols[0]?.pi_profile).toBeNull();
      expect(cols[0]?.pi_tokens_input).toBeNull();
      // Valid outcome publishes the fake-forge review exactly once.
      expect(api.callsTo("createPullReview")).toHaveLength(1);
      // Per-run data carries the one-shot clone timing.
      const usage = (await sql.unsafe(`SELECT clone_seconds FROM jumi_run_usage`)) as Array<{ clone_seconds: unknown }>;
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.some((r) => r.clone_seconds != null)).toBe(true);
    });
  });

  test("review with no Pi verdict publishes no review", async () => {
    const api = makeForgeApi({
      getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
      listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    });
    await store.enqueue(makeJob({ delivery: "pi-review-missing", headSha: "headsha", prNumber: 7 }));
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const jobId = Number(ids[0]?.id);

    await withWorkspace(async (workspace) => {
      const result = await runOneShotJob({
        store,
        jobId,
        engineConfig: makeConfig({ workdir: workspace, home: workspace, opencodeWellKnownUrl: "disabled" }),
        workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
        api: api as never,
        leasedBy: "pi-settlement-review-missing",
        engineExtras: {
          gitRunner: frozenGitRunner() as never,
          workspacePreparer: async (opts: { workdir: string }) => {
            await Bun.$`mkdir -p ${opts.workdir}/src`.quiet();
            await writeFile(join(opts.workdir, "src", "demo.ts"), "old\n");
          },
          verdictContract: "legacy" as never,
          openCodeRunner: (async (opts: { workdir: string }) => {
            // Deterministic inference with no verdict: real Pi child runs, stays incomplete.
            const { runtime, model } = await makeLoopback([{ text: "no verdict, just prose" }]);
            const verdict = new ReviewVerdictStore({
              changedFiles: [{ filename: "src/demo.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
            });
            const attempt = await runPiReviewAttempt({
              workdir: opts.workdir,
              prompt: "missing verdict",
              store: verdict,
              modelRuntime: runtime,
              model,
              baseInstructions: "base",
              timeoutMs: 15_000,
            });
            expect(attempt.status).toBe("incomplete");
            expect(verdict.hasVerdict()).toBe(false);
            return { status: "ok" as const, exitCode: 0, stdout: "" };
          }) as never,
        },
      });
      expect(result.exitCode).toBe(0);
      const row = await store.get(jobId);
      // Missing verdict never becomes a success; no review is published.
      expect(row?.state).not.toBe("succeeded");
      expect(api.callsTo("createPullReview")).toHaveLength(0);
      expect(piAttemptStampFromRecord((row ?? {}) as Record<string, unknown>)).toBeUndefined();
    });
  });

  test("stale review attempt after lease loss publishes nothing; fresh attempt recovers", async () => {
    const api = makeForgeApi({
      getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
      listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    });
    await store.enqueue(makeJob({ delivery: "pi-review-stale", headSha: "headsha", prNumber: 7 }));
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const jobId = Number(ids[0]?.id);
    let releaseTool!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });

    await withWorkspace(async (workspace) => {
      const runPromise = runOneShotJob({
        store,
        jobId,
        engineConfig: makeConfig({ workdir: workspace, home: workspace, opencodeWellKnownUrl: "disabled" }),
        workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
        api: api as never,
        leasedBy: "pi-settlement-review-stale",
        engineExtras: {
          gitRunner: frozenGitRunner() as never,
          heartbeatMs: 60_000,
          workspacePreparer: async (opts: { workdir: string }) => {
            await Bun.$`mkdir -p ${opts.workdir}/src`.quiet();
            await writeFile(join(opts.workdir, "src", "demo.ts"), "old\n");
          },
          verdictContract: "legacy" as never,
          openCodeRunner: (async (opts: { workdir: string }) => {
            // Pause tool completion: the lease is revoked while the child is still running.
            await gate;
            const { runtime, model } = await makeLoopback([{ tool: "jumi_set_verdict", args: { state: "success" } }]);
            const verdict = new ReviewVerdictStore({
              changedFiles: [{ filename: "src/demo.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
            });
            const attempt = await runPiReviewAttempt({
              workdir: opts.workdir,
              prompt: "stale review",
              store: verdict,
              modelRuntime: runtime,
              model,
              baseInstructions: "base",
              timeoutMs: 30_000,
            });
            await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), attempt.markdown);
            return { status: "ok" as const, exitCode: 0, stdout: "" };
          }) as never,
        },
      });
      for (let i = 0; i < 250; i++) {
        const row = await store.get(jobId);
        if (row?.state === "leased") break;
        await Bun.sleep(20);
      }
      expect((await store.get(jobId))?.state).toBe("leased");
      // Revoke the lease mid-run, then allow the child to complete.
      expect(await store.releaseLease(jobId, "pi-settlement-review-stale")).toBe(true);
      releaseTool();
      const result = await runPromise;
      expect(result.exitCode).toBe(0);
      // Stale ownership cannot publish.
      expect(api.callsTo("createPullReview")).toHaveLength(0);
      expect((await store.get(jobId))?.state).not.toBe("succeeded");

      // Fenced recovery: a fresh attempt on the same row still settles and publishes once.
      const retryApi = makeForgeApi({
        getPRFiles: async () => [makeFile({ filename: "src/demo.ts" })],
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
      });
      await withWorkspace(async (fresh) => {
        const retry = await runOneShotJob({
          store,
          jobId,
          engineConfig: makeConfig({ workdir: fresh, home: fresh, opencodeWellKnownUrl: "disabled" }),
          workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
          api: retryApi as never,
          leasedBy: "pi-settlement-review-retry",
          engineExtras: {
            gitRunner: frozenGitRunner() as never,
            workspacePreparer: async (opts: { workdir: string }) => {
              await Bun.$`mkdir -p ${opts.workdir}/src`.quiet();
              await writeFile(join(opts.workdir, "src", "demo.ts"), "old\n");
            },
            verdictContract: "legacy" as never,
            openCodeRunner: (async (opts: { workdir: string }) => {
              const { runtime, model } = await makeLoopback([{ tool: "jumi_set_verdict", args: { state: "success" } }]);
              const verdict = new ReviewVerdictStore({
                changedFiles: [{ filename: "src/demo.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
              });
              const attempt = await runPiReviewAttempt({
                workdir: opts.workdir,
                prompt: "recovery review",
                store: verdict,
                modelRuntime: runtime,
                model,
                baseInstructions: "base",
                timeoutMs: 30_000,
              });
              await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), attempt.markdown);
              return { status: "ok" as const, exitCode: 0, stdout: "" };
            }) as never,
          },
        });
        expect(retry.exitCode).toBe(0);
        expect((await store.get(jobId))?.state).toBe("succeeded");
        expect(retryApi.callsTo("createPullReview")).toHaveLength(1);
      });
    });
  });

  test("worker success via real Pi child creates the PR exactly once with legacy harness and usage", async () => {
    const api = makeIssueApi({
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      getIssue: async () => makeIssue(),
      ...emptyCiMethods(),
    });
    await store.enqueueIssue(makeIssueJob({ delivery: "pi-worker-ok" }));
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const jobId = Number(ids[0]?.id);

    const result = await runOneShotJob({
      store,
      jobId,
      engineConfig: makeConfig({ opencodeWellKnownUrl: "disabled" }),
      workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
      api: api as never,
      leasedBy: "pi-settlement-worker-ok",
      workerExtras: {
        implement: (async () => {
          // Disposable Git: real checkout the Pi child edits; parent observes the diff.
          const dir = await mkdtemp(join(tmpdir(), "jumi-pi-settlement-worker-"));
          try {
            gitSync(["init"], dir);
            gitSync(["config", "user.email", "test@example.com"], dir);
            gitSync(["config", "user.name", "test"], dir);
            await writeFile(join(dir, "app.txt"), "broken\n");
            await writeFile(join(dir, "check.sh"), "#!/bin/sh\ngrep -q fixed app.txt\n");
            gitSync(["add", "-A"], dir);
            gitSync(["commit", "-m", "init"], dir);
            const { runtime, model } = await makeLoopback([
              { tool: "edit", args: { path: "app.txt", edits: [{ oldText: "broken", newText: "fixed" }] } },
              { tool: "bash", args: { command: "sh check.sh" } },
              { tool: "jumi_set_pr_body", args: { markdown: "fix the app" } },
              { tool: "jumi_set_handoff", args: { notes: "edited app.txt, check.sh passes" } },
            ]);
            const workerStore = new WorkerResultStore();
            const attempt = await runPiWorkerAttempt({
              workdir: dir,
              intent: "implement",
              prompt: "fix app.txt so check.sh passes",
              store: workerStore,
              modelRuntime: runtime,
              model,
              timeoutMs: 30_000,
            });
            expect(attempt.status).toBe("complete");
            expect(attempt.dirty).toBe(true);
            expect(attempt.diff).toContain("fixed");
            expect(workerStore.getPrBody()).toContain("fix the app");
            const check = Bun.spawnSync(["sh", "check.sh"], { cwd: dir });
            expect(check.exitCode).toBe(0);
            // Parent-owned release: exactly one fake-forge PR for the valid outcome.
            const pr = await (
              api.createPullRequest as unknown as (
                owner: string,
                repo: string,
                pull: unknown
              ) => Promise<{ number: number; html_url: string }>
            )("kirmanak", "demo", {
              title: "Fix the thing",
              body: workerStore.getPrBody() ?? "fix",
              head: "jumi/issue-12",
              base: "main",
            });
            return { status: "pr" as const, prNumber: pr.number, htmlUrl: pr.html_url };
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }) as never,
      },
    });
    expect(result.exitCode).toBe(0);
    const row = await store.get(jobId);
    expect(row?.state).toBe("succeeded");
    expect(row?.harnessMode).toBeUndefined();
    expect(piAttemptStampFromRecord((row ?? {}) as Record<string, unknown>)).toBeUndefined();
    expect(api.callsTo("createPullRequest")).toHaveLength(1);
    expect((await store.get(jobId))?.state).toBe("succeeded");
  });

  test("cancelled worker ownership after real Pi start publishes no PR", async () => {
    const api = makeIssueApi({
      getRepo: async () => makeRepo(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      getIssue: async () => makeIssue(),
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_o: string, _r: string, _n: number, body: string) => makeComment({ body }),
      updateIssueComment: async (_o: string, _r: string, id: number, body: string) => makeComment({ id, body }),
      ...emptyCiMethods(),
    });
    await store.enqueueIssue(makeIssueJob({ delivery: "pi-worker-cancel" }));
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const jobId = Number(ids[0]?.id);
    let releaseTool!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });

    const runPromise = runOneShotJob({
      store,
      jobId,
      engineConfig: makeConfig({ opencodeWellKnownUrl: "disabled" }),
      workerConfig: makeWorkerConfig({ opencodeWellKnownUrl: "disabled" }),
      api: api as never,
      leasedBy: "pi-settlement-worker-cancel",
      workerExtras: {
        heartbeatMs: 50,
        implement: (async (opts: { abortSignal?: AbortSignal }) => {
          // Real Pi child starts in a disposable checkout, then the test cancels ownership.
          const dir = await mkdtemp(join(tmpdir(), "jumi-pi-settlement-cancel-"));
          try {
            gitSync(["init"], dir);
            gitSync(["config", "user.email", "test@example.com"], dir);
            gitSync(["config", "user.name", "test"], dir);
            await writeFile(join(dir, "app.txt"), "broken\n");
            gitSync(["add", "-A"], dir);
            gitSync(["commit", "-m", "init"], dir);
            const { runtime, model } = await makeLoopback([
              { tool: "jumi_set_pr_body", args: { markdown: "should never publish" } },
            ]);
            await gate;
            // Fenced stale check: cancelled ownership must not reach the forge even if
            // the in-process abort has not fired yet.
            if (opts.abortSignal?.aborted || (await store.isCancelRequested(jobId))) {
              return { status: "cancelled" as const };
            }
            const workerStore = new WorkerResultStore();
            const attempt = await runPiWorkerAttempt({
              workdir: dir,
              intent: "implement",
              prompt: "cancelled before publish",
              store: workerStore,
              modelRuntime: runtime,
              model,
              abortSignal: opts.abortSignal,
              timeoutMs: 15_000,
            });
            void attempt;
            if (opts.abortSignal?.aborted || (await store.isCancelRequested(jobId))) {
              return { status: "cancelled" as const };
            }
            await (
              api.createPullRequest as unknown as (owner: string, repo: string, pull: unknown) => Promise<unknown>
            )("kirmanak", "demo", {});
            return { status: "pr" as const, prNumber: 3, htmlUrl: "https://example.test/pr/3" };
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }) as never,
      },
    });
    for (let i = 0; i < 250; i++) {
      const row = await store.get(jobId);
      if (row?.state === "leased") break;
      await Bun.sleep(20);
    }
    expect((await store.get(jobId))?.state).toBe("leased");
    await withWorkspace(async (home) => {
      await handleIssueCancel(makeWorkerConfig({ home }), api as never, "kirmanak", "demo", 12, undefined, store);
      releaseTool();
      const result = await runPromise;
      expect(result.exitCode).toBe(0);
      expect((await store.get(jobId))?.state).toBe("cancelled");
      // Cancelled ownership never reaches the fake forge.
      expect(api.callsTo("createPullRequest")).toHaveLength(0);
    });
  });

  test("pi stamp persists on postgres and old rows still read as absent", async () => {
    await store.enqueue(makeJob({ delivery: "pi-stamp-legacy", headSha: "headsha", prNumber: 7 }));
    const ids = (await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`)) as Array<{ id: unknown }>;
    const legacyId = Number(ids[0]?.id);
    const leased = await store.lease("pi-stamp-owner", 60_000, new Date(), ["review"] as never);
    expect(leased?.id).toBe(legacyId);
    // Old rows predate every pi column: the stamp reads as absent.
    expect(piAttemptStampFromRecord((leased ?? {}) as Record<string, unknown>)).toBeUndefined();
    const stamp = buildPiAttemptStamp({
      route: {
        name: "pi-zen-main",
        provider: "opencode",
        model: "example-code-large",
        endpoint: "https://opencode.ai/zen/v1",
        fundingPool: "workspace-balance-pool",
        payer: "workspace-balance",
        credentialRef: "env:EXAMPLE_ZEN_KEY_A",
        scopes: ["public", "private"],
      } as never,
      role: "review",
      outcome: "ok",
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    await store.saveResult(legacyId, "pi-stamp-owner", {
      kind: "markdown",
      markdown: "hello",
      harnessMode: "pi",
      piAttempt: stamp,
    } as never);
    const after = await store.get(legacyId);
    expect(after?.harnessMode).toBe("pi");
    expect(after?.piProfile).toBe("pi-zen-main");
    expect(after?.piModel).toBe("example-code-large");
    expect(after?.piTokensInput).toBe(5);
    expect(after?.piTokensOutput).toBe(6);
    expect(after?.piTokensCacheWrite).toBeUndefined();
    const cols = (await sql.unsafe(
      `SELECT pi_profile, pi_model, pi_tokens_input, pi_tokens_cache_write FROM review_jobs WHERE id = $1`,
      [legacyId]
    )) as Array<{
      pi_profile: unknown;
      pi_model: unknown;
      pi_tokens_input: unknown;
      pi_tokens_cache_write: unknown;
    }>;
    expect(cols[0]?.pi_profile).toBe("pi-zen-main");
    expect(Number(cols[0]?.pi_tokens_input)).toBe(5);
    expect(cols[0]?.pi_tokens_cache_write).toBeNull();
    expect(ModelRuntime).toBeDefined();
  });
});
