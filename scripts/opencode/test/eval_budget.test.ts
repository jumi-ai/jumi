import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, EngineRunOptions } from "../src/engine.ts";
import {
  EVAL_SPEND_INPUT_USD_PER_M,
  EVAL_SPEND_OUTPUT_USD_PER_M,
  evalListEstimateUsdFrom,
  evalSpendForRun,
  parseEvalBudgetUsd,
  readEvalSpendFile,
  writeEvalSpendFile,
} from "../src/eval_harness.ts";
import { loadReviewEvalFixture, parseReviewEvalArgs, runReviewEval } from "../src/review_eval.ts";
import { resetTokenMetricsForTests } from "../src/token_metrics.ts";
import { loadWorkerEvalFixture, parseWorkerEvalArgs, runWorkerEval } from "../src/worker_eval.ts";

const RUNNER = { name: "fake", type: "opencode", model: "fake/model" } as const;

function usageEngine(usage: unknown, extra?: Record<string, unknown>): Engine {
  return (async () => ({ status: "ok", ...(extra ?? {}), ...(usage === undefined ? {} : { usage }) })) as Engine;
}

async function withDirs(
  fn: (dirs: { outDir: string; workdirRoot: string; homeRoot: string; tmpRoot: string }) => Promise<void>
): Promise<void> {
  const outDir = await mkdtemp(join(tmpdir(), "eval-budget-out-"));
  const workdirRoot = await mkdtemp(join(tmpdir(), "eval-budget-work-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "eval-budget-home-"));
  const tmpRoot = await mkdtemp(join(tmpdir(), "eval-budget-tmp-"));
  resetTokenMetricsForTests();
  try {
    await fn({ outDir, workdirRoot, homeRoot, tmpRoot });
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("eval spend budget", () => {
  test("list estimate prices input and output at the published list prices", () => {
    expect(EVAL_SPEND_INPUT_USD_PER_M).toBe(0.1);
    expect(EVAL_SPEND_OUTPUT_USD_PER_M).toBe(0.2);
    expect(evalListEstimateUsdFrom({ inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.3, 9);
  });

  test("estimate counts cached input at the full input price", () => {
    expect(evalListEstimateUsdFrom({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 })).toBeCloseTo(0.2, 9);
  });

  test("allowance figure is preferred over the estimate", () => {
    const spend = evalSpendForRun({
      usage: { inputTokens: 100_000_000, outputTokens: 100_000_000, opencode: { allowance: 0.01 } },
    });
    expect(spend.spendUsd).toBeCloseTo(0.01, 9);
    expect(spend.spendSource).toBe("allowance");
  });

  test("a run with no figure is unmeasurable", () => {
    expect(evalSpendForRun({ usage: null })).toEqual({ spendUsd: null, spendSource: "unknown" });
    expect(evalSpendForRun({ usage: {} })).toEqual({ spendUsd: null, spendSource: "unknown" });
  });

  test("worker eval stops before the next run once the budget is reached (overshoot at most one run)", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withDirs(async (dirs) => {
      const usage = { inputTokens: 1_000_000 };
      const records = await runWorkerEval({
        fixtures: [fixture],
        runners: [{ ...RUNNER }],
        trials: 3,
        budgetUsd: 0.15,
        ...dirs,
        engineForRunner: () => usageEngine(usage),
        logger: () => undefined,
      });
      expect(records).toHaveLength(3);
      // Two runs executed at $0.10 each (overshoot of one run past $0.15);
      // the third never started.
      expect(records[0]?.spendUsd).toBeCloseTo(0.1, 9);
      expect(records[0]?.spendSource).toBe("list-estimate");
      expect(records[1]?.spendUsd).toBeCloseTo(0.1, 9);
      expect(records[2]?.verdict).toBe("inconclusive");
      expect(records[2]?.inconclusiveReason).toBe("budget-exhausted");
      expect(records[2]?.spendUsd).toBe(0);
      // Budget-exhausted rows still count in denominators.
      const jsonl = await readFile(join(dirs.outDir, "results.jsonl"), "utf8");
      expect(jsonl.trim().split("\n")).toHaveLength(3);
    });
  });

  test("worker eval records allowance spend and prefers it over tokens", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withDirs(async (dirs) => {
      const records = await runWorkerEval({
        fixtures: [fixture],
        runners: [{ ...RUNNER }],
        trials: 1,
        ...dirs,
        engineForRunner: () =>
          usageEngine({ inputTokens: 100_000_000, outputTokens: 100_000_000 }, { allowanceUsd: 0.02 }),
        logger: () => undefined,
      });
      expect(records[0]?.spendUsd).toBeCloseTo(0.02, 9);
      expect(records[0]?.spendSource).toBe("allowance");
    });
  });

  test("a run with no figure stops the eval as budget-unmeasurable", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withDirs(async (dirs) => {
      let threw = false;
      try {
        await runWorkerEval({
          fixtures: [fixture],
          runners: [{ ...RUNNER }],
          trials: 2,
          budgetUsd: 10,
          ...dirs,
          engineForRunner: () => usageEngine(undefined),
          logger: () => undefined,
        });
      } catch (err) {
        threw = true;
        expect(String(err)).toMatch(/unmeasurable/);
      }
      expect(threw).toBe(true);
      const jsonl = await readFile(join(dirs.outDir, "results.jsonl"), "utf8");
      const rows = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { inconclusiveReason?: string; spendUsd?: number | null });
      expect(rows).toHaveLength(2);
      expect(rows[1]?.inconclusiveReason).toBe("budget-unmeasurable");
    });
  });

  test("shared spend file carries worker spend into the review eval", async () => {
    const workerFixture = await loadWorkerEvalFixture("done-while-ci-pending");
    const reviewFixture = await loadReviewEvalFixture("adult-boundary");
    const outWorker = await mkdtemp(join(tmpdir(), "eval-budget-wout-"));
    const outReview = await mkdtemp(join(tmpdir(), "eval-budget-rout-"));
    const workdirRoot = await mkdtemp(join(tmpdir(), "eval-budget-work-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "eval-budget-home-"));
    const tmpRoot = await mkdtemp(join(tmpdir(), "eval-budget-tmp-"));
    const spendFile = join(tmpdir(), `eval-budget-spend-${Date.now().toString(36)}.txt`);
    resetTokenMetricsForTests();
    try {
      await runWorkerEval({
        fixtures: [workerFixture],
        runners: [{ ...RUNNER }],
        trials: 1,
        outDir: outWorker,
        workdirRoot,
        homeRoot,
        tmpRoot,
        spendFile,
        engineForRunner: () => usageEngine({ inputTokens: 1_000_000 }),
        logger: () => undefined,
      });
      expect(await readEvalSpendFile(spendFile)).toBeCloseTo(0.1, 9);
      const records = await runReviewEval({
        fixtures: [reviewFixture],
        halves: ["defective", "repaired"],
        runners: [{ ...RUNNER }],
        trials: 1,
        outDir: outReview,
        workdirRoot,
        homeRoot,
        budgetUsd: 0.15,
        spendFile,
        engineForRunner: () => usageEngine({ inputTokens: 1_000_000 }),
        logger: () => undefined,
      });
      // Carried $0.10 + first review run $0.10 = $0.20, so the second half never starts.
      expect(records).toHaveLength(2);
      expect(records[0]?.spendUsd).toBeCloseTo(0.1, 9);
      expect(records[1]?.inconclusiveReason).toBe("budget-exhausted");
      expect(await readEvalSpendFile(spendFile)).toBeCloseTo(0.2, 9);
    } finally {
      await rm(outWorker, { recursive: true, force: true }).catch(() => undefined);
      await rm(outReview, { recursive: true, force: true }).catch(() => undefined);
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(spendFile, { force: true }).catch(() => undefined);
    }
  });

  test("no budget flag keeps today's behaviour", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withDirs(async (dirs) => {
      const records = await runWorkerEval({
        fixtures: [fixture],
        runners: [{ ...RUNNER }],
        trials: 2,
        ...dirs,
        engineForRunner: () => usageEngine(undefined),
        logger: () => undefined,
      });
      expect(records).toHaveLength(2);
      expect(records[0]?.spendSource).toBe("unknown");
      expect(records[0]?.spendUsd).toBeNull();
      expect(records.every((r) => r.inconclusiveReason !== "budget-exhausted")).toBe(true);
    });
  });

  test("review eval stops before the next run once the budget is reached", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    const workdirRoot = await mkdtemp(join(tmpdir(), "eval-budget-rwork-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "eval-budget-rhome-"));
    const outDir = await mkdtemp(join(tmpdir(), "eval-budget-rout-"));
    resetTokenMetricsForTests();
    try {
      const records = await runReviewEval({
        fixtures: [fixture],
        halves: ["defective", "repaired"],
        runners: [{ ...RUNNER }],
        trials: 1,
        outDir,
        workdirRoot,
        homeRoot,
        budgetUsd: 0.05,
        engineForRunner: () => usageEngine({ inputTokens: 1_000_000 }),
        logger: () => undefined,
      });
      expect(records).toHaveLength(2);
      expect(records[0]?.spendUsd).toBeCloseTo(0.1, 9);
      expect(records[1]?.verdict).toBe("inconclusive");
      expect(records[1]?.inconclusiveReason).toBe("budget-exhausted");
    } finally {
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("spend file round-trips the running total", async () => {
    const path = join(tmpdir(), `eval-spend-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}.txt`);
    try {
      expect(await readEvalSpendFile(path)).toBe(0);
      await writeEvalSpendFile(path, 0.25);
      expect(await readEvalSpendFile(path)).toBeCloseTo(0.25, 9);
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  });

  test("a missing --budget-usd value fails instead of running uncapped", () => {
    // Empty is not "omitted" once the flag was given: it must throw.
    expect(() => parseEvalBudgetUsd("")).toThrow(/Missing --budget-usd/);
    expect(() => parseEvalBudgetUsd("   ")).toThrow(/Missing --budget-usd/);
    expect(parseEvalBudgetUsd(undefined)).toBeUndefined();
    expect(parseEvalBudgetUsd("0.5")).toBeCloseTo(0.5, 9);
    expect(() => parseEvalBudgetUsd("nope")).toThrow(/Invalid --budget-usd/);
    // Bare flag last swallows nothing: both CLIs throw.
    expect(() => parseReviewEvalArgs(["--out", "x", "--budget-usd"])).toThrow(/Missing --budget-usd/);
    expect(() => parseWorkerEvalArgs(["--out", "x", "--budget-usd"])).toThrow(/Missing --budget-usd/);
    // The `=` form with an empty value throws too.
    expect(() => parseReviewEvalArgs(["--out", "x", "--budget-usd="])).toThrow(/Missing --budget-usd/);
    expect(() => parseWorkerEvalArgs(["--out", "x", "--budget-usd="])).toThrow(/Missing --budget-usd/);
    expect(() => parseReviewEvalArgs(["--out", "x", "--budget-usd= "])).toThrow(/Missing --budget-usd/);
    // Well-formed flags still parse.
    expect(parseReviewEvalArgs(["--out", "x", "--budget-usd", "0.5"]).budgetUsd).toBeCloseTo(0.5, 9);
    expect(parseWorkerEvalArgs(["--out", "x", "--budget-usd=0.5"]).budgetUsd).toBeCloseTo(0.5, 9);
  });

  test("legacy review post-run git failure keeps the priced spend", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    const workdirRoot = await mkdtemp(join(tmpdir(), "eval-budget-rwork-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "eval-budget-rhome-"));
    const outDir = await mkdtemp(join(tmpdir(), "eval-budget-rout-"));
    resetTokenMetricsForTests();
    try {
      // The engine breaks the checkout after a priced run, so the post-run
      // HEAD read fails. The record must still carry the spend: under a
      // budget it stays measurable (no budget-unmeasurable throw).
      const breakingEngine = (async (runOpts: EngineRunOptions) => {
        await rm(join(runOpts.workdir, ".git"), { recursive: true, force: true });
        // A bogus `.git` file (not a deletion): git walks up to a parent
        // checkout, so only an invalid `.git` fails discovery outright.
        await writeFile(join(runOpts.workdir, ".git"), "not a git dir\n");
        return { status: "ok", usage: { inputTokens: 1_000_000 } };
      }) as Engine;
      const records = await runReviewEval({
        fixtures: [fixture],
        halves: ["defective"],
        runners: [{ ...RUNNER }],
        trials: 1,
        outDir,
        workdirRoot,
        homeRoot,
        budgetUsd: 10,
        engineForRunner: () => breakingEngine,
        logger: () => undefined,
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.inconclusiveReason).toMatch(/post-run HEAD read failed/);
      expect(records[0]?.spendUsd).toBeCloseTo(0.1, 9);
      expect(records[0]?.spendSource).toBe("list-estimate");
    } finally {
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
