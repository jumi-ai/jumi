import { describe, expect, test } from "bun:test";
import { buildFollowUpSnapshot } from "../src/pr_snapshot.ts";
import { MemorySkipLatchStore } from "../src/skip_latches.ts";
import { makeIssueJob, makePR, makeUser } from "./fixtures.ts";

function makeCountingApi(overrides: Record<string, unknown> = {}) {
  const counts: Record<string, number> = {};
  const count = (method: string) => {
    counts[method] = (counts[method] ?? 0) + 1;
  };
  const api: Record<string, unknown> = {
    getRepoFile: async (..._args: unknown[]) => {
      count("getRepoFile");
      return (overrides.getRepoFile as (() => unknown) | undefined)?.() ?? { found: false };
    },
    listIssueComments: async () => {
      count("listIssueComments");
      return [];
    },
    listPullReviews: async () => {
      count("listPullReviews");
      return [];
    },
    listPullReviewComments: async () => {
      count("listPullReviewComments");
      return [];
    },
    getCollaboratorPermission: async () => {
      count("getCollaboratorPermission");
      return { permission: "write", role_name: "write" };
    },
    listCommitStatuses: async () => {
      count("listCommitStatuses");
      return [];
    },
    listCheckRuns: async () => {
      count("listCheckRuns");
      return [];
    },
    listActionJobs: async () => {
      count("listActionJobs");
      return [];
    },
    getBranch: async () => {
      count("getBranch");
      return { protected: false };
    },
    getPR: async () => {
      count("getPR");
      return makePR();
    },
    listPullCommits: async () => {
      count("listPullCommits");
      return [];
    },
    getPRFiles: async () => {
      count("getPRFiles");
      return [];
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "getRepoFile") continue;
    (api as Record<string, unknown>)[key] = (...args: unknown[]) => {
      count(key);
      return (value as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { api, counts };
}

function snapshotArgs(
  api: unknown,
  latches: MemorySkipLatchStore,
  overrides: { defaultBranch?: string; job?: ReturnType<typeof makeIssueJob>; pr?: ReturnType<typeof makePR> } = {}
) {
  const job = overrides.job ?? makeIssueJob({ defaultBranch: overrides.defaultBranch ?? "main" });
  const pr = (overrides.pr ?? makePR({ number: 127 })) as unknown as Parameters<typeof buildFollowUpSnapshot>[0]["pr"];
  return {
    opts: {
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      pr,
      job,
      botUsername: "jumi",
      home: "/tmp/jumi-pr-snapshot-test",
      defaultBranch: overrides.defaultBranch ?? "main",
      deployment: {
        maxFollowupRounds: 3,
        maxConflictRounds: 3,
        blockingQuestionAuthors: [] as string[],
        followupIgnoreLogins: [] as string[],
        trustedSenderLogins: [] as string[],
        ignoreConflictsLabel: "ignore-conflicts",
      },
      skipLatches: latches,
    },
    deps: { api, log: () => undefined, sleep: async () => undefined, now: () => new Date("2026-01-01T00:00:00Z") },
  };
}

describe("pr_snapshot", () => {
  test("one settings read per wake", async () => {
    const { api, counts } = makeCountingApi({
      getRepoFile: () => ({ found: true, content: "max_followup_rounds: 1\n" }),
    });
    const latches = new MemorySkipLatchStore();
    const { opts, deps } = snapshotArgs(api as never, latches);
    const snapshot = await buildFollowUpSnapshot(opts, deps as never);
    expect(counts["getRepoFile"]).toBe(1);
    expect(snapshot.policy.maxFollowupRounds).toBe(1);
    // Thunks do not re-read settings.
    await snapshot.resolveRequiredCiContexts();
    await snapshot.isLeftToAuthor();
    await snapshot.getPrDiffHash();
    await snapshot.getLeftToAuthor();
    await snapshot.getSameFinding();
    expect(counts["getRepoFile"]).toBe(1);
  });

  test("failure modes match the old inline fail-open/fail-closed rules", async () => {
    const deployment = {
      maxFollowupRounds: 3,
      maxConflictRounds: 3,
      blockingQuestionAuthors: ["deployer"],
      followupIgnoreLogins: ["ignore-me"],
      trustedSenderLogins: ["trusted"] as string[],
      ignoreConflictsLabel: "ignore-conflicts",
    };
    // Invalid file: fail open to deployment, ignore authors [].
    {
      const { api } = makeCountingApi({
        getRepoFile: () => ({ found: true, content: "max_followup_rounds: [oops\n" }),
      });
      const latches = new MemorySkipLatchStore();
      const job = makeIssueJob({ defaultBranch: "main" });
      const pr = makePR({ number: 127 }) as unknown as Parameters<typeof buildFollowUpSnapshot>[0]["pr"];
      const snapshot = await buildFollowUpSnapshot(
        {
          owner: "k",
          repo: "d",
          issueNumber: 12,
          pr,
          job,
          botUsername: "jumi",
          home: "/tmp/x",
          defaultBranch: "main",
          deployment,
          skipLatches: latches,
        },
        { api, log: () => undefined, sleep: async () => undefined, now: () => new Date() } as never
      );
      expect(snapshot.settings.state).toBe("loaded");
      expect(snapshot.policy.maxFollowupRounds).toBe(3);
      expect(snapshot.policy.followupOnSuggestions).toBe(true);
      expect(snapshot.lists.blockingAuthors).toEqual(["deployer"]);
      expect(snapshot.lists.ignoreAuthors).toEqual([]);
    }
    // Thrown read: fail open to deployment, ignore authors undefined (fail closed).
    {
      const { api, counts } = makeCountingApi({
        getRepoFile: () => {
          throw new Error("boom");
        },
      });
      const latches = new MemorySkipLatchStore();
      const job = makeIssueJob({ defaultBranch: "main" });
      const pr = makePR({ number: 127 }) as unknown as Parameters<typeof buildFollowUpSnapshot>[0]["pr"];
      const snapshot = await buildFollowUpSnapshot(
        {
          owner: "k",
          repo: "d",
          issueNumber: 12,
          pr,
          job,
          botUsername: "jumi",
          home: "/tmp/x",
          defaultBranch: "main",
          deployment,
          skipLatches: latches,
        },
        { api, log: () => undefined, sleep: async () => undefined, now: () => new Date() } as never
      );
      expect(snapshot.settings.state).toBe("threw");
      expect(snapshot.policy.maxFollowupRounds).toBe(3);
      expect(snapshot.lists.ignoreAuthors).toBeUndefined();
      expect(counts["getRepoFile"]).toBe(1);
    }
    // Missing file: fail open, ignore authors [].
    {
      const { api } = makeCountingApi({ getRepoFile: () => ({ found: false }) });
      const latches = new MemorySkipLatchStore();
      const job = makeIssueJob({ defaultBranch: "main" });
      const pr = makePR({ number: 127 }) as unknown as Parameters<typeof buildFollowUpSnapshot>[0]["pr"];
      const snapshot = await buildFollowUpSnapshot(
        {
          owner: "k",
          repo: "d",
          issueNumber: 12,
          pr,
          job,
          botUsername: "jumi",
          home: "/tmp/x",
          defaultBranch: "main",
          deployment,
          skipLatches: latches,
        },
        { api, log: () => undefined, sleep: async () => undefined, now: () => new Date() } as never
      );
      expect(snapshot.policy.maxFollowupRounds).toBe(3);
      expect(snapshot.lists.ignoreAuthors).toEqual([]);
    }
    // Missing branch: no read at all.
    {
      const { api, counts } = makeCountingApi({});
      const latches = new MemorySkipLatchStore();
      const job = makeIssueJob({ defaultBranch: "" });
      const pr = makePR({ number: 127 }) as unknown as Parameters<typeof buildFollowUpSnapshot>[0]["pr"];
      const snapshot = await buildFollowUpSnapshot(
        {
          owner: "k",
          repo: "d",
          issueNumber: 12,
          pr,
          job,
          botUsername: "jumi",
          home: "/tmp/x",
          defaultBranch: "",
          deployment,
          skipLatches: latches,
        },
        { api, log: () => undefined, sleep: async () => undefined, now: () => new Date() } as never
      );
      expect(snapshot.settings.state).toBe("no-branch");
      expect(snapshot.policy.maxFollowupRounds).toBe(3);
      expect(snapshot.lists.ignoreAuthors).toEqual([]);
      expect(counts["getRepoFile"] ?? 0).toBe(0);
    }
  });

  test("thunks memoise (evaluated at most once)", async () => {
    const { api, counts } = makeCountingApi({
      getRepoFile: () => ({ found: true, content: "max_followup_rounds: 3\n" }),
      getBranch: async () => ({ protected: true, enableStatusCheck: true, requiredContexts: ["build"] }),
      listPullCommits: async () => [],
      getPRFiles: async () => [{ filename: "a.ts", status: "modified", additions: 1, deletions: 1, changes: 2 }],
    });
    const latches = new MemorySkipLatchStore();
    const pr = makePR({
      number: 127,
      labels: ["ignore-conflicts"],
      user: makeUser({ login: "alice" }),
      head: {
        label: "kirmanak:jumi/issue-12-x",
        ref: "jumi/issue-12-x",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        repo: undefined as never,
        repo_id: 10,
      },
      base: { label: "kirmanak:main", ref: "main", sha: "basesha", repo: undefined as never, repo_id: 10 },
    }) as unknown as Parameters<typeof buildFollowUpSnapshot>[0]["pr"];
    const job = makeIssueJob({
      defaultBranch: "main",
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      headSha: "other-sha",
    });
    // Seed one unhandled Jumi finding so the diff thunk has an identity hash.
    (api as Record<string, unknown>).listIssueComments = async () => {
      counts["listIssueComments"] = (counts["listIssueComments"] ?? 0) + 1;
      return [
        {
          id: 1,
          body: [
            "<!-- jumi-review:kirmanak/demo#127 -->",
            "### Jumi review",
            "",
            "Reviewed commit: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`",
            "",
            "src/foo.ts:123: 🟡 risk: guard the null deref in `connectToServer`",
            "<!-- jumi-check: failure -->",
          ].join("\n"),
          user: { login: "jumi" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ];
    };
    const { opts, deps } = snapshotArgs(api as never, latches, { pr: pr as never, job });
    const snapshot = await buildFollowUpSnapshot(opts, deps as never);
    expect(snapshot.hasFeedback).toBe(true);
    expect(snapshot.findingIdentityHash).toBeDefined();
    // Required contexts resolved once during build; further calls memoise.
    expect(counts["getBranch"]).toBe(1);
    await snapshot.resolveRequiredCiContexts();
    await snapshot.resolveRequiredCiContexts();
    expect(counts["getBranch"]).toBe(1);

    expect(counts["listPullCommits"] ?? 0).toBe(0);
    await snapshot.isLeftToAuthor();
    expect(counts["listPullCommits"]).toBe(1);
    await snapshot.isLeftToAuthor();
    await snapshot.getLeftToAuthor();
    await snapshot.getLeftToAuthor();
    expect(counts["listPullCommits"]).toBe(1);

    expect(counts["getPRFiles"] ?? 0).toBe(0);
    await snapshot.getPrDiffHash();
    expect(counts["getPRFiles"]).toBe(1);
    await snapshot.getPrDiffHash();
    await snapshot.getSameFinding();
    await snapshot.getSameFinding();
    expect(counts["getPRFiles"]).toBe(1);
  });

  test("thunks not evaluated on paths today's code does not call them", async () => {
    // Gate `all`: required contexts never read the branch.
    {
      const { api, counts } = makeCountingApi({
        getRepoFile: () => ({ found: true, content: "ci_gate:\n  wait: all\n" }),
      });
      const latches = new MemorySkipLatchStore();
      const { opts, deps } = snapshotArgs(api as never, latches);
      const snapshot = await buildFollowUpSnapshot(opts, deps as never);
      expect(snapshot.ciGateWait).toBe("all");
      expect(counts["getBranch"] ?? 0).toBe(0);
      await snapshot.resolveRequiredCiContexts();
      expect(counts["getBranch"] ?? 0).toBe(0);
    }
    // No feedback: no finding identity, so no PR diff read even after getSameFinding.
    // The snapshot still lists PR files once to check for an invalid head
    // settings file (which counts as feedback when the pull touches it).
    {
      const { api, counts } = makeCountingApi({
        getRepoFile: () => ({ found: true, content: "max_followup_rounds: 3\n" }),
      });
      const latches = new MemorySkipLatchStore();
      const { opts, deps } = snapshotArgs(api as never, latches);
      const snapshot = await buildFollowUpSnapshot(opts, deps as never);
      expect(snapshot.hasFeedback).toBe(false);
      expect(counts["getPRFiles"] ?? 0).toBe(1);
      await snapshot.getPrDiffHash();
      await snapshot.getSameFinding();
      expect(counts["getPRFiles"] ?? 0).toBe(1);
    }
    // Lazy left-to-author: no commit read until the thunk runs.
    {
      const { api, counts } = makeCountingApi({
        getRepoFile: () => ({ found: true, content: "max_followup_rounds: 3\n" }),
      });
      const latches = new MemorySkipLatchStore();
      const { opts, deps } = snapshotArgs(api as never, latches);
      const snapshot = await buildFollowUpSnapshot(opts, deps as never);
      expect(counts["listPullCommits"] ?? 0).toBe(0);
    }
  });
});
