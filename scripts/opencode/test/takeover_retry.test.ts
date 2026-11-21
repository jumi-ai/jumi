import { describe, expect, test } from "bun:test";
import { MemoryReviewJobStore, QueueUnavailableError } from "../src/review_jobs.ts";
import { createFetchHandler } from "../src/server.ts";
import type { IssueJob } from "../src/types.ts";
import { encodeJson, makeConfig, makePayload, makePR, makeRepo, makeUser, responseJson, signBody } from "./fixtures.ts";
import { reviewerRequest } from "./harness/webhook.ts";

const repo = makeRepo();
const githubRepo = makeRepo({
  html_url: "https://github.com/kirmanak/demo",
  clone_url: "https://github.com/kirmanak/demo.git",
});

function openedPayload(authorLogin: string, target: ReturnType<typeof makeRepo> = repo) {
  return makePayload({
    action: "opened",
    repository: target,
    pull_request: makePR({
      number: 7,
      title: "chore(deps): update all",
      body: "",
      state: "open",
      user: makeUser({ login: authorLogin }),
      html_url: `${target.html_url}/pulls/7`,
      head: {
        label: "kirmanak:feature",
        ref: "feature",
        sha: "headsha",
        repo: target,
        repo_id: target.id,
      },
    }),
  });
}

function takeoverApi(marker: { labeled: number; assigned: number }) {
  return {
    getRepoFile: async () => ({ found: true, content: "takeover_authors: [renovate]\n" }),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    addIssueAssignees: async () => {
      marker.assigned += 1;
      return undefined;
    },
    addIssueLabel: async () => {
      marker.labeled += 1;
      return undefined;
    },
    findStickyIssueComment: async () => undefined,
    createIssueComment: async () => ({ id: 1 }),
    updateIssueComment: async () => ({ id: 1 }),
  };
}

function flakyWorkerQueue(store: MemoryReviewJobStore, failFirst: boolean) {
  let calls = 0;
  return {
    calls: () => calls,
    enqueue: async (job: IssueJob) => {
      calls += 1;
      if (failFirst && calls === 1) throw new QueueUnavailableError(new Error("connection refused"));
      return store.enqueueIssue(job);
    },
  };
}

async function signedGithubRequest(body: unknown, delivery: string): Promise<Request> {
  const raw = encodeJson(body);
  const signature = await signBody(raw, "webhook-secret");
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("x-hub-signature-256", `sha256=${signature}`);
  headers.set("x-github-event", "pull_request");
  headers.set("x-github-delivery", delivery);
  return new Request("https://reviewer.test/webhooks/github", {
    method: "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("PR-open takeover retry", () => {
  test("Gitea: takeover enqueue failure is retryable without duplicating the review", async () => {
    const store = new MemoryReviewJobStore();
    const marker = { labeled: 0, assigned: 0 };
    const workerQueue = flakyWorkerQueue(store, true);
    const logs: string[] = [];
    const handler = createFetchHandler(makeConfig(), {
      queue: store,
      logger: (message) => logs.push(message),
      worker: {
        queue: workerQueue,
        api: takeoverApi(marker) as never,
        logger: (message: string) => logs.push(message),
      },
    });

    const first = await handler(await reviewerRequest(openedPayload("renovate"), { delivery: "gitea-takeover-1" }));
    expect(first.status).toBe(503);
    expect(await responseJson(first)).toEqual({ error: "queue unavailable" });
    expect(store.rows.filter((row) => row.kind === "review")).toHaveLength(1);
    expect(store.rows.filter((row) => row.kind !== "review")).toHaveLength(0);

    const second = await handler(await reviewerRequest(openedPayload("renovate"), { delivery: "gitea-takeover-1" }));
    expect(second.status).toBe(202);
    expect(store.rows.filter((row) => row.kind === "review")).toHaveLength(1);
    expect(store.rows.filter((row) => row.kind !== "review")).toHaveLength(1);

    const replay = await handler(await reviewerRequest(openedPayload("renovate"), { delivery: "gitea-takeover-1" }));
    expect(replay.status).toBe(202);
    expect(await responseJson(replay)).toEqual({ queued: false, deduped: true });
    expect(store.rows).toHaveLength(2);
  });

  test("GitHub: takeover enqueue failure is retryable without duplicating the review", async () => {
    const store = new MemoryReviewJobStore();
    const marker = { labeled: 0, assigned: 0 };
    const workerQueue = flakyWorkerQueue(store, true);
    const logs: string[] = [];
    const handler = createFetchHandler(makeConfig({ githubWebhookSecret: "webhook-secret" }), {
      queue: store,
      logger: (message) => logs.push(message),
      worker: {
        queue: workerQueue,
        api: takeoverApi(marker) as never,
        logger: (message: string) => logs.push(message),
      },
    });

    const first = await handler(await signedGithubRequest(openedPayload("renovate", githubRepo), "github-takeover-1"));
    expect(first.status).toBe(503);
    expect(await responseJson(first)).toEqual({ error: "queue unavailable" });
    expect(store.rows.filter((row) => row.kind === "review")).toHaveLength(1);
    expect(store.rows.filter((row) => row.kind !== "review")).toHaveLength(0);

    const second = await handler(await signedGithubRequest(openedPayload("renovate", githubRepo), "github-takeover-1"));
    expect(second.status).toBe(202);
    expect(store.rows.filter((row) => row.kind === "review")).toHaveLength(1);
    expect(store.rows.filter((row) => row.kind !== "review")).toHaveLength(1);

    const replay = await handler(await signedGithubRequest(openedPayload("renovate", githubRepo), "github-takeover-1"));
    expect(replay.status).toBe(202);
    expect(await responseJson(replay)).toEqual({ queued: false, deduped: true });
    expect(store.rows).toHaveLength(2);
  });

  test("Gitea: takeover skip stays a non-error and enqueues nothing extra", async () => {
    const store = new MemoryReviewJobStore();
    const marker = { labeled: 0, assigned: 0 };
    const workerQueue = flakyWorkerQueue(store, false);
    const handler = createFetchHandler(makeConfig(), {
      queue: store,
      worker: { queue: workerQueue, api: takeoverApi(marker) as never },
    });
    const response = await handler(await reviewerRequest(openedPayload("alice"), { delivery: "gitea-takeover-skip" }));
    expect(response.status).toBe(202);
    expect(store.rows.filter((row) => row.kind === "review")).toHaveLength(1);
    expect(store.rows.filter((row) => row.kind !== "review")).toHaveLength(0);
    expect(workerQueue.calls()).toBe(0);
  });

  test("GitHub: takeover skip stays a non-error and enqueues nothing extra", async () => {
    const store = new MemoryReviewJobStore();
    const marker = { labeled: 0, assigned: 0 };
    const workerQueue = flakyWorkerQueue(store, false);
    const handler = createFetchHandler(makeConfig({ githubWebhookSecret: "webhook-secret" }), {
      queue: store,
      worker: { queue: workerQueue, api: takeoverApi(marker) as never },
    });
    const response = await handler(
      await signedGithubRequest(openedPayload("alice", githubRepo), "github-takeover-skip")
    );
    expect(response.status).toBe(202);
    expect(store.rows.filter((row) => row.kind === "review")).toHaveLength(1);
    expect(store.rows.filter((row) => row.kind !== "review")).toHaveLength(0);
    expect(workerQueue.calls()).toBe(0);
  });
});
