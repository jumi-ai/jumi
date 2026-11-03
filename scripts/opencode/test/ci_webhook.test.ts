import { describe, expect, test } from "bun:test";
import {
  parseWorkflowJobPayload,
  shouldEnqueueWorkflowJobFollowUp,
  shouldEnqueueWorkflowJobReview,
} from "../src/ci_webhook.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { hasJumiLabel } from "../src/github_webhook.ts";
import type { IssueJob } from "../src/types.ts";
import type { WorkerQueueLike } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import {
  encodeJson,
  makeIssue,
  makePR,
  makeRepo,
  makeUser,
  makeWorkerConfig,
  makeWorkflowJobPayload,
  responseJson,
  signBody,
} from "./fixtures.ts";

const policy = {
  giteaUrl: "https://gitea.kirmanak.stream",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [] as string[],
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
  else if (!overrides.eventType) headers.set("x-gitea-event", "workflow_job");
  if (overrides.eventType) headers.set("x-gitea-event-type", overrides.eventType);
  headers.set("x-gitea-delivery", "delivery-1");
  return new Request("https://worker.test/webhooks/gitea", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("shouldEnqueueWorkflowJobFollowUp", () => {
  test("enqueues follow-up for an in-scope jumi closer matching head sha", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(makeWorkflowJobPayload(), policy, makeApi());
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs).toHaveLength(1);
    expect(decision.jobs[0]?.mode).toBe("follow-up");
    expect(decision.jobs[0]?.issueNumber).toBe(12);
    expect(decision.jobs[0]?.prNumber).toBe(127);
    expect(decision.jobs[0]?.headSha).toBe("headsha");
    expect(decision.jobs[0]?.trigger).toEqual({ event: "workflow_job", sender: "alice", workflowJobId: 99 });
  });

  test("enqueues follow-up for a jumi branch PR whose body says Refs #N", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload(),
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
    expect(decision.jobs).toHaveLength(1);
    expect(decision.jobs[0]?.issueNumber).toBe(12);
    expect(decision.jobs[0]?.prNumber).toBe(127);
  });

  test("stays routed by the branch when a jumi body names a different issue", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload(),
      policy,
      makeApi({
        listOpenPulls: async () => [
          makePR({
            number: 127,
            title: "Fix the thing",
            body: "Fixes #13",
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
  });

  test("matches head branch when sha differs from live PR head", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload({
        workflow_job: {
          id: 99,
          name: "build",
          head_sha: "oldsha",
          head_branch: "jumi/issue-12-fix-the-thing",
        },
      }),
      policy,
      makeApi()
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs[0]?.headSha).toBe("headsha");
  });

  test("skips when sender is jumi but still enqueues (Actions may appear as the bot)", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload({ sender: makeUser({ login: "jumi" }) }),
      policy,
      makeApi()
    );
    expect(decision.type).toBe("enqueue");
  });

  test("skips human-only closer", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload(),
      policy,
      makeApi({
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #12", user: makeUser({ login: "alice" }) })],
      })
    );
    expect(decision).toEqual({ type: "skip", reason: "not an in-scope jumi pull request" });
  });

  test("skips when closing issue is unassigned", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload(),
      policy,
      makeApi({
        getIssue: async () =>
          makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
      })
    );
    expect(decision).toEqual({ type: "skip", reason: "not an in-scope jumi pull request" });
  });

  test("enqueues follow-up for a labeled GitHub foreign PR matching head sha", async () => {
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
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload({
        repository: githubRepo,
        workflow_job: { id: 99, name: "build", head_sha: "headsha", head_branch: "renovate/all-digest" },
      }),
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
    expect(decision.jobs[0]?.issueNumber).toBe(55);
    expect(decision.jobs[0]?.prNumber).toBe(55);
  });

  test("enqueues follow-up for an assigned foreign PR matching head sha", async () => {
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
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload({
        workflow_job: { id: 99, name: "build", head_sha: "headsha", head_branch: "renovate/all-digest" },
      }),
      policy,
      makeApi({ listOpenPulls: async () => [foreign] })
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs[0]?.issueNumber).toBe(50);
    expect(decision.jobs[0]?.prNumber).toBe(50);
  });

  test("skips when head does not match any open PR", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload({
        workflow_job: { id: 1, name: "build", head_sha: "other", head_branch: "main" },
      }),
      policy,
      makeApi()
    );
    expect(decision).toEqual({ type: "skip", reason: "not an in-scope jumi pull request" });
  });

  test("skips queued, in_progress, and waiting jobs without listing pulls", async () => {
    let listed = 0;
    const api = makeApi({
      listOpenPulls: async () => {
        listed++;
        return [jumiPr()];
      },
    });
    for (const status of ["queued", "in_progress", "waiting"] as const) {
      const decision = await shouldEnqueueWorkflowJobFollowUp(
        makeWorkflowJobPayload({
          action: status,
          workflow_job: {
            id: 99,
            name: "build",
            status,
            head_sha: "headsha",
            head_branch: "jumi/issue-12-fix-the-thing",
          },
        }),
        policy,
        api
      );
      expect(decision).toEqual({ type: "skip", reason: `workflow_job ${status}` });
    }
    expect(listed).toBe(0);
  });

  test("enqueues on completed success and skipped conclusions", async () => {
    for (const conclusion of ["success", "skipped"] as const) {
      const decision = await shouldEnqueueWorkflowJobFollowUp(
        makeWorkflowJobPayload({
          workflow_job: {
            id: 99,
            name: "build",
            status: "completed",
            conclusion,
            head_sha: "headsha",
            head_branch: "jumi/issue-12-fix-the-thing",
          },
        }),
        policy,
        makeApi()
      );
      expect(decision.type).toBe("enqueue");
    }
  });
});

describe("shouldEnqueueWorkflowJobReview", () => {
  test("enqueues review for a matching open PR", async () => {
    const decision = await shouldEnqueueWorkflowJobReview(makeWorkflowJobPayload(), policy, makeApi());
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs).toHaveLength(1);
    expect(decision.jobs[0]?.prNumber).toBe(127);
    expect(decision.jobs[0]?.headSha).toBe("headsha");
  });

  test("skips draft or WIP PRs", async () => {
    const decision = await shouldEnqueueWorkflowJobReview(
      makeWorkflowJobPayload(),
      policy,
      makeApi({
        listOpenPulls: async () => [jumiPr(), makePR({ number: 8, title: "WIP: later", head: jumiPr().head })],
      })
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs.map((job) => job.prNumber)).toEqual([127]);
  });

  test("skips in_progress jobs without listing pulls", async () => {
    let listed = 0;
    const decision = await shouldEnqueueWorkflowJobReview(
      makeWorkflowJobPayload({
        action: "in_progress",
        workflow_job: { id: 99, name: "build", status: "in_progress", head_sha: "headsha" },
      }),
      policy,
      makeApi({
        listOpenPulls: async () => {
          listed++;
          return [jumiPr()];
        },
      })
    );
    expect(decision).toEqual({ type: "skip", reason: "workflow_job in_progress" });
    expect(listed).toBe(0);
  });
});

describe("createWorkerFetchHandler workflow_job", () => {
  test("enqueues on X-Gitea-Event workflow_job", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(await signedRequest(makeWorkflowJobPayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ queued: true, keys: ["kirmanak/demo#12"] });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.trigger?.event).toBe("workflow_job");
  });

  test("malformed payload is 202 skip never 400", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue(), api: makeApi() });
    const response = await handler(await signedRequest({ zen: "nope" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "malformed workflow_job payload" });
  });

  test("status event stays skipped", async () => {
    const logs: string[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: makeQueue(),
      api: makeApi(),
      logger: (message) => logs.push(message),
    });
    const response = await handler(await signedRequest(makeWorkflowJobPayload(), { event: "status" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported event status" });
    expect(logs.some((line) => line.includes("skipped unsupported event status"))).toBe(true);
  });

  test("skips in_progress workflow_job without enqueue", async () => {
    const queue = makeQueue();
    const logs: string[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: makeApi(),
      logger: (message) => logs.push(message),
    });
    const response = await handler(
      await signedRequest(
        makeWorkflowJobPayload({
          action: "in_progress",
          workflow_job: {
            id: 99,
            name: "build",
            status: "in_progress",
            head_sha: "headsha",
            head_branch: "jumi/issue-12-fix-the-thing",
          },
        })
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "workflow_job in_progress" });
    expect(queue.jobs).toHaveLength(0);
    expect(logs.some((line) => line.includes("skipped workflow_job in_progress"))).toBe(true);
  });

  test("does not call listOpenPulls on malformed body", async () => {
    let listed = 0;
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: makeQueue(),
      api: {
        listOpenPulls: async () => {
          listed++;
          return [];
        },
        getIssue: async () => makeIssue(),
      },
    });
    await handler(await signedRequest({ not: "a job" }));
    expect(listed).toBe(0);
  });
});

describe("parseWorkflowJobPayload", () => {
  test("accepts a Gitea workflow_job body", () => {
    const parsed = parseWorkflowJobPayload(encodeJson(makeWorkflowJobPayload()));
    expect(parsed.workflow_job?.head_sha).toBe("headsha");
    expect(parsed.repository.full_name).toBe("kirmanak/demo");
  });
});
