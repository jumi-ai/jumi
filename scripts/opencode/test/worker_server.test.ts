import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryReviewJobStore, QueueUnavailableError } from "../src/review_jobs.ts";
import { MemoryRouterSitStore } from "../src/router_sits.ts";
import type { IssueJob } from "../src/types.ts";
import type { WorkerQueueLike } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import {
  encodeJson,
  makeIssue,
  makeIssuePayload,
  makeLinkedIssue,
  makePayload,
  makePR,
  makeRepo,
  makeUser,
  makeWorkerConfig,
  responseJson,
  signBody,
} from "./fixtures.ts";

function makeQueue(): WorkerQueueLike & { jobs: IssueJob[] } {
  const jobs: IssueJob[] = [];
  return {
    jobs,
    enqueue(job) {
      jobs.push(job);
      return { key: `${job.owner}/${job.repo}#${job.issueNumber}`, queued: true };
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
  headers.set("x-gitea-event", overrides.event ?? "issues");
  if (overrides.eventType) headers.set("x-gitea-event-type", overrides.eventType);
  headers.set("x-gitea-delivery", "delivery-1");
  return new Request("https://worker.test/webhooks/gitea", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("createWorkerFetchHandler", () => {
  test("serves healthz and basic HTTP errors", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });

    expect((await handler(new Request("https://worker.test/healthz"))).status).toBe(200);
    expect(await responseJson(await handler(new Request("https://worker.test/healthz")))).toEqual({ ok: true });
    expect((await handler(new Request("https://worker.test/missing"))).status).toBe(404);
    expect((await handler(new Request("https://worker.test/webhooks/gitea"))).status).toBe(405);
    expect((await handler(new Request("https://worker.test/webhooks/gitea", { method: "POST" }))).status).toBe(415);
  });

  test("serves Prometheus token metrics without auth", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(new Request("https://worker.test/metrics"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("ai_token_exporter_up");
    expect(body).toContain("jumi_jobs_completed_total");
    expect(body).toContain("jumi_opencode_exits_total");
    expect(body).not.toContain("jumi_review_jobs");
    expect(body).not.toContain("jumi_webhooks_total");
    expect((await handler(new Request("https://worker.test/metrics", { method: "POST" }))).status).toBe(405);
  });

  test("rejects invalid signatures", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    expect((await handler(await signedRequest(makeIssuePayload(), { secret: "wrong" }))).status).toBe(401);
  });

  test("returns ok for ping events", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest({ zen: "pong" }, { event: "ping" }));
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ ok: true });
  });

  test("skips unsupported events", async () => {
    const logs: string[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: makeQueue(),
      logger: (message) => logs.push(message),
    });
    const response = await handler(await signedRequest(makeIssuePayload(), { event: "status" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported event status" });
    expect(logs.some((line) => line.includes("skipped unsupported event status"))).toBe(true);
  });

  test("does not scan on a timer or at boot", async () => {
    const src = await readFile(join(import.meta.dir, "../src/worker_server.ts"), "utf8");
    expect(src).not.toContain("runAssignedIssueScan");
    expect(src).not.toContain("scanIntervalMs");
    expect(src).not.toContain("scanAssignedIssues");
    const worker = await readFile(join(import.meta.dir, "../src/worker.ts"), "utf8");
    expect(worker).not.toContain("searchAssignedIssues");
    expect(worker).not.toContain("scanAssignedIssues");
  });

  test("skips X-Gitea-Event: pull_request opened", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest(makePayload(), { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action opened" });
  });

  test("skips pull_request synchronize 202 never 400", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(makePayload({ action: "synchronize" }), { event: "pull_request" })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action synchronize" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("skips malformed non-assign pull_request 202 never 400", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest({ action: "opened" }, { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action opened" });
  });

  test("enqueues follow-up when a foreign PR is assigned to the bot", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const repository = makePayload().repository;
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
              repo: repository,
              repo_id: repository.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#50", queued: true });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.issueNumber).toBe(50);
    expect(queue.jobs[0]?.prNumber).toBe(50);
  });

  test("skips PR-assign when the closing issue is already assigned to the bot", async () => {
    const queue = makeQueue();
    const cancelled: Array<{ owner: string; repo: string; issueNumber: number }> = [];
    const loaded: number[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: {
        listOpenPulls: async () => [],
        getIssue: async (_owner, _repo, index) => {
          loaded.push(index);
          return makeIssue();
        },
      },
      cancel: async (owner, repo, issueNumber) => {
        cancelled.push({ owner, repo, issueNumber });
        return { key: `${owner}/${repo}#${issueNumber}`, cancelled: true };
      },
    });
    const repository = makePayload().repository;
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "assigned",
          pull_request: makePR({
            number: 127,
            title: "Fix the thing",
            body: "Fixes #12",
            user: makeUser({ login: "jumi" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "closing issue already assigned" });
    expect(queue.jobs).toHaveLength(0);
    expect(cancelled).toEqual([]);
    expect(loaded).toEqual([12]);
  });

  test("standalone worker mailbox remembers an explicit skip as a sit", async () => {
    const queue = makeQueue();
    const sits = new MemoryRouterSitStore();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      sits,
      api: {
        listOpenPulls: async () => [],
        getIssue: async () => makeIssue(),
      },
    });
    const repository = makePayload().repository;
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "assigned",
          pull_request: makePR({
            number: 127,
            title: "Fix the thing",
            body: "Fixes #12",
            user: makeUser({ login: "jumi" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "closing issue already assigned" });
    expect(queue.jobs).toHaveLength(0);
    expect(await sits.get("kirmanak", "demo", 127)).toMatchObject({ reason: "implement-latch" });
  });

  test("skips PR-assign when getIssue of the closer fails", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: {
        listOpenPulls: async () => [],
        getIssue: async () => {
          throw new Error("gitea 502");
        },
      },
    });
    const repository = makePayload().repository;
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "assigned",
          pull_request: makePR({
            number: 127,
            title: "Fix the thing",
            body: "Fixes #12",
            user: makeUser({ login: "jumi" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "failed to load issue" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("cancels when a foreign PR is unassigned from the bot", async () => {
    const cancelled: Array<{ owner: string; repo: string; issueNumber: number }> = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: makeQueue(),
      cancel: async (owner, repo, issueNumber) => {
        cancelled.push({ owner, repo, issueNumber });
        return { key: `${owner}/${repo}#${issueNumber}`, cancelled: true };
      },
    });
    const repository = makePayload().repository;
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "unassigned",
          pull_request: makePR({
            number: 50,
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "alice" }),
            assignees: [makeUser({ login: "alice" })],
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#50", cancelled: true });
    expect(cancelled).toEqual([{ owner: "kirmanak", repo: "demo", issueNumber: 50 }]);
  });

  test("enqueues Gitea issue_assign deliveries (Event=issues, Event-Type=issue_assign)", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(makeIssuePayload({ action: "assigned" }), { event: "issues", eventType: "issue_assign" })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs).toHaveLength(1);
  });

  test("enqueues assigned issue events", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(await signedRequest(makeIssuePayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.delivery).toBe("delivery-1");
    expect(queue.jobs[0]?.issueNumber).toBe(12);
  });

  test("cancels when the bot is unassigned", async () => {
    const cancelled: Array<{ owner: string; repo: string; issueNumber: number }> = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: makeQueue(),
      cancel: async (owner, repo, issueNumber) => {
        cancelled.push({ owner, repo, issueNumber });
        return { key: `${owner}/${repo}#${issueNumber}`, cancelled: true };
      },
    });
    const response = await handler(
      await signedRequest(
        makeIssuePayload({
          action: "unassigned",
          issue: makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
        })
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", cancelled: true });
    expect(cancelled).toEqual([{ owner: "kirmanak", repo: "demo", issueNumber: 12 }]);
  });

  test("skips pull request issues", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(makeIssuePayload({ issue: makeIssue({ pull_request: { merged_at: null } }) }))
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "pull request issue" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("closed of a blocker wakes assigned blocked issues and does not enqueue the blocker", async () => {
    const queue = makeQueue();
    const blocks: number[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: {
        listOpenPulls: async () => [],
        listIssueBlocks: async (_owner, _repo, index) => {
          blocks.push(index);
          if (index !== 196) return [];
          return [
            makeLinkedIssue({
              number: 206,
              title: "stale",
              body: "stale",
              html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/206",
            }),
          ];
        },
        getIssue: async (_owner, _repo, index) =>
          makeIssue({
            number: index,
            title: "Slice two",
            body: "Depends on #196",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/206",
            updated_at: "2026-05-24T00:00:00Z",
          }),
        getRepo: async () => makeRepo(),
      },
    });
    const response = await handler(
      await signedRequest(makeIssuePayload({ action: "closed", issue: makeIssue({ number: 196, state: "closed" }) }))
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#206", queued: true });
    expect(blocks).toEqual([196, 206]);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.issueNumber).toBe(206);
    expect(queue.jobs[0]?.title).toBe("Slice two");
    expect(queue.jobs[0]?.body).toBe("Depends on #196");
    expect(queue.jobs[0]?.issueUpdatedAt).toBe("2026-05-24T00:00:00Z");
  });

  test("closed without a blocks API still 202-skips the closed issue", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(makeIssuePayload({ action: "closed", issue: makeIssue({ number: 196, state: "closed" }) }))
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action closed" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("closed blocker issue returns 503 when listing blocks fails", async () => {
    const logs: string[] = [];
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      logger: (message) => logs.push(message),
      api: {
        listOpenPulls: async () => [],
        listIssueBlocks: async () => {
          throw new Error("blocks down");
        },
        getIssue: async () => makeIssue({ number: 206 }),
        getRepo: async () => makeRepo(),
      },
    });
    const response = await handler(
      await signedRequest(makeIssuePayload({ action: "closed", issue: makeIssue({ number: 196, state: "closed" }) }))
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "failed to wake waiting issues" });
    expect(logs.some((line) => line.includes("blocks down"))).toBe(true);
    expect(logs.some((line) => line.includes("unsupported action closed"))).toBe(false);
    expect(queue.jobs).toHaveLength(0);
  });

  test("reopened blocker returns 503 when listing blocks fails", async () => {
    const logs: string[] = [];
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      logger: (message) => logs.push(message),
      api: {
        listOpenPulls: async () => [],
        listIssueBlocks: async () => {
          throw new Error("blocks down");
        },
        getIssue: async () => makeIssue({ number: 206 }),
        getRepo: async () => makeRepo(),
      },
    });
    const response = await handler(
      await signedRequest(makeIssuePayload({ action: "reopened", issue: makeIssue({ number: 196 }) }))
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "failed to wake waiting issues" });
    expect(logs.some((line) => line.includes("blocks down"))).toBe(true);
    expect(queue.jobs).toHaveLength(0);
  });

  test("closed assigned foreign PR wakes other assigned issues in the repo", async () => {
    const queue = makeQueue();
    const repository = makeRepo();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: {
        listOpenPulls: async () => [],
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386, title: "stale" })],
        getIssue: async () =>
          makeIssue({
            number: 4386,
            title: "Configure",
            body: "do it",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/4386",
            updated_at: "2026-09-15T00:00:00Z",
          }),
        getRepo: async () => repository,
      },
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "closed",
          pull_request: makePR({
            number: 4373,
            state: "closed",
            merged: true,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/4373",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
          repository,
        }),
        { event: "pull_request" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#4386", queued: true });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.issueNumber).toBe(4386);
    expect(queue.jobs[0]?.title).toBe("Configure");
    expect(queue.jobs[0]?.mode).toBeUndefined();
  });

  test("closed assigned foreign PR still wakes when listing blocks fails", async () => {
    const logs: string[] = [];
    const queue = makeQueue();
    const repository = makeRepo();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      logger: (message) => logs.push(message),
      api: {
        listOpenPulls: async () => [],
        listIssueBlocks: async () => {
          throw new Error("blocks down");
        },
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386, title: "stale" })],
        getIssue: async () =>
          makeIssue({
            number: 4386,
            title: "Configure",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/4386",
          }),
        getRepo: async () => repository,
      },
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "closed",
          pull_request: makePR({
            number: 4373,
            state: "closed",
            merged: true,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/4373",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
          repository,
        }),
        { event: "pull_request" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#4386", queued: true });
    expect(logs.some((line) => line.includes("blocks down"))).toBe(true);
    expect(queue.jobs).toHaveLength(1);
  });

  test("unassigned foreign PR cancels then wakes other assigned issues", async () => {
    const queue = makeQueue();
    const cancelled: Array<{ owner: string; repo: string; issueNumber: number }> = [];
    const repository = makeRepo();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: {
        listOpenPulls: async () => [],
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386 })],
        getIssue: async () =>
          makeIssue({
            number: 4386,
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/4386",
          }),
        getRepo: async () => repository,
      },
      cancel: async (owner, repo, issueNumber) => {
        cancelled.push({ owner, repo, issueNumber });
        return { key: `${owner}/${repo}#${issueNumber}`, cancelled: true };
      },
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "unassigned",
          assignee: makeUser({ login: "jumi" }),
          pull_request: makePR({
            number: 4373,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "alice" }),
            assignees: [makeUser({ login: "alice" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/4373",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
          repository,
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#4386", queued: true });
    expect(cancelled).toEqual([{ owner: "kirmanak", repo: "demo", issueNumber: 4373 }]);
    expect(queue.jobs.map((job) => job.issueNumber)).toEqual([4386]);
  });

  test("Gitea unassigned foreign PR without assignee cancels then wakes other assigned issues", async () => {
    const queue = makeQueue();
    const cancelled: Array<{ owner: string; repo: string; issueNumber: number }> = [];
    const repository = makeRepo();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: {
        listOpenPulls: async () => [],
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386 })],
        getIssue: async () =>
          makeIssue({
            number: 4386,
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/4386",
          }),
        getRepo: async () => repository,
      },
      cancel: async (owner, repo, issueNumber) => {
        cancelled.push({ owner, repo, issueNumber });
        return { key: `${owner}/${repo}#${issueNumber}`, cancelled: true };
      },
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "unassigned",
          pull_request: makePR({
            number: 4373,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "alice" }),
            assignees: [makeUser({ login: "alice" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/4373",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
          repository,
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#4386", queued: true });
    expect(cancelled).toEqual([{ owner: "kirmanak", repo: "demo", issueNumber: 4373 }]);
    expect(queue.jobs.map((job) => job.issueNumber)).toEqual([4386]);
  });

  test("closed assigned foreign PR returns 503 when listing assigned issues fails", async () => {
    const logs: string[] = [];
    const queue = makeQueue();
    const repository = makeRepo();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      logger: (message) => logs.push(message),
      api: {
        listOpenPulls: async () => [],
        listRepoIssues: async () => {
          throw new Error("issues down");
        },
        getIssue: async () => makeIssue({ number: 4386 }),
        getRepo: async () => repository,
      },
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "closed",
          pull_request: makePR({
            number: 4373,
            state: "closed",
            merged: true,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/4373",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
          repository,
        }),
        { event: "pull_request" }
      )
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "failed to wake waiting issues" });
    expect(logs.some((line) => line.includes("issues down"))).toBe(true);
    expect(logs.some((line) => line.includes("unsupported action closed"))).toBe(false);
    expect(queue.jobs).toHaveLength(0);
  });

  test("unassigned foreign PR returns 503 when wake listing fails after cancel", async () => {
    const logs: string[] = [];
    const queue = makeQueue();
    const cancelled: Array<{ owner: string; repo: string; issueNumber: number }> = [];
    const repository = makeRepo();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      logger: (message) => logs.push(message),
      api: {
        listOpenPulls: async () => [],
        listRepoIssues: async () => {
          throw new Error("issues down");
        },
        getIssue: async () => makeIssue({ number: 4386 }),
        getRepo: async () => repository,
      },
      cancel: async (owner, repo, issueNumber) => {
        cancelled.push({ owner, repo, issueNumber });
        return { key: `${owner}/${repo}#${issueNumber}`, cancelled: true };
      },
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "unassigned",
          assignee: makeUser({ login: "jumi" }),
          pull_request: makePR({
            number: 4373,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "alice" }),
            assignees: [makeUser({ login: "alice" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/4373",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
          repository,
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "failed to wake waiting issues" });
    expect(cancelled).toEqual([{ owner: "kirmanak", repo: "demo", issueNumber: 4373 }]);
    expect(logs.some((line) => line.includes("issues down"))).toBe(true);
    expect(queue.jobs).toHaveLength(0);
  });

  test("closed blocker PR returns 503 when listing blocks fails", async () => {
    const logs: string[] = [];
    const queue = makeQueue();
    const repository = makeRepo();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      logger: (message) => logs.push(message),
      api: {
        listOpenPulls: async () => [],
        listIssueBlocks: async () => {
          throw new Error("blocks down");
        },
        getIssue: async () => makeIssue({ number: 206 }),
        getRepo: async () => repository,
      },
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "closed",
          pull_request: makePR({
            number: 200,
            state: "closed",
            merged: true,
            body: "Fixes #196",
            user: makeUser({ login: "alice" }),
            assignee: null,
            assignees: [],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/200",
            head: {
              label: "kirmanak:fix",
              ref: "fix",
              sha: "abc",
              repo: repository,
              repo_id: repository.id,
            },
          }),
          repository,
        }),
        { event: "pull_request" }
      )
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "failed to wake waiting issues" });
    expect(logs.some((line) => line.includes("blocks down"))).toBe(true);
    expect(logs.some((line) => line.includes("unsupported action closed"))).toBe(false);
    expect(queue.jobs).toHaveLength(0);
  });

  test("closed assigned foreign PR returns 503 when listing open pulls fails", async () => {
    const logs: string[] = [];
    const queue = makeQueue();
    const repository = makeRepo();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      logger: (message) => logs.push(message),
      api: {
        listOpenPulls: async () => {
          throw new Error("pulls down");
        },
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386 })],
        getIssue: async () => makeIssue({ number: 4386 }),
        getRepo: async () => repository,
      },
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "closed",
          pull_request: makePR({
            number: 4373,
            state: "closed",
            merged: true,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/4373",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
          repository,
        }),
        { event: "pull_request" }
      )
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "failed to wake waiting issues" });
    expect(logs.some((line) => line.includes("pulls down"))).toBe(true);
    expect(logs.some((line) => line.includes("unsupported action closed"))).toBe(false);
    expect(queue.jobs).toHaveLength(0);
  });

  test("closed pull_request with a missing pull_request is 400 not 503", async () => {
    const logs: string[] = [];
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      logger: (message) => logs.push(message),
      api: {
        listOpenPulls: async () => [],
        getIssue: async () => makeIssue({ number: 4386 }),
      },
    });
    const response = await handler(
      await signedRequest({ action: "closed", repository: makeRepo() }, { event: "pull_request" })
    );
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({ error: "invalid webhook payload" });
    expect(logs.some((line) => line.includes("missing pull_request"))).toBe(true);
    expect(queue.jobs).toHaveLength(0);
  });

  test("closed pull_request for a disallowed org is 400 not 503", async () => {
    const logs: string[] = [];
    const queue = makeQueue();
    const other = makeRepo({ owner: makeUser({ login: "other" }), full_name: "other/demo" });
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      logger: (message) => logs.push(message),
      api: {
        listOpenPulls: async () => [],
        getIssue: async () => makeIssue({ number: 4386 }),
      },
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "closed",
          repository: other,
          pull_request: makePR({
            state: "closed",
            merged: true,
            html_url: "https://gitea.kirmanak.stream/other/demo/pulls/7",
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
    expect(queue.jobs).toHaveLength(0);
  });

  test("closed pull_request without wait-clear API still 202-skips", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(makePayload({ action: "closed", pull_request: makePR({ state: "closed", merged: true }) }), {
        event: "pull_request",
      })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action closed" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("reopened of a blocker enqueues the blocker and wakes assigned blocked issues", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: {
        listOpenPulls: async () => [],
        listIssueBlocks: async () => [makeLinkedIssue({ number: 206 })],
        getIssue: async (_owner, _repo, index) =>
          makeIssue({
            number: index,
            title: index === 206 ? "Slice two" : "Slice one",
            html_url: `https://gitea.kirmanak.stream/kirmanak/demo/issues/${index}`,
          }),
        getRepo: async () => makeRepo(),
      },
    });
    const response = await handler(
      await signedRequest(makeIssuePayload({ action: "reopened", issue: makeIssue({ number: 196 }) }))
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ queued: true, keys: ["kirmanak/demo#196", "kirmanak/demo#206"] });
    expect(queue.jobs.map((job) => job.issueNumber)).toEqual([196, 206]);
  });

  test("returns bad request for valid signatures with invalid payloads", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest({ action: "assigned" }));
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({ error: "invalid webhook payload" });
  });

  test("first-run assign still 202s on the in-memory queue without a store", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(await signedRequest(makeIssuePayload({ action: "assigned" })));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBeUndefined();
  });

  test("ledger enqueue uses the implement job key", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: { enqueue: (job) => store.enqueueIssue(job) },
    });
    const response = await handler(await signedRequest(makeIssuePayload({ action: "assigned" })));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
    expect(store.rows[0]?.kind).toBe("implement");
    expect(store.rows[0]?.state).toBe("queued");
  });

  test("fails closed with 503 when the ledger is unavailable", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: {
        enqueue() {
          throw new QueueUnavailableError("down");
        },
      },
    });
    const response = await handler(await signedRequest(makeIssuePayload({ action: "assigned" })));
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "queue unavailable" });
  });
});
