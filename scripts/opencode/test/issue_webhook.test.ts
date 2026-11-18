import { describe, expect, test } from "bun:test";
import { DEPENDENCY_GRAPH_CAP } from "../src/dependencies.ts";
import { hasJumiLabel } from "../src/github_webhook.ts";
import {
  assignedIssueJobsToEnqueue,
  blockedIssueJobsToEnqueue,
  enqueueEligibleBlockedIssue,
  isDependencyRemoveAction,
  parseIssueDependenciesPayload,
  parseIssuesPayload,
  pullWaitClearJobsToEnqueue,
  shouldEnqueueIssue,
} from "../src/issue_webhook.ts";
import {
  encodeJson,
  makeIssue,
  makeIssuePayload,
  makeLinkedIssue,
  makePayload,
  makePR,
  makeRepo,
  makeUser,
} from "./fixtures.ts";

const policy = {
  giteaUrl: "https://gitea.kirmanak.stream",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [],
  botUsername: "jumi",
};

describe("parseIssuesPayload", () => {
  test("parses a valid issues payload", () => {
    const payload = parseIssuesPayload(encodeJson(makeIssuePayload()));
    expect(payload.issue.number).toBe(12);
    expect(payload.repository.full_name).toBe("kirmanak/demo");
  });

  test("parses a Gitea 1.27 IssuePayload (null pull_request, no top-level assignee)", () => {
    const raw = makeIssuePayload({
      action: "assigned",
      number: 12,
      issue: makeIssue({ pull_request: null, assignees: [makeUser({ login: "jumi" })] }),
    });
    const payload = parseIssuesPayload(encodeJson({ ...raw, commit_id: "" }));
    expect(payload.issue.pull_request).toBeNull();
    expect(shouldEnqueueIssue(payload, policy).type).toBe("enqueue");
  });

  test("rejects malformed payloads", () => {
    expect(() => parseIssuesPayload(encodeJson({ action: "assigned" }))).toThrow("missing repository");
    expect(() => parseIssuesPayload(new TextEncoder().encode("not-json"))).toThrow();
  });
});

describe("shouldEnqueueIssue", () => {
  test("enqueues assigned, opened, and reopened issues assigned to the bot", () => {
    for (const action of ["assigned", "opened", "reopened"]) {
      const decision = shouldEnqueueIssue(makeIssuePayload({ action }), policy);
      expect(decision.type).toBe("enqueue");
      if (decision.type === "enqueue") {
        expect(decision.job.issueNumber).toBe(12);
        expect(decision.job.owner).toBe("kirmanak");
        expect(decision.job.action).toBe(action);
      }
    }
  });

  test("cancels when the bot is unassigned", () => {
    const decision = shouldEnqueueIssue(
      makeIssuePayload({
        action: "unassigned",
        issue: makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
      }),
      policy
    );
    expect(decision).toEqual({ type: "cancel", owner: "kirmanak", repo: "demo", issueNumber: 12 });
  });

  test("does not cancel when another assignee is removed and the bot remains", () => {
    const decision = shouldEnqueueIssue(
      makeIssuePayload({
        action: "unassigned",
        issue: makeIssue({
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" }), makeUser({ login: "alice" })],
        }),
      }),
      policy
    );
    expect(decision).toEqual({ type: "skip", reason: "bot still assigned" });
  });

  test("skips pull request issues", () => {
    const decision = shouldEnqueueIssue(
      makeIssuePayload({ issue: makeIssue({ pull_request: { merged_at: null } }) }),
      policy
    );
    expect(decision).toEqual({ type: "skip", reason: "pull request issue" });
  });

  test("does not first-run a closed issue; closed is a wake of blockers", () => {
    expect(shouldEnqueueIssue(makeIssuePayload({ action: "closed" }), policy)).toEqual({
      type: "skip",
      reason: "unsupported action closed",
    });
  });

  test("skips other actions and issues not assigned to the bot", () => {
    expect(shouldEnqueueIssue(makeIssuePayload({ action: "edited" }), policy)).toEqual({
      type: "skip",
      reason: "unsupported action edited",
    });
    expect(
      shouldEnqueueIssue(
        makeIssuePayload({
          issue: makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
        }),
        policy
      )
    ).toEqual({ type: "skip", reason: "not assigned to bot" });
  });

  test("rejects disallowed orgs and origins", () => {
    expect(() =>
      shouldEnqueueIssue(makeIssuePayload({ repository: makeRepo({ full_name: "evil/demo" }) }), policy)
    ).toThrow("not allowed");
    expect(() =>
      shouldEnqueueIssue(
        makeIssuePayload({
          repository: makeRepo({
            html_url: "https://evil.test/kirmanak/demo",
            clone_url: "https://evil.test/kirmanak/demo.git",
          }),
        }),
        policy
      )
    ).toThrow("does not match configured Gitea origin");
  });
});

describe("blockedIssueJobsToEnqueue", () => {
  test("enqueues open issues assigned to the bot from GET /blocks with a fresh GET", async () => {
    const jobs = await blockedIssueJobsToEnqueue(
      makeIssuePayload({ action: "closed", issue: makeIssue({ number: 196 }) }),
      policy,
      {
        listIssueBlocks: async () => [
          makeLinkedIssue({
            number: 206,
            title: "stale title",
            body: "stale body",
            updated_at: "2026-01-01T00:00:00Z",
          }),
        ],
        getIssue: async () =>
          makeIssue({
            number: 206,
            title: "fresh title",
            body: "fresh body",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/206",
            updated_at: "2026-05-24T00:00:00Z",
          }),
      }
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.issueNumber).toBe(206);
    expect(jobs[0]?.title).toBe("fresh title");
    expect(jobs[0]?.body).toBe("fresh body");
    expect(jobs[0]?.issueUpdatedAt).toBe("2026-05-24T00:00:00Z");
    expect(jobs[0]?.action).toBe("closed");
    expect(jobs[0]?.cloneUrl).toBe("https://gitea.kirmanak.stream/kirmanak/demo.git");
  });

  test("skips closed, unassigned, and pull-request blocked issues", async () => {
    const loaded: number[] = [];
    const jobs = await blockedIssueJobsToEnqueue(makeIssuePayload({ action: "closed" }), policy, {
      listIssueBlocks: async () => [
        makeLinkedIssue({ number: 1 }),
        makeLinkedIssue({ number: 2 }),
        makeLinkedIssue({ number: 3 }),
      ],
      getIssue: async (_owner, _repo, index) => {
        loaded.push(index);
        if (index === 1) return makeIssue({ number: 1, state: "closed" });
        if (index === 2) return makeIssue({ number: 2, assignee: makeUser({ login: "alice" }), assignees: [] });
        return makeIssue({ number: 3, pull_request: { merged_at: null } });
      },
    });
    expect(loaded).toEqual([1, 2, 3]);
    expect(jobs).toEqual([]);
  });

  test("honors cross-repo rows via getRepo and still clones only that repo", async () => {
    const other = makeRepo({ name: "other", full_name: "kirmanak/other" });
    const jobs = await blockedIssueJobsToEnqueue(makeIssuePayload({ action: "closed" }), policy, {
      listIssueBlocks: async () => [makeLinkedIssue({ owner: "kirmanak", repo: "other", number: 10 })],
      getIssue: async (owner, repo, index) =>
        makeIssue({
          number: index,
          title: "cross",
          html_url: `https://gitea.kirmanak.stream/${owner}/${repo}/issues/${index}`,
        }),
      getRepo: async () => other,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.owner).toBe("kirmanak");
    expect(jobs[0]?.repo).toBe("other");
    expect(jobs[0]?.issueNumber).toBe(10);
    expect(jobs[0]?.cloneUrl).toBe(other.clone_url);
  });

  test("walks transitive /blocks through a closed parent", async () => {
    const blocks: number[] = [];
    const jobs = await blockedIssueJobsToEnqueue(
      makeIssuePayload({ action: "closed", issue: makeIssue({ number: 180, state: "closed" }) }),
      policy,
      {
        listIssueBlocks: async (_owner, _repo, index) => {
          blocks.push(index);
          if (index === 180) return [makeLinkedIssue({ number: 196, state: "closed" })];
          if (index === 196) return [makeLinkedIssue({ number: 12 })];
          return [];
        },
        getIssue: async (_owner, _repo, index) => {
          if (index === 196) {
            return makeIssue({
              number: 196,
              state: "closed",
              assignee: makeUser({ login: "alice" }),
              assignees: [],
            });
          }
          return makeIssue({
            number: 12,
            title: "Slice two",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
          });
        },
      }
    );
    expect(blocks).toEqual([180, 196, 12]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.issueNumber).toBe(12);
    expect(jobs[0]?.title).toBe("Slice two");
  });

  test("does not loop a /blocks cycle and still enqueues open assigned issues", async () => {
    let calls = 0;
    const jobs = await blockedIssueJobsToEnqueue(
      makeIssuePayload({ action: "closed", issue: makeIssue({ number: 180, state: "closed" }) }),
      policy,
      {
        listIssueBlocks: async (_owner, _repo, index) => {
          calls += 1;
          if (calls > 8) throw new Error("cycle walk did not terminate");
          if (index === 180) return [makeLinkedIssue({ number: 196 })];
          if (index === 196) return [makeLinkedIssue({ number: 180, state: "closed" })];
          return [];
        },
        getIssue: async (_owner, _repo, index) =>
          makeIssue({
            number: index,
            state: index === 180 ? "closed" : "open",
            html_url: `https://gitea.kirmanak.stream/kirmanak/demo/issues/${index}`,
          }),
      }
    );
    expect(calls).toBe(2);
    expect(jobs.map((job) => job.issueNumber)).toEqual([196]);
  });

  test("stops walking /blocks at the dependency graph cap", async () => {
    let calls = 0;
    const jobs = await blockedIssueJobsToEnqueue(
      makeIssuePayload({ action: "closed", issue: makeIssue({ number: 0, state: "closed" }) }),
      policy,
      {
        listIssueBlocks: async (_owner, _repo, index) => {
          calls += 1;
          if (calls > DEPENDENCY_GRAPH_CAP + 5) throw new Error("cap walk did not terminate");
          return [makeLinkedIssue({ number: index + 1 })];
        },
        getIssue: async (_owner, _repo, index) =>
          makeIssue({
            number: index,
            html_url: `https://gitea.kirmanak.stream/kirmanak/demo/issues/${index}`,
          }),
      }
    );
    expect(calls).toBe(DEPENDENCY_GRAPH_CAP);
    expect(jobs).toHaveLength(DEPENDENCY_GRAPH_CAP);
  });
});

describe("assignedIssueJobsToEnqueue", () => {
  test("fresh-GETs open issues still assigned to the bot and skips the rest", async () => {
    const listed: Array<{ state?: string; type?: string; assignedBy?: string } | undefined> = [];
    const jobs = await assignedIssueJobsToEnqueue("kirmanak", "demo", makeRepo(), "closed", policy, {
      listRepoIssues: async (_owner, _repo, opts) => {
        listed.push(opts);
        return [
          makeLinkedIssue({ number: 4386, title: "stale" }),
          makeLinkedIssue({ number: 9, title: "other" }),
          makeLinkedIssue({ number: 50, title: "pr" }),
        ];
      },
      getIssue: async (_owner, _repo, index) => {
        if (index === 4386) {
          return makeIssue({
            number: 4386,
            title: "fresh",
            body: "do it",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/4386",
            updated_at: "2026-09-15T00:00:00Z",
          });
        }
        if (index === 9) {
          return makeIssue({
            number: 9,
            assignee: makeUser({ login: "alice" }),
            assignees: [makeUser({ login: "alice" })],
          });
        }
        return makeIssue({ number: 50, pull_request: { merged_at: null } });
      },
    });
    expect(listed).toEqual([{ state: "open", type: "issues", assignedBy: "jumi" }]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.issueNumber).toBe(4386);
    expect(jobs[0]?.title).toBe("fresh");
    expect(jobs[0]?.issueUpdatedAt).toBe("2026-09-15T00:00:00Z");
    expect(jobs[0]?.action).toBe("closed");
  });

  test("omits assignedBy when pickup is a label and keeps unlabeled-assignee issues", async () => {
    const listed: Array<{ state?: string; type?: string; assignedBy?: string } | undefined> = [];
    const jobs = await assignedIssueJobsToEnqueue(
      "kirmanak",
      "demo",
      makeRepo(),
      "closed",
      { ...policy, isPickedUp: hasJumiLabel },
      {
        listRepoIssues: async (_owner, _repo, opts) => {
          listed.push(opts);
          return [makeLinkedIssue({ number: 12, title: "stale" })];
        },
        getIssue: async () =>
          makeIssue({
            number: 12,
            title: "Slice",
            assignee: null,
            assignees: [],
            labels: [{ name: "jumi" }],
            html_url: "https://github.com/kirmanak/demo/issues/12",
          }),
      }
    );
    expect(listed).toEqual([{ state: "open", type: "issues" }]);
    expect(jobs.map((job) => job.issueNumber)).toEqual([12]);
  });

  test("does not resurrect an issue excluded as the lock PR", async () => {
    const jobs = await assignedIssueJobsToEnqueue(
      "kirmanak",
      "demo",
      makeRepo(),
      "closed",
      policy,
      {
        listRepoIssues: async () => [makeLinkedIssue({ number: 50 })],
        getIssue: async () => makeIssue({ number: 50 }),
      },
      new Set([50])
    );
    expect(jobs).toEqual([]);
  });
});

describe("pullWaitClearJobsToEnqueue", () => {
  const repo = makeRepo();
  const foreign = makePR({
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
      repo,
      repo_id: repo.id,
    },
  });

  test("closed assigned foreign PR enqueues other assigned issues when no lock remains", async () => {
    const jobs = await pullWaitClearJobsToEnqueue(
      makePayload({ action: "closed", pull_request: foreign, repository: repo }),
      policy,
      {
        listOpenPulls: async () => [],
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386, title: "stale" })],
        getIssue: async () =>
          makeIssue({
            number: 4386,
            title: "Slice",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/4386",
          }),
      }
    );
    expect(jobs.map((job) => job.issueNumber)).toEqual([4386]);
  });

  test("does not wake assigned issues while another assigned foreign PR remains", async () => {
    const jobs = await pullWaitClearJobsToEnqueue(
      makePayload({ action: "closed", pull_request: foreign, repository: repo }),
      policy,
      {
        listOpenPulls: async () => [
          makePR({
            number: 80,
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            head: { label: "kirmanak:renovate/y", ref: "renovate/y", sha: "abc", repo, repo_id: repo.id },
          }),
        ],
        listRepoIssues: async () => {
          throw new Error("should not list assigned issues");
        },
        getIssue: async () => makeIssue({ number: 4386 }),
      }
    );
    expect(jobs).toEqual([]);
  });

  test("does not wake assigned issues when a merged foreign PR was never assigned to the bot", async () => {
    const closer = makePR({
      number: 200,
      state: "closed",
      merged: true,
      title: "chore(deps)",
      body: "",
      user: makeUser({ login: "renovate" }),
      assignee: null,
      assignees: [],
      head: { label: "kirmanak:renovate/x", ref: "renovate/x", sha: "abc", repo, repo_id: repo.id },
    });
    const jobs = await pullWaitClearJobsToEnqueue(
      makePayload({ action: "closed", pull_request: closer, repository: repo }),
      policy,
      {
        listOpenPulls: async () => [],
        listRepoIssues: async () => {
          throw new Error("should not list assigned issues");
        },
        getIssue: async () => makeIssue({ number: 4386 }),
      }
    );
    expect(jobs).toEqual([]);
  });

  test("unassigned foreign PR wakes assigned issues when the bot was removed", async () => {
    const jobs = await pullWaitClearJobsToEnqueue(
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
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo,
            repo_id: repo.id,
          },
        }),
        repository: repo,
      }),
      policy,
      {
        listOpenPulls: async () => [],
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386 })],
        getIssue: async () =>
          makeIssue({
            number: 4386,
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/4386",
          }),
      }
    );
    expect(jobs.map((job) => job.issueNumber)).toEqual([4386]);
  });

  test("Gitea unassigned foreign PR wakes when payload has no assignee and the bot is gone", async () => {
    const jobs = await pullWaitClearJobsToEnqueue(
      makePayload({
        action: "unassigned",
        pull_request: makePR({
          number: 4373,
          title: "chore(deps)",
          body: "",
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "alice" }),
          assignees: [makeUser({ login: "alice" })],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo,
            repo_id: repo.id,
          },
        }),
        repository: repo,
      }),
      policy,
      {
        listOpenPulls: async () => [],
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386 })],
        getIssue: async () =>
          makeIssue({
            number: 4386,
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/4386",
          }),
      }
    );
    expect(jobs.map((job) => job.issueNumber)).toEqual([4386]);
  });

  test("Gitea unassigned foreign PR does not wake when the bot remains assigned", async () => {
    const jobs = await pullWaitClearJobsToEnqueue(
      makePayload({
        action: "unassigned",
        pull_request: makePR({
          number: 4373,
          title: "chore(deps)",
          body: "",
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" }), makeUser({ login: "alice" })],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo,
            repo_id: repo.id,
          },
        }),
        repository: repo,
      }),
      policy,
      {
        listOpenPulls: async () => [],
        listRepoIssues: async () => {
          throw new Error("should not list assigned issues");
        },
        getIssue: async () => makeIssue({ number: 4386 }),
      }
    );
    expect(jobs).toEqual([]);
  });

  test("does not wake assigned issues when a human is unassigned from a foreign PR", async () => {
    const jobs = await pullWaitClearJobsToEnqueue(
      makePayload({
        action: "unassigned",
        assignee: makeUser({ login: "alice" }),
        pull_request: makePR({
          number: 4373,
          title: "chore(deps)",
          body: "",
          user: makeUser({ login: "renovate" }),
          assignee: null,
          assignees: [],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo,
            repo_id: repo.id,
          },
        }),
        repository: repo,
      }),
      policy,
      {
        listOpenPulls: async () => [],
        listRepoIssues: async () => {
          throw new Error("should not list assigned issues");
        },
        getIssue: async () => makeIssue({ number: 4386 }),
      }
    );
    expect(jobs).toEqual([]);
  });

  test("listIssueBlocks failure still wakes assigned issues", async () => {
    const logs: string[] = [];
    const jobs = await pullWaitClearJobsToEnqueue(
      makePayload({ action: "closed", pull_request: foreign, repository: repo }),
      policy,
      {
        listOpenPulls: async () => [],
        listIssueBlocks: async () => {
          throw new Error("blocks down");
        },
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386, title: "stale" })],
        getIssue: async () =>
          makeIssue({
            number: 4386,
            title: "Slice",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/4386",
          }),
      },
      (message) => logs.push(message)
    );
    expect(jobs.map((job) => job.issueNumber)).toEqual([4386]);
    expect(logs.some((line) => line.includes("blocks down"))).toBe(true);
  });

  test("listOpenPulls failure throws so the webhook can retry", async () => {
    await expect(
      pullWaitClearJobsToEnqueue(makePayload({ action: "closed", pull_request: foreign, repository: repo }), policy, {
        listOpenPulls: async () => {
          throw new Error("pulls down");
        },
        listRepoIssues: async () => [makeLinkedIssue({ number: 4386 })],
        getIssue: async () => makeIssue({ number: 4386 }),
      })
    ).rejects.toThrow("pulls down");
  });

  test("listIssueBlocks failure throws when assigned wake does not apply", async () => {
    const closer = makePR({
      number: 200,
      state: "closed",
      merged: true,
      body: "Fixes #196",
      user: makeUser({ login: "alice" }),
      assignee: null,
      assignees: [],
      head: { label: "kirmanak:fix", ref: "fix", sha: "abc", repo, repo_id: repo.id },
    });
    await expect(
      pullWaitClearJobsToEnqueue(makePayload({ action: "closed", pull_request: closer, repository: repo }), policy, {
        listOpenPulls: async () => [],
        listIssueBlocks: async () => {
          throw new Error("blocks down");
        },
        listRepoIssues: async () => {
          throw new Error("should not list assigned issues");
        },
        getIssue: async () => makeIssue({ number: 206 }),
      })
    ).rejects.toThrow("blocks down");
  });

  test("closed of a blocker PR wakes /blocks dependents even when the PR was not assigned", async () => {
    const closer = makePR({
      number: 200,
      state: "closed",
      merged: true,
      body: "Fixes #196",
      user: makeUser({ login: "alice" }),
      assignee: null,
      assignees: [],
      head: { label: "kirmanak:fix", ref: "fix", sha: "abc", repo, repo_id: repo.id },
    });
    const jobs = await pullWaitClearJobsToEnqueue(
      makePayload({ action: "closed", pull_request: closer, repository: repo }),
      policy,
      {
        listOpenPulls: async () => [],
        listIssueBlocks: async (_owner, _repo, index) =>
          index === 196 ? [makeLinkedIssue({ number: 206, title: "stale" })] : [],
        getIssue: async (_owner, _repo, index) =>
          makeIssue({
            number: index,
            title: "Dependent",
            html_url: `https://gitea.kirmanak.stream/kirmanak/demo/issues/${index}`,
          }),
      }
    );
    expect(jobs.map((job) => job.issueNumber)).toEqual([206]);
  });
});

describe("isDependencyRemoveAction", () => {
  test("accepts only the remove actions", () => {
    expect(isDependencyRemoveAction("blocked_by_removed")).toBe(true);
    expect(isDependencyRemoveAction("blocking_removed")).toBe(true);
    expect(isDependencyRemoveAction("blocked_by_added")).toBe(false);
    expect(isDependencyRemoveAction("blocking_added")).toBe(false);
    expect(isDependencyRemoveAction(undefined)).toBe(false);
  });
});

describe("parseIssueDependenciesPayload", () => {
  test("blocked_by_removed wakes the issue in the delivery repository", () => {
    const repository = makeRepo();
    const ref = parseIssueDependenciesPayload(
      encodeJson({ action: "blocked_by_removed", repository, blocked_issue: { number: 12 } })
    );
    expect(ref.action).toBe("blocked_by_removed");
    expect(ref.blockedOwner).toBe("kirmanak");
    expect(ref.blockedRepo).toBe("demo");
    expect(ref.blockedNumber).toBe(12);
    expect(ref.triggerOwner).toBe("kirmanak");
    expect(ref.triggerRepo).toBe("demo");
  });

  test("blocking_removed wakes blocked_issue in blocked_issue_repo", () => {
    const repository = makeRepo({ name: "blocker", full_name: "kirmanak/blocker" });
    const blockedIssueRepo = makeRepo();
    const ref = parseIssueDependenciesPayload(
      encodeJson({
        action: "blocking_removed",
        repository,
        blocked_issue: { number: 12 },
        blocked_issue_repo: blockedIssueRepo,
      })
    );
    expect(ref.action).toBe("blocking_removed");
    expect(ref.blockedOwner).toBe("kirmanak");
    expect(ref.blockedRepo).toBe("demo");
    expect(ref.blockedNumber).toBe(12);
    expect(ref.triggerOwner).toBe("kirmanak");
    expect(ref.triggerRepo).toBe("blocker");
  });

  test("rejects added actions and malformed payloads", () => {
    const repository = makeRepo();
    expect(() =>
      parseIssueDependenciesPayload(
        encodeJson({ action: "blocked_by_added", repository, blocked_issue: { number: 12 } })
      )
    ).toThrow("unsupported action");
    expect(() =>
      parseIssueDependenciesPayload(encodeJson({ action: "blocking_added", repository, blocked_issue: { number: 12 } }))
    ).toThrow("unsupported action");
    expect(() => parseIssueDependenciesPayload(encodeJson({ action: "blocked_by_removed" }))).toThrow(
      "missing repository"
    );
    expect(() => parseIssueDependenciesPayload(encodeJson({ action: "blocked_by_removed", repository }))).toThrow(
      "missing blocked_issue"
    );
    expect(() =>
      parseIssueDependenciesPayload(
        encodeJson({ action: "blocking_removed", repository, blocked_issue: { number: 12 } })
      )
    ).toThrow("missing blocked_issue_repo");
    expect(() => parseIssueDependenciesPayload(new TextEncoder().encode("not-json"))).toThrow();
  });
});

describe("enqueueEligibleBlockedIssue", () => {
  const repository = makeRepo();

  function context(
    overrides: Partial<Parameters<typeof enqueueEligibleBlockedIssue>[1]> = {}
  ): Parameters<typeof enqueueEligibleBlockedIssue>[1] {
    return {
      owner: "kirmanak",
      repo: "demo",
      repository,
      action: "blocked_by_removed",
      policy,
      api: { getIssue: async () => makeIssue({ number: 12 }) },
      ...overrides,
    };
  }

  test("enqueues an open issue picked up by the bot", async () => {
    const job = await enqueueEligibleBlockedIssue({ owner: "kirmanak", repo: "demo", number: 12 }, context());
    expect(job?.issueNumber).toBe(12);
    expect(job?.action).toBe("blocked_by_removed");
    expect(job?.cloneUrl).toBe(repository.clone_url);
  });

  test("skips closed, unpicked, and pull-request targets", async () => {
    const closed = await enqueueEligibleBlockedIssue(
      { owner: "kirmanak", repo: "demo", number: 1 },
      context({ api: { getIssue: async () => makeIssue({ number: 1, state: "closed" }) } })
    );
    const unpicked = await enqueueEligibleBlockedIssue(
      { owner: "kirmanak", repo: "demo", number: 2 },
      context({
        api: {
          getIssue: async () =>
            makeIssue({ number: 2, assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
        },
      })
    );
    const pr = await enqueueEligibleBlockedIssue(
      { owner: "kirmanak", repo: "demo", number: 3 },
      context({ api: { getIssue: async () => makeIssue({ number: 3, pull_request: { merged_at: null } }) } })
    );
    expect(closed).toBeUndefined();
    expect(unpicked).toBeUndefined();
    expect(pr).toBeUndefined();
  });

  test("skips a cross-repo blocked issue outside the repository policy", async () => {
    const other = makeRepo({ name: "other", full_name: "evil/other" });
    const job = await enqueueEligibleBlockedIssue(
      { owner: "evil", repo: "other", number: 10 },
      context({
        api: {
          getIssue: async (_owner, _repo, index) =>
            makeIssue({
              number: index,
              html_url: "https://gitea.kirmanak.stream/evil/other/issues/10",
            }),
          getRepo: async () => other,
        },
      })
    );
    expect(job).toBeUndefined();
  });

  test("skips a cross-repo blocked issue when there is no getRepo", async () => {
    const job = await enqueueEligibleBlockedIssue(
      { owner: "kirmanak", repo: "other", number: 10 },
      context({ api: { getIssue: async () => makeIssue({ number: 10 }) } })
    );
    expect(job).toBeUndefined();
  });
});
