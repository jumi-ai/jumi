import { describe, expect, test } from "bun:test";
import {
  checkPiHandoff,
  classifyPiAdapterError,
  hasPiUsage,
  isContributorSku,
  isGooglePiModel,
  isPiRouteAllowed,
  KNOWN_PI_ENDPOINTS,
  narrowPiRoutesWithRepo,
  orderPiRoutes,
  PI_ALLOWED_ROUTES_ENV,
  type PiProfileCatalog,
  type PiProfileDefinition,
  PiRouteDeniedError,
  PiRouteNotAllowedError,
  PiRouteNotFoundError,
  PiRouteScopeRefusedError,
  type PiUsage,
  parsePiAllowedRoutes,
  piAdapterAuthExpired,
  piAdapterCancelled,
  piAdapterDenied,
  piAdapterProviderFailure,
  piAdapterQuota,
  piAllowedRoutesFromEnv,
  piFamilyOf,
  resolvePiProfile,
  selectPiRoute,
} from "../src/pi_profiles.ts";
import { parseRunnersCatalog, synthesizeRunners } from "../src/runners.ts";

const ZEN = "https://opencode.ai/zen/v1";
const GO = "https://opencode.ai/zen/go/v1";

function fixtureCatalog(): PiProfileCatalog {
  return {
    "pi-zen-main": {
      provider: "opencode",
      model: "example-code-large",
      effort: "high",
      endpoint: ZEN,
      fundingPool: "workspace-balance-pool",
      payer: "workspace-balance",
      credentialRef: "env:EXAMPLE_ZEN_KEY_A",
      scopes: ["public", "private"],
    },
    "pi-zen-alias": {
      provider: "opencode",
      model: "example-code-large",
      effort: "medium",
      endpoint: ZEN,
      fundingPool: "workspace-balance-pool",
      payer: "workspace-balance",
      credentialRef: "env:EXAMPLE_ZEN_KEY_ALIAS",
      scopes: ["public", "private"],
    },
    "pi-zen-teams": {
      provider: "opencode",
      model: "example-code-large",
      effort: "high",
      endpoint: ZEN,
      fundingPool: "team-balance-pool",
      payer: "team-balance",
      credentialRef: "env:EXAMPLE_ZEN_KEY_B",
      scopes: ["public", "private"],
    },
    "pi-go-main": {
      provider: "opencode-go",
      model: "example-code-small",
      effort: "low",
      endpoint: GO,
      fundingPool: "go-pool",
      payer: "go-subscription",
      credentialRef: "env:EXAMPLE_GO_KEY_A",
      scopes: ["public", "private"],
    },
    "pi-contributor": {
      provider: "opencode",
      model: "example-contributor-model",
      effort: "medium",
      endpoint: ZEN,
      fundingPool: "workspace-balance-pool",
      payer: "workspace-balance",
      credentialRef: "env:EXAMPLE_ZEN_KEY_CONTRIBUTOR",
      scopes: ["public"],
      sku: "contributor",
    },
    "pi-unknown-endpoint": {
      provider: "opencode",
      model: "example-code-large",
      endpoint: "https://unknown.example.invalid/v1",
      fundingPool: "workspace-balance-pool",
      payer: "workspace-balance",
      credentialRef: "env:EXAMPLE_ZEN_KEY_A",
      scopes: ["public"],
    },
    "pi-google-direct": {
      provider: "google",
      model: "gemini-fictional-test",
      endpoint: ZEN,
      fundingPool: "workspace-balance-pool",
      payer: "workspace-balance",
      credentialRef: "env:EXAMPLE_ZEN_KEY_A",
      scopes: ["public"],
    },
    "pi-go-google": {
      provider: "opencode-go",
      model: "gemini-fictional-test",
      endpoint: GO,
      fundingPool: "go-pool",
      payer: "go-subscription",
      credentialRef: "env:EXAMPLE_GO_KEY_A",
      scopes: ["public"],
    },
  };
}

describe("pi profile resolution", () => {
  test("deployment env key is stable and known endpoints cover Zen and Go", () => {
    expect(PI_ALLOWED_ROUTES_ENV).toBe("JUMI_PI_ALLOWED_ROUTES");
    expect(KNOWN_PI_ENDPOINTS).toContain("https://opencode.ai/zen/v1");
    expect(KNOWN_PI_ENDPOINTS).toContain("https://opencode.ai/zen/go/v1");
    const def: PiProfileDefinition = fixtureCatalog()["pi-zen-main"]!;
    expect(def.provider).toBe("opencode");
  });

  test("named profile resolves to exact provider, model, effort, pool, credential ref and family", () => {
    const route = resolvePiProfile("pi-zen-main", fixtureCatalog());
    expect(route.name).toBe("pi-zen-main");
    expect(route.provider).toBe("opencode");
    expect(route.model).toBe("example-code-large");
    expect(route.effort).toBe("high");
    expect(route.fundingPool).toBe("workspace-balance-pool");
    expect(route.payer).toBe("workspace-balance");
    expect(route.credentialRef).toBe("env:EXAMPLE_ZEN_KEY_A");
    expect(route.family).toBe(piFamilyOf("opencode", "example-code-large"));
  });

  test("family ignores effort and credential", () => {
    const catalog = fixtureCatalog();
    const main = resolvePiProfile("pi-zen-main", catalog);
    const alias = resolvePiProfile("pi-zen-alias", catalog);
    expect(alias.effort).toBe("medium");
    expect(alias.credentialRef).not.toBe(main.credentialRef);
    expect(alias.family).toBe(main.family);
  });

  test("all credential references are fictional", () => {
    for (const def of Object.values(fixtureCatalog())) {
      expect(def.credentialRef).toContain("EXAMPLE_");
      expect(def.credentialRef).not.toMatch(/sk-ant-|sk-[A-Za-z0-9]{20,}/);
    }
  });
});

describe("deployment allowlist is authoritative and defaults off", () => {
  test("unset or blank allowlist denies everything", () => {
    expect(parsePiAllowedRoutes(undefined)).toEqual([]);
    expect(parsePiAllowedRoutes("")).toEqual([]);
    expect(piAllowedRoutesFromEnv({})).toEqual([]);
    expect(piAllowedRoutesFromEnv({ JUMI_PI_ALLOWED_ROUTES: "  " })).toEqual([]);
  });

  test("CSV parsing trims and dedupes", () => {
    expect(parsePiAllowedRoutes("a, b,a,, c ")).toEqual(["a", "b", "c"]);
  });

  test("having a profile, key, adapter or discovered model does not enable the route", () => {
    const catalog = fixtureCatalog();
    // Resolve works: the profile exists and the credential ref is present.
    expect(resolvePiProfile("pi-zen-main", catalog).credentialRef).toContain("EXAMPLE_");
    // Selection still fails: nothing is enabled without the allowlist.
    expect(() => selectPiRoute("pi-zen-main", catalog, [])).toThrow(PiRouteNotAllowedError);
    expect(isPiRouteAllowed("pi-zen-main", [])).toBe(false);
  });

  test("configured but disabled route fails without substitution or paid fallback", () => {
    const catalog = fixtureCatalog();
    let failed: unknown;
    try {
      selectPiRoute("pi-zen-main", catalog, []);
    } catch (err) {
      failed = err;
    }
    expect(failed).toBeInstanceOf(PiRouteNotAllowedError);
    // No substitution: the error names the requested route and no other route is returned.
    expect(String((failed as Error).message)).toContain("pi-zen-main");
  });

  test("the same fixture works when explicitly allowed", () => {
    const catalog = fixtureCatalog();
    const route = selectPiRoute("pi-zen-main", catalog, ["pi-zen-main"]);
    expect(route.provider).toBe("opencode");
    expect(route.model).toBe("example-code-large");
  });

  test("explicit allowlist in an isolated fixture is not a production opt-in", () => {
    const catalog = fixtureCatalog();
    const fixtureAllowlist = ["pi-zen-main"];
    expect(selectPiRoute("pi-zen-main", catalog, fixtureAllowlist).name).toBe("pi-zen-main");
    // Production default is still off: the fixture array never touches the env default.
    expect(piAllowedRoutesFromEnv({})).toEqual([]);
    expect(() => selectPiRoute("pi-zen-main", catalog, piAllowedRoutesFromEnv({}))).toThrow(PiRouteNotAllowedError);
  });

  test("unknown profile fails as not found, not as not-allowed", () => {
    expect(() => resolvePiProfile("pi-missing", fixtureCatalog())).toThrow(PiRouteNotFoundError);
    expect(() => selectPiRoute("pi-missing", fixtureCatalog(), ["pi-missing"])).toThrow(PiRouteNotFoundError);
  });
});

describe("aliases, payers, and scopes", () => {
  test("aliases share one pool", () => {
    const catalog = fixtureCatalog();
    const main = resolvePiProfile("pi-zen-main", catalog);
    const alias = resolvePiProfile("pi-zen-alias", catalog);
    expect(alias.provider).toBe(main.provider);
    expect(alias.model).toBe(main.model);
    expect(alias.fundingPool).toBe(main.fundingPool);
    expect(alias.family).toBe(main.family);
    expect(alias.name).not.toBe(main.name);
  });

  test("same model via different payers stays distinct", () => {
    const catalog = fixtureCatalog();
    const main = selectPiRoute("pi-zen-main", catalog, ["pi-zen-main", "pi-zen-teams"]);
    const teams = selectPiRoute("pi-zen-teams", catalog, ["pi-zen-main", "pi-zen-teams"]);
    expect(teams.model).toBe(main.model);
    expect(teams.family).toBe(main.family);
    expect(teams.payer).not.toBe(main.payer);
    expect(teams.fundingPool).not.toBe(main.fundingPool);
    expect(teams.credentialRef).not.toBe(main.credentialRef);
  });

  test("contributor SKU allows public scope and refuses private scope", () => {
    const catalog = fixtureCatalog();
    expect(isContributorSku("contributor")).toBe(true);
    const allowed = selectPiRoute("pi-contributor", catalog, ["pi-contributor"], { scope: "public" });
    expect(allowed.sku).toBe("contributor");
    expect(() => selectPiRoute("pi-contributor", catalog, ["pi-contributor"], { scope: "private" })).toThrow(
      PiRouteScopeRefusedError
    );
  });

  test("non-contributor serves private scope", () => {
    const route = selectPiRoute("pi-zen-main", fixtureCatalog(), ["pi-zen-main"], { scope: "private" });
    expect(route.name).toBe("pi-zen-main");
  });
});

describe("endpoint and Google denials", () => {
  test("unknown endpoints fail closed even when allowlisted", () => {
    const catalog = fixtureCatalog();
    expect(() => resolvePiProfile("pi-unknown-endpoint", catalog)).toThrow(PiRouteDeniedError);
    expect(() => selectPiRoute("pi-unknown-endpoint", catalog, ["pi-unknown-endpoint"])).toThrow(PiRouteDeniedError);
  });

  test("Google models are denied, including via Go", () => {
    expect(isGooglePiModel("google", "gemini-fictional-test")).toBe(true);
    expect(isGooglePiModel("opencode-go", "gemini-fictional-test")).toBe(true);
    expect(isGooglePiModel("opencode", "example-code-large")).toBe(false);
    const catalog = fixtureCatalog();
    expect(() => resolvePiProfile("pi-google-direct", catalog)).toThrow(PiRouteDeniedError);
    expect(() => resolvePiProfile("pi-go-google", catalog)).toThrow(PiRouteDeniedError);
    expect(() => selectPiRoute("pi-google-direct", catalog, ["pi-google-direct"])).toThrow(PiRouteDeniedError);
    expect(() => selectPiRoute("pi-go-google", catalog, ["pi-go-google"])).toThrow(PiRouteDeniedError);
  });
});

describe("repo narrowing and handoff", () => {
  test("a repo may narrow permissions, never add models or accounts", () => {
    expect(narrowPiRoutesWithRepo(["a", "b"], ["b", "c"])).toEqual(["b"]);
    expect(narrowPiRoutesWithRepo(["a"], undefined)).toEqual(["a"]);
    expect(narrowPiRoutesWithRepo(["a"], ["c"])).toEqual([]);
    // The repo cannot add a configured profile the deployment did not allow.
    expect(narrowPiRoutesWithRepo(["a"], ["a", "pi-zen-main"])).toEqual(["a"]);
  });

  test("selection and handoff both enforce the allowlist", () => {
    const catalog = fixtureCatalog();
    const deployment = ["pi-zen-main"];
    expect(selectPiRoute("pi-zen-main", catalog, deployment).name).toBe("pi-zen-main");
    expect(checkPiHandoff("pi-zen-main", catalog, deployment).name).toBe("pi-zen-main");
    // Handoff with a repo narrowing that drops the route fails even though selection passed.
    expect(() => checkPiHandoff("pi-zen-main", catalog, deployment, { repoAllowed: ["other"] })).toThrow(
      PiRouteNotAllowedError
    );
    // Handoff re-checks scope too.
    expect(() => checkPiHandoff("pi-contributor", catalog, ["pi-contributor"], { scope: "private" })).toThrow(
      PiRouteScopeRefusedError
    );
  });
});

describe("adapter result contract", () => {
  test("usage missing is not zero", () => {
    expect(hasPiUsage({ kind: "ok", message: "done" })).toBe(false);
    const zero: PiUsage = { inputTokens: 0, outputTokens: 0 };
    expect(hasPiUsage({ kind: "ok", usage: zero })).toBe(true);
  });

  test("auth-expiry and cancellation constructors stay distinct", () => {
    expect(piAdapterAuthExpired("invalid_grant").kind).toBe("auth-expired");
    expect(piAdapterAuthExpired("invalid_grant").authExpired).toBe(true);
    expect(piAdapterCancelled("cancelled").kind).toBe("cancelled");
  });

  test("auth expiry stays distinct from quota", () => {
    expect(classifyPiAdapterError("OAuth session expired and could not be refreshed")).toBe("auth-expired");
    expect(classifyPiAdapterError("invalid_grant: token revoked")).toBe("auth-expired");
    expect(classifyPiAdapterError("API Error: 401 Unauthorized")).toBe("auth-expired");
  });

  test("quota carries the stated reset and stays retryable", () => {
    expect(classifyPiAdapterError("Go limit reached, retry in 45 minutes")).toBe("quota");
    expect(classifyPiAdapterError("FreeUsageLimitError: Free usage exceeded")).toBe("quota");
    const result = piAdapterQuota("Go limit reached", {
      resetting: true,
      retryAfterMs: 45 * 60 * 1000,
      resetAtMs: 1_700_000_000_000,
    });
    expect(result.kind).toBe("quota");
    expect(result.quota?.resetting).toBe(true);
    expect(result.quota?.retryAfterMs).toBe(45 * 60 * 1000);
    expect(result.quota?.resetAtMs).toBe(1_700_000_000_000);
    expect(result.retryable).toBe(true);
  });

  test("cancellation stays distinct from provider failures", () => {
    expect(classifyPiAdapterError("cancelled")).toBe("cancelled");
    expect(classifyPiAdapterError("AbortError: The operation was aborted")).toBe("cancelled");
    expect(classifyPiAdapterError("fetch failed")).toBe("provider-failure");
    const denied = piAdapterDenied("route not allowed");
    expect(denied.kind).toBe("denied");
    expect(denied.retryable).toBe(false);
  });

  test("transient provider failures are retryable, permanent ones are not", () => {
    expect(piAdapterProviderFailure("fetch failed").retryable).toBe(true);
    expect(piAdapterProviderFailure("529 overloaded").retryable).toBe(true);
    expect(piAdapterProviderFailure("ModelProtocolUnsupported").retryable).toBe(false);
  });
});

describe("chain order and independent review", () => {
  test("ordered keeps configured order; random-start rotates deterministically", () => {
    const catalog = fixtureCatalog();
    const chain = [resolvePiProfile("pi-zen-main", catalog), resolvePiProfile("pi-zen-teams", catalog)];
    expect(orderPiRoutes(chain, "ordered").map((route) => route.name)).toEqual(["pi-zen-main", "pi-zen-teams"]);
    expect(orderPiRoutes(chain, undefined).map((route) => route.name)).toEqual(["pi-zen-main", "pi-zen-teams"]);
    expect(orderPiRoutes(chain, "random-start", () => 0).map((route) => route.name)).toEqual([
      "pi-zen-main",
      "pi-zen-teams",
    ]);
    expect(orderPiRoutes(chain, "random-start", () => 0.75).map((route) => route.name)).toEqual([
      "pi-zen-teams",
      "pi-zen-main",
    ]);
    expect(orderPiRoutes([chain[0]!], "random-start", () => 0.99)).toHaveLength(1);
  });

  test("same-family routes stay eligible: no implicit independent review", () => {
    const catalog = fixtureCatalog();
    const chain = [resolvePiProfile("pi-zen-main", catalog), resolvePiProfile("pi-zen-alias", catalog)];
    expect(chain[0]!.family).toBe(chain[1]!.family);
    const ordered = orderPiRoutes(chain, "ordered");
    expect(ordered).toHaveLength(2);
  });
});

describe("legacy catalogs and behavior are unchanged", () => {
  test("synthesized and parsed runner catalogs keep today's shape", () => {
    const synthesized = synthesizeRunners({ model: "example-model" });
    expect(synthesized.chain).toEqual(["primary"]);
    const parsed = parseRunnersCatalog({
      runners: { primary: { type: "opencode", model: "example-model" } },
      chain: ["primary"],
    });
    expect(parsed.chain).toEqual(["primary"]);
    expect(parsed.independentReview).toBeUndefined();
  });
});
