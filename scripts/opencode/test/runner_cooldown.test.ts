import { describe, expect, test } from "bun:test";
import { EngineFailedError, type EngineResult } from "../src/engine.ts";
import { withEngineChain } from "../src/fallback.ts";
import { QUOTA_MESSAGE, QuotaCooldown } from "../src/quota.ts";
import { throwIfQuotaWait } from "../src/quota_wait.ts";
import {
  DEFAULT_RUNNER_COOLDOWN_CONFIG,
  RunnerCooldownStore,
  recordRunnerCooldownForFailure,
} from "../src/runner_cooldown.ts";
import { type NamedRunner, orderChainForJob, orderChainForRetry, parseRunnersCatalog } from "../src/runners.ts";

const codex: NamedRunner = { name: "codex", type: "codex", model: "codex/model-a", effort: "high" };
const claude: NamedRunner = { name: "claude", type: "claude", model: "claude/model-b", effort: "high" };

function quotaStuck(): EngineResult {
  return { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" };
}

describe("runner cooldown", () => {
  test("quota hit with retry-after is skipped by random-start until reset, then selectable", () => {
    const store = new RunnerCooldownStore();
    store.recordQuota("codex", { retryAfterMs: 5 * 60 * 1000, nowMs: 0 });
    expect(store.isCooled("codex", 0)).toBe(true);
    expect(store.isCooled("codex", 5 * 60 * 1000 - 1)).toBe(true);
    expect(store.isCooled("codex", 5 * 60 * 1000)).toBe(false);

    const logs: string[] = [];
    const fresh = new RunnerCooldownStore();
    fresh.recordQuota("codex", { retryAfterMs: 5 * 60 * 1000, nowMs: 0 });
    const order = orderChainForJob([codex, claude], "random-start", () => 0, {
      cooldowns: fresh,
      nowMs: 0,
      logger: (m) => logs.push(m),
    });
    // Random 0 would pick codex first without cooldown; cooled codex is skipped.
    expect(order.map((r) => r.name)[0]).toBe("claude");
    expect(logs.some((m) => m.includes("event=runner_skipped_cooldown") && m.includes("runner=codex"))).toBe(true);

    const after = orderChainForJob([codex, claude], "random-start", () => 0, {
      cooldowns: fresh,
      nowMs: 5 * 60 * 1000,
    });
    expect(after.map((r) => r.name)).toContain("codex");
  });

  test("quota without retry-after uses the configured default", () => {
    const store = new RunnerCooldownStore();
    const config = { ...DEFAULT_RUNNER_COOLDOWN_CONFIG, quotaMs: 42 * 60 * 1000 };
    const entry = store.recordQuota("codex", { nowMs: 1_000, config });
    expect(entry.untilMs).toBe(1_000 + 42 * 60 * 1000);
    expect(entry.source).toBe("default");
    expect(store.isCooled("codex", 1_000 + 42 * 60 * 1000 - 1)).toBe(true);
    expect(store.isCooled("codex", 1_000 + 42 * 60 * 1000)).toBe(false);
  });

  test("auth death cools until the credential changes or N minutes", () => {
    const store = new RunnerCooldownStore();
    const config = { ...DEFAULT_RUNNER_COOLDOWN_CONFIG, authMs: 30 * 60 * 1000 };
    store.recordAuth("codex", { nowMs: 0, config, fingerprint: "v1" });
    expect(store.isCooled("codex", 1_000, "v1")).toBe(true);
    // Credential rotated: the same runner is selectable immediately.
    expect(store.isCooled("codex", 1_000, "v2")).toBe(false);

    const again = new RunnerCooldownStore();
    again.recordAuth("codex", { nowMs: 0, config, fingerprint: "v1" });
    expect(again.isCooled("codex", 30 * 60 * 1000 - 1, "v1")).toBe(true);
    expect(again.isCooled("codex", 30 * 60 * 1000, "v1")).toBe(false);
  });

  test("transient provider error does not cool down", () => {
    const store = new RunnerCooldownStore();
    const transient: EngineResult = { status: "exit", exitCode: 1, message: "500 internal server error" };
    expect(recordRunnerCooldownForFailure(store, "codex", { result: transient, nowMs: 0 })).toBeUndefined();
    expect(store.size()).toBe(0);
    const transientErr = new EngineFailedError("500 internal server error", true);
    expect(recordRunnerCooldownForFailure(store, "codex", { err: transientErr, nowMs: 0 })).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  test("all runners cooled picks earliest expiry and logs it", () => {
    const store = new RunnerCooldownStore();
    store.recordQuota("codex", { retryAfterMs: 10 * 60 * 1000, nowMs: 0 });
    store.recordQuota("claude", { retryAfterMs: 5 * 60 * 1000, nowMs: 0 });
    const logs: string[] = [];
    const order = orderChainForJob([codex, claude], "random-start", () => 0.99, {
      cooldowns: store,
      nowMs: 0,
      logger: (m) => logs.push(m),
    });
    expect(order.map((r) => r.name)[0]).toBe("claude");
    expect(logs.some((m) => m.includes("event=runner_cooldown") && m.includes("runner=claude"))).toBe(true);
  });

  test("runners-file cooldown override validated", () => {
    expect(() =>
      parseRunnersCatalog({
        runners: { a: { type: "opencode", model: "a/m" } },
        chain: ["a"],
        cooldown: { quotaMs: -1 },
      })
    ).toThrow("cooldown");
    expect(() =>
      parseRunnersCatalog({
        runners: { a: { type: "opencode", model: "a/m" } },
        chain: ["a"],
        cooldown: { quotaMs: "soon" },
      })
    ).toThrow("cooldown");
    const ok = parseRunnersCatalog({
      runners: { a: { type: "opencode", model: "a/m" } },
      chain: ["a"],
      cooldown: { quotaMs: 60_000 },
    });
    expect(ok.cooldown?.quotaMs).toBe(60_000);
  });

  test("quota on one runner with a healthy later runner hops and sets no role-wide cooldown", async () => {
    const cooldowns = new RunnerCooldownStore();
    const roleWide = new QuotaCooldown();
    const calls: string[] = [];
    const engine = async (opts: { model: string }) => {
      calls.push(opts.model);
      if (opts.model === "codex/model-a") return quotaStuck();
      return { status: "ok" as const, exitCode: 0, stdout: "done" };
    };
    const chain = withEngineChain(engine as never, {
      chain: [codex, claude],
      selection: "ordered",
      runnerCooldowns: cooldowns,
      logger: () => undefined,
    });
    const result = await chain({ model: "codex/model-a", workdir: "/tmp" });
    expect(result.status).toBe("ok");
    expect(calls).toEqual(["codex/model-a", "claude/model-b"]);
    expect(cooldowns.isCooled("codex", Date.now())).toBe(true);
    expect(roleWide.canLease()).toBe(true);
  });

  test("quota with every runner cooled requeues with earliest expiry, not the 1 h default", () => {
    const cooldowns = new RunnerCooldownStore();
    const now = 1_000_000;
    cooldowns.recordQuota("codex", { retryAfterMs: 10 * 60 * 1000, nowMs: now });
    cooldowns.recordQuota("claude", { retryAfterMs: 5 * 60 * 1000, nowMs: now });
    let thrown: unknown;
    try {
      throwIfQuotaWait({
        result: quotaStuck(),
        model: "codex/model-a",
        chain: [codex, claude],
        previousError: null,
        nowMs: now,
        random: () => 0,
        runnerCooldowns: cooldowns,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ name: "QuotaWaitError" });
    const backoff = (thrown as { backoffMs: number }).backoffMs;
    expect(backoff).toBe(5 * 60 * 1000);
  });

  test("quota with a healthy runner does not requeue with a 1 h backoff", () => {
    const cooldowns = new RunnerCooldownStore();
    const now = 2_000_000;
    cooldowns.recordQuota("codex", { retryAfterMs: 60 * 60 * 1000, nowMs: now });
    // claude is healthy: a stuck result returns without a QuotaWaitError,
    // and a thrown quota error is rethrown for an immediate retry.
    expect(() =>
      throwIfQuotaWait({
        result: quotaStuck(),
        model: "codex/model-a",
        chain: [codex, claude],
        previousError: null,
        nowMs: now,
        random: () => 0,
        runnerCooldowns: cooldowns,
      })
    ).not.toThrow();
    const err = new EngineFailedError(QUOTA_MESSAGE, false, { quota: "resetting" });
    expect(() =>
      throwIfQuotaWait({
        err,
        model: "codex/model-a",
        chain: [codex, claude],
        previousError: null,
        nowMs: now,
        random: () => 0,
        runnerCooldowns: cooldowns,
      })
    ).toThrow(err);
  });

  test("hop refused by lease logs the reason", async () => {
    const logs: string[] = [];
    const engine = async () => quotaStuck();
    const chain = withEngineChain(engine as never, {
      chain: [codex, claude],
      selection: "ordered",
      remainingLeaseMs: async () => 1_000,
      logger: (m) => logs.push(m),
    });
    const result = await chain({ model: "codex/model-a", workdir: "/tmp", timeoutMs: 3_600_000 });
    expect(result.hopRefused).toBe(true);
    expect(logs.some((m) => m.includes("event=hop_refused") && m.includes("reason=lease"))).toBe(true);
    expect(logs.some((m) => m.includes("remaining_ms=1000") && m.includes("timeout_ms=3600000"))).toBe(true);
  });

  test("retry after a cooled failure starts on the next healthy runner", () => {
    const store = new RunnerCooldownStore();
    store.recordQuota("codex", { retryAfterMs: 60 * 60 * 1000, nowMs: 0 });
    const order = orderChainForRetry([codex, claude], "random-start", () => 0.99, "codex", {
      cooldowns: store,
      nowMs: 0,
    });
    expect(order.map((r) => r.name)[0]).toBe("claude");
  });
});
