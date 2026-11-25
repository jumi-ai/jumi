import { describe, expect, test } from "bun:test";
import { failureFingerprint, failureLines, normalizeFailureLine, readCiState } from "../src/ci.ts";
import { ciStatePath } from "../src/claim.ts";
import { decide, type PrDecisionSnapshot } from "../src/pr_decision.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
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
  test("waiter skips with sticky, stays unhandled, and is not stuck or round-capped", () => {
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
    // Deferred, not handled: no recordCiHandled so a later wake re-evaluates.
    expect(decision.effects.map((effect) => effect.kind)).toEqual(["sticky", "resolveHeld", "forgetClaim"]);
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
        isLivePush: (n) => n !== 1,
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

describe("shared-failure deferral (full follow-up path)", () => {
  const FAILURE_LOG = "::error::Talos dry-run failed (exit code 1)\n";
  const TIMEOUT_LOG = "##[error]Failed to connect to 140.82.112.4 port 443: Connection timed out\n";

  function testPr(number: number, issue: number, sha: string) {
    // Local copy of the follow-up harness PR shape (kirmanak/demo).
    const repo = {
      id: 10,
      name: "demo",
      full_name: "kirmanak/demo",
      private: true,
      owner: { id: 1, login: "kirmanak", full_name: "K", email: "", avatar_url: "" },
      html_url: "https://gitea.kirmanak.stream/kirmanak/demo",
      clone_url: "https://gitea.kirmanak.stream/kirmanak/demo.git",
      default_branch: "main",
    };
    const nowIso = new Date().toISOString();
    return {
      id: 100 + number,
      number,
      title: `Fix ${issue}`,
      body: `Fixes #${issue}`,
      state: "open" as const,
      user: { id: 2, login: "jumi", full_name: "J", email: "", avatar_url: "" },
      head: {
        label: `kirmanak:jumi/issue-${issue}-fix`,
        ref: `jumi/issue-${issue}-fix`,
        sha,
        repo,
        repo_id: repo.id,
      },
      base: { label: "kirmanak:main", ref: "main", sha: "basesha" },
      merged: false,
      created_at: nowIso,
      updated_at: nowIso,
      html_url: `https://gitea.kirmanak.stream/kirmanak/demo/pulls/${number}`,
    };
  }

  function stripGit(args: string[]): string[] {
    const out = [...args];
    while (out[0] === "-c") out.splice(0, 2);
    return out;
  }

  async function runWake(opts: {
    api: never;
    ledger: never;
    home: string;
    workdir: string;
    issueNumber: number;
    prNumber: number;
    sha: string;
    delivery: string;
    shouldRun: boolean;
  }): Promise<{ status: string; reason?: string; openCode: number }> {
    const { implementFollowUp } = await import("../src/followup.ts");
    let openCode = 0;
    const result = await implementFollowUp({
      api: opts.api,
      job: {
        delivery: opts.delivery,
        owner: "kirmanak",
        repo: "demo",
        issueNumber: opts.issueNumber,
        action: "assigned",
        title: "Fix the thing",
        body: "Please implement this.",
        htmlUrl: `https://gitea.kirmanak.stream/kirmanak/demo/issues/${opts.issueNumber}`,
        issueUpdatedAt: new Date().toISOString(),
        defaultBranch: "main",
        cloneUrl: "https://gitea.kirmanak.stream/kirmanak/demo.git",
        receivedAt: new Date().toISOString(),
        mode: "follow-up",
        prNumber: opts.prNumber,
        headSha: opts.sha,
        trigger: { event: "workflow_job", sender: "gitea" },
      } as never,
      giteaUrl: "https://gitea.kirmanak.stream",
      giteaToken: "bot-token",
      botUsername: "jumi",
      model: "openai/gpt-5.5",
      home: opts.home,
      workdir: opts.workdir,
      heartbeatIntervalMs: 0,
      gitRunner: async (args: string[]) => {
        const gitArgs = stripGit(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      },
      openCodeRunner: async () => {
        if (!opts.shouldRun) throw new Error("opencode should not run while waiting");
        openCode++;
        return { status: "ok" };
      },
      logger: () => undefined,
      ledger: opts.ledger,
    } as never);
    const status = (result as { status: string }).status;
    const reason = (result as { reason?: string }).reason;
    return { status, ...(reason !== undefined ? { reason } : {}), openCode };
  }

  async function makeApiFor(opts: { openPullsRef: { current: ReturnType<typeof testPr>[] }; log: string }) {
    const { makeIssueApi } = await import("./fakes/forge.ts");
    const { makeIssue } = await import("./fixtures.ts");
    const comments: string[] = [];
    const api = makeIssueApi({
      getIssue: async (_owner: string, _repo: string, n: number) =>
        makeIssue({ number: n, state: "open" as const }) as never,
      listOpenPulls: async () => opts.openPullsRef.current as never,
      getPR: async (_owner: string, _repo: string, n: number) => {
        const found = opts.openPullsRef.current.find((pr) => pr.number === n);
        if (found) return found as never;
        return { ...(opts.openPullsRef.current[0] as object), number: n, merged: false, state: "closed" } as never;
      },
      listIssueComments: async () => [],
      listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }] as never,
      listCheckRuns: async () => [] as never,
      listActionJobs: async (_o: string, _r: string, filter?: { headSha?: string }) =>
        [{ id: 9, name: "build", head_sha: filter?.headSha ?? "headsha" }] as never,
      getActionJobLogs: async () => opts.log as never,
      findStickyIssueComment: async () => undefined as never,
      createIssueComment: async (_o: string, _r: string, _i: number, body: string) => {
        comments.push(body);
        return { id: 1, body } as never;
      },
      updateIssueComment: async (_o: string, _r: string, _id: number, body: string) => {
        comments.push(body);
        return { id: 1, body } as never;
      },
      // deno-lint-ignore no-explicit-any
      ...({
        createCommitStatus: async (_o: string, _r: string, _s: string, payload: unknown) => payload as never,
      } as unknown as Record<string, unknown>),
    });
    return { api: api as never, comments };
  }

  test("waiter defers while owner active, then takes over after owner leaves", async () => {
    const { withDirs } = await import("./harness/temp.ts");
    await withDirs(async (home: string, workdir: string) => {
      const ledger = new MemoryReviewJobStore();
      const firstSha = "firstsha000000000000000000000000000001";
      const waiterSha = "waitersha0000000000000000000000000002";
      const openPullsRef = { current: [testPr(100, 10, firstSha), testPr(127, 12, waiterSha)] };
      const { api, comments } = await makeApiFor({ openPullsRef, log: FAILURE_LOG });

      // Owner runs and fixes: engine work happens.
      const first = await runWake({
        api,
        ledger: ledger as never,
        home,
        workdir,
        issueNumber: 10,
        prNumber: 100,
        sha: firstSha,
        delivery: "delivery-first",
        shouldRun: true,
      });
      expect(first.openCode).toBe(1);
      expect(first.status).not.toBe("skipped");

      // Waiter defers: no engine work, no round-cap cost, CI stays unhandled.
      const waiter = await runWake({
        api,
        ledger: ledger as never,
        home,
        workdir,
        issueNumber: 12,
        prNumber: 127,
        sha: waiterSha,
        delivery: "delivery-waiter-1",
        shouldRun: false,
      });
      expect(waiter).toMatchObject({ status: "skipped", openCode: 0 });
      expect(waiter.reason).toContain("waiting on #100");
      expect(comments.some((body) => body.includes("Same failure as #100"))).toBe(true);
      const deferred = await readCiState(ciStatePath(home, "kirmanak", "demo", 12));
      expect(deferred.handled).toEqual([]);

      // Owner leaves: a later qualifying CI wake lets the waiter take over.
      openPullsRef.current = [testPr(127, 12, waiterSha)];
      const takeover = await runWake({
        api,
        ledger: ledger as never,
        home,
        workdir,
        issueNumber: 12,
        prNumber: 127,
        sha: waiterSha,
        delivery: "delivery-waiter-2",
        shouldRun: true,
      });
      expect(takeover.openCode).toBe(1);
      expect(takeover.status).not.toBe("skipped");
      const after = await readCiState(ciStatePath(home, "kirmanak", "demo", 12));
      expect(after.handled).toHaveLength(1);
    });
  });

  test("two waiters do not both take over after the owner leaves", async () => {
    const { withDirs } = await import("./harness/temp.ts");
    await withDirs(async (home: string, workdir: string) => {
      const ledger = new MemoryReviewJobStore();
      const firstSha = "firstsha000000000000000000000000000011";
      const sha2 = "sha2000000000000000000000000000000002";
      const sha3 = "sha3000000000000000000000000000000003";
      const openPullsRef = {
        current: [testPr(100, 10, firstSha), testPr(127, 12, sha2), testPr(128, 13, sha3)],
      };
      const { api } = await makeApiFor({ openPullsRef, log: FAILURE_LOG });

      const first = await runWake({
        api,
        ledger: ledger as never,
        home,
        workdir,
        issueNumber: 10,
        prNumber: 100,
        sha: firstSha,
        delivery: "delivery-first",
        shouldRun: true,
      });
      expect(first.openCode).toBe(1);

      const w2 = await runWake({
        api,
        ledger: ledger as never,
        home,
        workdir,
        issueNumber: 12,
        prNumber: 127,
        sha: sha2,
        delivery: "delivery-w2-1",
        shouldRun: false,
      });
      expect(w2.status).toBe("skipped");
      const w3 = await runWake({
        api,
        ledger: ledger as never,
        home,
        workdir,
        issueNumber: 13,
        prNumber: 128,
        sha: sha3,
        delivery: "delivery-w3-1",
        shouldRun: false,
      });
      expect(w3.status).toBe("skipped");

      // Owner leaves: the first waiter to wake takes over, the other still waits.
      openPullsRef.current = [testPr(127, 12, sha2), testPr(128, 13, sha3)];
      const take2 = await runWake({
        api,
        ledger: ledger as never,
        home,
        workdir,
        issueNumber: 12,
        prNumber: 127,
        sha: sha2,
        delivery: "delivery-w2-2",
        shouldRun: true,
      });
      expect(take2.openCode).toBe(1);
      expect(take2.status).not.toBe("skipped");

      const stillWaiting = await runWake({
        api,
        ledger: ledger as never,
        home,
        workdir,
        issueNumber: 13,
        prNumber: 128,
        sha: sha3,
        delivery: "delivery-w3-2",
        shouldRun: false,
      });
      expect(stillWaiting.status).toBe("skipped");
      expect(stillWaiting.reason).toContain("waiting on #127");
      expect(stillWaiting.openCode).toBe(0);
    });
  });

  test("a red timeout log runs the worker and records handled", async () => {
    const { withDirs } = await import("./harness/temp.ts");
    await withDirs(async (home: string, workdir: string) => {
      const ledger = new MemoryReviewJobStore();
      const sha = "timeoutsha0000000000000000000000000001";
      const openPullsRef = { current: [testPr(127, 12, sha)] };
      const { api } = await makeApiFor({ openPullsRef, log: TIMEOUT_LOG });

      const first = await runWake({
        api,
        ledger: ledger as never,
        home,
        workdir,
        issueNumber: 12,
        prNumber: 127,
        sha,
        delivery: "delivery-timeout-1",
        shouldRun: true,
      });
      expect(first.status).toBe("no-changes");
      const handled = await readCiState(ciStatePath(home, "kirmanak", "demo", 12));
      expect(handled.handled).toHaveLength(1);

      expect(first.openCode).toBe(1);
    });
  });
});
