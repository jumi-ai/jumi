import { describe, expect, test } from "bun:test";
import {
  buildPiAttemptStamp,
  formatPiAttemptStamp,
  isHistoricalPiAttemptBlank,
  isPiAttemptOutcome,
  isPiAttemptRole,
  normalizePiAttemptUsage,
  PI_ATTEMPT_ROLES,
  piAttemptStampFromRecord,
  piAttemptStampToRecord,
} from "../src/pi_attempt.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { renderLedgerMetrics } from "../src/run_usage.ts";

const ZEN = "https://opencode.ai/zen/v1";
const GO = "https://opencode.ai/zen/go/v1";

function routeFixture(overrides: Record<string, unknown> = {}) {
  return {
    name: "pi-zen-main",
    provider: "opencode",
    model: "example-code-large",
    effort: "high",
    endpoint: ZEN,
    fundingPool: "workspace-balance-pool",
    payer: "workspace-balance",
    credentialRef: "env:EXAMPLE_ZEN_KEY_A",
    scopes: ["public", "private"],
    family: "opencode|example-code-large",
    ...overrides,
  } as never;
}

describe("pi attempt stamp", () => {
  test("builds profile, role, model, funding route and outcome without secrets", () => {
    const stamp = buildPiAttemptStamp({ route: routeFixture(), role: "review", outcome: "ok" });
    expect(stamp.profile).toBe("pi-zen-main");
    expect(stamp.role).toBe("review");
    expect(stamp.model).toBe("example-code-large");
    expect(stamp.fundingPool).toBe("workspace-balance-pool");
    expect(stamp.payer).toBe("workspace-balance");
    expect(stamp.outcome).toBe("ok");
    expect(stamp.usage).toBeUndefined();
    const text = formatPiAttemptStamp(stamp);
    expect(text).toContain("pi-zen-main");
    expect(text).not.toContain("EXAMPLE_ZEN_KEY");
  });

  test("preserves available usage and keeps unknown absent (never zero)", () => {
    const withUsage = buildPiAttemptStamp({
      route: routeFixture(),
      role: "implement",
      outcome: "ok",
      usage: { inputTokens: 10, outputTokens: 0, cachedInputTokens: 3, reasoningTokens: 7 },
    });
    expect(withUsage.usage?.inputTokens).toBe(10);
    // A stated zero stays zero.
    expect(withUsage.usage?.outputTokens).toBe(0);
    expect(withUsage.usage?.cacheWriteTokens).toBeUndefined();
    const record = piAttemptStampToRecord(withUsage);
    expect(record.piTokensInput).toBe(10);
    expect(record.piTokensOutput).toBe(0);
    expect(record.piTokensCacheWrite).toBeNull();
    // Unknown usage stays absent, never zero-filled.
    const missing = normalizePiAttemptUsage(undefined);
    expect(missing).toBeUndefined();
    const emptyRecord = piAttemptStampToRecord(
      buildPiAttemptStamp({ route: routeFixture(), role: "review", outcome: "ok" })
    );
    expect(emptyRecord.piTokensInput).toBeNull();
  });

  test("role set is stable and historical rows read as absent", () => {
    expect([...PI_ATTEMPT_ROLES]).toEqual(["review", "implement", "follow-up", "conflict"]);
    expect(piAttemptStampFromRecord({})).toBeUndefined();
    expect(isHistoricalPiAttemptBlank({})).toBe(true);
    expect(isPiAttemptRole("review")).toBe(true);
    expect(isPiAttemptRole("bogus")).toBe(false);
    expect(isPiAttemptOutcome("quota")).toBe(true);
    // Partial identity never becomes a half stamp.
    expect(piAttemptStampFromRecord({ piProfile: "pi-zen-main" } as never)).toBeUndefined();
  });

  test("memory saveResult carries the stamp; old rows stay compatible", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue({
      delivery: "d1",
      owner: "o",
      repo: "r",
      prNumber: 1,
      action: "synchronize",
      headSha: "abc",
      receivedAt: new Date().toISOString(),
    } as never);
    const leased = await store.lease("owner-1", 60_000, new Date(), ["review"] as never);
    expect(leased).toBeDefined();
    expect((leased as unknown as Record<string, unknown>).piProfile).toBeUndefined();
    const stamp = buildPiAttemptStamp({
      route: routeFixture(),
      role: "review",
      outcome: "ok",
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    await store.saveResult((leased as unknown as { id: number }).id, "owner-1", {
      kind: "markdown",
      markdown: "hello",
      harnessMode: "pi",
      piAttempt: stamp,
    } as never);
    const after = await store.get((leased as unknown as { id: number }).id);
    expect((after as unknown as Record<string, unknown>).piProfile).toBe("pi-zen-main");
    expect((after as unknown as Record<string, unknown>).piOutcome).toBe("ok");
    expect((after as unknown as Record<string, unknown>).piTokensInput).toBe(5);
    expect((after as unknown as Record<string, unknown>).piTokensCacheWrite).toBeUndefined();
    void GO;
  });

  test("dashboards keep existing label sets (no per-session metric labels)", async () => {
    const metrics = await renderLedgerMetrics({
      countByKindState: async () =>
        ({
          review: { queued: 0, leased: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 0 },
          implement: { queued: 0, leased: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 0 },
          "follow-up": { queued: 0, leased: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 0 },
          conflict: { queued: 0, leased: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 0 },
        }) as never,
      getRunUsageTokenTotals: async () => [],
      getRunUsageSessionTotals: async () => [],
      getRunExitCounts: async () => [],
      getRunRunnerExitCounts: async () => [],
      getRunnerQuotaResets: async () => [],
      getRunDurations: async () => [],
      getReviewSuggestionTotals: async () => [],
      getReviewFindingTotals: async () => [],
      getJobReclaimTotals: async () => [],
    });
    expect(metrics).toContain("ai_tokens_total");
    expect(metrics).not.toContain("pi_profile");
    expect(metrics).not.toContain("session_id");
  });
});
