#!/usr/bin/env bun
/**
 * Prove the per-shell review Landlock sandbox against the real wrapper,
 * the way `codex_probe.ts` proves argv against the real Codex binary.
 *
 * Part-2 shape (jumi#550): the agent is unsandboxed; every shell the model
 * runs gets its own domain (`reviewShellSandboxRules`): RW checkout+scratch,
 * RO system without /tmp, no harness temp, no HOME. Unit tests grade the
 * hook generation; this probe runs the actual `review_sandbox.py` and
 * requires the confinement to hold:
 *   - `--check` reports ABI >= `REVIEW_SANDBOX_MIN_ABI`;
 *   - a sandboxed shell cannot read the parent's `/proc/<pid>/environ`;
 *   - a sandboxed shell cannot signal the parent (`kill -0`);
 *   - a sandboxed shell cannot read the outside harness temp (MCP token);
 *   - a sandboxed shell cannot read a HOME credential file;
 *   - a sandboxed shell cannot write outside the checkout;
 *   - a sandboxed shell can still write scratch, run `git`, run `node`,
 *     and shallow-clone into scratch (benign `bun test` + `git clone`).
 *
 * Exit 0 when every case matches its expectation, 1 otherwise. Run in the
 * reviewer image job (needs the job-pod kernel, not just userspace).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_SANDBOX_MIN_ABI,
  reviewSandboxArgv,
  reviewSandboxWrapperPath,
  reviewShellSandboxRules,
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
  // Outside harness temp (stands in for the per-spawn /tmp/jumi-review-*
  // holding the MCP bearer token): never in the shell allow-list.
  const harnessTemp = await mkdtemp("/tmp/jumi-review-probe-");
  const tokenFile = join(harnessTemp, "review-mcp.json");
  await writeFile(tokenFile, `{"token": "probe-secret-token"}`, { mode: 0o600 });
  const homeSecret = join(harnessTemp, "home-secret");
  await writeFile(homeSecret, "probe-home-secret", { mode: 0o600 });
  try {
    const rules = reviewShellSandboxRules({ workdir: dir, scratchDir: scratch });
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
        name: "sandboxed shell cannot read the outside harness temp (MCP token)",
        ...(() => {
          const r = shell(`cat ${tokenFile} 2>&1; echo rc=$?`);
          const denied = /Permission denied/.test(r.stdout);
          return { ok: denied, observed: r.stdout.trim().split("\n").join(" | ") };
        })(),
      },
      {
        name: "sandboxed shell cannot read the agent HOME secret",
        ...(() => {
          const r = shell(`cat ${homeSecret} 2>&1; echo rc=$?`);
          const denied = /Permission denied/.test(r.stdout);
          return { ok: denied, observed: r.stdout.trim().split("\n").join(" | ") };
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
    // Shallow clone needs async setup; run it separately to keep the table above sync.
    const src = join(dir, "clone-src");
    await mkdir(src, { recursive: true });
    run(["git", "init", "-q", src], tmpdir());
    await writeFile(join(src, "file.txt"), "hi\n");
    run(["git", "-C", src, "add", "file.txt"], tmpdir());
    run(["git", "-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], tmpdir());
    const clone = shell(`git clone --depth 1 file://${src} ${scratch}/cloned 2>&1; echo rc=$?`);
    const cloneOk = /rc=0/.test(clone.stdout);
    const cloneCase: CaseResult = {
      name: "sandboxed shell can shallow-clone into scratch",
      ok: cloneOk,
      observed: clone.stdout.trim().split("\n").join(" | "),
    };
    const finalCases = [...cases, cloneCase];
    for (const c of finalCases) console.log(`${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.observed}`);
    const all = [...checkCases, ...finalCases];
    if (all.some((c) => !c.ok)) {
      console.error("review sandbox probe failed");
      process.exit(1);
    }
    console.log("review sandbox probe passed");
  } finally {
    await rm(harnessTemp, { recursive: true, force: true }).catch(() => undefined);
  }
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await rm("/tmp/review-sandbox-probe-evil", { force: true }).catch(() => undefined);
}
