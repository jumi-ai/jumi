/**
 * Pi codemode isolation (jumi#997).
 *
 * Proves every isolation requirement by calling the guarded tools from a
 * codemode script and getting the same refusal as a direct call: destination
 * guard, denied commands, reviewer write attempts, non-role tool names, and
 * `models.*` blocked without any provider request. Also proves spill/image
 * files stay in job-owned scratch (never in the diff) and cancellation ends
 * a running script.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runPiReviewAttempt } from "../src/pi_review.ts";
import { type PiWorkerIntent, runPiWorkerAttempt } from "../src/pi_worker.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import { WorkerResultStore } from "../src/worker_mcp.ts";

type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string };

async function makeLoopback(steps: ScriptStep[]) {
  const queue = [...steps];
  const api = {
    streamSimple(model: never, _context: never) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const next = queue.shift() ?? { text: "done" };
        if ("text" in next) {
          const msg = {
            role: "assistant",
            content: [{ type: "text", text: (next as { text: string }).text }],
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
            {
              type: "toolCall",
              id: `call-${Date.now()}-${Math.random()}`,
              name: (next as { tool: string; args: Record<string, unknown> }).tool,
              arguments: (next as { tool: string; args: Record<string, unknown> }).args,
            },
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
      return (this as unknown as { streamSimple: (m: never, c: never) => never }).streamSimple(model, context);
    },
  };
  const provider = createProvider({
    id: "jumi-loopback",
    name: "loopback",
    models: [
      {
        id: "loopback-1",
        name: "loopback",
        api: "openai-completions",
        provider: "jumi-loopback",
        baseUrl: "http://127.0.0.1/loopback",
        input: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 16_000,
        maxTokens: 1_000,
      },
    ],
    auth: {
      apiKey: { name: "loopback", resolve: async () => ({ auth: { type: "apiKey", key: "k" }, source: "test" }) },
    },
    api: api as never,
  } as never);
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false } as never);
  (runtime as unknown as { registerNativeProvider: (p: unknown) => void }).registerNativeProvider(provider);
  const model = runtime.getModel("jumi-loopback", "loopback-1");
  if (!model) throw new Error("loopback model missing");
  return { runtime, model };
}

function gitSync(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(proc.stderr)}`);
}

async function reviewWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-pi-codemode-review-"));
  await writeFile(join(dir, "allowed.txt"), "hello\n");
  return dir;
}

async function workerFixture(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-pi-codemode-worker-"));
  gitSync(["init"], dir);
  gitSync(["config", "user.email", "t@example.com"], dir);
  gitSync(["config", "user.name", "t"], dir);
  await writeFile(join(dir, "app.txt"), "broken\n");
  gitSync(["add", "-A"], dir);
  gitSync(["commit", "-m", "init"], dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function codemodeOk(calls: Array<{ name: string; ok: boolean }>): boolean {
  return calls.some((call) => call.name === "codemode" && call.ok);
}

describe("pi codemode isolation", () => {
  test("reviewer script read succeeds, shell write denied like a direct call", async () => {
    const workdir = await reviewWorkdir();
    try {
      const { runtime, model } = await makeLoopback([
        {
          tool: "codemode",
          args: {
            code: 'const t = await tools.read({ path: "allowed.txt" }); try { await tools.bash({ command: "echo evil > pwned.txt" }); text("no-deny:" + t); } catch (e) { text("denied:" + String(e).slice(0, 80)); }',
          },
        },
        { tool: "jumi_set_verdict", args: { state: "failure", reason: "could not finish: probe" } },
      ]);
      const store = new ReviewVerdictStore({
        changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
      });
      const result = await runPiReviewAttempt({
        workdir,
        prompt: "probe",
        store,
        modelRuntime: runtime,
        model,
        timeoutMs: 20_000,
      });
      expect(codemodeOk(result.toolCalls)).toBe(true);
      expect(result.toolCalls.some((c) => c.name === "read" && c.ok)).toBe(true);
      expect(result.toolCalls.some((c) => c.name === "bash" && !c.ok)).toBe(true);
      await expect(readFile(join(workdir, "pwned.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("reviewer script write attempt fails: no write tools even through a script", async () => {
    const workdir = await reviewWorkdir();
    try {
      const { runtime, model } = await makeLoopback([
        {
          tool: "codemode",
          args: {
            code: 'try { await tools.edit({ path: "allowed.txt", edits: [{ oldText: "hello", newText: "evil" }] }); text("no-deny"); } catch (e) { text("denied:" + String(e).slice(0, 120)); }',
          },
        },
        { tool: "jumi_set_verdict", args: { state: "failure", reason: "could not finish: probe" } },
      ]);
      const store = new ReviewVerdictStore({
        changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
      });
      const result = await runPiReviewAttempt({
        workdir,
        prompt: "probe",
        store,
        modelRuntime: runtime,
        model,
        timeoutMs: 20_000,
      });
      expect(codemodeOk(result.toolCalls)).toBe(true);
      // No edit tool exists for the reviewer, so the script fails before any write.
      expect(await readFile(join(workdir, "allowed.txt"), "utf8")).toContain("hello");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("worker script write outside the worktree denied like a direct call", async () => {
    const outer = await mkdtemp(join(tmpdir(), "jumi-pi-codemode-outer-"));
    const dir = join(outer, "work");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    gitSync(["init"], dir);
    gitSync(["config", "user.email", "t@example.com"], dir);
    gitSync(["config", "user.name", "t"], dir);
    await writeFile(join(dir, "app.txt"), "broken\n");
    gitSync(["add", "-A"], dir);
    gitSync(["commit", "-m", "init"], dir);
    try {
      const { runtime, model } = await makeLoopback([
        {
          tool: "codemode",
          args: {
            code: 'try { await tools.write({ path: "../evil.txt", content: "x" }); text("no-deny"); } catch (e) { text("denied:" + String(e).slice(0, 80)); }',
          },
        },
        { tool: "jumi_set_pr_body", args: { markdown: "x" } },
        { tool: "jumi_set_handoff", args: { notes: "probe" } },
      ]);
      const store = new WorkerResultStore();
      const result = await runPiWorkerAttempt({
        workdir: dir,
        intent: "implement",
        prompt: "probe",
        store,
        modelRuntime: runtime,
        model,
        timeoutMs: 20_000,
      });
      expect(codemodeOk(result.toolCalls)).toBe(true);
      expect(result.toolCalls.some((c) => c.name === "write" && !c.ok)).toBe(true);
      await expect(readFile(join(outer, "evil.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  test("worker script denied command fails like a direct call", async () => {
    const { dir, cleanup } = await workerFixture();
    try {
      const { runtime, model } = await makeLoopback([
        {
          tool: "codemode",
          args: {
            code: 'try { await tools.bash({ command: "curl http://evil" }); text("no-deny"); } catch (e) { text("denied:" + String(e).slice(0, 80)); }',
          },
        },
        { tool: "jumi_set_pr_body", args: { markdown: "x" } },
        { tool: "jumi_set_handoff", args: { notes: "probe" } },
      ]);
      const store = new WorkerResultStore();
      const result = await runPiWorkerAttempt({
        workdir: dir,
        intent: "implement",
        prompt: "probe",
        store,
        modelRuntime: runtime,
        model,
        timeoutMs: 20_000,
      });
      expect(codemodeOk(result.toolCalls)).toBe(true);
      expect(result.toolCalls.some((c) => c.name === "bash" && !c.ok)).toBe(true);
      expect(result.destinations).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("script calling a non-role tool fails", async () => {
    const workdir = await reviewWorkdir();
    try {
      const { runtime, model } = await makeLoopback([
        {
          tool: "codemode",
          args: {
            code: 'try { await tools.grep({ pattern: "x" }); text("no-deny"); } catch (e) { text("denied:" + String(e).slice(0, 120)); }',
          },
        },
        { tool: "jumi_set_verdict", args: { state: "failure", reason: "could not finish: probe" } },
      ]);
      const store = new ReviewVerdictStore({
        changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
      });
      const result = await runPiReviewAttempt({
        workdir,
        prompt: "probe",
        store,
        modelRuntime: runtime,
        model,
        timeoutMs: 20_000,
      });
      expect(codemodeOk(result.toolCalls)).toBe(true);
      // grep is never active, so the script cannot reach it.
      expect(result.toolCalls.some((c) => c.name === "grep")).toBe(false);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("models.* fails without any provider request", async () => {
    const workdir = await reviewWorkdir();
    try {
      const { runtime, model } = await makeLoopback([
        {
          tool: "codemode",
          args: {
            code: 'try { await models.getModelsOfType("classifier"); text("no-block"); } catch (e) { text("blocked:" + String(e && e.message ? e.message : e).slice(0, 160)); }',
          },
        },
        { tool: "jumi_set_verdict", args: { state: "failure", reason: "could not finish: probe" } },
      ]);
      const store = new ReviewVerdictStore({
        changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
      });
      const result = await runPiReviewAttempt({
        workdir,
        prompt: "probe",
        store,
        modelRuntime: runtime,
        model,
        allowedFetchHosts: [],
        timeoutMs: 20_000,
      });
      expect(codemodeOk(result.toolCalls)).toBe(true);
      const codemodeText = result.toolCalls.find((c) => c.name === "codemode")?.text ?? "";
      expect(codemodeText).toMatch(/blocked|models/i);
      expect(codemodeText).not.toContain("no-block");
      expect(result.destinations).toEqual([]);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("codemode spill and image files stay in scratch, never in the diff", async () => {
    const { dir, cleanup } = await workerFixture();
    try {
      const { runtime, model } = await makeLoopback([
        {
          // Large output forces the truncation spill; image() saves a copy.
          tool: "codemode",
          args: {
            code: 'for (let i = 0; i < 2000; i++) text("line-" + i + "-" + "x".repeat(60)); image("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");',
          },
        },
        { tool: "jumi_set_pr_body", args: { markdown: "spill probe" } },
        { tool: "jumi_set_handoff", args: { notes: "spill probe" } },
      ]);
      const store = new WorkerResultStore();
      const result = await runPiWorkerAttempt({
        workdir: dir,
        intent: "implement",
        prompt: "spill",
        store,
        modelRuntime: runtime,
        model,
        timeoutMs: 30_000,
      });
      expect(codemodeOk(result.toolCalls)).toBe(true);
      const scratchDir = join(dir, ".jumi-tmp", "scratch");
      const entries = await readdir(scratchDir).catch(() => [] as string[]);
      // Spill/image files land in scratch (TMPDIR), never in the checkout diff.
      expect(result.diff).not.toContain("pi-codemode");
      expect(result.diff).not.toContain(".jumi-tmp");
      const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir });
      expect(String(status.stdout)).not.toContain("pi-codemode");
      // At least one codemode artifact exists in scratch (spill or image).
      expect(entries.some((name) => name.startsWith("pi-codemode"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("cancelling aborts a running script and its nested calls", async () => {
    const { dir, cleanup } = await workerFixture();
    try {
      const { runtime, model } = await makeLoopback([
        {
          tool: "codemode",
          args: { code: 'await tools.bash({ command: "sleep 10" }); text("no-cancel");' },
        },
      ]);
      const controller = new AbortController();
      const store = new WorkerResultStore();
      const pending = runPiWorkerAttempt({
        workdir: dir,
        intent: "implement" as PiWorkerIntent,
        prompt: "cancel",
        store,
        modelRuntime: runtime,
        model,
        abortSignal: controller.signal,
        timeoutMs: 30_000,
      });
      setTimeout(() => controller.abort(), 500);
      const result = await pending;
      expect(result.status).toBe("incomplete");
      expect(result.reason).toMatch(/abort/i);
      expect(result.toolCalls.some((c) => c.name === "codemode")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
