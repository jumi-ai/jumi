import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_SANDBOX_WRAPPER_ENV } from "../../src/review_sandbox.ts";

export interface FakeEnv {
  workdir: string;
  home: string;
  argsLog: string;
}

/** Silent Landlock stub: answers `--check` like the real wrapper, then execs whatever follows `--`. */
export const SANDBOX_STUB = `#!/bin/sh
if [ "$1" = "--check" ]; then echo "landlock-abi=7"; exit 0; fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$1" = "--" ] && shift
exec "$@"
`;

/** Fake binary template: appends one argv line per call to `$ARGS_LOG`, then runs `body`. */
export function fakeBin(name: string, body: string): string {
  return `#!/bin/sh
printf '${name} %s\\n' "$*" >> "$ARGS_LOG"
${body}
`;
}

function saveEnv(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Fake `$PATH` binaries plus the sandbox-wrapper stub. Saves and restores
 * `PATH` and the wrapper env var even when `run` throws, so call sites can
 * drop their `originalPath`/`originalSandboxWrapper` save/restore blocks.
 */
export async function withFakeBins(
  bins: Record<string, string>,
  run: (env: FakeEnv) => Promise<void>,
  opts: { prefix?: string } = {}
): Promise<void> {
  const prefix = opts.prefix ?? "fake-bins-";
  const saved = saveEnv(["PATH", REVIEW_SANDBOX_WRAPPER_ENV]);
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const workdir = await mkdtemp(join(tmpdir(), `${prefix}work-`));
  const home = await mkdtemp(join(tmpdir(), `${prefix}home-`));
  try {
    for (const [name, script] of Object.entries(bins)) {
      const bin = join(dir, name);
      await writeFile(bin, script);
      await chmod(bin, 0o755);
    }
    const stub = join(dir, "jumi-sandbox-stub");
    await writeFile(stub, SANDBOX_STUB);
    await chmod(stub, 0o755);
    process.env[REVIEW_SANDBOX_WRAPPER_ENV] = stub;
    process.env.PATH = `${dir}:${saved.get("PATH") ?? ""}`;
    await run({ workdir, home, argsLog: join(dir, "args.log") });
  } finally {
    restoreEnv(saved);
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

/** Fake `claude` binary on `PATH` with a throwaway workdir; restores `PATH` even on throw. */
export async function withFakeClaude(
  script: string,
  run: (workdir: string) => Promise<void>,
  opts: { prefix?: string } = {}
): Promise<void> {
  const prefix = opts.prefix ?? "fake-claude-";
  const savedPath = process.env.PATH;
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const workdir = await realpath(await mkdtemp(join(tmpdir(), `${prefix}work-`)));
  try {
    const bin = join(dir, "claude");
    await writeFile(bin, script);
    await chmod(bin, 0o755);
    process.env.PATH = `${dir}:${savedPath ?? ""}`;
    await run(workdir);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}
