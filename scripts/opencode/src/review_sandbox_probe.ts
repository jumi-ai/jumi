#!/usr/bin/env bun
/**
 * Prove the review Landlock sandbox against the real wrapper on this image,
 * the way `codex_probe.ts` proves argv against the real Codex binary.
 *
 * Unit tests grade `review_sandbox.ts` against itself; this probe runs the
 * actual `review_sandbox.py` and requires the confinement to hold:
 *   - `--check` reports ABI >= `REVIEW_SANDBOX_MIN_ABI`;
 *   - a sandboxed shell cannot read the parent's `/proc/<pid>/environ`;
 *   - a sandboxed shell cannot signal the parent (`kill -0`);
 *   - a sandboxed shell cannot write outside the checkout;
 *   - a sandboxed shell can still write the scratch dir, run `git`, and run `node`.
 *
 * Non-goal, pinned open (see docs/review-sandbox.md): the verdict channel.
 * A token file under `<checkout>/.jumi-tmp` stays readable from inside the
 * single-domain sandbox, so this probe does not assert it is denied.
 *
 * Exit 0 when every case matches its expectation, 1 otherwise. Run in the
 * reviewer image job (needs the job-pod kernel, not just userspace).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_SANDBOX_MIN_ABI,
  reviewSandboxArgv,
  reviewSandboxRules,
  reviewSandboxWrapperPath,
} from "./review_sandbox.ts";

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly observed: string;
}

function run(argv: string[], cwd: string): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: String(proc.stdout ?? ""),
    stderr: String(proc.stderr ?? ""),
  };
}

export function judgeProbe(check: { exitCode: number | null; stdout: string; stderr: string }): CaseResult[] {
  const abi = /landlock-abi=(\d+)/.exec(check.stdout)?.[1];
  return [
    {
      name: "wrapper reports a Landlock ABI",
      ok: check.exitCode === 0 && abi !== undefined,
      observed: (check.stdout || check.stderr).trim().split("\n").pop() ?? "<empty>",
    },
    {
      name: `Landlock ABI meets the minimum (${REVIEW_SANDBOX_MIN_ABI})`,
      ok: check.exitCode === 0 && abi !== undefined && Number.parseInt(abi, 10) >= REVIEW_SANDBOX_MIN_ABI,
      observed: abi === undefined ? "<no abi>" : `abi=${abi}`,
    },
  ];
}

const wrapper = reviewSandboxWrapperPath();
const checkCases = judgeProbe(run([wrapper, "--check"], tmpdir()));
for (const c of checkCases) console.log(`${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.observed}`);

const dir = await mkdtemp(join(tmpdir(), "review-sandbox-probe-"));
try {
  const scratch = join(dir, "scratch");
  await mkdir(scratch, { recursive: true });
  // The git case needs a repo to inspect: init it unsandboxed so the
  // sandboxed `git rev-parse` / `git status` below grade the wrapper's
  // gitdir allow-list, not a missing repo.
  run(["git", "init", "-q", dir], tmpdir());
  const rules = reviewSandboxRules({ workdir: dir, scratchDir: scratch });
  const shell = (script: string) => run(reviewSandboxArgv(rules, ["sh", "-c", script]), dir);
  const parentPid = process.pid;
  const cases: CaseResult[] = [
    {
      name: "sandboxed shell cannot read the parent environ",
      ...(() => {
        const r = shell(`head -c 32 /proc/${parentPid}/environ 2>&1`);
        const denied = r.exitCode !== 0 || /Permission denied|No such file/i.test(r.stdout);
        return { ok: denied, observed: r.stdout.trim().split("\n").pop() ?? "<empty>" };
      })(),
    },
    {
      name: "sandboxed shell cannot signal the parent",
      ...(() => {
        const r = shell(`kill -0 ${parentPid} 2>&1; echo rc=$?`);
        return { ok: /Operation not permitted/.test(r.stdout), observed: r.stdout.trim().split("\n").join(" | ") };
      })(),
    },
    {
      name: "sandboxed shell cannot write outside the checkout",
      ...(() => {
        const r = shell("echo evil > /tmp/review-sandbox-probe-evil 2>&1; echo rc=$?");
        const combined = [r.stdout, r.stderr].join("\n");
        return { ok: /Permission denied/.test(combined), observed: combined.trim().split("\n").join(" | ") };
      })(),
    },
    {
      name: "sandboxed shell can write the scratch dir",
      ...(() => {
        const r = shell(`echo hi > ${scratch}/ok && cat ${scratch}/ok`);
        return { ok: r.exitCode === 0 && r.stdout.trim() === "hi", observed: `exit=${r.exitCode}` };
      })(),
    },
    {
      name: "sandboxed shell can run git in the checkout",
      ...(() => {
        const r = shell(`git rev-parse --show-toplevel && git status --porcelain`);
        const combined = [r.stdout, r.stderr].join("\n");
        return { ok: r.exitCode === 0, observed: `exit=${r.exitCode} ${combined.trim().split("\n").join(" | ")}` };
      })(),
    },
    {
      name: "sandboxed shell can run node",
      ...(() => {
        const r = shell(`node -e 'console.log("probe-ok")'`);
        return { ok: r.exitCode === 0 && r.stdout.trim() === "probe-ok", observed: `exit=${r.exitCode}` };
      })(),
    },
  ];
  for (const c of cases) console.log(`${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.observed}`);
  const all = [...checkCases, ...cases];
  if (all.some((c) => !c.ok)) {
    console.error("review sandbox probe failed");
    process.exit(1);
  }
  console.log("review sandbox probe passed");
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await rm("/tmp/review-sandbox-probe-evil", { force: true }).catch(() => undefined);
}
