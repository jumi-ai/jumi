import { describe, expect, test } from "bun:test";
import {
  githubWebhookPolicy,
  handleGithubWebhookEvent,
  hasJumiLabel,
  isGithubBotSender,
  shouldEnqueueGithubIssue,
  verifyGithubSignature,
} from "../src/github_webhook.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { MemoryRouterSitStore } from "../src/router_sits.ts";
import { createFetchHandler } from "../src/server.ts";
import type { IssueJob, ReviewJob } from "../src/types.ts";
import type { WorkerQueueLike } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import { cancelLedgerWorkerJobs } from "../src/worker_webhook.ts";
import {
  encodeJson,
  makeComment,
  makeConfig,
  makeIssue,
  makeIssuePayload,
  makeLinkedIssue,
  makePayload,
  makePR,
  makeRepo,
  makeUser,
  makeWorkerConfig,
  makeWorkflowJobPayload,
  responseJson,
  signBody,
} from "./fixtures.ts";

const githubRepo = makeRepo({
  html_url: "https://github.com/kirmanak/demo",
  clone_url: "https://github.com/kirmanak/demo.git",
});

const policy = {
  giteaUrl: "https://github.com",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [],
  botUsername: "kirmanak-jumi[bot]",
};

function githubIssue(overrides: Parameters<typeof makeIssue>[0] = {}) {
  return makeIssue({
    html_url: "https://github.com/kirmanak/demo/issues/12",
    assignee: null,
    assignees: [],
    labels: [{ name: "jumi" }],
    ...overrides,
  });
}

function labeledPayload(overrides: Parameters<typeof makeIssuePayload>[0] = {}) {
  return makeIssuePayload({
    action: "labeled",
    issue: githubIssue(),
    label: { name: "jumi" },
    repository: githubRepo,
    sender: makeUser({ login: "alice", type: "User" }),
    ...overrides,
  });
}

function makeReviewQueue(): { jobs: ReviewJob[]; enqueue: (job: ReviewJob) => { key: string; queued: true } } {
  const jobs: ReviewJob[] = [];
  return {
    jobs,
    enqueue(job) {
      jobs.push(job);
      return { key: `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`, queued: true };
    },
  };
}

function makeIssueQueue(): WorkerQueueLike & { jobs: IssueJob[] } {
  const jobs: IssueJob[] = [];
  return {
    jobs,
    enqueue(job) {
      jobs.push(job);
      return { key: `${job.owner}/${job.repo}#${job.issueNumber}`, queued: true };
    },
  };
}

async function signedGithubRequest(
  body: unknown,
  overrides: RequestInit & { event?: string; secret?: string; url?: string } = {}
): Promise<Request> {
  const raw = encodeJson(body);
  const secret = overrides.secret ?? "webhook-secret";
  const signature = await signBody(raw, secret);
  const headers = new Headers(overrides.headers);
  headers.set("content-type", "application/json");
  headers.set("x-hub-signature-256", `sha256=${signature}`);
  headers.set("x-github-event", overrides.event ?? "issues");
  headers.set("x-github-delivery", "delivery-1");
  return new Request(overrides.url ?? "https://reviewer.test/webhooks/github", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("verifyGithubSignature", () => {
  test("accepts sha256 hex of the raw UTF-8 body", async () => {
    const raw = encodeJson({ zen: "pong" });
    const hex = await signBody(raw, "webhook-secret");
    expect(await verifyGithubSignature(raw, "webhook-secret", `sha256=${hex}`)).toBe(true);
  });

  test("rejects missing secret, missing header, and bad hmac", async () => {
    const raw = encodeJson({ zen: "pong" });
    const hex = await signBody(raw, "webhook-secret");
    expect(await verifyGithubSignature(raw, "", `sha256=${hex}`)).toBe(false);
    expect(await verifyGithubSignature(raw, "webhook-secret", null)).toBe(false);
    expect(await verifyGithubSignature(raw, "webhook-secret", hex)).toBe(false);
    expect(await verifyGithubSignature(raw, "webhook-secret", "sha256=deadbeef")).toBe(false);
  });
});

describe("isGithubBotSender / hasJumiLabel", () => {
  test("treats type Bot and *[bot] logins as bots", () => {
    expect(isGithubBotSender({ login: "kirmanak-jumi[bot]", type: "Bot" })).toBe(true);
    expect(isGithubBotSender({ login: "github-actions[bot]", type: "User" })).toBe(true);
    expect(isGithubBotSender({ login: "dependabot[bot]" })).toBe(true);
    expect(isGithubBotSender({ login: "alice", type: "User" })).toBe(false);
  });

  test("detects the jumi label", () => {
    expect(hasJumiLabel({ labels: [{ name: "jumi" }] })).toBe(true);
    expect(hasJumiLabel({ labels: ["bug"] })).toBe(false);
  });
});

describe("shouldEnqueueGithubIssue", () => {
  test("enqueues a non-PR issue labeled jumi", () => {
    const decision = shouldEnqueueGithubIssue(labeledPayload(), policy);
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.issueNumber).toBe(12);
      expect(decision.job.action).toBe("labeled");
      expect(decision.job.cloneUrl).toBe("https://github.com/kirmanak/demo.git");
    }
  });

  test("skips a labeled pull request issue", () => {
    const decision = shouldEnqueueGithubIssue(
      labeledPayload({ issue: githubIssue({ pull_request: { url: "https://github.com/kirmanak/demo/pulls/12" } }) }),
      policy
    );
    expect(decision).toEqual({ type: "skip", reason: "pull request issue" });
  });

  test("cancels when the jumi label is removed", () => {
    const decision = shouldEnqueueGithubIssue(
      labeledPayload({ action: "unlabeled", issue: githubIssue({ labels: [] }) }),
      policy
    );
    expect(decision).toEqual({ type: "cancel", owner: "kirmanak", repo: "demo", issueNumber: 12 });
  });

  test("skips bot senders on labeled", () => {
    expect(
      shouldEnqueueGithubIssue(
        labeledPayload({ sender: makeUser({ login: "kirmanak-jumi[bot]", type: "Bot" }) }),
        policy
      )
    ).toEqual({ type: "skip", reason: "sender is bot" });
  });

  test("does not enqueue assigned-only GitHub issues", () => {
    const decision = shouldEnqueueGithubIssue(
      labeledPayload({
        action: "assigned",
        issue: githubIssue({
          labels: [],
          assignee: makeUser({ login: "kirmanak-jumi[bot]" }),
          assignees: [makeUser({ login: "kirmanak-jumi[bot]" })],
        }),
      }),
      policy
    );
    expect(decision).toEqual({ type: "skip", reason: "unsupported action assigned" });
  });
});

describe("POST /webhooks/github", () => {
  function githubConfig() {
    return makeConfig({ githubWebhookSecret: "webhook-secret" });
  }

  function mailbox(store = new MemoryReviewJobStore()) {
    const api = {
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => ({ id: 1, body: "", user: { login: "jumi" }, created_at: "", updated_at: "" }),
      updateIssueComment: async () => ({ id: 1, body: "", user: { login: "jumi" }, created_at: "", updated_at: "" }),
      listOpenPulls: async () => [],
      getIssue: async () =>
        githubIssue({
          number: 12,
          assignee: null,
          assignees: [],
          labels: [{ name: "jumi" }],
        }),
      listIssueBlocks: async () => [
        makeLinkedIssue({
          number: 12,
          html_url: "https://github.com/kirmanak/demo/issues/12",
          assignee: null,
          assignees: [],
        }),
      ],
      getRepo: async () => githubRepo,
    };
    return {
      store,
      handler: createFetchHandler(githubConfig(), {
        queue: store,
        worker: {
          queue: { enqueue: (job) => store.enqueueIssue(job) },
          api,
          cancel: (owner, repo, issueNumber) =>
            cancelLedgerWorkerJobs({
              store,
              api,
              owner,
              repo,
              issueNumber,
              botUsername: "jumi",
            }),
        },
      }),
    };
  }

  test("labeled issue enqueues implement; issues-event labeled PR does not", async () => {
    const { handler, store } = mailbox();
    const labeled = await handler(await signedGithubRequest(labeledPayload(), { event: "issues" }));
    expect(labeled.status).toBe(202);
    expect(await responseJson(labeled)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
    expect(store.rows[0]?.kind).toBe("implement");

    const pr = await handler(
      await signedGithubRequest(
        labeledPayload({
          issue: githubIssue({ number: 9, pull_request: { url: "https://github.com/kirmanak/demo/pulls/9" } }),
        }),
        { event: "issues" }
      )
    );
    expect(pr.status).toBe(202);
    expect(await responseJson(pr)).toEqual({ skipped: "pull request issue" });
    expect(store.rows).toHaveLength(1);
  });

  function labeledForeignPrPayload(overrides: Parameters<typeof makePR>[0] = {}) {
    return makePayload({
      action: "labeled",
      label: { name: "jumi" },
      repository: githubRepo,
      sender: makeUser({ login: "alice", type: "User" }),
      pull_request: makePR({
        number: 55,
        title: "chore(deps)",
        body: "",
        user: makeUser({ login: "renovate[bot]" }),
        assignee: null,
        assignees: [],
        labels: [{ name: "jumi" }],
        html_url: "https://github.com/kirmanak/demo/pull/55",
        head: {
          label: "kirmanak:renovate/all-digest",
          ref: "renovate/all-digest",
          sha: "headsha",
          repo: githubRepo,
          repo_id: githubRepo.id,
        },
        ...overrides,
      }),
    });
  }

  test("pull_request labeled jumi enqueues follow-up on the PR head ref", async () => {
    const { handler, store } = mailbox();
    const response = await handler(await signedGithubRequest(labeledForeignPrPayload(), { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "follow-up:kirmanak/demo#55:headsha", queued: true });
    expect(store.rows[0]?.kind).toBe("follow-up");
    expect(store.rows[0]?.issueNumber).toBe(55);
    expect(store.rows[0]?.prNumber).toBe(55);
  });

  test("pull_request labeled does not enqueue review", async () => {
    const queue = makeReviewQueue();
    const { store } = mailbox();
    const withReview = createFetchHandler(githubConfig(), {
      queue,
      worker: {
        queue: { enqueue: (job) => store.enqueueIssue(job) },
      },
    });
    const response = await withReview(await signedGithubRequest(labeledForeignPrPayload(), { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "follow-up:kirmanak/demo#55:headsha", queued: true });
    expect(queue.jobs).toHaveLength(0);
  });

  test("unlabel jumi on a PR cancels worker jobs", async () => {
    const { handler, store } = mailbox();
    expect(
      (await handler(await signedGithubRequest(labeledForeignPrPayload(), { event: "pull_request" }))).status
    ).toBe(202);
    const unlabeled = labeledForeignPrPayload({ labels: [] });
    unlabeled.action = "unlabeled";
    const response = await handler(await signedGithubRequest(unlabeled, { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#55", cancelled: true });
    expect(store.rows.filter((row) => row.state === "queued")).toHaveLength(0);
  });

  test("GitHub pull_request assigned does not start follow-up", async () => {
    const { handler, store } = mailbox();
    const response = await handler(
      await signedGithubRequest(
        makePayload({
          action: "assigned",
          repository: githubRepo,
          pull_request: makePR({
            number: 55,
            user: makeUser({ login: "renovate[bot]" }),
            assignee: makeUser({ login: "alice" }),
            assignees: [makeUser({ login: "alice" })],
            html_url: "https://github.com/kirmanak/demo/pull/55",
            head: {
              label: "kirmanak:renovate/x",
              ref: "renovate/x",
              sha: "headsha",
              repo: githubRepo,
              repo_id: githubRepo.id,
            },
          }),
        }),
        { event: "pull_request" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action assigned" });
    expect(store.rows).toHaveLength(0);
  });

  test("unlabel deletes skip latches even when no jobs are queued", async () => {
    const { handler, store } = mailbox();
    await store.skipLatches.put(
      { owner: "kirmanak", repo: "demo", issueNumber: 12 },
      { followup: { round: 3 }, stuck: { fingerprints: [{ kind: "action", hash: "aaa" }] } }
    );
    const response = await handler(
      await signedGithubRequest(labeledPayload({ action: "unlabeled", issue: githubIssue({ labels: [] }) }), {
        event: "issues",
      })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", cancelled: true });
    expect(await store.skipLatches.get({ owner: "kirmanak", repo: "demo", issueNumber: 12 })).toEqual({
      followup: {},
      conflict: {},
      ci: {},
      stuck: {},
    });
  });

  test("unlabel jumi clears the skip latch even with no queued jobs", async () => {
    const { handler, store } = mailbox();
    await store.setIssueSkipReason("kirmanak", "demo", 12, "stuck: cannot resolve conflicts");
    const response = await handler(
      await signedGithubRequest(labeledPayload({ action: "unlabeled", issue: githubIssue({ labels: [] }) }), {
        event: "issues",
      })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", cancelled: true });
    expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({ generation: 1, skipReason: null });
  });

  test("relabel after succeeded implement stays the same closer", async () => {
    const { handler, store } = mailbox();
    expect((await handler(await signedGithubRequest(labeledPayload(), { event: "issues" }))).status).toBe(202);
    const leased = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    await store.markPublished(leased!.id, "worker-1", { state: "succeeded" });
    await store.setIssueSkipReason("kirmanak", "demo", 12, "stuck: cannot resolve conflicts");
    await handler(
      await signedGithubRequest(labeledPayload({ action: "unlabeled", issue: githubIssue({ labels: [] }) }), {
        event: "issues",
      })
    );
    const relabel = await handler(await signedGithubRequest(labeledPayload(), { event: "issues" }));
    expect(await responseJson(relabel)).toEqual({ key: "implement:kirmanak/demo#12", queued: false });
    expect(await store.readIssueSkipLatch("kirmanak", "demo", 12)).toEqual({ generation: 1, skipReason: null });
  });

  test("bad HMAC is 401 and ping is 200", async () => {
    const handler = createFetchHandler(githubConfig(), { queue: makeReviewQueue() });
    expect((await handler(await signedGithubRequest(labeledPayload(), { secret: "wrong" }))).status).toBe(401);
    const raw = encodeJson(labeledPayload());
    const unsigned = new Request("https://reviewer.test/webhooks/github", {
      method: "POST",
      body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
      headers: { "content-type": "application/json", "x-github-event": "issues" },
    });
    expect((await handler(unsigned)).status).toBe(401);
    const ping = await handler(await signedGithubRequest({ zen: "pong" }, { event: "ping" }));
    expect(ping.status).toBe(200);
    expect(await responseJson(ping)).toEqual({ ok: true });
  });

  test("rejects GitHub mailbox when the GitHub secret is missing", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeReviewQueue() });
    expect((await handler(await signedGithubRequest({ zen: "pong" }, { event: "ping" }))).status).toBe(401);
  });

  test("closing a blocker returns 503 when listing blocks fails", async () => {
    const logs: string[] = [];
    const store = new MemoryReviewJobStore();
    const handler = createFetchHandler(githubConfig(), {
      queue: store,
      logger: (message) => logs.push(message),
      worker: {
        queue: { enqueue: (job) => store.enqueueIssue(job) },
        api: {
          listOpenPulls: async () => [],
          getIssue: async () => githubIssue(),
          listIssueBlocks: async () => {
            throw new Error("blocks down");
          },
        },
      },
    });
    const response = await handler(
      await signedGithubRequest(
        labeledPayload({
          action: "closed",
          issue: githubIssue({ number: 196, state: "closed", labels: [] }),
        }),
        { event: "issues" }
      )
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "failed to wake waiting issues" });
    expect(logs.some((line) => line.includes("blocks down"))).toBe(true);
    expect(store.rows).toHaveLength(0);
  });

  test("closing a blocker enqueues the blocked issue if it still has label jumi", async () => {
    const { handler, store } = mailbox();
    const response = await handler(
      await signedGithubRequest(
        labeledPayload({
          action: "closed",
          issue: githubIssue({
            number: 196,
            html_url: "https://github.com/kirmanak/demo/issues/196",
            labels: [],
            state: "closed",
          }),
        }),
        { event: "issues" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
    expect(store.rows[0]?.kind).toBe("implement");
  });

  test("does not enqueue a blocked issue that is not labeled jumi", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createFetchHandler(githubConfig(), {
      queue: store,
      worker: {
        queue: { enqueue: (job) => store.enqueueIssue(job) },
        api: {
          listOpenPulls: async () => [],
          getIssue: async () =>
            githubIssue({
              labels: [],
              assignee: makeUser({ login: "jumi" }),
              assignees: [makeUser({ login: "jumi" })],
            }),
          listIssueBlocks: async () => [
            makeLinkedIssue({ number: 12, html_url: "https://github.com/kirmanak/demo/issues/12" }),
          ],
        },
      },
    });
    const response = await handler(
      await signedGithubRequest(
        labeledPayload({
          action: "closed",
          issue: githubIssue({ number: 196, state: "closed", labels: [] }),
        }),
        { event: "issues" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action closed" });
    expect(store.rows).toHaveLength(0);
  });

  test("closed labeled foreign PR wakes labeled issues", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createFetchHandler(githubConfig(), {
      queue: store,
      worker: {
        queue: { enqueue: (job) => store.enqueueIssue(job) },
        api: {
          listOpenPulls: async () => [],
          listRepoIssues: async (_owner, _repo, opts) => {
            if (opts?.assignedBy) throw new Error("GitHub pickup is the jumi label, not assignee");
            return [makeLinkedIssue({ number: 12, html_url: "https://github.com/kirmanak/demo/issues/12" })];
          },
          getIssue: async () =>
            githubIssue({
              number: 12,
              title: "Slice",
              html_url: "https://github.com/kirmanak/demo/issues/12",
            }),
          getRepo: async () => githubRepo,
        },
      },
    });
    const response = await handler(
      await signedGithubRequest(
        makePayload({
          action: "closed",
          repository: githubRepo,
          pull_request: makePR({
            number: 50,
            state: "closed",
            merged: true,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate[bot]" }),
            assignee: null,
            assignees: [],
            labels: [{ name: "jumi" }],
            html_url: "https://github.com/kirmanak/demo/pulls/50",
            head: {
              label: "kirmanak:renovate/x",
              ref: "renovate/x",
              sha: "headsha",
              repo: githubRepo,
              repo_id: githubRepo.id,
            },
          }),
        }),
        { event: "pull_request" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
    expect(store.rows[0]?.kind).toBe("implement");
  });

  test("closed pull_request for a disallowed org is 400 not 503", async () => {
    const logs: string[] = [];
    const store = new MemoryReviewJobStore();
    const other = makeRepo({
      owner: makeUser({ login: "other" }),
      full_name: "other/demo",
      html_url: "https://github.com/other/demo",
      clone_url: "https://github.com/other/demo.git",
    });
    const handler = createFetchHandler(githubConfig(), {
      queue: store,
      logger: (message) => logs.push(message),
      worker: {
        queue: { enqueue: (job) => store.enqueueIssue(job) },
        api: {
          listOpenPulls: async () => [],
          getIssue: async () => githubIssue(),
        },
      },
    });
    const response = await handler(
      await signedGithubRequest(
        makePayload({
          action: "closed",
          repository: other,
          pull_request: makePR({
            state: "closed",
            merged: true,
            html_url: "https://github.com/other/demo/pulls/7",
            head: {
              label: "other:feature",
              ref: "feature",
              sha: "headsha",
              repo: other,
              repo_id: other.id,
            },
          }),
        }),
        { event: "pull_request" }
      )
    );
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({ error: "invalid webhook payload" });
    expect(logs.some((line) => line.includes("not allowed"))).toBe(true);
    expect(store.rows).toHaveLength(0);
  });

  test("enqueues review on synchronize and skips draft / WIP", async () => {
    const queue = makeReviewQueue();
    const handler = createFetchHandler(githubConfig(), { queue });
    const opened = await handler(
      await signedGithubRequest(
        makePayload({
          action: "synchronize",
          repository: githubRepo,
          pull_request: makePR({
            html_url: "https://github.com/kirmanak/demo/pulls/7",
            head: {
              label: "kirmanak:feature",
              ref: "feature",
              sha: "headsha",
              repo: githubRepo,
              repo_id: githubRepo.id,
            },
          }),
        }),
        { event: "pull_request" }
      )
    );
    expect(opened.status).toBe(202);
    expect(await responseJson(opened)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(queue.jobs[0]?.action).toBe("synchronize");

    const draft = await handler(
      await signedGithubRequest(
        makePayload({
          action: "opened",
          repository: githubRepo,
          pull_request: makePR({
            draft: true,
            title: "WIP: secret",
            html_url: "https://github.com/kirmanak/demo/pulls/7",
            head: {
              label: "kirmanak:feature",
              ref: "feature",
              sha: "headsha",
              repo: githubRepo,
              repo_id: githubRepo.id,
            },
          }),
        }),
        { event: "pull_request" }
      )
    );
    expect(draft.status).toBe(202);
    expect(await responseJson(draft)).toEqual({ skipped: "draft or WIP pull request" });
  });

  test("GitHub issue_comment on a PR fetches the PR and enqueues follow-up", async () => {
    const store = new MemoryReviewJobStore();
    const fetched = makePR({
      number: 127,
      title: "Fix the thing",
      body: "Fixes #12",
      user: makeUser({ login: "kirmanak-jumi[bot]" }),
      html_url: "https://github.com/kirmanak/demo/pull/127",
      head: {
        label: "kirmanak:jumi/issue-12-fix-the-thing",
        ref: "jumi/issue-12-fix-the-thing",
        sha: "headsha",
        repo: githubRepo,
        repo_id: githubRepo.id,
      },
    });
    const handler = createFetchHandler(githubConfig(), {
      queue: store,
      worker: {
        queue: { enqueue: (job) => store.enqueueIssue(job) },
        api: {
          listOpenPulls: async () => [],
          getIssue: async () => githubIssue(),
          getPR: async () => fetched,
          getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
        },
      },
    });
    const response = await handler(
      await signedGithubRequest(
        {
          action: "created",
          comment: makeComment({
            id: 55,
            body: "please fix the tests",
            user: makeUser({ login: "alice" }),
          }),
          issue: githubIssue({
            number: 127,
            title: "Fix the thing",
            body: "Fixes #12",
            html_url: "https://github.com/kirmanak/demo/pull/127",
            user: makeUser({ login: "kirmanak-jumi[bot]", type: "Bot" }),
            assignee: null,
            assignees: [],
            labels: [],
            pull_request: {
              url: "https://api.github.com/repos/kirmanak/demo/pulls/127",
              html_url: "https://github.com/kirmanak/demo/pull/127",
            },
          }),
          repository: githubRepo,
          sender: makeUser({ login: "alice", type: "User" }),
        },
        { event: "issue_comment" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "follow-up:kirmanak/demo#127:headsha", queued: true });
    expect(store.rows[0]?.kind).toBe("follow-up");
  });

  test("GitHub issue_comment PR lookup failure is 503", async () => {
    const handler = createFetchHandler(githubConfig(), {
      queue: makeReviewQueue(),
      worker: {
        queue: { enqueue: async () => ({ key: "x", queued: true }) },
        api: {
          listOpenPulls: async () => [],
          getIssue: async () => githubIssue(),
          getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
          getPR: async () => {
            throw new Error("github 502");
          },
        },
      },
    });
    const response = await handler(
      await signedGithubRequest(
        {
          action: "created",
          comment: makeComment({
            id: 55,
            body: "please fix the tests",
            user: makeUser({ login: "alice" }),
          }),
          issue: githubIssue({
            number: 127,
            title: "Fix the thing",
            body: "Fixes #12",
            html_url: "https://github.com/kirmanak/demo/pull/127",
            user: makeUser({ login: "kirmanak-jumi[bot]", type: "Bot" }),
            assignee: null,
            assignees: [],
            labels: [],
            pull_request: {
              url: "https://api.github.com/repos/kirmanak/demo/pulls/127",
              html_url: "https://github.com/kirmanak/demo/pull/127",
            },
          }),
          repository: githubRepo,
          sender: makeUser({ login: "alice", type: "User" }),
        },
        { event: "issue_comment" }
      )
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "pr lookup failed" });
  });

  test("webhook with installation.id is remembered for mint", async () => {
    const remembered: Array<{ id: string; owner?: string; repo?: string }> = [];
    const response = await handleGithubWebhookEvent(
      encodeJson({
        ...labeledPayload(),
        installation: { id: 789 },
        repository: {
          ...githubRepo,
          full_name: "kirmanak/jumi",
          name: "jumi",
          html_url: "https://github.com/kirmanak/jumi",
          clone_url: "https://github.com/kirmanak/jumi.git",
        },
      }),
      "issues",
      "delivery-1",
      githubWebhookPolicy({
        webhookSecret: "webhook-secret",
        maxWebhookBytes: 1_048_576,
        allowedOrgs: ["kirmanak"],
        allowedRepos: [],
        botUsername: "kirmanak-jumi[bot]",
      }),
      {
        worker: {
          queue: { enqueue: () => ({ key: "implement:kirmanak/jumi#12", queued: true }) },
        },
        rememberInstallation: (id, owner, repo) => remembered.push({ id, owner, repo }),
      }
    );
    expect(response.status).toBe(202);
    expect(remembered).toEqual([{ id: "789", owner: "kirmanak", repo: "jumi" }]);
  });

  test("webhook without installation.id does not remember an install", async () => {
    const remembered: Array<{ id: string; owner?: string; repo?: string }> = [];
    const response = await handleGithubWebhookEvent(
      encodeJson(labeledPayload()),
      "issues",
      "delivery-1",
      githubWebhookPolicy({
        webhookSecret: "webhook-secret",
        maxWebhookBytes: 1_048_576,
        allowedOrgs: ["kirmanak"],
        allowedRepos: [],
        botUsername: "kirmanak-jumi[bot]",
      }),
      {
        worker: {
          queue: { enqueue: () => ({ key: "implement:kirmanak/demo#12", queued: true }) },
        },
        rememberInstallation: (id, owner, repo) => remembered.push({ id, owner, repo }),
      }
    );
    expect(response.status).toBe(202);
    expect(remembered).toEqual([]);
  });

  test("skips status and check_run without a worker api", async () => {
    const handler = createFetchHandler(githubConfig(), { queue: makeReviewQueue() });
    expect(await responseJson(await handler(await signedGithubRequest({}, { event: "status" })))).toEqual({
      skipped: "unsupported event status",
    });
    expect(await responseJson(await handler(await signedGithubRequest({}, { event: "check_run" })))).toEqual({
      skipped: "unsupported event check_run",
    });
  });

  test("finished external status and check_run wake the matching review", async () => {
    const store = new MemoryReviewJobStore();
    const human = makePR({
      number: 55,
      title: "Add feature",
      body: "please review",
      user: makeUser({ login: "alice", type: "User" }),
      html_url: "https://github.com/kirmanak/demo/pull/55",
      head: {
        label: "kirmanak:feature",
        ref: "feature",
        sha: "headsha",
        repo: githubRepo,
        repo_id: githubRepo.id,
      },
    });
    const handler = createFetchHandler(githubConfig(), {
      queue: store,
      worker: {
        queue: { enqueue: (job) => store.enqueueIssue(job) },
        api: {
          listOpenPulls: async () => [human],
          getIssue: async () => githubIssue(),
        },
      },
    });
    const pending = await handler(
      await signedGithubRequest(
        {
          sha: "headsha",
          state: "pending",
          context: "external/ci",
          repository: githubRepo,
        },
        { event: "status" }
      )
    );
    expect(await responseJson(pending)).toEqual({ skipped: "status pending" });
    expect(store.rows).toHaveLength(0);

    const status = await handler(
      await signedGithubRequest(
        {
          sha: "headsha",
          state: "success",
          context: "external/ci",
          repository: githubRepo,
        },
        { event: "status" }
      )
    );
    expect(await responseJson(status)).toEqual({ key: "kirmanak/demo#55:headsha", queued: true });
    expect(store.rows.find((row) => row.kind === "review")?.state).toBe("queued");

    const checkRun = await handler(
      await signedGithubRequest(
        {
          action: "completed",
          check_run: {
            name: "external",
            head_sha: "headsha",
            status: "completed",
            conclusion: "success",
            check_suite: { head_branch: "feature" },
          },
          repository: githubRepo,
        },
        { event: "check_run" }
      )
    );
    expect(await responseJson(checkRun)).toEqual({ key: "kirmanak/demo#55:headsha", queued: false });
  });

  test("later sibling workflow_job is not same-SHA deduped while the first follow-up is leased", async () => {
    const store = new MemoryReviewJobStore();
    const closer = makePR({
      number: 102,
      title: "Fix biome",
      body: "Fixes #81",
      user: makeUser({ login: "kirmanak-jumi[bot]", type: "Bot" }),
      html_url: "https://github.com/kirmanak/demo/pull/102",
      head: {
        label: "kirmanak:jumi/issue-81-fix-biome",
        ref: "jumi/issue-81-fix-biome",
        sha: "headsha",
        repo: githubRepo,
        repo_id: githubRepo.id,
      },
    });
    const handler = createFetchHandler(githubConfig(), {
      queue: store,
      worker: {
        queue: { enqueue: (job) => store.enqueueIssue(job) },
        api: {
          listOpenPulls: async () => [closer],
          getIssue: async () => githubIssue({ number: 81 }),
        },
      },
    });
    const jobPayload = (id: number, name: string) =>
      makeWorkflowJobPayload({
        repository: githubRepo,
        workflow_job: {
          id,
          name,
          status: "completed",
          conclusion: name === "checks" ? "failure" : "success",
          head_sha: "headsha",
          head_branch: "jumi/issue-81-fix-biome",
        },
      });
    const first = await handler(await signedGithubRequest(jobPayload(11, "checks"), { event: "workflow_job" }));
    expect(first.status).toBe(202);
    expect(await responseJson(first)).toEqual({
      key: "follow-up:kirmanak/demo#102:headsha:11",
      queued: true,
    });
    const leased = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    expect(leased?.state).toBe("leased");
    const duplicate = await handler(await signedGithubRequest(jobPayload(11, "checks"), { event: "workflow_job" }));
    expect(await responseJson(duplicate)).toEqual({
      key: "follow-up:kirmanak/demo#102:headsha:11",
      queued: false,
    });
    const sibling = await handler(await signedGithubRequest(jobPayload(12, "Analyze"), { event: "workflow_job" }));
    expect(await responseJson(sibling)).toEqual({
      key: "follow-up:kirmanak/demo#102:headsha:12",
      queued: true,
    });
    await store.markPublished(leased!.id, "worker-1", { state: "skipped", reason: "CI still pending" });
    expect(store.rows.find((row) => row.jobKey === "follow-up:kirmanak/demo#102:headsha:12")?.state).toBe("queued");
  });

  test("workflow_job enqueues review when the PR is not in-scope for follow-up", async () => {
    const store = new MemoryReviewJobStore();
    const human = makePR({
      number: 55,
      title: "Add feature",
      body: "please review",
      user: makeUser({ login: "alice", type: "User" }),
      html_url: "https://github.com/kirmanak/demo/pull/55",
      head: {
        label: "kirmanak:feature",
        ref: "feature",
        sha: "headsha",
        repo: githubRepo,
        repo_id: githubRepo.id,
      },
    });
    const handler = createFetchHandler(githubConfig(), {
      queue: store,
      worker: {
        queue: { enqueue: (job) => store.enqueueIssue(job) },
        api: {
          listOpenPulls: async () => [human],
          getIssue: async () => githubIssue(),
        },
      },
    });
    const response = await handler(
      await signedGithubRequest(
        makeWorkflowJobPayload({
          repository: githubRepo,
          workflow_job: {
            id: 11,
            name: "checks",
            status: "completed",
            conclusion: "success",
            head_sha: "headsha",
            head_branch: "feature",
          },
        }),
        { event: "workflow_job" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#55:headsha", queued: true });
    expect(store.rows.find((row) => row.kind === "review")?.state).toBe("queued");
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
  });

  test("Gitea mailbox still accepts Gitea signatures on /webhooks/gitea", async () => {
    const queue = makeReviewQueue();
    const handler = createFetchHandler(makeConfig(), { queue });
    const raw = encodeJson(makePayload());
    const signature = await signBody(raw, "webhook-secret");
    const response = await handler(
      new Request("https://reviewer.test/webhooks/gitea", {
        method: "POST",
        body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
        headers: {
          "content-type": "application/json",
          "x-gitea-signature": signature,
          "x-gitea-event": "pull_request",
          "x-gitea-delivery": "delivery-1",
        },
      })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
  });
});

describe("worker POST /webhooks/github", () => {
  test("labeled issue enqueues implement; ping is 200; bad hmac is 401", async () => {
    const queue = makeIssueQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig({ githubWebhookSecret: "webhook-secret" }), { queue });
    const labeled = await handler(
      await signedGithubRequest(labeledPayload(), { event: "issues", url: "https://worker.test/webhooks/github" })
    );
    expect(labeled.status).toBe(202);
    expect(await responseJson(labeled)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.issueNumber).toBe(12);

    const ping = await handler(
      await signedGithubRequest({ zen: "pong" }, { event: "ping", url: "https://worker.test/webhooks/github" })
    );
    expect(ping.status).toBe(200);

    expect(
      (
        await handler(
          await signedGithubRequest(labeledPayload(), {
            event: "issues",
            secret: "wrong",
            url: "https://worker.test/webhooks/github",
          })
        )
      ).status
    ).toBe(401);
  });

  test("labeled foreign PR enqueues follow-up on the worker mailbox", async () => {
    const queue = makeIssueQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig({ githubWebhookSecret: "webhook-secret" }), { queue });
    const response = await handler(
      await signedGithubRequest(
        makePayload({
          action: "labeled",
          label: { name: "jumi" },
          repository: githubRepo,
          sender: makeUser({ login: "alice", type: "User" }),
          pull_request: makePR({
            number: 55,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate[bot]" }),
            labels: [{ name: "jumi" }],
            html_url: "https://github.com/kirmanak/demo/pull/55",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: githubRepo,
              repo_id: githubRepo.id,
            },
          }),
        }),
        { event: "pull_request", url: "https://worker.test/webhooks/github" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#55", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.issueNumber).toBe(55);
    expect(queue.jobs[0]?.prNumber).toBe(55);
  });

  test("worker mailbox remembers a label skip as a sit", async () => {
    const queue = makeIssueQueue();
    const sits = new MemoryRouterSitStore();
    const handler = createWorkerFetchHandler(makeWorkerConfig({ githubWebhookSecret: "webhook-secret" }), {
      queue,
      sits,
    });
    const response = await handler(
      await signedGithubRequest(
        makePayload({
          action: "labeled",
          label: { name: "other" },
          repository: githubRepo,
          sender: makeUser({ login: "alice", type: "User" }),
          pull_request: makePR({
            number: 55,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate[bot]" }),
            labels: [{ name: "other" }],
            html_url: "https://github.com/kirmanak/demo/pull/55",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: githubRepo,
              repo_id: githubRepo.id,
            },
          }),
        }),
        { event: "pull_request", url: "https://worker.test/webhooks/github" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "labeled other label" });
    expect(queue.jobs).toHaveLength(0);
    expect(await sits.get("kirmanak", "demo", 55)).toMatchObject({ reason: "not-labeled" });
  });

  test("does not enqueue review jobs on the worker mailbox", async () => {
    const queue = makeIssueQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig({ githubWebhookSecret: "webhook-secret" }), { queue });
    const response = await handler(
      await signedGithubRequest(makePayload({ action: "synchronize", repository: githubRepo }), {
        event: "pull_request",
        url: "https://worker.test/webhooks/github",
      })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action synchronize" });
    expect(queue.jobs).toHaveLength(0);
  });
});
