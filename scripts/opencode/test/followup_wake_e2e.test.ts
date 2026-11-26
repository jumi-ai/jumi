import { describe, expect, test } from "bun:test";
import { implementFollowUp } from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { MemoryReviewJobStore, workerJobKey } from "../src/review_jobs.ts";
import type { IssueJob } from "../src/types.ts";
import { processWorkerTick } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import {
  makeComment,
  makeIssue,
  makeIssueCommentPayload,
  makeIssueJob,
  makePR,
  makeRepo,
  makeUser,
  makeWorkerConfig,
  responseJson,
} from "./fixtures.ts";
import { withDirs } from "./harness/temp.ts";
import { workerIssueCommentRequest } from "./harness/webhook.ts";

const OWNER = "kirmanak";
const REPO = "demo";
const ISSUE = 12;
const PR = 127;
const HEAD = "headsha";
const NEW_HEAD = "newsha";
const HELD_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function jumiPr(headSha: string) {
  const repo = makeRepo();
  return makePR({
    number: PR,
    title: "Fix the thing",
    body: "Fixes #12",
    user: makeUser({ login: "jumi" }),
    html_url: `https://gitea.kirmanak.stream/${OWNER}/${REPO}/pulls/${PR}`,
    head: {
      label: `${OWNER}:jumi/issue-12-fix-the-thing`,
      ref: "jumi/issue-12-fix-the-thing",
      sha: headSha,
      repo,
      repo_id: repo.id,
    },
  });
}

function cleanGitRunner() {
  return async (args: string[]) => {
    const rest = [...args];
    while (rest[0] === "-c") rest.splice(0, 2);
    if (rest[0] === "rev-parse") return "abc123";
    if (rest[0] === "status") return "";
    if (rest[0] === "rev-list") return "0";
    return "";
  };
}

function heldStickyBody(sha = HELD_HEAD): string {
  return [
    "<!-- jumi-review:kirmanak/demo#127 -->",
    "### Jumi review",
    "",
    `Reviewed commit: \`${sha}\``,
    "",
    "src/foo.ts:12: ❓ maintainer: please file the follow-up issue?",
    "<!-- jumi-check: success -->",
  ].join("\n");
}

interface TestForge {
  api: IssueApi;
  comments: ReturnType<typeof makeComment>[];
  statuses: Array<{ state: string; description?: string; context?: string }>;
  pr: ReturnType<typeof makePR>;
}

function testForge(pr: ReturnType<typeof makePR>, comments: ReturnType<typeof makeComment>[]): TestForge {
  const statuses: TestForge["statuses"] = [];
  const api = makeIssueApi({
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [pr],
    getPR: async () => pr,
    listIssueComments: async () => [...comments],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner: string, _repo: string, _index: number, body: string) => makeComment({ body }),
    updateIssueComment: async (_owner: string, _repo: string, id: number, body: string) => makeComment({ id, body }),
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listCommitStatuses: async () => [],
    listCheckRuns: async () => [],
    listActionJobs: async () => [],
    getActionJobLogs: async () => "",
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getRepoFile: async () => ({ found: false }),
  });
  (api as unknown as Record<string, unknown>).createCommitStatus = async (
    _owner: string,
    _repo: string,
    _sha: string,
    status: { state: string; description?: string; context?: string }
  ) => {
    statuses.push(status);
    return status as never;
  };
  return { api: api as unknown as IssueApi, comments, statuses, pr };
}

function commentPayload(
  commentId: number,
  body: string,
  sender: string,
  headSha: string,
  prNumber = PR,
  issueNumber = ISSUE
) {
  const repository = makeRepo();
  const pr = jumiPr(headSha);
  pr.number = prNumber;
  return makeIssueCommentPayload({
    repository,
    sender: makeUser({ login: sender }),
    comment: makeComment({ id: commentId, body, user: makeUser({ login: sender }) }),
    issue: makeIssue({
      number: prNumber,
      title: "Fix the thing",
      body: `Fixes #${issueNumber}`,
      html_url: `https://gitea.kirmanak.stream/${OWNER}/${REPO}/pulls/${prNumber}`,
      user: makeUser({ login: "jumi" }),
      pull_request: { merged_at: null },
    }),
    pull_request: pr,
  });
}

async function deliverComment(
  handler: (req: Request) => Promise<Response>,
  payload: ReturnType<typeof makeIssueCommentPayload>,
  delivery: string
): Promise<Record<string, unknown>> {
  const response = await handler(await workerIssueCommentRequest(payload, { event: "issue_comment", delivery }));
  expect(response.status).toBe(202);
  return (await responseJson(response)) as Record<string, unknown>;
}

describe("follow-up wake end-to-end through the worker webhook (memory)", () => {
  test("no-changes finish promotes exactly one pass whose feedback includes B", async () => {
    await withDirs(async (home, workdir) => {
      const store = new MemoryReviewJobStore();
      const pr = jumiPr(HEAD);
      const commentA = makeComment({ id: 11, body: "first feedback", user: makeUser({ login: "alice" }) });
      const forge = testForge(pr, [commentA]);
      const config = makeWorkerConfig({ home, workdir });
      const handler = createWorkerFetchHandler(config, {
        queue: { enqueue: (job: IssueJob) => store.enqueueIssue(job) },
        api: forge.api,
        sits: store.sits,
        logger: () => undefined,
      });

      const first = await deliverComment(handler, commentPayload(11, "first feedback", "alice", HEAD), "delivery-a");
      expect(first).toMatchObject({ queued: true });
      const key = workerJobKey(makeIssueJob({ mode: "follow-up", prNumber: PR, headSha: HEAD }));
      expect(first.key).toBe(key);

      const feedbackWritten = Promise.withResolvers<void>();
      const allowFinish = Promise.withResolvers<void>();
      let feedbackA: { body?: string | null }[] = [];
      const tickA = processWorkerTick(store, config, forge.api, "worker-1", {
        followUp: async (opts) => {
          feedbackA = await opts.api.listIssueComments(opts.job.owner, opts.job.repo, PR);
          feedbackWritten.resolve();
          await allowFinish.promise;
          return { status: "no-changes" };
        },
      });
      await feedbackWritten.promise;
      expect(feedbackA.map((comment) => comment.body)).not.toContain("second wake body");

      forge.comments.push(makeComment({ id: 22, body: "second wake body", user: makeUser({ login: "bob" }) }));
      const second = await deliverComment(handler, commentPayload(22, "second wake body", "bob", HEAD), "delivery-b");
      expect(second).toMatchObject({ queued: false });
      expect(await store.wakeCauses.countPending(key)).toBe(1);

      allowFinish.resolve();
      expect(await tickA).toBe("processed");
      expect(await store.wakeCauses.countPending(key)).toBe(0);

      const seen: IssueJob[] = [];
      let feedbackB: { body?: string | null }[] = [];
      let runs = 0;
      expect(
        await processWorkerTick(store, config, forge.api, "worker-1", {
          followUp: async (opts) => {
            runs++;
            seen.push(opts.job);
            feedbackB = await opts.api.listIssueComments(opts.job.owner, opts.job.repo, PR);
            return { status: "no-changes" };
          },
        })
      ).toBe("processed");
      expect(runs).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.trigger).toEqual({ event: "issue_comment", commentId: 22, sender: "bob" });
      expect(feedbackB.map((comment) => comment.body)).toContain("second wake body");
      const cause = await store.wakeCauses.get(key, "delivery:delivery-b");
      expect(cause?.state).toBe("promoted");
      expect(cause?.promotedJobId).not.toBeNull();

      expect(
        await processWorkerTick(store, config, forge.api, "worker-1", {
          followUp: async () => {
            throw new Error("promoted pass must run exactly once");
          },
        })
      ).toBe("idle");
    });
  });

  test("maintainer answer trigger releases the hold like the un-deduped control", async () => {
    await withDirs(async (home, workdir) => {
      const pr = jumiPr(HELD_HEAD);
      const sticky = makeComment({ id: 38022, body: heldStickyBody(), user: makeUser({ login: "jumi" }) });
      const firstComment = makeComment({ id: 11, body: "first feedback", user: makeUser({ login: "alice" }) });
      const answer = makeComment({ id: 55, body: "answered, thanks", user: makeUser({ login: "alice" }) });
      const forge = testForge(pr, [sticky, firstComment]);
      const store = new MemoryReviewJobStore();
      const config = makeWorkerConfig({ home, workdir });
      const handler = createWorkerFetchHandler(config, {
        queue: { enqueue: (job: IssueJob) => store.enqueueIssue(job) },
        api: forge.api,
        sits: store.sits,
        logger: () => undefined,
      });
      const key = workerJobKey(makeIssueJob({ mode: "follow-up", prNumber: PR, headSha: HELD_HEAD }));

      expect(
        await deliverComment(handler, commentPayload(11, "first feedback", "alice", HELD_HEAD), "delivery-a")
      ).toMatchObject({
        queued: true,
      });

      const feedbackWritten = Promise.withResolvers<void>();
      const allowFinish = Promise.withResolvers<void>();
      const tickA = processWorkerTick(store, config, forge.api, "worker-1", {
        followUp: async (opts) => {
          await opts.api.listIssueComments(opts.job.owner, opts.job.repo, PR);
          feedbackWritten.resolve();
          await allowFinish.promise;
          return { status: "no-changes" };
        },
      });
      await feedbackWritten.promise;

      forge.comments.push(answer);
      expect(
        await deliverComment(handler, commentPayload(55, "answered, thanks", "alice", HELD_HEAD), "delivery-b")
      ).toMatchObject({ queued: false });
      allowFinish.resolve();
      expect(await tickA).toBe("processed");

      let promotedJob: IssueJob | undefined;
      expect(
        await processWorkerTick(store, config, forge.api, "worker-1", {
          followUp: async (tickOpts) => {
            promotedJob = tickOpts.job;
            return implementFollowUp({
              ...tickOpts,
              giteaUrl: config.giteaUrl,
              giteaToken: config.giteaToken,
              botUsername: config.botUsername,
              model: config.model,
              heartbeatIntervalMs: 0,
              gitRunner: cleanGitRunner() as never,
              openCodeRunner: async () => ({ status: "ok" }),
              logger: () => undefined,
            });
          },
        })
      ).toBe("processed");
      expect(promotedJob?.trigger).toEqual({ event: "issue_comment", commentId: 55, sender: "alice" });
      const promotedSuccess = forge.statuses.filter((status) => status.state === "success");
      expect(promotedSuccess.length).toBeGreaterThan(0);
      expect(promotedSuccess.at(-1)?.description).toBe("No blocking issues");

      const controlForge = testForge(jumiPr(HELD_HEAD), [sticky, firstComment, answer]);
      const controlStore = new MemoryReviewJobStore();
      const controlHandler = createWorkerFetchHandler(config, {
        queue: { enqueue: (job: IssueJob) => controlStore.enqueueIssue(job) },
        api: controlForge.api,
        sits: controlStore.sits,
        logger: () => undefined,
      });
      expect(
        await deliverComment(controlHandler, commentPayload(55, "answered, thanks", "alice", HELD_HEAD), "delivery-b")
      ).toMatchObject({ queued: true });
      let controlJob: IssueJob | undefined;
      expect(
        await processWorkerTick(controlStore, config, controlForge.api, "worker-1", {
          followUp: async (tickOpts) => {
            controlJob = tickOpts.job;
            return implementFollowUp({
              ...tickOpts,
              giteaUrl: config.giteaUrl,
              giteaToken: config.giteaToken,
              botUsername: config.botUsername,
              model: config.model,
              heartbeatIntervalMs: 0,
              gitRunner: cleanGitRunner() as never,
              openCodeRunner: async () => ({ status: "ok" }),
              logger: () => undefined,
            });
          },
        })
      ).toBe("processed");
      expect(controlJob?.trigger).toEqual(promotedJob?.trigger);
      const controlSuccess = controlForge.statuses.filter((status) => status.state === "success");
      expect(controlSuccess.length).toBeGreaterThan(0);
      expect(controlSuccess.at(-1)?.description).toBe(promotedSuccess.at(-1)?.description);
      expect(await controlStore.wakeCauses.countPending(key)).toBe(0);
    });
  });

  test("head-changed finish parks B visible and runs no promoted pass", async () => {
    await withDirs(async (home, workdir) => {
      const store = new MemoryReviewJobStore();
      const pr = jumiPr(HEAD);
      const forge = testForge(pr, [makeComment({ id: 11, body: "first feedback" })]);
      const config = makeWorkerConfig({ home, workdir });
      const handler = createWorkerFetchHandler(config, {
        queue: { enqueue: (job: IssueJob) => store.enqueueIssue(job) },
        api: forge.api,
        sits: store.sits,
        logger: () => undefined,
      });
      const key = workerJobKey(makeIssueJob({ mode: "follow-up", prNumber: PR, headSha: HEAD }));

      expect(
        await deliverComment(handler, commentPayload(11, "first feedback", "alice", HEAD), "delivery-a")
      ).toMatchObject({
        queued: true,
      });

      const feedbackWritten = Promise.withResolvers<void>();
      const allowFinish = Promise.withResolvers<void>();
      const tickA = processWorkerTick(store, config, forge.api, "worker-1", {
        followUp: async (opts) => {
          await opts.api.listIssueComments(opts.job.owner, opts.job.repo, PR);
          feedbackWritten.resolve();
          await allowFinish.promise;
          return { status: "skipped", reason: `PR head changed from ${HEAD} to ${NEW_HEAD}` };
        },
      });
      await feedbackWritten.promise;
      forge.comments.push(makeComment({ id: 22, body: "second wake body", user: makeUser({ login: "bob" }) }));
      expect(
        await deliverComment(handler, commentPayload(22, "second wake body", "bob", HEAD), "delivery-b")
      ).toMatchObject({
        queued: false,
      });
      allowFinish.resolve();
      expect(await tickA).toBe("processed");

      expect(await store.wakeCauses.countPending(key)).toBe(0);
      const parked = await store.wakeCauses.list(key, "parked");
      expect(parked).toHaveLength(1);
      expect(parked[0]?.parkReason).toBe("head-changed");
      expect(parked[0]?.causeId).toBe("delivery:delivery-b");
      expect(store.rows.filter((row) => row.jobKey === key && row.state === "queued")).toHaveLength(0);

      const successorKey = workerJobKey(makeIssueJob({ mode: "follow-up", prNumber: PR, headSha: NEW_HEAD }));
      const successor = store.rows.find((row) => row.jobKey === successorKey);
      expect(successor?.state).toBe("queued");

      const seen: IssueJob[] = [];
      expect(
        await processWorkerTick(store, config, forge.api, "worker-1", {
          followUp: async (opts) => {
            seen.push(opts.job);
            return { status: "no-changes" };
          },
        })
      ).toBe("processed");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.headSha).toBe(NEW_HEAD);
      expect(seen[0]?.trigger).not.toMatchObject({ commentId: 22 });
      expect((await store.wakeCauses.list(key, "parked")).length).toBe(1);
    });
  });

  test("restart between settle and lease still runs B exactly once", async () => {
    await withDirs(async (home, workdir) => {
      const store = new MemoryReviewJobStore();
      const pr = jumiPr(HEAD);
      const forge = testForge(pr, [makeComment({ id: 11, body: "first feedback" })]);
      const config = makeWorkerConfig({ home, workdir });
      const handler = createWorkerFetchHandler(config, {
        queue: { enqueue: (job: IssueJob) => store.enqueueIssue(job) },
        api: forge.api,
        sits: store.sits,
        logger: () => undefined,
      });
      const key = workerJobKey(makeIssueJob({ mode: "follow-up", prNumber: PR, headSha: HEAD }));

      expect(
        await deliverComment(handler, commentPayload(11, "first feedback", "alice", HEAD), "delivery-a")
      ).toMatchObject({
        queued: true,
      });
      const feedbackWritten = Promise.withResolvers<void>();
      const allowFinish = Promise.withResolvers<void>();
      const tickA = processWorkerTick(store, config, forge.api, "worker-1", {
        followUp: async (opts) => {
          await opts.api.listIssueComments(opts.job.owner, opts.job.repo, PR);
          feedbackWritten.resolve();
          await allowFinish.promise;
          return { status: "no-changes" };
        },
      });
      await feedbackWritten.promise;
      forge.comments.push(makeComment({ id: 22, body: "second wake body", user: makeUser({ login: "bob" }) }));
      expect(
        await deliverComment(handler, commentPayload(22, "second wake body", "bob", HEAD), "delivery-b")
      ).toMatchObject({
        queued: false,
      });
      allowFinish.resolve();
      expect(await tickA).toBe("processed");

      const seen: IssueJob[] = [];
      let runs = 0;
      expect(
        await processWorkerTick(store, config, forge.api, "worker-2", {
          followUp: async (opts) => {
            runs++;
            seen.push(opts.job);
            return { status: "no-changes" };
          },
        })
      ).toBe("processed");
      expect(runs).toBe(1);
      expect(seen[0]?.trigger).toEqual({ event: "issue_comment", commentId: 22, sender: "bob" });

      expect(
        await processWorkerTick(store, config, forge.api, "worker-2", {
          followUp: async () => {
            throw new Error("B must run exactly once");
          },
        })
      ).toBe("idle");
      expect(await store.wakeCauses.countPending(key)).toBe(0);
      expect((await store.wakeCauses.get(key, "delivery:delivery-b"))?.state).toBe("promoted");
    });
  });
});
