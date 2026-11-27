import { describe, expect, test } from "bun:test";
import type { PiHopAttempt, PiHopLease, PiHopRequest, PiHopStatus } from "../src/pi_hop.ts";
import { PI_HOP_MAX_ROUTES, resolvePiHopResetAtMs, runPiHop } from "../src/pi_hop.ts";
import type { PiProfileCatalog } from "../src/pi_profiles.ts";
import { piAdapterAuthExpired, piAdapterProviderFailure, piAdapterQuota } from "../src/pi_profiles.ts";

const ZEN = "https://opencode.ai/zen/v1";

function catalog(): PiProfileCatalog {
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
  };
}

function leaseOk(): PiHopRequest["lease"] {
  return {
    isLeaseHeld: () => true,
    isCancelled: () => false,
    isWorktreeSafe: () => true,
  };
}

describe("pi bounded hop", () => {
  test("hop is bounded to two scripted routes", () => {
    expect(PI_HOP_MAX_ROUTES).toBe(2);
    const okStatus: PiHopStatus = "ok";
    expect(okStatus).toBe("ok");
    const lease: PiHopLease = { isLeaseHeld: () => true, isCancelled: () => false, isWorktreeSafe: () => true };
    expect(typeof lease.isLeaseHeld).toBe("function");
    expect(resolvePiHopResetAtMs({ kind: "ok" })).toBeUndefined();
    const attemptShape: PiHopAttempt = {
      route: "pi-zen-main",
      sessionId: "ses-test",
      stamp: {
        profile: "pi-zen-main",
        role: "review",
        model: "example-code-large",
        fundingPool: "workspace-balance-pool",
        payer: "workspace-balance",
        outcome: "ok",
      },
      kind: "ok",
    };
    expect(attemptShape.route).toBe("pi-zen-main");
  });
  test("permitted handoff succeeds on the first route with a fresh session", async () => {
    const seen: string[] = [];
    const result = await runPiHop({
      routes: ["pi-zen-main", "pi-zen-teams"],
      catalog: catalog(),
      deploymentAllowlist: ["pi-zen-main", "pi-zen-teams"],
      scope: "private",
      role: "review",
      lease: leaseOk(),
      invoke: (route, ctx) => {
        seen.push(ctx.sessionId);
        expect(route.name).toBe("pi-zen-main");
        return { kind: "ok", message: "done" };
      },
    });
    expect(result.status).toBe("ok");
    expect(result.stamp?.profile).toBe("pi-zen-main");
    expect(result.stamp?.role).toBe("review");
    expect(result.attempts).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  test("quota hops to a different pool but never retries an exhausted pool through an alias", async () => {
    const seen: string[] = [];
    const result = await runPiHop({
      routes: ["pi-zen-main", "pi-zen-alias"],
      catalog: catalog(),
      deploymentAllowlist: ["pi-zen-main", "pi-zen-alias"],
      scope: "private",
      role: "review",
      lease: leaseOk(),
      newSessionId: (() => {
        let n = 0;
        return () => `ses-${++n}`;
      })(),
      invoke: (route) => {
        seen.push(route.name);
        return piAdapterQuota("Free limit reached", { resetting: true, retryAfterMs: 60_000 });
      },
    });
    // Second route shares the pool: skipped, no second invoke.
    expect(seen).toEqual(["pi-zen-main"]);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("failed:pool-exhausted:workspace-balance-pool");
    expect(result.exhaustedPools).toEqual(["workspace-balance-pool"]);
    expect(result.attempts).toHaveLength(1);
  });

  test("quota hops across pools to success and records only the stated reset", async () => {
    const sessions: string[] = [];
    const result = await runPiHop({
      routes: ["pi-zen-main", "pi-zen-teams"],
      catalog: catalog(),
      deploymentAllowlist: ["pi-zen-main", "pi-zen-teams"],
      scope: "private",
      role: "implement",
      lease: leaseOk(),
      nowMs: () => 1_700_000_000_000,
      newSessionId: (() => {
        let n = 0;
        return () => `fresh-${++n}`;
      })(),
      invoke: (route, ctx) => {
        sessions.push(ctx.sessionId);
        if (route.name === "pi-zen-main") {
          return piAdapterQuota("Free limit reached", { resetting: true, retryAfterMs: 60_000 });
        }
        return { kind: "ok", message: "done", usage: { inputTokens: 4, outputTokens: 5 } };
      },
    });
    expect(result.status).toBe("ok");
    expect(result.stamp?.profile).toBe("pi-zen-teams");
    expect(result.stamp?.fundingPool).toBe("team-balance-pool");
    expect(result.stamp?.usage?.inputTokens).toBe(4);
    // Fresh provider session per attempt: never replay the first id.
    expect(sessions).toEqual(["fresh-1", "fresh-2"]);
    expect(result.attempts.map((attempt) => attempt.sessionId)).toEqual(["fresh-1", "fresh-2"]);
  });

  test("private scope to a Contributor route is refused without inference", async () => {
    let invoked = false;
    const result = await runPiHop({
      routes: ["pi-contributor"],
      catalog: catalog(),
      deploymentAllowlist: ["pi-contributor"],
      scope: "private",
      role: "review",
      lease: leaseOk(),
      invoke: () => {
        invoked = false;
        invoked = true;
        return { kind: "ok" };
      },
    });
    expect(result.status).toBe("refused");
    expect(invoked).toBe(false);
    expect(result.attempts).toHaveLength(0);
  });

  test("lost lease, cancellation, and unsafe worktree refuse without inference", async () => {
    for (const lease of [
      { ...leaseOk(), isLeaseHeld: () => false },
      { ...leaseOk(), isCancelled: () => true },
      { ...leaseOk(), isWorktreeSafe: () => false },
    ]) {
      let invoked = false;
      const result = await runPiHop({
        routes: ["pi-zen-main"],
        catalog: catalog(),
        deploymentAllowlist: ["pi-zen-main"],
        scope: "private",
        role: "review",
        lease,
        invoke: () => {
          invoked = true;
          return { kind: "ok" };
        },
      });
      expect(result.status).toBe("refused");
      expect(invoked).toBe(false);
    }
  });

  test("authentication stays distinct from quota and never records a quota reset", async () => {
    let calls = 0;
    const result = await runPiHop({
      routes: ["pi-zen-main", "pi-zen-teams"],
      catalog: catalog(),
      deploymentAllowlist: ["pi-zen-main", "pi-zen-teams"],
      scope: "private",
      role: "review",
      lease: leaseOk(),
      invoke: (route) => {
        calls++;
        expect(route.name).toBe("pi-zen-main");
        return piAdapterAuthExpired("invalid_grant: token revoked");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("failed:auth");
    expect(result.stamp?.outcome).toBe("auth-expired");
    expect(result.quotaResetAtMs).toBeUndefined();
    // Auth never hops as quota.
    expect(calls).toBe(1);
    expect(piAdapterProviderFailure("fetch failed", true).retryable).toBe(true);
  });

  test("quota without a stated reset records no reset (never guessed)", async () => {
    const result = await runPiHop({
      routes: ["pi-zen-main"],
      catalog: catalog(),
      deploymentAllowlist: ["pi-zen-main"],
      scope: "private",
      role: "review",
      lease: leaseOk(),
      invoke: () => ({ kind: "quota", message: "quota exceeded", quota: { resetting: false } }),
    });
    expect(result.status).toBe("failed");
    expect(result.quotaResetAtMs).toBeUndefined();
  });
});
