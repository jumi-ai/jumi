import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleAutomergeForPr } from "../src/automerge.ts";
import { JUMI_REVIEW_CONTEXT } from "../src/ci.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { enqueueFollowUpFromReview } from "../src/handover.ts";
import { REPO_MODE_DISABLED_NOTE } from "../src/repo_settings.ts";
import type { ReviewApi } from "../src/review.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { processEngineTick } from "../src/server.ts";
import { processWorkerTick } from "../src/worker.ts";
import { makeIssueApi, makeReviewApi } from "./fakes/forge.ts";
import {
  makeComment,
  makeConfig,
  makeIssue,
  makeIssueJob,
  makeJob,
  makePR,
  makeRepo,
  makeWorkerConfig,
} from "./fixtures.ts";

function modeRepoFile(mode: string) {
  return async () => ({ found: true as const, content: `mode: ${mode}\n` });
}

function modeReviewApi(mode: string | undefined): ReviewApi & { statuses: unknown[]; comments: string[] } {
  const statuses: unknown[] = [];
  const comments: string[] = [];
  const fake = makeReviewApi({
    getPRFiles: async () => [{ filename: "a.ts", status: "modified" as const, additions: 1, deletions: 0, changes: 1 }],
    getRepoFile: mode === undefined ? undefined : modeRepoFile(mode),
    createIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_o: string, _r: string, id: number, body: string) => {
      comments.push(body);
      return makeComment({ id, body });
    },
    createCommitStatus: async (_o: string, _r: string, _s: string, status: unknown) => {
      statuses.push(status);
      return status as never;
    },
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" as const }],
  });
  return Object.assign(fake, { statuses, comments });
}

function modeIssueApi(mode: string | undefined): IssueApi & { comments: string[] } {
  const comments: string[] = [];
  const fake = makeIssueApi({
    getRepoFile: mode === undefined ? undefined : modeRepoFile(mode),
    createIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_o: string, _r: string, _id: number, body: string) => {
      comments.push(body);
      return makeComment({ body });
    },
  });
  return Object.assign(fake, { comments });
}

describe("repository mode", () => {
  test("off mode skips a review with no runner, no status, and no comment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-mode-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = modeReviewApi("off");
      let ran = 0;
      const result = await processEngineTick(
        store,
        makeConfig({ workdir: workspace, home: workspace }),
        api,
        "engine-1",
        {
          gitRunner: async () => {
            throw new Error("git must not run in off mode");
          },
          workspacePreparer: async () => undefined,
          openCodeRunner: async () => {
            ran++;
            return { status: "ok" };
          },
        }
      );
      expect(result).toBe("processed");
      expect(ran).toBe(0);
      expect(api.statuses).toEqual([]);
      expect(api.comments).toEqual([]);
      expect(store.rows[0]?.state).toBe("skipped");
      expect(store.rows[0]?.resultReason).toBe("repository mode is off");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("review-only mode still reviews", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-mode-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = modeReviewApi("review-only");
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace, home: workspace }), api, "engine-1", {
        gitRunner: async (args) => {
          if (args[0] === "rev-parse") return "headsha";
          if (args[0] === "status") return "?? JUMI_REVIEW.md";
          if (args[0] === "ls-files") return "";
          if (args[0] === "checkout") return "";
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        workspacePreparer: async () => undefined,
        // File-artifact path: the stubbed runner never wires the structured adapter.
        verdictContract: "legacy",
        openCodeRunner: async (opts) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ran).toBe(1);
      expect(store.rows[0]?.state).toBe("succeeded");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("review-only mode skips a worker job with one disabled note and no runner", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const api = modeIssueApi("review-only");
    let ran = 0;
    const result = await processWorkerTick(store, makeWorkerConfig(), api, "worker-1", {
      implement: async () => {
        ran++;
        return { status: "pr", prNumber: 1, htmlUrl: "https://example" };
      },
    });
    expect(result).toBe("processed");
    expect(ran).toBe(0);
    expect(store.rows[0]?.state).toBe("skipped");
    expect(store.rows[0]?.resultReason).toBe("repository mode is review-only");
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]).toContain(REPO_MODE_DISABLED_NOTE);
  });

  test("off mode skips a worker job silently", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const api = modeIssueApi("off");
    let ran = 0;
    const result = await processWorkerTick(store, makeWorkerConfig(), api, "worker-1", {
      implement: async () => {
        ran++;
        return { status: "pr", prNumber: 1, htmlUrl: "https://example" };
      },
    });
    expect(result).toBe("processed");
    expect(ran).toBe(0);
    expect(api.comments).toEqual([]);
    expect(store.rows[0]?.resultReason).toBe("repository mode is off");
  });

  test("restricted modes never schedule auto-merge", async () => {
    for (const mode of ["review-only", "off"]) {
      const calls: string[] = [];
      const api = {
        getRepo: async () => makeRepo(),
        getPR: async (_o: string, _r: string, index: number) => makePR({ number: index }),
        getPRFiles: async () => [],
        getRepoFile: async () => ({ found: true as const, content: `automerge: true\nmode: ${mode}\n` }),
        getBranch: async () => ({ protected: true, enableStatusCheck: true, requiredContexts: [JUMI_REVIEW_CONTEXT] }),
        scheduleAutoMerge: async () => {
          calls.push("scheduleAutoMerge");
        },
        findStickyIssueComment: async () => undefined,
        createIssueComment: async () => makeComment({}),
        updateIssueComment: async () => makeComment({}),
      } as unknown as IssueApi & { getPRFiles: () => Promise<never[]>; getBranch: () => Promise<never> };
      const result = await scheduleAutomergeForPr({
        api: api as never,
        forgeKind: "gitea",
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        baseBranch: "main",
        automergeRepos: ["kirmanak/demo"],
        botUsername: "jumi",
      });
      expect(result).toEqual({ scheduled: false });
      expect(calls).toEqual([]);
    }
  });

  test("restricted modes never enqueue review follow-up", async () => {
    for (const mode of ["review-only", "off"]) {
      const store = new MemoryReviewJobStore();
      const api = {
        getRepo: async () => makeRepo(),
        getPR: async () => makePR(),
        getIssue: async () => makeIssue({ number: 12 }),
        getRepoFile: async () => ({ found: true as const, content: `mode: ${mode}\n` }),
        findStickyIssueComment: async () => undefined,
        createIssueComment: async () => makeComment({}),
        updateIssueComment: async () => makeComment({}),
      } as unknown as ReviewApi;
      const row = { id: 1, owner: "kirmanak", repo: "demo", prNumber: 7, headSha: "headsha" } as never;
      const result = await enqueueFollowUpFromReview({
        store: store as never,
        api: api as never,
        row,
        published: { status: "posted" },
        markdown: "🔴 bug\n<!-- jumi-check: failure -->",
        botUsername: "jumi",
      });
      expect(result).toBeUndefined();
      expect(store.rows).toEqual([]);
    }
  });
});
