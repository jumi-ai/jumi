import { describe, expect, test } from "bun:test";
import { inspectClaudeCreditExhaustion } from "../src/claude.ts";
import { EngineFailedError, type EngineResult } from "../src/engine.ts";
import {
  isCreditStuckResult,
  isProviderUnavailableResult,
  looksLikeProviderUnavailable,
  sameExhaustedCredential,
  shouldHopForCreditExhaustion,
  withEngineChain,
} from "../src/fallback.ts";
import {
  CREDIT_QUOTA_MESSAGE,
  CREDIT_STUCK_TEXT,
  classifyQuotaText,
  engineFailureQuotaClass,
  isCreditBalanceText,
  isHardQuotaText,
  isQuotaText,
  isResettingQuotaText,
  QUOTA_MESSAGE,
  QUOTA_STUCK_TEXT,
  quotaClassOf,
  quotaStuckReasonForText,
} from "../src/quota.ts";
import { throwIfQuotaWait } from "../src/quota_wait.ts";

/** What `claude` prints when the Console API key has no credit left. */
const CLI_CREDIT_TEXT = "Credit balance is too low";
/** The Anthropic API message behind it (https://code.claude.com/docs/en/errors#credit-balance-is-too-low). */
const API_CREDIT_TEXT =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const DOCUMENTED_CREDIT_TEXTS = [CLI_CREDIT_TEXT, API_CREDIT_TEXT] as const;

/** A tier/workspace spend cap answers 429 `rate_limit_error` and must keep hopping as provider-unavailable. */
const SPEND_CAP_TEXT = JSON.stringify({
  type: "error",
  status: 429,
  error: {
    type: "rate_limit_error",
    code: "rate_limit_error",
    message: "You have reached your API usage limits. Please try again later or lower your usage.",
    details: { error_code: "enforced_spend_limit_reached" },
  },
});

function ok(model: string): EngineResult {
  return { status: "ok", exitCode: 0, stdout: model };
}

describe("credit exhaustion classification", () => {
  test("both documented texts are narrow hard quota with the distinct credit message", () => {
    expect(CREDIT_QUOTA_MESSAGE).not.toBe(QUOTA_MESSAGE);
    expect(CREDIT_STUCK_TEXT).not.toBe(QUOTA_STUCK_TEXT);
    for (const text of DOCUMENTED_CREDIT_TEXTS) {
      expect(isCreditBalanceText(text)).toBe(true);
      expect(isQuotaText(text)).toBe(true);
      expect(classifyQuotaText(text)).toBe("hard");
      expect(isHardQuotaText(text)).toBe(true);
      expect(isResettingQuotaText(text)).toBe(false);
      expect(inspectClaudeCreditExhaustion(text)).toBe("hard");
      expect(quotaStuckReasonForText(text)).toBe(CREDIT_STUCK_TEXT);
      expect(quotaClassOf({ message: text })).toBe("hard");
      expect(isCreditStuckResult({ status: "stuck", message: CREDIT_QUOTA_MESSAGE, quota: "hard" })).toBe(true);
    }
    expect(engineFailureQuotaClass(new EngineFailedError(CREDIT_QUOTA_MESSAGE, false, { quota: "hard" }))).toBe("hard");
  });

  test("ordinary task output mentioning credit, billing, or balance does not match", () => {
    for (const text of ["credit billing balance", "billing balance shows credit", "out of credits for review"]) {
      expect(isCreditBalanceText(text)).toBe(false);
      expect(isQuotaText(text)).toBe(false);
      expect(inspectClaudeCreditExhaustion(text)).toBeUndefined();
      expect(quotaStuckReasonForText(text)).toBe(QUOTA_STUCK_TEXT);
    }
  });
});

describe("credit hop is credential-keyed, not model-keyed", () => {
  const apiKeyA = { auth: "api-key", authEnv: "JUMI_ANTHROPIC_KEY_A" };
  const apiKeyB = { auth: "api-key", authEnv: "JUMI_ANTHROPIC_KEY_B" };
  const subscription = {};

  test("api-key to subscription (and back) hops even with the same type and model", () => {
    expect(sameExhaustedCredential(apiKeyA, subscription)).toBe(false);
    expect(shouldHopForCreditExhaustion(apiKeyA, subscription)).toBe(true);
    expect(shouldHopForCreditExhaustion(subscription, apiKeyA)).toBe(true);
    expect(shouldHopForCreditExhaustion(apiKeyA, apiKeyB)).toBe(true);
  });

  test("the same exhausted credential refuses", () => {
    expect(sameExhaustedCredential(apiKeyA, { ...apiKeyA })).toBe(true);
    expect(shouldHopForCreditExhaustion(apiKeyA, { ...apiKeyA })).toBe(false);
    expect(shouldHopForCreditExhaustion(subscription, subscription)).toBe(false);
  });

  test("out-of-credit on the API runner hops to the subscription runner on the identical model", async () => {
    const creditStuck: EngineResult = {
      status: "stuck",
      exitCode: 1,
      message: CREDIT_QUOTA_MESSAGE,
      quota: "hard",
    };
    const apiRunner = { name: "claude-api", type: "claude" as const, model: "opus", ...apiKeyA };
    const subRunner = { name: "claude", type: "claude" as const, model: "opus" };
    const seen: string[] = [];
    const engine = async (opts: { model: string; auth?: string }) => {
      seen.push(`${opts.auth ?? "subscription"}/${opts.model}`);
      if (opts.auth === "api-key") return creditStuck;
      return ok(opts.model);
    };
    const result = await withEngineChain(engine as never, { chain: [apiRunner, subRunner] })({
      model: "opus",
      workdir: "/tmp",
    } as never);
    expect(result).toMatchObject(ok("opus"));
    expect(seen).toEqual(["api-key/opus", "subscription/opus"]);
  });

  test("a thrown credit failure hops the same way", async () => {
    const apiRunner = { name: "claude-api", type: "claude" as const, model: "opus", ...apiKeyA };
    const subRunner = { name: "claude", type: "claude" as const, model: "opus" };
    const models: string[] = [];
    const engine = async (opts: { model: string; auth?: string }) => {
      models.push(opts.model);
      if (opts.auth === "api-key") throw new EngineFailedError(CREDIT_QUOTA_MESSAGE, false, { quota: "hard" });
      return ok(opts.model);
    };
    const result = await withEngineChain(engine as never, { chain: [apiRunner, subRunner] })({
      model: "opus",
      workdir: "/tmp",
    } as never);
    expect(result).toMatchObject(ok("opus"));
    expect(models).toEqual(["opus", "opus"]);
  });

  test("the same exhausted credential parks instead of hopping", async () => {
    const creditStuck: EngineResult = {
      status: "stuck",
      exitCode: 1,
      message: CREDIT_QUOTA_MESSAGE,
      quota: "hard",
    };
    const first = { name: "claude-api-1", type: "claude" as const, model: "opus", ...apiKeyA };
    // Same `authEnv` bills the same key, even on a differently named runner: no hop.
    const sameKey = { name: "claude-api-2", type: "claude" as const, model: "opus", ...apiKeyA };
    let n = 0;
    const engine = async () => {
      n++;
      return creditStuck;
    };
    const result = await withEngineChain(engine as never, { chain: [first, sameKey] })({
      model: "opus",
      workdir: "/tmp",
    } as never);
    expect(result).toMatchObject(creditStuck);
    expect(result.runner?.model).toBe("opus");
    expect(result.chainIndex).toBe(0);
    // Same as a same-provider plan-limit refusal: the hop was never available,
    // so there is nothing to mark refused (that flag is for lease/abort
    // refusals of a hop that would otherwise happen).
    expect(result.hopRefused).toBeUndefined();
    expect(n).toBe(1);
  });
});

describe("credit never waits", () => {
  test("throwIfQuotaWait returns for credit stuck and credit failures, even with a runner left", () => {
    const creditStuck: EngineResult = {
      status: "stuck",
      exitCode: 1,
      message: CREDIT_QUOTA_MESSAGE,
      quota: "hard",
    };
    expect(() => throwIfQuotaWait({ result: creditStuck, model: "opus", random: () => 0 })).not.toThrow();
    expect(() =>
      throwIfQuotaWait({
        result: { ...creditStuck, runner: { type: "claude", model: "opus" }, chainIndex: 0 },
        model: "opus",
        chain: [{ model: "opus" }, { model: "opus" }],
        random: () => 0,
      })
    ).not.toThrow();
    expect(() =>
      throwIfQuotaWait({
        err: new EngineFailedError(CREDIT_QUOTA_MESSAGE, false, { quota: "hard" }),
        model: "opus",
        random: () => 0,
      })
    ).not.toThrow();
  });
});

describe("spend-cap limit still hops as provider-unavailable", () => {
  test("the enforced_spend_limit_reached message matches the provider pattern", () => {
    expect(looksLikeProviderUnavailable(SPEND_CAP_TEXT)).toBe(true);
    expect(
      isProviderUnavailableResult({
        status: "exit",
        exitCode: 1,
        message: `claude exited with code 1:\n${SPEND_CAP_TEXT}`,
      })
    ).toBe(true);
  });

  test("a spend-cap exit hops to the next runner", async () => {
    const spendCap: EngineResult = {
      status: "exit",
      exitCode: 1,
      message: `claude exited with code 1:\n${SPEND_CAP_TEXT}`,
    };
    const claude = { name: "claude", type: "claude" as const, model: "opus" };
    const grok = { name: "grok", type: "opencode" as const, model: "xai/grok-4.6", variant: "high" };
    const seen: string[] = [];
    const engine = async (opts: { type?: string; model: string }) => {
      seen.push(opts.model);
      if (opts.type === "claude") return spendCap;
      return ok(opts.model);
    };
    const result = await withEngineChain(engine as never, { chain: [claude, grok] })({
      model: "opus",
      workdir: "/tmp",
    } as never);
    expect(result).toMatchObject(ok(grok.model));
    expect(seen).toEqual(["opus", grok.model]);
  });
});
