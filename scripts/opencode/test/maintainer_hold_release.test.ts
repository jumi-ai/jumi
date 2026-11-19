import { describe, expect, test } from "bun:test";
import { assessMaintainerHoldRelease } from "../src/followup.ts";
import { shouldEnqueueIssueCommentFollowUp } from "../src/followup_webhook.ts";
import { isReleaseCandidateSkipReason, tryReleaseMaintainerHold } from "../src/maintainer_hold_release.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { MemoryRouterSitStore, normalizeSitReason } from "../src/router_sits.ts";
import { createFetchHandler } from "../src/server.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import {
  encodeJson,
  makeComment,
  makeConfig,
  makeIssue,
  makeIssueCommentPayload,
  makePayload,
  makePR,
  makeRepo,
  makeUser,
  makeWorkerConfig,
  responseJson,
  signBody,
} from "./fixtures.ts";
import { makeQueue, workerIssueCommentRequest } from "./harness/webhook.ts";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function nonJumiPr(sha = HEAD) {
  const repo = makeRepo();
  return makePR({
    number: 15,
    title: "Chronicle of Lenora",
    body: "Lore update",
    user: makeUser({ login: "sampo" }),
    assignee: null,
    assignees: [],
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/15",
    head: {
      label: "kirmanak:lore/lenora-chronicle-kildrak",
      ref: "lore/lenora-chronicle-kildrak",
      sha,
      repo,
      repo_id: repo.id,
    },
  });
}

function heldStickyBody(sha = HEAD) {
  return [
    "<!-- jumi-review:kirmanak/demo#15 -->",
    "### Jumi review",
    "",
    `Reviewed commit: \`${sha}\``,
    "",
    "src/table.ts:12: ❓ maintainer: can the table see that?",
    "<!-- jumi-check: success -->",
  ].join("\n");
}

function heldSticky(sha = HEAD) {
  return makeComment({
    id: 38022,
    body: heldStickyBody(sha),
    user: makeUser({ login: "jumi" }),
  });
}

function releaseApi(opts: {
  statuses: Array<{ state: string; description?: string; context?: string }>;
  stickySha?: string;
  permission?: string;
  settingsContent?: string | undefined;
  withSticky?: boolean;
  bugs?: boolean;
}) {
  const pr = nonJumiPr(opts.stickySha === OLD_HEAD ? HEAD : HEAD);
  const sticky = opts.withSticky === false ? [] : [heldSticky(opts.stickySha ?? HEAD)];
  const body =
    opts.bugs === true
      ? [
          "<!-- jumi-review:kirmanak/demo#15 -->",
          "### Jumi review",
          "",
          `Reviewed commit: \`${HEAD}\``,
          "",
          "src/table.ts:12: 🔴 bug: null deref. Guard it.",
          "src/table.ts:13: ❓ maintainer: can the table see that?",
          "<!-- jumi-check: failure; 1 blocking -->",
        ].join("\n")
      : undefined;
  const bugSticky = body === undefined ? [] : [makeComment({ id: 38023, body, user: makeUser({ login: "jumi" }) })];
  return {
    getPR: async () => pr,
    listPullReviews: async () => [],
    listIssueComments: async () => (body === undefined ? sticky : bugSticky),
    listPullReviewComments: async () => [],
    createCommitStatus: async (
      _owner: string,
      _repo: string,
      _sha: string,
      status: { state: string; description?: string; context?: string }
    ) => {
      opts.statuses.push(status);
      return status as never;
    },
    getRepoFile: async () =>
      opts.settingsContent === undefined ? { found: false } : { found: true, content: opts.settingsContent },
    getCollaboratorPermission: async () => ({ permission: opts.permission ?? "write" }),
    listOpenPulls: async () => [],
    getIssue: async () => makeIssue(),
  };
}

describe("assessMaintainerHoldRelease", () => {
  const good = "src/a.ts:1: ❓ maintainer: please answer?\n<!-- jumi-check: success -->";
  test("releases on complete success with one open maintainer question", () => {
    const assessment = assessMaintainerHoldRelease({
      reviewBody: good,
      inlines: [],
      prAuthorLogin: "sampo",
      blockingAuthors: [],
      botUsername: "jumi",
      holdEnabled: true,
    });
    expect(assessment.releasable).toBe(true);
    expect(assessment.openMaintainers).toBe(1);
    expect(assessment.description).toBe("No blocking issues");
  });

  test("stays failed with an open bug plus a maintainer question", () => {
    const assessment = assessMaintainerHoldRelease({
      reviewBody:
        "src/a.ts:1: 🔴 bug: null deref.\nsrc/a.ts:2: ❓ maintainer: please answer?\n<!-- jumi-check: failure; 1 blocking -->",
      inlines: [],
      prAuthorLogin: "sampo",
      blockingAuthors: [],
      botUsername: "jumi",
      holdEnabled: true,
    });
    expect(assessment.releasable).toBe(false);
    expect(assessment.completeSuccess).toBe(false);
  });

  test("does not release when the hold is disabled", () => {
    const assessment = assessMaintainerHoldRelease({
      reviewBody: good,
      inlines: [],
      prAuthorLogin: "sampo",
      blockingAuthors: [],
      botUsername: "jumi",
      holdEnabled: false,
    });
    expect(assessment.releasable).toBe(false);
    expect(assessment.keepReason).toBe("hold disabled");
  });

  test("does not release with no open maintainer questions", () => {
    const assessment = assessMaintainerHoldRelease({
      reviewBody: "No blocking issues.\n<!-- jumi-check: success -->",
      inlines: [],
      prAuthorLogin: "sampo",
      blockingAuthors: [],
      botUsername: "jumi",
      holdEnabled: true,
    });
    expect(assessment.releasable).toBe(false);
  });
});

describe("tryReleaseMaintainerHold on a non-Jumi PR", () => {
  test("trusted comment releases the held head with no worker job", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const api = releaseApi({ statuses });
    const payload = makeIssueCommentPayload({
      sender: makeUser({ login: "kirmanak" }),
      comment: makeComment({
        id: 99,
        body: "@jumi Yes, the table can see that",
        user: makeUser({ login: "kirmanak" }),
      }),
      issue: makeIssue({
        number: 15,
        title: "Chronicle of Lenora",
        body: "Lore update",
        html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/15",
        user: makeUser({ login: "sampo" }),
        assignee: null,
        assignees: [],
        pull_request: { merged_at: null },
      }),
      pull_request: nonJumiPr(),
    });
    const scope = shouldEnqueueIssueCommentFollowUp(
      payload,
      { giteaUrl: "https://gitea.kirmanak.stream", allowedOrgs: ["kirmanak"], allowedRepos: [], botUsername: "jumi" },
      "issue_comment"
    );
    expect(scope).toEqual({ type: "skip", reason: "not a jumi pull request" });
    expect(isReleaseCandidateSkipReason("not a jumi pull request")).toBe(true);

    const logged: string[] = [];
    const outcome = await tryReleaseMaintainerHold({
      api: api as never,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 15,
      senderLogin: "kirmanak",
      botUsername: "jumi",
      trustedSenderLogins: [],
      followupIgnoreLogins: [],
      defaultBranch: "main",
      logger: (message) => logged.push(message),
    });
    expect(outcome.outcome).toBe("released");
    if (outcome.outcome === "released") {
      expect(outcome.headSha).toBe(HEAD);
      expect(outcome.openMaintainers).toBe(1);
    }
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(logged.some((line) => line.includes("maintainer hold released for kirmanak/demo#15"))).toBe(true);
  });

  test("untrusted sender does not release", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const api = releaseApi({ statuses, permission: "read" });
    const logged: string[] = [];
    const outcome = await tryReleaseMaintainerHold({
      api: api as never,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 15,
      senderLogin: "mallory",
      botUsername: "jumi",
      trustedSenderLogins: [],
      followupIgnoreLogins: [],
      defaultBranch: "main",
      logger: (message) => logged.push(message),
    });
    expect(outcome).toEqual({ outcome: "skip", reason: "sender lacks write access" });
    expect(statuses).toHaveLength(0);
    expect(normalizeSitReason("sender lacks write access")).toBe("no-write-access");
  });

  test("bot sender does not release", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const api = releaseApi({ statuses });
    const outcome = await tryReleaseMaintainerHold({
      api: api as never,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 15,
      senderLogin: "jumi",
      botUsername: "jumi",
      trustedSenderLogins: [],
      followupIgnoreLogins: [],
      defaultBranch: "main",
    });
    expect(outcome).toEqual({ outcome: "skip", reason: "sender is bot" });
    expect(statuses).toHaveLength(0);
  });

  test("review on an older head does not release", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const api = releaseApi({ statuses, stickySha: OLD_HEAD });
    const logged: string[] = [];
    const outcome = await tryReleaseMaintainerHold({
      api: api as never,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 15,
      senderLogin: "kirmanak",
      botUsername: "jumi",
      trustedSenderLogins: [],
      followupIgnoreLogins: [],
      defaultBranch: "main",
      logger: (message) => logged.push(message),
    });
    expect(outcome.outcome).toBe("skip");
    if (outcome.outcome === "skip") {
      expect(outcome.reason.startsWith("PR head changed from ")).toBe(true);
      expect(normalizeSitReason(outcome.reason)).toBeUndefined();
    }
    expect(statuses).toHaveLength(0);
    expect(logged.some((line) => line.includes("PR head changed"))).toBe(true);
  });

  test("disabled hold does not release", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const api = releaseApi({ statuses, settingsContent: "maintainer_questions_hold_merge: false\n" });
    const outcome = await tryReleaseMaintainerHold({
      api: api as never,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 15,
      senderLogin: "kirmanak",
      botUsername: "jumi",
      trustedSenderLogins: [],
      followupIgnoreLogins: [],
      defaultBranch: "main",
    });
    expect(outcome).toEqual({ outcome: "skip", reason: "maintainer hold disabled" });
    expect(statuses).toHaveLength(0);
    expect(normalizeSitReason("maintainer hold disabled")).toBeUndefined();
  });

  test("open bug plus maintainer question stays failed", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const api = releaseApi({ statuses, bugs: true });
    const logged: string[] = [];
    const outcome = await tryReleaseMaintainerHold({
      api: api as never,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 15,
      senderLogin: "kirmanak",
      botUsername: "jumi",
      trustedSenderLogins: [],
      followupIgnoreLogins: [],
      defaultBranch: "main",
      logger: (message) => logged.push(message),
    });
    expect(outcome.outcome).toBe("skip");
    if (outcome.outcome === "skip") {
      expect(outcome.reason).not.toBe("not a jumi pull request");
    }
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(0);
    expect(logged.some((line) => line.includes("maintainer hold skipped"))).toBe(true);
  });

  test("status write failure skips without reporting released", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const api = releaseApi({ statuses });
    (api as { createCommitStatus: unknown }).createCommitStatus = async () => {
      throw new Error("forge exploded");
    };
    const logged: string[] = [];
    const outcome = await tryReleaseMaintainerHold({
      api: api as never,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 15,
      senderLogin: "kirmanak",
      botUsername: "jumi",
      trustedSenderLogins: [],
      followupIgnoreLogins: [],
      defaultBranch: "main",
      logger: (message) => logged.push(message),
    });
    expect(outcome).toEqual({ outcome: "skip", reason: "failed to post status" });
    expect(statuses).toHaveLength(0);
    expect(logged.some((line) => line.includes("maintainer hold released for"))).toBe(false);
    expect(logged.some((line) => line.includes("failed to post status"))).toBe(true);
  });
});

describe("router release-only path on both forges", () => {
  function giteaCommentRequest() {
    const repository = makeRepo();
    return makeIssueCommentPayload({
      repository,
      sender: makeUser({ login: "kirmanak" }),
      comment: makeComment({
        id: 99,
        body: "@jumi Yes, the table can see that",
        user: makeUser({ login: "kirmanak" }),
      }),
      issue: makeIssue({
        number: 15,
        title: "Chronicle of Lenora",
        body: "Lore update",
        html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/15",
        user: makeUser({ login: "sampo" }),
        assignee: null,
        assignees: [],
        pull_request: { merged_at: null },
      }),
      pull_request: {
        ...nonJumiPr(),
        head: {
          label: "kirmanak:lore/lenora-chronicle-kildrak",
          ref: "lore/lenora-chronicle-kildrak",
          sha: HEAD,
          repo: repository,
          repo_id: repository.id,
        },
      },
    });
  }

  test("gitea issue_comment on a non-Jumi PR releases with no worker job", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const api = {
      ...releaseApi({ statuses }),
      getRepo: async () => makeRepo(),
    };
    const queue = makeQueue();
    const sits = new MemoryRouterSitStore();
    const logs: string[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: api as never,
      sits,
      logger: (message: string) => logs.push(message),
    });
    const response = await handler(await workerIssueCommentRequest(giteaCommentRequest(), { event: "issue_comment" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ released: true, key: "kirmanak/demo#15" });
    expect(queue.jobs).toHaveLength(0);
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(logs.some((line) => line.includes("maintainer hold released for kirmanak/demo#15"))).toBe(true);
    expect(await sits.get("kirmanak", "demo", 15)).toBeUndefined();
  });

  test("gitea issue_comment with an untrusted sender sits as no-write-access", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const api = {
      ...releaseApi({ statuses, permission: "read" }),
      getRepo: async () => makeRepo(),
    };
    const queue = makeQueue();
    const sits = new MemoryRouterSitStore();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: api as never, sits });
    const payload = giteaCommentRequest();
    payload.sender = makeUser({ login: "mallory" });
    payload.comment = makeComment({ id: 99, body: "looks fine", user: makeUser({ login: "mallory" }) });
    const response = await handler(await workerIssueCommentRequest(payload, { event: "issue_comment" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "sender lacks write access" });
    expect(queue.jobs).toHaveLength(0);
    expect(statuses).toHaveLength(0);
    expect(await sits.get("kirmanak", "demo", 15)).toMatchObject({ reason: "no-write-access" });
  });

  test("gitea issue_comment with a status write failure skips without clearing the sit", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const base = releaseApi({ statuses });
    const api = {
      ...base,
      createCommitStatus: async () => {
        throw new Error("forge exploded");
      },
      getRepo: async () => makeRepo(),
    };
    const queue = makeQueue();
    const sits = new MemoryRouterSitStore();
    const logs: string[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: api as never,
      sits,
      logger: (message: string) => logs.push(message),
    });
    const response = await handler(await workerIssueCommentRequest(giteaCommentRequest(), { event: "issue_comment" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "failed to post status" });
    expect(queue.jobs).toHaveLength(0);
    expect(statuses).toHaveLength(0);
    expect(logs.some((line) => line.includes("maintainer hold released for kirmanak/demo#15"))).toBe(false);
    expect(logs.some((line) => line.includes("failed to post status"))).toBe(true);
  });

  test("github pull_request_review on a non-Jumi PR releases with no worker job", async () => {
    const statuses: Array<{ state: string; description?: string; context?: string }> = [];
    const githubRepo = makeRepo({
      html_url: "https://github.com/kirmanak/demo",
      clone_url: "https://github.com/kirmanak/demo.git",
    });
    const pr = {
      ...makePR({
        number: 15,
        title: "Chronicle of Lenora",
        body: "Lore update",
        user: makeUser({ login: "sampo" }),
        assignee: null,
        assignees: [],
        html_url: "https://github.com/kirmanak/demo/pull/15",
        head: {
          label: "kirmanak:lore/lenora-chronicle-kildrak",
          ref: "lore/lenora-chronicle-kildrak",
          sha: HEAD,
          repo: githubRepo,
          repo_id: githubRepo.id,
        },
      }),
    };
    const api = {
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => ({ id: 1, body: "", user: { login: "x" }, created_at: "", updated_at: "" }),
      updateIssueComment: async () => ({ id: 1, body: "", user: { login: "x" }, created_at: "", updated_at: "" }),
      getPR: async () => pr,
      listPullReviews: async () => [],
      listIssueComments: async () => [heldSticky()],
      listPullReviewComments: async () => [],
      createCommitStatus: async (
        _owner: string,
        _repo: string,
        _sha: string,
        status: { state: string; description?: string; context?: string }
      ) => {
        statuses.push(status);
        return status as never;
      },
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listOpenPulls: async () => [],
      getIssue: async () => makeIssue(),
      getRepo: async () => githubRepo,
    };
    const store = new MemoryReviewJobStore();
    const sits = new MemoryRouterSitStore();
    const logs: string[] = [];
    const handler = createFetchHandler(makeConfig({ githubWebhookSecret: "webhook-secret" }), {
      queue: store,
      worker: {
        queue: { enqueue: (job: never) => store.enqueueIssue(job) },
        api: api as never,
        sits,
      },
      logger: (message: string) => logs.push(message),
    });
    const payload = makePayload({
      action: "submitted",
      repository: githubRepo,
      pull_request: pr,
      review: { id: 7, body: "Yes, the table can see that" },
      sender: makeUser({ login: "kirmanak" }),
    });
    const raw = encodeJson(payload);
    const signature = await signBody(raw, "webhook-secret");
    const headers = new Headers();
    headers.set("content-type", "application/json");
    headers.set("x-hub-signature-256", `sha256=${signature}`);
    headers.set("x-github-event", "pull_request_review");
    headers.set("x-github-delivery", crypto.randomUUID());
    const request = new Request("https://reviewer.test/webhooks/github", {
      method: "POST",
      body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
      headers,
    });
    const decision = await handler(request);
    expect(decision.status).toBe(202);
    expect(await responseJson(decision)).toEqual({ released: true, key: "kirmanak/demo#15" });
    expect(store.rows.filter((row) => row.state === "queued")).toHaveLength(0);
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(logs.some((line) => line.includes("maintainer hold released for kirmanak/demo#15"))).toBe(true);
  });
});
