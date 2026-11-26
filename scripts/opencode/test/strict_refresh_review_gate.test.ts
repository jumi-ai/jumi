import { describe, expect, test } from "bun:test";
import { parseJumiReviewSuccessFinish } from "../src/ci_webhook.ts";
import type { Check, Pull } from "../src/ports.ts";
import {
  enqueueStrictRefreshForGreenReview,
  isReviewReadyForStrictRefresh,
  readStrictReviewGreen,
  recheckStrictRefreshEligibility,
  type StrictReviewGreen,
  shouldEnqueueStrictRefreshForPR,
  shouldEnqueueStrictRefreshOnPush,
  shouldEnqueueStrictRefreshOnReviewGreen,
} from "../src/strict_refresh.ts";
import { MemoryStrictRefreshSlotStore } from "../src/strict_refresh_queue.ts";
import { expireStrictRefreshSlotsOnTick, isStrictRefreshRetryableSkipReason } from "../src/strict_refresh_terminal.ts";
import type { IssueJob } from "../src/types.ts";

function reviewCheck(state: string): Check {
  return { context: "jumi/opencode-review", state: state as Check["state"], status: state as Check["state"] };
}

function githubPull(number: number, overrides: Partial<Pull> = {}): Pull {
  const issue = 1000 + number;
  return {
    number,
    title: `Fix ${number}`,
    body: `Fixes #${issue}`,
    state: "open",
    html_url: `https://github.com/o/r/pull/${number}`,
    user: { login: "jumi" },
    head: {
      ref: `jumi/issue-${issue}-fix`,
      sha: `head-${number}`,
      repo: { full_name: "o/r", clone_url: "https://github.com/o/r.git" },
    },
    base: { ref: "main", sha: "base-1" },
    merged: false,
    draft: false,
    autoMergeEnabled: true,
    mergeableState: "behind",
    created_at: new Date(Date.UTC(2026, 4, 23, 0, 0, number)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 4, 23, 0, 0, number)).toISOString(),
    ...overrides,
  };
}

function giteaPull(number: number, overrides: Partial<Pull> = {}): Pull {
  return githubPull(number, {
    html_url: `https://gitea.example.test/o/r/pulls/${number}`,
    ...overrides,
  });
}

function pushPayload(after = "base-2") {
  return {
    ref: "refs/heads/main",
    before: "base-1",
    after,
    repository: {
      full_name: "o/r",
      default_branch: "main",
      clone_url: "https://github.com/o/r.git",
    },
    pusher: { login: "alice" },
    sender: { login: "alice" },
  } as never;
}

function giteaPushPayload(after = "base-2") {
  return {
    ref: "refs/heads/main",
    before: "base-1",
    after,
    repository: {
      full_name: "o/r",
      default_branch: "main",
      clone_url: "https://gitea.example.test/o/r.git",
    },
    pusher: { login: "alice" },
    sender: { login: "alice" },
  } as never;
}

const githubPolicy = {
  giteaUrl: "https://github.com",
  allowedOrgs: ["o"],
  allowedRepos: [],
  botUsername: "jumi",
} as never;

const giteaPolicy = {
  giteaUrl: "https://gitea.example.test",
  allowedOrgs: ["o"],
  allowedRepos: [],
  botUsername: "jumi",
  forgeKind: "gitea",
} as never;

function githubApi(opts: { pulls: Pull[]; statuses: Record<string, Check[]> | "throw"; requiredContexts?: string[] }) {
  return {
    listOpenPulls: async () => opts.pulls,
    getPR: async (_o: string, _r: string, index: number) => {
      const found = opts.pulls.find((pr) => pr.number === index);
      if (!found) throw new Error(`GitHub pull request #${index} unreadable`);
      return found;
    },
    getBranch: async () => ({
      protected: true,
      strict: true,
      sha: "base-2",
      requiredContexts: opts.requiredContexts ?? ["ci"],
    }),
    listCommitStatuses: async (_o: string, _r: string, sha: string) => {
      if (opts.statuses === "throw") throw new Error("GitHub GET /repos/o/r/commits/x/status → 503: boom");
      return opts.statuses[sha] ?? [];
    },
    listCheckRuns: async () => [],
    getRepoFile: async () => ({ found: false }),
    getRepo: async () => ({
      full_name: "o/r",
      html_url: "https://github.com/o/r",
      clone_url: "https://github.com/o/r.git",
      default_branch: "main",
    }),
  } as never;
}

function giteaApi(opts: {
  pulls: Pull[];
  statuses: Record<string, Check[]> | "throw";
  scheduled?: boolean;
  behind?: number;
}) {
  const { scheduled = true, behind = 2 } = opts;
  return {
    capabilities: { kind: "gitea" },
    listOpenPulls: async () => opts.pulls,
    getPR: async (_o: string, _r: string, index: number) => {
      const found = opts.pulls.find((pr) => pr.number === index);
      if (!found) throw new Error(`Gitea pull request #${index} unreadable`);
      return found;
    },
    getBranch: async () => ({ protected: true, strict: true, sha: "base-2" }) as never,
    listIssueTimeline: async () =>
      scheduled ? [{ type: "pull_scheduled_merge" }] : [{ type: "pull_cancel_scheduled_merge" }],
    compareCommits: async () => ({ totalCommits: behind }),
    listCommitStatuses: async (_o: string, _r: string, sha: string) => {
      if (opts.statuses === "throw") throw new Error("Gitea API GET /repos/o/r/commits/x/statuses → 503: boom");
      return opts.statuses[sha] ?? [];
    },
    listCheckRuns: async () => [],
    getRepoFile: async () => ({ found: false }),
    getRepo: async () => ({
      full_name: "o/r",
      html_url: "https://gitea.example.test/o/r",
      clone_url: "https://gitea.example.test/o/r.git",
      default_branch: "main",
    }),
  } as never;
}

describe("review gate on push, github fake (#900)", () => {
  test("pending review is not refreshed", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("pending")] } });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), githubPolicy, api, undefined, slots, 1_000);
    expect(jobs).toHaveLength(0);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
    expect(await slots.getTerminal("o", "r", "main")).toBeUndefined();
  });

  test("failing review is not refreshed", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("failure")] } });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), githubPolicy, api, undefined, slots, 1_000);
    expect(jobs).toHaveLength(0);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
  });

  test("missing review is not refreshed", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: {} });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), githubPolicy, api, undefined, slots, 1_000);
    expect(jobs).toHaveLength(0);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
  });

  test("green review is refreshed", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), githubPolicy, api, undefined, slots, 1_000);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prNumber).toBe(100);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
  });

  test("unreadable review statuses fail closed without terminal evidence", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: "throw" });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(pushPayload(), githubPolicy, api, undefined, slots, 1_000);
    expect(jobs).toHaveLength(0);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
    expect(await slots.getTerminal("o", "r", "main")).toBeUndefined();
  });

  test("pending follow-up blocks a green head", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      pushPayload(),
      githubPolicy,
      api,
      undefined,
      slots,
      1_000,
      async () => true
    );
    expect(jobs).toHaveLength(0);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
  });
});

describe("review gate on push, gitea fake (#900)", () => {
  test("pending review is not refreshed", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = giteaApi({ pulls: [giteaPull(100)], statuses: { "head-100": [reviewCheck("pending")] } });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      giteaPushPayload(),
      giteaPolicy,
      api,
      undefined,
      slots,
      1_000
    );
    expect(jobs).toHaveLength(0);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
  });

  test("failing review is not refreshed", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = giteaApi({ pulls: [giteaPull(100)], statuses: { "head-100": [reviewCheck("failure")] } });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      giteaPushPayload(),
      giteaPolicy,
      api,
      undefined,
      slots,
      1_000
    );
    expect(jobs).toHaveLength(0);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
  });

  test("green review is refreshed", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = giteaApi({ pulls: [giteaPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      giteaPushPayload(),
      giteaPolicy,
      api,
      undefined,
      slots,
      1_000
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.prNumber).toBe(100);
  });

  test("pending follow-up blocks a green head", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = giteaApi({ pulls: [giteaPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const { jobs } = await shouldEnqueueStrictRefreshOnPush(
      giteaPushPayload(),
      giteaPolicy,
      api,
      undefined,
      slots,
      1_000,
      async () => true
    );
    expect(jobs).toHaveLength(0);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
  });
});

describe("review gate on PR activity (#900)", () => {
  test("github: red head never enqueues, green head does", async () => {
    const redApi = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("failure")] } });
    const red = await shouldEnqueueStrictRefreshForPR({
      pr: githubPull(100),
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: githubPolicy,
      api: redApi,
    });
    expect(red).toBeNull();

    const greenApi = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const green = await shouldEnqueueStrictRefreshForPR({
      pr: githubPull(100),
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: githubPolicy,
      api: greenApi,
    });
    expect(green?.mergeOnly).toBe(true);
    expect(green?.strictRefresh).toBe(true);
  });

  test("gitea: red head never enqueues, green head does", async () => {
    const redApi = giteaApi({ pulls: [giteaPull(100)], statuses: { "head-100": [reviewCheck("failure")] } });
    const red = await shouldEnqueueStrictRefreshForPR({
      pr: giteaPull(100),
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: giteaPolicy,
      api: redApi,
    });
    expect(red).toBeNull();

    const greenApi = giteaApi({ pulls: [giteaPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const green = await shouldEnqueueStrictRefreshForPR({
      pr: giteaPull(100),
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      cloneUrl: "https://github.com/o/r.git",
      policy: giteaPolicy,
      api: greenApi,
    });
    expect(green?.mergeOnly).toBe(true);
  });
});

describe("review-green wake without a target push (#900)", () => {
  const wakeOpts = (api: never) => ({
    owner: "o",
    repo: "r",
    prNumber: 100,
    headSha: "head-100",
    defaultBranch: "main",
    cloneUrl: "https://github.com/o/r.git",
    policy: githubPolicy,
    api: api as never,
    nowMs: 1_000,
  });

  test("behind plus green enqueues without any push", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const { job, deferred } = await shouldEnqueueStrictRefreshOnReviewGreen({
      ...wakeOpts(api),
      slots,
    });
    expect(deferred).toBe(false);
    expect(job?.prNumber).toBe(100);
    expect(job?.mergeOnly).toBe(true);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
  });

  test("up-to-date head wakes nothing", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({
      pulls: [githubPull(100, { mergeableState: "clean" })],
      statuses: { "head-100": [reviewCheck("success")] },
    });
    const { job, deferred } = await shouldEnqueueStrictRefreshOnReviewGreen({
      ...wakeOpts(api),
      slots,
    });
    expect(job).toBeNull();
    expect(deferred).toBe(false);
    expect(await slots.getSlot("o", "r", "main")).toBeUndefined();
  });

  test("red head wakes nothing", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("failure")] } });
    const { job, deferred } = await shouldEnqueueStrictRefreshOnReviewGreen({
      ...wakeOpts(api),
      slots,
    });
    expect(job).toBeNull();
    expect(deferred).toBe(false);
  });

  test("fix loop in flight wakes nothing", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const { job, deferred } = await shouldEnqueueStrictRefreshOnReviewGreen({
      ...wakeOpts(api),
      slots,
      hasPendingFollowUp: async () => true,
    });
    expect(job).toBeNull();
    expect(deferred).toBe(false);
  });

  test("forge error on the first attempt defers; the tick retries into a job", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    let failReads = true;
    const flaky = {
      listOpenPulls: async () => [githubPull(100)],
      getPR: async () => {
        if (failReads) throw new Error("GitHub GET /repos/o/r/pulls/100 → 503: boom");
        return githubPull(100);
      },
      getBranch: async () => ({ protected: true, strict: true, sha: "base-2", requiredContexts: ["ci"] }),
      listCommitStatuses: async () => {
        if (failReads) throw new Error("GitHub GET /repos/o/r/commits/head-100/status → 503: boom");
        return [reviewCheck("success")];
      },
      listCheckRuns: async () => [],
      getRepoFile: async () => ({ found: false }),
      getRepo: async () => ({
        full_name: "o/r",
        html_url: "https://github.com/o/r",
        clone_url: "https://github.com/o/r.git",
        default_branch: "main",
      }),
    } as never;
    const first = await shouldEnqueueStrictRefreshOnReviewGreen({ ...wakeOpts(flaky), slots, baseBranch: "main" });
    expect(first.job).toBeNull();
    expect(first.deferred).toBe(true);
    expect(await slots.listAdmitNextDue(1_000)).toHaveLength(1);

    // The forge heals: the tick drains the durable wake into a job.
    failReads = false;
    const enqueued: IssueJob[] = [];
    const summary = await expireStrictRefreshSlotsOnTick({
      slots,
      api: flaky,
      policy: githubPolicy,
      enqueueIssue: async (job) => {
        enqueued.push(job);
        return { queued: true, key: `k-${job.prNumber}` };
      },
      nowMs: 2_000,
    });
    expect(summary.enqueued).toBe(1);
    expect(enqueued[0]?.prNumber).toBe(100);
    expect(enqueued[0]?.strictRefresh).toBe(true);
    expect(await slots.listAdmitNextDue(2_000)).toHaveLength(0);
  });

  test("a held slot is never clobbered by a deferred wake", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    await slots.tryAdmit({
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 200,
      headSha: "head-200",
      baseSha: "base-1",
      admittedAtMs: 500,
      updatedAtMs: 500,
    });
    const throwing = {
      listOpenPulls: async () => [githubPull(100)],
      getPR: async () => {
        throw new Error("GitHub GET /repos/o/r/pulls/100 → 503: boom");
      },
    } as never;
    const { job, deferred } = await shouldEnqueueStrictRefreshOnReviewGreen({
      ...wakeOpts(throwing),
      slots,
      baseBranch: "main",
    });
    expect(job).toBeNull();
    expect(deferred).toBe(false);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(200);
    expect(await slots.listAdmitNextDue(1_000)).toHaveLength(0);
  });
});

describe("shared status-event entry (#900)", () => {
  const statusPayload = (state: string, context = "jumi/opencode-review") =>
    new TextEncoder().encode(
      JSON.stringify({
        sha: "head-100",
        state,
        context,
        repository: { full_name: "o/r" },
        sender: { login: "alice" },
      })
    );

  test("green status queues the refresh on the github fake", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const queued: IssueJob[] = [];
    const outcome = await enqueueStrictRefreshForGreenReview({
      rawBody: statusPayload("success"),
      delivery: "d1",
      api,
      policy: githubPolicy,
      slots,
      log: () => undefined,
      enqueue: async (job) => {
        queued.push(job);
        return { queued: true, key: `strict:${job.prNumber}` };
      },
    });
    expect(outcome.outcome).toBe("queued");
    expect(outcome.key).toBe("strict:100");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.strictRefresh).toBe(true);
  });

  test("pending status and foreign contexts fall through", async () => {
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    for (const rawBody of [statusPayload("pending"), statusPayload("success", "ci")]) {
      const outcome = await enqueueStrictRefreshForGreenReview({
        rawBody,
        delivery: "d1",
        api,
        policy: githubPolicy,
        log: () => undefined,
        enqueue: async () => ({ queued: true, key: "k" }),
      });
      expect(outcome.outcome).toBe("skip");
    }
  });

  test("check_run shape queues on the github fake", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = githubApi({ pulls: [githubPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        action: "completed",
        check_run: {
          status: "completed",
          conclusion: "success",
          name: "jumi/opencode-review",
          head_sha: "head-100",
        },
        repository: { full_name: "o/r" },
      })
    );
    const queued: IssueJob[] = [];
    const outcome = await enqueueStrictRefreshForGreenReview({
      rawBody,
      delivery: "d1",
      api,
      policy: githubPolicy,
      slots,
      log: () => undefined,
      enqueue: async (job) => {
        queued.push(job);
        return { queued: true, key: `strict:${job.prNumber}` };
      },
    });
    expect(outcome.outcome).toBe("queued");
    expect(queued).toHaveLength(1);
  });

  test("green status queues the refresh on the gitea fake", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = giteaApi({ pulls: [giteaPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const queued: IssueJob[] = [];
    const outcome = await enqueueStrictRefreshForGreenReview({
      rawBody: statusPayload("success"),
      delivery: "d1",
      api,
      policy: giteaPolicy,
      slots,
      log: () => undefined,
      enqueue: async (job) => {
        queued.push(job);
        return { queued: true, key: `strict:${job.prNumber}` };
      },
    });
    expect(outcome.outcome).toBe("queued");
    expect(queued).toHaveLength(1);
  });

  test("unreadable pull request defers durably", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    const api = {
      listOpenPulls: async () => [githubPull(100)],
      getPR: async () => {
        throw new Error("GitHub GET /repos/o/r/pulls/100 → 503: boom");
      },
      getRepo: async () => ({
        full_name: "o/r",
        html_url: "https://github.com/o/r",
        clone_url: "https://github.com/o/r.git",
        default_branch: "main",
      }),
    } as never;
    const outcome = await enqueueStrictRefreshForGreenReview({
      rawBody: statusPayload("success"),
      delivery: "d1",
      api,
      policy: githubPolicy,
      slots,
      log: () => undefined,
      enqueue: async () => ({ queued: true, key: "k" }),
    });
    expect(outcome.outcome).toBe("deferred");
    expect(await slots.listAdmitNextDue(Date.now())).toHaveLength(1);
  });
});

describe("worker recheck review gate (#900)", () => {
  test("green proceeds, red refuses, unreadable retries", async () => {
    const greenApi = {
      getPR: async () => githubPull(100),
      getBranch: async () => ({ protected: true, strict: true, sha: "base-2" }),
      listCommitStatuses: async () => [reviewCheck("success")],
      listCheckRuns: async () => [],
      getRepoFile: async () => ({ found: false }),
    } as never;
    const green = await recheckStrictRefreshEligibility({
      api: greenApi,
      owner: "o",
      repo: "r",
      prNumber: 100,
      expectedHeadSha: "head-100",
      botUsername: "jumi",
      defaultBranch: "main",
    });
    expect(green.skipReason).toBeNull();

    const redApi = {
      getPR: async () => githubPull(100),
      getBranch: async () => ({ protected: true, strict: true, sha: "base-2" }),
      listCommitStatuses: async () => [reviewCheck("failure")],
      listCheckRuns: async () => [],
      getRepoFile: async () => ({ found: false }),
    } as never;
    const red = await recheckStrictRefreshEligibility({
      api: redApi,
      owner: "o",
      repo: "r",
      prNumber: 100,
      expectedHeadSha: "head-100",
      botUsername: "jumi",
      defaultBranch: "main",
    });
    expect(red.skipReason).toBe("strict refresh: review not green");

    const throwingApi = {
      getPR: async () => githubPull(100),
      getBranch: async () => ({ protected: true, strict: true, sha: "base-2" }),
      listCommitStatuses: async () => {
        throw new Error("GitHub GET /repos/o/r/commits/head-100/status → 503: boom");
      },
      listCheckRuns: async () => [],
      getRepoFile: async () => ({ found: false }),
    } as never;
    const throwing = await recheckStrictRefreshEligibility({
      api: throwingApi,
      owner: "o",
      repo: "r",
      prNumber: 100,
      expectedHeadSha: "head-100",
      botUsername: "jumi",
      defaultBranch: "main",
    });
    expect(throwing.skipReason).toBe("strict refresh: review status unreadable");
    expect(isStrictRefreshRetryableSkipReason(throwing.skipReason ?? undefined)).toBe(true);
    expect(isStrictRefreshRetryableSkipReason("strict refresh: review not green")).toBe(false);
  });

  test("gitea recheck honors the gate", async () => {
    const api = {
      getPR: async () => giteaPull(100),
      getBranch: async () => ({ protected: true, strict: true }),
      listIssueTimeline: async () => [{ type: "pull_scheduled_merge" }],
      compareCommits: async () => ({ totalCommits: 2 }),
      listCommitStatuses: async () => [reviewCheck("success")],
      listCheckRuns: async () => [],
      getRepoFile: async () => ({ found: false }),
    } as never;
    const ok = await recheckStrictRefreshEligibility({
      api,
      owner: "o",
      repo: "r",
      prNumber: 100,
      expectedHeadSha: "head-100",
      botUsername: "jumi",
      policy: { botUsername: "jumi", forgeKind: "gitea" } as never,
      defaultBranch: "main",
    });
    expect(ok.skipReason).toBeNull();
  });
});

describe("review readiness helper (#900)", () => {
  test("verdict truth table: success is green, anything else is not, errors are unknown", async () => {
    const forStatuses = (statuses: Record<string, Check[]> | "throw") =>
      githubApi({ pulls: [githubPull(100)], statuses });
    const read = (statuses: Record<string, Check[]> | "throw"): Promise<StrictReviewGreen> =>
      readStrictReviewGreen({ api: forStatuses(statuses), owner: "o", repo: "r", headSha: "head-100" });
    expect(await read({ "head-100": [reviewCheck("success")] })).toBe("green");
    expect(await read({ "head-100": [reviewCheck("pending")] })).toBe("not-green");
    expect(await read({ "head-100": [reviewCheck("failure")] })).toBe("not-green");
    expect(await read({})).toBe("not-green");
    expect(await read("throw")).toBe("unknown");
  });

  test("truth table: green and idle is ready, anything else is not", async () => {
    const green = { "head-100": [reviewCheck("success")] };
    expect(
      await isReviewReadyForStrictRefresh({
        api: githubApi({ pulls: [githubPull(100)], statuses: green }),
        owner: "o",
        repo: "r",
        pr: githubPull(100),
      })
    ).toBe(true);
    const pendingLike: Array<Record<string, Check[]>> = [
      { "head-100": [reviewCheck("pending")] },
      { "head-100": [reviewCheck("failure")] },
      {},
    ];
    for (const statuses of pendingLike) {
      expect(
        await isReviewReadyForStrictRefresh({
          api: githubApi({ pulls: [githubPull(100)], statuses }),
          owner: "o",
          repo: "r",
          pr: githubPull(100),
        })
      ).toBe(false);
    }
    expect(
      await isReviewReadyForStrictRefresh({
        api: githubApi({ pulls: [githubPull(100)], statuses: green }),
        owner: "o",
        repo: "r",
        pr: githubPull(100),
        hasPendingFollowUp: async () => true,
      })
    ).toBe(false);
    expect(
      await isReviewReadyForStrictRefresh({
        api: githubApi({ pulls: [githubPull(100)], statuses: "throw" }),
        owner: "o",
        repo: "r",
        pr: githubPull(100),
      })
    ).toBe(false);
  });
});

describe("parseJumiReviewSuccessFinish (#900)", () => {
  const encode = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
  test("status shape: only green review finishes match", () => {
    const base = { sha: "abc", context: "jumi/opencode-review", repository: { full_name: "o/r" } };
    expect(parseJumiReviewSuccessFinish(encode({ ...base, state: "success" }))).toEqual({ sha: "abc" });
    expect(parseJumiReviewSuccessFinish(encode({ ...base, state: "pending" }))).toBeNull();
    expect(parseJumiReviewSuccessFinish(encode({ ...base, state: "failure" }))).toBeNull();
    expect(parseJumiReviewSuccessFinish(encode({ ...base, state: "success", context: "ci" }))).toBeNull();
    expect(parseJumiReviewSuccessFinish(encode({ nope: true }))).toBeNull();
    expect(parseJumiReviewSuccessFinish(new TextEncoder().encode("not json"))).toBeNull();
  });
  test("check_run shape: only completed successes match", () => {
    const run = (status: string, conclusion: string, name = "jumi/opencode-review") =>
      encode({ check_run: { status, conclusion, name, head_sha: "abc" } });
    expect(parseJumiReviewSuccessFinish(run("completed", "success"))).toEqual({ sha: "abc" });
    expect(parseJumiReviewSuccessFinish(run("completed", "Success"))).toEqual({ sha: "abc" });
    expect(parseJumiReviewSuccessFinish(run("completed", "failure"))).toBeNull();
    expect(parseJumiReviewSuccessFinish(run("in_progress", "success"))).toBeNull();
    expect(parseJumiReviewSuccessFinish(run("completed", "success", "ci"))).toBeNull();
  });
});

describe("ensureAdmitNextDue (#900)", () => {
  test("empty branch stores a due obligation; held branch stays untouched", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    expect(await slots.ensureAdmitNextDue("o", "r", "main", 1_000)).toBe(true);
    expect(await slots.listAdmitNextDue(1_000)).toHaveLength(1);
    expect(await slots.consumeAdmitNext("o", "r", "main")).toBe(true);
    expect(await slots.listAdmitNextDue(1_000)).toHaveLength(0);

    await slots.tryAdmit({
      owner: "o",
      repo: "r",
      baseBranch: "main",
      prNumber: 100,
      headSha: "head-100",
      baseSha: "base-1",
      admittedAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    expect(await slots.ensureAdmitNextDue("o", "r", "main", 2_000)).toBe(false);
    expect((await slots.getSlot("o", "r", "main"))?.prNumber).toBe(100);
    expect(await slots.listAdmitNextDue(2_000)).toHaveLength(0);
  });

  test("tick keeps the obligation when the repo lookup fails and drains it when healthy", async () => {
    const slots = new MemoryStrictRefreshSlotStore();
    await slots.ensureAdmitNextDue("o", "r", "main", 1_000);
    const healthyBase = giteaApi({ pulls: [giteaPull(100)], statuses: { "head-100": [reviewCheck("success")] } });
    const healthy = healthyBase as unknown as Record<string, unknown>;
    const failing = {
      ...healthy,
      getRepo: async () => {
        throw new Error("Gitea API GET /repos/o/r → 503: boom");
      },
    };
    const enqueued: IssueJob[] = [];
    const kept = await expireStrictRefreshSlotsOnTick({
      slots,
      api: failing as never,
      policy: giteaPolicy,
      enqueueIssue: async (job) => {
        enqueued.push(job);
        return { queued: true, key: "k" };
      },
      nowMs: 2_000,
    });
    expect(kept.enqueued).toBe(0);
    expect(enqueued).toHaveLength(0);
    // The transient failure does not consume the wake: it is still due.
    expect(await slots.listAdmitNextDue(2_000)).toHaveLength(1);

    const drained = await expireStrictRefreshSlotsOnTick({
      slots,
      api: healthy as never,
      policy: giteaPolicy,
      enqueueIssue: async (job) => {
        enqueued.push(job);
        return { queued: true, key: "k" };
      },
      nowMs: 3_000,
    });
    expect(drained.enqueued).toBe(1);
    expect(enqueued[0]?.prNumber).toBe(100);
    expect(await slots.listAdmitNextDue(3_000)).toHaveLength(0);
  });
});
