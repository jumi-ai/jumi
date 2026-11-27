import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, EngineRunOptions } from "../src/engine.ts";
import { QUOTA_STUCK_TEXT } from "../src/quota.ts";
import { loadReviewEvalFixture, REVIEW_EVAL_CONTRACT, runReviewEval, runReviewEvalCase } from "../src/review_eval.ts";
import { probeReviewMcpServer } from "../src/review_mcp.ts";

const RUNNER = { name: "fake", type: "opencode", model: "fake/model" } as const;

type ScriptOpts = {
  findings?: Array<{ path?: string; line?: number; severity: string; title: string; body: string }>;
  verdict?: { state: "success" | "failure"; reason?: string };
  dirty?: boolean;
  plantFile?: string;
  capture?: {
    contract?: unknown;
    hasMcp?: boolean;
    task?: string;
    baseDir?: string;
    taskHas?: Record<string, boolean>;
  };
};

function scriptedReviewEngine(script: ScriptOpts): Engine {
  return async (runOpts: EngineRunOptions) => {
    if (script.capture) {
      script.capture.contract = (runOpts as { verdictContract?: unknown }).verdictContract;
      script.capture.hasMcp = Boolean(runOpts.reviewMcp?.url && runOpts.reviewMcp?.token);
      script.capture.baseDir = (runOpts as { baseInstructionsDir?: string }).baseInstructionsDir;
      try {
        script.capture.task = await readFile(join(runOpts.workdir, "JUMI_TASK.md"), "utf8");
      } catch {
        script.capture.task = "";
      }
      if (script.capture.task !== undefined) {
        const task = script.capture.task;
        script.capture.taskHas = {
          files: task.includes("eligibility.js"),
          mcp: task.includes("add_finding"),
          reviewMd: task.includes("Boundary comparisons"),
          base: task.includes("Base instructions"),
        };
      }
    }
    if (script.plantFile !== undefined) {
      await writeFile(join(runOpts.workdir, "JUMI_REVIEW.md"), script.plantFile, "utf8");
    }
    if (script.dirty) {
      await writeFile(join(runOpts.workdir, "notes.txt"), "agent was here\n", "utf8");
    }
    const mcp = runOpts.reviewMcp;
    if (!mcp) throw new Error("no review mcp");
    for (const finding of script.findings ?? []) {
      const added = await probeReviewMcpServer(mcp.url, mcp.token, "add_finding", { ...finding });
      if (!added.ok) throw new Error(`add_finding rejected: ${added.text}`);
    }
    if (script.verdict) {
      const recorded = await probeReviewMcpServer(mcp.url, mcp.token, "set_verdict", { ...script.verdict });
      if (!recorded.ok) throw new Error(`set_verdict rejected: ${recorded.text}`);
    }
    return { status: "ok" };
  };
}

const BUG_FINDING = {
  path: "eligibility.js",
  line: 2,
  severity: "bug",
  title: "Off-by-one: isAdult(18) is false",
  body: "isAdult(18) returns false, want true: an 18-year-old counts as an adult. Use age >= 18. Proof: isAdult(18) is false on this head.",
};

const VAGUE_FINDING = {
  path: "eligibility.js",
  line: 2,
  severity: "bug",
  title: "Check this",
  body: "Please check this boundary.",
};

const OFF_ANCHOR_FINDING = {
  path: "eligibility.js",
  line: 1,
  severity: "bug",
  title: "Off-by-one: isAdult(18) is false",
  body: "isAdult(18) returns false, want true. Proof: isAdult(18) is false.",
};

async function withRoots(fn: (roots: { workdirRoot: string; homeRoot: string; tmpRoot: string }) => Promise<void>) {
  const workdirRoot = await mkdtemp(join(tmpdir(), "review-eval-test-work-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "review-eval-test-home-"));
  const tmpRoot = await mkdtemp(join(tmpdir(), "review-eval-test-tmp-"));
  try {
    await fn({ workdirRoot, homeRoot, tmpRoot });
  } finally {
    await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("review eval", () => {
  test("passing run on both halves", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const defective = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedReviewEngine({
          findings: [BUG_FINDING],
          verdict: { state: "failure", reason: "blocking boundary defect" },
        }),
        logger: () => undefined,
      });
      expect(defective.verdict).toBe("pass");
      expect(defective.failedAssertions).toEqual([]);
      expect(defective.reviewState).toBe("failure");
      expect(defective.blockingCount).toBe(1);
      expect(defective.treeClean).toBe(true);
      expect(defective.contract).toBe(REVIEW_EVAL_CONTRACT);

      const repaired = await runReviewEvalCase({
        fixture,
        half: "repaired",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedReviewEngine({ verdict: { state: "success", reason: "clean" } }),
        logger: () => undefined,
      });
      expect(repaired.verdict).toBe("pass");
      expect(repaired.failedAssertions).toEqual([]);
      expect(repaired.reviewState).toBe("success");
      expect(repaired.blockingCount).toBe(0);
    });
  });

  test("missed defect fails the defective half", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const record = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedReviewEngine({ verdict: { state: "success", reason: "looks fine" } }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("defect-anchor");
    });
  });

  test("vague finding text fails the defective half", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const record = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedReviewEngine({
          findings: [VAGUE_FINDING],
          verdict: { state: "failure", reason: "blocking" },
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("defect-text");
    });
  });

  test("blocking finding outside every anchor fails", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const record = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedReviewEngine({
          findings: [OFF_ANCHOR_FINDING],
          verdict: { state: "failure", reason: "blocking" },
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("defect-anchor");
    });
  });

  test("blocking finding on the repaired half fails", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const record = await runReviewEvalCase({
        fixture,
        half: "repaired",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedReviewEngine({
          findings: [{ ...BUG_FINDING }],
          verdict: { state: "failure", reason: "blocking" },
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("repaired-blocking");
    });
  });

  test("dirty tree fails", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const record = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedReviewEngine({
          findings: [BUG_FINDING],
          verdict: { state: "failure", reason: "blocking" },
          dirty: true,
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("tree-clean");
    });
  });

  test("quota and auth failures are inconclusive, never fail", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const quotaRecord = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: async () => ({ status: "stuck", message: QUOTA_STUCK_TEXT }),
        logger: () => undefined,
      });
      expect(quotaRecord.verdict).toBe("inconclusive");
      expect(quotaRecord.failedAssertions).toEqual([]);

      const authRecord = await runReviewEvalCase({
        fixture,
        half: "repaired",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: async () => {
          throw new Error("auth: invalid token for fake/model");
        },
        logger: () => undefined,
      });
      expect(authRecord.verdict).toBe("inconclusive");
      expect(authRecord.failedAssertions).toEqual([]);
    });
  });

  test("fixture review runs the review MCP with the required verdict contract, not the legacy trailer", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const capture: ScriptOpts["capture"] = {};
      const record = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedReviewEngine({
          findings: [BUG_FINDING],
          verdict: { state: "failure", reason: "blocking" },
          // Opposite-verdict legacy file: the harness must ignore it.
          plantFile: "looks fine\n\n<!-- jumi-check: success -->\n",
          capture,
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("pass");
      expect(capture.hasMcp).toBe(true);
      expect(capture.contract).toBe("required");
      expect(capture.taskHas?.files).toBe(true);
      expect(capture.taskHas?.mcp).toBe(true);
      expect(capture.taskHas?.reviewMd).toBe(true);
      expect(capture.taskHas?.base).toBe(true);

      const fileOnly = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedReviewEngine({
          plantFile: "eligibility.js:2: 🔴 bug: off-by-one, isAdult(18) is false\n\n<!-- jumi-check: failure -->\n",
        }),
        logger: () => undefined,
      });
      // Required mode never publishes the file: no MCP verdict is incomplete.
      expect(fileOnly.verdict).toBe("fail");
      expect(fileOnly.reviewState).toBe("incomplete");
    });
  });

  test("harness writes one JSONL record per fixture x half x runner x trial", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    const workdirRoot = await mkdtemp(join(tmpdir(), "review-eval-batch-work-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "review-eval-batch-home-"));
    const tmpRoot = await mkdtemp(join(tmpdir(), "review-eval-batch-tmp-"));
    const outDir = await mkdtemp(join(tmpdir(), "review-eval-batch-out-"));
    try {
      const records = await runReviewEval({
        fixtures: [fixture],
        halves: ["defective", "repaired"],
        runners: [{ ...RUNNER }],
        trials: 1,
        outDir,
        workdirRoot,
        homeRoot,
        tmpRoot,
        engineForRunner: () => scriptedReviewEngine({ verdict: { state: "success", reason: "batch" } }),
        logger: () => undefined,
      });
      expect(records).toHaveLength(2);
      const jsonl = await readFile(join(outDir, "results.jsonl"), "utf8");
      expect(jsonl.trim().split("\n")).toHaveLength(2);
    } finally {
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("harness cannot reach a forge", async () => {
    const source = await readFile(new URL("../src/review_eval.ts", import.meta.url), "utf8");
    // No real forge client: fixture data replaces the forge.
    expect(source).not.toContain("createForge");
    expect(source).not.toContain("./forge.ts");
    expect(source).not.toContain("./api.ts");
    expect(source).not.toContain("./github_api.ts");
    // No direct network fetch in the harness (MCP rides the engine's localhost server).
    expect(source).not.toContain("fetch(");
    // Required contract and the MCP verdict store stay wired in code.
    expect(source).toContain("REVIEW_EVAL_CONTRACT");
    expect(source).toContain("required");
    expect(source).toContain("startReviewMcpServer");
    expect(source).toContain("ReviewVerdictStore");
    expect(source).toContain("buildPROpenedPrompt");
  });
});
