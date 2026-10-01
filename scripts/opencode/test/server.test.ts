import { afterEach, describe, expect, test } from "bun:test";
import { renderWebhookMetrics, resetControlMetricsForTests } from "../src/control_metrics.ts";
import {
  MemoryReviewJobStore,
  QueueUnavailableError,
  renderQueueMetrics,
  WORKER_JOB_KINDS,
} from "../src/review_jobs.ts";
import type { ReviewQueueLike } from "../src/server.ts";
import { createFetchHandler, shouldSeedOpenCodeAuth, startReviewer } from "../src/server.ts";
import type { IssueJob, ReviewJob } from "../src/types.ts";
import { cancelLedgerWorkerJobs } from "../src/worker_webhook.ts";
import {
  encodeJson,
  makeBranch,
  makeComment,
  makeConfig,
  makeIssue,
  makeIssueCommentPayload,
  makeIssueJob,
  makeIssuePayload,
  makeJob,
  makePayload,
  makePR,
  makePushPayload,
  makeRepo,
  makeUser,
  makeWorkflowJobPayload,
  pushApi,
  responseJson,
  signBody,
} from "./fixtures.ts";

function makeQueue(): ReviewQueueLike & { jobs: ReviewJob[] } {
  const jobs: ReviewJob[] = [];
  return {
    jobs,
    enqueue(job) {
      jobs.push(job);
      return { key: `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`, queued: true };
    },
  };
}

async function signedRequest(
  body: unknown,
  overrides: RequestInit & { event?: string; eventType?: string; secret?: string } = {}
): Promise<Request> {
  const raw = encodeJson(body);
  const secret = overrides.secret ?? "webhook-secret";
  const signature = await signBody(raw, secret);
  const headers = new Headers(overrides.headers);
  headers.set("content-type", "application/json");
  headers.set("x-gitea-signature", signature);
  if (overrides.eventType) headers.set("x-gitea-event-type", overrides.eventType);
  headers.set("x-gitea-event", overrides.event ?? "pull_request");
  headers.set("x-gitea-delivery", "delivery-1");
  return new Request("https://reviewer.test/webhooks/gitea", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

afterEach(() => {
  resetControlMetricsForTests();
});

describe("createFetchHandler", () => {
  test("serves health and basic HTTP errors", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeQueue() });

    expect((await handler(new Request("https://reviewer.test/healthz"))).status).toBe(200);
    expect((await handler(new Request("https://reviewer.test/missing"))).status).toBe(404);
    expect((await handler(new Request("https://reviewer.test/webhooks/gitea"))).status).toBe(405);
    expect((await handler(new Request("https://reviewer.test/webhooks/gitea", { method: "POST" }))).status).toBe(415);
  });

  test("serves Prometheus token metrics without auth", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeQueue() });
    const response = await handler(new Request("https://reviewer.test/metrics"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain('ai_token_exporter_up{agent_instance="jumi"} 1');
    expect(body).toContain("jumi_jobs_completed_total");
    expect(body).toContain("jumi_opencode_exits_total");
    expect(body).not.toContain("jumi_review_jobs");
    expect(body).not.toContain("jumi_webhooks_total");
    expect((await handler(new Request("https://reviewer.test/metrics", { method: "POST" }))).status).toBe(405);
  });

  test("rejects invalid auth, oversized payloads, and bad signatures", async () => {
    const config = makeConfig({ webhookAuthToken: "auth-token", maxWebhookBytes: 5 });
    const handler = createFetchHandler(config, { queue: makeQueue() });

    expect((await handler(await signedRequest(makePayload()))).status).toBe(401);
    expect(
      (await handler(await signedRequest({ long: "payload" }, { headers: { authorization: "Bearer auth-token" } })))
        .status
    ).toBe(413);

    const badSignatureRequest = await signedRequest(makePayload(), {
      headers: { authorization: "Bearer auth-token" },
      secret: "wrong",
    });
    expect(
      (
        await createFetchHandler(makeConfig({ webhookAuthToken: "auth-token" }), { queue: makeQueue() })(
          badSignatureRequest
        )
      ).status
    ).toBe(401);
    expect(renderWebhookMetrics()).toContain('jumi_webhooks_total{event="pull_request",result="too large"} 1');
    expect(renderWebhookMetrics()).toContain('jumi_webhooks_total{event="pull_request",result="hmac"} 1');
    expect(renderWebhookMetrics()).not.toContain("invalid authorization header");
  });

  test("skips unsupported events", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest(makePayload(), { event: "push" }));

    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported event push" });
    expect(renderWebhookMetrics()).toContain('jumi_webhooks_total{event="push",result="skipped"} 1');
  });

  test("returns ok for ping events", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest({ zen: "pong" }, { event: "ping" }));
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ ok: true });
    expect(renderWebhookMetrics()).toContain('jumi_webhooks_total{event="ping",result="ping"} 1');
  });

  test("enqueues valid pull request events", async () => {
    const queue = makeQueue();
    const handler = createFetchHandler(makeConfig(), { queue });
    const response = await handler(await signedRequest(makePayload()));

    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.delivery).toBe("delivery-1");
  });

  test("returns bad request for valid signatures with invalid payloads", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest({ action: "opened" }));

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({ error: "invalid webhook payload" });
  });

  test("does not enqueue a stale SHA when GET PR head differs", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ headSha: "sha2", prUpdatedAt: "2026-05-23T00:00:01Z" }));
    const handler = createFetchHandler(makeConfig({ role: "router" }), {
      queue: store,
      getPR: async () => makePR({ head: makeBranch({ sha: "sha2" }) }),
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "synchronize",
          pull_request: makePR({
            head: makeBranch({ sha: "sha1" }),
            updated_at: "2026-05-23T00:00:01Z",
          }),
        })
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:sha1", queued: false });
    expect(store.rows.find((row) => row.headSha === "sha2")?.state).toBe("queued");
    expect(store.rows.find((row) => row.headSha === "sha1")).toBeUndefined();
  });

  test("enqueues when GET PR fails", async () => {
    const queue = makeQueue();
    const handler = createFetchHandler(makeConfig(), {
      queue,
      getPR: async () => {
        throw new Error("gitea down");
      },
    });
    const response = await handler(await signedRequest(makePayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(queue.jobs).toHaveLength(1);
  });

  test("router enqueues when GET PR fails", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createFetchHandler(makeConfig({ role: "router" }), {
      queue: store,
      getPR: async () => {
        throw new Error("gitea down");
      },
    });
    const response = await handler(await signedRequest(makePayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("queued");
  });

  test("returns 503 when the queue backend is down", async () => {
    const handler = createFetchHandler(makeConfig(), {
      queue: {
        enqueue() {
          throw new QueueUnavailableError(new Error("connection refused"));
        },
      },
    });
    const response = await handler(await signedRequest(makePayload()));
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "queue unavailable" });
    expect(renderWebhookMetrics()).toContain('jumi_webhooks_total{event="pull_request",result="unavailable"} 1');
  });

  test("router webhook persists a job and serves queue metrics", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createFetchHandler(makeConfig({ role: "router" }), {
      queue: store,
      renderMetrics: async () => `${await renderQueueMetrics(store)}${renderWebhookMetrics()}`,
    });
    const response = await handler(await signedRequest(makePayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("queued");

    const metrics = await handler(new Request("https://reviewer.test/metrics"));
    const text = await metrics.text();
    expect(text).toContain('jumi_review_jobs{state="queued",kind="review"} 1');
    expect(text).toContain('jumi_review_jobs_oldest_queued_age_seconds{kind="review"}');
    expect(text).toContain('jumi_webhooks_total{event="pull_request",result="accepted"} 1');
    expect(text).not.toContain("ai_token_exporter_up");
    expect(text).not.toContain("jumi_jobs_completed_total");
  });

  test("engine does not expose the webhook", async () => {
    const handler = createFetchHandler(makeConfig({ role: "engine" }), {
      queue: makeQueue(),
      webhookEnabled: false,
    });
    expect((await handler(await signedRequest(makePayload()))).status).toBe(404);
  });
});

describe("shouldSeedOpenCodeAuth", () => {
  test("router does not seed OpenCode auth", () => {
    expect(shouldSeedOpenCodeAuth("router")).toBe(false);
    expect(shouldSeedOpenCodeAuth("engine")).toBe(true);
  });
});

describe("startReviewer", () => {
  test("router does not call ensureOpenCodeWellKnownAuth", async () => {
    let seeded = 0;
    const store = new MemoryReviewJobStore();
    await startReviewer(makeConfig({ role: "router", databaseUrl: "postgres://unused" }), {
      store,
      listen: false,
      ensureAuth: async () => {
        seeded++;
        return undefined;
      },
    });
    expect(seeded).toBe(0);
  });

  test("engine seeds OpenCode auth and does not spawn OpenCode on boot", async () => {
    let seeded = 0;
    let ran = 0;
    const store = new MemoryReviewJobStore();
    await startReviewer(makeConfig({ role: "engine", databaseUrl: "postgres://unused" }), {
      store,
      listen: false,
      ensureAuth: async () => {
        seeded++;
        return undefined;
      },
      extras: {
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" };
        },
      },
    });
    expect(seeded).toBe(1);
    expect(ran).toBe(0);
  });
});

describe("createFetchHandler router mailbox", () => {
  const repo = makeRepo();

  function jumiPr() {
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

  function commentApi(comments: string[] = []) {
    return {
      comments,
      findStickyIssueComment: async () => undefined,
      createIssueComment: async (_owner: string, _repo: string, _index: number, body: string) => {
        comments.push(body);
        return makeComment({ body });
      },
      updateIssueComment: async (_owner: string, _repo: string, _id: number, body: string) => {
        comments.push(body);
        return makeComment({ body });
      },
      listOpenPulls: async () => [jumiPr()],
      getIssue: async () => makeIssue(),
      getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
      getRepo: async () => makeRepo(),
      getPR: async (_owner: string, _repo: string, index: number) => makePR({ number: index }),
    };
  }

  function mailboxHandler(
    store = new MemoryReviewJobStore(),
    extras: {
      api?: ReturnType<typeof commentApi>;
      cancel?: (owner: string, repo: string, issueNumber: number) => Promise<{ key: string; cancelled: true }>;
      logs?: string[];
      followupIgnoreLogins?: string[];
    } = {}
  ) {
    const api = extras.api ?? commentApi();
    const logs = extras.logs ?? [];
    const logger = (message: string) => logs.push(message);
    return {
      store,
      api,
      logs,
      handler: createFetchHandler(
        makeConfig({ role: "router", followupIgnoreLogins: extras.followupIgnoreLogins ?? [] }),
        {
          queue: store,
          logger,
          worker: {
            queue: { enqueue: (job: IssueJob) => store.enqueueIssue(job) },
            review: store,
            api,
            cancel:
              extras.cancel ??
              ((owner, repo, issueNumber) =>
                cancelLedgerWorkerJobs({
                  store,
                  api,
                  owner,
                  repo,
                  issueNumber,
                  botUsername: "jumi",
                  logger,
                })),
            logger,
          },
        }
      ),
    };
  }

  test("enqueues implement on issue assign", async () => {
    const { handler, store, logs } = mailboxHandler();
    const response = await handler(
      await signedRequest(makeIssuePayload({ action: "assigned" }), { event: "issues", eventType: "issue_assign" })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
    expect(store.rows[0]?.kind).toBe("implement");
    expect(logs.some((line) => line.includes("queued implement:kirmanak/demo#12"))).toBe(true);
  });

  test("cancels queued and leased worker rows on unassign and posts stopped", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    const { handler, api } = mailboxHandler(store);
    const response = await handler(
      await signedRequest(
        makeIssuePayload({
          action: "unassigned",
          issue: makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
        }),
        { event: "issues", eventType: "issue_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", cancelled: true });
    expect(store.rows[0]?.state).toBe("cancelled");
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(api.comments.at(-1)).toContain("stopped");
  });

  test("does not post stopped when no worker rows were cancelled", async () => {
    const { handler, api } = mailboxHandler();
    const response = await handler(
      await signedRequest(
        makeIssuePayload({
          action: "unassigned",
          issue: makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
        }),
        { event: "issues" }
      )
    );
    expect(response.status).toBe(202);
    expect(api.comments).toEqual([]);
  });

  test("enqueues follow-up on a human PR comment", async () => {
    const { handler, store, logs } = mailboxHandler();
    const response = await handler(
      await signedRequest(makeIssueCommentPayload({ pull_request: jumiPr() }), { event: "issue_comment" })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "follow-up:kirmanak/demo#127:headsha", queued: true });
    expect(store.rows[0]?.kind).toBe("follow-up");
    expect(logs.some((line) => line.includes("queued follow-up:"))).toBe(true);
  });

  test("skips follow-up for ignored comment logins", async () => {
    const { handler, store, logs } = mailboxHandler(undefined, { followupIgnoreLogins: ["tapio"] });
    const response = await handler(
      await signedRequest(makeIssueCommentPayload({ pull_request: jumiPr(), sender: makeUser({ login: "tapio" }) }), {
        event: "issue_comment",
      })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "sender ignored" });
    expect(store.rows).toHaveLength(0);
    expect(logs.some((line) => line.includes("skipped sender ignored"))).toBe(true);
  });

  test("review-comment delivery never 400s", async () => {
    const { handler, store } = mailboxHandler();
    const body = makePayload({
      action: "reviewed",
      pull_request: jumiPr(),
      review: { id: 9, body: "please change this" },
    });
    expect("issue" in body).toBe(false);
    expect("comment" in body).toBe(false);
    const response = await handler(await signedRequest(body, { event: "pull_request_comment" }));
    expect(response.status).toBe(202);
    const json = await responseJson(response);
    expect(json).not.toHaveProperty("error");
    expect(json).toEqual({ key: "follow-up:kirmanak/demo#127:headsha", queued: true });
    expect(store.rows[0]?.kind).toBe("follow-up");
  });

  test("enqueues conflict on default-branch push", async () => {
    const { handler, store, logs } = mailboxHandler();
    const response = await handler(await signedRequest(makePushPayload(), { event: "push" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ queued: true, keys: ["conflict:kirmanak/demo#127:headsha"] });
    expect(store.rows[0]?.kind).toBe("conflict");
    expect(logs.some((line) => line.includes("queued conflict:"))).toBe(true);
  });

  test("enqueues follow-up on workflow_job", async () => {
    const { handler, store, logs } = mailboxHandler();
    const response = await handler(await signedRequest(makeWorkflowJobPayload(), { event: "workflow_job" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ queued: true, keys: ["follow-up:kirmanak/demo#127:headsha:99"] });
    expect(store.rows[0]?.kind).toBe("follow-up");
    expect(logs.some((line) => line.includes("queued follow-up:"))).toBe(true);
  });

  test("workflow_job also enqueues a review for the matching PR", async () => {
    const { handler, store, logs } = mailboxHandler();
    const response = await handler(await signedRequest(makeWorkflowJobPayload(), { event: "workflow_job" }));
    expect(response.status).toBe(202);
    expect(store.rows.find((row) => row.kind === "review")?.jobKey).toBe("kirmanak/demo#127:headsha");
    expect(store.rows.find((row) => row.kind === "follow-up")?.state).toBe("queued");
    expect(logs.some((line) => line.includes("queued kirmanak/demo#127:headsha"))).toBe(true);
  });

  test("pull_request opened still enqueues review", async () => {
    const { handler, store } = mailboxHandler();
    const response = await handler(await signedRequest(makePayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(store.rows[0]?.kind).toBe("review");
  });

  test("pull_request assigned enqueues follow-up", async () => {
    const { handler, store } = mailboxHandler();
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "assigned",
          pull_request: makePR({
            number: 50,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo,
              repo_id: repo.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "follow-up:kirmanak/demo#50:headsha", queued: true });
    expect(store.rows[0]?.kind).toBe("follow-up");
  });

  test("pull_request assigned skips when the closer issue is already assigned", async () => {
    const { handler, store } = mailboxHandler();
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "assigned",
          pull_request: makePR({
            ...jumiPr(),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "closing issue already assigned" });
    expect(store.rows).toHaveLength(0);
  });

  test("unknown events 202-skip", async () => {
    const { handler, logs } = mailboxHandler();
    const response = await handler(await signedRequest(makePayload(), { event: "fork" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported event fork" });
    expect(logs.some((line) => line.includes("skipped unsupported event fork"))).toBe(true);
  });

  test("finished Gitea commit status wakes the matching review without a push", async () => {
    const { handler, store } = mailboxHandler();
    const pending = await handler(
      await signedRequest(
        {
          sha: "headsha",
          state: "pending",
          context: "external/ci",
          repository: repo,
          sender: makeUser({ login: "ci" }),
        },
        { event: "status" }
      )
    );
    expect(await responseJson(pending)).toEqual({ skipped: "status pending" });
    expect(store.rows).toHaveLength(0);

    const own = await handler(
      await signedRequest(
        {
          sha: "headsha",
          state: "success",
          context: "jumi/opencode-review",
          repository: repo,
          sender: makeUser({ login: "jumi" }),
        },
        { event: "status" }
      )
    );
    expect(await responseJson(own)).toEqual({ skipped: "jumi review status" });
    expect(store.rows).toHaveLength(0);

    const response = await handler(
      await signedRequest(
        {
          sha: "headsha",
          state: "success",
          context: "external/ci",
          repository: repo,
          sender: makeUser({ login: "ci" }),
        },
        { event: "status" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#127:headsha", queued: true });
    expect(store.rows.find((row) => row.kind === "review")?.state).toBe("queued");
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
  });

  test("returns 503 when the ledger is down for worker events", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createFetchHandler(makeConfig({ role: "router" }), {
      queue: store,
      worker: {
        api: pushApi(),
        queue: {
          enqueue() {
            throw new QueueUnavailableError("down");
          },
        },
      },
    });
    const response = await handler(await signedRequest(makeIssuePayload({ action: "assigned" }), { event: "issues" }));
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "queue unavailable" });
  });

  test("unassign still 202s if the stopped comment fails", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const api = {
      ...commentApi(),
      createIssueComment: async () => {
        throw new Error("gitea down");
      },
    };
    const { handler } = mailboxHandler(store, { api });
    const response = await handler(
      await signedRequest(
        makeIssuePayload({
          action: "unassigned",
          issue: makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
        }),
        { event: "issues" }
      )
    );
    expect(response.status).toBe(202);
    expect(store.rows[0]?.state).toBe("cancelled");
  });
});
