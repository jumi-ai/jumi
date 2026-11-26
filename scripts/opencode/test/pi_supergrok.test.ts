/**
 * Direct SuperGrok Pi route tests (jumi#938). CI never signs in, never
 * contacts vendors, and never asserts billing: every network peer here is a
 * loopback `Bun.serve` on 127.0.0.1 and every credential is a dummy.
 */

import { describe, expect, test } from "bun:test";
import {
  KNOWN_PI_ENDPOINTS,
  type PiProfileCatalog,
  PiRouteDeniedError,
  PiRouteNotAllowedError,
  piAllowedRoutesFromEnv,
  resolvePiProfile,
  selectPiRoute,
} from "../src/pi_profiles.ts";
import {
  assertNoForbiddenSupergrokSource,
  assertSupergrokSessionId,
  checkSupergrokOperatorGates,
  classifySupergrokPiError,
  createSupergrokSessionId,
  isSupergrokApiKeyCredential,
  isSupergrokGoPool,
  isSupergrokImpersonatedClientId,
  isSupergrokSessionId,
  PI_SUPERGROK_CHAT_COMPLETIONS_PATH,
  PI_SUPERGROK_DOC,
  PI_SUPERGROK_ENDPOINT,
  PI_SUPERGROK_GO_PAYER,
  PI_SUPERGROK_GO_POOL,
  PI_SUPERGROK_GROK_CLI_CLIENT_ID,
  PI_SUPERGROK_OPEN_QUESTIONS,
  PI_SUPERGROK_PAYER,
  PI_SUPERGROK_POOL,
  PI_SUPERGROK_PRICING_URL,
  PI_SUPERGROK_PROVIDER_ID,
  PI_SUPERGROK_ROUTE_NAME,
  PI_SUPERGROK_THIRD_PARTY_PROVIDERS,
  postSupergrokChatCompletion,
  redactSupergrokPiText,
  SupergrokFixtureStore,
  type SupergrokOperatorGate,
  SupergrokPiDeniedError,
  selectSupergrokPiRoute,
  supergrokBlockedReason,
  supergrokChildView,
  supergrokChildViewLeaks,
  supergrokMissingCredentialMessage,
  supergrokPiProfileDefinition,
  toSupergrokPiAdapterResult,
} from "../src/pi_supergrok.ts";

function supergrokCatalog(): PiProfileCatalog {
  return {
    [PI_SUPERGROK_ROUTE_NAME]: {
      provider: PI_SUPERGROK_PROVIDER_ID,
      model: "example-grok-fictional",
      endpoint: PI_SUPERGROK_ENDPOINT,
      fundingPool: PI_SUPERGROK_POOL,
      payer: PI_SUPERGROK_PAYER,
      credentialRef: "env:EXAMPLE_SUPERGROK_OAUTH_CREDENTIAL",
      scopes: ["public"],
    },
    "pi-supergrok-go-pool": {
      provider: PI_SUPERGROK_PROVIDER_ID,
      model: "example-grok-fictional",
      endpoint: PI_SUPERGROK_ENDPOINT,
      fundingPool: PI_SUPERGROK_GO_POOL,
      payer: PI_SUPERGROK_GO_PAYER,
      credentialRef: "env:EXAMPLE_GO_KEY",
      scopes: ["public"],
    },
    "pi-supergrok-private": {
      provider: PI_SUPERGROK_PROVIDER_ID,
      model: "example-grok-fictional",
      endpoint: PI_SUPERGROK_ENDPOINT,
      fundingPool: PI_SUPERGROK_POOL,
      payer: PI_SUPERGROK_PAYER,
      credentialRef: "env:EXAMPLE_SUPERGROK_OAUTH_CREDENTIAL",
      scopes: ["public", "private"],
    },
  };
}

describe("supergrok route constants", () => {
  test("route stays on its own payer, pool, endpoint, and allowlist name", () => {
    expect(PI_SUPERGROK_ROUTE_NAME).toBe("pi-supergrok-direct");
    expect(PI_SUPERGROK_PROVIDER_ID).toBe("xai");
    expect(PI_SUPERGROK_ENDPOINT).toBe("https://api.x.ai/v1");
    expect(PI_SUPERGROK_PAYER).toBe("supergrok-subscription");
    expect(PI_SUPERGROK_POOL).toBe("supergrok-pool");
    expect(PI_SUPERGROK_GO_PAYER).not.toBe(PI_SUPERGROK_PAYER);
    expect(PI_SUPERGROK_GO_POOL).not.toBe(PI_SUPERGROK_POOL);
    expect(KNOWN_PI_ENDPOINTS).toContain(PI_SUPERGROK_ENDPOINT);
    expect(PI_SUPERGROK_DOC).toBe("https://docs.x.ai/x-subscription/usage-limits");
    expect(PI_SUPERGROK_PRICING_URL).toBe("https://x.ai/pricing");
    expect(PI_SUPERGROK_GROK_CLI_CLIENT_ID).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(PI_SUPERGROK_CHAT_COMPLETIONS_PATH).toBe("/chat/completions");
    expect([...PI_SUPERGROK_THIRD_PARTY_PROVIDERS]).toEqual(["supergrok", "xai-auth"]);
    expect(PI_SUPERGROK_OPEN_QUESTIONS.length).toBeGreaterThan(0);
  });

  test("profile is fictional and resolves on the official xAI base", () => {
    const def = supergrokPiProfileDefinition();
    expect(def.provider).toBe("xai");
    expect(def.endpoint).toBe("https://api.x.ai/v1");
    expect(def.payer).toBe("supergrok-subscription");
    expect(def.fundingPool).toBe("supergrok-pool");
    expect(def.credentialRef).toContain("EXAMPLE_");
    expect(def.credentialRef).not.toMatch(/sk-|xai-[A-Za-z0-9]{8,}/);
    const route = resolvePiProfile(PI_SUPERGROK_ROUTE_NAME, supergrokCatalog());
    expect(route.payer).toBe("supergrok-subscription");
    expect(route.fundingPool).toBe("supergrok-pool");
  });

  test("deployment allowlist defaults off; fixture allowlist is not a production opt-in", () => {
    expect(piAllowedRoutesFromEnv({})).toEqual([]);
    expect(() => selectSupergrokPiRoute(PI_SUPERGROK_ROUTE_NAME, supergrokCatalog(), [], { scope: "public" })).toThrow(
      PiRouteNotAllowedError
    );
    const route = selectSupergrokPiRoute(PI_SUPERGROK_ROUTE_NAME, supergrokCatalog(), [PI_SUPERGROK_ROUTE_NAME], {
      scope: "public",
    });
    expect(route.name).toBe(PI_SUPERGROK_ROUTE_NAME);
    expect(piAllowedRoutesFromEnv({})).toEqual([]);
  });
});

describe("correct quota pool and no payer substitution", () => {
  test("Go payer/pool is refused without failover", () => {
    expect(isSupergrokGoPool("go-subscription", "go-pool")).toBe(true);
    expect(isSupergrokGoPool("supergrok-subscription", "supergrok-pool")).toBe(false);
    expect(() =>
      selectSupergrokPiRoute("pi-supergrok-go-pool", supergrokCatalog(), ["pi-supergrok-go-pool"], { scope: "public" })
    ).toThrow(PiRouteDeniedError);
  });

  test("quota pool on the resolved route is the SuperGrok pool", () => {
    const route = selectPiRoute(PI_SUPERGROK_ROUTE_NAME, supergrokCatalog(), [PI_SUPERGROK_ROUTE_NAME], {
      scope: "public",
    });
    expect(route.fundingPool).toBe("supergrok-pool");
    expect(route.payer).toBe("supergrok-subscription");
    expect(route.fundingPool).not.toBe("go-pool");
  });

  test("private scope is refused until data handling is confirmed", () => {
    expect(() =>
      selectSupergrokPiRoute("pi-supergrok-private", supergrokCatalog(), ["pi-supergrok-private"], {
        scope: "private",
      })
    ).toThrow(PiRouteDeniedError);
  });
});

describe("no impersonation, token reuse, or API/Go fallback", () => {
  test("borrowed Grok-CLI client id is impersonation", () => {
    expect(isSupergrokImpersonatedClientId(PI_SUPERGROK_GROK_CLI_CLIENT_ID)).toBe(true);
    expect(isSupergrokImpersonatedClientId("dynamic_agent_client")).toBe(false);
    let failed: unknown;
    try {
      assertNoForbiddenSupergrokSource({ clientId: PI_SUPERGROK_GROK_CLI_CLIENT_ID });
    } catch (err) {
      failed = err;
    }
    expect(failed).toBeInstanceOf(SupergrokPiDeniedError);
    expect(String((failed as Error).message)).toMatch(/impersonation/);
  });

  test("API-key credentials are refused", () => {
    expect(isSupergrokApiKeyCredential("xai-abc123456789")).toBe(true);
    expect(isSupergrokApiKeyCredential("sk-ant-abc123456789")).toBe(true);
    expect(isSupergrokApiKeyCredential("dummy-supergrok-access-1")).toBe(false);
    expect(() => assertNoForbiddenSupergrokSource({ accessToken: "xai-abc123456789" })).toThrow(/per-token/);
  });

  test("third-party provider ids and token paths are refused", () => {
    expect(() => assertNoForbiddenSupergrokSource({ provider: "supergrok" })).toThrow(/third-party/);
    expect(() => assertNoForbiddenSupergrokSource({ provider: "xai-auth" })).toThrow(/third-party/);
    expect(() => assertNoForbiddenSupergrokSource({ endpoint: "https://opencode.ai/inference/go" })).toThrow(
      /Console gateway/
    );
    expect(() => assertNoForbiddenSupergrokSource({ tokenPath: "~/.grok/auth.json" })).toThrow(/token reuse/);
  });

  test("selection carries the forbidden-source checks", () => {
    expect(() =>
      selectSupergrokPiRoute(PI_SUPERGROK_ROUTE_NAME, supergrokCatalog(), [PI_SUPERGROK_ROUTE_NAME], {
        scope: "public",
        clientId: PI_SUPERGROK_GROK_CLI_CLIENT_ID,
      })
    ).toThrow(/impersonation/);
    expect(() =>
      selectSupergrokPiRoute(PI_SUPERGROK_ROUTE_NAME, supergrokCatalog(), [PI_SUPERGROK_ROUTE_NAME], {
        scope: "public",
        accessToken: "xai-abc123456789",
      })
    ).toThrow(/per-token/);
  });
});

describe("operator gates keep the route disabled", () => {
  test("empty evidence blocks on every gate", () => {
    const feasibility = checkSupergrokOperatorGates({ allowlist: [] });
    expect(feasibility.feasible).toBe(false);
    expect(feasibility.blocked.length).toBe(5);
    const gateIds: string[] = (feasibility.gates as SupergrokOperatorGate[]).map((gate) => gate.id);
    expect(gateIds).toEqual([
      "deployment-scope",
      "operator-tier",
      "unattended-client",
      "eligible-surface",
      "entitlement-mapping",
    ]);
  });

  test("allowlist alone does not authorize the route", () => {
    const feasibility = checkSupergrokOperatorGates({ allowlist: [PI_SUPERGROK_ROUTE_NAME] });
    expect(feasibility.feasible).toBe(false);
    expect(feasibility.blocked.join(" ")).toMatch(/operator-tier|unattended-client|eligible-surface/);
  });

  test("all gates confirmed is feasible; blocked reason names the docs", () => {
    const feasibility = checkSupergrokOperatorGates({
      allowlist: [PI_SUPERGROK_ROUTE_NAME],
      tierConfirmed: true,
      unattendedClientConfirmed: true,
      eligibleSurfaceConfirmed: true,
      entitlementMappingConfirmed: true,
    });
    expect(feasibility.feasible).toBe(true);
    expect(supergrokBlockedReason(checkSupergrokOperatorGates({ allowlist: [] }))).toContain(PI_SUPERGROK_DOC);
  });
});

describe("adapter result contract", () => {
  test("auth expiry stays distinct from quota and denial", () => {
    expect(classifySupergrokPiError("invalid_grant: token revoked")).toBe("auth-expired");
    expect(classifySupergrokPiError("API Error: 401 Unauthorized")).toBe("auth-expired");
    expect(classifySupergrokPiError("SuperGrok subscription required (403)")).toBe("denied");
    expect(classifySupergrokPiError("Go limit reached, retry in 45 minutes")).toBe("quota");
  });

  test("quota carries the stated reset and stays retryable with no failover", () => {
    const result = toSupergrokPiAdapterResult("rate limited, reset in 60s", undefined, {
      resetting: true,
      retryAfterMs: 60_000,
    });
    expect(result.kind).toBe("quota");
    expect(result.quota?.resetting).toBe(true);
    expect(result.quota?.retryAfterMs).toBe(60_000);
    expect(result.retryable).toBe(true);
  });

  test("denied and cancelled stay distinct; missing usage is not zero", () => {
    expect(toSupergrokPiAdapterResult("SuperGrok subscription required").kind).toBe("denied");
    expect(toSupergrokPiAdapterResult("cancelled").kind).toBe("cancelled");
    expect(toSupergrokPiAdapterResult("ok").kind).toBe("provider-failure");
  });
});

describe("direct tool round trip on loopback", () => {
  async function serveOnce(handler: (req: Request) => Response | Promise<Response>) {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: handler,
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop() };
  }

  test("bearer-only request succeeds and reports usage", async () => {
    let seenAuth = "";
    let seenSession = "";
    let requests = 0;
    const upstream = await serveOnce(async (req) => {
      requests += 1;
      seenAuth = req.headers.get("authorization") ?? "";
      seenSession = req.headers.get("x-supergrok-session") ?? "";
      const body = (await req.json()) as { usage?: unknown };
      void body;
      return Response.json({ usage: { prompt_tokens: 3, completion_tokens: 7 } });
    });
    try {
      const sessionId = createSupergrokSessionId(() => "a".repeat(32));
      const result = await postSupergrokChatCompletion({
        baseUrl: upstream.url,
        accessToken: "dummy-supergrok-access-1",
        sessionId,
      });
      expect(result.kind).toBe("ok");
      expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 7 });
      expect(seenAuth).toBe("Bearer dummy-supergrok-access-1");
      expect(seenSession).toBe(sessionId);
      expect(requests).toBe(1);
    } finally {
      upstream.stop();
    }
  });

  test("missing bearer fails closed with zero requests", async () => {
    let requests = 0;
    const upstream = await serveOnce(() => {
      requests += 1;
      return Response.json({});
    });
    try {
      const result = await postSupergrokChatCompletion({
        baseUrl: upstream.url,
        accessToken: undefined,
        sessionId: createSupergrokSessionId(() => "b".repeat(32)),
      });
      expect(result.kind).toBe("auth-expired");
      expect(requests).toBe(0);
      expect(supergrokMissingCredentialMessage()).not.toMatch(/dummy|sk-|xai-/);
    } finally {
      upstream.stop();
    }
  });

  test("quota refusal makes exactly one request and carries retry-after", async () => {
    let requests = 0;
    const upstream = await serveOnce(() => {
      requests += 1;
      return new Response("weekly pool exhausted, reset soon", {
        status: 429,
        headers: { "retry-after": "90" },
      });
    });
    try {
      const result = await postSupergrokChatCompletion({
        baseUrl: upstream.url,
        accessToken: "dummy-supergrok-access-1",
        sessionId: createSupergrokSessionId(() => "c".repeat(32)),
      });
      expect(result.kind).toBe("quota");
      expect(result.quota?.retryAfterMs).toBe(90_000);
      expect(requests).toBe(1);
    } finally {
      upstream.stop();
    }
  });

  test("revoked/expired session fails closed as auth death", async () => {
    let requests = 0;
    const upstream = await serveOnce(() => {
      requests += 1;
      return new Response("invalid_grant: token revoked", { status: 401 });
    });
    try {
      const result = await postSupergrokChatCompletion({
        baseUrl: upstream.url,
        accessToken: "dummy-revoked-access",
        sessionId: createSupergrokSessionId(() => "d".repeat(32)),
      });
      expect(result.kind).toBe("auth-expired");
      expect(result.authExpired).toBe(true);
      expect(requests).toBe(1);
    } finally {
      upstream.stop();
    }
  });

  test("non-opaque session id fails before any fetch", async () => {
    let requests = 0;
    const upstream = await serveOnce(() => {
      requests += 1;
      return Response.json({});
    });
    try {
      await expect(
        postSupergrokChatCompletion({ baseUrl: upstream.url, accessToken: "dummy-x", sessionId: "repo/a/b" })
      ).rejects.toThrow(/opaque conversation/);
      expect(requests).toBe(0);
    } finally {
      upstream.stop();
    }
  });
});

describe("session identity", () => {
  test("opaque ids pass, repo/user identity fails", () => {
    expect(isSupergrokSessionId(createSupergrokSessionId(() => "e".repeat(32)))).toBe(true);
    expect(isSupergrokSessionId("repo/owner/name")).toBe(false);
    expect(isSupergrokSessionId("user@example.com")).toBe(false);
    expect(isSupergrokSessionId("")).toBe(false);
    expect(() => assertSupergrokSessionId("repo/a")).toThrow(/opaque/);
  });
});

describe("fixture credential boundary", () => {
  function seed(at: number) {
    return { access: "dummy-access-1", refresh: "dummy-refresh-1", expiresAtMs: at + 3_600_000 };
  }

  test("permitted inference succeeds; unknown bearer fails", () => {
    const store = new SupergrokFixtureStore(seed(1_000_000), { now: () => 1_000_000 });
    expect(store.inference("dummy-access-1")).toBe(true);
    expect(store.inference("wrong-bearer")).toBe(false);
  });

  test("revoked session fails closed", () => {
    const store = new SupergrokFixtureStore(seed(1_000_000), { now: () => 1_000_000 });
    store.revoke();
    expect(store.inference("dummy-access-1")).toBe(false);
  });

  test("expired session fails closed until refresh", async () => {
    let now = 1_000_000;
    const store = new SupergrokFixtureStore(seed(now), { now: () => now });
    expect(store.inference("dummy-access-1")).toBe(true);
    now = 1_000_000 + 3_600_001;
    expect(store.inference("dummy-access-1")).toBe(false);
    const rotated = await store.refresh();
    expect(rotated.access).not.toBe("dummy-access-1");
    expect(store.inference(rotated.access)).toBe(true);
    expect(store.inference("dummy-access-1")).toBe(true);
  });

  test("concurrent refresh shares one POST and cannot invalidate the other job", async () => {
    const store = new SupergrokFixtureStore(seed(1_000_000), { now: () => 1_000_000 });
    const [first, second] = await Promise.all([store.refresh(), store.refresh()]);
    expect(store.posts).toBe(1);
    expect(first.access).toBe(second.access);
    expect(store.inference(first.access)).toBe(true);
    expect(store.inference(second.access)).toBe(true);
  });

  test("tool context never observes the refresh grant or another payer", () => {
    const store = new SupergrokFixtureStore(seed(1_000_000), { now: () => 1_000_000 });
    const secret = store.snapshot();
    const view = store.childView();
    expect(supergrokChildViewLeaks(view, secret)).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain(secret.refresh);
    const bare = supergrokChildView("dummy-access-1");
    expect(JSON.stringify(bare)).not.toMatch(/GITEA|GITHUB|WEBHOOK|SECRETS/);
    expect(JSON.stringify(bare)).not.toContain("opencode-go");
  });
});

describe("redaction and quota hold", () => {
  test("bearer, refresh, and codes are scrubbed", () => {
    const bearer = "dummy-supergrok-bearer-abcdef123456";
    const refresh = "dummy-supergrok-refresh-abcdef123456";
    const redacted = redactSupergrokPiText(`Bearer ${bearer} refresh_token=${refresh} user_code=ABCD-1234`, [
      bearer,
      refresh,
    ]);
    expect(redacted).not.toContain(bearer);
    expect(redacted).not.toContain(refresh);
    expect(redacted).toContain("[redacted]");
  });

  test("error text from the transport never contains the bearer", async () => {
    const bearer = "dummy-supergrok-bearer-abcdef123456";
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(`boom for ${bearer}`, { status: 500 }),
    });
    try {
      const result = await postSupergrokChatCompletion({
        baseUrl: `http://127.0.0.1:${upstream.port}`,
        accessToken: bearer,
        sessionId: createSupergrokSessionId(() => "f".repeat(32)),
      });
      expect(result.kind).toBe("provider-failure");
      expect(JSON.stringify(result)).not.toContain(bearer);
    } finally {
      upstream.stop();
    }
  });

  test("quota hold blocks with rate-limited status and no spend failover", () => {
    const result = toSupergrokPiAdapterResult("weekly pool exhausted", undefined, { resetting: true });
    expect(result.kind).toBe("quota");
    expect(result.retryable).toBe(true);
    expect(result.message ?? "").not.toMatch(/top-up|topup|Extra Usage/i);
  });
});
