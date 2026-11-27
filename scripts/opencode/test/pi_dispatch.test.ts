import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { makeIssueApi, makeReviewApi } from "../src/forge_fake.ts";
import { runOneShotJob } from "../src/job.ts";
import {
  PI_ALLOWED_ROUTES_ENV,
  PI_PROFILES_FILE_ENV,
  type PiStartupCatalog,
  type PiStartupProfile,
  parsePiAllowedRoutesEnv,
  parsePiProfilesText,
  validatePiStartupEnv,
} from "../src/pi_env.ts";
import type { PiJobSeams } from "../src/pi_jobs.ts";
import { piQuotaDecision, piScopeRefusalReason, piSessionToAdapterResult, runPiReviewJob } from "../src/pi_jobs.ts";
import { PI_GO_MODEL_ID, PI_GO_PROVIDER_ID, postPiGoChatCompletion } from "../src/pi_opencode_go.ts";
import type { PiProfileCatalog } from "../src/pi_profiles.ts";
import { loadPiDeployment, piChainForJob, piScopeForRepo, resolvePiDataScope } from "../src/pi_runtime.ts";
import type { IssueApi, ReviewApi } from "../src/ports.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { processEngineTick } from "../src/server.ts";
import { processWorkerTick } from "../src/worker.ts";
import { makeConfig, makeFile, makeIssueJob, makeJob, makeWorkerConfig } from "./fixtures.ts";
import { withTempDirs } from "./harness/temp.ts";

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

function piDeployment() {
  return { mode: "pi" as const, catalog: goCatalog(), allowlist: ["pi-go-spark"] };
}

type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string } | { fetch: string };

async function makeLoopback(steps: ScriptStep[]) {
  const queue = [...steps];
  const api = {
    streamSimple(model: never, _context: never) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        let next: ScriptStep | { text: string } = { text: "done" };
        while (queue.length > 0) {
          const peek = queue[0] as ScriptStep;
          if (!("fetch" in peek && (peek as { fetch?: string }).fetch)) break;
          queue.shift();
          try {
            const res = await fetch((peek as { fetch: string }).fetch);
            await res.text().catch(() => undefined);
          } catch {}
        }
        next = queue.shift() ?? { text: "done" };
        if ("fetch" in next) {
          stream.end({ role: "assistant", content: [] } as never);
          return;
        }
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
    stream(model: never, context: never) {
      return (this as unknown as { streamSimple: (model: never, context: never) => never }).streamSimple(
        model,
        context
      );
    },
  };
  const provider = createProvider({
    id: "jumi-pi-dispatch-loopback",
    name: "loopback",
    models: [
      {
        id: "loopback-1",
        name: "loopback",
        api: "openai-completions",
        provider: "jumi-pi-dispatch-loopback",
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
  const model = runtime.getModel("jumi-pi-dispatch-loopback", "loopback-1");
  if (!model) throw new Error("loopback model missing");
  return { runtime, model };
}

function loopbackSeams(steps: ScriptStep[]): PiJobSeams {
  return {
    sandboxAvailable: true,
    sessionDepsFor: async (_route, _sessionId) => {
      const { runtime, model } = await makeLoopback(steps);
      return { modelRuntime: runtime, model, allowedFetchHosts: ["127.0.0.1"] };
    },
  };
}

const UNSANDBOXED_ENV = "JUMI_ALLOW_UNSANDBOXED_REVIEWS";
let savedUnsandboxed: string | undefined;
function allowUnsandboxed(): void {
  savedUnsandboxed = process.env[UNSANDBOXED_ENV];
  process.env[UNSANDBOXED_ENV] = "1";
}
afterEach(() => {
  if (savedUnsandboxed === undefined) delete process.env[UNSANDBOXED_ENV];
  else process.env[UNSANDBOXED_ENV] = savedUnsandboxed;
  savedUnsandboxed = undefined;
});

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(proc.stderr)}`);
}

/** Seed a bare repo with `main` and `feature` branches, plus a file the session edits. */
async function seedBare(bare: string, seed: string): Promise<void> {
  git(process.cwd(), ["init", "-q", seed]);
  git(seed, ["config", "user.email", "test@example.com"]);
  git(seed, ["config", "user.name", "test"]);
  await writeFile(join(seed, "app.txt"), "broken\n");
  await writeFile(join(seed, "check.sh"), "#!/bin/sh\ngrep -q fixed app.txt\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "init"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["checkout", "-qb", "feature"]);
  git(process.cwd(), ["clone", "-q", "--bare", seed, bare]);
}

describe("pi startup validation", () => {
  test("pi mode without a profiles file fails naming the key", () => {
    expect(() =>
      loadConfig({
        GITEA_URL: "https://gitea.example/",
        GITEA_BOT_TOKEN: "token",
        GITEA_WEBHOOK_SECRET: "secret",
        JUMI_ROLE: "engine",
        DATABASE_URL: "postgres://probe",
        JUMI_HARNESS_MODE: "pi",
      })
    ).toThrow(PI_PROFILES_FILE_ENV);
  });

  test("pi mode with an empty allowlist fails naming the allowlist", async () => {
    await withTempDirs(["jumi-pi-catalog-"], async (dir) => {
      const path = join(dir!, "profiles.json");
      await writeFile(path, JSON.stringify(goCatalog()));
      expect(() =>
        loadConfig({
          GITEA_URL: "https://gitea.example/",
          GITEA_BOT_TOKEN: "token",
          GITEA_WEBHOOK_SECRET: "secret",
          JUMI_ROLE: "engine",
          DATABASE_URL: "postgres://probe",
          JUMI_HARNESS_MODE: "pi",
          [PI_PROFILES_FILE_ENV]: path,
        })
      ).toThrow(PI_ALLOWED_ROUTES_ENV);
    });
  });

  test("pi mode with an unwired route fails as route not wired", async () => {
    await withTempDirs(["jumi-pi-catalog-"], async (dir) => {
      const path = join(dir!, "profiles.json");
      await writeFile(
        path,
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
      expect(() =>
        validatePiStartupEnv({ [PI_PROFILES_FILE_ENV]: path, [PI_ALLOWED_ROUTES_ENV]: "pi-chatgpt-oss" })
      ).toThrow("route not wired");
    });
  });

  test("legacy mode never reads the profiles file", () => {
    const config = loadConfig({
      GITEA_URL: "https://gitea.example/",
      GITEA_BOT_TOKEN: "token",
      GITEA_WEBHOOK_SECRET: "secret",
      JUMI_ROLE: "engine",
      DATABASE_URL: "postgres://probe",
      [PI_PROFILES_FILE_ENV]: "/nonexistent/profiles.json",
    });
    expect(config.harnessMode).toBe("legacy");
  });
});

describe("pi scope and chain", () => {
  test("private, non-public visibility, and missing records are private", () => {
    expect(resolvePiDataScope({ private: false })).toBe("public");
    expect(resolvePiDataScope({ private: false, visibility: "public" })).toBe("public");
    expect(resolvePiDataScope({ private: true })).toBe("private");
    expect(resolvePiDataScope({ private: false, visibility: "internal" })).toBe("private");
    expect(resolvePiDataScope({})).toBe("private");
    expect(resolvePiDataScope(null)).toBe("private");
    expect(resolvePiDataScope(undefined)).toBe("private");
  });

  test("a failed visibility read means private", async () => {
    const out = await piScopeForRepo(
      async () => {
        throw new Error("forge down");
      },
      "o",
      "r"
    );
    expect(out).toEqual({ scope: "private", visibilityFailed: true });
  });

  test("the chain follows the allowlist order capped at two", () => {
    const deployment = { mode: "legacy" as const, catalog: {}, allowlist: ["a", "b", "c"] };
    expect(piChainForJob(deployment)).toEqual(["a", "b"]);
    expect(piChainForJob(deployment, ["c", "b", "a"])).toEqual(["c", "b"]);
    expect(piScopeRefusalReason("o", "r", false)).toContain("private");
    expect(piScopeRefusalReason("o", "r", true)).toContain("unreadable");
  });

  test("profile catalog text is validated without leaking contents", () => {
    const catalog: PiStartupCatalog = parsePiProfilesText(
      JSON.stringify({
        "pi-go-spark": {
          provider: "opencode-go",
          model: "muse-spark-1.3-contributor",
          endpoint: "https://opencode.ai/zen/go/v1",
          fundingPool: "go-pool",
          payer: "go-subscription",
          credentialRef: "env:K",
          scopes: ["public"],
          sku: "contributor",
        },
      }),
      "profiles"
    );
    expect(Object.keys(catalog)).toEqual(["pi-go-spark"]);
    const profile: PiStartupProfile | undefined = catalog["pi-go-spark"];
    expect(profile?.provider).toBe("opencode-go");
    expect(parsePiAllowedRoutesEnv("b, a ,b,")).toEqual(["b", "a"]);
    expect(parsePiAllowedRoutesEnv(undefined)).toEqual([]);
    expect(() => parsePiProfilesText("not json", "profiles")).toThrow("not valid JSON");
    expect(() => parsePiProfilesText(JSON.stringify({ bad: { provider: "x" } }), "profiles")).toThrow(
      "must name provider"
    );
  });

  test("session outcomes classify into quota, auth, and provider results", () => {
    expect(piSessionToAdapterResult("complete", undefined, "ok").kind).toBe("ok");
    expect(piSessionToAdapterResult("incomplete", "Go request failed (429): rate limited", "x").kind).toBe("quota");
    expect(piSessionToAdapterResult("incomplete", "API Error: 401 Unauthorized: bad key", "x").kind).toBe(
      "auth-expired"
    );
    expect(piSessionToAdapterResult("incomplete", "fetch failed", "x").kind).toBe("provider-failure");
    expect(piQuotaDecision(null, 1_000).action).toBe("throw");
  });
});

describe("pi review tick", () => {
  test("public repo runs the Pi session, publishes, stamps, and spawns no legacy runner", async () => {
    allowUnsandboxed();
    await withTempDirs(["jumi-pi-work-"], async (workdir) => {
      const checkout = join(workdir!, "checkout");
      await Bun.write(join(checkout, "src", "demo.ts"), "old\n");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let legacyRan = 0;
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
      const config = makeConfig({ workdir: workdir!, home: workdir!, harnessMode: "pi" });
      const tick = await processEngineTick(
        store,
        config,
        api as unknown as ReviewApi,
        "engine-1",
        {
          engine: async () => {
            legacyRan++;
            throw new Error("must not spawn legacy on pi");
          },
          openCodeRunner: async () => {
            legacyRan++;
            throw new Error("must not spawn legacy on pi");
          },
          piDeployment: piDeployment(),
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
      expect(legacyRan).toBe(0);
      const row = await store.get(1);
      expect(row?.state).toBe("succeeded");
      expect(row?.harnessMode).toBe("pi");
      expect(row?.piProfile).toBe("pi-go-spark");
      expect(row?.piOutcome).toBe("ok");
      expect(row?.piPayer).toBe("go-subscription");
      expect(row?.piFundingPool).toBe("go-pool");
      expect(row?.piTokensInput).toBeUndefined();
      expect(row?.resultMarkdown).toContain("jumi-check:");
      expect(api.callsTo("createPullReview").length).toBeGreaterThan(0);
    });
  });

  test("private repo is refused with a stamp, zero session calls, and no legacy spawn", async () => {
    allowUnsandboxed();
    await withTempDirs(["jumi-pi-work-"], async (workdir) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let sessions = 0;
      let legacyRan = 0;
      const api = makeReviewApi({
        getRepo: async () => ({
          name: "demo",
          full_name: "kirmanak/demo",
          html_url: "https://gitea.example/kirmanak/demo",
          clone_url: "https://gitea.example/kirmanak/demo.git",
          default_branch: "main",
          owner: { login: "kirmanak" },
          private: true,
        }),
      });
      const config = makeConfig({ workdir: workdir!, home: workdir!, harnessMode: "pi" });
      const tick = await processEngineTick(
        store,
        config,
        api as unknown as ReviewApi,
        "engine-1",
        {
          engine: async () => {
            legacyRan++;
            throw new Error("must not spawn legacy on pi");
          },
          piDeployment: piDeployment(),
          piSeams: {
            sandboxAvailable: true,
            sessionDepsFor: async () => {
              sessions++;
              const { runtime, model } = await makeLoopback([]);
              return { modelRuntime: runtime, model, allowedFetchHosts: ["127.0.0.1"] };
            },
          },
        },
        () => undefined
      );
      expect(tick).toBe("processed");
      expect(sessions).toBe(0);
      expect(legacyRan).toBe(0);
      const row = await store.get(1);
      expect(row?.state).toBe("skipped");
      expect(row?.harnessMode).toBe("pi");
      expect(row?.piOutcome).toBe("denied");
      expect(row?.piProfile).toBe("pi-go-spark");
      expect(row?.error).toContain("private");
      expect(api.callsTo("createPullReview")).toHaveLength(0);
    });
  });

  test("unreadable visibility fails closed into a private refusal", async () => {
    allowUnsandboxed();
    await withTempDirs(["jumi-pi-work-"], async (workdir) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let sessions = 0;
      const api = makeReviewApi({
        getRepo: async () => {
          throw new Error("forge down");
        },
      });
      const config = makeConfig({ workdir: workdir!, home: workdir!, harnessMode: "pi" });
      const tick = await processEngineTick(
        store,
        config,
        api as unknown as ReviewApi,
        "engine-1",
        {
          piDeployment: piDeployment(),
          piSeams: {
            sandboxAvailable: true,
            sessionDepsFor: async () => {
              sessions++;
              const { runtime, model } = await makeLoopback([]);
              return { modelRuntime: runtime, model, allowedFetchHosts: ["127.0.0.1"] };
            },
          },
        },
        () => undefined
      );
      expect(tick).toBe("processed");
      expect(sessions).toBe(0);
      const row = await store.get(1);
      expect(row?.state).toBe("skipped");
      expect(row?.piOutcome).toBe("denied");
      expect(row?.error).toContain("unreadable");
    });
  });

  test("loopback quota requeues with a quota stamp and no legacy fallback", async () => {
    allowUnsandboxed();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("rate limited", { status: 429 }),
    });
    try {
      await withTempDirs(["jumi-pi-work-"], async (workdir) => {
        const checkout = join(workdir!, "checkout");
        await Bun.write(join(checkout, "src", "demo.ts"), "old\n");
        const store = new MemoryReviewJobStore();
        await store.enqueue(makeJob());
        let legacyRan = 0;
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
        const config = makeConfig({ workdir: workdir!, home: workdir!, harnessMode: "pi" });
        const tick = await processEngineTick(
          store,
          config,
          api as unknown as ReviewApi,
          "engine-1",
          {
            engine: async () => {
              legacyRan++;
              throw new Error("must not spawn legacy on pi");
            },
            piDeployment: piDeployment(),
            piSeams: {
              ...loopbackSeams([{ fetch: `http://127.0.0.1:${server.port}/quota` }]),
              workdirForReview: checkout,
            },
          },
          () => undefined
        );
        expect(tick).toBe("processed");
        expect(legacyRan).toBe(0);
        const row = await store.get(1);
        expect(row?.state).toBe("queued");
        expect(row?.harnessMode).toBe("pi");
        expect(row?.piOutcome).toBe("quota");
      });
    } finally {
      server.stop(true);
    }
  });

  test("loopback auth failure records an auth stamp and never falls back", async () => {
    allowUnsandboxed();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("bad key", { status: 401 }),
    });
    try {
      await withTempDirs(["jumi-pi-work-"], async (workdir) => {
        const checkout = join(workdir!, "checkout");
        await Bun.write(join(checkout, "src", "demo.ts"), "old\n");
        const store = new MemoryReviewJobStore();
        await store.enqueue(makeJob());
        let legacyRan = 0;
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
        const config = makeConfig({ workdir: workdir!, home: workdir!, harnessMode: "pi" });
        const tick = await processEngineTick(
          store,
          config,
          api as unknown as ReviewApi,
          "engine-1",
          {
            engine: async () => {
              legacyRan++;
              throw new Error("must not spawn legacy on pi");
            },
            piDeployment: piDeployment(),
            piSeams: {
              ...loopbackSeams([{ fetch: `http://127.0.0.1:${server.port}/auth` }]),
              workdirForReview: checkout,
            },
          },
          () => undefined
        );
        expect(tick).toBe("processed");
        expect(legacyRan).toBe(0);
        const row = await store.get(1);
        expect(row?.state).toBe("failed");
        expect(row?.harnessMode).toBe("pi");
        expect(row?.piOutcome).toBe("auth-expired");
      });
    } finally {
      server.stop(true);
    }
  });
});

describe("pi worker ticks", () => {
  test("implement completes on loopback with the parent pushing to the bare remote", async () => {
    allowUnsandboxed();
    await withTempDirs(
      ["jumi-pi-home-", "jumi-pi-work-", "jumi-pi-bare-", "jumi-pi-seed-"],
      async (home, work, bare, seed) => {
        await seedBare(bare!, seed!);
        const store = new MemoryReviewJobStore();
        await store.enqueueIssue(makeIssueJob());
        let legacyRan = 0;
        const legacyStub = async (): Promise<never> => {
          legacyRan++;
          throw new Error("must not spawn legacy on pi");
        };
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
        const config = makeWorkerConfig({ workdir: work!, home: home!, harnessMode: "pi" });
        const tick = await processWorkerTick(
          store,
          config,
          api as unknown as IssueApi,
          "worker-1",
          {
            implement: legacyStub as never,
            followUp: legacyStub as never,
            conflict: legacyStub as never,
            piDeployment: piDeployment(),
            piSeams: {
              ...loopbackSeams([
                { tool: "edit", args: { path: "app.txt", edits: [{ oldText: "broken", newText: "fixed" }] } },
                { tool: "jumi_set_pr_body", args: { markdown: "fix the app" } },
                { tool: "jumi_set_handoff", args: { notes: "edited app.txt" } },
              ]),
              prepareCheckout: async (workdir) => {
                await rm(workdir, { recursive: true, force: true });
                git(process.cwd(), ["clone", "-q", bare!, workdir]);
                const branch = "jumi/issue-12-fix-the-thing";
                git(workdir, ["checkout", "-qb", branch, "origin/main"]);
                return {
                  branch,
                  // File remotes are test-only (`protocol.file.allow=never` is
                  // production git config); the env allowlist lifts it here so
                  // the test exercises the real parent push.
                  env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
                  cleanup: async () => undefined,
                };
              },
            },
          },
          () => undefined
        );
        expect(tick).toBe("processed");
        expect(legacyRan).toBe(0);
        const row = await store.get(1);
        expect(row?.state).toBe("succeeded");
        expect(row?.harnessMode).toBe("pi");
        expect(row?.piProfile).toBe("pi-go-spark");
        expect(row?.piOutcome).toBe("ok");
        expect(row?.piTokensInput).toBeUndefined();
        expect(api.callsTo("createPullRequest")).toHaveLength(1);
        const pushed = Bun.spawnSync(["git", "log", "--oneline", "jumi/issue-12-fix-the-thing"], {
          cwd: bare!,
          stdout: "pipe",
        });
        expect(String(pushed.stdout)).toContain("Fix the thing");
      }
    );
  });

  test("follow-up and conflict each record a stamp with the parent pushing", async () => {
    allowUnsandboxed();
    for (const kind of ["follow-up", "conflict"] as const) {
      await withTempDirs(
        ["jumi-pi-home-", "jumi-pi-work-", "jumi-pi-bare-", "jumi-pi-seed-"],
        async (home, work, bare, seed) => {
          await seedBare(bare!, seed!);
          const store = new MemoryReviewJobStore();
          await store.enqueueIssue(makeIssueJob({ mode: kind, prNumber: 19, headSha: "abc123" }));
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
            getPR: async () => ({
              number: 19,
              title: "t",
              body: "b",
              state: "open",
              html_url: "https://gitea.example/kirmanak/demo/pulls/19",
              user: { login: "alice" },
              head: { ref: "feature", sha: "abc123", repo: { full_name: "kirmanak/demo", clone_url: "x" } },
              base: { ref: "main", sha: "basesha" },
              merged: false,
              created_at: "",
              updated_at: "",
            }),
          });
          const config = makeWorkerConfig({ workdir: work!, home: home!, harnessMode: "pi" });
          const steps: Array<{ tool: string; args: Record<string, unknown> }> =
            kind === "follow-up"
              ? [
                  { tool: "jumi_set_pr_body", args: { markdown: "follow-up notes" } },
                  { tool: "jumi_set_handoff", args: { notes: "done" } },
                  { tool: "jumi_no_changes", args: { reason: "already fixed" } },
                ]
              : [
                  { tool: "edit", args: { path: "app.txt", edits: [{ oldText: "broken", newText: "fixed" }] } },
                  { tool: "jumi_set_pr_body", args: { markdown: "resolved" } },
                  { tool: "jumi_set_handoff", args: { notes: "resolved" } },
                ];
          const tick = await processWorkerTick(
            store,
            config,
            api as unknown as IssueApi,
            "worker-1",
            {
              piDeployment: piDeployment(),
              piSeams: {
                ...loopbackSeams(steps),
                prepareCheckout: async (workdir) => {
                  await rm(workdir, { recursive: true, force: true });
                  git(process.cwd(), ["clone", "-q", bare!, workdir]);
                  git(workdir, ["checkout", "-qB", "feature", "origin/feature"]);
                  return {
                    branch: "feature",
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
          expect(row?.harnessMode).toBe("pi");
          expect(row?.piProfile).toBe("pi-go-spark");
          expect(row?.piOutcome).toBe("ok");
          if (kind === "conflict") {
            const pushed = Bun.spawnSync(["git", "log", "--oneline", "feature"], { cwd: bare!, stdout: "pipe" });
            expect(String(pushed.stdout)).toContain("Fix the thing");
          }
        }
      );
    }
  });

  test("private repo refuses without a session call and without legacy spawn", async () => {
    allowUnsandboxed();
    await withTempDirs(["jumi-pi-home-", "jumi-pi-work-"], async (home, work) => {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      let sessions = 0;
      let legacyRan = 0;
      const legacyStub = async (): Promise<never> => {
        legacyRan++;
        throw new Error("must not spawn legacy on pi");
      };
      const api = makeIssueApi({
        getRepo: async () => ({
          name: "demo",
          full_name: "kirmanak/demo",
          html_url: "https://gitea.example/kirmanak/demo",
          clone_url: "https://gitea.example/kirmanak/demo.git",
          default_branch: "main",
          owner: { login: "kirmanak" },
          private: true,
        }),
      });
      const config = makeWorkerConfig({ workdir: work!, home: home!, harnessMode: "pi" });
      const tick = await processWorkerTick(
        store,
        config,
        api as unknown as IssueApi,
        "worker-1",
        {
          implement: legacyStub as never,
          piDeployment: piDeployment(),
          piSeams: {
            sandboxAvailable: true,
            sessionDepsFor: async () => {
              sessions++;
              const { runtime, model } = await makeLoopback([]);
              return { modelRuntime: runtime, model, allowedFetchHosts: ["127.0.0.1"] };
            },
          },
        },
        () => undefined
      );
      expect(tick).toBe("processed");
      expect(sessions).toBe(0);
      expect(legacyRan).toBe(0);
      const row = await store.get(1);
      expect(row?.state).toBe("skipped");
      expect(row?.harnessMode).toBe("pi");
      expect(row?.piOutcome).toBe("denied");
      expect(api.callsTo("createPullRequest")).toHaveLength(0);
    });
  });
});

describe("pi harness fence", () => {
  test("a never-attempted row is leased and run in pi mode for review and worker rows", async () => {
    allowUnsandboxed();
    await withTempDirs(["jumi-pi-home-", "jumi-pi-work-"], async (home, work) => {
      const checkout = join(work!, "checkout");
      await Bun.write(join(checkout, "src", "demo.ts"), "old\n");
      const reviewStore = new MemoryReviewJobStore();
      await reviewStore.enqueue(makeJob());
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
      const reviewTick = await processEngineTick(
        reviewStore,
        makeConfig({ workdir: work!, home: home!, harnessMode: "pi" }),
        api as unknown as ReviewApi,
        "engine-1",
        {
          piDeployment: piDeployment(),
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
      expect(reviewTick).toBe("processed");
      const reviewRow = await reviewStore.get(1);
      expect(reviewRow?.state).toBe("succeeded");
      expect(reviewRow?.harnessMode).toBe("pi");

      const workerStore = new MemoryReviewJobStore();
      await workerStore.enqueueIssue(makeIssueJob());
      const workerApi = makeIssueApi({
        getRepo: async () => ({
          name: "demo",
          full_name: "kirmanak/demo",
          html_url: "https://gitea.example/kirmanak/demo",
          clone_url: "https://gitea.example/kirmanak/demo.git",
          default_branch: "main",
          owner: { login: "kirmanak" },
          private: true,
        }),
      });
      const workerTick = await processWorkerTick(
        workerStore,
        makeWorkerConfig({ workdir: work!, home: home!, harnessMode: "pi" }),
        workerApi as unknown as IssueApi,
        "worker-1",
        { piDeployment: piDeployment(), piSeams: { sandboxAvailable: true } },
        () => undefined
      );
      expect(workerTick).toBe("processed");
      const workerRow = await workerStore.get(1);
      expect(workerRow?.harnessMode).toBe("pi");
    });
  });

  test("a pi-stamped row runs fresh under a legacy process instead of looping", async () => {
    await withTempDirs(["jumi-pi-home-", "jumi-pi-work-"], async (home, work) => {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const leased = await store.lease("probe", 60_000, undefined, ["implement", "follow-up", "conflict"]);
      expect(leased?.kind).toBe("implement");
      await store.saveResult(leased!.id, "probe", {
        kind: "error",
        error: "pi refused: o/r is private",
        harnessMode: "pi",
      });
      // Simulate the requeued row: queued with the other mode's stamp.
      const stamped = store.rows[0]!;
      stamped.state = "queued";
      stamped.leasedBy = null;
      stamped.leasedUntil = null;
      expect(stamped.harnessMode).toBe("pi");
      let legacyRan = 0;
      const api = makeIssueApi();
      const tick = await processWorkerTick(
        store,
        makeWorkerConfig({ workdir: work!, home: home! }),
        api as unknown as IssueApi,
        "worker-1",
        {
          implement: (async () => {
            legacyRan++;
            return { status: "no-changes" };
          }) as never,
        },
        () => undefined
      );
      expect(tick).toBe("processed");
      expect(legacyRan).toBe(1);
    });
  });
});

describe("pi one-shot job", () => {
  test("bun run src/job.ts runs a review row end to end in pi mode", async () => {
    allowUnsandboxed();
    await withTempDirs(["jumi-pi-home-", "jumi-pi-work-"], async (home, work) => {
      const checkout = join(work!, "checkout");
      await Bun.write(join(checkout, "src", "demo.ts"), "old\n");
      const store = new MemoryReviewJobStore();
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
      const engineConfig = makeConfig({
        workdir: work!,
        home: home!,
        harnessMode: "pi",
        opencodeWellKnownUrl: "disabled",
      });
      const workerConfig = makeWorkerConfig({
        workdir: work!,
        home: home!,
        harnessMode: "pi",
        opencodeWellKnownUrl: "disabled",
      });
      const result = await runOneShotJob({
        store,
        jobId: 1,
        engineConfig,
        workerConfig,
        api: api as unknown as ReviewApi & IssueApi,
        logger: () => undefined,
        engineExtras: {
          engine: async () => {
            throw new Error("must not spawn legacy on pi");
          },
          piDeployment: piDeployment(),
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
      });
      expect(result.exitCode).toBe(0);
      const row = await store.get(1);
      expect(row?.state).toBe("succeeded");
      expect(row?.harnessMode).toBe("pi");
      expect(row?.piProfile).toBe("pi-go-spark");
    });
  });
});

describe("pi go loopback endpoint", () => {
  test("quota, auth, entitlement, and ok classify without touching a vendor", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/quota")) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "7" } });
        }
        if (url.pathname.startsWith("/auth")) {
          return new Response("bad key", { status: 401 });
        }
        if (url.pathname.startsWith("/entitlement")) {
          return new Response("OpenCode Go subscription required.", { status: 403 });
        }
        return Response.json({ usage: { prompt_tokens: 3, completion_tokens: 4 } });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const session = "ses_0123456789abcdef0123456789abcdef";
      const quota = await postPiGoChatCompletion({
        baseUrl: `${base}/quota`,
        apiKey: "k",
        sessionId: session,
        fetchImpl: fetch,
      });
      expect(quota.kind).toBe("quota");
      expect(quota.quota?.retryAfterMs).toBe(7_000);
      const auth = await postPiGoChatCompletion({
        baseUrl: `${base}/auth`,
        apiKey: "k",
        sessionId: session,
        fetchImpl: fetch,
      });
      expect(auth.kind).toBe("auth-expired");
      const denied = await postPiGoChatCompletion({
        baseUrl: `${base}/entitlement`,
        apiKey: "k",
        sessionId: session,
        fetchImpl: fetch,
      });
      expect(denied.kind).toBe("denied");
      const ok = await postPiGoChatCompletion({
        baseUrl: `${base}/ok`,
        apiKey: "k",
        sessionId: session,
        fetchImpl: fetch,
      });
      expect(ok.kind).toBe("ok");
      expect(ok.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
      const missing = await postPiGoChatCompletion({
        baseUrl: `${base}/ok`,
        apiKey: undefined,
        sessionId: session,
        fetchImpl: fetch,
      });
      expect(missing.kind).toBe("auth-expired");
    } finally {
      server.stop(true);
    }
  });

  test("the deployment loader stays legacy without pi env", () => {
    const deployment = loadPiDeployment({});
    expect(deployment.mode).toBe("legacy");
    expect(deployment.catalog).toEqual({});
    expect(deployment.allowlist).toEqual([]);
  });

  test("runPiReviewJob refuses a private repo with zero session calls", async () => {
    let sessions = 0;
    const api = makeReviewApi({
      getRepo: async () => ({
        name: "demo",
        full_name: "o/r",
        html_url: "https://gitea.example/o/r",
        clone_url: "https://gitea.example/o/r.git",
        default_branch: "main",
        owner: { login: "o" },
        private: true,
      }),
    });
    await withTempDirs(["jumi-pi-review-"], async (dir) => {
      const result = await runPiReviewJob({
        owner: "o",
        repo: "r",
        prNumber: 7,
        headSha: "headsha",
        config: { workdir: dir!, home: dir!, giteaUrl: "https://gitea.example", giteaToken: "t", botUsername: "jumi" },
        api: api as unknown as ReviewApi,
        logger: () => undefined,
        deployment: piDeployment(),
        persist: async () => undefined,
        seams: {
          sandboxAvailable: true,
          sessionDepsFor: async () => {
            sessions++;
            const { runtime, model } = await makeLoopback([]);
            return { modelRuntime: runtime, model, allowedFetchHosts: ["127.0.0.1"] };
          },
        },
      });
      expect(result).toEqual({ status: "skipped", reason: expect.stringContaining("private") });
      expect(sessions).toBe(0);
    });
  });
});
