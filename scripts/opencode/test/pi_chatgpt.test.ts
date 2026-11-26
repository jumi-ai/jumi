import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertChatGptModelAvailable,
  assertNoForbiddenChatGptSource,
  buildChatGptResponsesRequest,
  type ChatGptChildView,
  ChatGptCredentialError,
  ChatGptDeniedError,
  type ChatGptFeasibility,
  ChatGptFixtureStore,
  ChatGptModelUnavailableError,
  type ChatGptOperatorGate,
  chatGptChildViewLeaks,
  chatGptPiProfileDefinition,
  chatGptResultFromCompletion,
  chatGptResultFromError,
  checkChatGptOperatorGates,
  classifyChatGptError,
  filterChatGptListableModels,
  hasChatGptDirectScope,
  isAlternateClientIdentity,
  isChatGptAccessExpired,
  isChatGptStreamComplete,
  isCodexCliCredentialSource,
  isIssuedChatGptClientId,
  isPlatformKeyCredential,
  needsChatGptRefresh,
  PI_CHATGPT_AUTHORIZE_URL,
  PI_CHATGPT_BACKEND_API_HOST,
  PI_CHATGPT_DIRECT_SCOPE,
  PI_CHATGPT_DOC,
  PI_CHATGPT_DYNAMIC_CLIENT_ID,
  PI_CHATGPT_ELIGIBLE_MODEL,
  PI_CHATGPT_ENDPOINT,
  PI_CHATGPT_MODELS_URL,
  PI_CHATGPT_PROVIDER,
  PI_CHATGPT_REQUIRED_SCOPES,
  PI_CHATGPT_RESOURCE,
  PI_CHATGPT_RESPONSES_URL,
  PI_CHATGPT_ROUTE_NAME,
  PI_CHATGPT_TOKEN_URL,
  PI_CHATGPT_UNSUPPORTED_RESPONSE_FIELDS,
  redactChatGptText,
  validateChatGptCredential,
} from "../src/pi_chatgpt.ts";
import { hasPiUsage, PiRouteNotAllowedError, resolvePiProfile, selectPiRoute } from "../src/pi_profiles.ts";

function seedDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jumi-chatgpt-"));
}

describe("chatgpt oss route constants", () => {
  test("uses only the public Responses API, never the Codex backend", () => {
    expect(PI_CHATGPT_RESPONSES_URL).toBe("https://api.openai.com/v1/responses");
    expect(PI_CHATGPT_MODELS_URL).toBe("https://api.openai.com/v1/models");
    expect(PI_CHATGPT_TOKEN_URL).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(PI_CHATGPT_AUTHORIZE_URL).toContain("auth.openai.com");
    expect(PI_CHATGPT_RESOURCE).toBe("https://api.openai.com/v1");
    expect(PI_CHATGPT_DOC).toBe("https://developers.openai.com/siwc/token-sharing-open-source");
    expect(PI_CHATGPT_DIRECT_SCOPE).toBe("chatgpt.tokens.use.direct");
    expect(PI_CHATGPT_REQUIRED_SCOPES).toContain(PI_CHATGPT_DIRECT_SCOPE);
    expect(PI_CHATGPT_ELIGIBLE_MODEL).toBe("gpt-6.2-sol");
    expect(PI_CHATGPT_ENDPOINT).toBe("https://api.openai.com/v1");
    expect(PI_CHATGPT_PROVIDER).toBe("openai");
    expect(PI_CHATGPT_ROUTE_NAME).toBe("pi-chatgpt-oss");
    expect(PI_CHATGPT_DYNAMIC_CLIENT_ID).toBe("dynamic_agent_client");
    expect(PI_CHATGPT_BACKEND_API_HOST).toBe("chatgpt.com");
    expect(PI_CHATGPT_UNSUPPORTED_RESPONSE_FIELDS).toContain("temperature");
    expect(PI_CHATGPT_UNSUPPORTED_RESPONSE_FIELDS).toContain("previous_response_id");
  });

  test("profile resolves on the public endpoint with a fictional credential ref", () => {
    const def = chatGptPiProfileDefinition();
    expect(def.provider).toBe("openai");
    expect(def.model).toBe("gpt-6.2-sol");
    expect(def.endpoint).toBe("https://api.openai.com/v1");
    expect(def.credentialRef).toContain("EXAMPLE_");
    expect(def.credentialRef).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  test("route is disabled by default: allowlist gates selection without substitution", () => {
    const catalog = { [PI_CHATGPT_ROUTE_NAME]: chatGptPiProfileDefinition() };
    expect(resolvePiProfile(PI_CHATGPT_ROUTE_NAME, catalog).model).toBe("gpt-6.2-sol");
    expect(() => selectPiRoute(PI_CHATGPT_ROUTE_NAME, catalog, [])).toThrow(PiRouteNotAllowedError);
    const allowed = selectPiRoute(PI_CHATGPT_ROUTE_NAME, catalog, [PI_CHATGPT_ROUTE_NAME]);
    expect(allowed.model).toBe("gpt-6.2-sol");
  });
});

describe("chatgpt fixture fresh-job contract", () => {
  test("permitted inference, restart, concurrent refresh, revocation, exposure", async () => {
    const dir = await seedDir();
    try {
      const store = new ChatGptFixtureStore(dir);
      await store.persist();
      const before = store.snapshot();
      expect(store.inference(before.access)).toBe(true);
      expect(store.inference("wrong-bearer")).toBe(false);

      await store.restart();
      const afterRestart = store.snapshot();
      expect(afterRestart.access).toBe(before.access);
      expect(store.inference(afterRestart.access)).toBe(true);

      const [first, second] = await Promise.all([store.refresh(), store.refresh()]);
      expect(store.posts).toBe(1);
      expect(store.inference(first.access)).toBe(true);
      expect(store.inference(second.access)).toBe(true);
      expect(first.access).toBe(second.access);

      const exposed = store.snapshot();
      const view = store.childView();
      expect(chatGptChildViewLeaks(view, exposed)).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain(exposed.refresh);

      store.revoke();
      expect(store.inference(second.access)).toBe(false);
      expect(store.inference("wrong-bearer")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rotation does not revoke an already-issued bearer", async () => {
    const dir = await seedDir();
    try {
      const store = new ChatGptFixtureStore(dir);
      await store.persist();
      const before = store.snapshot().access;
      const rotated = await store.refresh();
      expect(rotated.access).not.toBe(before);
      expect(store.inference(before)).toBe(true);
      expect(store.inference(rotated.access)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("orphan sibling from an interrupted write is adopted on restart", async () => {
    const dir = await seedDir();
    try {
      const store = new ChatGptFixtureStore(dir);
      await store.persist();
      const before = store.snapshot();
      const orphan = {
        current: {
          ...before,
          access: "dummy-chatgpt-access-newer",
          refresh: "dummy-chatgpt-refresh-newer",
          generation: before.generation + 1,
        },
        issued: [before.access, "dummy-chatgpt-access-newer"],
      };
      await writeFile(join(dir, "chatgpt-oss.json.jumi-orphan.tmp"), JSON.stringify(orphan));
      await store.restart();
      expect(store.snapshot().access).toBe("dummy-chatgpt-access-newer");
      expect(store.inference("dummy-chatgpt-access-newer")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("chatgpt expiry, reconnect, and entitlement", () => {
  test("expired access fails closed; a refresh reconnects without a second POST", async () => {
    const dir = await seedDir();
    try {
      const store = new ChatGptFixtureStore(dir);
      await store.persist();
      const before = store.snapshot();
      expect(isChatGptAccessExpired(before)).toBe(false);
      expect(needsChatGptRefresh({ expiresAtMs: Date.now() + 3600_000 })).toBe(false);
      expect(needsChatGptRefresh({ expiresAtMs: Date.now() + 60_000 })).toBe(true);
      store.expireForTest();
      const expired = store.snapshot();
      expect(isChatGptAccessExpired(expired)).toBe(true);
      expect(store.inference(expired.access)).toBe(false);
      const [first, second] = await Promise.all([store.refresh(), store.refresh()]);
      expect(store.posts).toBe(1);
      expect(first.access).toBe(second.access);
      expect(store.inference(first.access)).toBe(true);
      expect(store.inference(before.access)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing direct scope is identity only: inference refused and validation fails", async () => {
    const dir = await seedDir();
    try {
      const store = new ChatGptFixtureStore(dir);
      await store.persist();
      store.dropDirectScopeForTest();
      const scoped = store.snapshot();
      expect(hasChatGptDirectScope(scoped.scopes)).toBe(false);
      expect(store.inference(scoped.access)).toBe(false);
      expect(() =>
        validateChatGptCredential({
          clientId: scoped.clientId,
          extAgentHostId: scoped.hostId,
          accessToken: scoped.access,
          refreshToken: scoped.refresh,
          scopes: scoped.scopes,
          expiresAtMs: scoped.expiresAtMs,
          savedAt: new Date().toISOString(),
        })
      ).toThrow(ChatGptCredentialError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("credential validation rejects incomplete registration and platform keys", () => {
    expect(isIssuedChatGptClientId("oaiapp_abc")).toBe(true);
    expect(isIssuedChatGptClientId("dynamic_agent_client")).toBe(false);
    expect(isIssuedChatGptClientId("")).toBe(false);
    expect(hasChatGptDirectScope(["openid", "chatgpt.tokens.use.direct"])).toBe(true);
    expect(hasChatGptDirectScope(["openid"])).toBe(false);
    expect(() =>
      validateChatGptCredential({
        clientId: "dynamic_agent_client",
        extAgentHostId: "urn:uuid:11111111-1111-4111-8111-111111111111",
        accessToken: "dummy-access",
        refreshToken: "dummy-refresh",
        scopes: ["chatgpt.tokens.use.direct"],
        expiresAtMs: Date.now() + 1000,
        savedAt: new Date().toISOString(),
      })
    ).toThrow(ChatGptCredentialError);
    expect(isPlatformKeyCredential("sk-abc123")).toBe(true);
    expect(isPlatformKeyCredential("dummy-access")).toBe(false);
  });
});

describe("chatgpt redaction", () => {
  test("child view carries only the access bearer on the public endpoints", async () => {
    const dir = await seedDir();
    try {
      const store = new ChatGptFixtureStore(dir);
      const view: ChatGptChildView = store.childView(["inference", "--standalone"]);
      const secret = store.snapshot();
      expect(view.env["CHATGPT_OSS_REFRESH"]).toBeUndefined();
      expect(view.endpoints).toContain(PI_CHATGPT_RESPONSES_URL);
      expect(view.endpoints).toContain(PI_CHATGPT_MODELS_URL);
      expect(view.endpoints.join(" ")).not.toContain("oauth/token");
      expect(view.argv.join(" ")).not.toContain(secret.refresh);
      expect(JSON.stringify(view)).not.toContain(secret.refresh);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("redactor strips bearer material, platform keys, and issued ids", () => {
    const record = {
      accessToken: "dummy-chatgpt-access-1",
      refreshToken: "dummy-chatgpt-refresh-1",
      idToken: "dummy-id-token-1",
    };
    const text = `used ${record.accessToken} and ${record.refreshToken} with sk-abcDEF123456 and oaiapp_xyz123`;
    const redacted = redactChatGptText(text, record);
    expect(redacted).not.toContain(record.accessToken);
    expect(redacted).not.toContain(record.refreshToken);
    expect(redacted).not.toContain("sk-abcDEF123456");
    expect(redacted).not.toContain("oaiapp_xyz123");
  });
});

describe("chatgpt model eligibility without substitution", () => {
  test("exact gpt-6.2-sol passes; anything else is refused", () => {
    expect(assertChatGptModelAvailable("gpt-6.2-sol")).toBe("gpt-6.2-sol");
    expect(assertChatGptModelAvailable("gpt-6.2-sol", ["gpt-6.2-sol", "other"])).toBe("gpt-6.2-sol");
    expect(() => assertChatGptModelAvailable("gpt-6.1-sol")).toThrow(ChatGptModelUnavailableError);
    expect(() => assertChatGptModelAvailable("gpt-6.2-sol", ["gpt-6.1-sol"])).toThrow(ChatGptModelUnavailableError);
    expect(() => assertChatGptModelAvailable("")).toThrow(ChatGptModelUnavailableError);
  });

  test("request builder sends only the supported shape", () => {
    const request = buildChatGptResponsesRequest({
      accessToken: "dummy-chatgpt-access-1",
      model: "gpt-6.2-sol",
      input: [{ role: "user", content: "Say exactly: Hello, world!" }],
    });
    expect(request.url).toBe(PI_CHATGPT_RESPONSES_URL);
    expect(request.method).toBe("POST");
    expect(request.body["store"]).toBe(false);
    expect(request.body["stream"]).toBe(true);
    expect(request.body["model"]).toBe("gpt-6.2-sol");
    expect(() =>
      buildChatGptResponsesRequest({ accessToken: "dummy", model: "gpt-6.1-sol", input: [{ role: "user" }] })
    ).toThrow();
    expect(() =>
      buildChatGptResponsesRequest({ accessToken: "sk-abc", model: "gpt-6.2-sol", input: [{ role: "user" }] })
    ).toThrow(ChatGptDeniedError);
  });

  test("model list keeps visibility list in server order", () => {
    const payload = {
      models: [
        { slug: "gpt-6.2-sol", display_name: "Sol", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "unlisted" },
        { slug: "", display_name: "Empty", visibility: "list" },
      ],
    };
    expect(filterChatGptListableModels(payload)).toEqual([{ slug: "gpt-6.2-sol", displayName: "Sol" }]);
    expect(filterChatGptListableModels({})).toEqual([]);
  });
});

describe("chatgpt forbidden sources are never copied", () => {
  test("codex cli, platform key, and alternate identity are denied", () => {
    expect(isCodexCliCredentialSource({ path: "/home/u/.codex/auth.json" })).toBe(true);
    expect(isCodexCliCredentialSource({ baseUrl: "https://chatgpt.com/backend-api/responses" })).toBe(true);
    expect(isCodexCliCredentialSource({ headers: { "chatgpt-account-id": "abc" } })).toBe(true);
    expect(isCodexCliCredentialSource({ baseUrl: PI_CHATGPT_RESPONSES_URL })).toBe(false);
    expect(isAlternateClientIdentity("oaiapp_a", "oaiapp_b")).toBe(true);
    expect(isAlternateClientIdentity("dynamic_agent_client", "oaiapp_b")).toBe(true);
    expect(isAlternateClientIdentity("oaiapp_a", "oaiapp_a")).toBe(false);
    expect(() => assertNoForbiddenChatGptSource({ path: "/home/u/.codex/auth.json", accessToken: "dummy" })).toThrow(
      ChatGptDeniedError
    );
    expect(() => assertNoForbiddenChatGptSource({ accessToken: "sk-abc123" })).toThrow(ChatGptDeniedError);
    expect(() => assertNoForbiddenChatGptSource({ presentedClientId: "oaiapp_a", issuedClientId: "oaiapp_b" })).toThrow(
      ChatGptDeniedError
    );
  });
});

describe("chatgpt operator gates", () => {
  const feasible = {
    issuedClientId: "oaiapp_ok",
    extAgentHostId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    allowlist: [PI_CHATGPT_ROUTE_NAME],
    catalogSlugs: [PI_CHATGPT_ELIGIBLE_MODEL],
    scopes: ["openid", "chatgpt.tokens.use.direct"],
    accessToken: "dummy-chatgpt-access-1",
  };

  test("all gates satisfied is feasible", () => {
    const result: ChatGptFeasibility = checkChatGptOperatorGates(feasible);
    const gateIds: ChatGptOperatorGate["id"][] = result.gates.map((gate) => gate.id);
    expect(gateIds).toEqual(["client-registration", "deployment-scope", "model-eligibility", "plan-billing"]);
    expect(result.feasible).toBe(true);
    expect(result.blocked).toEqual([]);
  });

  test("each missing gate is recorded as blocked", () => {
    expect(
      checkChatGptOperatorGates({ ...feasible, issuedClientId: "dynamic_agent_client" }).blocked.join(" ")
    ).toContain("client-registration");
    expect(checkChatGptOperatorGates({ ...feasible, allowlist: [] }).blocked.join(" ")).toContain("deployment-scope");
    expect(checkChatGptOperatorGates({ ...feasible, catalogSlugs: ["other"] }).blocked.join(" ")).toContain(
      "model-eligibility"
    );
    expect(checkChatGptOperatorGates({ ...feasible, scopes: ["openid"] }).blocked.join(" ")).toContain("plan-billing");
    expect(
      checkChatGptOperatorGates({ ...feasible, accessToken: "sk-abc123", scopes: feasible.scopes }).blocked.join(" ")
    ).toContain("plan-billing");
  });
});

describe("chatgpt shared transport result contract", () => {
  test("tool streams, reasoning, and available usage ride the ok result", () => {
    const withUsage = chatGptResultFromCompletion({
      toolCalls: [{ name: "read", argumentsJson: "{}" }],
      reasoningDeltas: ["thinking"],
      usage: { inputTokens: 10, outputTokens: 5 },
      completed: true,
    });
    expect(withUsage.kind).toBe("ok");
    expect(hasPiUsage(withUsage)).toBe(true);
    expect(withUsage.usage?.inputTokens).toBe(10);
    const withoutUsage = chatGptResultFromCompletion({ toolCalls: [], reasoningDeltas: [], completed: true });
    expect(withoutUsage.kind).toBe("ok");
    expect(hasPiUsage(withoutUsage)).toBe(false);
    expect(chatGptResultFromCompletion({ toolCalls: [], reasoningDeltas: [], completed: false }).kind).toBe(
      "provider-failure"
    );
  });

  test("completion requires response.completed; failed codes classify exactly", () => {
    expect(isChatGptStreamComplete(["response.output_text.delta", "response.completed"])).toBe(true);
    expect(isChatGptStreamComplete(["response.output_text.delta"])).toBe(false);
    expect(isChatGptStreamComplete(["response.completed", "response.failed"])).toBe(false);
    expect(classifyChatGptError("subscription_sharing_user_not_eligible")).toBe("denied");
    expect(classifyChatGptError("subscription_sharing_usage_limit_exceeded")).toBe("quota");
    expect(classifyChatGptError("subscription_sharing_usage_unavailable")).toBe("quota");
    expect(classifyChatGptError("invalid_grant: token revoked")).toBe("auth-expired");
    expect(classifyChatGptError("cancelled")).toBe("cancelled");
    expect(chatGptResultFromError("subscription_sharing_user_not_eligible").kind).toBe("denied");
    expect(chatGptResultFromError("subscription_sharing_user_not_eligible").retryable).toBe(false);
    const quota = chatGptResultFromError("subscription_sharing_usage_limit_exceeded");
    expect(quota.kind).toBe("quota");
    expect(quota.retryable).toBe(true);
    const unavailable = chatGptResultFromError("subscription_sharing_usage_unavailable");
    expect(unavailable.kind).toBe("quota");
    expect(unavailable.quota?.resetting).toBe(true);
    expect(chatGptResultFromError("invalid_grant", { requestId: "req-1" }).message).toContain("req-1");
  });

  test("error results stay distinct across auth, quota, denial, and cancellation", () => {
    expect(chatGptResultFromError("invalid_grant").kind).toBe("auth-expired");
    expect(chatGptResultFromError("subscription_sharing_route_not_supported").kind).toBe("denied");
    expect(chatGptResultFromError("fetch failed").kind).toBe("provider-failure");
  });
});
