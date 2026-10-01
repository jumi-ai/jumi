import { describe, expect, test } from "bun:test";
import {
  followUpSkipReason,
  shouldEnqueueIssueCommentFollowUp,
  shouldEnqueueIssueCommentFollowUpWithTrust,
  shouldEnqueuePullAssign,
  shouldEnqueuePullLabel,
  shouldEnqueuePullRejectedFollowUp,
  shouldEnqueuePullRejectedFollowUpWithTrust,
} from "../src/followup_webhook.ts";
import { hasJumiLabel } from "../src/github_webhook.ts";
import type { IssueJob } from "../src/types.ts";
import type { WorkerQueueLike } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import {
  encodeJson,
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

const policy = {
  giteaUrl: "https://gitea.kirmanak.stream",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [],
  botUsername: "jumi",
};

const writeApi = {
  listOpenPulls: async () => [],
  getIssue: async () => makeIssue(),
  getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
};

const readApi = {
  listOpenPulls: async () => [],
  getIssue: async () => makeIssue(),
  getCollaboratorPermission: async () => ({ permission: "read", role_name: "read" }),
};

function reviewCommentPayload() {
  return makePayload({
    action: "reviewed",
    pull_request: makePR({
      user: makeUser({ login: "jumi" }),
      body: "Fixes #12",
      head: {
        label: "kirmanak:jumi/issue-12-fix-the-thing",
        ref: "jumi/issue-12-fix-the-thing",
        sha: "headsha",
        repo: makePayload().repository,
        repo_id: 10,
      },
    }),
    review: { id: 9, body: "please change this" },
  });
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
  overrides: RequestInit & { event?: string; eventType?: string; secret?: string } = {}
): Promise<Request> {
  const raw = encodeJson(body);
  const secret = overrides.secret ?? "webhook-secret";
  const signature = await signBody(raw, secret);
  const headers = new Headers(overrides.headers);
  headers.set("content-type", "application/json");
  headers.set("x-gitea-signature", signature);
  headers.set("x-gitea-event", overrides.event ?? "issue_comment");
  if (overrides.eventType) headers.set("x-gitea-event-type", overrides.eventType);
  headers.set("x-gitea-delivery", "delivery-1");
  return new Request("https://worker.test/webhooks/gitea", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("shouldEnqueueIssueCommentFollowUp", () => {
  test("enqueues issue_comment created on a PR whose body Fixes #12", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(makeIssueCommentPayload(), policy, "issue_comment");
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(12);
      expect(decision.job.prNumber).toBe(127);
      expect(decision.job.trigger).toEqual({
        event: "issue_comment",
        commentId: 55,
        sender: "alice",
      });
    }
  });

  test("skips issue_comment when issue.pull_request is null", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({ issue: makeIssue({ pull_request: null, is_pull: false, body: "Fixes #12" }) }),
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "not a pull request comment" });
  });

  test("skips sender jumi", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({ sender: makeUser({ login: "jumi" }) }),
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "sender is bot" });
  });

  test("skips listed FOLLOWUP_IGNORE_LOGINS senders case-insensitively", () => {
    const ignorePolicy = { ...policy, followupIgnoreLogins: ["tapio", "renovate-bot"] };
    expect(
      shouldEnqueueIssueCommentFollowUp(
        makeIssueCommentPayload({ sender: makeUser({ login: "Tapio" }) }),
        ignorePolicy,
        "issue_comment"
      )
    ).toEqual({ type: "skip", reason: "sender ignored" });
    expect(
      shouldEnqueueIssueCommentFollowUp(
        makeIssueCommentPayload({ sender: makeUser({ login: "renovate-bot" }) }),
        ignorePolicy,
        "issue_comment"
      )
    ).toEqual({ type: "skip", reason: "sender ignored" });
  });

  test("unset ignore list still enqueues non-bot senders", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({ sender: makeUser({ login: "tapio" }) }),
      policy,
      "issue_comment"
    );
    expect(decision.type).toBe("enqueue");
  });

  test("BOT_USERNAME in the ignore list still skips as bot", () => {
    expect(
      shouldEnqueueIssueCommentFollowUp(
        makeIssueCommentPayload({ sender: makeUser({ login: "jumi" }) }),
        { ...policy, followupIgnoreLogins: ["jumi", "tapio"] },
        "issue_comment"
      )
    ).toEqual({ type: "skip", reason: "sender is bot" });
  });

  test("skips sender jumi even when body is a current-head failure sticky", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        sender: makeUser({ login: "jumi" }),
        comment: {
          id: 38022,
          body: [
            "<!-- jumi-review:kirmanak/demo#127 -->",
            "### Jumi review",
            "",
            "Reviewed commit: `a62c750c0ffee000000000000000000000000000`",
            "",
            "<!-- jumi-check: failure -->",
          ].join("\n"),
          user: makeUser({ login: "jumi" }),
          created_at: "",
          updated_at: "",
        },
      }),
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "sender is bot" });
  });

  test("skips action edited / deleted", () => {
    expect(
      shouldEnqueueIssueCommentFollowUp(makeIssueCommentPayload({ action: "edited" }), policy, "issue_comment")
    ).toEqual({ type: "skip", reason: "unsupported action edited" });
    expect(
      shouldEnqueueIssueCommentFollowUp(makeIssueCommentPayload({ action: "deleted" }), policy, "issue_comment")
    ).toEqual({ type: "skip", reason: "unsupported action deleted" });
  });

  test("skips empty body", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        comment: { id: 55, body: "  ", user: makeUser({ login: "alice" }), created_at: "", updated_at: "" },
      }),
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "empty comment body" });
  });

  test("skips jumi-stuck bodies", () => {
    expect(
      shouldEnqueueIssueCommentFollowUp(
        makeIssueCommentPayload({
          comment: {
            id: 3,
            body: "<!-- jumi-stuck:kirmanak/demo#12 -->\nstuck: repeated action",
            user: makeUser({ login: "alice" }),
            created_at: "",
            updated_at: "",
          },
        }),
        policy,
        "issue_comment"
      )
    ).toEqual({ type: "skip", reason: "jumi internal comment" });
  });

  test("skips jumi-review inline bodies", () => {
    expect(
      shouldEnqueueIssueCommentFollowUp(
        makeIssueCommentPayload({
          comment: {
            id: 4,
            body: "🔴 bug: null deref. Guard it.\n\n<!-- jumi-review:kirmanak/demo#7 -->",
            user: makeUser({ login: "alice" }),
            created_at: "",
            updated_at: "",
          },
        }),
        policy,
        "issue_comment"
      )
    ).toEqual({ type: "skip", reason: "jumi internal comment" });
  });

  test("skips jumi-check and jumi-worker bodies", () => {
    expect(
      shouldEnqueueIssueCommentFollowUp(
        makeIssueCommentPayload({
          comment: {
            id: 1,
            body: "<!-- jumi-check:kirmanak/demo#12 -->\nfindings",
            user: makeUser({ login: "alice" }),
            created_at: "",
            updated_at: "",
          },
        }),
        policy,
        "issue_comment"
      )
    ).toEqual({ type: "skip", reason: "jumi internal comment" });
    expect(
      shouldEnqueueIssueCommentFollowUp(
        makeIssueCommentPayload({
          comment: {
            id: 2,
            body: "<!-- jumi-worker:kirmanak/demo#12 -->\nJumi is implementing this issue.",
            user: makeUser({ login: "alice" }),
            created_at: "",
            updated_at: "",
          },
        }),
        policy,
        "issue_comment"
      )
    ).toEqual({ type: "skip", reason: "jumi internal comment" });
  });

  test("uses payload.pull_request head.ref over a Fix #N title", () => {
    const repository = makeRepo();
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        repository,
        issue: makeIssue({
          number: 127,
          title: "Fix #11 leftover",
          body: "Fixes #12",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
          user: makeUser({ login: "jumi" }),
          pull_request: { merged_at: null },
        }),
        pull_request: makePR({
          number: 127,
          title: "Fix #11 leftover",
          body: "Fixes #12",
          user: makeUser({ login: "jumi" }),
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
        sender: makeUser({ login: "alice" }),
      }),
      policy,
      "issue_comment"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.issueNumber).toBe(12);
      expect(decision.job.prNumber).toBe(127);
    }
  });

  test("enqueues a comment on a labeled GitHub foreign PR keyed by the PR number", () => {
    const repository = makeRepo({
      html_url: "https://github.com/kirmanak/demo",
      clone_url: "https://github.com/kirmanak/demo.git",
    });
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        repository,
        issue: makeIssue({
          number: 55,
          title: "chore(deps)",
          body: "",
          html_url: "https://github.com/kirmanak/demo/pull/55",
          user: makeUser({ login: "renovate[bot]" }),
          assignee: null,
          assignees: [],
          labels: [{ name: "jumi" }],
          pull_request: { merged_at: null },
        }),
        pull_request: makePR({
          number: 55,
          title: "chore(deps)",
          body: "",
          user: makeUser({ login: "renovate[bot]" }),
          assignee: null,
          assignees: [],
          labels: [{ name: "jumi" }],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
      }),
      githubPolicy,
      "issue_comment"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(55);
      expect(decision.job.prNumber).toBe(55);
    }
  });

  test("enqueues a comment on an assigned foreign PR keyed by the PR number", () => {
    const repository = makeRepo();
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        repository,
        issue: makeIssue({
          number: 50,
          title: "chore(deps)",
          body: "",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
          user: makeUser({ login: "renovate" }),
          pull_request: { merged_at: null },
        }),
        pull_request: makePR({
          number: 50,
          title: "chore(deps)",
          body: "",
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" })],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
      }),
      policy,
      "issue_comment"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(50);
      expect(decision.job.prNumber).toBe(50);
    }
  });

  test("skips a comment on an unassigned foreign PR", () => {
    const repository = makeRepo();
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        repository,
        issue: makeIssue({
          number: 50,
          title: "chore(deps)",
          body: "",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "alice" }),
          assignees: [makeUser({ login: "alice" })],
          pull_request: { merged_at: null },
        }),
        pull_request: makePR({
          number: 50,
          title: "chore(deps)",
          body: "",
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
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "not a jumi pull request" });
  });

  test("skips when issue no longer assigned", () => {
    const payload = makeIssueCommentPayload();
    const pr = {
      id: 1,
      number: 127,
      title: "Fix",
      body: "Fixes #12",
      state: "open" as const,
      user: makeUser({ login: "jumi" }),
      head: {
        label: "kirmanak:jumi/issue-12-fix",
        ref: "jumi/issue-12-fix-the-thing",
        sha: "abc",
        repo: payload.repository,
        repo_id: payload.repository.id,
      },
      base: {
        label: "kirmanak:main",
        ref: "main",
        sha: "def",
        repo: payload.repository,
        repo_id: payload.repository.id,
      },
      merged: false,
      created_at: "",
      updated_at: "",
      html_url: payload.issue.html_url,
    };
    const issue = makeIssue({
      assignee: makeUser({ login: "alice" }),
      assignees: [makeUser({ login: "alice" })],
    });
    expect(followUpSkipReason(pr, issue, "kirmanak", "demo", "jumi")).toBe("not assigned to bot");
    expect(shouldEnqueueIssueCommentFollowUp(payload, policy, "issue_comment", issue).type).toBe("skip");
  });
});

describe("shouldEnqueuePullRejectedFollowUp", () => {
  test("enqueues pull_request_rejected for a jumi PR", () => {
    const decision = shouldEnqueuePullRejectedFollowUp(
      makePayload({
        action: "reviewed",
        pull_request: makePR({
          user: makeUser({ login: "jumi" }),
          body: "Fixes #12",
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo: makePayload().repository,
            repo_id: 10,
          },
        }),
        review: { id: 9, body: "please change this" },
      }),
      policy,
      "pull_request_rejected"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(12);
      expect(decision.job.trigger?.reviewId).toBe(9);
      expect(decision.job.trigger?.body).toBe("please change this");
    }
  });

  test("skips empty review bodies", () => {
    const decision = shouldEnqueuePullRejectedFollowUp(
      makePayload({
        action: "reviewed",
        pull_request: makePR({
          user: makeUser({ login: "jumi" }),
          body: "Fixes #12",
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo: makePayload().repository,
            repo_id: 10,
          },
        }),
        review: { id: 9, body: "  " },
      }),
      policy,
      "pull_request_rejected"
    );
    expect(decision).toEqual({ type: "skip", reason: "empty comment body" });
  });

  test("enqueues a comment review webhook with content and no id", () => {
    const decision = shouldEnqueuePullRejectedFollowUp(
      makePayload({
        action: "reviewed",
        pull_request: makePR({
          user: makeUser({ login: "jumi" }),
          body: "Fixes #12",
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo: makePayload().repository,
            repo_id: 10,
          },
        }),
        review: { type: "pull_request_review_comment", content: "please rename" },
      }),
      policy,
      "pull_request_comment"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.trigger?.reviewId).toBeUndefined();
      expect(decision.job.trigger?.body).toBe("please rename");
    }
  });

  test("enqueues pull_request_rejected for a labeled GitHub foreign PR", () => {
    const repository = makeRepo({
      html_url: "https://github.com/kirmanak/demo",
      clone_url: "https://github.com/kirmanak/demo.git",
    });
    const decision = shouldEnqueuePullRejectedFollowUp(
      makePayload({
        action: "submitted",
        repository,
        pull_request: makePR({
          number: 55,
          title: "chore(deps)",
          body: "",
          user: makeUser({ login: "renovate[bot]" }),
          assignee: null,
          assignees: [],
          labels: [{ name: "jumi" }],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
        review: { id: 9, body: "please change this" },
      }),
      githubPolicy,
      "pull_request_review"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.issueNumber).toBe(55);
      expect(decision.job.prNumber).toBe(55);
    }
  });

  test("enqueues pull_request_rejected for an assigned foreign PR", () => {
    const repository = makeRepo();
    const decision = shouldEnqueuePullRejectedFollowUp(
      makePayload({
        action: "reviewed",
        pull_request: makePR({
          number: 50,
          title: "chore(deps)",
          body: "",
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" })],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
        review: { id: 9, body: "please change this" },
      }),
      policy,
      "pull_request_rejected"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.issueNumber).toBe(50);
      expect(decision.job.prNumber).toBe(50);
    }
  });
});

function assignedCloserPayload(overrides: Parameters<typeof makePR>[0] = {}): ReturnType<typeof makePayload> {
  const repository = makeRepo();
  return makePayload({
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
      ...overrides,
    }),
  });
}

describe("shouldEnqueuePullAssign", () => {
  test("enqueues follow-up when the bot is assigned", async () => {
    const repository = makeRepo();
    const decision = await shouldEnqueuePullAssign(
      makePayload({
        action: "assigned",
        pull_request: makePR({
          number: 50,
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" })],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
      }),
      policy
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(50);
      expect(decision.job.prNumber).toBe(50);
    }
  });

  test("cancels when the bot is unassigned", async () => {
    const repository = makeRepo();
    const decision = await shouldEnqueuePullAssign(
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
      policy
    );
    expect(decision).toEqual({ type: "cancel", owner: "kirmanak", repo: "demo", issueNumber: 50 });
  });

  test("skips opened and synchronize", async () => {
    expect(await shouldEnqueuePullAssign(makePayload({ action: "opened" }), policy)).toEqual({
      type: "skip",
      reason: "unsupported action opened",
    });
    expect(await shouldEnqueuePullAssign(makePayload({ action: "synchronize" }), policy)).toEqual({
      type: "skip",
      reason: "unsupported action synchronize",
    });
  });

  test("skips when the closing issue is open and assigned to the bot", async () => {
    const loaded: number[] = [];
    const decision = await shouldEnqueuePullAssign(assignedCloserPayload(), policy, {
      getIssue: async (_owner, _repo, index) => {
        loaded.push(index);
        return makeIssue();
      },
    });
    expect(decision).toEqual({ type: "skip", reason: "closing issue already assigned" });
    expect(loaded).toEqual([12]);
  });

  test("enqueues adopt-PR when the closing issue is not assigned to the bot", async () => {
    const decision = await shouldEnqueuePullAssign(assignedCloserPayload(), policy, {
      getIssue: async () => makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [] }),
    });
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.issueNumber).toBe(127);
      expect(decision.job.prNumber).toBe(127);
    }
  });

  test("enqueues adopt-PR when the closing issue is closed", async () => {
    const decision = await shouldEnqueuePullAssign(assignedCloserPayload(), policy, {
      getIssue: async () => makeIssue({ state: "closed" }),
    });
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.issueNumber).toBe(127);
      expect(decision.job.prNumber).toBe(127);
    }
  });

  test("skips when getIssue fails", async () => {
    const decision = await shouldEnqueuePullAssign(assignedCloserPayload(), policy, {
      getIssue: async () => {
        throw new Error("gitea 502");
      },
    });
    expect(decision).toEqual({ type: "skip", reason: "failed to load issue" });
  });

  test("skips a closer PR when getIssue is unavailable", async () => {
    expect(await shouldEnqueuePullAssign(assignedCloserPayload(), policy)).toEqual({
      type: "skip",
      reason: "failed to load issue",
    });
  });

  test("skips a human closer whose issue is assigned to the bot", async () => {
    const repository = makeRepo();
    const decision = await shouldEnqueuePullAssign(
      makePayload({
        action: "assigned",
        pull_request: makePR({
          number: 80,
          title: "Fix the thing",
          body: "Fixes #12",
          user: makeUser({ login: "alice" }),
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" })],
          head: {
            label: "kirmanak:fix-the-thing",
            ref: "fix-the-thing",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
      }),
      policy,
      { getIssue: async () => makeIssue() }
    );
    expect(decision).toEqual({ type: "skip", reason: "closing issue already assigned" });
  });

  test("does not treat a jumi branch without a close-keyword as a closer", async () => {
    const loaded: number[] = [];
    const decision = await shouldEnqueuePullAssign(
      assignedCloserPayload({ body: "no closer here", title: "WIP-free title" }),
      policy,
      {
        getIssue: async (_owner, _repo, index) => {
          loaded.push(index);
          return makeIssue();
        },
      }
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.issueNumber).toBe(127);
      expect(decision.job.prNumber).toBe(127);
    }
    expect(loaded).toEqual([]);
  });
});

const githubPolicy = {
  giteaUrl: "https://github.com",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [] as string[],
  botUsername: "kirmanak-jumi[bot]",
  isPickedUp: hasJumiLabel,
};

function labeledForeignPayload(overrides: Parameters<typeof makePR>[0] = {}) {
  const repository = makeRepo({
    html_url: "https://github.com/kirmanak/demo",
    clone_url: "https://github.com/kirmanak/demo.git",
  });
  return makePayload({
    action: "labeled",
    label: { name: "jumi" },
    repository,
    sender: makeUser({ login: "alice" }),
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
        repo: repository,
        repo_id: repository.id,
      },
      ...overrides,
    }),
  });
}

describe("shouldEnqueuePullLabel", () => {
  test("enqueues follow-up when jumi is added to a foreign PR", async () => {
    const decision = await shouldEnqueuePullLabel(labeledForeignPayload(), githubPolicy);
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(55);
      expect(decision.job.prNumber).toBe(55);
      expect(decision.job.trigger).toEqual({ event: "labeled", sender: "alice" });
    }
  });

  test("cancels when jumi is removed", async () => {
    const payload = labeledForeignPayload({ labels: [] });
    payload.action = "unlabeled";
    expect(await shouldEnqueuePullLabel(payload, githubPolicy)).toEqual({
      type: "cancel",
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 55,
    });
  });

  test("skips factory-bot sender on labeled and still enqueues interviewer bots", async () => {
    expect(
      await shouldEnqueuePullLabel(
        { ...labeledForeignPayload(), sender: makeUser({ login: "kirmanak-jumi[bot]", type: "Bot" }) },
        githubPolicy
      )
    ).toEqual({ type: "skip", reason: "sender is bot" });
    const renovate = await shouldEnqueuePullLabel(
      { ...labeledForeignPayload(), sender: makeUser({ login: "renovate[bot]", type: "Bot" }) },
      githubPolicy
    );
    expect(renovate.type).toBe("enqueue");
  });

  test("skips other labels, drafts, forks, and WIP", async () => {
    expect(await shouldEnqueuePullLabel({ ...labeledForeignPayload(), label: { name: "bug" } }, githubPolicy)).toEqual({
      type: "skip",
      reason: "labeled other label",
    });
    expect(await shouldEnqueuePullLabel(labeledForeignPayload({ draft: true }), githubPolicy)).toEqual({
      type: "skip",
      reason: "draft or WIP pull request",
    });
    expect(await shouldEnqueuePullLabel(labeledForeignPayload({ title: "WIP: deps" }), githubPolicy)).toEqual({
      type: "skip",
      reason: "draft or WIP pull request",
    });
    const forkRepo = makeRepo({
      full_name: "other/demo",
      html_url: "https://github.com/other/demo",
      clone_url: "https://github.com/other/demo.git",
    });
    expect(
      await shouldEnqueuePullLabel(
        labeledForeignPayload({
          head: {
            label: "other:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo: forkRepo,
            repo_id: forkRepo.id,
          },
        }),
        githubPolicy
      )
    ).toEqual({ type: "skip", reason: "fork pull request" });
  });

  test("skips a closer whose issue is already labeled jumi", async () => {
    const repository = makeRepo({
      html_url: "https://github.com/kirmanak/demo",
      clone_url: "https://github.com/kirmanak/demo.git",
    });
    const decision = await shouldEnqueuePullLabel(
      makePayload({
        action: "labeled",
        label: { name: "jumi" },
        repository,
        sender: makeUser({ login: "alice" }),
        pull_request: makePR({
          number: 127,
          title: "Fix the thing",
          body: "Fixes #12",
          user: makeUser({ login: "kirmanak-jumi[bot]" }),
          labels: [{ name: "jumi" }],
          html_url: "https://github.com/kirmanak/demo/pull/127",
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
      }),
      githubPolicy,
      {
        getIssue: async () => makeIssue({ assignee: null, assignees: [], labels: [{ name: "jumi" }] }),
      }
    );
    expect(decision).toEqual({ type: "skip", reason: "closing issue already assigned" });
  });
});

describe("createWorkerFetchHandler follow-up events", () => {
  test("skips listed ignore login on issue_comment", async () => {
    const queue = makeQueue();
    const logs: string[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig({ followupIgnoreLogins: ["tapio"] }), {
      queue,
      logger: (message) => logs.push(message),
    });
    const response = await handler(
      await signedRequest(makeIssueCommentPayload({ sender: makeUser({ login: "tapio" }) }), { event: "issue_comment" })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "sender ignored" });
    expect(queue.jobs).toHaveLength(0);
    expect(logs.some((line) => line.includes("skipped sender ignored"))).toBe(true);
  });

  test("enqueues issue_comment created on a jumi PR", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: writeApi });
    const response = await handler(await signedRequest(makeIssueCommentPayload(), { event: "issue_comment" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.prNumber).toBe(127);
  });

  test("enqueues X-Gitea-Event: pull_request_rejected for a jumi PR", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: writeApi });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "reviewed",
          pull_request: makePR({
            user: makeUser({ login: "jumi" }),
            body: "Fixes #12",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo: makePayload().repository,
              repo_id: 10,
            },
          }),
          review: { id: 9, body: "please change this" },
        }),
        { event: "pull_request_rejected" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
  });

  test("skips X-Gitea-Event: pull_request opened", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(await signedRequest(makePayload(), { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action opened" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("accepts Event-Type pull_request_review_comment with Event pull_request_comment", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: writeApi });
    const response = await handler(
      await signedRequest(reviewCommentPayload(), {
        event: "pull_request_comment",
        eventType: "pull_request_review_comment",
      })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.trigger?.reviewId).toBe(9);
  });

  test("enqueues PR-payload comment review with content and no id", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: writeApi });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "reviewed",
          pull_request: makePR({
            user: makeUser({ login: "jumi" }),
            body: "Fixes #12",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo: makePayload().repository,
              repo_id: 10,
            },
          }),
          review: { type: "pull_request_review_comment", content: "please rename" },
        }),
        { event: "pull_request_comment", eventType: "pull_request_review_comment" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.trigger?.reviewId).toBeUndefined();
    expect(queue.jobs[0]?.trigger?.body).toBe("please rename");
  });

  test("Event pull_request_comment with a review-shaped payload never 400s", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: writeApi });
    const body = reviewCommentPayload();
    expect("issue" in body).toBe(false);
    expect("comment" in body).toBe(false);
    const response = await handler(await signedRequest(body, { event: "pull_request_comment" }));
    expect(response.status).toBe(202);
    const json = await responseJson(response);
    expect(json).not.toHaveProperty("error");
    expect(json).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
  });

  test("skips issue_comment from a reader without write access", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: readApi });
    const response = await handler(await signedRequest(makeIssueCommentPayload(), { event: "issue_comment" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "sender lacks write access" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("skips issue_comment when permission lookup is unavailable (fail-closed)", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(await signedRequest(makeIssueCommentPayload(), { event: "issue_comment" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "sender lacks write access" });
    expect(queue.jobs).toHaveLength(0);
  });
});

describe("follow-up write gating", () => {
  test("issue comment wakes for write, maintain, admin, and owner", async () => {
    for (const permission of ["write", "admin", "owner"]) {
      const api = { getCollaboratorPermission: async () => ({ permission, role_name: permission }) };
      const decision = await shouldEnqueueIssueCommentFollowUpWithTrust(
        makeIssueCommentPayload(),
        policy,
        "issue_comment",
        undefined,
        api
      );
      expect(decision.type).toBe("enqueue");
    }
    const maintain = await shouldEnqueueIssueCommentFollowUpWithTrust(
      makeIssueCommentPayload(),
      policy,
      "issue_comment",
      undefined,
      {
        getCollaboratorPermission: async () => ({ permission: "write", role_name: "maintain" }),
      }
    );
    expect(maintain.type).toBe("enqueue");
  });

  test("issue comment skips for read, triage, none, and lookup failure", async () => {
    for (const permission of ["read", "none"]) {
      const decision = await shouldEnqueueIssueCommentFollowUpWithTrust(
        makeIssueCommentPayload(),
        policy,
        "issue_comment",
        undefined,
        { getCollaboratorPermission: async () => ({ permission, role_name: permission }) }
      );
      expect(decision).toEqual({ type: "skip", reason: "sender lacks write access" });
    }
    const triage = await shouldEnqueueIssueCommentFollowUpWithTrust(
      makeIssueCommentPayload(),
      policy,
      "issue_comment",
      undefined,
      {
        getCollaboratorPermission: async () => ({ permission: "read", role_name: "triage" }),
      }
    );
    expect(triage).toEqual({ type: "skip", reason: "sender lacks write access" });
    expect(
      await shouldEnqueueIssueCommentFollowUpWithTrust(makeIssueCommentPayload(), policy, "issue_comment")
    ).toEqual({ type: "skip", reason: "sender lacks write access" });
    expect(
      await shouldEnqueueIssueCommentFollowUpWithTrust(makeIssueCommentPayload(), policy, "issue_comment", undefined, {
        getCollaboratorPermission: async () => {
          throw new Error("forge 500");
        },
      })
    ).toEqual({ type: "skip", reason: "sender lacks write access" });
  });

  test("ignore list still wins even when the sender has write", async () => {
    const ignorePolicy = { ...policy, followupIgnoreLogins: ["renovate-bot"] };
    const decision = await shouldEnqueueIssueCommentFollowUpWithTrust(
      makeIssueCommentPayload({ sender: makeUser({ login: "renovate-bot" }) }),
      ignorePolicy,
      "issue_comment",
      undefined,
      writeApi
    );
    expect(decision).toEqual({ type: "skip", reason: "sender ignored" });
  });

  test("pull rejection wakes for write and skips for read", async () => {
    const payload = reviewCommentPayload();
    expect(
      (await shouldEnqueuePullRejectedFollowUpWithTrust(payload, policy, "pull_request_rejected", undefined, writeApi))
        .type
    ).toBe("enqueue");
    expect(
      await shouldEnqueuePullRejectedFollowUpWithTrust(payload, policy, "pull_request_rejected", undefined, readApi)
    ).toEqual({ type: "skip", reason: "sender lacks write access" });
    expect(await shouldEnqueuePullRejectedFollowUpWithTrust(payload, policy, "pull_request_rejected")).toEqual({
      type: "skip",
      reason: "sender lacks write access",
    });
  });

  test("repository push hint admits a sender whose flat collaborator permission is none", async () => {
    const noneApi = {
      getCollaboratorPermission: async () => ({ permission: "none", role_name: "none" }),
    };
    const payload = makeIssueCommentPayload({
      repository: makeRepo({ permissions: { push: true, pull: true, admin: false } }),
    });
    const decision = await shouldEnqueueIssueCommentFollowUpWithTrust(
      payload,
      policy,
      "issue_comment",
      undefined,
      noneApi
    );
    expect(decision.type).toBe("enqueue");
  });

  test("repository push hint missing still skips a sender who cannot push", async () => {
    const noneApi = {
      getCollaboratorPermission: async () => ({ permission: "none", role_name: "none" }),
    };
    const payload = makeIssueCommentPayload({
      repository: makeRepo({ permissions: { push: false, pull: true, admin: false } }),
    });
    expect(
      await shouldEnqueueIssueCommentFollowUpWithTrust(payload, policy, "issue_comment", undefined, noneApi)
    ).toEqual({ type: "skip", reason: "sender lacks write access" });
  });

  test("an App installation with contents write admits the sender without reading another app record", async () => {
    const api = {
      getCollaboratorPermission: async () => ({ permission: "none" }),
      getRepoInstallation: async () => ({ permissions: { contents: "write" } }),
    };
    const payload = makeIssueCommentPayload({ sender: makeUser({ login: "filer[bot]" }) });
    const decision = await shouldEnqueueIssueCommentFollowUpWithTrust(payload, policy, "issue_comment", undefined, api);
    expect(decision.type).toBe("enqueue");
  });
});
