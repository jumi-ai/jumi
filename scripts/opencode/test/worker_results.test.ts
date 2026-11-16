import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueApi } from "../src/gitea_issues.ts";
import { handoffKey, MemoryHandoffStore } from "../src/handoff.ts";
import {
  implementIssue,
  resolveWorkerBlocked,
  resolveWorkerPrBody,
  resolveWorkerSkip,
  saveWorkerHandoff,
  seedPullRequestDescription,
  withPrConventions,
} from "../src/implement.ts";
import { probeWorkerMcpServer, WorkerResultStore } from "../src/worker_mcp.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssue, makeIssueJob, makeLinkedIssue, makePR } from "./fixtures.ts";
import { withDirs } from "./harness/temp.ts";

async function withWorktree(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-worker-results-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("worker result tool-first reading", () => {
  test("pr_body prefers the tool and logs the path, falls back to the file", async () => {
    await withWorktree(async (dir) => {
      const logs: string[] = [];
      const log = (m: string) => logs.push(m);
      const store = new WorkerResultStore();
      expect(store.setPrBody({ markdown: "Tool body.\n\nFixes #12" }).ok).toBe(true);
      await writeFile(join(dir, "JUMI_PR.md"), "File body.");
      const picked = await resolveWorkerPrBody(store, dir, log);
      expect(picked).toContain("Tool body");
      expect(logs.join("\n")).toContain("from tool");

      const empty = new WorkerResultStore();
      const fallback = await resolveWorkerPrBody(empty, dir, log);
      expect(fallback).toContain("File body");
      expect(logs.join("\n")).toContain("file fallback");

      const missingStore = new WorkerResultStore();
      await withWorktree(async (emptyDir) => {
        const missing = await resolveWorkerPrBody(missingStore, emptyDir, log);
        expect(missing).toBeNull();
        expect(logs.join("\n")).toContain("missing");
      });
    });
  });

  test("skip prefers the tool and falls back to JUMI_SKIP.md", async () => {
    await withWorktree(async (dir) => {
      const logs: string[] = [];
      const store = new WorkerResultStore();
      expect(store.setSkip({ reason: "Tool skip." }).ok).toBe(true);
      await writeFile(join(dir, "JUMI_SKIP.md"), "File skip.");
      expect(await resolveWorkerSkip(store, dir, () => undefined)).toBe("Tool skip.");

      const empty = new WorkerResultStore();
      expect(await resolveWorkerSkip(empty, dir, (m) => logs.push(m))).toBe("File skip.");
      expect(logs.join("\n")).toContain("file fallback");
    });
  });

  test("blocked_on prefers the tool and falls back to JUMI_BLOCKED.md", async () => {
    await withWorktree(async (dir) => {
      const logs: string[] = [];
      const store = new WorkerResultStore();
      expect(store.setBlockedOn({ ref: "other/repo#34", reason: "Need it." }).ok).toBe(true);
      await writeFile(join(dir, "JUMI_BLOCKED.md"), "<!-- jumi-blocked-by: #12 -->");
      const tool = await resolveWorkerBlocked(store, dir, "o", "r", (m) => logs.push(m));
      expect(tool.present).toBe(true);
      expect(tool.parsed).toMatchObject({ owner: "other", repo: "repo", number: 34 });
      expect(tool.toolReason).toBe("Need it.");
      expect(logs.join("\n")).toContain("from tool");

      const empty = new WorkerResultStore();
      const file = await resolveWorkerBlocked(empty, dir, "o", "r", (m) => logs.push(m));
      expect(file.present).toBe(true);
      expect(file.parsed).toMatchObject({ owner: "o", repo: "r", number: 12 });
      expect(logs.join("\n")).toContain("file fallback");
    });
  });

  test("handoff prefers the tool (redacted) and falls back to the file", async () => {
    await withWorktree(async (dir) => {
      const logs: string[] = [];
      const store = new WorkerResultStore();
      expect(store.setHandoff({ notes: "tool notes with secret-token-abc" }).ok).toBe(true);
      await writeFile(join(dir, "JUMI_HANDOFF.md"), "file notes");
      const handoffs = new MemoryHandoffStore();
      const key = handoffKey("gitea", "o", "r", 12);
      const saved = await saveWorkerHandoff(store, dir, handoffs, key, ["secret-token-abc"], (m) => logs.push(m));
      expect(saved).not.toContain("secret-token-abc");
      expect(saved).toContain("tool notes");
      expect(await handoffs.get(key)).toBe(saved);
      expect(logs.join("\n")).toContain("from tool");
    });

    await withWorktree(async (dir) => {
      const logs: string[] = [];
      await writeFile(join(dir, "JUMI_HANDOFF.md"), "file notes only");
      const empty = new WorkerResultStore();
      const handoffs = new MemoryHandoffStore();
      const key = handoffKey("gitea", "o", "r", 12);
      const saved = await saveWorkerHandoff(empty, dir, handoffs, key, [], (m) => logs.push(m));
      expect(saved).toContain("file notes only");
      expect(logs.join("\n")).toContain("file fallback");
    });
  });

  test("implement prefers set_pr_body over JUMI_PR.md and logs the tool path", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const comments: string[] = [];
      const pulls: unknown[] = [];
      const api = makeIssueApi({
        createPullRequest: async (_o, _r, pull) => {
          pulls.push(pull);
          return makePR({ number: 3, title: pull.title, body: pull.body });
        },
        createIssueComment: async (_o, _r, _i, body) => {
          comments.push(body);
          return makeComment({ body });
        },
        updateIssueComment: async (_o, _r, _id, body) => {
          comments.push(body);
          return makeComment({ body });
        },
      }) as IssueApi & { comments?: string[]; pulls?: unknown[] };
      const logs: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = [...args];
        while (gitArgs[0] === "-c") gitArgs.splice(0, 2);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "rev-list") return "1";
        if (gitArgs[0] === "merge-base") return "base";
        if (gitArgs[0] === "ls-tree") return "";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          const mcp = (opts as unknown as { workerMcp?: { url: string; token: string } }).workerMcp;
          expect(mcp).toBeDefined();
          const out = await probeWorkerMcpServer(mcp!.url, mcp!.token, "set_pr_body", {
            markdown: "Tool body wins.",
          });
          expect(out.ok).toBe(true);
          await mkdir(worktree, { recursive: true });
          await writeFile(join(worktree, "JUMI_PR.md"), "File body loses.");
          return { status: "ok" };
        },
        logger: (m) => logs.push(m),
      });
      expect(result.status).toBe("pr");
      expect((pulls[0] as { body?: string }).body).toContain("Tool body wins.");
      expect((pulls[0] as { body?: string }).body).not.toContain("File body loses.");
      expect(logs.join("\n")).toContain("worker result: pr_body from tool");
    });
  });

  test("implement prefers skip and blocked_on tools over files", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const api = makeIssueApi({
        listOpenPulls: async () => [],
        createIssueComment: async (_o, _r, _i, body) => makeComment({ body }),
        updateIssueComment: async (_o, _r, _id, body) => makeComment({ body }),
      }) as IssueApi;
      const logs: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = [...args];
        while (gitArgs[0] === "-c") gitArgs.splice(0, 2);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        if (gitArgs[0] === "merge-base") return "base";
        if (gitArgs[0] === "ls-tree") return "";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          const mcp = (opts as unknown as { workerMcp?: { url: string; token: string } }).workerMcp;
          const out = await probeWorkerMcpServer(mcp!.url, mcp!.token, "skip", { reason: "Tool skip wins." });
          expect(out.ok).toBe(true);
          await mkdir(worktree, { recursive: true });
          await writeFile(join(worktree, "JUMI_SKIP.md"), "File skip loses.");
          return { status: "ok" };
        },
        logger: (m) => logs.push(m),
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(logs.join("\n")).toContain("worker result: skip from tool");
      await access(join(worktree, "JUMI_SKIP.md")).then(
        () => {
          throw new Error("skip file should be stripped");
        },
        () => undefined
      );
    });
  });

  test("implement prefers blocked_on tool over JUMI_BLOCKED.md", async () => {
    await withDirs(async (home, workdir) => {
      const deps: Array<{ owner: string; repo: string; number: number }> = [];
      const api = makeIssueApi({
        listOpenPulls: async () => [],
        listRepoIssues: async () => [makeLinkedIssue({ number: 196, title: "Sibling" })],
        listIssueDependencies: async () => [],
        getIssue: async () => makeIssue(),
        createIssueDependency: async (_o, _r, _i, dep) => {
          deps.push(dep);
        },
        createIssueComment: async (_o, _r, _i, body) => makeComment({ body }),
        updateIssueComment: async (_o, _r, _id, body) => makeComment({ body }),
      }) as IssueApi;
      const logs: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = [...args];
        while (gitArgs[0] === "-c") gitArgs.splice(0, 2);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "rev-list") return "1";
        if (gitArgs[0] === "merge-base") return "base";
        if (gitArgs[0] === "ls-tree") return "";
        if (gitArgs[0] === "show-ref") throw new Error("missing");
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          const mcp = (opts as unknown as { workerMcp?: { url: string; token: string } }).workerMcp;
          const out = await probeWorkerMcpServer(mcp!.url, mcp!.token, "blocked_on", {
            ref: "#196",
            reason: "Need sibling first.",
          });
          expect(out.ok).toBe(true);
          return { status: "ok" };
        },
        logger: (m) => logs.push(m),
      });
      expect(deps).toEqual([{ owner: "kirmanak", repo: "demo", number: 196 }]);
      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toContain("blocked on #196");
        expect(result.reason).toContain("Need sibling first");
      }
      expect(logs.join("\n")).toContain("worker result: blocked_on from tool");
    });
  });
});

describe("worker result seed handling (follow-up copies)", () => {
  test("pr_body seed: tool wins, untouched is unchanged, edited is fallback", async () => {
    await withWorktree(async (dir) => {
      const seed = seedPullRequestDescription("Posted body.\n\nFixes #12");
      await writeFile(join(dir, "JUMI_PR.md"), seed);

      // Tool wins over an untouched seed.
      const toolLogs: string[] = [];
      const toolStore = new WorkerResultStore();
      expect(toolStore.setPrBody({ markdown: "Tool body.\n\nFixes #12" }).ok).toBe(true);
      const toolPicked = await resolveWorkerPrBody(toolStore, dir, (m) => toolLogs.push(m), seed);
      expect(toolPicked).toContain("Tool body");
      expect(toolLogs.join("\n")).toContain("from tool");

      // Untouched copy counts as no result.
      const unchangedLogs: string[] = [];
      const unchanged = await resolveWorkerPrBody(new WorkerResultStore(), dir, (m) => unchangedLogs.push(m), seed);
      expect(unchanged).toBeNull();
      expect(unchangedLogs.join("\n")).toContain("pr_body unchanged");

      // Edited copy is the remaining fallback.
      await writeFile(join(dir, "JUMI_PR.md"), `${seed}\nEdited by child.\n`);
      const editedLogs: string[] = [];
      const edited = await resolveWorkerPrBody(new WorkerResultStore(), dir, (m) => editedLogs.push(m), seed);
      expect(edited).toContain("Edited by child");
      expect(editedLogs.join("\n")).toContain("from file fallback (edited seed)");
    });
  });

  test("pr_body seed absent: no file is unchanged, new file is edited fallback", async () => {
    await withWorktree(async (dir) => {
      const logs: string[] = [];
      const missing = await resolveWorkerPrBody(new WorkerResultStore(), dir, (m) => logs.push(m), null);
      expect(missing).toBeNull();
      expect(logs.join("\n")).toContain("pr_body unchanged");

      await writeFile(join(dir, "JUMI_PR.md"), "New body.\n");
      const editedLogs: string[] = [];
      const edited = await resolveWorkerPrBody(new WorkerResultStore(), dir, (m) => editedLogs.push(m), null);
      expect(edited).toContain("New body");
      expect(editedLogs.join("\n")).toContain("from file fallback (edited seed)");
    });
  });

  test("handoff seed: tool wins, untouched keeps store, edited is fallback", async () => {
    await withWorktree(async (dir) => {
      const seed = "previous notes";
      await writeFile(join(dir, "JUMI_HANDOFF.md"), seed);
      const key = handoffKey("gitea", "o", "r", 12);

      // Tool wins.
      const toolStore = new WorkerResultStore();
      expect(toolStore.setHandoff({ notes: "tool notes" }).ok).toBe(true);
      const toolLogs: string[] = [];
      const toolHandoffs = new MemoryHandoffStore();
      await toolHandoffs.put(key, seed);
      const toolSaved = await saveWorkerHandoff(toolStore, dir, toolHandoffs, key, [], (m) => toolLogs.push(m));
      expect(toolSaved).toContain("tool notes");
      expect(toolLogs.join("\n")).toContain("from tool");

      // Untouched copy keeps the stored note and is not re-saved.
      await writeFile(join(dir, "JUMI_HANDOFF.md"), seed);
      const kept = new MemoryHandoffStore();
      await kept.put(key, seed);
      const unchangedLogs: string[] = [];
      const unchanged = await saveWorkerHandoff(
        new WorkerResultStore(),
        dir,
        kept,
        key,
        [],
        (m) => unchangedLogs.push(m),
        seed
      );
      expect(unchanged).toBeNull();
      expect(await kept.get(key)).toBe(seed);
      expect(unchangedLogs.join("\n")).toContain("handoff unchanged");

      // Edited copy publishes the edit.
      await writeFile(join(dir, "JUMI_HANDOFF.md"), "edited notes");
      const editedStore = new MemoryHandoffStore();
      await editedStore.put(key, seed);
      const editedLogs: string[] = [];
      const edited = await saveWorkerHandoff(
        new WorkerResultStore(),
        dir,
        editedStore,
        key,
        [],
        (m) => editedLogs.push(m),
        seed
      );
      expect(edited).toContain("edited notes");
      expect(await editedStore.get(key)).toContain("edited notes");
      expect(editedLogs.join("\n")).toContain("from file fallback (edited seed)");
    });
  });

  test("handoff seed absent: no file is unchanged, new file is edited fallback", async () => {
    await withWorktree(async (dir) => {
      const key = handoffKey("gitea", "o", "r", 12);
      const store = new MemoryHandoffStore();
      const logs: string[] = [];
      const missing = await saveWorkerHandoff(new WorkerResultStore(), dir, store, key, [], (m) => logs.push(m), null);
      expect(missing).toBeNull();
      expect(await store.get(key)).toBeNull();
      expect(logs.join("\n")).toContain("handoff unchanged");

      await writeFile(join(dir, "JUMI_HANDOFF.md"), "new notes");
      const editedLogs: string[] = [];
      const edited = await saveWorkerHandoff(
        new WorkerResultStore(),
        dir,
        store,
        key,
        [],
        (m) => editedLogs.push(m),
        null
      );
      expect(edited).toContain("new notes");
      expect(editedLogs.join("\n")).toContain("from file fallback (edited seed)");
    });
  });

  test("withPrConventions refs text names set_pr_body, not JUMI_PR.md", async () => {
    const out = withPrConventions(
      "base",
      { branchPrefix: "jumi", prTitle: "{title}", commitMessage: "x", closingKeyword: "refs" },
      12
    );
    expect(out).toContain("set_pr_body");
    expect(out).not.toContain("JUMI_PR.md");
  });
});
