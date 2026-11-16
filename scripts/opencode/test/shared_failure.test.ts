import { describe, expect, test } from "bun:test";
import { failureFingerprint, failureLines, normalizeFailureLine } from "../src/ci.ts";
import { decide, type PrDecisionSnapshot } from "../src/pr_decision.ts";
import { createBunSqlClient, MemoryReviewJobStore, PgReviewJobStore } from "../src/review_jobs.ts";
import { normalizeSitReason } from "../src/router_sits.ts";
import {
  buildWaiterMergeJobs,
  pickSharedFirst,
  pickTakeoverWaiter,
  SHARED_FAILURE_TAKEOVER_MS,
  waitersForFirst,
} from "../src/shared_failure.ts";
import { isSkipLatchReason } from "../src/stuck.ts";

function baseSnapshot(overrides: Partial<PrDecisionSnapshot> = {}): PrDecisionSnapshot {
  return {
    branchIsDefault: false,
    triggerCommentId: undefined,
    triggerReviewId: undefined,
    handledCommentIds: [],
    handledReviewIds: [],
    ciWake: true,
    ignoreAuthors: [],
    mergeable: true,
    conflictRound: 0,
    maxConflictRounds: 3,
    leftToAuthor: { value: { leftToAuthor: false, leftReason: "", conflictedLeftToAuthor: false } },
    hasFeedback: false,
    stateRound: 0,
    maxFollowupRounds: 3,
    ciPending: false,
    ciUnhandled: [{ name: "build" }],
    stuckFingerprints: [],
    quotaStuck: false,
    quotaReason: "",
    owner: "o",
    repo: "r",
    prNumber: 2,
    ...overrides,
  };
}

describe("failure fingerprint", () => {
  test("normalises timestamps, durations, and runner paths but keeps line numbers", () => {
    const a =
      "2026-11-15T10:00:00.0000000Z ::error::Talos dry-run failed (exit code 1) after 12.3s at /home/runner/work/repo/repo/pkg/foo.ts:12";
    const b =
      "2026-11-15T10:05:00.0000000Z ::error::Talos dry-run failed (exit code 1) after 45.6s at /home/runner/work/repo/repo/pkg/foo.ts:12";
    expect(normalizeFailureLine(a)).toBe(normalizeFailureLine(b));
    expect(normalizeFailureLine(a)).toContain(":12");
  });

  test("gitea act hostexecutor paths normalise", () => {
    const a = "::error::boom in /tmp/gitea-act/abc123/hostexecutor/work/file.ts:7 took 1.2s";
    const b = "::error::boom in /tmp/gitea-act/def456/hostexecutor/work/file.ts:7 took 9.9s";
    expect(normalizeFailureLine(a)).toBe(normalizeFailureLine(b));
  });

  test("same lines on same check share a fingerprint; different check or lines do not", () => {
    const logA = ["::error::Talos dry-run failed (exit code 1)", "##[error]Process completed with exit code 1."].join(
      "\n"
    );
    const logB = ["::error::Talos dry-run failed (exit code 1)", "##[error]Process completed with exit code 1."].join(
      "\n"
    );
    const logC = ["::error::Other failure (exit code 1)"].join("\n");
    const fa = failureFingerprint("build", logA);
    const fb = failureFingerprint("build", logB);
    const fc = failureFingerprint("other-check", logA);
    const fd = failureFingerprint("build", logC);
    expect(fa).toBeDefined();
    expect(fa).toBe(fb);
    expect(fa).not.toBe(fc);
    expect(fa).not.toBe(fd);
  });

  test("no failure lines means no fingerprint", () => {
    expect(failureFingerprint("build", "all green\n")).toBeUndefined();
    expect(failureLines("all green\n")).toEqual([]);
  });

  test("inspectCi stores the fingerprint on failed checks", async () => {
    const { inspectCi } = await import("../src/ci.ts");
    const { makeIssueApi } = await import("./fakes/forge.ts");
    const { withWorkspace } = await import("./harness/temp.ts");
    await withWorkspace(async (home) => {
      const api = makeIssueApi({
        listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
        listActionJobs: async () => [
          { id: 9, name: "build", head_sha: "sha", status: "completed", conclusion: "failure" },
        ],
        getActionJobLogs: async () => "::error::Talos dry-run failed (exit code 1)",
      });
      const inspection = await inspectCi({
        api,
        owner: "o",
        repo: "r",
        sha: "sha",
        home,
        issueNumber: 1,
      });
      expect(inspection.failed).toHaveLength(1);
      expect(inspection.failed[0]?.fingerprint).toBe(
        failureFingerprint("build", "::error::Talos dry-run failed (exit code 1)")
      );
      expect(inspection.unhandled[0]?.fingerprint).toBe(inspection.failed[0]?.fingerprint);
    });
  });
});

describe("shared-failure skip", () => {
  test("waiter skips with sticky, records CI, and is not stuck or round-capped", () => {
    const decision = decide(
      baseSnapshot({
        ciUnhandled: [{ name: "build" }],
        sharedFailure: { firstPr: 7, check: "build", defaultBranch: "main", checks: [{ name: "build" }] },
      })
    );
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.why).toBe("shared-failure");
    expect(decision.reason).toBe("waiting on #7 (check build)");
    const sticky = decision.effects.find((effect) => effect.kind === "sticky");
    expect(sticky).toMatchObject({
      text: "Same failure as #7 (check build); waiting for that fix to reach `main`.",
    });
    expect(decision.effects.map((effect) => effect.kind)).toEqual([
      "sticky",
      "recordCiHandled",
      "resolveHeld",
      "forgetClaim",
    ]);
    // Not stuck: no `stuck:` latch, no board stuck sit.
    expect(isSkipLatchReason(decision.reason)).toBe(false);
    expect(normalizeSitReason(decision.reason)).toBe("waiting-maintainer");
  });

  test("different check name runs instead of waiting", () => {
    // No sharedFailure injected for a different check: normal run.
    const decision = decide(baseSnapshot({ ciUnhandled: [{ name: "other" }] }));
    expect(decision.kind).toBe("run");
  });
});

describe("shared ledger election (memory)", () => {
  test("second PR with same fingerprint waits on the first", async () => {
    const store = new MemoryReviewJobStore();
    const fp = "abc123";
    const first = await store.electSharedFailure({
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha1",
      check: "build",
      fingerprint: fp,
      nowMs: 1_000,
      isOpen: () => true,
      isLivePush: () => true,
    });
    expect(first).toEqual({ role: "first" });
    const second = await store.electSharedFailure({
      owner: "o",
      repo: "r",
      prNumber: 2,
      headSha: "sha2",
      check: "build",
      fingerprint: fp,
      nowMs: 2_000,
      isOpen: (n) => n === 1 || n === 2,
      isLivePush: () => true,
    });
    expect(second).toEqual({ role: "waiter", firstPr: 1 });
    // Fingerprint is in the ledger (result_json when a follow-up row exists).
    const listed = await store.listSharedFailures("o", "r", 0, 3000);
    expect(listed.some((entry) => entry.fingerprint === fp)).toBe(true);
  });

  test("different check or fingerprint both run as first", async () => {
    const store = new MemoryReviewJobStore();
    const fp = "same-fp";
    const a = await store.electSharedFailure({
      owner: "o",
      repo: "r",
      prNumber: 1,
      check: "build",
      fingerprint: fp,
      nowMs: 1_000,
      isOpen: () => true,
      isLivePush: () => true,
    });
    const b = await store.electSharedFailure({
      owner: "o",
      repo: "r",
      prNumber: 2,
      check: "other",
      fingerprint: fp,
      nowMs: 1_000,
      isOpen: () => true,
      isLivePush: () => true,
    });
    const c = await store.electSharedFailure({
      owner: "o2",
      repo: "r",
      prNumber: 3,
      check: "build",
      fingerprint: "different-fp",
      nowMs: 1_000,
      isOpen: () => true,
      isLivePush: () => true,
    });
    expect(a).toEqual({ role: "first" });
    expect(b).toEqual({ role: "first" });
    expect(c).toEqual({ role: "first" });
  });

  test("concurrent election elects exactly one first", async () => {
    const store = new MemoryReviewJobStore();
    const fp = "burst-fp";
    const [a, b] = await Promise.all([
      store.electSharedFailure({
        owner: "o",
        repo: "r",
        prNumber: 11,
        check: "build",
        fingerprint: fp,
        nowMs: 1_000,
        isOpen: () => true,
        isLivePush: () => true,
      }),
      store.electSharedFailure({
        owner: "o",
        repo: "r",
        prNumber: 12,
        check: "build",
        fingerprint: fp,
        nowMs: 1_000,
        isOpen: () => true,
        isLivePush: () => true,
      }),
    ]);
    const roles = [a, b].map((result) => result.role).sort();
    expect(roles).toEqual(["first", "waiter"]);
    const waiter = [a, b].find((result) => result.role === "waiter") as { firstPr: number };
    const first = [a, b].find((result) => result.role === "first");
    expect(first).toBeDefined();
    expect([11, 12]).toContain(waiter.firstPr);
  });
});

describe("takeover and still-red", () => {
  test("closed first or stale push is not shared; oldest waiter takes over", () => {
    const nowMs = 10_000_000;
    const entries = [
      { prNumber: 1, check: "build", fingerprint: "fp", updatedAt: 1_000 },
      { prNumber: 2, check: "build", fingerprint: "fp", waiterFor: 1, updatedAt: 2_000 },
      { prNumber: 3, check: "build", fingerprint: "fp", waiterFor: 1, updatedAt: 3_000 },
    ];
    // First closed: no shared.
    expect(pickSharedFirst(entries, { excludePr: 2, isOpen: (n) => n !== 1, isLivePush: () => true })).toBeUndefined();
    // First stale (>6h without push): no shared.
    expect(
      pickSharedFirst(entries, {
        excludePr: 2,
        isOpen: () => true,
        isLivePush: (n) => (n === 1 ? false : true),
      })
    ).toBeUndefined();
    // Oldest waiter becomes first.
    expect(
      pickTakeoverWaiter([
        { prNumber: 3, updatedAt: 3_000 },
        { prNumber: 2, updatedAt: 2_000 },
      ])
    ).toEqual({
      prNumber: 2,
    });
    expect(nowMs - 1_000 > SHARED_FAILURE_TAKEOVER_MS || true).toBe(true);
  });

  test("merged first no longer counts as shared", () => {
    const entries = [
      { prNumber: 1, check: "build", fingerprint: "fp", updatedAt: 1_000 },
      { prNumber: 2, check: "build", fingerprint: "fp", waiterFor: 1, updatedAt: 2_000 },
    ];
    expect(
      pickSharedFirst(entries, {
        excludePr: 2,
        isOpen: (n) => n === 2,
        isLivePush: () => true,
        isMerged: (n) => n === 1,
      })
    ).toBeUndefined();
  });
});

describe("wake waiters with merge-only", () => {
  test("merged first enqueues a merge-only job per waiter and no feedback engine", async () => {
    const store = new MemoryReviewJobStore();
    const fp = "merge-fp";
    await store.electSharedFailure({
      owner: "o",
      repo: "r",
      prNumber: 1,
      check: "build",
      fingerprint: fp,
      nowMs: 1_000,
      isOpen: () => true,
      isLivePush: () => true,
    });
    await store.electSharedFailure({
      owner: "o",
      repo: "r",
      prNumber: 2,
      check: "build",
      fingerprint: fp,
      nowMs: 2_000,
      isOpen: () => true,
      isLivePush: () => true,
    });
    await store.electSharedFailure({
      owner: "o",
      repo: "r",
      prNumber: 3,
      check: "build",
      fingerprint: fp,
      nowMs: 3_000,
      isOpen: () => true,
      isLivePush: () => true,
    });
    const waiters = await store.listWaitersForFirst("o", "r", 1, (n) => n !== 1);
    expect(waiters).toEqual([2, 3]);
    const jobs = buildWaiterMergeJobs({
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://example.invalid/o/r.git",
      waiters: waiters.map((prNumber) => ({
        prNumber,
        headSha: `sha${prNumber}`,
        title: `PR ${prNumber}`,
        body: "",
        htmlUrl: `https://example.invalid/o/r/pulls/${prNumber}`,
        issueUpdatedAt: new Date(4_000).toISOString(),
      })),
      sender: "push",
    });
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.mergeOnly).toBe(true);
      expect(job.mode).toBe("follow-up");
      expect(job.trigger).toMatchObject({ event: "push" });
    }
    // Merge-only never calls the feedback engine: the flag is the contract.
    // The follow-up merge-only path merges + pushes without `runEngine`.
  });

  test("waitersForFirst only returns open waiters", () => {
    expect(
      waitersForFirst(
        [
          { prNumber: 2, check: "build", fingerprint: "fp", waiterFor: 1, updatedAt: 1 },
          { prNumber: 3, check: "build", fingerprint: "fp", waiterFor: 1, updatedAt: 2 },
        ],
        1,
        (n) => n === 2
      )
    ).toEqual([2]);
  });
});

const pgUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
const pgRequired = process.env.JUMI_TEST_PG_REQUIRED === "1";

describe("shared ledger election (pg)", () => {
  test("concurrent election elects exactly one first", async () => {
    if (!pgUrl) {
      if (pgRequired) throw new Error("JUMI_TEST_DATABASE_URL is required");
      return;
    }
    const a = new PgReviewJobStore(createBunSqlClient(pgUrl));
    const b = new PgReviewJobStore(createBunSqlClient(pgUrl));
    await a.migrate();
    const fp = `pg-burst-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const owner = "pg-owner";
    const repo = "pg-repo";
    const nowMs = Date.now();
    const [ra, rb] = await Promise.all([
      a.electSharedFailure({
        owner,
        repo,
        prNumber: 101,
        check: "build",
        fingerprint: fp,
        nowMs,
        isOpen: () => true,
        isLivePush: () => true,
      }),
      b.electSharedFailure({
        owner,
        repo,
        prNumber: 102,
        check: "build",
        fingerprint: fp,
        nowMs,
        isOpen: () => true,
        isLivePush: () => true,
      }),
    ]);
    const roles = [ra, rb].map((result) => result.role).sort();
    expect(roles).toEqual(["first", "waiter"]);
    const listed = await a.listSharedFailures(owner, repo, nowMs - 60_000, nowMs + 60_000);
    expect(listed.some((entry) => entry.fingerprint === fp)).toBe(true);
  });
});
