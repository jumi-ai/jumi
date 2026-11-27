import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiJobSeams } from "../src/pi_jobs.ts";
import { PI_GO_MODEL_ID, PI_GO_PROVIDER_ID } from "../src/pi_opencode_go.ts";
import type { PiProfileCatalog } from "../src/pi_profiles.ts";
import type { IssueApi, ReviewApi } from "../src/ports.ts";
import { PgReviewJobStore } from "../src/review_jobs.ts";
import { processEngineTick } from "../src/server.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { processWorkerTick } from "../src/worker.ts";
import { makeIssueApi, makeReviewApi } from "./fakes/forge.ts";
import { makeConfig, makeFile, makeIssueJob, makeJob, makeWorkerConfig } from "./fixtures.ts";
import { describePg, openTestSqlClient, pgDatabaseUrl } from "./pg.ts";

const GO_ENDPOINT = "https://opencode.ai/zen/go/v1";

function goCatalog(): PiProfileCatalog {
  return {
    "pi-go-spark": {
      provider: PI_GO_PROVIDER_ID,
      model: PI_GO_MODEL_ID,
      effort: "high",
      endpoint: GO_ENDPOINT,
      fundingPool: "go-pool",
      payer: "go-subscription",
      credentialRef: "env:EXAMPLE_GO_KEY",
      scopes: ["public"],
      sku: "contributor",
    },
  };
}

type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string };

async function makeLoopback(steps: ScriptStep[]) {
  const queue = [...steps];
  const api = {
    streamSimple(model: never, _context: never) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
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
        const typed = next as { tool: string; args: Record<string, unknown> };
        const msg = {
          role: "assistant",
          content: [
            { type: "toolCall", id: `call-${Date.now()}-${Math.random()}`, name: typed.tool, arguments: typed.args },
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
    stream(model: never, context: never) {
      return (this as unknown as { streamSimple: (model: never, context: never) => never }).streamSimple(
        model,
        context
      );
    },
  };
  const provider = createProvider({
    id: "jumi-pi-dispatch-pg-loopback",
    name: "loopback",
    models: [
      {
        id: "loopback-1",
        name: "loopback",
        api: "openai-completions",
        provider: "jumi-pi-dispatch-pg-loopback",
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
  const model = runtime.getModel("jumi-pi-dispatch-pg-loopback", "loopback-1");
  if (!model) throw new Error("loopback model missing");
  return { runtime, model };
}

function loopbackSeams(steps: ScriptStep[]): PiJobSeams {
  return {
    sandboxAvailable: true,
    sessionDepsFor: async () => {
      const { runtime, model } = await makeLoopback(steps);
      return { modelRuntime: runtime, model, allowedFetchHosts: ["127.0.0.1"] };
    },
  };
}

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(proc.stderr)}`);
}

describePg("pi dispatch against real postgres", () => {
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
  });

  test("a never-attempted review row is leased and run by a pi-mode process", async () => {
    process.env.JUMI_ALLOW_UNSANDBOXED_REVIEWS = "1";
    const workdir = await mkdtemp(join(tmpdir(), "jumi-pi-pg-work-"));
    try {
      const checkout = join(workdir, "checkout");
      await Bun.write(join(checkout, "src", "demo.ts"), "old\n");
      await store.enqueue(makeJob());
      const api = makeReviewApi({
        getRepo: async () => ({
          name: "demo",
          full_name: "kirmanak/demo",
          html_url: "https://gitea.example/kirmanak/demo",
          clone_url: "https://gitea.example/kirmanak/demo.git",
          default_branch: "main",
          owner: { login: "kirmanak" },
          private: false,
        }),
        getPRFiles: async () => [makeFile()],
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
      });
      const tick = await processEngineTick(
        store,
        makeConfig({ workdir, home: workdir, harnessMode: "pi" }),
        api as unknown as ReviewApi,
        "engine-1",
        {
          piDeployment: { mode: "pi", catalog: goCatalog(), allowlist: ["pi-go-spark"] },
          piSeams: {
            ...loopbackSeams([
              {
                tool: "jumi_add_finding",
                args: { path: "src/demo.ts", line: 1, severity: "suggestion", title: "t", body: "b" },
              },
              { tool: "jumi_set_verdict", args: { state: "success" } },
            ]),
            workdirForReview: checkout,
          },
        },
        () => undefined
      );
      expect(tick).toBe("processed");
      const row = await store.get(1);
      expect(row?.state).toBe("succeeded");
      expect(row?.harnessMode).toBe("pi");
      expect(row?.piProfile).toBe("pi-go-spark");
      expect(row?.piOutcome).toBe("ok");
    } finally {
      delete process.env.JUMI_ALLOW_UNSANDBOXED_REVIEWS;
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("a never-attempted worker row is leased and run by a pi-mode process", async () => {
    process.env.JUMI_ALLOW_UNSANDBOXED_REVIEWS = "1";
    const home = await mkdtemp(join(tmpdir(), "jumi-pi-pg-home-"));
    const work = await mkdtemp(join(tmpdir(), "jumi-pi-pg-work-"));
    const bare = await mkdtemp(join(tmpdir(), "jumi-pi-pg-bare-"));
    const seed = await mkdtemp(join(tmpdir(), "jumi-pi-pg-seed-"));
    const clean = async () => {
      delete process.env.JUMI_ALLOW_UNSANDBOXED_REVIEWS;
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
    };
    try {
      git(process.cwd(), ["init", "-q", seed]);
      git(seed, ["config", "user.email", "test@example.com"]);
      git(seed, ["config", "user.name", "test"]);
      await Bun.write(join(seed, "app.txt"), "broken\n");
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-qm", "init"]);
      git(seed, ["branch", "-M", "main"]);
      git(process.cwd(), ["clone", "-q", "--bare", seed, bare]);
      await store.enqueueIssue(makeIssueJob());
      const api = makeIssueApi({
        getRepo: async () => ({
          name: "demo",
          full_name: "kirmanak/demo",
          html_url: "https://gitea.example/kirmanak/demo",
          clone_url: "https://gitea.example/kirmanak/demo.git",
          default_branch: "main",
          owner: { login: "kirmanak" },
          private: false,
        }),
      });
      const tick = await processWorkerTick(
        store,
        makeWorkerConfig({ workdir: work, home, harnessMode: "pi" }),
        api as unknown as IssueApi,
        "worker-1",
        {
          piDeployment: { mode: "pi", catalog: goCatalog(), allowlist: ["pi-go-spark"] },
          piSeams: {
            ...loopbackSeams([
              { tool: "edit", args: { path: "app.txt", edits: [{ oldText: "broken", newText: "fixed" }] } },
              { tool: "jumi_set_pr_body", args: { markdown: "fix the app" } },
              { tool: "jumi_set_handoff", args: { notes: "edited app.txt" } },
            ]),
            prepareCheckout: async (dir) => {
              await rm(dir, { recursive: true, force: true });
              git(process.cwd(), ["clone", "-q", bare, dir]);
              git(dir, ["checkout", "-qB", "jumi/issue-12-fix-the-thing", "origin/main"]);
              return {
                branch: "jumi/issue-12-fix-the-thing",
                env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
                cleanup: async () => undefined,
              };
            },
          },
        },
        () => undefined
      );
      expect(tick).toBe("processed");
      const row = await store.get(1);
      expect(row?.state).toBe("succeeded");
      expect(row?.harnessMode).toBe("pi");
      expect(row?.piProfile).toBe("pi-go-spark");
      expect(row?.piOutcome).toBe("ok");
      const pushed = Bun.spawnSync(["git", "log", "--oneline", "jumi/issue-12-fix-the-thing"], {
        cwd: bare,
        stdout: "pipe",
      });
      expect(String(pushed.stdout)).toContain("Fix the thing");
    } finally {
      await clean();
    }
  });
});
