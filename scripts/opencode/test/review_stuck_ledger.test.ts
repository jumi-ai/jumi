import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewStuckStatePath } from "../src/claim.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
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
import { handleIssueCancel } from "../src/worker.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import { makeComment, makeFile, makeIssue, makePR, makeRepo, makeWorkerConfig } from "./fixtures.ts";
import { withEnv } from "./harness/env.ts";
import { frozenGit } from "./harness/git.ts";
import { withTempDirs, withWorkspace } from "./harness/temp.ts";

function stuckLedgerApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return makeReviewApi({
    getPRFiles: async () => [makeFile()],
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    ...overrides,
  });
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
  // File-artifact path: these harnesses stub the runner without wiring the
  // structured adapter, so they pin the legacy contract explicitly.
  verdictContract: "legacy" as const,
};

describe("review stuck ledger survives HOME change", () => {
  test("same-finding stop triggers across different HOME directories", async () => {
    await withTempDirs(["jumi-tmp-", "jumi-tmp-"], async (homeA, homeB) => {
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
          api: stuckLedgerApi(),
          gitRunner: frozenGit(),
          openCodeRunner: async () => {
            openCode++;
            return { status: "ok" };
          },
        });
        expect(result).toEqual({ status: "skipped", reason: "stuck: repeated action" });
        expect(openCode).toBe(0);
      }
    });
  });

  test("ping-pong stop triggers across different HOME directories", async () => {
    await withTempDirs(["jumi-tmp-", "jumi-tmp-"], async (homeA, homeB) => {
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
          api: stuckLedgerApi(),
          gitRunner: frozenGit(),
          openCodeRunner: async () => {
            openCode++;
            return { status: "ok" };
          },
        });
        expect(result).toEqual({ status: "skipped", reason: "stuck: ping-pong" });
        expect(openCode).toBe(0);
      }
    });
  });

  test("quota flag triggers across different HOME directories", async () => {
    await withTempDirs(["jumi-tmp-", "jumi-tmp-"], async (homeA, homeB) => {
      const store = new MemorySkipLatchStore();
      await markReviewQuotaStuckLatch(store, "kirmanak", "demo", 7, QUOTA_STUCK_TEXT);
      for (const home of [homeA, homeB]) {
        let openCode = 0;
        const result = await reviewPullRequest({
          ...baseOptions,
          home,
          skipLatches: store,
          api: stuckLedgerApi(),
          gitRunner: frozenGit(),
          openCodeRunner: async () => {
            openCode++;
            return { status: "ok" };
          },
        });
        expect(result).toEqual({ status: "skipped", reason: QUOTA_STUCK_TEXT });
        expect(openCode).toBe(0);
      }
    });
  });
});

describe("DATABASE_URL disables the HOME file", () => {
  test("ledger empty + file stuck does not stop when DATABASE_URL is set", async () => {
    await withTempDirs(["jumi-dburl-"], async (home) => {
      await withEnv({ DATABASE_URL: "postgres://example/db" }, async () => {
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
        await withWorkspace(async (workspace) => {
          let openCode = 0;
          const failureMarkdown = "src/foo.ts:1: 🔴 bug: please fix the tests.\n<!-- jumi-check: failure -->";
          const result = await reviewPullRequest({
            ...baseOptions,
            workspace,
            home,
            skipLatches: store,
            api: stuckLedgerApi(),
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
        });
      });
    });
  });

  test("ledger stuck stops without touching the HOME file when DATABASE_URL is set", async () => {
    await withTempDirs(["jumi-dburl-"], async (home) => {
      await withEnv({ DATABASE_URL: "postgres://example/db" }, async () => {
        const store = new MemorySkipLatchStore();
        await markReviewQuotaStuckLatch(store, "kirmanak", "demo", 7, QUOTA_STUCK_TEXT);
        const stuckPath = reviewStuckStatePath(home, "kirmanak", "demo", 7);
        await expect(access(stuckPath)).rejects.toThrow();
        let openCode = 0;
        const result = await reviewPullRequest({
          ...baseOptions,
          home,
          skipLatches: store,
          api: stuckLedgerApi(),
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
      });
    });
  });

  test("file stuck is still read when DATABASE_URL is unset and no store is passed", async () => {
    await withTempDirs(["jumi-file-"], async (home) => {
      await withEnv({ DATABASE_URL: undefined }, async () => {
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
          api: stuckLedgerApi(),
          gitRunner: frozenGit(),
          openCodeRunner: async () => {
            openCode++;
            return { status: "ok" };
          },
        });
        expect(result).toEqual({ status: "skipped", reason: "stuck: repeated action" });
        expect(openCode).toBe(0);
      });
    });
  });
});

describe("review and worker stuck cells are isolated", () => {
  const key = { owner: "kirmanak", repo: "demo", issueNumber: 7 };

  test("worker fingerprints + quota do not stop review", async () => {
    await withWorkspace(async (home) => {
      const store = new MemorySkipLatchStore();
      const workerHash = fingerprintReviewArtifact("worker finding\n<!-- jumi-check: failure -->")!;
      for (let i = 0; i < 4; i++) {
        await appendStuckLatchFingerprint(store, key, { kind: "action", hash: workerHash });
      }
      await markQuotaStuckLatch(store, key, QUOTA_STUCK_TEXT);
      expect((await readStuckLatch(store, key)).fingerprints).toHaveLength(4);
      expect(isQuotaStuck(await readStuckLatch(store, key))).toBe(true);
      expect((await readReviewStuckLatch(store, "kirmanak", "demo", 7)).fingerprints).toHaveLength(0);

      await withWorkspace(async (workspace) => {
        let openCode = 0;
        const failureMarkdown = "src/foo.ts:1: 🔴 bug: please fix the tests.\n<!-- jumi-check: failure -->";
        const result = await reviewPullRequest({
          ...baseOptions,
          workspace,
          home,
          skipLatches: store,
          api: stuckLedgerApi(),
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
      });
    });
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

  test("worker cancel without a store clears worker cells but preserves review stuck", async () => {
    await withWorkspace(async (home) => {
      const shared = new MemorySkipLatchStore();
      const workerHash = fingerprintReviewArtifact("worker finding\n<!-- jumi-check: failure -->")!;
      const reviewHash = fingerprintReviewArtifact("review finding\n<!-- jumi-check: failure -->")!;
      await shared.put(key, {
        followup: { round: 3 },
        conflict: { round: 1 },
        ci: { pending: true },
        stuck: { fingerprints: [{ kind: "action", hash: workerHash }] },
      });
      await appendReviewStuckLatch(shared, "kirmanak", "demo", 7, { kind: "action", hash: reviewHash });
      await handleIssueCancel(
        makeWorkerConfig({ home }),
        {} as IssueApi,
        "kirmanak",
        "demo",
        7,
        undefined,
        undefined,
        undefined,
        undefined,
        shared
      );
      expect((await readStuckLatch(shared, key)).fingerprints).toHaveLength(0);
      const after = await shared.get(key);
      expect(after.followup).toEqual({});
      expect(after.conflict).toEqual({});
      expect(after.ci).toEqual({});
      expect(after.stuck).toEqual({});
      expect(after.reviewStuck).toMatchObject({
        fingerprints: [{ kind: "action", hash: reviewHash }],
      });
      expect(await readReviewStuckLatch(shared, "kirmanak", "demo", 7)).toMatchObject({
        fingerprints: [{ kind: "action", hash: reviewHash }],
      });
    });
  });
});
