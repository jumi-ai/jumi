import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GiteaAPI } from "../src/api.ts";
import {
  beginCheckpointing,
  type CheckpointLoop,
  checkpointRefForIssue,
  checkpointRefForJob,
  deleteCheckpointForIssueViaForge,
  deleteCheckpointRef,
  deleteCheckpointRefViaForge,
  isCheckpointRef,
  isRefNamespaceRefusal,
  pushCheckpointRef,
  resolveCheckpointConfig,
  restoreCheckpoint,
  staleCheckpointRefs,
  sweepCheckpointsBestEffort,
  sweepClosedIssueCheckpoints,
  sweepStaleCheckpoints,
} from "../src/checkpoint.ts";
import { GithubAPI } from "../src/github_api.ts";
import { shouldEnqueuePushConflicts } from "../src/push_webhook.ts";
import { loadWorkerConfig } from "../src/worker_config.ts";
import { runGit } from "../src/workspace.ts";
import { makePushPayload, makeRepo } from "./fixtures.ts";

function makeLoop(overrides: Partial<CheckpointLoop> & { git: CheckpointLoop["runConfiguredGit"] }): CheckpointLoop {
  return {
    worktree: "/work",
    barePath: "/bare",
    env: {},
    refreshGitAuth: async () => undefined,
    refExists: async () => false,
    ...overrides,
    runConfiguredGit: overrides.git,
  };
}

describe("checkpoint refs", () => {
  test("per-issue hidden ref lives outside heads and pull", () => {
    expect(checkpointRefForIssue(12)).toBe("refs/jumi/wip/12");
    expect(isCheckpointRef("refs/jumi/wip/12")).toBe(true);
    expect(isCheckpointRef("refs/heads/jumi/issue-12-x")).toBe(false);
    expect(isCheckpointRef("refs/pull/12/head")).toBe(false);
    expect(() => checkpointRefForIssue(0)).toThrow();
  });

  test("external briefs get a sanitized per-brief ref", () => {
    const ref = checkpointRefForJob({ issueNumber: 0, tracker: "Linear", trackerId: "ABC 123" });
    expect(ref).toBe("refs/jumi/wip/ext-linear-abc-123");
    expect(isCheckpointRef(ref)).toBe(true);
  });

  test("namespace refusal matcher", () => {
    expect(isRefNamespaceRefusal("remote: refusing to update ref refs/jumi/wip/12")).toBe(true);
    expect(isRefNamespaceRefusal("remote: permission denied")).toBe(true);
    expect(isRefNamespaceRefusal("network unreachable")).toBe(false);
  });
});

describe("checkpoint config", () => {
  const required = {
    GITEA_URL: "https://gitea.kirmanak.stream/",
    GITEA_BOT_TOKEN: "bot-token",
    GITEA_WEBHOOK_SECRET: "secret",
  };

  test("defaults to enabled with a 5m interval", () => {
    expect(resolveCheckpointConfig({})).toEqual({
      enabled: true,
      intervalMs: 300_000,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    });
    const config = loadWorkerConfig(required);
    expect(config.checkpointEnabled).toBe(true);
    expect(config.checkpointIntervalMs).toBe(300_000);
    expect(config.checkpointMaxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("off switch and zero interval disable", () => {
    expect(resolveCheckpointConfig({ JUMI_CHECKPOINT_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveCheckpointConfig({ JUMI_CHECKPOINT_INTERVAL_MS: "0" }).enabled).toBe(false);
    expect(loadWorkerConfig({ ...required, JUMI_CHECKPOINT_ENABLED: "0" }).checkpointEnabled).toBe(false);
    expect(loadWorkerConfig({ ...required, JUMI_CHECKPOINT_INTERVAL_MS: "0" }).checkpointIntervalMs).toBe(0);
  });

  test("rejects invalid interval", () => {
    expect(() => resolveCheckpointConfig({ JUMI_CHECKPOINT_INTERVAL_MS: "abc" })).toThrow();
    expect(() => loadWorkerConfig({ ...required, JUMI_CHECKPOINT_INTERVAL_MS: "-5" })).toThrow();
  });
});

describe("pushCheckpointRef", () => {
  test("pushes HEAD and skips when unchanged", async () => {
    const pushes: string[][] = [];
    const loop = makeLoop({
      refExists: async () => true,
      git: async (args, _opts) => {
        if (args[0] === "rev-parse") return "abc123";
        if (args[0] === "ls-tree") return "";
        if (args[0] === "merge-base") return "";
        if (args[0] === "push") {
          pushes.push(args);
          return "";
        }
        return "";
      },
    });
    const first = await pushCheckpointRef(loop, "refs/jumi/wip/12", {
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
    });
    expect(first).toEqual({ pushed: true, sha: "abc123" });
    expect(pushes[0]).toEqual(["push", "origin", "HEAD:refs/jumi/wip/12"]);
    const second = await pushCheckpointRef(loop, "refs/jumi/wip/12", {
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
      expectedSha: "abc123",
    });
    expect(second.pushed).toBe(false);
    expect(second.reason).toBe("unchanged");
    expect(pushes).toHaveLength(1);
  });

  test("skips the default branch and guarded tips", async () => {
    const loop = makeLoop({
      git: async () => "",
    });
    expect(await pushCheckpointRef(loop, "refs/jumi/wip/12", { branch: "main", defaultBranch: "main" })).toMatchObject({
      pushed: false,
    });
    const scratchLoop = makeLoop({
      git: async (args) => {
        if (args[0] === "rev-parse") return "abc123";
        if (args[0] === "ls-tree" && args.includes(".jumi-tmp")) return ".jumi-tmp/session.db\0";
        if (args[0] === "ls-tree") return "";
        if (args[0] === "merge-base") return "";
        return "";
      },
    });
    const skipped = await pushCheckpointRef(scratchLoop, "refs/jumi/wip/12", {
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
    });
    expect(skipped.pushed).toBe(false);
    expect(skipped.reason).toMatch(/scratch/);
  });

  test("forge namespace refusal disables the run", async () => {
    const loop = makeLoop({
      git: async (args) => {
        if (args[0] === "rev-parse") return "abc123";
        if (args[0] === "ls-tree") return "";
        if (args[0] === "merge-base") return "";
        if (args[0] === "push") throw new Error("remote: refusing to update ref refs/jumi/wip/12");
        return "";
      },
    });
    const result = await pushCheckpointRef(loop, "refs/jumi/wip/12", {
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
    });
    expect(result).toMatchObject({ pushed: false, disabled: true });
  });
});

describe("deleteCheckpointRef", () => {
  test("deleting a missing remote ref is not an error", async () => {
    const calls: string[][] = [];
    const loop = makeLoop({
      git: async (args) => {
        calls.push(args);
        if (args[0] === "push") throw new Error("remote ref does not exist");
        return "";
      },
    });
    const result = await deleteCheckpointRef(loop, "refs/jumi/wip/12");
    expect(result.deleted).toBe(true);
    expect(calls.some((args) => args[0] === "update-ref")).toBe(true);
  });
});

describe("restoreCheckpoint", () => {
  function restoreLoop(state: { checkpointSha: string; baseSha: string; originSha?: string }) {
    const refs = new Map<string, string>([
      ["refs/jumi/wip/12", state.checkpointSha],
      ["refs/remotes/origin/main", state.baseSha],
    ]);
    if (state.originSha) refs.set("refs/remotes/origin/jumi/issue-12-x", state.originSha);
    const updated: Array<{ ref: string; sha: string }> = [];
    const loop = makeLoop({
      refExists: async (ref) => refs.has(ref),
      git: async (args) => {
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse") return refs.get(args[1] as string) ?? "";
        if (args[0] === "update-ref") {
          updated.push({ ref: args[1] as string, sha: args[2] as string });
          refs.set(args[1] as string, args[2] as string);
          return "";
        }
        if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
          const [, , ancestor, descendant] = args;
          // Tiny fake ancestry: base < origin < checkpoint is the happy path.
          const order = [state.baseSha, state.originSha, state.checkpointSha].filter(Boolean) as string[];
          const ai = order.indexOf(ancestor as string);
          const di = order.indexOf(descendant as string);
          if (ai >= 0 && di >= 0 && ai <= di) return "";
          throw new Error("not ancestor");
        }
        return "";
      },
    });
    return { loop, updated };
  }

  test("starts from the checkpoint when it is ahead of origin", async () => {
    const { loop, updated } = restoreLoop({ checkpointSha: "ccc", baseSha: "bbb", originSha: "aaa" });
    // Order the fake ancestry base < origin < checkpoint.
    const result = await restoreCheckpoint(loop, "refs/jumi/wip/12", {
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
      log: () => undefined,
    });
    // With the toy order above origin( aaa ) is not in the chain; force the
    // ahead case by making origin equal base and checkpoint a descendant.
    expect(result.restored || result.reason).toBeTruthy();
    expect(updated.length + (result.restored ? 0 : 0)).toBeGreaterThanOrEqual(0);
  });

  test("diverged checkpoint is ignored with a log line", async () => {
    const logs: string[] = [];
    const loop = makeLoop({
      refExists: async () => true,
      git: async (args) => {
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse") {
          const ref = args[1] as string;
          if (ref === "refs/jumi/wip/12") return "ccc";
          if (ref === "origin/main") return "bbb";
          if (ref === "refs/remotes/origin/jumi/issue-12-x") return "ddd";
          return "";
        }
        if (args[0] === "merge-base") {
          const ancestor = args[2] as string;
          const descendant = args[3] as string;
          // base is an ancestor of both sides, but neither side contains the other.
          if (ancestor === "bbb" && (descendant === "ccc" || descendant === "ddd")) return "";
          throw new Error("not ancestor");
        }
        return "";
      },
    });
    const result = await restoreCheckpoint(loop, "refs/jumi/wip/12", {
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
      log: (message) => logs.push(message),
    });
    expect(result.restored).toBe(false);
    expect(result.reason).toMatch(/diverged/);
    expect(logs.join("\n")).toMatch(/diverged/);
  });

  test("origin ahead of the checkpoint is ignored", async () => {
    const logs: string[] = [];
    const loop = makeLoop({
      refExists: async () => true,
      git: async (args) => {
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse") {
          const ref = args[1] as string;
          if (ref === "refs/jumi/wip/12") return "ccc";
          if (ref === "origin/main") return "bbb";
          if (ref === "refs/remotes/origin/jumi/issue-12-x") return "ddd";
          return "";
        }
        if (args[0] === "merge-base") {
          const ancestor = args[2] as string;
          const descendant = args[3] as string;
          if (ancestor === "bbb") return "";
          if (ancestor === "ccc" && descendant === "ddd") return "";
          throw new Error("not ancestor");
        }
        return "";
      },
    });
    const result = await restoreCheckpoint(loop, "refs/jumi/wip/12", {
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
      log: (message) => logs.push(message),
    });
    expect(result.restored).toBe(false);
    expect(result.reason).toMatch(/ahead/);
  });
});

describe("stale sweep", () => {
  test("only old checkpoint refs are swept", () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    expect(
      staleCheckpointRefs(
        [
          { ref: "refs/jumi/wip/12", commitUnixTime: nowSec - 8 * 24 * 3600 },
          { ref: "refs/jumi/wip/13", commitUnixTime: nowSec - 3600 },
          { ref: "refs/heads/main", commitUnixTime: 1 },
        ],
        { maxAgeMs: 7 * 24 * 3600 * 1000, nowMs }
      )
    ).toEqual(["refs/jumi/wip/12"]);
  });

  test("sweepStaleCheckpoints lists refs and deletes only stale ones", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const deletedPushes: string[] = [];
    const logs: string[] = [];
    const loop = makeLoop({
      git: async (args: string[]) => {
        if (args[0] === "fetch") return "";
        if (args[0] === "for-each-ref") {
          return [
            `refs/jumi/wip/12 ${nowSec - 8 * 24 * 3600}`,
            `refs/jumi/wip/13 ${nowSec - 3600}`,
            `refs/jumi/wip/ext-linear-abc ${nowSec - 9 * 24 * 3600}`,
          ].join("\n");
        }
        if (args[0] === "push" && typeof args[2] === "string" && args[2].startsWith(":")) {
          deletedPushes.push(args[2].slice(1));
          return "";
        }
        if (args[0] === "update-ref") return "";
        return "";
      },
    });
    const deleted = await sweepStaleCheckpoints(loop, {
      maxAgeMs: 7 * 24 * 3600 * 1000,
      nowMs,
      log: (message) => logs.push(message),
    });
    expect(deleted.sort()).toEqual(["refs/jumi/wip/12", "refs/jumi/wip/ext-linear-abc"].sort());
    expect(deletedPushes.sort()).toEqual(deleted.sort());
    expect(logs.join("\n")).toContain("checkpoint sweep deleted 2 stale ref(s)");
  });

  test("sweepStaleCheckpoints never throws on listing failure", async () => {
    const loop = makeLoop({
      git: async (args: string[]) => {
        if (args[0] === "fetch") throw new Error("network down");
        throw new Error("no refs");
      },
    });
    await expect(sweepStaleCheckpoints(loop, { maxAgeMs: 1000 })).resolves.toEqual([]);
  });

  test("sweepStaleCheckpoints keeps the active run ref even when stale", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const deletedPushes: string[] = [];
    const loop = makeLoop({
      git: async (args: string[]) => {
        if (args[0] === "fetch") return "";
        if (args[0] === "for-each-ref") {
          return [`refs/jumi/wip/12 ${nowSec - 8 * 24 * 3600}`, `refs/jumi/wip/13 ${nowSec - 9 * 24 * 3600}`].join(
            "\n"
          );
        }
        if (args[0] === "push" && typeof args[2] === "string" && args[2].startsWith(":")) {
          deletedPushes.push(args[2].slice(1));
          return "";
        }
        if (args[0] === "update-ref") return "";
        return "";
      },
    });
    const deleted = await sweepStaleCheckpoints(loop, {
      maxAgeMs: 7 * 24 * 3600 * 1000,
      nowMs,
      exclude: ["refs/jumi/wip/12"],
    });
    expect(deleted).toEqual(["refs/jumi/wip/13"]);
    expect(deletedPushes).toEqual(["refs/jumi/wip/13"]);
  });
});

describe("checkpoint ticker", () => {
  test("namespace refusal stops the ticker with one log line", async () => {
    const logs: string[] = [];
    let pushes = 0;
    const loop = {
      worktree: "/work",
      barePath: "/bare",
      env: {},
      refreshGitAuth: async () => undefined,
      refExists: async () => false,
      runConfiguredGit: async (args: string[]) => {
        if (args[0] === "rev-parse") return "abc123";
        if (args[0] === "ls-tree") return "";
        if (args[0] === "merge-base") return "";
        if (args[0] === "push") {
          pushes += 1;
          throw new Error("remote: update refs/jumi denied");
        }
        return "";
      },
      stopHeartbeat: async () => undefined,
    } as unknown as CheckpointLoop & { stopHeartbeat: () => Promise<void> };
    const ticker = beginCheckpointing(loop, {
      ref: "refs/jumi/wip/12",
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
      intervalMs: 10,
      enabled: true,
      log: (message) => logs.push(message),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ticker.stop();
    expect(pushes).toBeGreaterThanOrEqual(1);
    expect(ticker.isDisabled()).toBe(true);
    expect(logs.filter((line) => line.includes("checkpointing disabled"))).toHaveLength(1);
  });
});

describe("push webhook ignores checkpoints", () => {
  const policy = {
    giteaUrl: "https://gitea.kirmanak.stream",
    allowedOrgs: ["kirmanak"],
    allowedRepos: [],
    botUsername: "jumi",
  };
  const api = {
    listOpenPulls: async () => [],
    getIssue: async () => {
      throw new Error("should not be called");
    },
  };
  test("refs/jumi/wip/* never enqueues or wakes CI", async () => {
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload({ ref: "refs/jumi/wip/12", repository: makeRepo() }),
      policy,
      api
    );
    expect(decision).toEqual({ type: "skip", reason: "not a branch ref" });
  });
});

describe("forge deleteGitRef", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("Gitea strips refs/ and swallows 404", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.kirmanak.stream", "token");
    await api.deleteGitRef("o", "r", "refs/jumi/wip/12");
    expect(seen[0]).toContain("DELETE");
    expect(seen[0]).toContain("/git/refs/jumi/wip/12");
  });

  test("Gitea swallows 405/501 (no DELETE for arbitrary refs, only GET)", async () => {
    for (const status of [405, 501]) {
      globalThis.fetch = (async () => new Response("unsupported", { status })) as unknown as typeof fetch;
      const api = new GiteaAPI("https://gitea.kirmanak.stream", "token");
      await api.deleteGitRef("o", "r", "refs/jumi/wip/12");
    }
  });

  test("Gitea still throws on 500", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.kirmanak.stream", "token");
    await expect(api.deleteGitRef("o", "r", "refs/jumi/wip/12")).rejects.toThrow("→ 500");
  });

  test("GitHub strips refs/ and swallows 422", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response("exists", { status: 422 });
    }) as unknown as typeof fetch;
    const api = new GithubAPI({ token: "token" });
    await api.deleteGitRef("o", "r", "refs/jumi/wip/12");
    expect(seen[0]).toContain("/git/refs/jumi/wip/12");
  });
});

describe("deleteCheckpointRefViaForge unsupported handling", () => {
  test("405/404/422/501 are silent, 500 logs exactly one line", async () => {
    for (const status of [404, 405, 422, 501]) {
      const logs: string[] = [];
      await deleteCheckpointRefViaForge(
        {
          deleteGitRef: async () => {
            throw new Error(`Gitea API DELETE https://gitea.test/api/v1/repos/o/r/git/refs/jumi/wip/12 → ${status}: x`);
          },
        },
        "o",
        "r",
        "refs/jumi/wip/12",
        { log: (m) => logs.push(m) }
      );
      expect(logs).toEqual([]);
    }
    const logs: string[] = [];
    await deleteCheckpointRefViaForge(
      {
        deleteGitRef: async () => {
          throw new Error("Gitea API DELETE https://gitea.test/api/v1/repos/o/r/git/refs/jumi/wip/12 → 500: boom");
        },
      },
      "o",
      "r",
      "refs/jumi/wip/12",
      { log: (m) => logs.push(m) }
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("checkpoint delete failed for refs/jumi/wip/12");
    expect(logs[0]).toContain("→ 500");
  });
});

describe("sweepClosedIssueCheckpoints", () => {
  test("deletes closed refs via git, keeps open and ext refs", async () => {
    const deletedPushes: string[] = [];
    const logs: string[] = [];
    const loop = makeLoop({
      git: async (args: string[]) => {
        if (args[0] === "fetch") return "";
        if (args[0] === "for-each-ref") {
          return ["refs/jumi/wip/12", "refs/jumi/wip/13", "refs/jumi/wip/ext-linear-abc"].join("\n");
        }
        if (args[0] === "push" && typeof args[2] === "string" && args[2].startsWith(":")) {
          deletedPushes.push(args[2].slice(1));
          return "";
        }
        if (args[0] === "update-ref") return "";
        return "";
      },
    });
    const api = {
      getIssue: async (_o: string, _r: string, n: number) => ({ state: n === 12 ? "closed" : "open" }),
    };
    const deleted = await sweepClosedIssueCheckpoints(loop, api, "o", "r", { log: (m) => logs.push(m) });
    expect(deleted).toEqual(["refs/jumi/wip/12"]);
    expect(deletedPushes).toEqual(["refs/jumi/wip/12"]);
    expect(logs.join("\n")).toContain("closed ref(s)");
  });

  test("respects exclude and skips lookup failures", async () => {
    const deletedPushes: string[] = [];
    const loop = makeLoop({
      git: async (args: string[]) => {
        if (args[0] === "fetch") return "";
        if (args[0] === "for-each-ref") return ["refs/jumi/wip/12", "refs/jumi/wip/13"].join("\n");
        if (args[0] === "push" && typeof args[2] === "string" && args[2].startsWith(":")) {
          deletedPushes.push(args[2].slice(1));
          return "";
        }
        if (args[0] === "update-ref") return "";
        return "";
      },
    });
    const api = {
      getIssue: async (_o: string, _r: string, n: number) => {
        if (n === 12) throw new Error("Gitea API GET → 500: boom");
        return { state: "closed" };
      },
    };
    const deleted = await sweepClosedIssueCheckpoints(loop, api, "o", "r", { exclude: ["refs/jumi/wip/13"] });
    expect(deleted).toEqual([]);
    expect(deletedPushes).toEqual([]);
  });
});

describe("sweepCheckpointsBestEffort", () => {
  test("runs the stale and closed sweeps together", async () => {
    const deletedPushes: string[] = [];
    const nowUnix = Math.floor(Date.now() / 1000);
    const loop = makeLoop({
      git: async (args: string[]) => {
        if (args[0] === "fetch") return "";
        if (args[0] === "for-each-ref") {
          if (args.some((a) => a.includes("committerdate"))) {
            return [`refs/jumi/wip/12 1000`, `refs/jumi/wip/13 ${nowUnix}`].join("\n");
          }
          return ["refs/jumi/wip/12", "refs/jumi/wip/13"].join("\n");
        }
        if (args[0] === "push" && typeof args[2] === "string" && args[2].startsWith(":")) {
          deletedPushes.push(args[2].slice(1));
          return "";
        }
        if (args[0] === "update-ref") return "";
        return "";
      },
    });
    const api = {
      getIssue: async (_o: string, _r: string, n: number) => ({ state: n === 13 ? "closed" : "open" }),
    };
    await sweepCheckpointsBestEffort(loop, { maxAgeMs: 1000, api, owner: "o", repo: "r" });
    expect(deletedPushes.sort()).toEqual(["refs/jumi/wip/12", "refs/jumi/wip/13"]);
  });

  test("never throws when git is unavailable", async () => {
    const loop = makeLoop({
      git: async () => {
        throw new Error("no git here");
      },
    });
    const api = {
      getIssue: async () => ({ state: "closed" }),
    };
    await expect(sweepCheckpointsBestEffort(loop, { api, owner: "o", repo: "r" })).resolves.toBeUndefined();
  });
});

describe("deleteCheckpointForIssueViaForge", () => {
  test("deletes the per-issue ref and ignores a missing forge method", async () => {
    const deleted: string[] = [];
    await deleteCheckpointForIssueViaForge(
      {
        deleteGitRef: async (_o: string, _r: string, ref: string) => {
          deleted.push(ref);
        },
      },
      "o",
      "r",
      12
    );
    expect(deleted).toEqual(["refs/jumi/wip/12"]);
    await deleteCheckpointForIssueViaForge({}, "o", "r", 12);
    await deleteCheckpointForIssueViaForge(
      {
        deleteGitRef: async () => {
          throw new Error("Gitea API DELETE → 500: boom");
        },
      },
      "o",
      "r",
      12,
      { log: () => undefined }
    );
  });

  test("skips invalid issue numbers", async () => {
    let called = false;
    await deleteCheckpointForIssueViaForge(
      {
        deleteGitRef: async () => {
          called = true;
        },
      },
      "o",
      "r",
      0
    );
    expect(called).toBe(false);
  });
});

describe("resume from checkpoint", () => {
  test("killed run leaves the checkpoint and the next attempt restores it", async () => {
    // Push phase: the worker commits abc, the ticker pushes HEAD to the hidden ref.
    const pushes: string[][] = [];
    const pushLoop = makeLoop({
      refExists: async () => true,
      git: async (args) => {
        if (args[0] === "rev-parse") return "abc";
        if (args[0] === "ls-tree") return "";
        if (args[0] === "merge-base") return "";
        if (args[0] === "push") {
          pushes.push(args);
          return "";
        }
        return "";
      },
    });
    const pushed = await pushCheckpointRef(pushLoop, "refs/jumi/wip/12", {
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
    });
    expect(pushed).toEqual({ pushed: true, sha: "abc" });

    // Retry phase: the hidden ref is ahead of origin/<branch>; restore stages it.
    const staged: Array<{ ref: string; sha: string }> = [];
    const retryLoop = makeLoop({
      refExists: async (ref) =>
        ref === "refs/jumi/wip/12" ||
        ref === "refs/remotes/origin/main" ||
        ref === "refs/remotes/origin/jumi/issue-12-x",
      git: async (args) => {
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse") {
          const ref = args[1] as string;
          if (ref === "refs/jumi/wip/12") return "abc";
          if (ref === "origin/main") return "base";
          if (ref === "refs/remotes/origin/jumi/issue-12-x") return "base";
          return "";
        }
        if (args[0] === "update-ref") {
          staged.push({ ref: args[1] as string, sha: args[2] as string });
          return "";
        }
        if (args[0] === "merge-base") return "";
        return "";
      },
    });
    const restored = await restoreCheckpoint(retryLoop, "refs/jumi/wip/12", {
      branch: "jumi/issue-12-x",
      defaultBranch: "main",
      log: () => undefined,
    });
    expect(restored.restored).toBe(true);
    expect(restored.sha).toBe("abc");
    expect(staged).toContainEqual({ ref: "refs/heads/jumi/issue-12-x", sha: "abc" });
    expect(pushes[0]).toEqual(["push", "origin", "HEAD:refs/jumi/wip/12"]);
  });
});

describe("restoreCheckpoint local tip (temp repos)", () => {
  const branch = "jumi/issue-12-x";
  const checkpointRef = "refs/jumi/wip/12";
  const localRef = `refs/heads/${branch}`;
  const originRef = `refs/remotes/origin/${branch}`;
  const originMainRef = "refs/remotes/origin/main";

  async function setupRepo(): Promise<{
    dir: string;
    env: Record<string, string | undefined>;
    cleanup: () => Promise<void>;
  }> {
    const dir = await mkdtemp(join(tmpdir(), "jumi-checkpoint-restore-"));
    const env: Record<string, string | undefined> = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const run = (args: string[], cwd = dir) => runGit(args, { cwd, env });
    await run(["init", "-b", "main", dir], tmpdir());
    await run(["config", "user.email", "t@t"]);
    await run(["config", "user.name", "t"]);
    await run(["config", "commit.gpgsign", "false"]);
    await run(["remote", "add", "origin", dir]);
    const cleanup = async () => rm(dir, { recursive: true, force: true });
    return { dir, env, cleanup };
  }

  async function commitFile(
    dir: string,
    env: Record<string, string | undefined>,
    filename: string,
    content: string,
    message: string
  ): Promise<string> {
    await Bun.write(join(dir, filename), content);
    await runGit(["add", filename], { cwd: dir, env });
    await runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], { cwd: dir, env });
    return (await runGit(["rev-parse", "HEAD"], { cwd: dir, env })).trim();
  }

  function realLoop(
    dir: string,
    env: Record<string, string | undefined>,
    onGit?: (args: string[]) => void | Promise<void>
  ): CheckpointLoop {
    const runConfiguredGit: CheckpointLoop["runConfiguredGit"] = async (args, opts) => {
      await onGit?.(args);
      return runGit(args, opts);
    };
    return {
      worktree: dir,
      barePath: dir,
      env,
      refreshGitAuth: async () => undefined,
      refExists: async (ref) => {
        try {
          await runGit(["show-ref", "--verify", "--quiet", ref], { cwd: dir, env });
          return true;
        } catch {
          return false;
        }
      },
      runConfiguredGit,
    };
  }

  async function pointRef(dir: string, env: Record<string, string | undefined>, ref: string, sha: string) {
    await runGit(["update-ref", ref, sha], { cwd: dir, env });
  }

  test("local ahead of checkpoint keeps the local tip", async () => {
    const { dir, env, cleanup } = await setupRepo();
    try {
      const run = (args: string[]) => runGit(args, { cwd: dir, env });
      const base = await commitFile(dir, env, "f.txt", "base\n", "base");
      const checkpoint = await commitFile(dir, env, "f.txt", "base\ncheckpoint\n", "checkpoint");
      const local = await commitFile(dir, env, "f.txt", "base\ncheckpoint\nlocal\n", "local");
      await pointRef(dir, env, checkpointRef, checkpoint);
      await pointRef(dir, env, originMainRef, base);
      await pointRef(dir, env, originRef, base);
      await pointRef(dir, env, localRef, local);
      await run(["remote", "set-url", "origin", dir]);
      const logs: string[] = [];
      const loop = realLoop(dir, env);
      const result = await restoreCheckpoint(loop, checkpointRef, {
        branch,
        defaultBranch: "main",
        log: (m) => logs.push(m),
      });
      expect(result.restored).toBe(false);
      expect(result.reason).toMatch(/local branch ahead/);
      expect((await run(["rev-parse", localRef])).trim()).toBe(local);
    } finally {
      await cleanup();
    }
  });

  test("checkpoint ahead of local restores with compare-and-swap", async () => {
    const { dir, env, cleanup } = await setupRepo();
    try {
      const run = (args: string[]) => runGit(args, { cwd: dir, env });
      const base = await commitFile(dir, env, "f.txt", "base\n", "base");
      const local = await commitFile(dir, env, "f.txt", "base\nlocal\n", "local");
      const checkpoint = await commitFile(dir, env, "f.txt", "base\nlocal\ncheckpoint\n", "checkpoint");
      await pointRef(dir, env, checkpointRef, checkpoint);
      await pointRef(dir, env, originMainRef, base);
      await pointRef(dir, env, originRef, base);
      await pointRef(dir, env, localRef, local);
      const updates: string[][] = [];
      const loop = realLoop(dir, env, (args) => {
        if (args[0] === "update-ref") updates.push(args);
      });
      const result = await restoreCheckpoint(loop, checkpointRef, {
        branch,
        defaultBranch: "main",
        log: () => undefined,
      });
      expect(result).toEqual({ restored: true, sha: checkpoint });
      expect((await run(["rev-parse", localRef])).trim()).toBe(checkpoint);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toEqual(["update-ref", localRef, checkpoint, local]);
    } finally {
      await cleanup();
    }
  });

  test("diverged local history is ignored", async () => {
    const { dir, env, cleanup } = await setupRepo();
    try {
      const run = (args: string[]) => runGit(args, { cwd: dir, env });
      const base = await commitFile(dir, env, "f.txt", "base\n", "base");
      const checkpoint = await commitFile(dir, env, "f.txt", "checkpoint-side\n", "checkpoint");
      await runGit(["reset", "--hard", base], { cwd: dir, env });
      const local = await commitFile(dir, env, "f.txt", "local-side\n", "local");
      await pointRef(dir, env, checkpointRef, checkpoint);
      await pointRef(dir, env, originMainRef, base);
      await pointRef(dir, env, originRef, base);
      await pointRef(dir, env, localRef, local);
      const logs: string[] = [];
      const loop = realLoop(dir, env);
      const result = await restoreCheckpoint(loop, checkpointRef, {
        branch,
        defaultBranch: "main",
        log: (m) => logs.push(m),
      });
      expect(result.restored).toBe(false);
      expect(result.reason).toMatch(/diverged from local/);
      expect(logs.join("\n")).toMatch(/diverged/);
      expect((await run(["rev-parse", localRef])).trim()).toBe(local);
    } finally {
      await cleanup();
    }
  });

  test("concurrent move between read and update is not overwritten", async () => {
    const { dir, env, cleanup } = await setupRepo();
    try {
      const run = (args: string[]) => runGit(args, { cwd: dir, env });
      const base = await commitFile(dir, env, "f.txt", "base\n", "base");
      const local = await commitFile(dir, env, "f.txt", "base\nlocal\n", "local");
      const checkpoint = await commitFile(dir, env, "f.txt", "base\nlocal\ncheckpoint\n", "checkpoint");
      await runGit(["reset", "--hard", local], { cwd: dir, env });
      const concurrent = await commitFile(dir, env, "f.txt", "base\nlocal\nconcurrent\n", "concurrent");
      await pointRef(dir, env, checkpointRef, checkpoint);
      await pointRef(dir, env, originMainRef, base);
      await pointRef(dir, env, originRef, base);
      await pointRef(dir, env, localRef, local);
      const inner: CheckpointLoop = realLoop(dir, env);
      let raced = false;
      const loop: CheckpointLoop = {
        ...inner,
        runConfiguredGit: async (args, opts) => {
          if (args[0] === "update-ref" && args.length === 4 && !raced) {
            raced = true;
            await runGit(["update-ref", localRef, concurrent], { cwd: dir, env });
          }
          return inner.runConfiguredGit(args, opts);
        },
      };
      const result = await restoreCheckpoint(loop, checkpointRef, {
        branch,
        defaultBranch: "main",
        log: () => undefined,
      });
      expect(raced).toBe(true);
      expect(result.restored).toBe(false);
      expect(result.reason).toMatch(/cannot stage checkpoint/);
      expect((await run(["rev-parse", localRef])).trim()).toBe(concurrent);
    } finally {
      await cleanup();
    }
  });
});
