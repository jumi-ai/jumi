import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewStuckStatePath } from "../src/claim.ts";
import { QUOTA_STUCK_TEXT } from "../src/quota.ts";
import type { ReviewApi } from "../src/review.ts";
import { reviewPullRequest } from "../src/review.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { MemorySkipLatchStore } from "../src/skip_latches.ts";
import {
  appendReviewStuckLatch,
  appendStuckLatchFingerprint,
  deleteReviewStuckLatch,
  fingerprintReviewArtifact,
  isQuotaStuck,
  markQuotaStuckLatch,
  markReviewQuotaStuckLatch,
  readReviewStuckLatch,
  readStuckLatch,
  readStuckState,
  writeStuckState,
} from "../src/stuck.ts";
import { emptyCiMethods, makeComment, makeFile, makeIssue, makePR, makeRepo } from "./fixtures.ts";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ id: 1, body }),
    updateIssueComment: async (_owner, _repo, commentId, body) => makeComment({ id: commentId, body }),
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_owner, _repo, _sha, status) => status,
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  };
  return { ...defaults, ...overrides };
}

function frozenGit(): (args: string[]) => Promise<string> {
  return async (args) => {
    if (args[0] === "rev-parse") return "headsha";
    if (args[0] === "status") return "?? JUMI_REVIEW.md";
    if (args[0] === "ls-files") return "";
    if (args[0] === "checkout") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const baseOptions = {
  owner: "kirmanak",
  repo: "demo",
  prNumber: 7,
  model: "openai/gpt-5.5",
  workspace: "/work",
  giteaUrl: "https://gitea.kirmanak.stream",
  giteaToken: "bot-token",
  botUsername: "jumi",
  workspacePreparer: async () => undefined,
  logger: () => undefined,
};

describe("review stuck ledger survives HOME change", () => {
  test("same-finding stop triggers across different HOME directories", async () => {
    const homeA = await mkdtemp(join(tmpdir(), "jumi-ledger-a-"));
    const homeB = await mkdtemp(join(tmpdir(), "jumi-ledger-b-"));
    try {
      const store = new MemorySkipLatchStore();
      const hash = fingerprintReviewArtifact("please fix the tests\n<!-- jumi-check: failure -->")!;
      for (let i = 0; i < 4; i++) {
        await appendReviewStuckLatch(store, "kirmanak", "demo", 7, { kind: "action", hash });
      }
      for (const home of [homeA, homeB]) {
        let openCode = 0;
        const result = await reviewPullRequest({
          ...baseOptions,
          home,
          skipLatches: store,
          api: makeApi(),
          gitRunner: frozenGit(),
          openCodeRunner: async () => {
            openCode++;
            return { status: "ok" };
          },
        });
        expect(result).toEqual({ status: "skipped", reason: "stuck: repeated action" });
        expect(openCode).toBe(0);
      }
    } finally {
      await rm(homeA, { recursive: true, force: true });
      await rm(homeB, { recursive: true, force: true });
    }
  });

  test("ping-pong stop triggers across different HOME directories", async () => {
    const homeA = await mkdtemp(join(tmpdir(), "jumi-ledger-a-"));
    const homeB = await mkdtemp(join(tmpdir(), "jumi-ledger-b-"));
    try {
      const store = new MemorySkipLatchStore();
      const hashA = fingerprintReviewArtifact("src/a.ts:1: 🔴 bug: a.\n<!-- jumi-check: failure -->")!;
      const hashB = fingerprintReviewArtifact("src/b.ts:1: 🔴 bug: b.\n<!-- jumi-check: failure -->")!;
      await appendReviewStuckLatch(store, "kirmanak", "demo", 7, { kind: "action", hash: hashA });
      await appendReviewStuckLatch(store, "kirmanak", "demo", 7, { kind: "action", hash: hashB });
      await appendReviewStuckLatch(store, "kirmanak", "demo", 7, { kind: "action", hash: hashA });
      for (const home of [homeA, homeB]) {
        let openCode = 0;
        const result = await reviewPullRequest({
          ...baseOptions,
          home,
          skipLatches: store,
          api: makeApi(),
          gitRunner: frozenGit(),
          openCodeRunner: async () => {
            openCode++;
            return { status: "ok" };
          },
        });
        expect(result).toEqual({ status: "skipped", reason: "stuck: ping-pong" });
        expect(openCode).toBe(0);
      }
    } finally {
      await rm(homeA, { recursive: true, force: true });
      await rm(homeB, { recursive: true, force: true });
    }
  });

  test("quota flag triggers across different HOME directories", async () => {
    const homeA = await mkdtemp(join(tmpdir(), "jumi-ledger-a-"));
    const homeB = await mkdtemp(join(tmpdir(), "jumi-ledger-b-"));
    try {
      const store = new MemorySkipLatchStore();
      await markReviewQuotaStuckLatch(store, "kirmanak", "demo", 7, QUOTA_STUCK_TEXT);
      for (const home of [homeA, homeB]) {
        let openCode = 0;
        const result = await reviewPullRequest({
          ...baseOptions,
          home,
          skipLatches: store,
          api: makeApi(),
          gitRunner: frozenGit(),
          openCodeRunner: async () => {
            openCode++;
            return { status: "ok" };
          },
        });
        expect(result).toEqual({ status: "skipped", reason: QUOTA_STUCK_TEXT });
        expect(openCode).toBe(0);
      }
    } finally {
      await rm(homeA, { recursive: true, force: true });
      await rm(homeB, { recursive: true, force: true });
    }
  });
});

describe("DATABASE_URL disables the HOME file", () => {
  test("ledger empty + file stuck does not stop when DATABASE_URL is set", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-dburl-"));
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://example/db";
    try {
      const hash = fingerprintReviewArtifact("please fix the tests\n<!-- jumi-check: failure -->")!;
      const stuckPath = reviewStuckStatePath(home, "kirmanak", "demo", 7);
      await writeStuckState(stuckPath, {
        fingerprints: [
          { kind: "action", hash },
          { kind: "action", hash },
          { kind: "action", hash },
          { kind: "action", hash },
        ],
        updatedAt: new Date().toISOString(),
      });
      const store = new MemorySkipLatchStore();
      const workspace = await mkdtemp(join(tmpdir(), "jumi-ws-"));
      try {
        let openCode = 0;
        const failureMarkdown = "src/foo.ts:1: 🔴 bug: please fix the tests.\n<!-- jumi-check: failure -->";
        const result = await reviewPullRequest({
          ...baseOptions,
          workspace,
          home,
          skipLatches: store,
          api: makeApi(),
          gitRunner: frozenGit(),
          openCodeRunner: async () => {
            openCode++;
            await writeFile(join(workspace, "JUMI_REVIEW.md"), failureMarkdown);
            return { status: "ok" };
          },
        });
        expect(result.status).toBe("posted");
        expect(openCode).toBeGreaterThan(0);
        const ledger = await readReviewStuckLatch(store, "kirmanak", "demo", 7);
        expect(ledger.fingerprints).toHaveLength(1);
        const expectedHash = fingerprintReviewArtifact(failureMarkdown) as string;
        expect(ledger.fingerprints[0]).toEqual({ kind: "action", hash: expectedHash });
        const fileState = await readStuckState(stuckPath);
        expect(fileState.fingerprints).toHaveLength(4);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("ledger stuck stops without touching the HOME file when DATABASE_URL is set", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-dburl-"));
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://example/db";
    try {
      const store = new MemorySkipLatchStore();
      await markReviewQuotaStuckLatch(store, "kirmanak", "demo", 7, QUOTA_STUCK_TEXT);
      const stuckPath = reviewStuckStatePath(home, "kirmanak", "demo", 7);
      await expect(access(stuckPath)).rejects.toThrow();
      let openCode = 0;
      const result = await reviewPullRequest({
        ...baseOptions,
        home,
        skipLatches: store,
        api: makeApi(),
        gitRunner: async () => {
          throw new Error("git should not be called on quota skip");
        },
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: QUOTA_STUCK_TEXT });
      expect(openCode).toBe(0);
      await expect(access(stuckPath)).rejects.toThrow();
      const state = await readReviewStuckLatch(store, "kirmanak", "demo", 7);
      expect(state.quota?.reason).toBe(QUOTA_STUCK_TEXT);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("file stuck is still read when DATABASE_URL is unset and no store is passed", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-file-"));
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const hash = fingerprintReviewArtifact("please fix the tests\n<!-- jumi-check: failure -->")!;
      await writeStuckState(reviewStuckStatePath(home, "kirmanak", "demo", 7), {
        fingerprints: [
          { kind: "action", hash },
          { kind: "action", hash },
          { kind: "action", hash },
          { kind: "action", hash },
        ],
        updatedAt: new Date().toISOString(),
      });
      expect((await readStuckState(reviewStuckStatePath(home, "kirmanak", "demo", 7))).fingerprints).toHaveLength(4);
      let openCode = 0;
      const result = await reviewPullRequest({
        ...baseOptions,
        home,
        api: makeApi(),
        gitRunner: frozenGit(),
        openCodeRunner: async () => {
          openCode++;
          return { status: "ok" };
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "stuck: repeated action" });
      expect(openCode).toBe(0);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("review and worker stuck cells are isolated", () => {
  const key = { owner: "kirmanak", repo: "demo", issueNumber: 7 };

  test("worker fingerprints + quota do not stop review", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-isolation-"));
    try {
      const store = new MemorySkipLatchStore();
      const workerHash = fingerprintReviewArtifact("worker finding\n<!-- jumi-check: failure -->")!;
      for (let i = 0; i < 4; i++) {
        await appendStuckLatchFingerprint(store, key, { kind: "action", hash: workerHash });
      }
      await markQuotaStuckLatch(store, key, QUOTA_STUCK_TEXT);
      expect((await readStuckLatch(store, key)).fingerprints).toHaveLength(4);
      expect(isQuotaStuck(await readStuckLatch(store, key))).toBe(true);
      expect((await readReviewStuckLatch(store, "kirmanak", "demo", 7)).fingerprints).toHaveLength(0);

      const workspace = await mkdtemp(join(tmpdir(), "jumi-ws-"));
      try {
        let openCode = 0;
        const failureMarkdown = "src/foo.ts:1: 🔴 bug: please fix the tests.\n<!-- jumi-check: failure -->";
        const result = await reviewPullRequest({
          ...baseOptions,
          workspace,
          home,
          skipLatches: store,
          api: makeApi(),
          gitRunner: frozenGit(),
          openCodeRunner: async () => {
            openCode++;
            await writeFile(join(workspace, "JUMI_REVIEW.md"), failureMarkdown);
            return { status: "ok" };
          },
        });
        expect(result.status).toBe("posted");
        expect(openCode).toBeGreaterThan(0);
        // Worker state survives the review run; review wrote only its own cell.
        expect((await readStuckLatch(store, key)).fingerprints).toHaveLength(4);
        expect(isQuotaStuck(await readStuckLatch(store, key))).toBe(true);
        expect((await readReviewStuckLatch(store, "kirmanak", "demo", 7)).fingerprints).toHaveLength(1);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("review fingerprints + quota do not pollute worker state", async () => {
    const store = new MemorySkipLatchStore();
    const reviewHash = fingerprintReviewArtifact("review finding\n<!-- jumi-check: failure -->")!;
    for (let i = 0; i < 4; i++) {
      await appendReviewStuckLatch(store, "kirmanak", "demo", 7, { kind: "action", hash: reviewHash });
    }
    await markReviewQuotaStuckLatch(store, "kirmanak", "demo", 7, QUOTA_STUCK_TEXT);
    expect((await readReviewStuckLatch(store, "kirmanak", "demo", 7)).fingerprints).toHaveLength(4);
    const workerState = await readStuckLatch(store, key);
    expect(workerState.fingerprints).toHaveLength(0);
    expect(isQuotaStuck(workerState)).toBe(false);
  });

  test("review delete preserves worker state; worker clear preserves review state", async () => {
    const jobs = new MemoryReviewJobStore();
    const store = jobs.skipLatches;
    const workerHash = fingerprintReviewArtifact("worker finding\n<!-- jumi-check: failure -->")!;
    const reviewHash = fingerprintReviewArtifact("review finding\n<!-- jumi-check: failure -->")!;
    await appendStuckLatchFingerprint(store, key, { kind: "action", hash: workerHash });
    await appendReviewStuckLatch(store, "kirmanak", "demo", 7, { kind: "action", hash: reviewHash });

    await deleteReviewStuckLatch(store, "kirmanak", "demo", 7);
    expect((await readReviewStuckLatch(store, "kirmanak", "demo", 7)).fingerprints).toHaveLength(0);
    expect(await readStuckLatch(store, key)).toMatchObject({
      fingerprints: [{ kind: "action", hash: workerHash }],
    });

    await appendReviewStuckLatch(store, "kirmanak", "demo", 7, { kind: "action", hash: reviewHash });
    await jobs.clearIssueSkipLatch("kirmanak", "demo", 7);
    expect((await readStuckLatch(store, key)).fingerprints).toHaveLength(0);
    expect(await readReviewStuckLatch(store, "kirmanak", "demo", 7)).toMatchObject({
      fingerprints: [{ kind: "action", hash: reviewHash }],
    });
  });
});
