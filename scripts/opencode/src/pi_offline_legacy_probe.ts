#!/usr/bin/env bun
/**
 * Offline Pi + legacy image probe (jumi#940).
 *
 * Runs the real production harnesses against in-container loopback only:
 * - Pi review: real `createAgentSession` with a scripted loopback model
 *   through `runPiReviewAttempt`; requires a structured verdict.
 * - Pi worker: real session through `runPiWorkerAttempt` on a deterministic
 *   git fixture; requires the parent-observed diff plus a passing fixture
 *   test (`sh check.sh`).
 * - Pi codemode (both roles): the same harnesses driven by a `codemode`
 *   script that calls the guarded tools; requires the nested calls to land
 *   (finding/diff) and the outer `codemode` call to appear in telemetry.
 * - Legacy startup/dispatch for both roles without Pi credentials: real
 *   `loadConfig`/`loadWorkerConfig` plus the production dispatch gates
 *   (`processEngineTick`/`processWorkerTick`) on a memory ledger.
 * - Pi failure without rescue: `JUMI_HARNESS_MODE=pi` fails process start
 *   naming `JUMI_PI_PROFILES_FILE`, an empty allowlist, or an unwired route,
 *   and both ticks attempt the Pi path without spawning legacy.
 *
 * A source import or `--version` check cannot pass this probe: every case
 * below executes the real session or the real dispatch gate. No Docker
 * socket, no privileged mode, no subscription secrets: inference is a
 * scripted in-process model plus an in-container `127.0.0.1` fixture
 * server. The workflows run this probe with `--network none`, `--read-only`,
 * `--user 10001:10001`, a fresh `HOME`, and writable `/tmp` mounts.
 *
 * Exit 0 when every case matches, 1 otherwise.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { runPiReviewAttempt } from "./pi_review.ts";
import { runPiWorkerAttempt } from "./pi_worker.ts";
import { MemoryReviewJobStore } from "./review_jobs.ts";
import { ReviewVerdictStore } from "./review_verdict_store.ts";
import { processEngineTick } from "./server.ts";
import { errorMessage } from "./util/error.ts";
import { processWorkerTick } from "./worker.ts";
import { loadWorkerConfig } from "./worker_config.ts";
import { WorkerResultStore } from "./worker_mcp.ts";

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly observed: string;
}

type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string } | { fetch: string };

async function makeLoopback(steps: ScriptStep[], fetchImpl?: typeof fetch) {
  const queue = [...steps];
  const api = {
    streamSimple(model: never, _context: { messages: Array<{ role: string; content?: unknown }> }) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        let next: ScriptStep | { text: string } = { text: "done" };
        while (queue.length > 0) {
          const peek = queue[0] as ScriptStep;
          if (!("fetch" in peek && (peek as { fetch?: string }).fetch)) break;
          queue.shift();
          try {
            const res = await (fetchImpl ?? fetch)((peek as { fetch: string }).fetch);
            await res.text().catch(() => undefined);
          } catch {}
        }
        next = queue.shift() ?? { text: "done" };
        if ("fetch" in next && (next as { fetch?: string }).fetch) return;
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
        const toolName = (next as { tool: string }).tool;
        const toolArgs = (next as { args: Record<string, unknown> }).args;
        const msg = {
          role: "assistant",
          content: [
            { type: "toolCall", id: `call-${Date.now()}-${Math.random()}`, name: toolName, arguments: toolArgs },
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
    id: "jumi-image-probe-loopback",
    name: "loopback",
    models: [
      {
        id: "loopback-1",
        name: "loopback",
        api: "openai-completions",
        provider: "jumi-image-probe-loopback",
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
  const model = runtime.getModel("jumi-image-probe-loopback", "loopback-1");
  if (!model) throw new Error("loopback model missing");
  return { runtime, model };
}

function gitSync(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(proc.stderr)}`);
}

const REVIEWER_BASE = {
  GITEA_URL: "https://gitea.example/",
  GITEA_BOT_TOKEN: "probe-bot-token",
  GITEA_WEBHOOK_SECRET: "probe-secret",
  JUMI_ROLE: "engine",
  DATABASE_URL: "postgres://probe",
};

const WORKER_BASE = {
  GITEA_URL: "https://gitea.example/",
  GITEA_BOT_TOKEN: "probe-bot-token",
  GITEA_WEBHOOK_SECRET: "probe-secret",
};

async function main(): Promise<number> {
  const results: CaseResult[] = [];
  const push = (name: string, ok: boolean, observed: string) => {
    results.push({ name, ok, observed });
  };

  // Clean-room: the probe executes the installed production modules (not a
  // host copy) with a fresh HOME isolated from ambient credentials.
  const freshHome = await mkdtemp(join(tmpdir(), "jumi-image-probe-home-"));
  const probeInInstalledTree = import.meta.dir.includes(join("scripts", "opencode", "src"));
  push(
    "probe runs the installed production path with a fresh HOME",
    probeInInstalledTree && freshHome !== process.env.HOME,
    `dir=${import.meta.dir} home=${freshHome}`
  );
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  push("probe runs under the image UID 10001", uid === 10001, `uid=${uid}`);

  // In-container loopback fixture server: proves inference stays on 127.0.0.1.
  const loopServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
  const loopPort = loopServer.port;

  // --- Pi reviewer offline: structured verdict is required ---
  try {
    const workdir = await mkdtemp(join(tmpdir(), "jumi-image-probe-review-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(workdir, "src"), { recursive: true });
      await writeFile(join(workdir, "src", "a.ts"), "x\n");
      const { runtime, model } = await makeLoopback([
        { fetch: `http://127.0.0.1:${loopPort}/inference` },
        {
          tool: "jumi_add_finding",
          args: { path: "src/a.ts", line: 1, severity: "suggestion", title: "t", body: "b" },
        },
        { tool: "jumi_set_verdict", args: { state: "success" } },
      ]);
      const store = new ReviewVerdictStore({
        changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
      });
      const result = await runPiReviewAttempt({
        workdir,
        prompt: "image probe review",
        store,
        modelRuntime: runtime,
        model,
        allowedFetchHosts: ["127.0.0.1"],
        timeoutMs: 30_000,
      });
      const markdown = store.toMarkdown();
      push(
        "pi reviewer offline yields a structured verdict through the production harness",
        result.status === "complete" &&
          store.hasVerdict() &&
          store.toRecord().state === "success" &&
          /jumi-check:\s*success/i.test(markdown) &&
          result.destinations.some((d) => d.includes(`${loopPort}/inference`)),
        `status=${result.status} verdict=${store.hasVerdict() ? store.toRecord().state : "<none>"} dest=${result.destinations.join(",") || "<none>"}`
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  } catch (err) {
    push("pi reviewer offline yields a structured verdict through the production harness", false, errorMessage(err));
  }

  // --- Pi worker offline: asserted diff plus passing fixture test ---
  try {
    const dir = await mkdtemp(join(tmpdir(), "jumi-image-probe-worker-"));
    try {
      gitSync(["init"], dir);
      gitSync(["config", "user.email", "probe@example.com"], dir);
      gitSync(["config", "user.name", "probe"], dir);
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
      const store = new WorkerResultStore();
      const result = await runPiWorkerAttempt({
        workdir: dir,
        intent: "implement",
        prompt: "fix app.txt so check.sh passes",
        store,
        modelRuntime: runtime,
        model,
        allowedFetchHosts: ["127.0.0.1"],
        timeoutMs: 30_000,
      });
      const check = Bun.spawnSync(["sh", "check.sh"], { cwd: dir });
      const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: dir });
      const committed = String(log.stdout).trim().split("\n").filter(Boolean).length;
      push(
        "pi worker offline yields the asserted diff and the fixture test passes with no commit",
        result.status === "complete" &&
          result.dirty &&
          result.diff.includes("fixed") &&
          (await readFile(join(dir, "app.txt"), "utf8")).includes("fixed") &&
          check.exitCode === 0 &&
          committed === 1 &&
          (store.getPrBody() ?? "").includes("fix the app"),
        `status=${result.status} dirty=${result.dirty} check=${check.exitCode} commits=${committed}`
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (err) {
    push(
      "pi worker offline yields the asserted diff and the fixture test passes with no commit",
      false,
      errorMessage(err)
    );
  }

  // --- Pi reviewer codemode offline: script calls guarded tools, verdict resolves ---
  try {
    const workdir = await mkdtemp(join(tmpdir(), "jumi-image-probe-review-codemode-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(workdir, "src"), { recursive: true });
      await writeFile(join(workdir, "src", "a.ts"), "x\n");
      const { runtime, model } = await makeLoopback([
        {
          tool: "codemode",
          args: {
            code: 'const t = await tools.jumi_add_finding({ path: "src/a.ts", line: 1, severity: "suggestion", title: "t", body: "b" }); text("finding:" + t);',
          },
        },
        { tool: "jumi_set_verdict", args: { state: "success" } },
      ]);
      const store = new ReviewVerdictStore({
        changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
      });
      const result = await runPiReviewAttempt({
        workdir,
        prompt: "image probe review codemode",
        store,
        modelRuntime: runtime,
        model,
        allowedFetchHosts: ["127.0.0.1"],
        timeoutMs: 30_000,
      });
      const hasCodemode = result.toolCalls.some((call) => call.name === "codemode" && call.ok);
      const hasNestedFinding = result.toolCalls.some((call) => call.name === "jumi_add_finding" && call.ok);
      push(
        "pi reviewer codemode offline completes a real review task through a script",
        result.status === "complete" &&
          store.hasVerdict() &&
          store.toRecord().state === "success" &&
          hasCodemode &&
          hasNestedFinding &&
          store.listFindings().length === 1,
        `status=${result.status} codemode=${hasCodemode} nested=${hasNestedFinding} findings=${store.listFindings().length}`
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  } catch (err) {
    push("pi reviewer codemode offline completes a real review task through a script", false, errorMessage(err));
  }

  // --- Pi worker codemode offline: script edits, fixture test passes ---
  try {
    const dir = await mkdtemp(join(tmpdir(), "jumi-image-probe-worker-codemode-"));
    try {
      gitSync(["init"], dir);
      gitSync(["config", "user.email", "probe@example.com"], dir);
      gitSync(["config", "user.name", "probe"], dir);
      await writeFile(join(dir, "app.txt"), "broken\n");
      await writeFile(join(dir, "check.sh"), "#!/bin/sh\ngrep -q fixed app.txt\n");
      gitSync(["add", "-A"], dir);
      gitSync(["commit", "-m", "init"], dir);
      const { runtime, model } = await makeLoopback([
        {
          tool: "codemode",
          args: {
            code: 'const out = await tools.edit({ path: "app.txt", edits: [{ oldText: "broken", newText: "fixed" }] }); const check = await tools.bash({ command: "sh check.sh" }); text(out + "\\n" + check);',
          },
        },
        { tool: "jumi_set_pr_body", args: { markdown: "fix the app via codemode" } },
        { tool: "jumi_set_handoff", args: { notes: "edited app.txt via codemode, check.sh passes" } },
      ]);
      const store = new WorkerResultStore();
      const result = await runPiWorkerAttempt({
        workdir: dir,
        intent: "implement",
        prompt: "fix app.txt so check.sh passes via codemode",
        store,
        modelRuntime: runtime,
        model,
        allowedFetchHosts: ["127.0.0.1"],
        timeoutMs: 30_000,
      });
      const check = Bun.spawnSync(["sh", "check.sh"], { cwd: dir });
      const hasCodemode = result.toolCalls.some((call) => call.name === "codemode" && call.ok);
      const hasNestedEdit = result.toolCalls.some((call) => call.name === "edit" && call.ok);
      push(
        "pi worker codemode offline completes a real worker task through a script",
        result.status === "complete" &&
          result.dirty &&
          result.diff.includes("fixed") &&
          check.exitCode === 0 &&
          hasCodemode &&
          hasNestedEdit &&
          (store.getPrBody() ?? "").includes("via codemode"),
        `status=${result.status} dirty=${result.dirty} codemode=${hasCodemode} nestedEdit=${hasNestedEdit} check=${check.exitCode}`
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (err) {
    push("pi worker codemode offline completes a real worker task through a script", false, errorMessage(err));
  }

  // --- Ambient inference outside loopback fails closed ---
  try {
    const workdir = await mkdtemp(join(tmpdir(), "jumi-image-probe-ambient-"));
    try {
      const { runtime, model } = await makeLoopback([{ fetch: `http://127.0.0.1:${loopPort}/ambient` }]);
      const store = new ReviewVerdictStore({
        changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
      });
      const bad = await runPiReviewAttempt({
        workdir,
        prompt: "ambient",
        store,
        modelRuntime: runtime,
        model,
        allowedFetchHosts: [],
        timeoutMs: 15_000,
      });
      push(
        "ambient inference outside in-container loopback fails closed",
        bad.status === "incomplete" && /ambient network/i.test(bad.reason ?? ""),
        `status=${bad.status} reason=${bad.reason ?? "<none>"}`
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  } catch (err) {
    push("ambient inference outside in-container loopback fails closed", false, errorMessage(err));
  } finally {
    loopServer.stop(true);
  }

  // --- Legacy startup/dispatch for both roles without Pi credentials ---
  try {
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (/^PI_|ANTHROPIC|OPENAI|XAI_|GEMINI|CLAUDE_CODE|CODEX_|AGY_|JUMI_PI_/i.test(key)) delete cleanEnv[key];
    }
    delete (cleanEnv as Record<string, string | undefined>).JUMI_HARNESS_MODE;
    const reviewer = loadConfig({ ...REVIEWER_BASE, HOME: freshHome } as never);
    const workerCfg = loadWorkerConfig({ ...WORKER_BASE, HOME: freshHome } as never);
    const legacyModes = reviewer.harnessMode === "legacy" && workerCfg.harnessMode === "legacy";
    // Idle dispatch on an empty memory ledger proves the production gates run
    // without Pi credentials and without spawning a runner.
    const reviewStore = new MemoryReviewJobStore();
    const workerStore = new MemoryReviewJobStore();
    const reviewTick = await processEngineTick(reviewStore, reviewer, {} as never, "probe-lease");
    const workerTick = await processWorkerTick(workerStore, workerCfg, {} as never, "probe-lease");
    push(
      "legacy startup and dispatch for both roles without Pi credentials",
      legacyModes && reviewTick === "idle" && workerTick === "idle",
      `reviewer=${reviewer.harnessMode}/${reviewTick} worker=${workerCfg.harnessMode}/${workerTick}`
    );
  } catch (err) {
    push("legacy startup and dispatch for both roles without Pi credentials", false, errorMessage(err));
  }

  // --- Pi fails process start clearly without spawning legacy ---
  try {
    let legacySpawned = false;
    const legacyEngine = async (..._args: never[]): Promise<never> => {
      legacySpawned = true;
      throw new Error("must not spawn legacy on pi");
    };
    // 1. Missing profiles file fails naming the key (both roles).
    let missingFile = false;
    try {
      loadConfig({ ...REVIEWER_BASE, HOME: freshHome, JUMI_HARNESS_MODE: "pi" } as never);
    } catch (err) {
      missingFile = /JUMI_PI_PROFILES_FILE/.test(errorMessage(err));
    }
    let missingFileWorker = false;
    try {
      loadWorkerConfig({ ...WORKER_BASE, HOME: freshHome, JUMI_HARNESS_MODE: "pi" } as never);
    } catch (err) {
      missingFileWorker = /JUMI_PI_PROFILES_FILE/.test(errorMessage(err));
    }
    // 2. A profiles file with an empty allowlist fails naming the allowlist.
    const catalogDir = await mkdtemp(join(tmpdir(), "jumi-image-probe-pi-catalog-"));
    try {
      const goCatalogPath = join(catalogDir, "profiles.json");
      await writeFile(
        goCatalogPath,
        JSON.stringify({
          "pi-go-spark": {
            provider: "opencode-go",
            model: "muse-spark-1.3-contributor",
            endpoint: "https://opencode.ai/zen/go/v1",
            fundingPool: "go-pool",
            payer: "go-subscription",
            credentialRef: "env:EXAMPLE_GO_KEY",
            scopes: ["public"],
            sku: "contributor",
          },
        })
      );
      let emptyAllowlist = false;
      try {
        loadConfig({
          ...REVIEWER_BASE,
          HOME: freshHome,
          JUMI_HARNESS_MODE: "pi",
          JUMI_PI_PROFILES_FILE: goCatalogPath,
        } as never);
      } catch (err) {
        emptyAllowlist = /JUMI_PI_ALLOWED_ROUTES/.test(errorMessage(err));
      }
      // 3. An allowlisted route with no wired transport fails as "route not wired".
      const unwiredPath = join(catalogDir, "unwired.json");
      await writeFile(
        unwiredPath,
        JSON.stringify({
          "pi-chatgpt-oss": {
            provider: "openai",
            model: "gpt-6.2-sol",
            endpoint: "https://api.openai.com/v1",
            fundingPool: "chatgpt-pool",
            payer: "chatgpt-subscription",
            credentialRef: "operator:chatgpt-login",
            scopes: ["public"],
          },
        })
      );
      let unwiredReviewer = false;
      try {
        loadConfig({
          ...REVIEWER_BASE,
          HOME: freshHome,
          JUMI_HARNESS_MODE: "pi",
          JUMI_PI_PROFILES_FILE: unwiredPath,
          JUMI_PI_ALLOWED_ROUTES: "pi-chatgpt-oss",
        } as never);
      } catch (err) {
        unwiredReviewer = /route not wired/.test(errorMessage(err));
      }
      let unwiredWorker = false;
      try {
        loadWorkerConfig({
          ...WORKER_BASE,
          HOME: freshHome,
          JUMI_HARNESS_MODE: "pi",
          JUMI_PI_PROFILES_FILE: unwiredPath,
          JUMI_PI_ALLOWED_ROUTES: "pi-chatgpt-oss",
        } as never);
      } catch (err) {
        unwiredWorker = /route not wired/.test(errorMessage(err));
      }
      // 4. A valid Go deployment loads, and both ticks attempt the Pi path
      // without touching the legacy engine. The review tick observes the
      // forge read (then fails closed with no network); the worker tick
      // fails the visibility read closed into a private refusal.
      const deployment = {
        mode: "pi" as const,
        catalog: JSON.parse(await readFile(goCatalogPath, "utf8")),
        allowlist: ["pi-go-spark"],
      };
      const piReviewer = loadConfig({
        ...REVIEWER_BASE,
        HOME: freshHome,
        JUMI_HARNESS_MODE: "pi",
        JUMI_PI_PROFILES_FILE: goCatalogPath,
        JUMI_PI_ALLOWED_ROUTES: "pi-go-spark",
      } as never);
      const reviewStore = new MemoryReviewJobStore();
      await reviewStore.enqueue({
        delivery: "probe-d1",
        owner: "o",
        repo: "r",
        prNumber: 1,
        action: "synchronize",
        headSha: "abc",
        receivedAt: new Date().toISOString(),
      } as never);
      let forgeRead = false;
      const reviewTick = await processEngineTick(
        reviewStore,
        piReviewer,
        {
          getPR: async () => {
            forgeRead = true;
            throw new Error("forge unreachable (expected in probe)");
          },
        } as never,
        "probe-lease",
        { engine: legacyEngine, piDeployment: deployment } as never
      );
      const piWorker = loadWorkerConfig({
        ...WORKER_BASE,
        HOME: freshHome,
        JUMI_HARNESS_MODE: "pi",
        JUMI_PI_PROFILES_FILE: goCatalogPath,
        JUMI_PI_ALLOWED_ROUTES: "pi-go-spark",
      } as never);
      const workerStore = new MemoryReviewJobStore();
      await workerStore.enqueueIssue({
        delivery: "probe-w1",
        owner: "o",
        repo: "r",
        issueNumber: 1,
        action: "opened",
        title: "probe",
        body: "probe",
        htmlUrl: "https://gitea.example/o/r/issues/1",
        issueUpdatedAt: new Date().toISOString(),
        defaultBranch: "main",
        cloneUrl: "https://gitea.example/o/r.git",
        receivedAt: new Date().toISOString(),
      });
      const workerTick = await processWorkerTick(workerStore, piWorker, {} as never, "probe-lease", {
        implement: legacyEngine,
        followUp: legacyEngine,
        conflict: legacyEngine,
        piDeployment: deployment,
      } as never);
      push(
        "pi harness fails without rescue to legacy for both roles",
        piReviewer.harnessMode === "pi" &&
          piWorker.harnessMode === "pi" &&
          missingFile &&
          missingFileWorker &&
          emptyAllowlist &&
          unwiredReviewer &&
          unwiredWorker &&
          forgeRead &&
          reviewTick === "processed" &&
          workerTick === "processed" &&
          !legacySpawned,
        `missingFile=${missingFile}/${missingFileWorker} empty=${emptyAllowlist} unwired=${unwiredReviewer}/${unwiredWorker} forgeRead=${forgeRead} ticks=${reviewTick}/${workerTick} spawned=${legacySpawned}`
      );
    } finally {
      await rm(catalogDir, { recursive: true, force: true });
    }
  } catch (err) {
    push("pi harness fails without rescue to legacy for both roles", false, errorMessage(err));
  }

  await rm(freshHome, { recursive: true, force: true });

  for (const { name, ok, observed } of results) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${observed}`);
  }
  const failures = results.filter((r) => !r.ok).length;
  if (failures > 0) {
    console.error(
      `pi-offline-legacy probe: ${failures}/${results.length} check(s) failed against the installed components`
    );
    return 1;
  }
  console.log(
    `pi-offline-legacy probe: ${results.length}/${results.length} checks pass against the installed components`
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
