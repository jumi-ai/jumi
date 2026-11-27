import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../src/engine.ts";
import {
  listWorkerEvalFixtures,
  loadWorkerEvalFixture,
  runWorkerEvalCase,
  workerEvalClosingFailures,
} from "../src/worker_eval.ts";

const RUNNER = { name: "fake", type: "opencode", model: "fake/model" } as const;

function scriptedWorkerEngine(opts: { copyReference?: string; markdown?: string; remaining?: string[] }): Engine {
  return async (runOpts) => {
    if (opts.copyReference) {
      await cp(opts.copyReference, runOpts.workdir, { recursive: true });
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

async function runHidden(hiddenCheck: string, dir: string): Promise<{ code: number; output: string }> {
  const scriptPath = join(dir, ".eval-hidden-test.sh");
  await writeFile(scriptPath, hiddenCheck, "utf8");
  const proc = Bun.spawn(["sh", scriptPath, dir], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await rm(scriptPath, { force: true }).catch(() => undefined);
  await rm(join(dir, ".hidden-verify.mjs"), { force: true }).catch(() => undefined);
  return { code, output: `${out}\n${err}`.trim() };
}

async function withWorkerRoots(
  fn: (roots: { workdirRoot: string; homeRoot: string; tmpRoot: string }) => Promise<void>
) {
  const workdirRoot = await mkdtemp(join(tmpdir(), "worker-eval-new-work-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "worker-eval-new-home-"));
  const tmpRoot = await mkdtemp(join(tmpdir(), "worker-eval-new-tmp-"));
  try {
    await fn({ workdirRoot, homeRoot, tmpRoot });
  } finally {
    await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const NEW_WORKER_FIXTURES = ["median-fix", "greet-shout", "notes-deploy"];

describe("worker eval new fixtures", () => {
  test("listing picks up the new worker fixtures", async () => {
    const names = await listWorkerEvalFixtures();
    for (const name of NEW_WORKER_FIXTURES) {
      expect(names).toContain(name);
    }
    expect(names).toContain("done-while-ci-pending");
  });

  test("default fixtures keep the fixes plus empty-remaining rule", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    expect(fixture.expected).toBeUndefined();
    expect(workerEvalClosingFailures("fixes", [], undefined)).toEqual([]);
    expect(workerEvalClosingFailures("refs", [], undefined)).toContain("closing-keyword");
    expect(workerEvalClosingFailures("fixes", ["leftover"], undefined)).toContain("remaining-empty");
  });

  for (const name of NEW_WORKER_FIXTURES) {
    test(`${name}: hidden check fails the base and passes the reference`, async () => {
      const fixture = await loadWorkerEvalFixture(name);
      expect(fixture.name).toBe(name);
      // The eval case id never reaches the model: not in the issue or repo.
      expect(`${fixture.title}\n${fixture.body}`).not.toContain(name);
      const dir = await mkdtemp(join(tmpdir(), `worker-eval-hidden-${name}-`));
      try {
        await cp(fixture.repoDir, dir, { recursive: true });
        const base = await runHidden(fixture.hiddenCheck, dir);
        expect(base.code).not.toBe(0);

        await cp(join(fixture.dir, "reference"), dir, { recursive: true });
        const fixed = await runHidden(fixture.hiddenCheck, dir);
        expect(fixed.code).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  test("median-fix: reference run passes with Fixes and empty remaining", async () => {
    const fixture = await loadWorkerEvalFixture("median-fix");
    expect(fixture.expected).toBeUndefined();
    await withWorkerRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedWorkerEngine({
          copyReference: join(fixture.dir, "reference"),
          markdown: "Fixes the median ordering.\n\nFixes #11",
          remaining: [],
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("pass");
      expect(record.failedAssertions).toEqual([]);
      expect(record.closingKeyword).toBe("fixes");
      expect(record.remaining).toEqual([]);
      expect(record.hiddenCheck).toBe("pass");
    });
  });

  test("greet-shout: reference run passes with Fixes and empty remaining", async () => {
    const fixture = await loadWorkerEvalFixture("greet-shout");
    expect(fixture.expected).toBeUndefined();
    await withWorkerRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedWorkerEngine({
          copyReference: join(fixture.dir, "reference"),
          markdown: "Adds the shout option.\n\nFixes #12",
          remaining: [],
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("pass");
      expect(record.failedAssertions).toEqual([]);
      expect(record.closingKeyword).toBe("fixes");
      expect(record.remaining).toEqual([]);
      expect(record.hiddenCheck).toBe("pass");
    });
  });

  test("notes-deploy: reference run passes with Refs and the deploy item remaining", async () => {
    const fixture = await loadWorkerEvalFixture("notes-deploy");
    expect(fixture.expected).toEqual({ closingKeyword: "refs", minRemaining: 1 });
    expect(
      workerEvalClosingFailures("refs", ["Deploy the updated notes service to production"], fixture.expected)
    ).toEqual([]);
    expect(workerEvalClosingFailures("fixes", [], fixture.expected)).toContain("closing-keyword");
    await withWorkerRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedWorkerEngine({
          copyReference: join(fixture.dir, "reference"),
          markdown: "Fixes the wording.\n\nRefs #13",
          remaining: ["Deploy the updated notes service to production"],
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("pass");
      expect(record.failedAssertions).toEqual([]);
      expect(record.closingKeyword).toBe("refs");
      expect(record.remaining).toEqual(["Deploy the updated notes service to production"]);
      expect(record.hiddenCheck).toBe("pass");
    });
  });

  test("notes-deploy: a Fixes closing keyword fails the grade", async () => {
    const fixture = await loadWorkerEvalFixture("notes-deploy");
    await withWorkerRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedWorkerEngine({
          copyReference: join(fixture.dir, "reference"),
          markdown: "Fixes the wording.\n\nFixes #13",
          remaining: [],
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("closing-keyword");
      expect(record.closingKeyword).toBe("fixes");
      // The doable part still passes its hidden check: only the keyword fails.
      expect(record.hiddenCheck).toBe("pass");
      expect(record.failedAssertions).not.toContain("hidden-check");
    });
  });

  test("new worker fixtures keep reference solutions outside the model-visible repo", async () => {
    for (const name of NEW_WORKER_FIXTURES) {
      const fixture = await loadWorkerEvalFixture(name);
      const repoFiles = await readFile(join(fixture.dir, "fixture.json"), "utf8");
      expect(repoFiles).toContain(name);
      const issueText = `${fixture.title}\n${fixture.body}`;
      expect(issueText).not.toContain(name);
    }
  });
});
