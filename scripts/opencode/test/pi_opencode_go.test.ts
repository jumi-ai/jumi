/**
 * OpenCode Go transport tests (jumi#935). CI never logs in, never contacts
 * vendors, and never asserts billing: every network peer here is a loopback
 * `Bun.serve` on 127.0.0.1 or an in-process scripted provider.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  assertPiGoSessionId,
  buildPiGoHeaders,
  buildPiGoIdentity,
  buildPiGoStreamOptions,
  classifyPiGoError,
  createPiGoSessionId,
  isPiGoSessionId,
  PI_GO_BASE_URL,
  PI_GO_CHAT_COMPLETIONS_PATH,
  PI_GO_CLIENT_NAME,
  PI_GO_CLIENT_URL,
  PI_GO_KEY_ENV,
  PI_GO_KEY_FILE_ENV,
  PI_GO_MODEL_ID,
  PI_GO_PROVIDER_ID,
  PI_GO_SESSION_HEADER,
  PI_GO_SKU,
  PI_GO_USAGE_URL,
  PI_GO_USER_AGENT,
  type PiGoKeyResolution,
  piGoMissingKeyMessage,
  postPiGoChatCompletion,
  resolvePiGoApiKey,
  selectPiGoRoute,
  toPiGoAdapterResult,
  withPiGoTransport,
} from "../src/pi_opencode_go.ts";
import {
  type PiProfileCatalog,
  PiRouteDeniedError,
  PiRouteNotAllowedError,
  PiRouteNotFoundError,
  PiRouteScopeRefusedError,
} from "../src/pi_profiles.ts";
import { createPiReviewSettings, createTrustedPiResourceLoader, runPiReviewAttempt } from "../src/pi_review.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";

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
      sku: PI_GO_SKU,
    },
    "pi-zen-other": {
      provider: "opencode",
      model: "example-code-large",
      endpoint: "https://opencode.ai/zen/v1",
      fundingPool: "workspace-balance-pool",
      payer: "workspace-balance",
      credentialRef: "env:EXAMPLE_ZEN_KEY",
      scopes: ["public", "private"],
    },
    "pi-go-wrong-model": {
      provider: PI_GO_PROVIDER_ID,
      model: "example-code-small",
      endpoint: GO_ENDPOINT,
      fundingPool: "go-pool",
      payer: "go-subscription",
      credentialRef: "env:EXAMPLE_GO_KEY",
      scopes: ["public"],
      sku: PI_GO_SKU,
    },
    "pi-go-no-sku": {
      provider: PI_GO_PROVIDER_ID,
      model: PI_GO_MODEL_ID,
      endpoint: GO_ENDPOINT,
      fundingPool: "go-pool",
      payer: "go-subscription",
      credentialRef: "env:EXAMPLE_GO_KEY",
      scopes: ["public"],
    },
  };
}

type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string };

interface CapturedGoOptions {
  sessionId: unknown;
  identity: unknown;
  apiKey: unknown;
  headers: unknown;
}

async function makeGoLoopback(opts: { steps: ScriptStep[]; onOptions?: (seen: CapturedGoOptions) => void }) {
  const queue = [...opts.steps];
  const seen: CapturedGoOptions[] = [];
  const finish = (model: { api: string; provider: string; id: string }, text: string) => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
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
    return msg;
  };
  const api = {
    streamSimple(model: never, _context: never, streamOptions?: never) {
      const captured = streamOptions as unknown as CapturedGoOptions | undefined;
      seen.push({
        sessionId: captured?.sessionId,
        identity: captured?.identity,
        apiKey: captured?.apiKey,
        headers: captured?.headers,
      });
      opts.onOptions?.(seen[seen.length - 1]!);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const next = queue.shift() ?? { text: "done" };
        if ("text" in next) {
          const msg = finish(model as unknown as { api: string; provider: string; id: string }, next.text);
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
              name: next.tool,
              arguments: next.args,
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
    stream(model: never, context: never, streamOptions?: never) {
      return (this as unknown as { streamSimple: (m: never, c: never, o?: never) => never }).streamSimple(
        model,
        context,
        streamOptions
      );
    },
  };
  const provider = createProvider({
    id: PI_GO_PROVIDER_ID,
    name: "OpenCode Go",
    models: [
      {
        id: PI_GO_MODEL_ID,
        name: "Muse Spark 1.3 Contributor",
        api: "openai-completions",
        provider: PI_GO_PROVIDER_ID,
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
        name: "OpenCode API key",
        resolve: async () => ({ auth: { type: "apiKey", key: "loopback-key" }, source: "test" }),
      },
    },
    api: api as never,
  } as never);
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false } as never);
  (runtime as unknown as { registerNativeProvider: (provider: unknown) => void }).registerNativeProvider(provider);
  const model = runtime.getModel(PI_GO_PROVIDER_ID, PI_GO_MODEL_ID);
  if (!model) throw new Error("loopback Go model missing");
  return { runtime, model, seen };
}

function changedStore(): ReviewVerdictStore {
  return new ReviewVerdictStore({
    changedFiles: [{ filename: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+line\n" }],
  });
}

async function tempWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-pi-go-"));
  await writeFile(join(dir, "src-a.ts"), "hello\n");
  return dir;
}

describe("Go key delivery is fresh per call and fails closed", () => {
  test("gateway and operator URLs are pinned to the documented endpoints", () => {
    expect(PI_GO_BASE_URL).toBe("https://opencode.ai/inference/go");
    expect(PI_GO_USAGE_URL).toBe("https://opencode.ai/inference/go/v1/usage");
  });

  test("key file wins over env and rotation applies to the next call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-pi-go-key-"));
    try {
      const file = join(dir, "go-key");
      await writeFile(file, "  file-key-1  \n");
      const env = { [PI_GO_KEY_FILE_ENV]: file, [PI_GO_KEY_ENV]: "env-key" };
      expect(resolvePiGoApiKey(env).key).toBe("file-key-1");
      await writeFile(file, "file-key-2\n");
      expect(resolvePiGoApiKey(env).key).toBe("file-key-2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty file falls back to env; missing file with no env yields no key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-pi-go-key-"));
    try {
      const file = join(dir, "go-key");
      await writeFile(file, "   \n");
      const fallback = resolvePiGoApiKey({
        [PI_GO_KEY_FILE_ENV]: file,
        [PI_GO_KEY_ENV]: "env-key",
      });
      expect(fallback.key).toBe("env-key");
      expect(fallback.fileError).toBe("empty");
      const missing: PiGoKeyResolution = resolvePiGoApiKey({
        [PI_GO_KEY_FILE_ENV]: join(dir, "absent"),
      });
      expect(missing.key).toBeUndefined();
      expect(missing.fileError).not.toBeUndefined();
      expect(resolvePiGoApiKey({}).key).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing-key message names the reference, never the key", () => {
    const message = piGoMissingKeyMessage("/secret/go-key", "ENOENT");
    expect(message).toContain(PI_GO_KEY_FILE_ENV);
    expect(message).toContain(PI_GO_KEY_ENV);
    expect(message).not.toContain("secret-value-123");
    expect(piGoMissingKeyMessage()).toContain(PI_GO_KEY_ENV);
  });
});

describe("Go session ids are opaque and stable", () => {
  test("generated ids are unique, ses-shaped, and carry no repo or user identity", () => {
    const first = createPiGoSessionId();
    const second = createPiGoSessionId();
    expect(first).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(second).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
    for (const id of [first, second]) {
      expect(id).not.toContain("jumi");
      expect(id).not.toContain(process.cwd());
      expect(id).not.toContain("root");
    }
  });

  test("validator accepts generated and Pi agent ids, rejects paths and user strings", () => {
    expect(isPiGoSessionId(createPiGoSessionId())).toBe(true);
    expect(isPiGoSessionId("0197f3a2-4b5c-7d8e-9f0a-1b2c3d4e5f60")).toBe(true);
    expect(isPiGoSessionId("")).toBe(false);
    expect(isPiGoSessionId("../repo")).toBe(false);
    expect(isPiGoSessionId("/home/user")).toBe(false);
    expect(isPiGoSessionId("user@example.com")).toBe(false);
    expect(isPiGoSessionId("has space")).toBe(false);
    expect(isPiGoSessionId("ses_short")).toBe(false);
    expect(isPiGoSessionId(`ses_${"a".repeat(200)}`)).toBe(false);
    expect(() => assertPiGoSessionId("../repo")).toThrow();
    expect(() => assertPiGoSessionId(createPiGoSessionId())).not.toThrow();
  });
});

describe("Go requests identify the actual agent", () => {
  test("headers carry the bearer, the stable session, and the agent UA", () => {
    const sessionId = createPiGoSessionId(() => "a".repeat(32));
    const headers = buildPiGoHeaders({ apiKey: "k-1", sessionId });
    expect(headers.authorization).toBe("Bearer k-1");
    expect(headers[PI_GO_SESSION_HEADER]).toBe(sessionId);
    expect(headers["User-Agent"]).toBe(PI_GO_USER_AGENT);
    expect(headers["User-Agent"]).not.toContain("pi/");
    expect(headers["x-opencode-client"]).toBe(PI_GO_CLIENT_NAME);
    expect(JSON.stringify(headers)).not.toContain("other-secret");
  });

  test("identity names jumi with its own user agent", () => {
    const identity = buildPiGoIdentity();
    expect(identity).toMatchObject({
      userAgent: { custom: PI_GO_USER_AGENT },
      attribution: { name: PI_GO_CLIENT_NAME },
    });
    expect(identity.attribution?.url).toBe(PI_GO_CLIENT_URL);
  });
});

describe("Go route selection serves only the exact Spark Contributor SKU", () => {
  test("public scope passes; private scope is refused before any fetch", () => {
    const route = selectPiGoRoute("pi-go-spark", goCatalog(), ["pi-go-spark"], { scope: "public" });
    expect(route.provider).toBe(PI_GO_PROVIDER_ID);
    expect(route.model).toBe(PI_GO_MODEL_ID);
    expect(route.sku).toBe(PI_GO_SKU);
    expect(() => selectPiGoRoute("pi-go-spark", goCatalog(), ["pi-go-spark"], { scope: "private" })).toThrow(
      PiRouteScopeRefusedError
    );
  });

  test("Zen payer, wrong model, and missing SKU are denied without substitution", () => {
    const catalog = goCatalog();
    expect(() => selectPiGoRoute("pi-zen-other", catalog, ["pi-zen-other"], { scope: "public" })).toThrow(
      PiRouteDeniedError
    );
    expect(() => selectPiGoRoute("pi-go-wrong-model", catalog, ["pi-go-wrong-model"], { scope: "public" })).toThrow(
      PiRouteDeniedError
    );
    expect(() => selectPiGoRoute("pi-go-no-sku", catalog, ["pi-go-no-sku"], { scope: "public" })).toThrow(
      PiRouteDeniedError
    );
  });

  test("disabled route stays off; unknown profile stays not-found", () => {
    expect(() => selectPiGoRoute("pi-go-spark", goCatalog(), [], { scope: "public" })).toThrow(PiRouteNotAllowedError);
    expect(() => selectPiGoRoute("pi-missing", goCatalog(), ["pi-missing"], { scope: "public" })).toThrow(
      PiRouteNotFoundError
    );
  });
});

describe("Go error classification uses exact live strings", () => {
  test("missing subscription is denied, never quota", () => {
    expect(
      classifyPiGoError(
        '{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}'
      )
    ).toBe("denied");
    expect(classifyPiGoError("OpenCode Go subscription required.")).toBe("denied");
    expect(toPiGoAdapterResult("OpenCode Go subscription required.").kind).toBe("denied");
    expect(toPiGoAdapterResult("OpenCode Go subscription required.").retryable).toBe(false);
  });

  test("401 stays auth-expiry; quota stays quota; missing session is a client failure", () => {
    expect(classifyPiGoError("API Error: 401 Unauthorized")).toBe("auth-expired");
    expect(classifyPiGoError("Go limit reached, retry in 45 minutes")).toBe("quota");
    expect(classifyPiGoError("FreeUsageLimitError: Free usage exceeded")).toBe("quota");
    expect(classifyPiGoError("Error from provider (Console Go): Request is missing x-opencode-session")).toBe(
      "provider-failure"
    );
    expect(toPiGoAdapterResult("Request is missing x-opencode-session").retryable).toBe(false);
    expect(classifyPiGoError("cancelled")).toBe("cancelled");
  });

  test("usage missing is not zero; reported usage is attached", () => {
    expect(toPiGoAdapterResult("boom").usage).toBeUndefined();
    const withUsage = toPiGoAdapterResult("boom", { inputTokens: 0, outputTokens: 0 });
    expect(withUsage.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("Go transport wrapper enforces headers at the provider boundary", () => {
  test("session header derives from the loop session id; UA and client are enforced", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const inner = {
      stream: async (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
        captured.push({ ...(options as object) });
        return "stream-result";
      },
      streamSimple: async (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
        captured.push({ ...(options as object) });
        return "simple-result";
      },
    };
    const wrapped = withPiGoTransport(inner);
    const sessionId = createPiGoSessionId(() => "b".repeat(32));
    await wrapped.stream({}, {}, { sessionId });
    await wrapped.streamSimple({}, {}, { sessionId });
    expect(captured).toHaveLength(2);
    for (const options of captured) {
      const headers = options.headers as Record<string, string>;
      expect(headers[PI_GO_SESSION_HEADER]).toBe(sessionId);
      expect(headers["User-Agent"]).toBe(PI_GO_USER_AGENT);
      expect(headers["x-opencode-client"]).toBe(PI_GO_CLIENT_NAME);
      expect(options.sessionId).toBe(sessionId);
    }
  });

  test("an explicit session header is respected; a missing session id adds none", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const inner = {
      stream: async (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
        captured.push({ ...(options as object) });
        return "ok";
      },
      streamSimple: undefined as never,
    };
    const wrapped = withPiGoTransport(inner);
    await wrapped.stream({}, {}, { sessionId: "agent-session-1", headers: { [PI_GO_SESSION_HEADER]: "keep-me" } });
    await wrapped.stream({}, {}, {});
    expect((captured[0]!.headers as Record<string, string>)[PI_GO_SESSION_HEADER]).toBe("keep-me");
    expect((captured[0]!.headers as Record<string, string>)["User-Agent"]).toBe(PI_GO_USER_AGENT);
    expect((captured[1]!.headers as Record<string, string>)[PI_GO_SESSION_HEADER]).toBeUndefined();
  });
});

describe("Go HTTP round trip against loopback", () => {
  test("tool flow is irrelevant here: headers, path, model and usage map exactly once", async () => {
    const requests: Array<{ headers: Record<string, string>; url: string; body: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });
        requests.push({ headers, url: req.url, body: await req.text() });
        return Response.json({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        });
      },
    });
    try {
      const sessionId = createPiGoSessionId(() => "c".repeat(32));
      const result = await postPiGoChatCompletion({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "loopback-go-key",
        sessionId,
      });
      expect(result.kind).toBe("ok");
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
      expect(requests).toHaveLength(1);
      const only = requests[0]!;
      expect(only.url).toContain(PI_GO_CHAT_COMPLETIONS_PATH);
      expect(only.headers.authorization).toBe("Bearer loopback-go-key");
      expect(only.headers[PI_GO_SESSION_HEADER]).toBe(sessionId);
      expect(only.headers["user-agent"]).toBe(PI_GO_USER_AGENT);
      expect(only.headers["x-opencode-client"]).toBe(PI_GO_CLIENT_NAME);
      expect(JSON.parse(only.body).model).toBe(PI_GO_MODEL_ID);
    } finally {
      server.stop(true);
    }
  });

  test("missing key fails closed with zero loopback requests", async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ ok: true });
      },
    });
    try {
      const result = await postPiGoChatCompletion({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: undefined,
        sessionId: createPiGoSessionId(),
      });
      expect(result.kind).toBe("auth-expired");
      expect(hits).toBe(0);
      expect(() => buildPiGoStreamOptions({ apiKey: undefined, sessionId: createPiGoSessionId() })).toThrow();
    } finally {
      server.stop(true);
    }
  });

  test("invalid session id fails closed with zero loopback requests", async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ ok: true });
      },
    });
    try {
      await expect(
        postPiGoChatCompletion({
          baseUrl: `http://127.0.0.1:${server.port}`,
          apiKey: "loopback-go-key",
          sessionId: "../repo",
        })
      ).rejects.toThrow();
      expect(hits).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("quota refusal is quota with no metered failover: exactly one request", async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits += 1;
        return new Response("Go limit reached, retry in 45 minutes", {
          status: 429,
          headers: { "retry-after": "60", "content-type": "text/plain" },
        });
      },
    });
    try {
      const result = await postPiGoChatCompletion({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "loopback-go-key",
        sessionId: createPiGoSessionId(),
      });
      expect(result.kind).toBe("quota");
      expect(result.retryable).toBe(true);
      expect(result.quota?.retryAfterMs).toBe(60_000);
      expect(hits).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("entitlement refusal is denied, distinct from quota", async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits += 1;
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "EntitlementError", message: "OpenCode Go subscription required." },
          }),
          { status: 403, headers: { "content-type": "application/json" } }
        );
      },
    });
    try {
      const result = await postPiGoChatCompletion({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "loopback-go-key",
        sessionId: createPiGoSessionId(),
      });
      expect(result.kind).toBe("denied");
      expect(result.retryable).toBe(false);
      expect(hits).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("Go tool round trip through the Pi session", () => {
  test("selected Go route drives findings and verdict; session stays opaque and stable", async () => {
    const workdir = await tempWorkdir();
    try {
      const route = selectPiGoRoute("pi-go-spark", goCatalog(), ["pi-go-spark"], { scope: "public" });
      const seen: CapturedGoOptions[] = [];
      const { runtime, model } = await makeGoLoopback({
        steps: [
          {
            tool: "jumi_add_finding",
            args: { path: "src/a.ts", line: 1, severity: "suggestion", title: "t", body: "b" },
          },
          { tool: "jumi_set_verdict", args: { state: "success" } },
        ],
        onOptions: (options) => {
          seen.push(options);
        },
      });
      expect(runtime.getModel(route.provider, route.model)).toBeDefined();
      const store = changedStore();
      const result = await runPiReviewAttempt({
        workdir,
        prompt: "review over the Go route",
        store,
        modelRuntime: runtime,
        model,
        timeoutMs: 15_000,
      });
      expect(result.status).toBe("complete");
      expect(store.hasVerdict()).toBe(true);
      expect(store.toRecord().state).toBe("success");
      expect(seen.length).toBeGreaterThanOrEqual(2);
      const sessionIds = seen.map((options) => String(options.sessionId ?? ""));
      const first = sessionIds[0]!;
      expect(first.length).toBeGreaterThan(0);
      for (const id of sessionIds) {
        expect(id).toBe(first);
        expect(isPiGoSessionId(id)).toBe(true);
        expect(id).not.toContain(workdir);
        expect(id).not.toContain("src/a.ts");
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("fresh file key reaches the runtime as the stored Go credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-pi-go-key-"));
    try {
      const file = join(dir, "go-key");
      await writeFile(file, "fresh-go-key-9\n");
      const resolved = resolvePiGoApiKey({ [PI_GO_KEY_FILE_ENV]: file });
      expect(resolved.key).toBe("fresh-go-key-9");
      const sessionId = createPiGoSessionId();
      const options = buildPiGoStreamOptions({ apiKey: resolved.key, sessionId });
      expect(options.apiKey).toBe("fresh-go-key-9");
      expect(options.sessionId).toBe(sessionId);
      expect(options.identity.userAgent).toEqual({ custom: PI_GO_USER_AGENT });
      const headers = buildPiGoHeaders({ apiKey: options.apiKey, sessionId: options.sessionId });
      expect(headers.authorization).toBe("Bearer fresh-go-key-9");
      expect(headers[PI_GO_SESSION_HEADER]).toBe(sessionId);
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false } as never);
      expect(runtime.hasConfiguredAuth(PI_GO_PROVIDER_ID)).toBe(false);
      await runtime.setRuntimeApiKey(PI_GO_PROVIDER_ID, options.apiKey);
      expect(runtime.hasConfiguredAuth(PI_GO_PROVIDER_ID)).toBe(true);
      const auth = await runtime.getAuth(PI_GO_PROVIDER_ID, {});
      expect(auth?.auth && "apiKey" in auth.auth ? auth.auth.apiKey : undefined).toBe("fresh-go-key-9");
      const loader = createTrustedPiResourceLoader("base");
      const settings = createPiReviewSettings();
      expect(loader.getSystemPrompt()).toContain("Jumi");
      expect(settings.getSettings()).toMatchObject({ enableAnalytics: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("privacy denial happens at selection time, before any session starts", async () => {
    const workdir = await tempWorkdir();
    try {
      expect(() => selectPiGoRoute("pi-go-spark", goCatalog(), ["pi-go-spark"], { scope: "private" })).toThrow(
        PiRouteScopeRefusedError
      );
      expect(changedStore().hasVerdict()).toBe(false);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
