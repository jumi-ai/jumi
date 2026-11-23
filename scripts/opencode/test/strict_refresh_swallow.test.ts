import { describe, expect, test } from "bun:test";
import { hasLabel } from "../src/assignee.ts";
import { implementConflict } from "../src/conflict.ts";
import { implementFollowUp } from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { issueJobFromRecord, MemoryReviewJobStore, WORKER_JOB_KINDS, workerJobKey } from "../src/review_jobs.ts";
import { standingPodRuntime } from "../src/runtime.ts";
import { shouldEnqueueStrictRefreshOnPush } from "../src/strict_refresh.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeComment, makeIssue, makeIssueJob, makePR, makePushPayload, makeRepo, makeUser } from "./fixtures.ts";
import { withDirs } from "./harness/temp.ts";

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function jumiPr() {
  const repo = makeRepo();
  return makePR({
    number: 127,
    title: "Fix the thing",
    body: "Fixes #12",
    user: makeUser({ login: "jumi" }),
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    head: {
      label: "kirmanak:jumi/issue-12-fix-the-thing",
      ref: "jumi/issue-12-fix-the-thing",
      sha: "headsha",
      repo,
      repo_id: repo.id,
    },
  });
}

/** Same behind-but-clean PR the strict refresh path sees: behind is carried by `strictBaseSha`, not the PR shape. */
function strictPr() {
  return Object.assign(jumiPr(), { autoMergeEnabled: true });
}

function forgeApi(
  overrides: Partial<IssueApi> = {}
): IssueApi & { comments: string[]; pulls: unknown[]; commentIndexes: number[] } {
  const comments: string[] = [];
  const pulls: unknown[] = [];
  const commentIndexes: number[] = [];
  const fake = makeIssueApi({
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [strictPr()],
    getPR: async () => strictPr() as never,
    getBranch: async () => ({ protected: true, strict: true }) as never,
    createPullRequest: async (_owner, _repo, pull) => {
      pulls.push(pull);
      return makePR({ number: 3, title: pull.title, body: pull.body });
    },
    createIssueComment: async (_owner, _repo, index, body) => {
      commentIndexes.push(index);
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    ...overrides,
  });
  return Object.assign(fake, { comments, pulls, commentIndexes });
}

function conflictJob(overrides: Parameters<typeof makeIssueJob>[0] = {}) {
  return makeIssueJob({
    mode: "conflict",
    prNumber: 127,
    headSha: "headsha",
    action: "push",
    trigger: { event: "push", sender: "alice" },
    ...overrides,
  });
}

function strictMergeOnlyJob(overrides: Parameters<typeof makeIssueJob>[0] = {}) {
  return makeIssueJob({
    mode: "follow-up",
    prNumber: 127,
    headSha: "headsha",
    action: "push",
    trigger: { event: "push", sender: "alice" },
    mergeOnly: true,
    strictRefresh: true,
    strictBaseSha: "basesha-new",
    ...overrides,
  });
}

/** Behind but cleanly mergeable: the default is not an ancestor, the merge itself succeeds with no conflicts. */
function cleanMergeableGit(extra: GitRunner = async () => ""): GitRunner {
  return async (args, opts) => {
    const gitArgs = stripGitConfigArgs(args);
    if (gitArgs[0] === "merge-base" && gitArgs.includes("--is-ancestor") && gitArgs.includes("HEAD")) {
      throw new Error("git merge-base --is-ancestor failed with exit code 1");
    }
    if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha-new";
    if (gitArgs[0] === "rev-parse" && gitArgs.includes("MERGE_HEAD")) return "mergehead";
    if (gitArgs[0] === "rev-parse") return "headsha";
    if (gitArgs[0] === "diff") return "";
    if (gitArgs[0] === "grep") return "";
    return extra(args, opts);
  };
}

/** Already up to date: the default is an ancestor of the head. */
function upToDateGit(extra: GitRunner = async () => ""): GitRunner {
  return async (args, opts) => {
    const gitArgs = stripGitConfigArgs(args);
    if (gitArgs[0] === "merge-base" && gitArgs.includes("--is-ancestor")) return "";
    if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha-new";
    if (gitArgs[0] === "rev-parse") return "headsha";
    return extra(args, opts);
  };
}

function mergeOnlyRuntime() {
  return {
    ...standingPodRuntime,
    ensureBareCache: async () => undefined,
    attachPrWorktree: async () => ({}),
    destroyRuntimeWorkspace: async () => undefined,
  } as never;
}

describe("strict refresh swallowed by the same-push conflict job (#784)", () => {
  test("merge-only and strict-refresh intent survives ledger persistence", async () => {
    const store = new MemoryReviewJobStore();
    const job = strictMergeOnlyJob({ delivery: "push-delivery-1" });
    const enqueued = await store.enqueueIssue(job);
    expect(enqueued).toEqual({ key: workerJobKey(job), queued: true });

    const leased = await store.lease("worker-1", 60_000, new Date(), ["follow-up"]);
    if (!leased) throw new Error("expected a follow-up lease");
    const restored = issueJobFromRecord(leased);
    expect(restored.mergeOnly).toBe(true);
    expect(restored.strictRefresh).toBe(true);
    expect(restored.strictBaseSha).toBe("basesha-new");
  });

  test("same-delivery conflict and strict merge-only pair both queue without dedupe", async () => {
    const store = new MemoryReviewJobStore();
    const delivery = "push-delivery-1";
    const conflict = await store.enqueueIssue(conflictJob({ delivery }));
    const strict = await store.enqueueIssue(strictMergeOnlyJob({ delivery }));
    expect(conflict.queued).toBe(true);
    expect(strict.queued).toBe(true);
    expect(conflict.key).not.toBe(strict.key);
  });

  test("already-leased retry keeps merge-only semantics and is not cancelled by conflict success", async () => {
    const store = new MemoryReviewJobStore();
    const delivery = "push-delivery-1";
    await store.enqueueIssue(conflictJob({ delivery }));
    await store.enqueueIssue(strictMergeOnlyJob({ delivery }));

    // The conflict job wins the lease race first.
    const first = await store.lease("conflict-pod", 60_000, new Date(), [...WORKER_JOB_KINDS]);
    expect(first?.kind).toBe("conflict");

    // The strict follow-up cannot lease while the conflict holds the issue.
    const strictRow = store.rows.find((row) => row.jobKey.startsWith("follow-up:"));
    if (!strictRow) throw new Error("expected a queued strict follow-up row");
    const raced = await store.leaseJobById(strictRow.id, "followup-pod", 60_000, new Date());
    expect(raced.leased).toBe(false);
    if (!raced.leased) expect(raced.reason).toContain("already leased");

    // The conflict reports up-to-date (clean merge discarded under
    // skipCleanMerge): the pending strict refresh must survive it.
    const conflictRow = store.rows.find((row) => row.jobKey.startsWith("conflict:"));
    if (!conflictRow) throw new Error("expected a leased conflict row");
    await store.saveResult(conflictRow.id, "conflict-pod", { kind: "skip", reason: "up-to-date" });
    await store.markPublished(conflictRow.id, "conflict-pod", { state: "skipped", reason: "up-to-date" });
    const stillQueued = store.rows.find((row) => row.jobKey.startsWith("follow-up:"));
    expect(stillQueued?.state).toBe("queued");

    // The retry after the writer finishes still runs as a merge-only refresh.
    const retry = await store.lease("followup-pod", 60_000, new Date(), [...WORKER_JOB_KINDS]);
    if (!retry) throw new Error("expected the strict follow-up to lease after the conflict finished");
    const restored = issueJobFromRecord(retry);
    expect(restored.mergeOnly).toBe(true);
    expect(restored.strictRefresh).toBe(true);
    expect(restored.strictBaseSha).toBe("basesha-new");
  });

  test("conflict first: clean merge discarded, strict follow-up pushes the merge", async () => {
    await withDirs(async (home, workdir) => {
      const api = forgeApi();
      const conflictCalls: string[][] = [];
      const conflictResult = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        useClaim: false,
        gitRunner: cleanMergeableGit(async (args, opts) => {
          const gitArgs = stripGitConfigArgs(args);
          conflictCalls.push(gitArgs);
          return "";
        }),
        openCodeRunner: async () => {
          throw new Error("model should not run for a clean merge");
        },
        logger: () => undefined,
      });
      expect(conflictResult).toEqual({ status: "up-to-date" });
      expect(conflictCalls.some((args) => args[0] === "push")).toBe(false);

      const pushCalls: string[][] = [];
      const strictResult = await implementFollowUp({
        api,
        job: strictMergeOnlyJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        useClaim: false,
        runtime: mergeOnlyRuntime(),
        gitRunner: cleanMergeableGit(async (args, opts) => {
          const gitArgs = stripGitConfigArgs(args);
          pushCalls.push(gitArgs);
          if (gitArgs[0] === "push") return "";
          return "";
        }),
        openCodeRunner: async () => {
          throw new Error("model should not run for a clean strict refresh");
        },
        logger: () => undefined,
      });
      expect(strictResult).toEqual({
        status: "pushed",
        prNumber: 127,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
      });
      expect(pushCalls.some((args) => args[0] === "push" && args.includes("jumi/issue-12-fix-the-thing"))).toBe(true);
    });
  });

  test("strict follow-up first: merge pushed, conflict afterwards is a no-op", async () => {
    await withDirs(async (home, workdir) => {
      const api = forgeApi();
      const pushCalls: string[][] = [];
      const strictResult = await implementFollowUp({
        api,
        job: strictMergeOnlyJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        useClaim: false,
        runtime: mergeOnlyRuntime(),
        gitRunner: cleanMergeableGit(async (args, opts) => {
          const gitArgs = stripGitConfigArgs(args);
          pushCalls.push(gitArgs);
          if (gitArgs[0] === "push") return "";
          return "";
        }),
        openCodeRunner: async () => {
          throw new Error("model should not run for a clean strict refresh");
        },
        logger: () => undefined,
      });
      expect(strictResult.status).toBe("pushed");
      const pushes = pushCalls.filter((args) => args[0] === "push");
      expect(pushes).toHaveLength(1);

      const conflictResult = await implementConflict({
        api,
        job: conflictJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        useClaim: false,
        gitRunner: upToDateGit(async () => ""),
        openCodeRunner: async () => {
          throw new Error("model should not run on an up-to-date head");
        },
        logger: () => undefined,
      });
      expect(conflictResult).toEqual({ status: "up-to-date" });
    });
  });
});

describe("strict refresh pickup gate on Jumi closers (#814)", () => {
  // GitHub production pickup: the `jumi` label, not assignment. The closing
  // issue carries it; the PR itself does not.
  const labelPickup = (issue: { labels?: unknown }) => hasLabel(issue as never, "jumi");
  const strictPolicy = {
    giteaUrl: "https://gitea.kirmanak.stream",
    allowedOrgs: ["kirmanak"],
    allowedRepos: [],
    botUsername: "jumi",
    isPickedUp: labelPickup,
  } as never;

  function closerPr() {
    const repo = makeRepo();
    return Object.assign(
      makePR({
        number: 803,
        title: "Do the thing",
        body: "Fixes #802",
        user: makeUser({ login: "jumi" }),
        html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/803",
        labels: [],
        head: {
          label: "kirmanak:jumi/issue-802-do-the-thing",
          ref: "jumi/issue-802-do-the-thing",
          sha: "headsha",
          repo,
          repo_id: repo.id,
        },
      }),
      { autoMergeEnabled: true }
    );
  }

  function closingIssue() {
    return makeIssue({
      number: 802,
      title: "Do the thing",
      assignee: null,
      assignees: [],
      labels: [{ name: "jumi" }],
    });
  }

  function prAsIssue() {
    return makeIssue({ number: 803, state: "open", assignee: null, assignees: [], labels: [] });
  }

  function labelApi(pr: ReturnType<typeof closerPr>, issue802: ReturnType<typeof closingIssue>) {
    return forgeApi({
      getIssue: async (_owner, _repo, index) => (index === 802 ? issue802 : prAsIssue()),
      listOpenPulls: async () => [pr],
      getPR: async () => pr as never,
      getBranch: async () => ({ protected: true, strict: true }) as never,
    });
  }

  function strictCloserJob() {
    return makeIssueJob({
      issueNumber: 802,
      mode: "follow-up",
      prNumber: 803,
      headSha: "headsha",
      action: "push",
      trigger: { event: "push", sender: "alice" },
      mergeOnly: true,
      strictRefresh: true,
      strictBaseSha: "basesha-new",
    });
  }

  test("enqueue keys a Jumi closer to its closing issue, not the PR number", async () => {
    const pr = closerPr();
    const api = forgeApi({
      listOpenPulls: async () => [pr],
      getBranch: async () => ({ protected: true, strict: true }) as never,
    });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      makePushPayload({ after: "basesha-new" }),
      strictPolicy,
      api
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prNumber).toBe(803);
    expect(jobs[0]?.issueNumber).toBe(802);
  });

  test("behind Jumi closer without a PR pickup label still gets the merge pushed", async () => {
    await withDirs(async (home, workdir) => {
      const pr = closerPr();
      const api = labelApi(pr, closingIssue());
      const pushCalls: string[][] = [];
      const result = await implementFollowUp({
        api,
        job: strictCloserJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        isPickedUp: labelPickup,
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        useClaim: false,
        runtime: mergeOnlyRuntime(),
        gitRunner: cleanMergeableGit(async (args, opts) => {
          const gitArgs = stripGitConfigArgs(args);
          pushCalls.push(gitArgs);
          if (gitArgs[0] === "push") return "";
          return "";
        }),
        openCodeRunner: async () => {
          throw new Error("model should not run for a clean strict refresh");
        },
        logger: () => undefined,
      });
      expect(result).toEqual({
        status: "pushed",
        prNumber: 803,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/803",
      });
      expect(pushCalls.some((args) => args[0] === "push" && args.includes("jumi/issue-802-do-the-thing"))).toBe(true);
    });
  });

  test("Renovate case (pickup label on the PR itself) still refreshes", async () => {
    await withDirs(async (home, workdir) => {
      const repo = makeRepo();
      const pr = Object.assign(
        makePR({
          number: 804,
          title: "Update postgres Docker tag to v19",
          body: "Update postgres Docker tag to v19",
          user: makeUser({ login: "renovate" }),
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/804",
          labels: [{ name: "jumi" }],
          head: {
            label: "kirmanak:renovate/postgres-19",
            ref: "renovate/postgres-19",
            sha: "headsha",
            repo,
            repo_id: repo.id,
          },
        }),
        { autoMergeEnabled: true }
      );
      const api = forgeApi({
        getIssue: async () => makeIssue({ number: 804, assignee: null, assignees: [], labels: [{ name: "jumi" }] }),
        listOpenPulls: async () => [pr],
        getPR: async () => pr as never,
        getBranch: async () => ({ protected: true, strict: true }) as never,
      });
      const { jobs } = await shouldEnqueueStrictRefreshOnPush(
        makePushPayload({ after: "basesha-new" }),
        strictPolicy,
        api
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.issueNumber).toBe(804);
      const pushCalls: string[][] = [];
      const result = await implementFollowUp({
        api,
        job: makeIssueJob({
          issueNumber: 804,
          mode: "follow-up",
          prNumber: 804,
          headSha: "headsha",
          action: "push",
          trigger: { event: "push", sender: "alice" },
          mergeOnly: true,
          strictRefresh: true,
          strictBaseSha: "basesha-new",
        }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        isPickedUp: labelPickup,
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        useClaim: false,
        runtime: mergeOnlyRuntime(),
        gitRunner: cleanMergeableGit(async (args, opts) => {
          const gitArgs = stripGitConfigArgs(args);
          pushCalls.push(gitArgs);
          if (gitArgs[0] === "push") return "";
          return "";
        }),
        openCodeRunner: async () => {
          throw new Error("model should not run for a clean strict refresh");
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      expect(pushCalls.some((args) => args[0] === "push" && args.includes("renovate/postgres-19"))).toBe(true);
    });
  });

  test("unpicked closing issue ends skipped with a reason, not a bare cancel", async () => {
    await withDirs(async (home, workdir) => {
      const pr = closerPr();
      const api = labelApi(pr, makeIssue({ number: 802, assignee: null, assignees: [], labels: [] }));
      const result = await implementFollowUp({
        api,
        job: strictCloserJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        isPickedUp: labelPickup,
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        useClaim: false,
        runtime: mergeOnlyRuntime(),
        gitRunner: async () => {
          throw new Error("git should not run when the pickup gate fails");
        },
        openCodeRunner: async () => {
          throw new Error("model should not run when the pickup gate fails");
        },
        logger: () => undefined,
      });
      expect(result).toEqual({
        status: "skipped",
        reason: "strict refresh: closing issue not picked up or closed",
      });
    });
  });
});
