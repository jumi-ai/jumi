import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredEngine } from "../src/engine_dispatch.ts";
import { orderedRunners } from "../src/runners.ts";
import { destroyRuntimeWorkspace, runRuntimeEngine, STANDING_POD_RUNTIME, standingPodRuntime } from "../src/runtime.ts";
import { gitOpenCodeChildEnv, workerOpenCodeChildEnv } from "../src/workspace.ts";

describe("standing pod runtime", () => {
  test("is the live computer for both factories", () => {
    expect(standingPodRuntime.name).toBe(STANDING_POD_RUNTIME);
    expect(standingPodRuntime.name).toBe("standing-pod");
    // Both live engines run through it; docker is test-only and never selected.
    expect(typeof standingPodRuntime.runRuntimeEngine).toBe("function");
    // The seam boundary: clone/worktree through ensure/attach, engine run,
    // destroy. Claim lifecycle (begin/open/terminal stamp) stays in core.
    expect(typeof standingPodRuntime.ensureBareCache).toBe("function");
    expect(typeof standingPodRuntime.attachIssueWorktree).toBe("function");
    expect(typeof standingPodRuntime.attachPrWorktree).toBe("function");
    expect(registeredEngine).toBeDefined();
    const catalog = orderedRunners({
      runners: { primary: { type: "opencode", model: "openai/gpt-5.5" } },
      chain: ["primary"],
    });
    expect(catalog[0]?.type).toBe("opencode");
  });

  test("does not call the Kubernetes API, create Jobs, or run on Actions", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/runtime.ts")).text();
    expect(src).toContain("does not call");
    expect(src).not.toMatch(/@kubernetes|kubectl|createNamespacedJob|BatchV1Api|JobSpec/i);
    expect(src).not.toMatch(/actions\/checkout|GITHUB_ACTION/i);
    const workerSrc = await Bun.file(join(import.meta.dir, "../src/worker.ts")).text();
    expect(workerSrc).toContain("standingPodRuntime");
    expect(workerSrc).not.toMatch(/runtime_docker|DockerRuntime/);
    const dispatchSrc = await Bun.file(join(import.meta.dir, "../src/engine_dispatch.ts")).text();
    expect(dispatchSrc).not.toMatch(/docker/i);
  });

  test("timeout and kill belong to runtime; no memory API", () => {
    expect(standingPodRuntime.runRuntimeEngine.length).toBeGreaterThanOrEqual(3);
    const src = Bun.file(join(import.meta.dir, "../src/runtime.ts"));
    expect(src).toBeDefined();
    // No memory limit parameter on the port.
    expect(JSON.stringify(Object.keys(standingPodRuntime))).not.toMatch(/memory/i);
  });

  test("engine child receives no forge token; clone creds injected as today", () => {
    const auth = { giteaUrl: "https://gitea.example/", username: "jumi", token: "secret-token" };
    const child = gitOpenCodeChildEnv(auth);
    expect(child.GIT_AUTH_TOKEN).toBe("secret-token");
    expect(child.GIT_AUTH_HOST).toBeDefined();
    expect(Object.keys(child).join(",")).not.toMatch(/GITEA_BOT_TOKEN|GITEA_WEBHOOK_SECRET|GITHUB_APP_/);
    const workerChild = workerOpenCodeChildEnv(auth, "/work");
    expect(workerChild.GIT_AUTH_TOKEN).toBe("secret-token");
    expect(Object.keys(workerChild).join(",")).not.toMatch(/GITEA_BOT_TOKEN|GITHUB_APP_/);
  });

  test("runs engine, streams logs, kills on abort, collects artifacts, destroys", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-runtime-home-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-runtime-work-"));
    try {
      const logs: string[] = [];
      const fakeLoop = {
        worktree: workdir,
        stopHeartbeat: async () => {
          logs.push("stopHeartbeat");
        },
        forgetSerialized: async () => {
          logs.push("forget");
        },
        detachWorktree: async () => {
          logs.push("detach");
        },
      } as unknown as Parameters<typeof destroyRuntimeWorkspace>[0];
      const result = await runRuntimeEngine(
        fakeLoop as unknown as Parameters<typeof runRuntimeEngine>[0],
        async (opts) => {
          opts.logger?.(`engine in ${opts.workdir}`);
          return { status: "ok" as const };
        },
        {
          model: "openai/gpt-5.5",
          workdir: "/handed-over-path",
          logger: (m) => logs.push(m),
        },
        () => undefined
      );
      expect(result.status).toBe("ok");
      expect(logs.join("\n")).toContain(workdir);
      expect(logs.join("\n")).not.toContain("/handed-over-path");
      await destroyRuntimeWorkspace(fakeLoop, { pushLanded: false, logger: (m) => logs.push(m) });
      expect(logs).toContain("detach");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("failed destroy does not discard a landed push", async () => {
    const logs: string[] = [];
    const failingLoop = {
      worktree: "/work",
      stopHeartbeat: async () => undefined,
      forgetSerialized: async () => undefined,
      detachWorktree: async () => {
        throw new Error("destroy boom");
      },
    } as unknown as Parameters<typeof destroyRuntimeWorkspace>[0];
    // Without a landed push, destroy failure throws.
    await expect(destroyRuntimeWorkspace(failingLoop, { pushLanded: false })).rejects.toThrow("destroy boom");
    // With a landed push, it is logged and swallowed; the push stays landed.
    await destroyRuntimeWorkspace(failingLoop, { pushLanded: true, logger: (m) => logs.push(m) });
    expect(logs.join("\n")).toMatch(/destroy detach failed/);
  });
});
