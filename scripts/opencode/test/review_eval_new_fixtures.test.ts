import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, EngineRunOptions } from "../src/engine.ts";
import {
  listReviewEvalFixtures,
  loadReviewEvalFixture,
  REVIEW_EVAL_CONTRACT,
  runReviewEvalCase,
} from "../src/review_eval.ts";
import { probeReviewMcpServer } from "../src/review_mcp.ts";

const RUNNER = { name: "fake", type: "opencode", model: "fake/model" } as const;

type Finding = { path?: string; line?: number; severity: string; title: string; body: string };

function scriptedReviewEngine(script: {
  findings?: Finding[];
  verdict?: { state: "success" | "failure"; reason?: string };
}): Engine {
  return async (runOpts: EngineRunOptions) => {
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

async function withRoots(fn: (roots: { workdirRoot: string; homeRoot: string }) => Promise<void>) {
  const workdirRoot = await mkdtemp(join(tmpdir(), "review-eval-new-work-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "review-eval-new-home-"));
  try {
    await fn({ workdirRoot, homeRoot });
  } finally {
    await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const VAGUE: Finding = {
  path: "finding.js",
  line: 1,
  severity: "bug",
  title: "Check this",
  body: "Please check this boundary.",
};

const NEW_FIXTURES: Array<{
  name: string;
  file: string;
  line: number;
  good: Finding;
  offAnchor: Finding;
  vaguePath: string;
  vagueLine: number;
}> = [
  {
    name: "path-traversal",
    file: "download.js",
    line: 3,
    good: {
      path: "download.js",
      line: 3,
      severity: "bug",
      title: 'Path traversal: filePath("/srv/files", "../secret") escapes base',
      body:
        'filePath("/srv/files", "../secret") resolves to /srv/secret outside /srv/files. ' +
        "Reject .. segments with resolve. " +
        'Proof: filePath("/srv/files", "../secret") is outside the base on this head.',
    },
    offAnchor: {
      path: "download.js",
      line: 1,
      severity: "bug",
      title: 'Path traversal: filePath("/srv/files", "../secret") escapes base',
      body:
        'filePath("/srv/files", "../secret") resolves to /srv/secret outside /srv/files. ' +
        "Proof: outside the base on this head.",
    },
    vaguePath: "download.js",
    vagueLine: 3,
  },
  {
    name: "missing-await",
    file: "notify.js",
    line: 2,
    good: {
      path: "notify.js",
      line: 2,
      severity: "bug",
      title: "Missing await: send(user) rejection is unhandled",
      body:
        "notifyAll does not await send(user); a rejection from send(user) is unhandled and " +
        "the caller never sees it. Use await Promise.all. " +
        "Proof: send(user) rejects and notifyAll resolves; unhandled rejection on this head.",
    },
    offAnchor: {
      path: "notify.js",
      line: 1,
      severity: "bug",
      title: "Missing await: send(user) rejection is unhandled",
      body: "send(user) rejects while notifyAll resolves; unhandled rejection. Proof: unhandled on this head.",
    },
    vaguePath: "notify.js",
    vagueLine: 2,
  },
  {
    name: "money-rounding",
    file: "pricing.js",
    line: 4,
    good: {
      path: "pricing.js",
      line: 4,
      severity: "bug",
      title: "Float total: 0.1 + 0.2 is 0.30000000000000004",
      body:
        "cartTotal([{price: 0.1}, {price: 0.2}]) returns 0.30000000000000004, want 0.3. " +
        "Use integer cents. Proof: 0.1 + 0.2 gives 0.30000000000000004 on this head.",
    },
    offAnchor: {
      path: "pricing.js",
      line: 2,
      severity: "bug",
      title: "Float total: 0.1 + 0.2 is 0.30000000000000004",
      body: "0.1 + 0.2 gives 0.30000000000000004, want 0.3. Proof: 0.30000000000000004 on this head.",
    },
    vaguePath: "pricing.js",
    vagueLine: 4,
  },
];

describe("review eval new fixtures", () => {
  test("listing picks up the new review fixtures", async () => {
    const names = await listReviewEvalFixtures();
    for (const fixture of NEW_FIXTURES) {
      expect(names).toContain(fixture.name);
    }
    expect(names).toContain("adult-boundary");
  });

  for (const fixture of NEW_FIXTURES) {
    test(`${fixture.name}: scripted blocking finding passes defective, clean passes repaired`, async () => {
      const loaded = await loadReviewEvalFixture(fixture.name);
      expect(loaded.name).toBe(fixture.name);
      await withRoots(async (roots) => {
        const defective = await runReviewEvalCase({
          fixture: loaded,
          half: "defective",
          runner: { ...RUNNER },
          trial: 1,
          ...roots,
          engine: scriptedReviewEngine({
            findings: [fixture.good],
            verdict: { state: "failure", reason: "blocking defect" },
          }),
          logger: () => undefined,
        });
        expect(defective.verdict).toBe("pass");
        expect(defective.failedAssertions).toEqual([]);
        expect(defective.contract).toBe(REVIEW_EVAL_CONTRACT);

        const repaired = await runReviewEvalCase({
          fixture: loaded,
          half: "repaired",
          runner: { ...RUNNER },
          trial: 1,
          ...roots,
          engine: scriptedReviewEngine({ verdict: { state: "success", reason: "clean" } }),
          logger: () => undefined,
        });
        expect(repaired.verdict).toBe("pass");
        expect(repaired.failedAssertions).toEqual([]);
      });
    });

    test(`${fixture.name}: missed defect fails the defective half`, async () => {
      const loaded = await loadReviewEvalFixture(fixture.name);
      await withRoots(async (roots) => {
        const record = await runReviewEvalCase({
          fixture: loaded,
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

    test(`${fixture.name}: vague finding text fails the defective half`, async () => {
      const loaded = await loadReviewEvalFixture(fixture.name);
      await withRoots(async (roots) => {
        const record = await runReviewEvalCase({
          fixture: loaded,
          half: "defective",
          runner: { ...RUNNER },
          trial: 1,
          ...roots,
          engine: scriptedReviewEngine({
            findings: [{ ...VAGUE, path: fixture.vaguePath, line: fixture.vagueLine }],
            verdict: { state: "failure", reason: "blocking" },
          }),
          logger: () => undefined,
        });
        expect(record.verdict).toBe("fail");
        expect(record.failedAssertions).toContain("defect-text");
      });
    });

    test(`${fixture.name}: blocking finding outside every anchor fails`, async () => {
      const loaded = await loadReviewEvalFixture(fixture.name);
      await withRoots(async (roots) => {
        const record = await runReviewEvalCase({
          fixture: loaded,
          half: "defective",
          runner: { ...RUNNER },
          trial: 1,
          ...roots,
          engine: scriptedReviewEngine({
            findings: [fixture.offAnchor],
            verdict: { state: "failure", reason: "blocking" },
          }),
          logger: () => undefined,
        });
        expect(record.verdict).toBe("fail");
        expect(record.failedAssertions).toContain("defect-anchor");
      });
    });

    test(`${fixture.name}: blocking finding on the repaired half fails`, async () => {
      const loaded = await loadReviewEvalFixture(fixture.name);
      await withRoots(async (roots) => {
        const record = await runReviewEvalCase({
          fixture: loaded,
          half: "repaired",
          runner: { ...RUNNER },
          trial: 1,
          ...roots,
          engine: scriptedReviewEngine({
            findings: [{ ...fixture.good }],
            verdict: { state: "failure", reason: "blocking" },
          }),
          logger: () => undefined,
        });
        expect(record.verdict).toBe("fail");
        expect(record.failedAssertions).toContain("repaired-blocking");
      });
    });
  }

  test("new fixtures never leak the eval case id to the model", async () => {
    for (const fixture of NEW_FIXTURES) {
      const loaded = await loadReviewEvalFixture(fixture.name);
      const prText = `${loaded.title}\n${loaded.body}`;
      expect(prText).not.toContain(fixture.name);
      const reviewMd = await readFile(join(loaded.repoDir, "REVIEW.md"), "utf8");
      expect(reviewMd).not.toContain(fixture.name);
      const defectiveFile = await readFile(join(loaded.defectiveDir, fixture.file), "utf8");
      expect(defectiveFile).not.toContain(fixture.name);
      const repairedFile = await readFile(join(loaded.repairedDir, fixture.file), "utf8");
      expect(repairedFile).not.toContain(fixture.name);
      // The grader must have at least one anchor per new fixture.
      expect(loaded.anchors.length).toBeGreaterThan(0);
    }
  });
});
