import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  HARNESS_MODE_ENV,
  normalizeHarnessMode,
  PiHarnessNotImplementedError,
  parseHarnessMode,
  throwIfPiHarness,
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

const PI_GO_PROFILE = {
  provider: "opencode-go",
  model: "muse-spark-1.3-contributor",
  endpoint: "https://opencode.ai/zen/go/v1",
  fundingPool: "go-pool",
  payer: "go-subscription",
  credentialRef: "env:EXAMPLE_GO_KEY",
  scopes: ["public"],
  sku: "contributor",
};

async function piCatalogFile(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-harness-pi-"));
  const path = join(dir, "profiles.json");
  await writeFile(path, JSON.stringify({ "pi-go-spark": PI_GO_PROFILE }));
  return { dir, path };
}

function piDeployment(): { mode: "pi"; catalog: Record<string, never>; allowlist: string[] } {
  return { mode: "pi", catalog: { "pi-go-spark": PI_GO_PROFILE } as never, allowlist: ["pi-go-spark"] };
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

  test("two factory configs on the same release: unset and explicit legacy share dispatch", async () => {
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

    // Same release, same catalogs: the pi factory keeps the runner catalog
    // unchanged once its deployment file and allowlist are set.
    const { dir, path } = await piCatalogFile();
    try {
      const piEnv = { JUMI_HARNESS_MODE: "pi", JUMI_PI_PROFILES_FILE: path, JUMI_PI_ALLOWED_ROUTES: "pi-go-spark" };
      const piReviewer = loadConfig({ ...REVIEWER_BASE, ...piEnv });
      expect(piReviewer.harnessMode).toBe("pi");
      expect(piReviewer.chain).toEqual(unsetReviewer.chain);
      expect(piReviewer.runners).toEqual(unsetReviewer.runners);
      const piWorker = loadWorkerConfig({ ...WORKER_BASE, ...piEnv });
      expect(piWorker.harnessMode).toBe("pi");
      expect(piWorker.chain).toEqual(unsetWorker.chain);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("explicit pi fails process start naming the cause (reviewer)", async () => {
    // No profiles file: start fails naming the key, before any lease or spawn.
    expect(() => loadConfig({ ...REVIEWER_BASE, JUMI_HARNESS_MODE: "pi" })).toThrow("JUMI_PI_PROFILES_FILE");
    const { dir, path } = await piCatalogFile();
    try {
      // A profiles file with an empty allowlist fails naming the allowlist.
      expect(() => loadConfig({ ...REVIEWER_BASE, JUMI_HARNESS_MODE: "pi", JUMI_PI_PROFILES_FILE: path })).toThrow(
        "JUMI_PI_ALLOWED_ROUTES"
      );
      // A valid Go deployment loads, and the tick attempts the Pi path
      // without spawning legacy.
      const config = loadConfig({
        ...REVIEWER_BASE,
        JUMI_HARNESS_MODE: "pi",
        JUMI_PI_PROFILES_FILE: path,
        JUMI_PI_ALLOWED_ROUTES: "pi-go-spark",
      });
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
      let spawned = false;
      const api = {
        getPR: async () => {
          throw new Error("forge down (expected: pi path reads the PR before any spawn)");
        },
      };
      const tick = await processEngineTick(
        store,
        config,
        api as never,
        "lease-1",
        {
          engine: async () => {
            spawned = true;
            throw new Error("must not spawn legacy on pi");
          },
          piDeployment: piDeployment(),
        } as never,
        () => undefined
      );
      expect(tick).toBe("processed");
      expect(spawned).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(() => throwIfPiHarness("pi")).toThrow(PiHarnessNotImplementedError);
    expect(() => throwIfPiHarness("legacy")).not.toThrow();
  });

  test("explicit pi fails process start and never spawns legacy (worker)", async () => {
    expect(() => loadWorkerConfig({ ...WORKER_BASE, JUMI_HARNESS_MODE: "pi" })).toThrow("JUMI_PI_PROFILES_FILE");
    const { dir, path } = await piCatalogFile();
    try {
      const config = loadWorkerConfig({
        ...WORKER_BASE,
        JUMI_HARNESS_MODE: "pi",
        JUMI_PI_PROFILES_FILE: path,
        JUMI_PI_ALLOWED_ROUTES: "pi-go-spark",
      });
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue({
        delivery: "d1",
        owner: "o",
        repo: "r",
        issueNumber: 1,
        action: "opened",
        title: "t",
        body: "b",
        htmlUrl: "https://gitea.example/o/r/issues/1",
        issueUpdatedAt: new Date().toISOString(),
        defaultBranch: "main",
        cloneUrl: "https://gitea.example/o/r.git",
        receivedAt: new Date().toISOString(),
      });
      let spawned = false;
      const stub = async (): Promise<never> => {
        spawned = true;
        throw new Error("must not spawn legacy on pi");
      };
      const api = {
        getRepo: async () => ({
          name: "r",
          full_name: "o/r",
          html_url: "https://gitea.example/o/r",
          clone_url: "https://gitea.example/o/r.git",
          default_branch: "main",
          owner: { login: "o" },
          private: true,
        }),
      };
      const tick = await processWorkerTick(
        store,
        config,
        api as never,
        "lease-1",
        { implement: stub, followUp: stub, conflict: stub, piDeployment: piDeployment() } as never,
        () => undefined
      );
      expect(tick).toBe("processed");
      expect(spawned).toBe(false);
      const row = await store.get(1);
      expect(row?.harnessMode).toBe("pi");
      expect(row?.piOutcome).toBe("denied");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
});
