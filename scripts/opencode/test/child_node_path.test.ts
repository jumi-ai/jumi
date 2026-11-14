import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyEnv } from "../src/agy.ts";
import { buildClaudeEnv } from "../src/claude.ts";
import { buildCodexEnv } from "../src/codex.ts";
import { buildEnv } from "../src/git.ts";

const SAVED_PATH = process.env.PATH;

afterEach(() => {
  if (SAVED_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = SAVED_PATH;
});

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveNodeInPath(pathValue: string | undefined): Promise<string | undefined> {
  if (!pathValue) return undefined;
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "node");
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

describe("child env keeps the real Node on PATH", () => {
  test("opencode, claude, codex, and agy resolve node to the parent path, never the Bun shim", async () => {
    const stubDir = await mkdtemp(join(tmpdir(), "jumi-real-node-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-node-work-"));
    const tempRoot = join(workdir, ".jumi-tmp");
    const originalPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
    try {
      await writeFile(join(stubDir, "node"), "#!/bin/sh\necho v24.22.3\n");
      await chmod(join(stubDir, "node"), 0o755);
      process.env.PATH = `${stubDir}:${originalPath}`;

      const parentResolved = await resolveNodeInPath(process.env.PATH);
      expect(parentResolved).toBe(join(stubDir, "node"));

      const runners: Record<string, Record<string, string> | undefined> = {
        opencode: buildEnv(
          { model: "m", workdir, home: workdir, sanitizeEnv: true },
          tempRoot,
          join(tempRoot, "opencode-session.db")
        ),
        claude: buildClaudeEnv({ model: "m", workdir, home: workdir, sanitizeEnv: true }, tempRoot),
        codex: buildCodexEnv({ model: "m", workdir, home: workdir, sanitizeEnv: true }, tempRoot),
        agy: agyEnv({ model: "m", workdir, home: workdir, sanitizeEnv: true }, tempRoot),
      };

      for (const [name, env] of Object.entries(runners)) {
        expect(env).toBeDefined();
        const childPath = env?.PATH ?? "";
        expect(childPath.split(":")[0]).toBe(stubDir);
        expect(childPath).toContain(stubDir);
        const resolved = await resolveNodeInPath(childPath);
        expect(resolved).toBe(parentResolved);
        expect(resolved).toBe(join(stubDir, "node"));
        expect(resolved).not.toContain("/tmp/bun-node");
        expect(resolved).not.toContain("bun-node");
        expect(name).toBeDefined();
      }
    } finally {
      await rm(stubDir, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
