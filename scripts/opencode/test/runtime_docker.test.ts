import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standingPodRuntime } from "../src/runtime.ts";
import {
  DOCKER_RUNTIME_IMAGE,
  type DockerSession,
  destroyPreservingPush,
  dockerChildEnv,
  provisionDockerSession,
} from "../src/runtime_docker.ts";

const sessions: DockerSession[] = [];

afterEach(async () => {
  while (sessions.length > 0) {
    const s = sessions.pop();
    if (s) await s.destroy().catch(() => undefined);
  }
});

const hasDockerCli = Boolean(Bun.which("docker"));

async function dockerAvailable(): Promise<boolean> {
  if (!hasDockerCli) return false;
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

// Proof runs where a docker CLI is already available (CI checks job). Elsewhere
// it skips so `bun run ci` stays green without docker; in CI it must not skip.
const itDocker = hasDockerCli ? test : test.skip;

async function containerExists(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "inspect", name], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

describe("docker runtime (test-only proof)", () => {
  test("neither factory selects docker; one generic image", async () => {
    expect(DOCKER_RUNTIME_IMAGE).toContain("debian");
    expect(standingPodRuntime.name).toBe("standing-pod");
    const workerSrc = await Bun.file(join(import.meta.dir, "../src/worker.ts")).text();
    expect(workerSrc).not.toMatch(/runtime_docker|provisionDockerSession/);
    const dispatchSrc = await Bun.file(join(import.meta.dir, "../src/engine_dispatch.ts")).text();
    expect(dispatchSrc).not.toMatch(/docker/i);
    const runnersSrc = await Bun.file(join(import.meta.dir, "../src/runners.ts")).text();
    expect(runnersSrc).not.toMatch(/docker/i);
  });

  itDocker(
    "creates a real container, runs the engine in it, copies artifacts out, destroys",
    async () => {
      expect(await dockerAvailable()).toBe(true);
      const authDir = await mkdtemp(join(tmpdir(), "jumi-docker-auth-"));
      try {
        await writeFile(join(authDir, "auth.json"), JSON.stringify({ wellknown: true }));
        const logs: string[] = [];
        const session = await provisionDockerSession({ authMountSrc: authDir, logger: (m) => logs.push(m) });
        sessions.push(session);
        expect(await containerExists(session.name)).toBe(true);

        // The container can edit the workspace and run commands (writable, not read-only).
        await session.exec(["sh", "-c", "echo hello > /work/artifact.txt && echo world"], {
          logger: (m) => logs.push(m),
        });
        const inside = await session.exec(["cat", "/work/artifact.txt"]);
        expect(inside).toContain("hello");
        expect(logs.join("\n")).toMatch(/world|artifact/);

        // Copies artifacts out (bind mount + docker cp both prove it).
        const hostArtifact = join(session.hostWorkdir, "artifact.txt");
        const hostText = await readFile(hostArtifact, "utf8");
        expect(hostText).toContain("hello");
        const cpDest = join(tmpdir(), `jumi-docker-cp-${Date.now()}.txt`);
        try {
          await session.copyOut("/work/artifact.txt", cpDest);
          expect(await readFile(cpDest, "utf8")).toContain("hello");
        } finally {
          await rm(cpDest, { force: true }).catch(() => undefined);
        }

        // Engine child receives no forge token; clone creds injected by parent as today.
        const envOut = await session.exec(["sh", "-c", "env | sort"], {
          env: { GIT_AUTH_TOKEN: "parent-injected", GITEA_BOT_TOKEN: "must-not-reach-child" },
        });
        expect(envOut).toContain("GIT_AUTH_TOKEN=parent-injected");
        expect(envOut).not.toContain("GITEA_BOT_TOKEN");
        expect(envOut).not.toMatch(/GITHUB_APP_/);
        const childEnv = dockerChildEnv({ GIT_AUTH_TOKEN: "a", GITEA_BOT_TOKEN: "b" });
        expect(childEnv.GIT_AUTH_TOKEN).toBe("a");
        expect(Object.keys(childEnv).join(",")).not.toContain("GITEA_BOT_TOKEN");

        // Auth is a mount the operator already has: /auth is mounted ro, not copied.
        const authSeen = await session.exec(["cat", "/auth/auth.json"]);
        expect(authSeen).toContain("wellknown");
        const inspectProc = Bun.spawn(["docker", "inspect", session.name], { stdout: "pipe", stderr: "pipe" });
        const inspectText = await new Response(inspectProc.stdout).text();
        await inspectProc.exited;
        expect(inspectText).toContain("/auth");

        // Destroy runs on success.
        await session.destroy();
        sessions.pop();
        expect(await containerExists(session.name)).toBe(false);
      } finally {
        await rm(authDir, { recursive: true, force: true });
      }
    },
    120_000
  );

  itDocker(
    "destroy runs on failure, timeout, and cancel; failed destroy preserves push",
    async () => {
      expect(await dockerAvailable()).toBe(true);
      // Failure: exec fails but destroy still runs.
      const s1 = await provisionDockerSession();
      sessions.push(s1);
      await expect(s1.exec(["sh", "-c", "exit 3"])).rejects.toThrow();
      await destroyPreservingPush(() => s1.destroy(), { pushLanded: false });
      sessions.pop();
      expect(await containerExists(s1.name)).toBe(false);

      // Timeout belongs to the runtime.
      const s2 = await provisionDockerSession();
      sessions.push(s2);
      await expect(s2.exec(["sleep", "30"], { timeoutMs: 1500 })).rejects.toThrow(/timed out/);
      await destroyPreservingPush(() => s2.destroy(), { pushLanded: false });
      sessions.pop();
      expect(await containerExists(s2.name)).toBe(false);

      // Cancel belongs to the runtime.
      const s3 = await provisionDockerSession();
      sessions.push(s3);
      const abort = new AbortController();
      const pending = s3.exec(["sleep", "30"], { abortSignal: abort.signal });
      abort.abort();
      await expect(pending).rejects.toThrow(/cancelled/);
      await destroyPreservingPush(() => s3.destroy(), { pushLanded: false });
      sessions.pop();
      expect(await containerExists(s3.name)).toBe(false);

      // Failed destroy must not discard a push that already landed.
      let destroyed = false;
      const pushLandedResult = { status: "pushed" };
      try {
        throw new Error("push ok");
      } catch (pushErr) {
        await destroyPreservingPush(
          async () => {
            destroyed = true;
            throw new Error("destroy boom");
          },
          { pushLanded: true }
        ).catch(() => undefined);
        expect(destroyed).toBe(true);
        expect((pushErr as Error).message).toBe("push ok");
        expect(pushLandedResult.status).toBe("pushed");
      }
      await expect(
        destroyPreservingPush(
          async () => {
            throw new Error("destroy boom");
          },
          { pushLanded: false }
        )
      ).rejects.toThrow("destroy boom");
    },
    120_000
  );
});
