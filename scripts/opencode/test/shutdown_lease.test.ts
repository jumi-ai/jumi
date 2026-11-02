import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "../src/claim.ts";

async function readStatus(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

async function waitForLine(path: string, needle: string, proc: Bun.Subprocess, stderr: () => string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await readStatus(path);
    if (text.includes("JOB_FAILED")) {
      throw new Error(`${text}\n${stderr()}`);
    }
    const line = text.split("\n").find((item) => item.includes(needle));
    if (line) return line;
    if (proc.exitCode != null) throw new Error(`harness exited ${proc.exitCode}\n${text}\n${stderr()}`);
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${needle}\n${await readStatus(path)}\n${stderr()}`);
}

describe("shutdown signal holds the lease until the child has stopped", () => {
  test.each(["worker", "engine"])(
    "%s SIGTERM holds the lease until the child stops, then releases",
    async (role) => {
      const dir = await mkdtemp(join(tmpdir(), "jumi-shutdown-"));
      const statusPath = join(dir, "status");
      let stderrText = "";
      const proc = Bun.spawn(["bun", "test/shutdown_signal_harness.ts", role, statusPath], {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      void (async () => {
        stderrText = await new Response(proc.stderr).text();
      })();
      let childPid = 0;
      try {
        const ready = await waitForLine(statusPath, "READY ", proc, () => stderrText);
        childPid = Number(ready.slice("READY ".length));
        expect(isPidAlive(childPid)).toBe(true);
        proc.kill("SIGTERM");
        // Ordered shutdown: abort first, but the lease stays held while the
        // stubborn child is still running. Give the abort a beat, then prove
        // the lease was not freed early.
        await Bun.sleep(500);
        expect(isPidAlive(childPid)).toBe(true);
        const mid = await readStatus(statusPath);
        expect(mid).toContain("received SIGTERM, shutting down");
        expect(mid).not.toContain("FREED-");
        expect(mid).not.toContain("JOB_RETURNED");
        // Stopping the child lets the aborted tick finish: wait, then release.
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // already gone
        }
        const freed = await waitForLine(statusPath, "FREED-", proc, () => stderrText);
        expect(freed).toContain("attempt=0");
        expect(freed).toContain("sibling=sibling");
        expect(freed).toContain("comments=0");
        expect(freed).toContain("failures=0");
        await waitForLine(statusPath, "JOB_RETURNED", proc, () => stderrText);
        expect(isPidAlive(childPid)).toBe(false);
      } finally {
        proc.kill("SIGKILL");
        if (childPid > 0) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        await proc.exited.catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000
  );
});
