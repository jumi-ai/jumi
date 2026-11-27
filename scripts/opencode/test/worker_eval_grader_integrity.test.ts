import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../src/engine.ts";
import {
  type LoadedWorkerEvalFixture,
  loadWorkerEvalFixture,
  minimalWorkerEvalEnv,
  runWorkerEvalCase,
  workerEvalClosingFailures,
} from "../src/worker_eval.ts";
import { runGit } from "../src/workspace.ts";

const RUNNER = { name: "fake", type: "opencode", model: "fake/model" } as const;

function scriptedWorkerEngine(opts: {
  writeFiles?: Record<string, string>;
  markdown?: string;
  remaining?: string[];
  copyReference?: string;
}): Engine {
  return async (runOpts) => {
    for (const [name, content] of Object.entries(opts.writeFiles ?? {})) {
      await writeFile(join(runOpts.workdir, name), content, "utf8");
    }
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

async function withWorkerRoots(
  fn: (roots: { workdirRoot: string; homeRoot: string; tmpRoot: string }) => Promise<void>
) {
  const workdirRoot = await mkdtemp(join(tmpdir(), "worker-eval-integrity-work-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "worker-eval-integrity-home-"));
  const tmpRoot = await mkdtemp(join(tmpdir(), "worker-eval-integrity-tmp-"));
  try {
    await fn({ workdirRoot, homeRoot, tmpRoot });
  } finally {
    await rm(workdirRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function makeTempWorkerFixture(opts: { name: string; hiddenCheck: string; repoFrom: string }): Promise<{
  baseDir: string;
  fixture: LoadedWorkerEvalFixture;
}> {
  const baseDir = await mkdtemp(join(tmpdir(), "worker-eval-integrity-fixture-"));
  const dir = join(baseDir, opts.name);
  await mkdir(dir, { recursive: true });
  await cp(opts.repoFrom, join(dir, "repo"), { recursive: true });
  await writeFile(
    join(dir, "fixture.json"),
    JSON.stringify({ name: opts.name, owner: "eval", repo: "demo", issueNumber: 99, defaultBranch: "main" }),
    "utf8"
  );
  await writeFile(
    join(dir, "issue.json"),
    JSON.stringify({ title: "Temp eval case", body: "A temporary offline case for grader checks." }),
    "utf8"
  );
  await writeFile(join(dir, "hidden_check.sh"), opts.hiddenCheck, "utf8");
  return { baseDir, fixture: await loadWorkerEvalFixture(opts.name, baseDir) };
}

describe("worker eval grader integrity", () => {
  test("a decoy jumi/issue-N-zzz branch does not change the graded commit", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    let decoySha: string | null = null;
    await withWorkerRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedWorkerEngine({
          writeFiles: { "sum.js": `export function sum(a, b) {\n  return a + b;\n}\n` },
          markdown: "Adds sum helper.\n\nFixes #1",
          remaining: [],
        }),
        afterPr: async ({ barePath, tmpDir }) => {
          const env = minimalWorkerEvalEnv(tmpDir);
          const base = await runGit(["rev-parse", fixture.defaultBranch], { cwd: barePath, env });
          await runGit(["branch", `jumi/issue-${fixture.issueNumber}-zzz`, base.trim()], {
            cwd: barePath,
            env,
          });
          decoySha = (
            await runGit(["rev-parse", `jumi/issue-${fixture.issueNumber}-zzz`], {
              cwd: barePath,
              env,
            })
          ).trim();
        },
        logger: () => undefined,
      });
      expect(decoySha).toBeTruthy();
      // The graded commit is the recorded PR head (the fix), not the decoy (the base).
      expect(record.pushedSha).toBeTruthy();
      expect(record.pushedSha).not.toBe(decoySha);
      expect(record.verdict).toBe("pass");
      expect(record.hiddenCheck).toBe("pass");
      expect(record.failedAssertions).toEqual([]);
    });
  });

  test("parent-env credential canary is unreadable to the hidden check and grading git", async () => {
    const home = await mkdtemp(join(tmpdir(), "worker-eval-integrity-canary-home-"));
    const evilGitconfig = join(home, "evil-gitconfig");
    await writeFile(evilGitconfig, "[alias]\n\trev-parse = !exit 42\n\tstatus = !exit 42\n", "utf8");
    const previousCanary = process.env.JUMI_EVAL_CANARY;
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousCount = process.env.GIT_CONFIG_COUNT;
    process.env.JUMI_EVAL_CANARY = "secret-canary-value";
    process.env.GIT_CONFIG_GLOBAL = evilGitconfig;
    process.env.GIT_CONFIG_COUNT = "1";
    // The env builder itself must drop the canary and pin the global config away.
    const built = minimalWorkerEvalEnv(home);
    expect(Object.keys(built).join(",")).not.toContain("CANARY");
    expect(built.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(built.GIT_CONFIG_COUNT).toBeUndefined();
    let baseDir = "";
    try {
      const made = await makeTempWorkerFixture({
        name: "temp-canary",
        repoFrom: (await loadWorkerEvalFixture("done-while-ci-pending")).repoDir,
        hiddenCheck: [
          "#!/usr/bin/env sh",
          "set -eu",
          'if [ -n "${JUMI_EVAL_CANARY:-}" ]; then echo "canary leaked to hidden check"; exit 1; fi',
          'dir="$1"',
          "node -e 'import(\"./sum.js\").then(m => { if (m.sum(2, 3) !== 5) process.exit(1); })'",
        ].join("\n"),
      });
      baseDir = made.baseDir;
      await withWorkerRoots(async (roots) => {
        const record = await runWorkerEvalCase({
          fixture: made.fixture,
          runner: { ...RUNNER },
          trial: 1,
          ...roots,
          engine: scriptedWorkerEngine({
            writeFiles: { "sum.js": `export function sum(a, b) {\n  return a + b;\n}\n` },
            markdown: "Adds sum helper.\n\nFixes #99",
            remaining: [],
          }),
          logger: () => undefined,
        });
        // Passes only if the hidden check never saw the canary and grading
        // git ignored the malicious parent GIT_CONFIG_GLOBAL.
        expect(record.verdict).toBe("pass");
        expect(record.failedAssertions).toEqual([]);
        expect(record.hiddenCheck).toBe("pass");
      });
    } finally {
      if (previousCanary === undefined) delete process.env.JUMI_EVAL_CANARY;
      else process.env.JUMI_EVAL_CANARY = previousCanary;
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousCount === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = previousCount;
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      if (baseDir) await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("a hidden check sleeping past the deadline is killed and grades fail", async () => {
    let baseDir = "";
    try {
      const made = await makeTempWorkerFixture({
        name: "temp-sleep",
        repoFrom: (await loadWorkerEvalFixture("done-while-ci-pending")).repoDir,
        hiddenCheck: '#!/usr/bin/env sh\nset -eu\ndir="$1"\nsleep 30\necho done\n',
      });
      baseDir = made.baseDir;
      await withWorkerRoots(async (roots) => {
        const started = Date.now();
        const record = await runWorkerEvalCase({
          fixture: made.fixture,
          runner: { ...RUNNER },
          trial: 1,
          ...roots,
          engine: scriptedWorkerEngine({
            writeFiles: { "notes.txt": "agent was here\n" },
            markdown: "Partial work.\n\nFixes #99",
            remaining: [],
          }),
          hiddenCheckTimeoutMs: 1500,
          logger: () => undefined,
        });
        const elapsed = Date.now() - started;
        expect(record.verdict).toBe("fail");
        expect(record.failedAssertions).toContain("hidden-check");
        expect(record.hiddenCheck).toBe("fail");
        expect(record.hiddenCheckOutput ?? "").toMatch(/timed out/i);
        // The deadline fired instead of waiting out the 30s sleep.
        expect(elapsed).toBeLessThan(25_000);
      });
    } finally {
      if (baseDir) await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("git infrastructure failure grades inconclusive, never fail", async () => {
    const fixture = await loadWorkerEvalFixture("done-while-ci-pending");
    await withWorkerRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedWorkerEngine({
          writeFiles: { "sum.js": `export function sum(a, b) {\n  return a + b;\n}\n` },
          markdown: "Adds sum helper.\n\nFixes #1",
          remaining: [],
        }),
        afterPr: async ({ barePath }) => {
          await rm(barePath, { recursive: true, force: true });
        },
        logger: () => undefined,
      });
      expect(record.verdict).toBe("inconclusive");
      expect(record.failedAssertions).toEqual([]);
      expect(record.inconclusiveReason ?? "").toMatch(/infrastructure/i);
    });
  });

  test("notes-deploy fails when the remaining-work field holds unrelated text", async () => {
    const fixture = await loadWorkerEvalFixture("notes-deploy");
    expect(fixture.expected?.remainingMustContain).toContain("deploy");
    expect(workerEvalClosingFailures("refs", ["refresh the dashboard copy"], fixture.expected)).toContain(
      "remaining-empty"
    );
    expect(
      workerEvalClosingFailures("refs", ["Deploy the updated notes service to production"], fixture.expected)
    ).toEqual([]);
    await withWorkerRoots(async (roots) => {
      const record = await runWorkerEvalCase({
        fixture,
        runner: { ...RUNNER },
        trial: 1,
        ...roots,
        engine: scriptedWorkerEngine({
          copyReference: join(fixture.dir, "reference"),
          markdown: "Fixes the wording.\n\nRefs #13",
          remaining: ["refresh the dashboard copy"],
        }),
        logger: () => undefined,
      });
      expect(record.verdict).toBe("fail");
      expect(record.failedAssertions).toContain("remaining-empty");
      expect(record.closingKeyword).toBe("refs");
      // The doable part still passes its hidden check: only the remaining-work fails.
      expect(record.hiddenCheck).toBe("pass");
    });
  });

  test("harness still cannot reach a forge", async () => {
    const source = await readFile(new URL("../src/worker_eval.ts", import.meta.url), "utf8");
    expect(source).not.toContain("createForge");
    expect(source).not.toContain("./forge.ts");
    expect(source).not.toContain("./api.ts");
    expect(source).not.toContain("./github_api.ts");
    expect(source).not.toContain("fetch(");
    expect(source).toContain("headSha");
  });
});
