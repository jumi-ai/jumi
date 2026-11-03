import { describe, expect, test } from "bun:test";
import type { IssueApi } from "../src/gitea_issues.ts";
import { hasJumiLabel } from "../src/github_webhook.ts";
import { parsePushPayload, shouldEnqueuePushConflicts } from "../src/push_webhook.ts";
import type { IssueJob } from "../src/types.ts";
import type { WorkerQueueLike } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import {
  encodeJson,
  makeIssue,
  makePR,
  makePushPayload,
  makeRepo,
  makeUser,
  makeWorkerConfig,
  responseJson,
  signBody,
} from "./fixtures.ts";

const policy = {
  giteaUrl: "https://gitea.kirmanak.stream",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [],
  botUsername: "jumi",
};

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

function makeApi(overrides: Partial<Pick<IssueApi, "listOpenPulls" | "getIssue">> = {}) {
  return {
    listOpenPulls: async () => [jumiPr()],
    getIssue: async () => makeIssue(),
    ...overrides,
  };
}

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
  overrides: RequestInit & { event?: string; eventType?: string; secret?: string; raw?: Uint8Array } = {}
): Promise<Request> {
  const raw = overrides.raw ?? encodeJson(body);
  const secret = overrides.secret ?? "webhook-secret";
  const signature = await signBody(raw, secret);
  const headers = new Headers(overrides.headers);
  headers.set("content-type", "application/json");
  headers.set("x-gitea-signature", signature);
  if (overrides.event !== undefined) headers.set("x-gitea-event", overrides.event);
  else if (!overrides.eventType) headers.set("x-gitea-event", "push");
  if (overrides.eventType) headers.set("x-gitea-event-type", overrides.eventType);
  headers.set("x-gitea-delivery", "delivery-1");
  return new Request("https://worker.test/webhooks/gitea", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("shouldEnqueuePushConflicts", () => {
  test("enqueues when ref is the default branch and an in-scope jumi closer is assigned", async () => {
    const decision = await shouldEnqueuePushConflicts(makePushPayload(), policy, makeApi());
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs).toHaveLength(1);
    expect(decision.jobs[0]?.mode).toBe("conflict");
    expect(decision.jobs[0]?.issueNumber).toBe(12);
    expect(decision.jobs[0]?.prNumber).toBe(127);
    expect(decision.jobs[0]?.action).toBe("push");
    expect(decision.jobs[0]?.trigger).toEqual({ event: "push", sender: "alice" });
  });

  test("enqueues for a jumi branch PR whose body says Refs #N", async () => {
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload(),
      policy,
      makeApi({
        listOpenPulls: async () => [
          makePR({
            number: 127,
            title: "Fix the thing",
            body: "Refs #12",
            user: makeUser({ login: "jumi" }),
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo,
              repo_id: repo.id,
            },
          }),
        ],
      })
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs[0]?.issueNumber).toBe(12);
    expect(decision.jobs[0]?.prNumber).toBe(127);
  });

  test("skips push to a non-default branch", async () => {
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload({ ref: "refs/heads/jumi/issue-12-x" }),
      policy,
      makeApi()
    );
    expect(decision).toEqual({ type: "skip", reason: "not the default branch" });
  });

  test("skips tags", async () => {
    const decision = await shouldEnqueuePushConflicts(makePushPayload({ ref: "refs/tags/v1" }), policy, makeApi());
    expect(decision).toEqual({ type: "skip", reason: "not a branch ref" });
  });

  test("skips after all-zeros", async () => {
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload({ after: "0000000000000000000000000000000000000000" }),
      policy,
      makeApi()
    );
    expect(decision).toEqual({ type: "skip", reason: "deleted ref" });
  });

  test("skips missing after", async () => {
    const decision = await shouldEnqueuePushConflicts(makePushPayload({ after: undefined }), policy, makeApi());
    expect(decision).toEqual({ type: "skip", reason: "deleted ref" });
  });

  test("enqueues conflict for a labeled GitHub foreign PR", async () => {
    const githubRepo = makeRepo({
      html_url: "https://github.com/kirmanak/demo",
      clone_url: "https://github.com/kirmanak/demo.git",
    });
    const foreign = makePR({
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
    });
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload({ repository: githubRepo }),
      {
        giteaUrl: "https://github.com",
        allowedOrgs: ["kirmanak"],
        allowedRepos: [],
        botUsername: "kirmanak-jumi[bot]",
        isPickedUp: hasJumiLabel,
      },
      makeApi({ listOpenPulls: async () => [foreign] })
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs[0]?.mode).toBe("conflict");
    expect(decision.jobs[0]?.issueNumber).toBe(55);
    expect(decision.jobs[0]?.prNumber).toBe(55);
  });

  test("enqueues conflict for an assigned foreign PR", async () => {
    const foreign = makePR({
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
    });
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload(),
      policy,
      makeApi({ listOpenPulls: async () => [foreign] })
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs[0]?.mode).toBe("conflict");
    expect(decision.jobs[0]?.issueNumber).toBe(50);
    expect(decision.jobs[0]?.prNumber).toBe(50);
  });

  test("skips when listOpenPulls has no managed jumi PR", async () => {
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload(),
      policy,
      makeApi({
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #12", user: makeUser({ login: "alice" }) })],
      })
    );
    expect(decision).toEqual({ type: "skip", reason: "no managed jumi PRs" });
  });

  test("skips when closing issue is unassigned", async () => {
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload(),
      policy,
      makeApi({
        getIssue: async () =>
          makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
      })
    );
    expect(decision).toEqual({ type: "skip", reason: "no managed jumi PRs" });
  });

  test("skips when getIssue is 404 missing", async () => {
    const decision = await shouldEnqueuePushConflicts(
      makePushPayload(),
      policy,
      makeApi({
        getIssue: async () => {
          throw new Error(
            "Gitea API GET https://gitea.kirmanak.stream/api/v1/repos/kirmanak/demo/issues/12 → 404: not found"
          );
        },
      })
    );
    expect(decision).toEqual({ type: "skip", reason: "no managed jumi PRs" });
  });

  test("getIssue 5xx propagates", async () => {
    await expect(
      shouldEnqueuePushConflicts(
        makePushPayload(),
        policy,
        makeApi({
          getIssue: async () => {
            throw new Error(
              "Gitea API GET https://gitea.kirmanak.stream/api/v1/repos/kirmanak/demo/issues/12 → 500: boom"
            );
          },
        })
      )
    ).rejects.toThrow("→ 500");
  });
});

describe("push webhook HTTP", () => {
  test("enqueues X-Gitea-Event: push when a managed jumi closer exists", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(await signedRequest(makePushPayload(), { event: "push" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ queued: true, keys: ["kirmanak/demo#12"] });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.mode).toBe("conflict");
    expect(queue.jobs[0]?.prNumber).toBe(127);
  });

  test("skips push to refs/heads/jumi/issue-12-x", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(
      await signedRequest(makePushPayload({ ref: "refs/heads/jumi/issue-12-x" }), { event: "push" })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "not the default branch" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("skips refs/tags/v1", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(await signedRequest(makePushPayload({ ref: "refs/tags/v1" }), { event: "push" }));
    expect(response.status).toBe(202);
    expect((await responseJson(response)).skipped).toBeTruthy();
    expect(queue.jobs).toHaveLength(0);
  });

  test("skips after all-zeros / missing", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const zeros = await handler(
      await signedRequest(makePushPayload({ after: "0000000000000000000000000000000000000000" }), { event: "push" })
    );
    expect(zeros.status).toBe(202);
    expect(await responseJson(zeros)).toEqual({ skipped: "deleted ref" });
  });

  test("skips when listOpenPulls has no managed jumi PR", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: makeApi({ listOpenPulls: async () => [] }),
    });
    const response = await handler(await signedRequest(makePushPayload(), { event: "push" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "no managed jumi PRs" });
  });

  test("skips when closing issue is unassigned", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: makeApi({
        getIssue: async () => makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [] }),
      }),
    });
    const response = await handler(await signedRequest(makePushPayload(), { event: "push" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "no managed jumi PRs" });
  });

  test("skips X-Gitea-Event: pull_request", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(await signedRequest(makePushPayload(), { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported event pull_request" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("accepts Event-Type push if Event header is missing", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(await signedRequest(makePushPayload(), { event: "", eventType: "push" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ queued: true, keys: ["kirmanak/demo#12"] });
    expect(queue.jobs[0]?.mode).toBe("conflict");
  });

  test("malformed body → 202 skip, not 400", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(
      await signedRequest({}, { event: "push", raw: new TextEncoder().encode("{not-json") })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "malformed push payload" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("getIssue 5xx on push webhook is not 202 no-managed-PRs", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: makeApi({
        getIssue: async () => {
          throw new Error(
            "Gitea API GET https://gitea.kirmanak.stream/api/v1/repos/kirmanak/demo/issues/12 → 500: boom"
          );
        },
      }),
    });
    const response = await handler(await signedRequest(makePushPayload(), { event: "push" }));
    expect(response.status).toBe(500);
    const body = await responseJson(response);
    expect(body).toEqual({ error: "internal error" });
    expect(body.skipped).toBeUndefined();
    expect(queue.jobs).toHaveLength(0);
  });

  test("listOpenPulls failure → 5xx, not malformed skip", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: makeApi({
        listOpenPulls: async () => {
          throw new Error("gitea unavailable");
        },
      }),
    });
    const response = await handler(await signedRequest(makePushPayload(), { event: "push" }));
    expect(response.status).toBe(500);
    expect(await responseJson(response)).toEqual({ error: "internal error" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("enqueue failure → 5xx, not malformed skip", async () => {
    const jobs: IssueJob[] = [];
    const queue: WorkerQueueLike & { jobs: IssueJob[] } = {
      jobs,
      enqueue() {
        throw new Error("queue unavailable");
      },
    };
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(await signedRequest(makePushPayload(), { event: "push" }));
    expect(response.status).toBe(500);
    expect(await responseJson(response)).toEqual({ error: "internal error" });
  });

  test("HTTP handler does not call git / OpenCode", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(await signedRequest(makePushPayload(), { event: "push" }));
    expect(response.status).toBe(202);
    expect(queue.jobs[0]?.mode).toBe("conflict");
  });

  test("parsePushPayload requires repository and ref", () => {
    expect(() => parsePushPayload(encodeJson({ ref: "refs/heads/main" }))).toThrow("missing repository");
  });
});
