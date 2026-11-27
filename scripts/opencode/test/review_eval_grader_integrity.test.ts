import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, EngineRunOptions } from "../src/engine.ts";
import { listReviewEvalFixtures, loadReviewEvalFixture, runReviewEvalCase } from "../src/review_eval.ts";
import { probeReviewMcpServer } from "../src/review_mcp.ts";

const RUNNER = { name: "fake", type: "opencode", model: "fake/model" } as const;
const HALVES = ["defective", "repaired"] as const;

type CapturedModelInputs = {
  reviewLabel?: string;
  task?: string;
  logSubjects?: string[];
  branches?: string[];
  files?: string[];
};

async function spawnText(argv: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`spawn ${argv.join(" ")} failed`);
  return out;
}

async function listWorkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full.slice(root.length + 1));
    }
  };
  await walk(root);
  return out.sort();
}

function capturingEngine(
  capture: CapturedModelInputs,
  script: {
    findings?: Array<{ path?: string; line?: number; severity: string; title: string; body: string }>;
    verdict?: { state: "success" | "failure"; reason?: string };
    sabotage?: (workdir: string) => Promise<void>;
  }
): Engine {
  return async (runOpts: EngineRunOptions) => {
    capture.reviewLabel = runOpts.reviewLabel;
    try {
      capture.task = await readFile(join(runOpts.workdir, "JUMI_TASK.md"), "utf8");
    } catch {
      capture.task = "";
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
    // Model-visible git state is read after the verdict is recorded, exactly
    // like the harness reads it after the engine returns.
    capture.logSubjects = (await spawnText(["git", "log", "--format=%s"], runOpts.workdir)).split("\n");
    capture.branches = (await spawnText(["git", "branch", "--list", "--format=%(refname:short)"], runOpts.workdir))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    capture.files = await listWorkFiles(runOpts.workdir);
    if (script.sabotage) await script.sabotage(runOpts.workdir);
    return { status: "ok" };
  };
}

async function withRoots(fn: (roots: { workdirRoot: string; homeRoot: string }) => Promise<void>) {
  const workdirRoot = await mkdtemp(join(tmpdir(), "review-eval-integrity-work-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "review-eval-integrity-home-"));
  try {
    await fn({ workdirRoot, homeRoot });
  } finally {
    await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("review eval grader integrity", () => {
  test("half name is absent from every model-visible input for both halves of every fixture", async () => {
    const names = await listReviewEvalFixtures();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const fixture = await loadReviewEvalFixture(name);
      for (const half of HALVES) {
        const capture: CapturedModelInputs = {};
        await withRoots(async (roots) => {
          const anchor = fixture.anchors[0];
          await runReviewEvalCase({
            fixture,
            half,
            runner: { ...RUNNER },
            trial: 1,
            ...roots,
            engine: capturingEngine(capture, {
              findings:
                half === "defective" && anchor
                  ? [
                      {
                        path: anchor.path,
                        line: anchor.start,
                        severity: "bug",
                        title: "placeholder",
                        body: fixture.mustContain.join(" "),
                      },
                    ]
                  : [],
              verdict: { state: half === "defective" ? "failure" : "success", reason: "integrity probe" },
            }),
            logger: () => undefined,
          });
        });
        const visible = [
          capture.reviewLabel ?? "",
          capture.task ?? "",
          ...(capture.logSubjects ?? []),
          ...(capture.branches ?? []),
          ...(capture.files ?? []),
        ];
        expect(visible.length).toBeGreaterThan(0);
        for (const text of visible) {
          const lower = text.toLowerCase();
          expect(lower).not.toContain("defective");
          expect(lower).not.toContain("repaired");
        }
      }
    }
  });

  test("unreadable HEAD grades inconclusive", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const record = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: capturingEngine(
          {},
          {
            findings: [
              {
                path: "eligibility.js",
                line: 2,
                severity: "bug",
                title: "Off-by-one: isAdult(18) is false",
                body: "isAdult(18) returns false, want true.",
              },
            ],
            verdict: { state: "failure", reason: "blocking" },
            sabotage: async (workdir) => {
              await writeFile(join(workdir, ".git", "HEAD"), "ref: refs/heads/does-not-exist\n", "utf8");
            },
          }
        ),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("inconclusive");
      expect(record.failedAssertions).toEqual([]);
      expect(record.inconclusiveReason ?? "").toMatch(/HEAD/i);
    });
  });

  test("unreadable status grades inconclusive", async () => {
    const fixture = await loadReviewEvalFixture("adult-boundary");
    await withRoots(async (roots) => {
      const record = await runReviewEvalCase({
        fixture,
        half: "defective",
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: capturingEngine(
          {},
          {
            findings: [
              {
                path: "eligibility.js",
                line: 2,
                severity: "bug",
                title: "Off-by-one: isAdult(18) is false",
                body: "isAdult(18) returns false, want true.",
              },
            ],
            verdict: { state: "failure", reason: "blocking" },
            sabotage: async (workdir) => {
              await writeFile(join(workdir, ".git", "index"), "garbage-not-an-index\n", "utf8");
            },
          }
        ),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("inconclusive");
      expect(record.failedAssertions).toEqual([]);
      expect(record.inconclusiveReason ?? "").toMatch(/status/i);
    });
  });

  test("fixture paraphrases pass and vague text fails for every fixture", async () => {
    const names = await listReviewEvalFixtures();
    for (const name of names) {
      const fixture = await loadReviewEvalFixture(name);
      expect(fixture.paraphrases.length).toBeGreaterThan(0);
      const anchor = fixture.anchors[0];
      expect(anchor).toBeTruthy();
      for (const paraphrase of fixture.paraphrases) {
        // Calibration: every declared paraphrase really names the concrete failure.
        const text = `${paraphrase.title}\n${paraphrase.body}`.toLowerCase();
        for (const token of fixture.mustContain) {
          expect(text).toContain(token.toLowerCase());
        }
        await withRoots(async (roots) => {
          const record = await runReviewEvalCase({
            fixture,
            half: "defective",
            runner: { ...RUNNER },
            trial: 1,
            ...roots,
            engine: capturingEngine(
              {},
              {
                findings: [
                  {
                    path: anchor.path,
                    line: anchor.start,
                    severity: "bug",
                    title: paraphrase.title,
                    body: paraphrase.body,
                  },
                ],
                verdict: { state: "failure", reason: "blocking" },
              }
            ),
            logger: () => undefined,
          });
          expect(record.verdict).toBe("pass");
        });
      }
      await withRoots(async (roots) => {
        const record = await runReviewEvalCase({
          fixture,
          half: "defective",
          runner: { ...RUNNER },
          trial: 1,
          ...roots,
          engine: capturingEngine(
            {},
            {
              findings: [
                {
                  path: anchor.path,
                  line: anchor.start,
                  severity: "bug",
                  title: "Check this",
                  body: "Please check this boundary.",
                },
              ],
              verdict: { state: "failure", reason: "blocking" },
            }
          ),
          logger: () => undefined,
        });
        expect(record.verdict).toBe("fail");
        expect(record.failedAssertions).toContain("defect-text");
      });
    }
  });
});
