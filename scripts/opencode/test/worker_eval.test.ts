import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../src/engine.ts";
import { QUOTA_STUCK_TEXT } from "../src/quota.ts";
import {
  EVAL_INERT_HOST,
  loadWorkerEvalFixture,
  makeEvalGitRunner,
  runWorkerEval,
  runWorkerEvalCase,
} from "../src/worker_eval.ts";

const RUNNER = { name: "fake", type: "opencode", model: "fake/model" } as const;

function scriptedEngine(opts: {
  fixSum?: boolean;
  markdown?: string;
  remaining?: string[];
  leak?: boolean;
  dirty?: boolean;
  captureTask?: { text?: string };
}): Engine {
  return async (runOpts) => {
    if (opts.captureTask) {
      try {
        opts.captureTask.text = await readFile(join(runOpts.workdir, "JUMI_TASK.md"), "utf8");
      } catch {
        opts.captureTask.text = "";
      }
    }
    if (opts.fixSum) {
      await writeFile(join(runOpts.workdir, "sum.js"), `export function sum(a, b) {\n  return a + b;\n}\n`);
    } else if (opts.dirty) {
      await writeFile(join(runOpts.workdir, "notes.txt"), "agent was here\n");
    }
    if (opts.leak) {
      await writeFile(join(runOpts.workdir, "JUMI_LEAK.md"), "leak\n");
    }
    if (opts.markdown !== undefined) {
      const url = runOpts.workerMcp?.url;
      const token = runOpts.workerMcp?.token;
      if (!url || !token) throw new Error("no worker mcp");
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "set_pr_body", arguments: { markdown: opts.markdown, remaining: opts.remaining ?? [] } },
        }),
      });
      const payload = (await res.json()) as { result?: { isError?: boolean } };
      if (payload.result?.isError) throw new Error("set_pr_body rejected");
    }
    return { status: "ok" };
  };
}

async function withRoots(fn: (roots: { workdirRoot: string; homeRoot: string; tmpRoot: string }) => Promise<void>) {
  const workdirRoot = await mkdtemp(join(tmpdir(), "eval-test-work-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "eval-test-home-"));
  const tmpRoot = await mkdtemp(join(tmpdir(), "eval-test-tmp-"));
  try {
    await fn({ workdirRoot, homeRoot, tmpRoot });
  } finally {
    await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("worker eval", () => {
  test("passing run publishes closing keyword with empty remaining and passes hidden check", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withRoots(async (roots) => {
      const capture: { text?: string } = {};
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedEngine({
          fixSum: true,
          markdown: "Adds sum helper.\n\nFixes #1",
          remaining: [],
          captureTask: capture,
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("pass");
      expect(record.failedAssertions).toEqual([]);
      expect(record.jobStatus).toBe("pr");
      expect(record.closingKeyword).toBe("fixes");
      expect(record.remaining).toEqual([]);
      expect(record.hiddenCheck).toBe("pass");
      expect(record.noSentinels).toBe(true);
      expect(record.pushedSha).toBeTruthy();
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      // Isolation: the eval case id and hidden grader never reach the model.
      expect(capture.text ?? "").not.toContain("done-while-ci-pending");
      expect(capture.text ?? "").not.toContain("hidden check");
      expect(capture.text ?? "").toContain("Add sum helper");
    });
  });

  test("wrong closing keyword fails", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedEngine({
          fixSum: true,
          markdown: "Partial work.",
          remaining: ["one more case"],
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("closing-keyword");
      expect(record.closingKeyword).toBe("refs");
    });
  });

  test("non-empty remaining fails", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedEngine({
          fixSum: true,
          markdown: "Adds sum helper.",
          remaining: ["backfill test"],
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("remaining-empty");
      expect(record.remaining.length).toBeGreaterThan(0);
    });
  });

  test("failing hidden check fails", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        // Correct PR text but the code change is missing: hidden check fails.
        // The tree is still dirty (unrelated file) so a PR opens.
        engine: scriptedEngine({ fixSum: false, dirty: true, markdown: "Adds sum helper.\n\nFixes #1", remaining: [] }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("hidden-check");
      expect(record.closingKeyword).toBe("fixes");
    });
  });

  test("committed JUMI_*.md fails", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedEngine({
          fixSum: true,
          markdown: "Adds sum helper.\n\nFixes #1",
          remaining: [],
          leak: true,
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("no-sentinels");
      expect(record.noSentinels).toBe(false);
    });
  });

  test("quota and auth failures are inconclusive, never fail", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withRoots(async (roots) => {
      const quotaRecord = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: async () => ({ status: "stuck", message: QUOTA_STUCK_TEXT }),
        logger: () => undefined,
      });
      expect(quotaRecord.verdict).toBe("inconclusive");
      expect(quotaRecord.failedAssertions).toEqual([]);

      const authRecord = await runWorkerEvalCase({
        fixture,
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

  test("harness writes one JSONL record per fixture x runner x trial", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    const workdirRoot = await mkdtemp(join(tmpdir(), "eval-batch-work-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "eval-batch-home-"));
    const tmpRoot = await mkdtemp(join(tmpdir(), "eval-batch-tmp-"));
    const outDir = await mkdtemp(join(tmpdir(), "eval-batch-out-"));
    try {
      const records = await runWorkerEval({
        fixtures: [fixture],
        runners: [{ ...RUNNER }, { name: "fake-b", type: "opencode", model: "fake/model-b" }],
        trials: 2,
        outDir,
        workdirRoot,
        homeRoot,
        tmpRoot,
        engineForRunner: () =>
          scriptedEngine({ fixSum: true, markdown: "Adds sum helper.\n\nFixes #1", remaining: [] }),
        logger: () => undefined,
      });
      expect(records).toHaveLength(4);
      const jsonl = await readFile(join(outDir, "results.jsonl"), "utf8");
      expect(jsonl.trim().split("\n")).toHaveLength(4);
      for (const record of records) {
        expect(record.verdict).toBe("pass");
        expect(record.failedAssertions).toEqual([]);
      }
    } finally {
      await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("harness cannot reach a forge write", async () => {
    const source = await readFile(new URL("../src/worker_eval.ts", import.meta.url), "utf8");
    // No real forge client: the eval forge is the in-memory fake.
    expect(source).not.toContain("createForge");
    expect(source).not.toContain("./forge.ts");
    expect(source).not.toContain("./api.ts");
    expect(source).not.toContain("./github_api.ts");
    // No direct network fetch in the harness (MCP calls ride the engine's localhost server).
    expect(source).not.toContain("fetch(");
    // Inert host enforcement lives in code, not in log reading.
    expect(source).toContain(EVAL_INERT_HOST);
    expect(source).toContain("refuses network host");

    // The git runner maps only the inert host and refuses anything else.
    const runner = makeEvalGitRunner("/tmp/does-not-exist", `https://${EVAL_INERT_HOST}/o/r.git`);
    await expect(runner(["fetch", "origin", "https://example.com/o/r.git"], { cwd: "/", env: {} })).rejects.toThrow(
      /refuses network host/
    );
  });
});
