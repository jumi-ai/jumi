import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureEvalRoots,
  evalImageDigest,
  evalUsageOrNull,
  loadEvalLegacyRunners,
  loadEvalPiDeployment,
  parseEvalHarness,
  piAllowedHostsForRoute,
  resolveEvalPiRoute,
} from "../src/eval_harness.ts";
import { loadReviewEvalFixture, runReviewEval, runReviewEvalCase } from "../src/review_eval.ts";
import { loadWorkerEvalFixture, runWorkerEval, runWorkerEvalCase } from "../src/worker_eval.ts";

const LEGACY_RUNNER = { name: "fake", type: "opencode", model: "fake/model" } as const;
const GO_PROFILE = "pi-go-spark";

function goCatalog(endpoint = "http://127.0.0.1:1"): string {
  return JSON.stringify({
    [GO_PROFILE]: {
      provider: "opencode-go",
      model: "muse-spark-1.3-contributor",
      endpoint,
      fundingPool: "go-pool",
      payer: "go-subscription",
      credentialRef: "env:EXAMPLE_GO_KEY",
      scopes: ["public"],
      sku: "contributor",
    },
  });
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("eval harness selection", () => {
  test("parses harness flags, default legacy", () => {
    expect(parseEvalHarness(undefined)).toEqual(["legacy"]);
    expect(parseEvalHarness("")).toEqual(["legacy"]);
    expect(parseEvalHarness("legacy")).toEqual(["legacy"]);
    expect(parseEvalHarness("pi")).toEqual(["pi"]);
    expect(parseEvalHarness("legacy,pi")).toEqual(["legacy", "pi"]);
    expect(parseEvalHarness("pi,legacy")).toEqual(["pi", "legacy"]);
    expect(() => parseEvalHarness("bogus")).toThrow(/--harness/);
  });

  test("usage unknown stays null, never zero", () => {
    expect(evalUsageOrNull(undefined)).toBeNull();
    expect(evalUsageOrNull(null)).toBeNull();
    const usage = { inputTokens: 1, cachedInputTokens: 0 };
    expect(evalUsageOrNull(usage)).toEqual(usage);
  });

  test("image digest defaults null, reads env", async () => {
    await withEnv({ JUMI_IMAGE_DIGEST: undefined }, async () => {
      expect(evalImageDigest()).toBeNull();
    });
    await withEnv({ JUMI_IMAGE_DIGEST: "sha256:abc" }, async () => {
      expect(evalImageDigest()).toBe("sha256:abc");
    });
  });

  test("pi allowed hosts is just the endpoint", () => {
    expect(piAllowedHostsForRoute({ endpoint: "http://127.0.0.1:9/x" })).toEqual(["127.0.0.1"]);
  });
});

describe("eval pi gate", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eval-pi-gate-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("missing profile file fails before fixtures and writes no records", async () => {
    const outDir = join(dir, "out");
    const workdirRoot = join(dir, "work");
    const homeRoot = join(dir, "home");
    const tmpRoot = join(dir, "tmp");
    await withEnv({ JUMI_PI_PROFILES_FILE: undefined, JUMI_PI_ALLOWED_ROUTES: undefined }, async () => {
      const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
      await expect(
        runWorkerEval({
          fixtures: [fixture],
          runners: [{ ...LEGACY_RUNNER }],
          trials: 1,
          outDir,
          workdirRoot,
          homeRoot,
          tmpRoot,
          harnesses: ["pi"],
        })
      ).rejects.toThrow(/JUMI_PI_PROFILES_FILE/);
      // No records file was created.
      await expect(readFile(join(outDir, "results.jsonl"), "utf8")).rejects.toThrow();
    });
  });

  test("unwired route fails before fixtures", async () => {
    const catalogPath = join(dir, "profiles.json");
    await writeFile(
      catalogPath,
      JSON.stringify({
        "pi-chatgpt-oss": {
          provider: "openai",
          model: "gpt-6.2-sol",
          endpoint: "https://api.openai.com/v1",
          fundingPool: "chatgpt-pool",
          payer: "chatgpt-subscription",
          credentialRef: "operator:chatgpt-login",
          scopes: ["public"],
        },
      })
    );
    await withEnv({ JUMI_PI_PROFILES_FILE: catalogPath, JUMI_PI_ALLOWED_ROUTES: "pi-chatgpt-oss" }, async () => {
      expect(() => loadEvalPiDeployment()).toThrow(/route not wired/);
    });
  });
});

describe("eval pi records", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eval-pi-records-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function piEnv(fn: () => Promise<void>): Promise<void> {
    const catalogPath = join(dir, "profiles.json");
    await writeFile(catalogPath, goCatalog());
    await withEnv({ JUMI_PI_PROFILES_FILE: catalogPath, JUMI_PI_ALLOWED_ROUTES: GO_PROFILE }, fn);
  }

  test("pi review runs both halves with stamp fields", async () => {
    await piEnv(async () => {
      const fixture = await loadReviewEvalFixture("adult-boundary");
      const deployment = loadEvalPiDeployment();
      const route = resolveEvalPiRoute(deployment);
      expect(route.name).toBe(GO_PROFILE);
      for (const half of ["defective", "repaired"] as const) {
        const record = await runReviewEvalCase({
          fixture,
          half,
          runner: { ...LEGACY_RUNNER },
          trial: 1,
          workdirRoot: join(dir, "work"),
          homeRoot: join(dir, "home"),
          harness: "pi",
          piInvoke: async ({ store }) => {
            if (half === "defective") {
              const added = store.addFinding({
                path: "eligibility.js",
                line: 2,
                severity: "bug",
                title: "Off-by-one: isAdult(18) is false",
                body: "isAdult(18) returns false, want true: an 18-year-old counts as an adult.",
              });
              if (!added.ok) throw new Error(added.error);
              const verdict = store.setVerdict({ state: "failure", reason: "blocking" });
              if (!verdict.ok) throw new Error(verdict.error);
            } else {
              const verdict = store.setVerdict({ state: "success", reason: "clean" });
              if (!verdict.ok) throw new Error(verdict.error);
            }
            return { usage: { inputTokens: 3, outputTokens: 5 } };
          },
        });
        expect(record.harness).toBe("pi");
        expect(record.verdict).toBe("pass");
        expect(record.route).toBe(GO_PROFILE);
        expect(record.payer).toBe("go-subscription");
        expect(record.pool).toBe("go-pool");
        expect(record.outcome).toBe("ok");
        expect(record.effectiveModel).toBe("muse-spark-1.3-contributor");
        expect(record.usage).toBeDefined();
        expect(record.imageDigest).toBeNull();
        expect(record.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  test("pi worker runs the fixture with stamp fields", async () => {
    await piEnv(async () => {
      const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...LEGACY_RUNNER },
        trial: 1,
        workdirRoot: join(dir, "work"),
        homeRoot: join(dir, "home"),
        tmpRoot: join(dir, "tmp"),
        harness: "pi",
        piInvoke: async ({ workdir, store }) => {
          await writeFile(join(workdir, "sum.js"), `export function sum(a, b) {\n  return a + b;\n}\n`);
          const res = store.setPrBody({ markdown: "Adds sum helper.\n\nFixes #1", remaining: [] });
          if (!res.ok) throw new Error(res.error);
          return { usage: { inputTokens: 2, outputTokens: 4 } };
        },
      });
      expect(record.harness).toBe("pi");
      expect(record.verdict).toBe("pass");
      expect(record.route).toBe(GO_PROFILE);
      expect(record.payer).toBe("go-subscription");
      expect(record.pool).toBe("go-pool");
      expect(record.outcome).toBe("ok");
      expect(record.jobStatus).toBe("pr");
    });
  });

  test("pi quota is inconclusive, never fail", async () => {
    await piEnv(async () => {
      const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...LEGACY_RUNNER },
        trial: 1,
        workdirRoot: join(dir, "work"),
        homeRoot: join(dir, "home"),
        tmpRoot: join(dir, "tmp"),
        harness: "pi",
        piInvoke: async () => {
          throw new Error("Go limit reached for this interval (quota)");
        },
      });
      expect(record.verdict).toBe("inconclusive");
      expect(record.failedAssertions).toEqual([]);
      expect(record.inconclusiveReason).toMatch(/quota|limit/i);
    });
  });

  test("legacy,pi writes joinable records per harness", async () => {
    await piEnv(async () => {
      const fixture = await loadReviewEvalFixture("adult-boundary");
      const outDir = join(dir, "out");
      const records = await runReviewEval({
        fixtures: [fixture],
        halves: ["defective"],
        runners: [{ ...LEGACY_RUNNER }],
        trials: 1,
        outDir,
        workdirRoot: join(dir, "work"),
        homeRoot: join(dir, "home"),
        harnesses: ["legacy", "pi"],
        engineForRunner: () => async () => ({ status: "ok" as const }),
        piInvokeForRoute:
          () =>
          async ({ store }) => {
            const verdict = store.setVerdict({ state: "failure", reason: "blocking" });
            if (!verdict.ok) throw new Error(verdict.error);
            return {};
          },
      });
      expect(records).toHaveLength(2);
      const byHarness = new Map(records.map((r) => [r.harness, r]));
      expect(byHarness.get("legacy")?.fixture).toBe("adult-boundary");
      expect(byHarness.get("pi")?.fixture).toBe("adult-boundary");
      expect(byHarness.get("legacy")?.half).toBe(byHarness.get("pi")?.half);
      expect(byHarness.get("legacy")?.trial).toBe(byHarness.get("pi")?.trial);
      const jsonl = await readFile(join(outDir, "results.jsonl"), "utf8");
      expect(jsonl.trim().split("\n")).toHaveLength(2);
    });
  });

  test("omitting harness keeps legacy shape plus harness", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    const outDir = join(dir, "out-legacy");
    const records = await runReviewEval({
      fixtures: [fixture],
      halves: ["repaired"],
      runners: [{ ...LEGACY_RUNNER }],
      trials: 1,
      outDir,
      workdirRoot: join(dir, "work"),
      homeRoot: join(dir, "home"),
      engineForRunner: () => async () => ({ status: "ok" as const }),
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.harness).toBe("legacy");
    expect(records[0]?.route).toBe("fake");
  });
});

describe("eval volume and output", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eval-volume-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("fresh nested roots are created before mkdtemp", async () => {
    await ensureEvalRoots([join(dir, "a", "b"), join(dir, "c")]);
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    const record = await runWorkerEvalCase({
      fixture,
      runner: { ...LEGACY_RUNNER },
      trial: 1,
      workdirRoot: join(dir, "a", "b"),
      homeRoot: join(dir, "c"),
      tmpRoot: join(dir, "d", "e"),
      engine: async (runOpts) => {
        await writeFile(join(runOpts.workdir, "sum.js"), `export function sum(a, b) {\n  return a + b;\n}\n`);
        return { status: "ok" };
      },
    });
    // Engine alone does not open a PR, so this fails grading but must not be inconclusive.
    expect(record.verdict).not.toBe("inconclusive");
    expect(record.harness).toBe("legacy");
  });

  test("two runs with same out keep both runs records", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    const outDir = join(dir, "out");
    const scripted = () => async () => ({ status: "ok" as const });
    const first = await runWorkerEval({
      fixtures: [fixture],
      runners: [{ ...LEGACY_RUNNER }],
      trials: 1,
      outDir,
      workdirRoot: join(dir, "w1"),
      homeRoot: join(dir, "h1"),
      tmpRoot: join(dir, "t1"),
      engineForRunner: scripted,
    });
    const second = await runWorkerEval({
      fixtures: [fixture],
      runners: [{ ...LEGACY_RUNNER }],
      trials: 1,
      outDir,
      workdirRoot: join(dir, "w2"),
      homeRoot: join(dir, "h2"),
      tmpRoot: join(dir, "t2"),
      engineForRunner: scripted,
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const jsonl = await readFile(join(outDir, "results.jsonl"), "utf8");
    const lines = jsonl.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
  });

  test("legacy baseline ignores dormant agy entries", async () => {
    const runnersPath = join(dir, "runners.json");
    await writeFile(
      runnersPath,
      JSON.stringify({
        runners: {
          spark: { type: "opencode", model: "fake/model" },
          dormant: { type: "agy", model: "dormant/model" },
        },
        chain: ["spark", "dormant"],
      })
    );
    await withEnv({ JUMI_RUNNERS_FILE: runnersPath, FORGE: undefined }, async () => {
      const selected = loadEvalLegacyRunners(["spark"]);
      expect(selected.map((r) => r.name)).toEqual(["spark"]);
    });
  });
});
