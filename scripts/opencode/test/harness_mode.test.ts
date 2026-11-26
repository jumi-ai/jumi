import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  gateResumeOnHarnessMode,
  HARNESS_MODE_ENV,
  normalizeHarnessMode,
  PiHarnessNotImplementedError,
  parseHarnessMode,
  readRecordedHarnessMode,
  throwIfPiHarness,
  writeHarnessModeStamp,
} from "../src/harness_mode.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { processEngineTick } from "../src/server.ts";
import { processWorkerTick } from "../src/worker.ts";
import { loadWorkerConfig } from "../src/worker_config.ts";

const REVIEWER_BASE = {
  GITEA_URL: "https://gitea.example/",
  GITEA_BOT_TOKEN: "bot-token",
  GITEA_WEBHOOK_SECRET: "secret",
  JUMI_ROLE: "engine",
  DATABASE_URL: "postgres://jumi",
};

const WORKER_BASE = {
  GITEA_URL: "https://gitea.example/",
  GITEA_BOT_TOKEN: "bot-token",
  GITEA_WEBHOOK_SECRET: "secret",
};

function fakeReviewApi(): any {
  return {
    getPR: async () => {
      throw new Error("should not spawn legacy on pi");
    },
  };
}

function fakeIssueApi(): any {
  return {};
}

describe("JUMI_HARNESS_MODE", () => {
  test("env key is deployment-only and stable", () => {
    expect(HARNESS_MODE_ENV).toBe("JUMI_HARNESS_MODE");
  });
  test("unset or empty is legacy; explicit legacy and pi parse", () => {
    expect(parseHarnessMode(undefined)).toBe("legacy");
    expect(parseHarnessMode("")).toBe("legacy");
    expect(parseHarnessMode("   ")).toBe("legacy");
    expect(parseHarnessMode("legacy")).toBe("legacy");
    expect(parseHarnessMode("pi")).toBe("pi");
  });

  test("invalid values fail startup naming the variable", () => {
    expect(() => parseHarnessMode("PI")).toThrow("JUMI_HARNESS_MODE");
    expect(() => parseHarnessMode("auto")).toThrow("JUMI_HARNESS_MODE");
    expect(() => loadConfig({ ...REVIEWER_BASE, JUMI_HARNESS_MODE: "bogus" })).toThrow("JUMI_HARNESS_MODE");
    expect(() => loadWorkerConfig({ ...WORKER_BASE, JUMI_HARNESS_MODE: "bogus" })).toThrow("JUMI_HARNESS_MODE");
  });

  test("two factory configs on the same release: unset and explicit legacy share dispatch", () => {
    const unsetReviewer = loadConfig({ ...REVIEWER_BASE });
    const legacyReviewer = loadConfig({ ...REVIEWER_BASE, JUMI_HARNESS_MODE: "legacy" });
    expect(unsetReviewer.harnessMode).toBe("legacy");
    expect(legacyReviewer.harnessMode).toBe("legacy");
    expect(legacyReviewer.chain).toEqual(unsetReviewer.chain);
    expect(legacyReviewer.runners).toEqual(unsetReviewer.runners);
    expect(legacyReviewer.runnerSelection).toBe(unsetReviewer.runnerSelection);

    const unsetWorker = loadWorkerConfig({ ...WORKER_BASE });
    const legacyWorker = loadWorkerConfig({ ...WORKER_BASE, JUMI_HARNESS_MODE: "legacy" });
    expect(unsetWorker.harnessMode).toBe("legacy");
    expect(legacyWorker.harnessMode).toBe("legacy");
    expect(legacyWorker.chain).toEqual(unsetWorker.chain);
    expect(legacyWorker.runners).toEqual(unsetWorker.runners);

    // Same release, same catalogs: pi factory keeps the catalog unchanged.
    const piReviewer = loadConfig({ ...REVIEWER_BASE, JUMI_HARNESS_MODE: "pi" });
    expect(piReviewer.harnessMode).toBe("pi");
    expect(piReviewer.chain).toEqual(unsetReviewer.chain);
    expect(piReviewer.runners).toEqual(unsetReviewer.runners);
    const piWorker = loadWorkerConfig({ ...WORKER_BASE, JUMI_HARNESS_MODE: "pi" });
    expect(piWorker.harnessMode).toBe("pi");
    expect(piWorker.chain).toEqual(unsetWorker.chain);
  });

  test("explicit pi fails clearly without spawning legacy (reviewer)", async () => {
    const store = new MemoryReviewJobStore();
    const config = loadConfig({ ...REVIEWER_BASE, JUMI_HARNESS_MODE: "pi" });
    let spawned = false;
    const api = {
      getPR: async () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    };
    await expect(processEngineTick(store, config, api as never, "lease-1")).rejects.toBeInstanceOf(
      PiHarnessNotImplementedError
    );
    expect(spawned).toBe(false);
    expect(() => throwIfPiHarness("pi")).toThrow(PiHarnessNotImplementedError);
    expect(() => throwIfPiHarness("legacy")).not.toThrow();
  });

  test("explicit pi fails clearly without spawning legacy (worker)", async () => {
    const store = new MemoryReviewJobStore();
    const config = loadWorkerConfig({ ...WORKER_BASE, JUMI_HARNESS_MODE: "pi" });
    await expect(processWorkerTick(store, config, fakeIssueApi(), "lease-1")).rejects.toBeInstanceOf(
      PiHarnessNotImplementedError
    );
    void fakeReviewApi;
  });

  test("additive attempt-mode stamp: old rows read as legacy", () => {
    expect(normalizeHarnessMode(undefined)).toBe("legacy");
    expect(normalizeHarnessMode(null)).toBe("legacy");
    expect(normalizeHarnessMode("legacy")).toBe("legacy");
    expect(normalizeHarnessMode("pi")).toBe("pi");
  });

  test("saveResult stamps the attempt mode and old rows stay compatible", async () => {
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
    // Old row has no stamp: reads as legacy.
    expect((leased as any).harnessMode).toBeUndefined();
    expect(normalizeHarnessMode((leased as any).harnessMode)).toBe("legacy");
    await store.saveResult((leased as any).id, "owner-1", {
      kind: "skip",
      reason: "test",
      harnessMode: "legacy",
    } as never);
    const after = await store.get((leased as any).id);
    // Legacy clears to absent so whole-row assertions do not change.
    expect((after as any).harnessMode).toBeUndefined();
  });

  test("resume only in the recorded mode: mismatch needs a fresh fenced attempt", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue({
      delivery: "d2",
      owner: "o",
      repo: "r",
      prNumber: 2,
      action: "synchronize",
      headSha: "def",
      receivedAt: new Date().toISOString(),
    } as never);
    const leased = await store.lease("owner-1", 60_000, new Date(), ["review"] as never);
    await store.saveResult((leased as any).id, "owner-1", {
      kind: "error",
      error: "boom",
      harnessMode: "pi",
    } as never);
    const recorded = await store.get((leased as any).id);
    expect((recorded as any).harnessMode).toBe("pi");
    // A legacy factory must not convert the pi attempt's live session.
    const legacyConfig = loadConfig({ ...REVIEWER_BASE, JUMI_HARNESS_MODE: "legacy" });
    expect(normalizeHarnessMode((recorded as any).harnessMode)).not.toBe(legacyConfig.harnessMode);
  });

  test("workdir stamp fences mode changes without converting a live session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-harness-"));
    // First run stamps legacy and must not resume (no live session yet).
    expect(await gateResumeOnHarnessMode(dir, "legacy", async () => {})).toBe(false);
    expect(await readRecordedHarnessMode(dir)).toBe("legacy");
    // Same mode may resume; the helper does not clear.
    expect(await gateResumeOnHarnessMode(dir, "legacy", async () => {})).toBe(true);
    // Different mode clears and fences fresh, never converting.
    let cleared = false;
    expect(
      await gateResumeOnHarnessMode(dir, "pi", async () => {
        cleared = true;
      })
    ).toBe(false);
    expect(cleared).toBe(true);
    expect(await readRecordedHarnessMode(dir)).toBe("pi");
    await writeHarnessModeStamp(dir, "legacy");
    expect(await readRecordedHarnessMode(dir)).toBe("legacy");
  });
});
